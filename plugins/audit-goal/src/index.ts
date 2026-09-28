import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { readHostSetting } from "#src/host-settings.ts";
import {
  type AuditSettings,
  type AuditState,
  auditItemsIn,
  effectiveLaneLimit,
  extensionChoices,
  isAuditAgent,
  laneLabel,
  limitLabel,
  parseSettings,
  type RoundRecord,
  renderTemplate,
  selfFeedingSignal,
  totals,
  validateRound,
  verdict,
} from "#src/ledger.ts";

const PACKAGE_NAME = "wows-omp-plugin-audit-goal";
const STATE_ENTRY = "wows-omp-audit-goal.state";
const PROTOCOL_MESSAGE = "wows-omp-audit-goal.protocol";
const STATUS_KEY = "audit-goal";
const ROUND_TOOL = "audit_round";
const LOOP_TOOLS = ["goal", ROUND_TOOL];
const RUNTIME_SOURCE_PATH = fileURLToPath(import.meta.url);

/** Present on hosts whose subagent lifecycle hook can refuse a spawn; older hosts never emit it. */
interface SubagentSpawnEvent {
  agent?: unknown;
  invocationKind?: unknown;
}
type SubagentSpawnOn = (
  event: "before_subagent_spawn",
  handler: (event: SubagentSpawnEvent, ctx: ExtensionContext) => { block: true; reason: string } | undefined,
) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const assetBodies = new Map<string, string>();
async function loadAsset(relativePath: string): Promise<string> {
  const cached = assetBodies.get(relativePath);
  if (cached !== undefined) return cached;
  const body = (await readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")).trim();
  if (!body) throw new Error(`prompt asset ${relativePath} is empty`);
  assetBodies.set(relativePath, body);
  return body;
}

async function buildProtocol(state: AuditState): Promise<string> {
  const [template, intensityRules] = await Promise.all([
    loadAsset("../assets/protocol.md"),
    loadAsset(`../assets/intensity/${state.intensity}.md`),
  ]);
  return renderTemplate(template, {
    target: state.target,
    intensity: state.intensity,
    intensityRules,
    roundLimit: limitLabel(state.maxRounds),
    laneLimit: laneLabel(state.laneLimit),
    baseline: state.baseline ?? "none (not a git repository)",
  });
}

function ledgerSummary(state: AuditState): string {
  const sum = totals(state.rounds);
  const lines = [
    `Target: ${state.target}`,
    `Intensity: ${state.intensity}`,
    `Baseline: ${state.baseline ?? "none (not a git repository)"}`,
    `Rounds recorded: ${state.rounds.length} (limit: ${limitLabel(state.maxRounds)})`,
    `Lane limit: ${laneLabel(state.laneLimit)}`,
    `Verified findings so far: critical ${sum.critical}, major ${sum.major}, minor ${sum.minor}, picky ${sum.picky} (loop-induced ${sum.loopInduced}); rejected ${sum.rejected}`,
  ];
  for (const round of state.rounds) {
    lines.push(
      `- round ${round.round}: C${round.critical} M${round.major} m${round.minor} p${round.picky}, loop-induced ${round.loopInduced}, rejected ${round.rejected}`,
    );
  }
  if (state.capPending) lines.push("Round limit exhausted: awaiting audit_round op=extend.");
  return lines.join("\n");
}

function vibeModeActive(session: AgentSession): boolean {
  const host: object = session;
  if (!("getVibeModeState" in host) || typeof host.getVibeModeState !== "function") return false;
  return host.getVibeModeState()?.enabled === true;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export default function auditGoal(pi: ExtensionAPI): void {
  const states = new Map<string, AuditState>();
  /** In-flight audit subagents per session, keyed by the dispatching task tool call. */
  const inflight = new Map<string, Map<string, number>>();

  const mainSession = (ctx: ExtensionContext): AgentSession | undefined => {
    try {
      return (
        AgentRegistry.global()
          .list()
          .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager)?.session ?? undefined
      );
    } catch (error) {
      pi.logger.warn("audit-goal could not resolve the main session", { error: errorMessage(error) });
      return undefined;
    }
  };

  /** The loop is live only while its own goal is still the session goal and neither complete nor dropped. */
  const liveAudit = (ctx: ExtensionContext): { session: AgentSession; state: AuditState } | undefined => {
    const session = mainSession(ctx);
    const state = states.get(ctx.sessionManager.getSessionId());
    if (!session || state?.status !== "active") return undefined;
    const goal = session.getGoalModeState()?.goal;
    if (!goal || goal.id !== state.goalId || goal.status === "complete" || goal.status === "dropped") return undefined;
    return { session, state };
  };

  const persist = (state: AuditState): void => {
    try {
      pi.appendEntry(STATE_ENTRY, state);
    } catch (error) {
      pi.logger.warn("audit-goal could not persist its ledger", { error: errorMessage(error) });
    }
  };

  const showStatus = (ctx: ExtensionContext, state: AuditState | undefined): void => {
    const text =
      state?.status === "active"
        ? `Audit ${state.rounds.length}/${state.maxRounds ?? "∞"} · ${state.intensity}${state.capPending ? " · limit reached" : ""}`
        : undefined;
    ctx.ui.setStatus?.(STATUS_KEY, text);
  };

  const syncLoopTools = async (state: AuditState, wanted: boolean): Promise<void> => {
    try {
      const active = pi.getActiveTools();
      if (wanted) {
        const missing = LOOP_TOOLS.filter((name) => !active.includes(name));
        if (missing.length === 0) return;
        state.addedTools = [...new Set([...state.addedTools, ...missing])];
        await pi.setActiveTools([...active, ...missing]);
        return;
      }
      if (state.addedTools.length === 0) return;
      await pi.setActiveTools(active.filter((name) => !state.addedTools.includes(name)));
      state.addedTools = [];
    } catch (error) {
      pi.logger.warn("audit-goal could not reconcile loop tools", { error: errorMessage(error) });
    }
  };

  const endAudit = async (ctx: ExtensionContext, state: AuditState, reason: string): Promise<void> => {
    state.status = "ended";
    state.capPending = false;
    await syncLoopTools(state, false);
    persist(state);
    showStatus(ctx, state);
    inflight.delete(ctx.sessionManager.getSessionId());
    ctx.ui.notify(`Audit loop ${reason} after ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"}.`, "info");
  };

  const rehydrate = (ctx: ExtensionContext): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    states.delete(sessionId);
    inflight.delete(sessionId);
    if (!mainSession(ctx)) return;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const data: unknown = entry.data;
      if (data && typeof data === "object" && "version" in data && data.version === 1) {
        // Written only by persist() above, from a fully typed AuditState.
        const restored = structuredClone(data) as AuditState;
        states.set(sessionId, restored);
      }
    }
    showStatus(ctx, states.get(sessionId));
  };

  const sendProtocol = async (ctx: ExtensionContext, state: AuditState, withLedger: boolean): Promise<boolean> => {
    try {
      const protocol = await buildProtocol(state);
      const ledger = withLedger ? `\n\n<audit-ledger>\n${ledgerSummary(state)}\n</audit-ledger>` : "";
      pi.sendMessage(
        {
          customType: PROTOCOL_MESSAGE,
          content: `<audit-protocol>\n${protocol}\n</audit-protocol>${ledger}`,
          display: false,
          attribution: "user",
        },
        { deliverAs: ctx.isIdle() ? "nextTurn" : "aside" },
      );
      return true;
    } catch (error) {
      ctx.ui.notify(`Audit protocol could not be loaded (${errorMessage(error)}).`, "error");
      return false;
    }
  };

  const loadSettings = async (ctx: ExtensionContext): Promise<AuditSettings | undefined> => {
    try {
      return parseSettings(await getPluginSettings(PACKAGE_NAME, ctx.cwd));
    } catch (error) {
      ctx.ui.notify(`audit-goal settings are invalid (${errorMessage(error)}).`, "error");
      return undefined;
    }
  };

  const startAudit = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const target = args.trim();
    if (!target) {
      ctx.ui.notify("Usage: /audit <audit-target>", "warning");
      return;
    }
    const session = mainSession(ctx);
    if (!session) {
      ctx.ui.notify("/audit runs in the main session only", "warning");
      return;
    }
    if (liveAudit(ctx)) {
      ctx.ui.notify("An /audit loop is already running in this session. Use /goal to manage it.", "warning");
      return;
    }
    try {
      if ((await readHostSetting(session.settings, "goal.enabled")) === false) {
        ctx.ui.notify("Goal mode is disabled. Enable it in settings (goal.enabled).", "warning");
        return;
      }
    } catch (error) {
      pi.logger.warn("audit-goal could not read goal.enabled; assuming enabled", { error: errorMessage(error) });
    }
    if (session.getPlanModeState()?.enabled) {
      ctx.ui.notify("Exit plan mode before starting /audit.", "warning");
      return;
    }
    if (vibeModeActive(session)) {
      ctx.ui.notify("Exit vibe mode before starting /audit.", "warning");
      return;
    }
    const existing = session.getGoalModeState()?.goal;
    if (existing && existing.status !== "complete" && existing.status !== "dropped") {
      ctx.ui.notify("This session already has a goal. Finish it or run /goal drop before starting /audit.", "warning");
      return;
    }
    const settings = await loadSettings(ctx);
    if (!settings) return;

    let hostConcurrency: unknown;
    try {
      hostConcurrency = await readHostSetting(session.settings, "task.maxConcurrency");
    } catch (error) {
      pi.logger.warn("audit-goal could not read task.maxConcurrency", { error: errorMessage(error) });
    }

    let baseline: string | null = null;
    try {
      const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: ctx.cwd, timeout: 10_000 });
      if (head.code === 0 && head.stdout.trim()) baseline = head.stdout.trim();
    } catch (error) {
      pi.logger.warn("audit-goal could not read the git baseline", { error: errorMessage(error) });
    }

    const state: AuditState = {
      version: 1,
      status: "active",
      goalId: "",
      target,
      intensity: settings.intensity,
      maxRounds: settings.maxRounds ?? null,
      laneLimit: effectiveLaneLimit(settings.maxParallelLanes, hostConcurrency),
      baseline,
      rounds: [],
      capPending: false,
      addedTools: [],
    };
    try {
      await buildProtocol(state);
    } catch (error) {
      ctx.ui.notify(`Audit protocol could not be loaded (${errorMessage(error)}).`, "error");
      return;
    }

    await syncLoopTools(state, true);
    try {
      const created = await session.goalRuntime.createGoal({ objective: `Audit loop (/audit): ${target}` });
      state.goalId = created.goal.id;
    } catch (error) {
      await syncLoopTools(state, false);
      ctx.ui.notify(`Could not start the audit goal (${errorMessage(error)}).`, "error");
      return;
    }
    states.set(ctx.sessionManager.getSessionId(), state);
    persist(state);
    showStatus(ctx, state);
    if (!(await sendProtocol(ctx, state, false))) return;
    pi.sendUserMessage(`Run the audit loop.\n\n<audit-target>\n${target}\n</audit-target>`);
  };

  pi.registerCommand("audit", {
    description: "Start a goal that loops independent audits and fixes until the target converges",
    handler: startAudit,
  });

  const z = pi.zod;
  const roundParameters = z.object({
    op: z
      .enum(["record", "extend", "status"])
      .describe("record closes a finished round; extend asks the user for more rounds after cap-reached; status shows the ledger"),
    round: z.number().int().optional().describe("record: 1-based number of the round being closed"),
    critical: z.number().int().optional().describe("record: verified Critical findings this round"),
    major: z.number().int().optional().describe("record: verified Major findings this round"),
    minor: z.number().int().optional().describe("record: verified Minor findings this round"),
    picky: z.number().int().optional().describe("record: verified Picky findings this round"),
    rejected: z.number().int().optional().describe("record: auditor findings rejected after source verification"),
    loopInduced: z
      .number()
      .int()
      .optional()
      .describe("record: how many of this round's verified findings have their root cause in code the loop changed since the baseline"),
  });
  type RoundParams = {
    op: "record" | "extend" | "status";
    round?: number;
    critical?: number;
    major?: number;
    minor?: number;
    picky?: number;
    rejected?: number;
    loopInduced?: number;
  };

  const recordRound = (ctx: ExtensionContext, state: AuditState, params: RoundParams) => {
    const record: RoundRecord = {
      round: params.round ?? Number.NaN,
      critical: params.critical ?? Number.NaN,
      major: params.major ?? Number.NaN,
      minor: params.minor ?? Number.NaN,
      picky: params.picky ?? Number.NaN,
      rejected: params.rejected ?? Number.NaN,
      loopInduced: params.loopInduced ?? Number.NaN,
    };
    const invalid = validateRound(state, record);
    if (invalid) return textResult(invalid, true);
    state.rounds.push(record);
    const outcome = verdict(state);
    state.capPending = outcome === "cap-reached";
    persist(state);
    showStatus(ctx, state);

    const header = `Round ${record.round} recorded.\n${ledgerSummary(state)}\n\nVerdict: ${outcome}.`;
    switch (outcome) {
      case "converged":
        return textResult(
          `${header}\nThe ${state.intensity} exit gate is met. Write the final convergence report as the protocol requires, then call goal({op:"complete"}).`,
        );
      case "self-feeding":
        return textResult(
          `${header}\nThe loop is feeding itself: its recent findings come mostly from its own earlier fixes. Stop adding mechanisms. You MAY declare convergence (final report, then goal({op:"complete"})); if you continue with round ${record.round + 1}, state why, and prefer reverting or simplifying loop-introduced mechanisms over layering new fixes.`,
        );
      case "cap-reached":
        return textResult(
          `${header}\nThe round limit is exhausted without convergence${selfFeedingSignal(state.rounds) ? " (a self-feeding signal is present; say so)" : ""}. First write the interim report to the user: state plainly that the audit is NOT finished because the round limit ran out, and list the open findings by severity and what remains unaudited. Then call ${ROUND_TOOL}({op:"extend"}). Do not dispatch further audit or fix work before that.`,
        );
      default:
        return textResult(`${header}\nStart round ${record.round + 1}.`);
    }
  };

  const extendRounds = async (ctx: ExtensionContext, state: AuditState) => {
    if (!state.capPending || state.maxRounds === null) {
      return textResult("op=extend is only valid after record returned cap-reached.", true);
    }
    const stop = textResult(
      `The user did not extend the audit. Append closing notes to your interim report (what remains unaudited, open findings, where they are recorded), then call goal({op:"complete"}).`,
    );
    if (!ctx.hasUI) return stop;
    const choices = extensionChoices(state.maxRounds);
    let selected: string | undefined;
    try {
      selected = await ctx.ui.select(
        `Audit round limit reached (${state.rounds.length}/${state.maxRounds}) and the audit is not finished. Keep auditing?`,
        choices.map((choice) => choice.label),
      );
    } catch (error) {
      pi.logger.warn("audit-goal round extension prompt failed", { error: errorMessage(error) });
    }
    const choice = choices.find((candidate) => candidate.label === selected);
    if (!choice || choice.newLimit === undefined) return stop;
    state.maxRounds = choice.newLimit;
    state.capPending = false;
    persist(state);
    showStatus(ctx, state);
    return textResult(`The user extended the audit. New limit: ${limitLabel(state.maxRounds)}. Start round ${state.rounds.length + 1}.`);
  };

  pi.registerTool({
    name: ROUND_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Audit Round",
    description:
      "Round ledger for the active /audit loop. record once at the end of every round (after fixes landed, full CI ran, and the tree is clean) with verified finding counts; it returns the verdict and next action. extend only after cap-reached, to ask the user for more rounds. status shows the ledger.",
    parameters: roundParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (_toolCallId, params: RoundParams, _signal, _onUpdate, ctx) => {
      const live = liveAudit(ctx);
      if (!live) return textResult("No /audit loop is active in this main session.", true);
      if (params.op === "status") return textResult(ledgerSummary(live.state));
      if (params.op === "extend") return await extendRounds(ctx, live.state);
      return recordRound(ctx, live.state, params);
    },
  });

  const dispatchRefusal = (ctx: ExtensionContext, requested: number): string | undefined => {
    const live = liveAudit(ctx);
    if (!live) {
      return "audit-auditor and audit-fixer are reserved for the /audit loop and cannot be dispatched here. Use another agent.";
    }
    if (live.state.capPending)
      return `The audit round limit is exhausted. Call ${ROUND_TOOL}({op:"extend"}) before dispatching more audit work.`;
    const limit = live.state.laneLimit;
    const running = [...(inflight.get(ctx.sessionManager.getSessionId())?.values() ?? [])].reduce((sum, count) => sum + count, 0);
    if (limit !== null && running + requested > limit) {
      return `Lane limit: at most ${limit} audit/fix subagents may run at once (${running} running, ${requested} requested). Split the batch.`;
    }
    return undefined;
  };

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "task") return undefined;
    const requested = auditItemsIn(event.input);
    if (requested === 0) return undefined;
    const reason = dispatchRefusal(ctx, requested);
    if (reason) return { block: true, reason };
    const sessionId = ctx.sessionManager.getSessionId();
    const calls = inflight.get(sessionId) ?? new Map<string, number>();
    calls.set(event.toolCallId, requested);
    inflight.set(sessionId, calls);
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    inflight.get(ctx.sessionManager.getSessionId())?.delete(event.toolCallId);
    return undefined;
  });

  // Audit agents are blocking, so none outlive the turn that dispatched them; this also drops calls another extension blocked.
  pi.on("agent_end", (_event, ctx) => {
    inflight.delete(ctx.sessionManager.getSessionId());
  });

  const spawnOn = pi.on as unknown as SubagentSpawnOn;
  spawnOn.call(pi, "before_subagent_spawn", (event, ctx) => {
    if (!isAuditAgent(event.agent)) return undefined;
    if (event.invocationKind === "eval") {
      return { block: true, reason: "audit-auditor and audit-fixer are dispatched only through the task tool by the /audit loop." };
    }
    return liveAudit(ctx) ? undefined : { block: true, reason: "audit-auditor and audit-fixer are reserved for the /audit loop." };
  });

  pi.on("goal_updated", async (event, ctx) => {
    const state = states.get(ctx.sessionManager.getSessionId());
    if (state?.status !== "active" || !state.goalId) return;
    const goal = event.goal;
    if (!goal || goal.id !== state.goalId) {
      await endAudit(ctx, state, "ended because the session goal changed");
      return;
    }
    if (goal.status === "complete") {
      await endAudit(ctx, state, "completed");
      return;
    }
    if (goal.status === "dropped") {
      await endAudit(ctx, state, "dropped");
      return;
    }
    if (goal.status === "active") await syncLoopTools(state, true);
  });

  pi.on("session_compact", async (_event, ctx) => {
    const live = liveAudit(ctx);
    if (live) await sendProtocol(ctx, live.state, true);
  });

  pi.on("session_start", (_event, ctx) => rehydrate(ctx));
  pi.on("session_switch", (_event, ctx) => rehydrate(ctx));
  pi.on("session_branch", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    states.delete(sessionId);
    inflight.delete(sessionId);
  });
}
