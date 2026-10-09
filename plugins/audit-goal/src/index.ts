import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { auditPayload, invalidAuditPayload } from "#src/audit-payload.ts";
import { readHostSetting } from "#src/host-settings.ts";
import {
  type AuditSettings,
  type AuditState,
  auditItemsIn,
  type ConclusionEvidence,
  type ConclusionKind,
  createConclusion,
  effectiveLaneLimit,
  extensionChoices,
  INTENSITIES,
  isAuditAgent,
  laneLabel,
  limitLabel,
  parseSettings,
  type RoundRecord,
  remainingFindings,
  renderTemplate,
  restoreAuditState,
  selfFeedingSignal,
  totals,
  validateConclusion,
  validateRound,
  verdict,
} from "#src/ledger.ts";
import { PluginStatePublisher, pluginStatePath } from "#src/plugin-state.ts";

const PLUGIN_NAME = "audit-goal";
const PACKAGE_NAME = "wows-omp-plugin-audit-goal";
const STATE_ENTRY = "wows-omp-audit-goal.state";
const PROTOCOL_MESSAGE = "wows-omp-audit-goal.protocol";
const COMMAND_NOTICE = "wows-omp-audit-goal.command-status";
const STATUS_KEY = "audit-goal";
const ROUND_TOOL = "audit_round";
const LOOP_TOOLS = ["goal", ROUND_TOOL];
const RUNTIME_SOURCE_PATH = fileURLToPath(import.meta.url);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Asset = { body: string } | { error: Error };

function readAsset(relativePath: string): Asset {
  try {
    const body = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").trim();
    return body ? { body } : { error: new Error(`prompt asset ${relativePath} is empty`) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// Read at load: upgrading the plugin deletes this install's cache directory under running sessions.
const ASSETS: Record<string, Asset | undefined> = Object.fromEntries(
  ["../assets/protocol.md", ...INTENSITIES.map((intensity) => `../assets/intensity/${intensity}.md`)].map((relativePath) => [
    relativePath,
    readAsset(relativePath),
  ]),
);

function loadAsset(relativePath: string): string {
  const asset = ASSETS[relativePath];
  if (!asset) throw new Error(`unknown prompt asset ${relativePath}`);
  if ("error" in asset) throw asset.error;
  return asset.body;
}

function buildProtocol(state: AuditState): string {
  const template = loadAsset("../assets/protocol.md");
  const intensityRules = loadAsset(`../assets/intensity/${state.intensity}.md`);
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
  const remaining = remainingFindings(state.rounds);
  const lines = [
    `Target: ${state.target}`,
    `Intensity: ${state.intensity}`,
    `Baseline: ${state.baseline ?? "none (not a git repository)"}`,
    `Rounds recorded: ${state.rounds.length} (limit: ${limitLabel(state.maxRounds)})`,
    `Lane limit: ${laneLabel(state.laneLimit)}`,
    `Verified discoveries: critical ${sum.critical}, major ${sum.major}, minor ${sum.minor}, picky ${sum.picky} (loop-induced ${sum.loopInduced}); rejected ${sum.rejected}`,
  ];
  for (const round of state.rounds) {
    lines.push(
      `- round ${round.round}: C${round.critical} M${round.major} m${round.minor} p${round.picky}, loop-induced ${round.loopInduced}, rejected ${round.rejected}`,
      `  model: ${round.auditorModels}; coverage: ${round.coverage}; checks: ${round.checks}`,
    );
    for (const finding of round.findings)
      lines.push(
        `  ${finding.id} [${finding.severity}, ${finding.status}, ${finding.origin}]: ${finding.summary}; ${finding.evidence}${finding.resolution ? `; resolved: ${finding.resolution}` : ""}`,
      );
    for (const resolution of round.resolutions) lines.push(`  resolved ${resolution.findingId}: ${resolution.evidence}`);
    for (const rejected of round.rejectedEvidence) lines.push(`  rejected: ${rejected}`);
  }
  lines.push(
    `Remaining confirmed findings: critical ${remaining.counts.critical}, major ${remaining.counts.major}, minor ${remaining.counts.minor}, picky ${remaining.counts.picky}`,
  );
  for (const finding of remaining.findings)
    lines.push(`- OPEN ${finding.id} [${finding.severity}]: ${finding.summary}; ${finding.evidence}`);
  if (state.capPending) lines.push("Round limit exhausted: awaiting audit_round op=extend.");
  if (state.conclusion) {
    lines.push(`Conclusion: ${state.conclusion.kind}; reason: ${state.conclusion.reason}`);
    for (const evidence of state.conclusion.evidence) lines.push(`  round ${evidence.round}: ${evidence.observation}`);
  } else lines.push("Conclusion: none recorded.");
  lines.push("Artifact acceptance: false (audit process outcome is not acceptance; open findings remain open).");
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
  /** A malformed latest entry must not fall back to an older, apparently successful ledger. */
  const invalidStates = new Set<string>();
  /** In-flight audit subagents per session, keyed by the dispatching task tool call. */
  const inflight = new Map<string, Map<string, number>>();
  /** Sidecar files written by this process; a later null must replace them even before the first write lands. */
  const publishedFiles = new Set<string>();
  let publishWarned = false;
  const warnPublish = (error: unknown): void => {
    if (publishWarned) return;
    publishWarned = true;
    pi.logger.warn("audit-goal could not publish its state sidecar", { error: errorMessage(error) });
  };
  const publisher = new PluginStatePublisher(PLUGIN_NAME, warnPublish);

  /** Mirrors the session's persisted ledger to the sidecar; sessions that never had an audit get no file. */
  const publishState = (ctx: ExtensionContext): void => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const state = states.get(sessionId);
      const payload = invalidStates.has(sessionId) ? invalidAuditPayload() : state ? auditPayload(state) : null;
      const file = pluginStatePath(sessionId, PLUGIN_NAME);
      if (payload === null && !publishedFiles.has(file) && !existsSync(file)) return;
      publishedFiles.add(file);
      publisher.publish(sessionId, payload);
    } catch (error) {
      warnPublish(error);
    }
  };

  /** Command feedback must stay visible without a UI, where notify is dropped. */
  const commandNotice = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
      return;
    }
    pi.sendMessage({ customType: COMMAND_NOTICE, content: message, display: true, attribution: "agent" });
  };

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
    if (!session || invalidStates.has(ctx.sessionManager.getSessionId()) || state?.status !== "active") return undefined;
    const goal = session.getGoalModeState()?.goal;
    if (!goal || goal.id !== state.goalId || goal.status === "complete" || goal.status === "dropped") return undefined;
    return { session, state };
  };

  const persist = (ctx: ExtensionContext, state: AuditState): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      pi.appendEntry(STATE_ENTRY, state);
      invalidStates.delete(sessionId);
      states.set(sessionId, state);
    } catch (error) {
      invalidStates.add(sessionId);
      pi.logger.warn("audit-goal could not persist its ledger", { error: errorMessage(error) });
      throw error;
    } finally {
      publishState(ctx);
    }
  };

  const showStatus = (ctx: ExtensionContext, state: AuditState | undefined): void => {
    const text = invalidStates.has(ctx.sessionManager.getSessionId())
      ? "Audit ledger invalid · use /goal drop"
      : state?.status === "active"
        ? `Audit ${state.rounds.length}/${state.maxRounds ?? "∞"} · ${state.intensity}${state.capPending ? " · limit reached" : ""}${state.conclusion ? ` · ${state.conclusion.kind}` : ""}`
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

  const endAudit = async (ctx: ExtensionContext, state: AuditState, reason: string, completed: boolean): Promise<void> => {
    const ended = structuredClone(state);
    ended.status = "ended";
    ended.capPending = false;
    if (!completed || !ended.conclusion) {
      const last = ended.rounds.at(-1);
      ended.conclusion = createConclusion(ended, "stop", reason, last ? [{ round: last.round, observation: last.coverage }] : []);
    }
    await syncLoopTools(ended, false);
    try {
      persist(ctx, ended);
    } catch {
      commandNotice(ctx, "Audit ledger could not be saved; do not treat this audit as concluded.", "error");
      return;
    }
    showStatus(ctx, ended);
    inflight.delete(ctx.sessionManager.getSessionId());
    ctx.ui.notify(`Audit loop ${reason} after ${ended.rounds.length} round${ended.rounds.length === 1 ? "" : "s"}.`, "info");
  };

  const rehydrate = async (ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    states.delete(sessionId);
    invalidStates.delete(sessionId);
    inflight.delete(sessionId);
    if (!mainSession(ctx)) return;
    let latest: unknown;
    let found = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      latest = entry.data;
      found = true;
    }
    if (found) {
      try {
        const restored = restoreAuditState(latest);
        if (restored) {
          states.set(sessionId, restored);
          const currentGoal = mainSession(ctx)?.getGoalModeState()?.goal;
          if (restored.status === "active" && currentGoal?.id === restored.goalId) {
            if (currentGoal.status === "complete" || currentGoal.status === "dropped") {
              await endAudit(
                ctx,
                restored,
                currentGoal.status === "dropped" ? "dropped by the user" : "completed before ledger reconciliation",
                currentGoal.status === "complete",
              );
            } else {
              const before = restored.addedTools.length;
              await syncLoopTools(restored, true);
              if (states.get(sessionId) === restored && !invalidStates.has(sessionId) && before !== restored.addedTools.length)
                persist(ctx, restored);
            }
          } else if (restored.status === "ended" && restored.addedTools.length > 0) {
            await syncLoopTools(restored, false);
            persist(ctx, restored);
          }
        } else invalidStates.add(sessionId);
      } catch (error) {
        invalidStates.add(sessionId);
        pi.logger.warn("audit-goal could not restore its ledger", { error: errorMessage(error) });
      }
    }
    publishState(ctx);
    showStatus(ctx, states.get(sessionId));
  };

  const sendProtocol = async (ctx: ExtensionContext, state: AuditState, withLedger: boolean): Promise<boolean> => {
    try {
      const protocol = buildProtocol(state);
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
      commandNotice(ctx, `Audit protocol could not be loaded (${errorMessage(error)}).`, "error");
      return false;
    }
  };

  const loadSettings = async (ctx: ExtensionContext): Promise<AuditSettings | undefined> => {
    try {
      return parseSettings(await getPluginSettings(PACKAGE_NAME, ctx.cwd));
    } catch (error) {
      commandNotice(ctx, `audit-goal settings are invalid (${errorMessage(error)}).`, "error");
      return undefined;
    }
  };

  const startAudit = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const target = args.trim();
    if (!target) {
      commandNotice(ctx, "Usage: /audit <audit-target>", "warning");
      return;
    }
    const session = mainSession(ctx);
    if (!session) {
      commandNotice(ctx, "/audit runs in the main session only", "warning");
      return;
    }
    if (liveAudit(ctx)) {
      commandNotice(ctx, "An /audit loop is already running in this session. Use /goal to manage it.", "warning");
      return;
    }
    try {
      if ((await readHostSetting(session.settings, "goal.enabled")) === false) {
        commandNotice(ctx, "Goal mode is disabled. Enable it in settings (goal.enabled).", "warning");
        return;
      }
    } catch (error) {
      pi.logger.warn("audit-goal could not read goal.enabled; assuming enabled", { error: errorMessage(error) });
    }
    if (session.getPlanModeState()?.enabled) {
      commandNotice(ctx, "Exit plan mode before starting /audit.", "warning");
      return;
    }
    if (vibeModeActive(session)) {
      commandNotice(ctx, "Exit vibe mode before starting /audit.", "warning");
      return;
    }
    const existing = session.getGoalModeState()?.goal;
    if (existing && existing.status !== "complete" && existing.status !== "dropped") {
      commandNotice(ctx, "This session already has a goal. Finish it or run /goal drop before starting /audit.", "warning");
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
      version: 2,
      status: "active",
      goalId: "",
      target,
      intensity: settings.intensity,
      maxRounds: settings.maxRounds ?? null,
      laneLimit: effectiveLaneLimit(settings.maxParallelLanes, hostConcurrency),
      baseline,
      rounds: [],
      capPending: false,
      conclusion: null,
      addedTools: [],
    };
    try {
      buildProtocol(state);
    } catch (error) {
      commandNotice(ctx, `Audit protocol could not be loaded (${errorMessage(error)}).`, "error");
      return;
    }

    await syncLoopTools(state, true);
    try {
      const created = await session.goalRuntime.createGoal({ objective: `Audit loop (/audit): ${target}` });
      state.goalId = created.goal.id;
    } catch (error) {
      await syncLoopTools(state, false);
      commandNotice(ctx, `Could not start the audit goal (${errorMessage(error)}).`, "error");
      return;
    }
    try {
      persist(ctx, state);
    } catch (error) {
      await syncLoopTools(state, false);
      await session.goalRuntime.dropGoal();
      invalidStates.delete(ctx.sessionManager.getSessionId());
      publishState(ctx);
      commandNotice(ctx, `Could not save the audit ledger (${errorMessage(error)}); the goal was dropped.`, "error");
      return;
    }
    showStatus(ctx, state);
    if (!(await sendProtocol(ctx, state, false))) return;
    pi.sendUserMessage(`Run the audit loop.\n\n<audit-target>\n${target}\n</audit-target>`);
  };

  pi.registerCommand("audit", {
    description: "Start a goal that audits and repairs until an explicit process conclusion or stop",
    handler: startAudit,
  });

  const z = pi.zod;
  const roundParameters = z.object({
    op: z
      .enum(["record", "conclude", "extend", "status"])
      .describe("record a finished round; conclude threshold convergence or justified saturation; extend a finite cap; show status"),
    round: z.number().int().optional().describe("record: 1-based round number"),
    critical: z.number().int().optional(),
    major: z.number().int().optional(),
    minor: z.number().int().optional(),
    picky: z.number().int().optional(),
    rejected: z.number().int().optional(),
    loopInduced: z.number().int().optional(),
    auditorModels: z
      .array(z.string())
      .optional()
      .describe("record: all auditor models used in this round; stable sets support comparable saturation evidence"),
    coverage: z.string().optional().describe("record: concrete coverage and traversal axes"),
    checks: z.string().optional().describe("record: actual CI / verification result"),
    findings: z
      .array(
        z.object({
          id: z.string(),
          severity: z.enum(["critical", "major", "minor", "picky"]),
          summary: z.string(),
          evidence: z.string(),
          origin: z.enum(["pre-existing", "loop-induced"]),
          status: z.enum(["open", "resolved"]),
          resolution: z.string().optional(),
        }),
      )
      .optional()
      .describe("record: every verified finding, even if repaired within this round; [] when none"),
    resolutions: z
      .array(z.object({ findingId: z.string(), evidence: z.string() }))
      .optional()
      .describe("record: repairs of findings left open in earlier rounds"),
    rejectedEvidence: z.array(z.string()).optional().describe("record: one concrete reason for each rejected auditor claim"),
    conclusion: z
      .enum(["threshold-convergence", "capability-saturation"])
      .optional()
      .describe("conclude: process outcome; never artifact acceptance"),
    reason: z
      .string()
      .optional()
      .describe("conclude: reason for the outcome, including why further same-model audit has limited return for saturation"),
    evidence: z
      .array(z.object({ round: z.number().int(), observation: z.string() }))
      .optional()
      .describe("conclude: observations citing recorded rounds"),
  });
  type RoundParams = {
    op: "record" | "conclude" | "extend" | "status";
    round?: number;
    critical?: number;
    major?: number;
    minor?: number;
    picky?: number;
    rejected?: number;
    loopInduced?: number;
    auditorModels?: string[];
    coverage?: string;
    checks?: string;
    findings?: RoundRecord["findings"];
    resolutions?: RoundRecord["resolutions"];
    rejectedEvidence?: string[];
    conclusion?: ConclusionKind;
    reason?: string;
    evidence?: ConclusionEvidence[];
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
      auditorModels: params.auditorModels ?? [],
      coverage: params.coverage ?? "",
      checks: params.checks ?? "",
      findings: params.findings ?? [],
      resolutions: params.resolutions ?? [],
      rejectedEvidence: params.rejectedEvidence ?? [],
    };
    const invalid = validateRound(state, record);
    if (invalid) return textResult(invalid, true);
    const next = structuredClone(state);
    next.rounds.push(record);
    const outcome = verdict(next);
    next.capPending = outcome === "cap-reached";
    persist(ctx, next);
    showStatus(ctx, next);

    const header = `Round ${record.round} recorded.\n${ledgerSummary(next)}\n\nVerdict: ${outcome}.`;
    if (outcome === "threshold-ready")
      return textResult(
        `${header}\nThe ${next.intensity} exit gate is met. Record threshold-convergence with audit_round({op:"conclude", conclusion:"threshold-convergence", reason, evidence}), write the truthful report, then call goal({op:"complete"}). Open findings remain open.`,
      );
    if (outcome === "cap-reached")
      return textResult(
        `${header}\nThe round limit is exhausted without convergence${selfFeedingSignal(next.rounds) ? " (self-feeding signal observed, not a conclusion)" : ""}. Report the open findings and unaudited work, then call audit_round({op:"extend"}) to request the user's decision. Do not dispatch more audit work while the cap is pending.`,
      );
    return textResult(
      `${header}\n${selfFeedingSignal(next.rounds) ? "Self-feeding signal: simplify or revert mechanisms; this alone does not establish convergence. " : ""}Start round ${record.round + 1}, or, only with unlimited rounds and multi-round same-model evidence of discovery limits, record capability-saturation explicitly using op=conclude.`,
    );
  };

  const conclude = (ctx: ExtensionContext, state: AuditState, params: RoundParams) => {
    if (state.conclusion) return textResult("An audit conclusion is already recorded. Report it truthfully before goal completion.", true);
    if (!params.conclusion) return textResult("op=conclude requires conclusion: threshold-convergence or capability-saturation.", true);
    const reason = params.reason ?? "";
    const evidence = params.evidence ?? [];
    const invalid = validateConclusion(state, params.conclusion, reason, evidence);
    if (invalid) return textResult(invalid, true);
    const next = { ...state, conclusion: createConclusion(state, params.conclusion, reason, evidence) };
    persist(ctx, next);
    showStatus(ctx, next);
    return textResult(
      `${ledgerSummary(next)}\nAudit process conclusion recorded. ${params.conclusion === "capability-saturation" ? "Capability saturation is not an accepted repair; unresolved findings remain open. " : "Threshold convergence is a discovery gate, not artifact acceptance. "}Report the outcome and remaining findings, then call goal({op:"complete"}).`,
    );
  };

  const extendRounds = async (ctx: ExtensionContext, state: AuditState) => {
    if (!state.capPending || state.maxRounds === null || state.conclusion)
      return textResult("op=extend is only valid while a finite round cap decision is pending.", true);
    const choices = extensionChoices(state.maxRounds);
    let selected: string | undefined;
    if (ctx.hasUI) {
      try {
        selected = await ctx.ui.select(
          `Audit round limit reached (${state.rounds.length}/${state.maxRounds}) and the audit is not finished. Keep auditing?`,
          choices.map((choice) => choice.label),
        );
      } catch (error) {
        pi.logger.warn("audit-goal round extension prompt failed", { error: errorMessage(error) });
      }
      if (selected === undefined)
        return textResult(
          "No round-limit decision was made. The audit remains cap-pending; ask the user again or let them use /goal drop.",
          true,
        );
    }
    if (liveAudit(ctx)?.state !== state) {
      return textResult(
        "The audit goal or ledger changed while awaiting the user's round-limit decision; no stale decision was applied.",
        true,
      );
    }
    const choice = choices.find((candidate) => candidate.label === selected);
    const next = structuredClone(state);
    if (!ctx.hasUI || choice?.newLimit === undefined) {
      const reason = ctx.hasUI
        ? "User explicitly stopped at the finite round limit."
        : "Noninteractive finite round limit reached; the audit stopped without convergence.";
      const last = state.rounds.at(-1);
      next.conclusion = createConclusion(state, "stop", reason, last ? [{ round: last.round, observation: last.coverage }] : []);
      next.capPending = false;
      persist(ctx, next);
      showStatus(ctx, next);
      return textResult(
        `${ledgerSummary(next)}\nStop recorded, not convergence or acceptance. Append truthful closing notes to the interim report, then call goal({op:"complete"}).`,
      );
    }
    next.maxRounds = choice.newLimit;
    next.capPending = false;
    persist(ctx, next);
    showStatus(ctx, next);
    return textResult(`The user extended the audit. New limit: ${limitLabel(next.maxRounds)}. Start round ${next.rounds.length + 1}.`);
  };

  pi.registerTool({
    name: ROUND_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Audit Round",
    description:
      "Persist verified round findings and evidence; explicitly conclude threshold convergence or multi-round capability saturation; ask the user about finite cap; show open findings and acceptance state.",
    parameters: roundParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (_toolCallId, params: RoundParams, _signal, _onUpdate, ctx) => {
      if (invalidStates.has(ctx.sessionManager.getSessionId()))
        return textResult("Audit ledger is invalid or could not be saved. Do not complete or dispatch; use /goal drop explicitly.", true);
      const live = liveAudit(ctx);
      if (!live) return textResult("No /audit loop is active in this main session.", true);
      if (params.op === "status") return textResult(ledgerSummary(live.state));
      if (params.op === "conclude") return conclude(ctx, live.state, params);
      if (params.op === "extend") return await extendRounds(ctx, live.state);
      return recordRound(ctx, live.state, params);
    },
  });

  const dispatchRefusal = (ctx: ExtensionContext, requested: number): string | undefined => {
    const live = liveAudit(ctx);
    if (!live) {
      return "audit-auditor and audit-fixer are reserved for the /audit loop and cannot be dispatched here. Use another agent.";
    }
    if (live.state.conclusion)
      return "The audit has recorded its conclusion; report it and complete the goal instead of dispatching more audit work.";
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
    if (event.toolName === "goal") {
      const live = liveAudit(ctx);
      const current = mainSession(ctx)?.getGoalModeState()?.goal;
      const invalidAudit = invalidStates.has(ctx.sessionManager.getSessionId()) && current?.objective.startsWith("Audit loop (/audit): ");
      if (event.input.op === "complete" && (live || invalidAudit) && (!live?.state.conclusion || invalidAudit)) {
        return {
          block: true,
          reason:
            "The /audit goal cannot complete without a valid recorded conclusion. Use audit_round op=conclude, resolve the cap with op=extend, or explicitly use /goal drop.",
        };
      }
      if (event.input.op === "drop" && (live || invalidAudit)) {
        return {
          block: true,
          reason: "Only the user can drop this /audit goal with /goal drop; a model-issued goal drop cannot bypass its conclusion.",
        };
      }
      return undefined;
    }
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

  pi.on("before_subagent_spawn", (event, ctx) => {
    if (!isAuditAgent(event.agent)) return undefined;
    if (event.invocationKind === "eval") {
      return { block: true, reason: "audit-auditor and audit-fixer are dispatched only through the task tool by the /audit loop." };
    }
    const live = liveAudit(ctx);
    return live && !live.state.conclusion && !live.state.capPending
      ? undefined
      : { block: true, reason: "audit-auditor and audit-fixer are reserved for an active /audit round before its conclusion or cap." };
  });

  pi.on("goal_updated", async (event, ctx) => {
    const state = states.get(ctx.sessionManager.getSessionId());
    if (state?.status !== "active" || !state.goalId) return;
    const goal = event.goal;
    if (!goal || goal.id !== state.goalId) {
      await endAudit(ctx, state, "stopped because the session goal changed", false);
      return;
    }
    if (goal.status === "complete") {
      await endAudit(
        ctx,
        state,
        state.conclusion ? `completed with ${state.conclusion.kind}` : "completed outside the audit conclusion protocol",
        true,
      );
      return;
    }
    if (goal.status === "dropped") {
      await endAudit(ctx, state, "dropped by the user", false);
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
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    states.delete(sessionId);
    invalidStates.delete(sessionId);
    inflight.delete(sessionId);
    await publisher.flush();
  });
}
