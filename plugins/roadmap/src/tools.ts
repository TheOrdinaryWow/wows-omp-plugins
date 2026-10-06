import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { check, type Diagnostics } from "#src/check.ts";
import { loadAll, loadRepo, type Model, type Repo, renderStage } from "#src/documents.ts";
import { discoverRepo } from "#src/git.ts";
import { renderHandoff, renderInjection } from "#src/handoff.ts";
import { withRepoLock } from "#src/numbering.ts";
import {
  type Actor,
  adr,
  applyPrepared,
  prepareInit,
  prepareRoundOpen,
  type Receipt,
  recordFreeWork,
  stage,
  todo,
} from "#src/operations.ts";
import { actor, type RoadmapSession, type UiFactory } from "#src/ses.ts";
import type { OverlapAnswer } from "#src/ui.ts";

export type ToolReceipt = Receipt & { answer?: OverlapAnswer; diagnostics?: Diagnostics[]; changedFiles?: string[] };

export function toolResult(receipt: ToolReceipt) {
  const text = receipt.ok
    ? [
        receipt.summary,
        ...receipt.warnings.map((warning) => `Warning: ${warning}`),
        receipt.handoff,
        receipt.changedFiles.length
          ? `Changed: ${receipt.changedFiles.join(", ")}. Commit these files per the project's rules.`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n")
    : [receipt.reason, ...receipt.hints].join("\n");
  return { content: [{ type: "text" as const, text }], details: receipt, isError: !receipt.ok };
}

export async function requireRepo(ctx: ExtensionContext, initialize = false): Promise<Repo> {
  const git = discoverRepo(ctx.cwd);
  if (!git) throw new Error("Roadmap requires a git work tree.");
  if (initialize) return { ...git, roadmapDir: join(git.repoRoot, "docs/roadmap"), adrDir: join(git.repoRoot, "docs/adr") };
  const repo = await loadRepo(git.repoRoot);
  if (!repo) throw new Error("Roadmap is not initialized in this repository. Use /init-project first.");
  return repo;
}

export async function statusReceipt(repo: Repo, id?: string): Promise<Receipt> {
  const model = await loadAll(repo);
  if (id) {
    const current = model.stages.find((candidate) => candidate.id === id);
    if (!current) return { ok: false, reason: `Unknown stage ${id}.`, hints: ["Call roadmap_status for stage ids."] };
    return { ok: true, summary: renderStage(current), handoff: renderHandoff(model, current), changedFiles: [], warnings: [] };
  }
  const open = model.todos.flatMap((doc) => doc.items.filter((item) => item.status === "open"));
  return {
    ok: true,
    summary: [
      model.index.title,
      renderInjection(model) || "No active round. ADR management remains available.",
      "Stages:",
      ...model.stages.map((current) => `- ${current.id} [${current.status}] ${current.title} (${current.round})`),
      "Open TODOs by target or trigger:",
      ...open.map((item) => `- ${item.id} [${item.severity}] ${item.target ?? item.trigger}: ${item.title}`),
    ].join("\n"),
    changedFiles: [],
    warnings: (model.parseErrors ?? []).map((issue) => `${issue.path}: ${issue.message}`),
  };
}

export async function checkReceipt(repo: Repo, fix = false, signal?: AbortSignal): Promise<ToolReceipt> {
  const model = await loadAll(repo);
  const before = new Map(Object.entries(model.files ?? {}).map(([path, content]) => [path, Buffer.from(content)]));
  const diagnostics = await check(model, { fix, signal });
  const changedFiles = fix
    ? Object.entries(model.files ?? {})
        .filter(([path, content]) => !before.get(path)?.equals(Buffer.from(content)))
        .map(([path]) => path)
    : [];
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const lines = diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.rule} — ${diagnostic.path}: ${diagnostic.message}`);
  if (errors.length) {
    const hints = ["Check verifies document consistency, not code/document drift."];
    const cancelled = errors.some((diagnostic) => diagnostic.rule === "cancelled");
    if (cancelled) {
      hints.push(
        changedFiles.length
          ? `Files committed by the interrupted fix: ${changedFiles.join(", ")}. Commit these files per the project's rules.`
          : "No files were committed by the interrupted fix.",
        "Run roadmap_check with fix: true again to finish regenerating eligible generated blocks, then run roadmap_check to verify consistency.",
      );
    } else if (changedFiles.length) hints.push(`Regenerated: ${changedFiles.join(", ")}. Commit these files per the project's rules.`);
    return { ok: false, reason: lines.join("\n"), hints, diagnostics, ...(cancelled ? { changedFiles } : {}) };
  }
  return {
    ok: true,
    summary: `${fix ? "Regenerated eligible generated blocks. " : ""}Roadmap check passed. Check verifies document consistency, not code/document drift.`,
    changedFiles,
    warnings: lines,
    diagnostics,
  };
}

export function registerTools(pi: ExtensionAPI, ses: RoadmapSession, uiFor: UiFactory): void {
  const z = pi.zod;
  const overlapFlights = new Map<string, Promise<ToolReceipt>>();
  const criterion = z.object({ id: z.string().optional(), statement: z.string(), verify: z.string() });
  const stageFields = {
    id: z.string().optional(),
    title: z.string(),
    objective: z.string(),
    scope_in: z.array(z.string()),
    scope_out: z.array(z.string()),
    done_criteria: z.array(criterion),
    depends_on: z.array(z.string()).optional(),
    follows: z.string().optional(),
    design_constraints: z.string().optional(),
    risks: z.string().optional(),
  };
  const sections = z.object({
    context: z.string(),
    drivers: z.string().optional(),
    options: z.array(z.string()),
    outcome: z.string(),
    consequences: z.string().optional(),
    confirmation: z.string().optional(),
    pros_cons: z.string().optional(),
    more_info: z.string().optional(),
  });
  const adrFields = {
    id: z.string().optional(),
    title: z.string(),
    status: z.enum(["proposed", "accepted", "rejected", "deprecated"]).optional(),
    stage: z.string().optional(),
    sections,
    decision_makers: z.array(z.string()).optional(),
    consulted: z.array(z.string()).optional(),
    informed: z.array(z.string()).optional(),
  };
  const round = z.object({
    title: z.string(),
    goal: z.string(),
    constraints: z.array(z.string()),
    non_goals: z.array(z.string()),
    principles: z.array(z.object({ text: z.string(), adrs: z.array(z.string()) })),
  });
  const statusParameters = z.object({ stage: z.string().optional() });
  const stageParameters = z.object({
    ...stageFields,
    title: z.string().optional(),
    objective: z.string().optional(),
    scope_in: z.array(z.string()).optional(),
    scope_out: z.array(z.string()).optional(),
    done_criteria: z.array(criterion).optional(),
    action: z.enum(["add", "edit", "amend", "start", "close", "drop", "renumber"]),
    reason: z.string().optional(),
    amendments: z
      .object({
        add: z.array(criterion).optional(),
        modify: z.array(z.object({ id: z.string(), statement: z.string(), verify: z.string() })).optional(),
        remove: z.array(z.string()).optional(),
        scope: z.array(z.object({ op: z.enum(["add", "remove"]), side: z.enum(["in", "out"]), item: z.string() })).optional(),
      })
      .optional(),
    delivered: z.string().optional(),
    deviations: z.string().optional(),
    evidence: z
      .array(
        z.object({
          criterion: z.string(),
          result: z.enum(["pass", "fail"]),
          method: z.string(),
          summary: z.string(),
          commit: z.string().optional(),
        }),
      )
      .optional(),
    todos: z
      .array(
        z.object({
          id: z.string(),
          disposition: z.enum(["resolved", "moved"]),
          target: z.string().optional(),
          reference: z.string().optional(),
        }),
      )
      .optional(),
    adrs: z.array(z.object({ id: z.string(), status: z.enum(["accepted", "rejected"]) })).optional(),
    new_id: z.string().optional(),
  });
  const todoParameters = z.object({
    action: z.enum(["add", "update", "resolve", "move"]),
    id: z.string().optional(),
    title: z.string().optional(),
    severity: z.enum(["high", "normal", "low"]).optional(),
    source: z.string().optional(),
    target: z.string().optional(),
    trigger: z.string().optional(),
    body: z.string().optional(),
    reference: z.string().optional(),
  });
  const adrParameters = z.object({
    ...adrFields,
    action: z.enum(["create", "revise", "set_status", "supersede", "note"]),
    title: z.string().optional(),
    sections: sections.optional(),
    text: z.string().optional(),
  });
  const checkParameters = z.object({ fix: z.boolean().optional() });
  const overlapParameters = z.object({ stage: z.string(), intent: z.string() });
  const initParameters = z.object({
    project: z.object({ name: z.string(), description: z.string() }),
    round,
    adrs: z.array(z.object(adrFields)),
    stages: z.array(z.object(stageFields)),
  });
  const roundParameters = z.object({ round, import_todos: z.array(z.string()) });

  async function run(ctx: ExtensionContext, operation: (repo: Repo, owner: Actor) => Promise<ToolReceipt>, initialize = false) {
    try {
      ses.ensure(ctx);
      return toolResult(await operation(await requireRepo(ctx, initialize), actor(ctx)));
    } catch (error) {
      return toolResult({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        hints: ["Run roadmap_check to inspect managed files."],
      });
    }
  }

  pi.registerTool({
    name: "roadmap_status",
    label: "Roadmap status",
    description: "Read rounds, stages and open TODOs. Supply a stage id for its full document and planning handoff.",
    parameters: statusParameters,
    approval: "read",
    async execute(_id, params: typeof statusParameters.infer, _signal, _onUpdate, ctx) {
      return run(ctx, (repo) => statusReceipt(repo, params.stage));
    },
  });
  pi.registerTool({
    name: "roadmap_stage",
    label: "Roadmap stage",
    description:
      "Manage stage lifecycle. Start or join returns the planning handoff and binds this session. Close requires passing evidence for every done criterion and TODO/ADR dispositions.",
    parameters: stageParameters,
    approval: "write",
    async execute(_id, params: typeof stageParameters.infer, signal, _onUpdate, ctx) {
      const generation = ses.currentGeneration(ctx);
      return run(ctx, (repo, owner) =>
        stage(repo, owner, params, {
          signal,
          onSuccess() {
            if (!params.id || !ses.isCurrent(ctx, generation)) return;
            if (params.action === "start") ses.bind(ctx, repo.repoRoot, params.id);
            if (params.action === "close" || params.action === "drop") ses.clearStage(ctx, repo.repoRoot, params.id);
          },
        }),
      );
    },
  });
  pi.registerTool({
    name: "roadmap_todo",
    label: "Roadmap TODO",
    description:
      "Add, update, resolve or move carry-over TODOs with a source, severity and an unclosed target stage or trigger. Fix broken tests/builds before proceeding.",
    parameters: todoParameters,
    approval: "write",
    async execute(_id, params: typeof todoParameters.infer, signal, _onUpdate, ctx) {
      return run(ctx, (repo, owner) => todo(repo, owner, params, { signal }));
    },
  });
  pi.registerTool({
    name: "roadmap_adr",
    label: "Roadmap ADR",
    description:
      "Create MADR decisions, revise proposed ADRs, change status, supersede or append a dated note. Subagents can only create proposed ADRs and cannot decide statuses or supersede.",
    parameters: adrParameters,
    approval: "write",
    async execute(_id, params: typeof adrParameters.infer, signal, _onUpdate, ctx) {
      return run(ctx, (repo, owner) => adr(repo, owner, params, { signal }));
    },
  });
  pi.registerTool({
    name: "roadmap_check",
    label: "Roadmap check",
    description:
      "Check document consistency. fix regenerates eligible generated blocks without changing frozen rounds. Does not compare documents with code.",
    parameters: checkParameters,
    approval: "write",
    async execute(_id, params: typeof checkParameters.infer, signal, _onUpdate, ctx) {
      return run(ctx, (repo) => checkReceipt(repo, params.fix, signal));
    },
  });
  pi.registerTool({
    name: "roadmap_overlap",
    label: "Roadmap overlap",
    description:
      "Ask the user once per stage/session whether overlapping work should use the roadmap, be logged as free work, or be treated as unrelated. Subagents do not prompt.",
    parameters: overlapParameters,
    approval: "write",
    async execute(_id, params: typeof overlapParameters.infer, signal, _onUpdate, ctx) {
      if (ctx.agent.kind === "sub")
        return toolResult({ ok: true, summary: "Subagents do not ask overlap questions.", changedFiles: [], warnings: [] });
      const generation = ses.currentGeneration(ctx);
      return run(ctx, (repo, owner) => {
        const key = JSON.stringify([owner.sessionId, repo.repoRoot, params.stage, generation]);
        const pending = overlapFlights.get(key);
        if (pending) return pending;
        const stale = (): ToolReceipt => ({
          ok: false,
          reason: "Roadmap overlap answer is stale: the session or stage changed while the dialog was open.",
          hints: ["Call roadmap_overlap again to review the current session and stage."],
        });
        const resolve = async (): Promise<ToolReceipt> => {
          const model = await loadAll(repo);
          if (!ses.isCurrent(ctx, generation)) return stale();
          ses.validateBinding(ctx, repo.repoRoot, model);
          const current = model.stages.find((candidate) => candidate.id === params.stage);
          const roundId = current?.round;
          if (
            !current ||
            (current.status !== "planned" && current.status !== "active") ||
            !model.rounds.some((candidate) => candidate.id === roundId && candidate.status === "active")
          ) {
            return { ok: false, reason: `${params.stage} is not an unclosed stage in an active round.`, hints: [] };
          }
          let stored = ses.overlapAnswer(ctx, repo.repoRoot, current.id);
          let answer = stored;
          if (ses.getBinding(repo.repoRoot)?.stage !== current.id && !stored) {
            answer = await uiFor(ctx).overlap({ stage: current, intent: params.intent });
          }
          const guard = (latest: Model): ToolReceipt | undefined => {
            if (signal?.aborted) return { ok: false, reason: "Roadmap overlap cancelled.", hints: [] };
            if (!ses.isCurrent(ctx, generation)) return stale();
            const candidate = latest.stages.find((entry) => entry.id === params.stage);
            if (
              !candidate ||
              candidate.round !== roundId ||
              (candidate.status !== "planned" && candidate.status !== "active") ||
              !latest.rounds.some((entry) => entry.id === roundId && entry.status === "active")
            )
              return stale();
            ses.validateBinding(ctx, repo.repoRoot, latest);
            stored = ses.overlapAnswer(ctx, repo.repoRoot, candidate.id);
            answer = stored ?? answer;
            if (ses.getBinding(repo.repoRoot)?.stage === candidate.id) {
              answer = "roadmap";
              return {
                ok: true,
                summary: `This session is already working in-system on ${candidate.id}.`,
                answer,
                handoff: renderHandoff(latest, candidate),
                changedFiles: [],
                warnings: [],
              };
            }
            if (!answer)
              return {
                ok: false,
                reason: "Roadmap overlap: no answer available.",
                hints: ["Ask the user in an interactive session before beginning overlapping work."],
              };
            if (stored && answer !== "roadmap")
              return { ok: true, summary: `Overlap answer for ${candidate.id}: ${answer}.`, answer, changedFiles: [], warnings: [] };
          };
          const onSuccess = (): void => {
            if (!ses.isCurrent(ctx, generation) || !answer) return;
            if (answer === "roadmap") ses.bind(ctx, repo.repoRoot, current.id);
            if (!stored) ses.answerOverlap(ctx, repo.repoRoot, current.id, answer);
          };
          let receipt: Receipt;
          if (answer === "free" && !stored) receipt = await recordFreeWork(repo, owner, params, { signal, guard, onSuccess });
          else if (answer === "roadmap")
            receipt = await stage(repo, owner, { action: "start", id: current.id }, { signal, guard, onSuccess });
          else
            receipt = await withRepoLock(repo, async () => {
              const guarded = guard(await loadAll(repo));
              if (guarded) return guarded;
              onSuccess();
              return { ok: true, summary: `Overlap answer for ${current.id}: ${answer}.`, changedFiles: [], warnings: [] };
            });
          return receipt.ok ? { ...receipt, answer } : receipt;
        };
        const flight = resolve().finally(() => overlapFlights.delete(key));
        overlapFlights.set(key, flight);
        return flight;
      });
    },
  });
  pi.registerTool({
    name: "roadmap_init",
    label: "Initialize Roadmap",
    description:
      "Write the interviewed project, first-round charter, initial ADRs and stages after an exact user-confirmed preview. Only available to the main session armed by /init-project.",
    parameters: initParameters,
    approval: "write",
    async execute(_id, params: typeof initParameters.infer, signal, _onUpdate, ctx) {
      const generation = ses.currentGeneration(ctx);
      return run(
        ctx,
        async (repo, owner) => {
          if (!ses.isArmed(ctx, repo.repoRoot, "init"))
            return { ok: false, reason: "roadmap_init is unarmed. Run /init-project first.", hints: [] };
          const guard = (): Receipt | undefined => {
            if (
              ctx.sessionManager.getSessionId() !== owner.sessionId ||
              !ses.isCurrent(ctx, generation) ||
              !ses.isArmed(ctx, repo.repoRoot, "init")
            )
              return { ok: false, reason: "Initialization authorization changed; run /init-project again.", hints: [] };
          };
          const prepared = await prepareInit(repo, owner, params);
          if (!prepared.ok) return prepared;
          const confirmed = await uiFor(ctx).previewConfirm({ title: prepared.summary, files: prepared.files });
          if (confirmed !== true || signal?.aborted)
            return {
              ok: false,
              reason: confirmed === false ? "Initialization preview declined." : "Initialization: no answer available or cancelled.",
              hints: [],
            };
          const stale = guard();
          if (stale) return stale;
          return applyPrepared(repo, owner, prepared.prepared, {
            guard,
            signal,
            onSuccess() {
              if (ses.isCurrent(ctx, generation) && ses.isArmed(ctx, repo.repoRoot, "init")) ses.disarm(ctx, repo.repoRoot);
            },
          });
        },
        true,
      );
    },
  });
  pi.registerTool({
    name: "roadmap_round_open",
    label: "Open Roadmap round",
    description:
      "Open the next round from its charter and carried TODO ids after a confirmed preview. Only available to the main session armed by /roadmap new-round.",
    parameters: roundParameters,
    approval: "write",
    async execute(_id, params: typeof roundParameters.infer, signal, _onUpdate, ctx) {
      const generation = ses.currentGeneration(ctx);
      return run(ctx, async (repo, owner) => {
        if (!ses.isArmed(ctx, repo.repoRoot, "round"))
          return { ok: false, reason: "roadmap_round_open is unarmed. Run /roadmap new-round first.", hints: [] };
        const guard = (): Receipt | undefined => {
          if (
            ctx.sessionManager.getSessionId() !== owner.sessionId ||
            !ses.isCurrent(ctx, generation) ||
            !ses.isArmed(ctx, repo.repoRoot, "round")
          )
            return { ok: false, reason: "Round authorization changed; run /roadmap new-round again.", hints: [] };
        };
        const prepared = await prepareRoundOpen(repo, owner, params);
        if (!prepared.ok) return prepared;
        const confirmed = await uiFor(ctx).previewConfirm({ title: prepared.summary, files: prepared.files });
        if (confirmed !== true || signal?.aborted)
          return {
            ok: false,
            reason: confirmed === false ? "Round preview declined." : "Round open: no answer available or cancelled.",
            hints: [],
          };
        const stale = guard();
        if (stale) return stale;
        return applyPrepared(repo, owner, prepared.prepared, {
          guard,
          signal,
          onSuccess() {
            if (ses.isCurrent(ctx, generation) && ses.isArmed(ctx, repo.repoRoot, "round")) ses.disarm(ctx, repo.repoRoot);
          },
        });
      });
    },
  });
}
