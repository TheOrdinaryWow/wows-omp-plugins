import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { LOOP_ASSET, LOOP_DEFINE_ASSET, LOOP_WORKFLOW_ASSET, loadPromptAsset } from "#src/assets.ts";
import { readHostSetting } from "#src/host-settings.ts";
import {
  captureQualityGate,
  copyEvidence,
  criterionFresh,
  evidenceBinding,
  gateFresh,
  qualityGateTemplate,
  requireCriteria,
} from "#src/ulw-loop-evidence.ts";
import { type LoopParameters, loopParameters } from "#src/ulw-loop-schema.ts";
import {
  acquireGoal,
  appendGoal,
  createLoop,
  criterionById,
  type EvidenceBinding,
  editable,
  event,
  goalById,
  LoopError,
  type LoopGoal,
  type LoopState,
  nonempty,
  requireLoop,
  steer,
  validateBatches,
} from "#src/ulw-loop-state.ts";
import { LoopStore } from "#src/ulw-loop-store.ts";

interface LoopHost {
  mainSession(ctx: ExtensionContext): AgentSession | undefined;
  commandNotice(ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error"): void;
}
export interface LoopIntegration {
  researchContext(ctx: ExtensionContext): Promise<string>;
}
const DRIVER_ENTRY = "wows-omp-omo-ultrawork.loop-driver";
const READ_OPS: Readonly<Record<string, true>> = { help: true, status: true, criteria: true };
const OPERATIONS = {
  help: "List operations and steering contracts.",
  status: "Read durable state, driver relationship, freshness and next actions.",
  create_goals: "Read briefPath, set objective, typed goals and optional validationBatches. Requires /ulw-loop authorization.",
  complete_goals: "Acquire/resume one eligible goal; retry failed only with retryFailed:true. noEligibleWork is not aggregateComplete.",
  criteria: "Read goalId criteria and immutable evidence history.",
  record_evidence: "Capture goalId/criterionId status, evidence, artifacts and optional notes against the current clean tree.",
  checkpoint:
    "Set goalId status complete/failed/blocked with evidence; final/batch completion needs qualityGatePath. printTemplate:true prints the gate shape.",
  steer:
    "Finding-backed atomic change: add_subgoal, split_subgoal, reorder_pending, revise_pending_wording, revise_criterion, annotate_ledger, mark_blocked_superseded.",
  add_goal: "Append typed title/objective/shape/tier/criteria with stable ids.",
  record_review_blockers: "Block goalId and append an evidence-backed repair goal atomically.",
  pause: "Pause only the owned native goal and preserve unfinished work.",
  resume: "Resume the owned paused goal. Recreating a missing/completed driver requires user /ulw-loop resume.",
  stop: "Stop without success; do not cancel or claim to stop child agents.",
};

function nextActions(state: LoopState | undefined): string[] {
  if (!state) return ["Ask the user to enter /ulw-loop <objective> to authorize a durable native-goal loop."];
  if (state.status === "complete")
    return state.completion?.nativeNotified
      ? ["Loop accepted and native goal completed; use a fresh session for unrelated work."]
      : [
          "Acceptance is durable; native completion notification is pending. Run /ulw-loop resume or read status after ownership is restored.",
        ];
  if (state.status !== "active")
    return [
      `Loop ${state.status}: ${state.pauseReason ?? "Inspect blockers and unfinished criteria."}`,
      "Use /ulw-loop resume explicitly when the native goal and Plan Mode permit it.",
    ];
  if (!state.goals.length)
    return ["Write the authoritative brief file; call ulw_loop create_goals with fully specified goals and criteria."];
  const active = state.goals.find((goal) => goal.status === "in_progress");
  if (active)
    return [
      `Work ${active.id}; inspect criteria, capture observable evidence, then checkpoint. Todo is the live cursor, not a second ledger.`,
    ];
  if (state.goals.some((goal) => goal.status === "pending")) return ["Call complete_goals to acquire the next eligible goal."];
  if (state.goals.some((goal) => goal.status === "failed"))
    return ["Inspect failed attempts; only an explicit retryFailed:true acquires failed work."];
  return [
    "No eligible work is not success. Resolve blocked goals/review repairs, or run a fresh final checkpoint with all criteria and a quality gate.",
  ];
}
function storeFor(ctx: ExtensionContext): LoopStore {
  return new LoopStore(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId(), ctx.cwd);
}
function requireState(state: LoopState | undefined): asserts state is LoopState {
  requireLoop(state, "ULW_LOOP_NOT_STARTED", "No authorized loop exists. The user must enter /ulw-loop <objective> first.");
}

export function registerLoop(pi: ExtensionAPI, host: LoopHost): LoopIntegration {
  const internalGoalChange = new Set<string>();
  const parameters = loopParameters(pi);
  const main = (ctx: ExtensionContext): AgentSession => {
    const session = host.mainSession(ctx);
    requireLoop(session, "ULW_LOOP_MAIN_ONLY", "ulw-loop runs only in the main session.");
    return session;
  };
  const checkPlanMode = (session: AgentSession): void => {
    requireLoop(
      !session.getPlanModeState()?.enabled,
      "ULW_LOOP_PLAN_MODE",
      "Exit Plan Mode before starting or mutating ulw-loop. The loop never activates Plan Mode.",
    );
    requireLoop(!session.getVibeModeState()?.enabled, "ULW_LOOP_VIBE_MODE", "Exit vibe mode before starting or resuming ulw-loop.");
    requireLoop(
      readHostSetting(session.settings, "goal.enabled") !== false,
      "ULW_LOOP_GOAL_DISABLED",
      "Enable goal.enabled before starting/resuming ulw-loop.",
    );
  };
  const ownsActive = (session: AgentSession, state: LoopState): void => {
    checkPlanMode(session);
    const current = session.getGoalModeState()?.goal;
    requireLoop(
      current && current.id === state.driver.goalId && current.status === "active" && session.getGoalModeState()?.enabled,
      "ULW_LOOP_DRIVER_NOT_ACTIVE",
      "The loop's exact native goal is not active. Yield to /audit or the current goal; use /ulw-loop resume explicitly.",
    );
    requireLoop(state.status === "active", "ULW_LOOP_NOT_ACTIVE", "The durable loop is paused, blocked or stopped; explicitly resume it.");
  };
  const goalChange = async <T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T> => {
    const id = ctx.sessionManager.getSessionId();
    internalGoalChange.add(id);
    try {
      return await run();
    } finally {
      internalGoalChange.delete(id);
    }
  };
  const boundDriver = (ctx: ExtensionContext) => {
    const session = host.mainSession(ctx);
    const goal = session?.getGoalModeState()?.goal;
    if (!session || !goal) return undefined;
    let data: unknown;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === DRIVER_ENTRY) data = entry.data;
    }
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      data.version !== 1 ||
      !("runId" in data) ||
      typeof data.runId !== "string" ||
      !("goalId" in data) ||
      data.goalId !== goal.id ||
      !("objective" in data) ||
      data.objective !== goal.objective ||
      !goal.objective.startsWith(`ULW loop [${data.runId}]: `)
    )
      return undefined;
    return { session, goal };
  };
  const rememberDriver = (ctx: ExtensionContext, state: LoopState, goalId: string): void => {
    if (boundDriver(ctx)?.goal.id === goalId) return;
    pi.appendEntry(DRIVER_ENTRY, { version: 1, runId: state.runId, goalId, objective: state.driver.pendingObjective });
  };
  const pauseBoundDriver = async (ctx: ExtensionContext): Promise<void> => {
    const bound = boundDriver(ctx);
    if (!bound || (bound.goal.status !== "active" && bound.goal.status !== "budget-limited")) return;
    await goalChange(ctx, () => bound.session.goalRuntime.pauseGoal());
    ctx.ui.setStatus("ulw-loop", "ulw-loop paused · state unreadable");
  };
  const show = (ctx: ExtensionContext, state?: LoopState): void => {
    ctx.ui.setStatus("ulw-loop", state ? `ulw-loop ${state.status}${state.activeGoalId ? ` · ${state.activeGoalId}` : ""}` : undefined);
  };
  const notifyComplete = async (ctx: ExtensionContext): Promise<void> => {
    const store = storeFor(ctx);
    const state = await store.load();
    if (state?.status !== "complete" || !state.completion) return;
    const session = main(ctx);
    const current = session.getGoalModeState()?.goal;
    if (!state.completion.nativeNotified) {
      requireLoop(
        current && current.id === state.driver.goalId,
        "ULW_LOOP_COMPLETION_PENDING",
        "Acceptance is durable, but the owned native goal is missing/replaced. No foreign goal was completed.",
      );
      if (current.status !== "complete") {
        requireLoop(
          current.status !== "dropped",
          "ULW_LOOP_COMPLETION_PENDING",
          "The accepted loop's driver was dropped; native completion remains pending.",
        );
        await goalChange(ctx, () => session.goalRuntime.completeGoalFromTool());
      }
      await store.update((saved) => {
        requireState(saved);
        requireLoop(saved.completion, "ULW_LOOP_STATE_INVALID", "Missing loop completion.");
        saved.completion.nativeNotified = true;
        event(saved, "native_goal_completed", { goalId: saved.driver.goalId });
        return { state: saved, result: undefined };
      });
    }
    const saved = await store.load();
    if (saved?.completion && !saved.completion.eventNotified) {
      // Mark before emitting: a restart must not publish a second logical completion.
      await store.update((latest) => {
        requireState(latest);
        requireLoop(latest.completion, "ULW_LOOP_STATE_INVALID", "Missing loop completion.");
        latest.completion.eventNotified = true;
        event(latest, "completion_announced");
        return { state: latest, result: undefined };
      });
      pi.events.emit("ulw-loop:completed", { version: 1, sessionId: saved.sessionId, runId: saved.runId, revision: saved.revision + 1 });
    }
  };
  const reconcile = async (ctx: ExtensionContext): Promise<void> => {
    if (!host.mainSession(ctx) || !ctx.sessionManager.getSessionDir()) return;
    const store = storeFor(ctx);
    let state = await store.load();
    if (!state) {
      show(ctx);
      return;
    }
    const session = main(ctx);
    const current = session.getGoalModeState()?.goal;
    if (!state.driver.goalId && current?.objective === state.driver.pendingObjective) {
      rememberDriver(ctx, state, current.id);
      await store.update((saved) => {
        requireState(saved);
        saved.driver.goalId = current.id;
        saved.status = current.status === "active" ? "active" : "paused";
        saved.pauseReason = saved.status === "active" ? undefined : "Native goal is not active.";
        event(saved, "native_goal_recovered", { goalId: current.id });
        return { state: saved, result: undefined };
      });
      state = (await store.load()) as LoopState;
    }
    if (current && current.id === state.driver.goalId && current.objective === state.driver.pendingObjective)
      rememberDriver(ctx, state, current.id);
    if (state.status === "complete") {
      if (!state.completion?.nativeNotified && current?.id === state.driver.goalId) await notifyComplete(ctx);
    } else if (
      state.status === "active" &&
      (session.getPlanModeState()?.enabled ||
        !current ||
        current.id !== state.driver.goalId ||
        current.status !== "active" ||
        !session.getGoalModeState()?.enabled)
    ) {
      if (session.getPlanModeState()?.enabled && current && current.id === state.driver.goalId && current.status === "active")
        await goalChange(ctx, () => session.goalRuntime.pauseGoal());
      await store.update((saved) => {
        requireState(saved);
        saved.status = "paused";
        saved.pauseReason = session.getPlanModeState()?.enabled
          ? "Yielding to Plan Mode."
          : "Native goal paused, budget-limited, completed, dropped or replaced; unfinished criteria remain unfinished.";
        event(saved, "driver_yielded", { goalId: current?.id, status: current?.status });
        return { state: saved, result: undefined };
      });
    }
    show(ctx, await store.load());
  };
  const resume = async (ctx: ExtensionContext, userAuthorized: boolean): Promise<void> => {
    const session = main(ctx);
    checkPlanMode(session);
    const store = storeFor(ctx);
    const state = await store.load();
    requireState(state);
    if (state.status === "complete") {
      await notifyComplete(ctx);
      return;
    }
    const current = session.getGoalModeState()?.goal;
    requireLoop(
      !current || current.id === state.driver.goalId || current.status === "complete" || current.status === "dropped",
      "ULW_LOOP_FOREIGN_GOAL",
      "Another native goal owns continuation (including /audit). Finish/drop it before resuming this loop.",
    );
    const canResume = current && current.id === state.driver.goalId && current.status !== "complete" && current.status !== "dropped";
    requireLoop(
      canResume || userAuthorized,
      "ULW_LOOP_USER_RESUME_REQUIRED",
      "The user must enter /ulw-loop resume to recreate a missing or prematurely completed driver.",
    );
    const created = await goalChange(ctx, () =>
      canResume ? session.goalRuntime.resumeGoal() : session.goalRuntime.createGoal({ objective: state.driver.pendingObjective }),
    );
    try {
      rememberDriver(ctx, state, created.goal.id);
      await store.update((saved) => {
        requireState(saved);
        saved.driver.goalId = created.goal.id;
        saved.status = "active";
        saved.pauseReason = undefined;
        event(saved, "resumed", { goalId: created.goal.id });
        return { state: saved, result: undefined };
      });
    } catch (error) {
      if (session.getGoalModeState()?.goal.id === created.goal.id) await goalChange(ctx, () => session.goalRuntime.pauseGoal());
      throw error;
    }
    show(ctx, await store.load());
  };
  const suspend = async (ctx: ExtensionContext, op: "pause" | "stop", reason?: string): Promise<void> => {
    const session = main(ctx);
    const store = storeFor(ctx);
    const state = await store.load();
    requireState(state);
    requireLoop(
      state.status !== "complete",
      "ULW_LOOP_PLAN_EXISTS_COMPLETE",
      "The accepted loop is read-only; it cannot be marked stopped.",
    );
    await store.update((saved) => {
      requireState(saved);
      saved.status = op === "stop" ? "stopped" : "paused";
      saved.pauseReason =
        reason ?? (op === "stop" ? "Stopped without success; running children were not cancelled." : "Paused explicitly.");
      event(saved, op, { reason: saved.pauseReason });
      return { state: saved, result: undefined };
    });
    if (session.getGoalModeState()?.goal?.id === state.driver.goalId) {
      await goalChange(ctx, async () => {
        if (op === "stop") await session.goalRuntime.dropGoal();
        else await session.goalRuntime.pauseGoal();
      });
    }
    show(ctx, await store.load());
  };
  const summarize = async (ctx: ExtensionContext): Promise<Record<string, unknown>> => {
    const store = storeFor(ctx);
    const state = await store.load();
    if (!state) return { state: null, nextActions: nextActions(undefined), evidenceRoot: store.evidenceRoot };
    let binding: EvidenceBinding | undefined;
    let warning: string | undefined;
    try {
      binding = await evidenceBinding(ctx.cwd, pi.exec);
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error);
    }
    let fresh = 0;
    let stale = 0;
    for (const goal of state.goals) {
      if (goal.status === "superseded") continue;
      for (const criterion of goal.criteria) {
        if (binding && (await criterionFresh(store, goal, criterion, binding))) fresh++;
        else stale++;
      }
    }
    const current = main(ctx).getGoalModeState()?.goal;
    return {
      state,
      summary: { fresh, stale },
      driver: { goalId: current?.id, status: current?.status, owned: current?.id === state.driver.goalId },
      evidenceRoot: store.evidenceRoot,
      currentAttemptDir: state.activeGoalId
        ? path.join(store.evidenceRoot, `${state.activeGoalId}-attempt-${goalById(state, state.activeGoalId).attempt}`)
        : undefined,
      nextActions: nextActions(state),
      warnings: warning ? [warning] : [],
    };
  };

  pi.registerCommand("ulw-loop", {
    description: "<objective> | status | pause | resume | stop | reset: durable criterion/evidence loop driven by one native goal",
    handler: async (args, ctx) => {
      try {
        const session = main(ctx);
        const input = args.trim();
        if (!input || input === "status") {
          const current = await summarize(ctx);
          host.commandNotice(ctx, JSON.stringify(current, null, 2));
          return;
        }
        if (input === "pause" || input === "stop") {
          await suspend(ctx, input);
          host.commandNotice(
            ctx,
            input === "stop" ? "ulw-loop stopped without success. Running child agents were not cancelled." : "ulw-loop paused.",
          );
          return;
        }
        if (input === "resume") {
          await reconcile(ctx);
          await resume(ctx, true);
          host.commandNotice(ctx, "ulw-loop resumed; read ulw_loop status before continuing.");
          return;
        }
        if (input === "reset") {
          const store = storeFor(ctx);
          const state = await store.load();
          if (state && state.status !== "complete") await suspend(ctx, "stop", "Explicit user reset; old proof will be archived.");
          const archived = await store.archive();
          show(ctx);
          host.commandNotice(
            ctx,
            archived
              ? `ulw-loop archived at ${archived}. No proof was deleted; start a new objective explicitly.`
              : "No ulw-loop exists to reset.",
          );
          return;
        }
        checkPlanMode(session);
        const current = session.getGoalModeState()?.goal;
        requireLoop(
          !current || current.status === "complete" || current.status === "dropped",
          "ULW_LOOP_FOREIGN_GOAL",
          "This session already has a live/paused goal (possibly /audit). Finish or drop it before starting ulw-loop.",
        );
        const body = loadPromptAsset(LOOP_ASSET);
        const store = storeFor(ctx);
        await store.update((existing) => {
          requireLoop(
            !existing,
            existing?.status === "complete" ? "ULW_LOOP_PLAN_EXISTS_COMPLETE" : "ULW_LOOP_PLAN_EXISTS",
            "This session already has a loop; read status or resume it. Use a new session for unrelated work, or explicitly /ulw-loop reset to archive it.",
          );
          const state = createLoop(store.sessionId, store.cwd, input);
          event(state, "start_authorized");
          return { state, result: undefined };
        });
        await resume(ctx, true);
        pi.sendUserMessage(
          `<ulw-loop-request>\n${input}\n</ulw-loop-request>\n\n${body}\n\nLoop store: ${store.file}\nRead ulw_loop status; the plugin already created and owns the native driver. Do not create a second goal or notepad.`,
        );
      } catch (error) {
        if (error instanceof LoopError && error.code.startsWith("ULW_LOOP_STATE_")) await pauseBoundDriver(ctx);
        const code = error instanceof LoopError ? error.code : "ULW_LOOP_ERROR";
        host.commandNotice(ctx, `${code}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "ulw_loop",
    label: "Ultrawork loop",
    description:
      "Session-bound durable goals, criteria, evidence and steering. /ulw-loop explicitly authorizes creation; complete_goals only acquires/resumes work. Final acceptance requires fresh tree-bound evidence plus real-surface/source QA and independent review. Read help for operations.",
    parameters,
    approval: (input) => {
      if (!input || typeof input !== "object" || !("op" in input)) return "write";
      return typeof input.op === "string" &&
        (READ_OPS[input.op] || (input.op === "checkpoint" && "printTemplate" in input && input.printTemplate === true))
        ? "read"
        : "write";
    },
    strict: true,
    async execute(_id, params: LoopParameters, _signal, _update, ctx) {
      const op = params.op;
      try {
        const session = main(ctx);
        if (op === "help")
          return receipt(
            op,
            {
              operations: OPERATIONS,
              references: { defineGoal: loadPromptAsset(LOOP_DEFINE_ASSET), fullWorkflow: loadPromptAsset(LOOP_WORKFLOW_ASSET) },
              steeringFields: {
                add_subgoal: "title,objective,shape,tier,criteria",
                split_subgoal: "targetGoalId,childGoals (pending target)",
                reorder_pending: "pendingOrder (complete permutation)",
                revise_pending_wording: "targetGoalId,revisedTitle?,revisedObjective?",
                revise_criterion: "goalId,criterionId,scenario?,expectedEvidence?,userModel?",
                annotate_ledger: "no additional fields",
                mark_blocked_superseded: "targetGoalId,childGoals?,blockedReason?",
              },
              steeringRequired: "source:finding,evidence,rationale; no caller-supplied session id or store path",
            },
            [],
          );
        if (op === "status") return receipt(op, await summarize(ctx), nextActions(await storeFor(ctx).load()));
        if (op !== "criteria" && !(params.op === "checkpoint" && "printTemplate" in params)) await reconcile(ctx);
        if (op === "pause" || op === "stop") await suspend(ctx, op, params.reason);
        else if (op === "resume") await resume(ctx, false);
        else {
          const store = storeFor(ctx);
          const result = await store.update(async (state) => {
            requireState(state);
            if (params.op === "complete_goals" && state.status === "complete") {
              return { state, result: acquireGoal(state, params.retryFailed) };
            }
            if (params.op === "criteria") {
              const goal = goalById(state, params.goalId);
              const binding = await evidenceBinding(ctx.cwd, pi.exec).catch(() => undefined);
              return {
                state,
                result: {
                  goal,
                  criteria: await Promise.all(
                    goal.criteria.map(async (criterion) => ({
                      ...criterion,
                      fresh: binding ? await criterionFresh(store, goal, criterion, binding) : false,
                    })),
                  ),
                },
              };
            }
            if (params.op === "checkpoint" && "printTemplate" in params) {
              const target = params.goalId ? goalById(state, params.goalId) : undefined;
              const all = state.goals.filter((goal) => goal.status !== "superseded");
              const final = !target || all.every((goal) => goal.id === target.id || goal.status === "complete");
              const batchIds = target
                ? [...new Set(state.validationBatches.filter((batch) => batch.finalGoalId === target.id).flatMap((batch) => batch.goalIds))]
                : [];
              const goals = final ? all : batchIds.length ? batchIds.map((id) => goalById(state, id)) : [target as LoopGoal];
              return { state, result: qualityGateTemplate(state, goals, await evidenceBinding(ctx.cwd, pi.exec)) };
            }
            ownsActive(session, state);
            editable(state);
            let result: unknown;
            switch (params.op) {
              case "create_goals": {
                requireLoop(
                  state.goals.length === 0,
                  "ULW_LOOP_GOALS_EXIST",
                  "Goals already exist. Resume or steer them instead of replanning.",
                );
                const briefPath = path.resolve(ctx.cwd, params.briefPath);
                const brief = await readFile(briefPath, "utf8");
                requireLoop(nonempty(brief), "ULW_LOOP_BRIEF_REQUIRED", "The authoritative brief file is empty.");
                state.brief = brief;
                state.briefPath = briefPath;
                state.objective = params.objective;
                for (const seed of params.goals) appendGoal(state, seed);
                state.validationBatches = params.validationBatches ?? [];
                validateBatches(state);
                event(state, "goals_created", { goalIds: state.goals.map((goal) => goal.id), briefPath });
                result = state.goals;
                break;
              }
              case "complete_goals": {
                const acquired = acquireGoal(state, params.retryFailed);
                if (acquired.goal)
                  await mkdir(path.join(store.evidenceRoot, `${acquired.goal.id}-attempt-${acquired.goal.attempt}`), {
                    recursive: true,
                    mode: 0o700,
                  });
                result = acquired;
                break;
              }
              case "add_goal":
                result = appendGoal(state, params);
                event(state, "goal_added", { goalId: (result as LoopGoal).id });
                break;
              case "steer":
                steer(state, params);
                result = { revision: state.revision };
                break;
              case "record_evidence": {
                const goal = goalById(state, params.goalId);
                requireLoop(
                  goal.attempt > 0 && goal.status !== "superseded",
                  "ULW_LOOP_ATTEMPT_REQUIRED",
                  "Acquire the goal before recording evidence; superseded goals are read-only.",
                );
                const criterion = criterionById(goal, params.criterionId);
                const binding = await evidenceBinding(ctx.cwd, pi.exec, goal.shape === "delivery");
                requireLoop(
                  params.status !== "pass" || params.artifacts.length > 0,
                  "ULW_LOOP_EVIDENCE_REQUIRED",
                  "Passing evidence needs at least one actual non-empty artifact.",
                );
                const id = `capture-${randomUUID()}`;
                const capture = {
                  id,
                  goalAttempt: goal.attempt,
                  criterionRevision: criterion.revision,
                  status: params.status,
                  capturedAt: new Date().toISOString(),
                  evidence: params.evidence,
                  notes: params.notes,
                  artifacts: await copyEvidence(store, params.artifacts, `${goal.id}-attempt-${goal.attempt}/${id}`),
                  binding,
                };
                criterion.evidenceHistory.push(capture);
                event(state, "evidence_recorded", {
                  goalId: goal.id,
                  criterionId: criterion.id,
                  captureId: id,
                  status: capture.status,
                  binding,
                });
                result = capture;
                break;
              }
              case "record_review_blockers": {
                const goal = goalById(state, params.goalId);
                requireLoop(goal.status !== "superseded", "ULW_LOOP_GOAL_SUPERSEDED", "Cannot block a superseded goal.");
                const artifacts = await copyEvidence(store, params.artifacts, `blocker-${randomUUID()}`);
                goal.status = "blocked";
                goal.blockedReason = params.evidence;
                if (state.activeGoalId === goal.id) state.activeGoalId = undefined;
                const repair = appendGoal(state, {
                  title: params.title,
                  objective: params.objective,
                  shape: goal.shape,
                  tier: goal.tier,
                  criteria: [
                    {
                      scenario: params.objective,
                      expectedEvidence: `Fresh QA and independent review establish the blocker is resolved: ${params.evidence}`,
                    },
                  ],
                });
                repair.repairFor = goal.id;
                event(state, "review_blockers", { goalId: goal.id, repairGoalId: repair.id, evidence: params.evidence, artifacts });
                result = { blockedGoal: goal.id, repairGoal: repair };
                break;
              }
              case "checkpoint": {
                const goal = goalById(state, params.goalId);
                requireLoop(
                  goal.status === "in_progress" || (goal.status === "complete" && params.status === "complete"),
                  "ULW_LOOP_ATTEMPT_REQUIRED",
                  "Checkpoint only an acquired goal (or refresh the last completed checkpoint).",
                );
                if (params.status !== "complete") {
                  goal.status = params.status;
                  if (state.activeGoalId === goal.id) state.activeGoalId = undefined;
                  goal.blockedReason = params.evidence;
                  if (params.status === "blocked") {
                    state.status = "blocked";
                    state.pauseReason = params.evidence;
                  }
                  event(state, "checkpoint", { goalId: goal.id, status: params.status, evidence: params.evidence });
                  result = { goalId: goal.id, aggregateComplete: false };
                  break;
                }
                const binding = await evidenceBinding(
                  ctx.cwd,
                  pi.exec,
                  state.goals.some((item) => item.shape === "delivery" && item.status !== "superseded"),
                );
                const liveGoals = state.goals.filter((item) => item.status !== "superseded");
                const remaining = liveGoals.filter((item) => item.id !== goal.id && item.status !== "complete");
                const final = remaining.length === 0;
                await requireCriteria(store, [goal], binding, !final);
                const batches = state.validationBatches.filter((batch) => batch.finalGoalId === goal.id);
                for (const batch of batches)
                  requireLoop(
                    batch.goalIds.every((id) => id === goal.id || goalById(state, id).status === "complete"),
                    "ULW_LOOP_BATCH_INCOMPLETE",
                    `Validation batch ${batch.id} has unfinished members.`,
                  );
                const covered = final
                  ? liveGoals
                  : [...new Set(batches.flatMap((batch) => batch.goalIds))].map((id) => goalById(state, id));
                if (covered.length) {
                  requireLoop(
                    params.qualityGatePath,
                    "ULW_LOOP_QUALITY_GATE_REQUIRED",
                    "Final/batch checkpoint requires an authoritative qualityGatePath JSON file. Use checkpoint printTemplate:true.",
                  );
                  const parent = AgentRegistry.global()
                    .list()
                    .find((ref) => ref.kind === "main" && ref.session === session);
                  const receipt = await captureQualityGate(store, covered, binding, params.qualityGatePath, (id) => {
                    const child = AgentRegistry.global().get(id);
                    return Boolean(parent && child?.kind === "sub" && child.parentId === parent.id && child.id !== parent.id);
                  });
                  state.gates = state.gates.filter((gate) => gate.goalId !== goal.id);
                  state.gates.push({ goalId: goal.id, receipt });
                }
                if (final) {
                  for (const batch of state.validationBatches) {
                    if (batch.finalGoalId === goal.id) continue;
                    const batchGoals = batch.goalIds.map((id) => goalById(state, id));
                    const captures = await requireCriteria(store, batchGoals, binding, false);
                    const saved = state.gates.find((gate) => gate.goalId === batch.finalGoalId);
                    requireLoop(
                      saved && (await gateFresh(store, saved.receipt, captures, binding)),
                      "ULW_LOOP_BATCH_GATE_STALE",
                      `Batch ${batch.id} needs fresh quality-gate evidence at its closer.`,
                    );
                  }
                  state.status = "complete";
                  state.completion = {
                    at: new Date().toISOString(),
                    evidence: params.evidence,
                    nativeNotified: false,
                    eventNotified: false,
                  };
                }
                goal.status = "complete";
                if (state.activeGoalId === goal.id) state.activeGoalId = undefined;
                // A repair reopens its blocked target; the repair is not acceptance of that target.
                if (goal.repairFor) {
                  const target = goalById(state, goal.repairFor);
                  if (target.status === "blocked") target.status = "pending";
                }
                event(state, "checkpoint", { goalId: goal.id, status: "complete", evidence: params.evidence, aggregateComplete: final });
                result = { goalId: goal.id, aggregateComplete: final };
                break;
              }
            }
            return { state, result };
          });
          const saved = await store.load();
          if (saved?.status === "blocked" && session.getGoalModeState()?.goal.id === saved.driver.goalId)
            await goalChange(ctx, () => session.goalRuntime.pauseGoal());
          if (saved?.status === "complete") {
            try {
              await notifyComplete(ctx);
            } catch (error) {
              return receipt(op, result, nextActions(await store.load()), [error instanceof Error ? error.message : String(error)]);
            }
          }
          show(ctx, await store.load());
          return receipt(op, result, nextActions(await store.load()));
        }
        const state = await storeFor(ctx).load();
        return receipt(op, { status: state?.status }, nextActions(state));
      } catch (error) {
        if (error instanceof LoopError && error.code.startsWith("ULW_LOOP_STATE_")) await pauseBoundDriver(ctx);
        const failure = {
          ok: false,
          op,
          error: {
            code: error instanceof LoopError ? error.code : "ULW_LOOP_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        };
        return { content: [{ type: "text", text: JSON.stringify(failure) }], details: failure, isError: true };
      }
    },
  });

  const restore = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    try {
      await reconcile(ctx);
    } catch (error) {
      await pauseBoundDriver(ctx);
      host.commandNotice(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  };
  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_branch", restore);
  pi.on("session_tree", restore);
  pi.on("session_compact", restore);
  pi.on("goal_updated", async (update, ctx) => {
    if (internalGoalChange.has(ctx.sessionManager.getSessionId()) || !host.mainSession(ctx) || !ctx.sessionManager.getSessionDir()) return;
    try {
      const store = storeFor(ctx);
      const state = await store.load();
      if (state?.status === "active" && (!update.goal || update.goal.id !== state.driver.goalId || update.goal.status !== "active")) {
        await store.update((saved) => {
          requireState(saved);
          saved.status = "paused";
          saved.pauseReason = "The native goal was paused, budget-limited, completed, dropped or replaced; acceptance remains unfinished.";
          event(saved, "driver_yielded", { goalId: update.goal?.id, status: update.goal?.status });
          return { state: saved, result: undefined };
        });
      }
      await reconcile(ctx);
    } catch (error) {
      host.commandNotice(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!host.mainSession(ctx) || !ctx.sessionManager.getSessionDir()) return;
    try {
      await reconcile(ctx);
      const state = await storeFor(ctx).load();
      if (!state) return;
      return {
        message: {
          customType: "wows-omp-omo-ultrawork.loop-context",
          content: `<omo-ulw-loop-mode>Loop ${state.runId} is ${state.status}. ${nextActions(state).join(" ")} Authoritative state: ${storeFor(ctx).file}. Read ulw_loop status after compaction; never create a second notepad, goal or ledger.</omo-ulw-loop-mode>`,
          display: false,
        },
      };
    } catch (error) {
      await pauseBoundDriver(ctx);
      return {
        message: {
          customType: "wows-omp-omo-ultrawork.loop-context",
          content: `ulw-loop is paused because its durable state is unreadable: ${error instanceof Error ? error.message : String(error)}. Do not continue or initialize over it.`,
          display: false,
        },
      };
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!host.mainSession(ctx) || !ctx.sessionManager.getSessionDir() || event.toolName !== "goal" || event.input.op !== "complete") return;
    try {
      const state = await storeFor(ctx).load();
      if (state && state.status !== "complete" && main(ctx).getGoalModeState()?.goal.id === state.driver.goalId)
        return {
          block: true,
          reason:
            "ulw-loop criteria are unfinished. Complete the domain checkpoint/quality gate; native goal complete is not evidence. User /goal actions remain available.",
        };
    } catch (error) {
      if (boundDriver(ctx))
        return {
          block: true,
          reason: `Cannot authenticate ulw-loop acceptance: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
  });
  return {
    async researchContext(ctx) {
      if (!ctx.sessionManager.getSessionDir())
        return "No durable loop is active. Use the research journal only; do not create a native goal or loop aggregate.";
      const state = await storeFor(ctx).load();
      if (state?.status !== "active" || main(ctx).getGoalModeState()?.goal.id !== state.driver.goalId)
        return "No compatible active loop owns this research. Use the research journal only; do not create a loop automatically.";
      return `Reuse the active ulw-loop ${state.runId}, objective ${JSON.stringify(state.objective)}${state.activeGoalId ? `, goal ${state.activeGoalId}` : ""}. Read ulw_loop status/criteria and preserve its criterion ids. The loop owns execution/evidence; annotate findings through steer kind annotate_ledger. Do not create a second aggregate, native goal or notepad.`;
    },
  };
}

function receipt(op: string, result: unknown, next: string[], warnings?: string[]) {
  const details = { ok: true, op, result, nextActions: next, ...(warnings?.length ? { warnings } : {}) };
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
