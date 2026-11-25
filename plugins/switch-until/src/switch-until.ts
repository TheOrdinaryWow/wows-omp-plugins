import { randomUUID } from "node:crypto";

import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveExactModelIdentity } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { hasNativeJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  EPHEMERAL_MODEL_CHANGE_ROLE,
  type ModelChangeEntry,
  type SessionEntry,
  TEMPORARY_MODEL_CHANGE_ROLE,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";

import { parseHeadlessArgs } from "#src/args.ts";
import { buildJudgeState, qualifiesForJudgment, readBranchProgress } from "#src/evidence.ts";
import { judgeGoal, NATIVE_JUDGE_HINT, translateToEnglish } from "#src/judge.ts";
import {
  captureSelection,
  compactToFit,
  disarmPrewalk,
  matchesModel,
  modelLabel,
  needsCompaction,
  pickModel,
  resolveSelection,
  sessionFor,
} from "#src/models.ts";
import { DEFAULT_SETTINGS, parseSettings, type UntilSettings } from "#src/settings.ts";
import { readSidecars } from "#src/sidecars.ts";
import {
  type ActiveUntil,
  type Decision,
  deadline,
  decide,
  ENTRY_TYPE,
  encodeEntry,
  readWorkflow,
  resolveRestorePoint,
  startUntil,
  type UntilEntry,
  type UntilRecord,
} from "#src/state.ts";
import { TranslationCache } from "#src/translation-cache.ts";

type RestoreReason = Decision | "cancel";
interface RunningUntil {
  run: ActiveUntil;
  startEntryId: string;
  modelEntryId: string;
  session: AgentSession;
  sessionId: string;
  controller: AbortController;
  translation: TranslationCache;
  unobserve: () => void;
  timer?: Timer;
  observedTurns: number;
  limit?: Exclude<Decision, "met">;
  rebuilding?: boolean;
  pending?: RestoreReason;
  handoff?: Promise<void>;
}

const REASONS: Record<NonNullable<UntilRecord["ended"]>, string> = {
  met: "Goal met",
  cancel: "Switch-until cancelled",
  "foreign-change": "Session model changed",
  limit: "Switch-until reached a limit",
  "turn-limit": "Switch-until reached its turn limit",
  "time-limit": "Switch-until reached its time limit",
};

function describeJudgment(run: ActiveUntil): string {
  const last = run.lastJudgment;
  return last
    ? `${(last.probability * 100).toFixed(1)}% P(met) at ${new Date(last.at).toISOString()} (${
        last.probability > 0.5 ? "judge favored met" : last.probability < 0.5 ? "judge favored not met" : "judge was evenly split"
      })`
    : "none yet";
}

function describeStatus(run: ActiveUntil): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
  return [
    `Temporary model: ${run.target.selector} (${run.target.thinking ?? "default"} thinking)`,
    `Restore model: ${run.original.selector} (${run.original.thinking ?? "default"} thinking)`,
    `Goal: ${run.goal}`,
    `Additional context: ${run.context ? "present" : "none"}`,
    `Elapsed: ${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m ${elapsed % 60}s`,
    `Judged turns: ${run.judgedTurns} of ${run.turns}`,
    `Last judgment: ${describeJudgment(run)}`,
  ].join("\n");
}

async function readSettings(ctx: ExtensionContext): Promise<UntilSettings> {
  try {
    return parseSettings(await getPluginSettings("wows-omp-plugin-switch-until", ctx.cwd), (message) => logger.warn(message));
  } catch (error) {
    logger.warn("Could not read switch-until settings. Using defaults.", { error });
    return DEFAULT_SETTINGS;
  }
}

export interface SwitchUntilDependencies {
  sessionFor: typeof sessionFor;
  readSettings: typeof readSettings;
  hasNativeJudge: (ctx: ExtensionContext, model: Model) => boolean;
  resolveSelection: typeof resolveSelection;
  judgeGoal: typeof judgeGoal;
  translateToEnglish: typeof translateToEnglish;
  readSidecars: typeof readSidecars;
}

export default function switchUntil(pi: ExtensionAPI): void {
  registerSwitchUntil(pi, {
    sessionFor,
    readSettings,
    hasNativeJudge: (ctx, model) => {
      const settings = findScopedSettings(ctx.cwd);
      return settings !== undefined && hasNativeJudge(settings, ctx.modelRegistry, model);
    },
    resolveSelection,
    judgeGoal,
    translateToEnglish,
    readSidecars,
  });
}

export function registerSwitchUntil(pi: ExtensionAPI, deps: SwitchUntilDependencies): void {
  let active: RunningUntil | undefined;
  let commandOpen = false;
  let switching = false;
  let judgmentTask: Promise<void> | undefined;
  let queuedJudgment: { ctx: ExtensionContext; current: RunningUntil } | undefined;
  let completionContext: ExtensionContext | undefined;

  function notice(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else pi.sendMessage({ customType: ENTRY_TYPE, content: text, display: true, excludeFromContext: true });
  }

  function persist(entry: UntilEntry): void {
    pi.appendEntry(ENTRY_TYPE, encodeEntry(entry));
  }

  function attach(ctx: ExtensionContext, session: AgentSession, workflow: UntilRecord): RunningUntil {
    const { run, startEntryId, modelEntryId, translations } = workflow;
    const controller = new AbortController();
    const sessionId = ctx.sessionManager.getSessionId();
    const translation = new TranslationCache(
      (text) => deps.translateToEnglish(ctx, session, text, controller.signal),
      translations,
      (messageId, text) => {
        if (!controller.signal.aborted && ctx.sessionManager.getSessionId() === sessionId) {
          persist({ kind: "translation", id: run.id, messageId, text });
        }
      },
    );
    const unobserveTurns = session.agent.subscribe((event) => {
      if (event.type !== "turn_end" || switching || current.pending || current.rebuilding || !isCurrent(ctx, current)) return;
      recordTurns(current, ++current.observedTurns);
    });
    const removePreflight = session.agent.addBeforeModelCallHook(async (signal) => {
      if (current.handoff) await untilAborted(signal, current.handoff);
      if (switching || !stillOwnsModel(ctx, current)) return;
      const settings = await deps.readSettings(ctx);
      signal?.throwIfAborted();
      if (current.handoff) await untilAborted(signal, current.handoff);
      if (switching || !stillOwnsModel(ctx, current)) return;
      const progress = readBranchProgress(ctx.sessionManager.getBranch(), startEntryId);
      recordTurns(current, progress.turns);
      const limit = decide(run, settings, Date.now());
      if (!current.limit && limit) {
        const restore = finish(ctx, current, limit, true);
        await untilAborted(signal, restore);
      }
      if (current.limit && stillOwnsModel(ctx, current)) session.agent.abort();
    });
    const current: RunningUntil = {
      run,
      startEntryId,
      modelEntryId,
      session,
      sessionId,
      controller,
      translation,
      observedTurns: Math.max(run.turns, readBranchProgress(ctx.sessionManager.getBranch(), startEntryId).turns),
      unobserve: () => {
        removePreflight();
        unobserveTurns();
      },
    };
    active = current;
    if (ctx.hasUI) {
      const goal = Array.from(run.goal);
      ctx.ui.setStatus(ENTRY_TYPE, `until: ${goal.length > 40 ? `${goal.slice(0, 39).join("")}…` : run.goal}`);
    }
    return current;
  }

  function detach(ctx: ExtensionContext): void {
    if (active?.timer !== undefined) ctx.clearTimer(active.timer);
    active?.unobserve();
    active?.controller.abort();
    active = undefined;
    queuedJudgment = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(ENTRY_TYPE, undefined);
  }

  function isCurrent(ctx: ExtensionContext, current: RunningUntil): boolean {
    return active === current && ctx.sessionManager.getSessionId() === current.sessionId;
  }

  function recordTurns(current: RunningUntil, turns: number): void {
    if (turns <= current.run.turns) return;
    current.run.turns = turns;
    persist({ kind: "turn", id: current.run.id, turns });
  }

  function modelChanges(branch: readonly SessionEntry[], ownedThrough: string) {
    let latest: ModelChangeEntry | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.id === ownedThrough) return { latest, explicit: false };
      if (entry?.type !== "model_change") continue;
      if (entry.role !== EPHEMERAL_MODEL_CHANGE_ROLE) return { latest: latest ?? entry, explicit: true };
      latest ??= entry;
    }
    return { latest, explicit: true };
  }

  function stillOwnsModel(ctx: ExtensionContext, current: RunningUntil): boolean {
    if (!isCurrent(ctx, current) || current.rebuilding) return false;
    const model = ctx.models.current();
    const { latest, explicit } = modelChanges(ctx.sessionManager.getBranch(), current.modelEntryId);
    if (model && !explicit) {
      const selector = modelLabel(model);
      if (selector === current.run.target.selector || (latest?.resolvedModelIsFallback && latest.model === selector)) return true;
    }
    persist({ kind: "end", id: current.run.id, reason: "foreign-change" });
    detach(ctx);
    notice(ctx, "Switch-until ended because the session model changed.");
    return false;
  }

  function scheduleCheck(ctx: ExtensionContext, current: RunningUntil, at: number): void {
    if (!isCurrent(ctx, current)) return;
    if (current.timer !== undefined) ctx.clearTimer(current.timer);
    const delay = Math.min(2_147_483_647, Math.max(0, Math.ceil(at - Date.now())));
    current.timer = ctx.setTimeout(async () => {
      current.timer = undefined;
      if (!isCurrent(ctx, current)) return;
      const latest = await deps.readSettings(ctx);
      if (!isCurrent(ctx, current)) return;
      const reason = current.limit ?? current.pending ?? decide(current.run, latest, Date.now());
      if (switching || current.session.isSessionTransitioning) scheduleCheck(ctx, current, Date.now() + 250);
      else if (reason) await finish(ctx, current, reason);
      else if (stillOwnsModel(ctx, current)) scheduleCheck(ctx, current, deadline(current.run, latest));
    }, delay);
  }

  async function finish(ctx: ExtensionContext, current: RunningUntil, requested: RestoreReason, continues?: boolean): Promise<void> {
    if (switching || current.session.isSessionTransitioning || !stillOwnsModel(ctx, current)) return;
    const { run, session } = current;
    if (requested === "turn-limit" || requested === "time-limit") current.limit ??= requested;
    const reason = current.limit ?? requested;
    const handoff = Promise.withResolvers<void>();
    current.pending = reason;
    current.handoff = handoff.promise;
    switching = true;
    let rejudge = false;
    try {
      const original = resolveRestorePoint(run, (selector) => resolveExactModelIdentity(selector, ctx.modelRegistry));
      if (!original) throw new Error(`Original model ${run.original.selector} is unavailable.`);
      const { model, thinking } = original;
      if (needsCompaction(ctx, model)) {
        await compactToFit(ctx, session, model, {
          signal: current.controller.signal,
          suppressContinuation: continues === undefined ? undefined : !continues,
        });
      }
      if (!stillOwnsModel(ctx, current)) return;
      if (
        reason === "met" &&
        run.lastJudgment?.evidenceId !== readBranchProgress(ctx.sessionManager.getBranch(), current.startEntryId).evidenceId
      ) {
        current.pending = undefined;
        rejudge = true;
        return;
      }
      await session.setModelTemporary(model, thinking);
      if (!isCurrent(ctx, current)) return;
      if (!matchesModel(ctx.models.current(), model)) {
        stillOwnsModel(ctx, current);
        return;
      }
      if (thinking === undefined && session.configuredThinkingLevel() !== undefined) session.setThinkingLevel(undefined);
      persist(
        reason === "cancel" || reason === "met"
          ? { kind: "end", id: run.id, reason }
          : { kind: "end", id: run.id, reason: "limit", limit: reason },
      );
      detach(ctx);
      notice(ctx, `${REASONS[reason]}. Restored ${run.original.selector} (${thinking ?? "default"} thinking).`);
    } catch (error) {
      if (!isCurrent(ctx, current)) return;
      notice(ctx, `Switch-until could not restore the model. ${error instanceof Error ? error.message : String(error)}`, "error");
      scheduleCheck(ctx, current, Date.now() + 60_000);
    } finally {
      switching = false;
      current.handoff = undefined;
      handoff.resolve();
      if (rejudge) queueJudgment(ctx, current);
    }
  }

  async function reconcileTarget(ctx: ExtensionContext, current: RunningUntil, branched: boolean): Promise<void> {
    const { run, session, modelEntryId, controller } = current;
    const branch = ctx.sessionManager.getBranch();
    const { explicit, latest } = modelChanges(branch, modelEntryId);
    const live = ctx.models.current();
    if (explicit || !live) return;
    const target = run.target;
    const selector = modelLabel(live);
    if (selector === target.selector) {
      if (session.configuredThinkingLevel() !== target.thinking) session.setThinkingLevel(target.thinking);
      return;
    }
    const lastDefault = branch.findLast((entry) => entry.type === "model_change" && (entry.role === undefined || entry.role === "default"));
    const restoredDefault =
      latest?.role === EPHEMERAL_MODEL_CHANGE_ROLE && lastDefault?.type === "model_change" ? lastDefault.model : undefined;
    if (!branched && selector !== `${target.provider}/${target.id}` && selector !== restoredDefault) return;
    const model = resolveExactModelIdentity(target.selector, ctx.modelRegistry);
    if (!model) throw new Error(`Saved target ${target.selector} is unavailable.`);
    if (needsCompaction(ctx, model)) await compactToFit(ctx, session, model, { signal: controller.signal });
    const before = ctx.sessionManager.getBranch();
    if (!isCurrent(ctx, current) || !matchesModel(ctx.models.current(), live) || modelChanges(before, modelEntryId).explicit) return;
    const prior = before.findLast((entry) => entry.type === "model_change");
    await session.setModelTemporary(model, target.thinking);
    if (!isCurrent(ctx, current) || !matchesModel(ctx.models.current(), model)) return;
    const receipt = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "model_change");
    if (
      !receipt ||
      receipt.id === prior?.id ||
      receipt.role !== TEMPORARY_MODEL_CHANGE_ROLE ||
      receipt.model !== `${target.provider}/${target.id}`
    )
      return;
    if (target.thinking === undefined && session.configuredThinkingLevel() !== undefined) session.setThinkingLevel(undefined);
    current.modelEntryId = receipt.id;
    persist({ kind: "reconciled", id: run.id, modelEntryId: receipt.id });
  }

  async function rebuild(ctx: ExtensionContext, branched = false): Promise<void> {
    if (ctx.agent.kind !== "main") return;
    completionContext = ctx;
    detach(ctx);
    const workflow = readWorkflow(ctx.sessionManager.getBranch());
    if (!workflow || workflow.ended) return;
    const session = deps.sessionFor(ctx);
    if (!session) return;
    const current = attach(ctx, session, workflow);
    const { run, startEntryId } = current;
    current.rebuilding = true;
    const ready = Promise.withResolvers<void>();
    current.handoff = ready.promise;
    const refresh = async () => {
      try {
        if (!isCurrent(ctx, current)) return;
        await reconcileTarget(ctx, current, branched);
      } catch (error) {
        if (isCurrent(ctx, current))
          notice(ctx, `Switch-until could not resume. ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        current.rebuilding = false;
        current.handoff = undefined;
        ready.resolve();
      }
      if (!stillOwnsModel(ctx, current)) return;
      disarmPrewalk(session);
      const settings = await deps.readSettings(ctx);
      if (!stillOwnsModel(ctx, current)) return;
      const progress = readBranchProgress(ctx.sessionManager.getBranch(), startEntryId);
      recordTurns(current, progress.turns);
      const judgment = run.lastJudgment;
      const reason = decide(run, settings, Date.now(), judgment?.evidenceId === progress.evidenceId ? judgment?.probability : undefined);
      if (reason) await finish(ctx, current, reason);
      else {
        scheduleCheck(ctx, current, deadline(run, settings));
        if (progress.evidenceId !== undefined && judgment?.evidenceId !== progress.evidenceId) queueJudgment(ctx, current);
      }
    };
    if (session.isSessionTransitioning) {
      void session
        .waitForSessionTransition()
        .then(refresh)
        .catch((error: unknown) => logger.warn("Could not resume switch-until", { error }));
    } else {
      await refresh();
    }
  }

  function queueJudgment(ctx: ExtensionContext, current: RunningUntil): void {
    queuedJudgment = { ctx, current };
    if (judgmentTask) return;
    judgmentTask = Promise.resolve().then(async () => {
      try {
        while (queuedJudgment) {
          const next = queuedJudgment;
          queuedJudgment = undefined;
          await runJudgment(next.ctx, next.current);
        }
      } catch (error) {
        logger.warn("Switch-until could not settle its judgment queue", { error });
      } finally {
        judgmentTask = undefined;
      }
    });
  }

  async function runJudgment(ctx: ExtensionContext, current: RunningUntil): Promise<void> {
    if (current.pending || switching || !stillOwnsModel(ctx, current)) return;
    const { run, session, translation, startEntryId } = current;
    try {
      const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(60_000)]);
      await untilAborted(signal, () => session.settleInFlightMessagePersistence());
      const messages = ctx.sessionManager.getBranch();
      const progress = readBranchProgress(messages, startEntryId);
      if (!progress.evidenceId || progress.evidenceId === run.lastJudgment?.evidenceId) return;
      const settings = await deps.readSettings(ctx);
      const sidecars = await deps.readSidecars(current.sessionId);
      if (current.pending || switching || !stillOwnsModel(ctx, current)) return;
      const state = await untilAborted(
        signal,
        buildJudgeState({ goal: run.englishGoal, messages, sidecars, translation, contextMessages: settings.contextMessages }),
      );
      const probability = await untilAborted(signal, () => deps.judgeGoal(ctx, session, state, signal));
      await untilAborted(signal, () => session.settleInFlightMessagePersistence());
      if (current.pending || switching || !stillOwnsModel(ctx, current)) return;
      const latest = readBranchProgress(ctx.sessionManager.getBranch(), startEntryId);
      recordTurns(current, latest.turns);
      const judgment = { probability, at: Date.now(), evidenceId: progress.evidenceId };
      run.judgedTurns++;
      run.lastJudgment = judgment;
      persist({ kind: "judgment", id: run.id, turns: run.turns, judgedTurns: run.judgedTurns, judgment });
      const stale = latest.evidenceId !== judgment.evidenceId;
      const reason = decide(run, settings, judgment.at, stale ? undefined : probability);
      if (reason) await finish(ctx, current, reason, latest.continues);
      else if (stale) queueJudgment(ctx, current);
    } catch (error) {
      if (isCurrent(ctx, current))
        notice(ctx, `Switch-until judgment failed. ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => rebuild(ctx));
  pi.on("session_switch", (_event, ctx) => rebuild(ctx));
  pi.on("session_tree", (_event, ctx) => rebuild(ctx));
  pi.on("session_branch", (_event, ctx) => rebuild(ctx, true));
  pi.on("session_clear", (_event, ctx) => rebuild(ctx));
  pi.on("retry_fallback_applied", (_event, ctx) => {
    if (ctx.agent.kind === "main" && !switching && active) stillOwnsModel(ctx, active);
  });
  pi.on("session_stop", async (event, ctx) => {
    if (ctx.agent.kind !== "main" || (ctx.mode !== "print" && ctx.mode !== "json") || !judgmentTask) return;
    try {
      await untilAborted(event.signal, judgmentTask);
    } catch (error) {
      if (!event.signal.aborted) throw error;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    completionContext = undefined;
    try {
      const outstanding = judgmentTask ?? active?.handoff;
      if (outstanding && (ctx.mode === "print" || ctx.mode === "json")) await untilAborted(AbortSignal.timeout(1_500), outstanding);
    } catch (error) {
      logger.debug("Switch-until work did not settle before shutdown", { error });
    } finally {
      detach(ctx);
    }
  });

  pi.on("context", (event, ctx) => {
    if (ctx.agent.kind !== "main" || switching || !active?.run.context || !stillOwnsModel(ctx, active)) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "user",
          content: `Additional user-provided guidance for the current goal, active until the goal is met:\n\n${active.run.context}`,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("turn_start", async (_event, ctx) => {
    const current = active;
    if (ctx.agent.kind !== "main" || switching || !current || !stillOwnsModel(ctx, current)) return;
    const settings = await deps.readSettings(ctx);
    if (switching || !stillOwnsModel(ctx, current)) return;
    const reason = current.pending ?? decide(current.run, settings, Date.now());
    if (reason) await finish(ctx, current, reason, true);
    else scheduleCheck(ctx, current, deadline(current.run, settings));
  });

  pi.on("turn_end", async (event, ctx) => {
    const current = active;
    if (ctx.agent.kind !== "main" || switching || !current || current.pending || !stillOwnsModel(ctx, current)) return;
    const settings = await deps.readSettings(ctx);
    if (switching || !stillOwnsModel(ctx, current)) return;
    const progress = readBranchProgress(ctx.sessionManager.getBranch(), current.startEntryId);
    recordTurns(current, progress.turns);
    const limit = decide(current.run, settings, Date.now());
    if (limit) {
      const continues = event.toolResults.length > 0 || (event.message.role === "assistant" && event.message.stopReason === "toolUse");
      await finish(ctx, current, limit, continues);
      return;
    }
    scheduleCheck(ctx, current, deadline(current.run, settings));
    if (qualifiesForJudgment(event.message, event.toolResults)) queueJudgment(ctx, current);
  });

  pi.registerCommand("switch-until", {
    description: "Switch the session model until a goal is met, then switch back",
    getArgumentCompletions: (prefix) => {
      if (!completionContext || /\s/.test(prefix)) return null;
      const labels = new Set(["status", "cancel", ...completionContext.models.list().map(modelLabel)]);
      return [...labels].filter((label) => label.toLowerCase().includes(prefix.toLowerCase())).map((label) => ({ label, value: label }));
    },
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== "main") return;
      const raw = args.trim();
      if (switching) {
        notice(ctx, "A switch-until model change is already in progress.", "warning");
        return;
      }
      if (active) stillOwnsModel(ctx, active);
      if (raw === "status") {
        if (active) notice(ctx, describeStatus(active.run));
        else {
          const last = readWorkflow(ctx.sessionManager.getBranch());
          notice(
            ctx,
            last?.ended
              ? `Last switch-until: ${REASONS[last.ended]}.\nGoal: ${last.run.goal}\nLast judgment: ${describeJudgment(last.run)}`
              : "No switch-until is active.",
          );
        }
        return;
      }
      if (raw === "cancel") {
        if (active) await finish(ctx, active, "cancel");
        else notice(ctx, "No switch-until is active.");
        return;
      }
      if (commandOpen) {
        notice(ctx, "Switch-until setup is already open.", "warning");
        return;
      }
      commandOpen = true;
      const previous = active;
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        const original = ctx.models.current();
        const session = deps.sessionFor(ctx);
        if (!session || !original) throw new Error("Switch-until requires an active session model.");
        if (previous) {
          if (!ctx.hasUI) throw new Error("A switch-until is active. Run /switch-until cancel before starting another.");
          if (
            !(await ctx.ui.confirm("Replace the active switch-until?", "The first model and thinking level will remain the restore point."))
          )
            return;
        }

        const headless = ctx.hasUI ? undefined : parseHeadlessArgs(raw);
        const selector = headless?.selector ?? raw;
        const pick = selector ? deps.resolveSelection(selector, session) : await pickModel(ctx, session);
        if (!pick) return;
        if (!deps.hasNativeJudge(ctx, pick.model)) throw new Error(NATIVE_JUDGE_HINT);
        const goal = headless?.goal ?? (await ctx.ui.input("Until what?"))?.trim();
        if (!goal || /[\r\n]/.test(goal)) return;
        const context = headless ? headless.context : await ctx.ui.editor("Additional context (optional)");
        if (ctx.hasUI && context === undefined) return;

        const configured = await deps.readSettings(ctx);
        const englishGoal = await new TranslationCache((text) =>
          deps.translateToEnglish(ctx, session, text, AbortSignal.timeout(60_000)),
        ).translate(goal);
        const isSetupCurrent = () => {
          if (previous && !stillOwnsModel(ctx, previous)) return false;
          return active === previous && matchesModel(ctx.models.current(), original) && ctx.sessionManager.getSessionId() === sessionId;
        };
        if (switching || !isSetupCurrent()) throw new Error("The session changed during switch-until setup. Run the command again.");
        switching = true;
        try {
          const originalSelection = captureSelection(original, session);
          await compactToFit(ctx, session, pick.model);
          if (!isSetupCurrent()) throw new Error("The session changed during switch-until setup. Run the command again.");
          if (!deps.hasNativeJudge(ctx, pick.model)) throw new Error(NATIVE_JUDGE_HINT);
          await session.setModelTemporary(pick.model, pick.thinking ?? pick.model.thinking?.defaultLevel);
          if (ctx.sessionManager.getSessionId() !== sessionId || active !== previous || !matchesModel(ctx.models.current(), pick.model)) {
            throw new Error("The selected model was superseded during switch-until setup.");
          }
          const run = startUntil(
            {
              id: randomUUID(),
              original: originalSelection,
              target: captureSelection(pick.model, session),
              goal,
              englishGoal,
              context: context?.trim() || undefined,
              startedAt: Date.now(),
            },
            previous?.run,
          );
          persist({ kind: "start", run });
          const workflow = readWorkflow(ctx.sessionManager.getBranch());
          if (!workflow || workflow.run.id !== run.id) throw new Error("Could not read the saved switch-until run.");
          const prewalkOff = disarmPrewalk(session);
          detach(ctx);
          scheduleCheck(ctx, attach(ctx, session, workflow), deadline(run, configured));
          notice(
            ctx,
            `Switched to ${run.target.selector} (${run.target.thinking ?? "default"} thinking) until: ${goal}${prewalkOff ? " Auto prewalk is off for this session until /new." : ""}`,
          );
        } finally {
          switching = false;
        }
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      } finally {
        commandOpen = false;
      }
    },
  });
}
