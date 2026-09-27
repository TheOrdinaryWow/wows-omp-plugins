/**
 * Prometheus: one planning workflow with two entry points.
 *
 * `/prometheus` toggles the workflow like the host's native `/plan`, and a native plan-mode
 * session can opt into the same workflow through an `ask`-based depth check
 * plus the `prometheus_activate` tool. Both paths land in one per-session state
 * machine and inject the same plugin-owned skill.
 *
 * After the host's own plan approval the session becomes Atlas: the Atlas
 * prompt and runtime guard force all implementation and verification work into
 * child agents while keeping the host's native plan artifact and handoff.
 *
 * State is tracked per session id and mirrored into session entries, never in
 * process globals, the environment, or host settings, so child sessions and
 * ordinary plan-mode sessions are untouched.
 */
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { ATLAS_ASSET, loadPromptAsset, loadRequiredPromptAssets, SKILL_ASSET } from "./assets.ts";
import {
  BLOCKED_TOOL_NOTICE,
  blockedToolMessage,
  EXECUTION_PREAMBLE,
  EXECUTION_START_NOTICE,
  executionBlockReason,
  executionToolSourceBlockReason,
  isApprovedPlanHandoff,
  isPrometheusOptInConsent,
  isPrometheusOptInQuestion,
  nestedXdevToolCall,
  OPT_IN_ADDENDUM,
  PLANNING_PREAMBLE,
  PROMETHEUS_DEEP_OPTION_INDEX,
  PROMETHEUS_OPT_IN_QUESTION_ID,
  parsePrometheusCommand,
  planReferencesMatch,
  proposedPlanPathFromToolResult,
} from "./workflow.ts";

const ACTIVATE_TOOL = "prometheus_activate";
const RELEASE_TOOL = "prometheus_release";
const STATE_ENTRY = "wows-omp-prometheus.state";
const PLANNING_CONTEXT_TYPE = "wows-omp-prometheus.planning-context";
const EXECUTION_CONTEXT_TYPE = "wows-omp-prometheus.execution-context";
const NATIVE_PLAN_CONTEXT_TYPE = "plan-mode-context";
const BLOCK_NOTICE_BURST_MS = 5_000;
const RUNTIME_SOURCE_PATH = fileURLToPath(import.meta.url);

type Phase = "idle" | "planning" | "executing";

interface SessionRecord {
  phase: Phase;
  /** Canonical path returned by the host's successful xd://propose dispatch. */
  planFilePath?: string;
  /** Tool-call provenance for the proposal that chose planFilePath. */
  proposedByToolCallId?: string;
  /** `mode_change` entry for which native opt-in guidance was already supplied. */
  offerPendingForModeEntryId?: string;
  planningModeEntryId?: string;
  offeredForModeEntryId?: string;
  suppressedForModeEntryId?: string;
  pendingConsent?: { askToolCallId: string; modeEntryId: string };
  proposalAwaitingApproval?: boolean;
  approvalCompactionPending?: boolean;
  lastBlockedAt: number;
}

interface PendingFreshHandoff {
  sourceSessionId: string;
  sourceSession: AgentSession;
  targetSessionId?: string;
  record: SessionRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function prometheus(pi: ExtensionAPI): void {
  const records = new Map<string, SessionRecord>();
  const authorizedActivationCalls = new Map<string, string>();
  let pendingFreshHandoff: PendingFreshHandoff | undefined;

  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void => {
    try {
      ctx.ui.notify(message, type);
    } catch (error) {
      pi.logger.warn("prometheus could not display a notice", { error: errorMessage(error) });
    }
  };

  const commandNotice = (ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) {
      notify(ctx, message, type);
      return;
    }
    pi.sendMessage({
      customType: "wows-omp-prometheus.command-status",
      content: message,
      display: true,
      attribution: "agent",
    });
  };

  const mainSession = (ctx: ExtensionContext): AgentSession | undefined => {
    try {
      return (
        AgentRegistry.global()
          .list()
          .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager)?.session ?? undefined
      );
    } catch (error) {
      pi.logger.warn("prometheus could not resolve the main session", { error: errorMessage(error) });
      return undefined;
    }
  };

  const planModeEpisodeId = (ctx: ExtensionContext): string | undefined => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "mode_change") continue;
      return entry.mode === "plan" ? entry.id : undefined;
    }
    return undefined;
  };

  const recordFor = (sessionId: string): SessionRecord => {
    const existing = records.get(sessionId);
    if (existing) return existing;
    const created: SessionRecord = { phase: "idle", lastBlockedAt: 0 };
    records.set(sessionId, created);
    return created;
  };

  const persist = (record: SessionRecord): void => {
    try {
      pi.appendEntry(STATE_ENTRY, {
        version: 1,
        phase: record.phase,
        planningModeEntryId: record.planningModeEntryId,
        planFilePath: record.planFilePath,
        proposedByToolCallId: record.proposedByToolCallId,
        offeredForModeEntryId: record.offeredForModeEntryId,
        suppressedForModeEntryId: record.suppressedForModeEntryId,
      });
    } catch (error) {
      pi.logger.warn("prometheus could not persist workflow state", { error: errorMessage(error) });
    }
  };

  const rehydrate = (ctx: ExtensionContext, force = false): SessionRecord | undefined => {
    if (!mainSession(ctx)) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!force && records.has(sessionId)) return records.get(sessionId);
    records.delete(sessionId);
    let restored: SessionRecord | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const data = entry.data as
        | {
            phase?: unknown;
            planFilePath?: unknown;
            planningModeEntryId?: unknown;
            proposedByToolCallId?: unknown;
            offeredForModeEntryId?: unknown;
            suppressedForModeEntryId?: unknown;
          }
        | undefined;
      if (data?.phase !== "idle" && data?.phase !== "planning" && data?.phase !== "executing") continue;
      restored = {
        phase: data.phase,
        planFilePath: typeof data.planFilePath === "string" && data.planFilePath.trim() ? data.planFilePath : undefined,
        proposedByToolCallId:
          typeof data.proposedByToolCallId === "string" && data.proposedByToolCallId ? data.proposedByToolCallId : undefined,
        offeredForModeEntryId:
          typeof data.offeredForModeEntryId === "string" && data.offeredForModeEntryId ? data.offeredForModeEntryId : undefined,
        suppressedForModeEntryId:
          typeof data.suppressedForModeEntryId === "string" && data.suppressedForModeEntryId ? data.suppressedForModeEntryId : undefined,
        lastBlockedAt: 0,
        planningModeEntryId:
          typeof data.planningModeEntryId === "string" && data.planningModeEntryId ? data.planningModeEntryId : undefined,
      };
    }
    if (restored) records.set(sessionId, restored);
    return restored;
  };

  const syncTools = async (wantActivate: boolean, wantRelease: boolean): Promise<void> => {
    try {
      const active = pi.getActiveTools();
      const desired = new Set(active);
      if (wantActivate) desired.add(ACTIVATE_TOOL);
      else desired.delete(ACTIVATE_TOOL);
      if (wantRelease) desired.add(RELEASE_TOOL);
      else desired.delete(RELEASE_TOOL);
      if (desired.size === active.length && active.every((name) => desired.has(name))) return;
      await pi.setActiveTools([...desired]);
    } catch (error) {
      pi.logger.warn("prometheus could not reconcile workflow tools", { error: errorMessage(error) });
    }
  };

  const release = async (ctx: ExtensionContext, reason: string): Promise<void> => {
    if (!mainSession(ctx)) {
      notify(ctx, "Prometheus runs in the main session only.", "warning");
      return;
    }
    const episodeId = planModeEpisodeId(ctx);
    authorizedActivationCalls.clear();
    pendingFreshHandoff = undefined;
    const record =
      records.get(ctx.sessionManager.getSessionId()) ??
      rehydrate(ctx) ??
      (episodeId ? recordFor(ctx.sessionManager.getSessionId()) : undefined);
    if (!record) {
      notify(ctx, "Prometheus is not active in this session.");
      await syncTools(false, false);
      return;
    }
    if (record.phase === "idle") {
      record.pendingConsent = undefined;
      record.proposalAwaitingApproval = false;
      record.approvalCompactionPending = false;
      record.offerPendingForModeEntryId = undefined;
      record.suppressedForModeEntryId = episodeId;
      if (episodeId) {
        record.offeredForModeEntryId = episodeId;
        persist(record);
      }
      await syncTools(false, false);
      notify(ctx, episodeId ? "Prometheus opt-in is off for this native plan-mode session." : "Prometheus is not active in this session.");
      return;
    }
    const wasExecuting = record.phase === "executing";
    record.phase = "idle";
    record.planFilePath = undefined;
    record.proposedByToolCallId = undefined;
    record.offeredForModeEntryId = episodeId;
    record.suppressedForModeEntryId = episodeId;
    record.pendingConsent = undefined;
    record.proposalAwaitingApproval = false;
    record.approvalCompactionPending = false;
    record.planningModeEntryId = undefined;
    record.offerPendingForModeEntryId = undefined;
    persist(record);
    await syncTools(false, false);
    notify(
      ctx,
      wasExecuting
        ? `Prometheus: Atlas execution released (${reason}). Direct tools are available again in this session.`
        : `Prometheus: planning workflow released (${reason}).`,
    );
  };

  const activate = async (ctx: ExtensionContext): Promise<boolean> => {
    if (!mainSession(ctx)) {
      notify(ctx, "Prometheus runs in the main session only.", "warning");
      return false;
    }
    try {
      await loadRequiredPromptAssets();
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus refused activation without prompt assets", { error: detail });
      notify(ctx, `Prometheus could not load its prompt assets (${detail}); activation was refused.`, "error");
      return false;
    }
    const record = recordFor(ctx.sessionManager.getSessionId());
    if (record.phase !== "planning") {
      record.phase = "planning";
      record.planFilePath = undefined;
      record.proposedByToolCallId = undefined;
      record.offeredForModeEntryId = undefined;
      record.suppressedForModeEntryId = undefined;
      record.pendingConsent = undefined;
      record.proposalAwaitingApproval = false;
      record.approvalCompactionPending = false;
      record.offerPendingForModeEntryId = undefined;
      record.planningModeEntryId = planModeEpisodeId(ctx);
    }
    persist(record);
    return true;
  };

  const toolProvenance = (toolName: string) => {
    try {
      return pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo;
    } catch (error) {
      pi.logger.warn("prometheus could not inspect tool provenance", { toolName, error: errorMessage(error) });
      return undefined;
    }
  };

  const provenanceBlockReason = (toolName: string): string | undefined => {
    const provenance = toolProvenance(toolName);
    const trustedPrometheusTool =
      toolName === RELEASE_TOOL && provenance?.source === "extension" && provenance.path === RUNTIME_SOURCE_PATH;
    return executionToolSourceBlockReason(toolName, provenance?.source, trustedPrometheusTool);
  };

  const planningBlock = async (ctx: ExtensionContext): Promise<string> => {
    try {
      return `${PLANNING_PREAMBLE}\n\n${await loadPromptAsset(SKILL_ASSET)}`;
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus planning asset became unavailable", { error: detail });
      notify(ctx, `Prometheus planning instructions could not be loaded (${detail}).`, "error");
      return PLANNING_PREAMBLE;
    }
  };

  const atlasBlock = async (ctx: ExtensionContext, record: SessionRecord): Promise<string> => {
    const path = record.planFilePath ?? "unavailable (retain the inline native plan and report this recovery limitation)";
    const taskIssue =
      provenanceBlockReason("task") ??
      (pi.getActiveTools().includes("task") ? undefined : "the native task tool is disabled in this session");
    const capability = taskIssue
      ? `\n\n<capability-block>The required native task tool is unavailable: ${taskIssue}. Report this blocker; do not implement in the parent.</capability-block>`
      : "";
    try {
      return `${EXECUTION_PREAMBLE}\n\n<approved-plan-reference path="${path}" provenance="native-xd-propose" />${capability}\n\n${await loadPromptAsset(ATLAS_ASSET)}`;
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus Atlas asset became unavailable", { error: detail });
      notify(ctx, `Prometheus could not load the Atlas asset (${detail}); the execution guard remains active.`, "error");
      return `${EXECUTION_PREAMBLE}\n\n<approved-plan-reference path="${path}" provenance="native-xd-propose" />${capability}`;
    }
  };

  const enterExecution = (ctx: ExtensionContext, record: SessionRecord): void => {
    record.phase = "executing";
    record.pendingConsent = undefined;
    record.proposalAwaitingApproval = false;
    record.approvalCompactionPending = false;
    record.offeredForModeEntryId = undefined;
    record.offerPendingForModeEntryId = undefined;
    record.planningModeEntryId = undefined;
    persist(record);
    notify(ctx, EXECUTION_START_NOTICE);
  };

  pi.on("input", async (event, ctx) => {
    const command = parsePrometheusCommand(event.text);
    if (!command) {
      const trimmed = event.text.trim();
      const current = records.get(ctx.sessionManager.getSessionId());
      if (trimmed.startsWith("/") && current?.phase === "planning") current.proposalAwaitingApproval = false;
      if (trimmed.startsWith("/") && current?.phase === "planning") current.approvalCompactionPending = false;
      if (/^\/plan(?:[ \t]|$)/.test(trimmed)) {
        const live = mainSession(ctx);
        const record = current ?? rehydrate(ctx);
        if (live?.getPlanModeState()?.enabled === true && record?.phase === "planning") {
          record.phase = "idle";
          record.planFilePath = undefined;
          record.proposedByToolCallId = undefined;
          record.planningModeEntryId = undefined;
          record.pendingConsent = undefined;
          record.proposalAwaitingApproval = false;
          record.approvalCompactionPending = false;
          record.offerPendingForModeEntryId = undefined;
          persist(record);
          await syncTools(false, false);
        }
      }
      return undefined;
    }
    const live = mainSession(ctx);
    if (!live) {
      notify(ctx, "Prometheus requires the registered main session; this host/session cannot enter it.", "error");
      return { handled: true };
    }
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    const planModeActive = live.getPlanModeState()?.enabled === true;
    if (record && record.phase !== "idle") {
      const wasPlanning = record.phase === "planning";
      await release(ctx, "/prometheus");
      return wasPlanning && planModeActive ? { text: "/plan" } : { handled: true };
    }
    if (!(await activate(ctx))) return { handled: true };
    if (planModeActive) {
      notify(ctx, "Prometheus planning is active in this native plan-mode session.");
      return command.prompt ? { text: command.prompt } : { handled: true };
    }
    notify(ctx, "Prometheus planning is active — entering native plan mode.");
    return { text: command.prompt ? `/plan ${command.prompt}` : "/plan" };
  });

  const commandHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const prompt = args.trim();
    const live = mainSession(ctx);
    if (!live) {
      commandNotice(ctx, "Prometheus requires the registered main session and is unavailable in this host/session.", "error");
      return;
    }
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record && record.phase !== "idle") {
      await release(ctx, "/prometheus");
      return;
    }
    if (live.getPlanModeState()?.enabled !== true) {
      commandNotice(
        ctx,
        `Prometheus cannot enter native plan mode through a ${ctx.mode} extension command. Enter native /plan first, then run /prometheus.`,
        "error",
      );
      return;
    }
    if (!(await activate(ctx))) return;
    if (prompt) pi.sendUserMessage(prompt);
    notify(ctx, "Prometheus planning is active in this native plan-mode session.");
  };

  pi.registerCommand("prometheus", {
    description: "Toggle Prometheus planning mode (Metis, Momus, Atlas)",
    handler: commandHandler,
  });

  const z = pi.zod;
  const activateParameters = z.object({
    questionId: z.literal(PROMETHEUS_OPT_IN_QUESTION_ID),
    selectedOptionIndex: z.literal(PROMETHEUS_DEEP_OPTION_INDEX),
  });
  const releaseParameters = z.object({
    reason: z.string().describe("Concise summary of completed child-produced evidence shown to the user before release"),
  });

  pi.registerTool({
    name: ACTIVATE_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Prometheus Activate",
    description:
      "Activate Prometheus only after the immediately preceding native ask result records explicit option-index consent for the fixed Prometheus question.",
    parameters: activateParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (
      toolCallId,
      _params: { questionId: typeof PROMETHEUS_OPT_IN_QUESTION_ID; selectedOptionIndex: typeof PROMETHEUS_DEEP_OPTION_INDEX },
      _signal,
      _onUpdate,
      ctx,
    ) => {
      const consentAskToolCallId = authorizedActivationCalls.get(toolCallId);
      authorizedActivationCalls.delete(toolCallId);
      if (!consentAskToolCallId) {
        return {
          content: [{ type: "text" as const, text: "Prometheus activation has no correlated explicit native ask consent." }],
          isError: true,
          details: {},
        };
      }
      const live = mainSession(ctx);
      if (!live || !ctx.hasUI || live.getPlanModeState()?.enabled !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Prometheus activation requires the interactive main session with active native plan mode.",
            },
          ],
          isError: true,
          details: {},
        };
      }
      if (!(await activate(ctx))) {
        return {
          content: [{ type: "text" as const, text: "Prometheus prompt assets are unavailable; activation was refused." }],
          isError: true,
          details: {},
        };
      }
      await syncTools(false, false);
      return {
        content: [
          {
            type: "text" as const,
            text: "Prometheus activated. The complete workflow is injected for the next model step and subsequent planning turns.",
          },
        ],
        details: {
          questionId: PROMETHEUS_OPT_IN_QUESTION_ID,
          selectedOptionIndex: PROMETHEUS_DEEP_OPTION_INDEX,
          consentAskToolCallId,
        },
      };
    },
  });

  pi.registerTool({
    name: RELEASE_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Prometheus Release",
    description:
      "After every delegated plan item has verified child evidence, request human confirmation to release Atlas. Never releases without confirmation.",
    parameters: releaseParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (_toolCallId, params: { reason: string }, _signal, _onUpdate, ctx) => {
      const live = mainSession(ctx);
      const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      if (!live || record?.phase !== "executing") {
        return {
          content: [{ type: "text" as const, text: "Prometheus Atlas execution is not active in this main session." }],
          isError: true,
          details: {},
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text" as const, text: "No confirmation UI is available. Ask the user to run /prometheus." }],
          isError: true,
          details: {},
        };
      }
      let confirmed = false;
      try {
        confirmed = await ctx.ui.confirm(
          "Release the Prometheus execution guard?",
          `${params.reason.trim()}\n\nRelease restores direct implementation tools and ends Atlas delegation in this session.`,
        );
      } catch (error) {
        pi.logger.warn("prometheus release confirmation failed", { error: errorMessage(error) });
      }
      if (!confirmed) {
        return {
          content: [{ type: "text" as const, text: "The user did not release the guard. Keep delegating." }],
          isError: true,
          details: {},
        };
      }
      await release(ctx, "human-confirmed completion release");
      return { content: [{ type: "text" as const, text: "Prometheus execution guard released by the user." }], details: {} };
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const live = mainSession(ctx);
    if (!live) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    let record = records.get(sessionId) ?? rehydrate(ctx);
    const fresh = pendingFreshHandoff;
    if (fresh?.targetSessionId === sessionId && fresh.sourceSession === live) {
      if (
        (!record || record.phase === "idle") &&
        isApprovedPlanHandoff(event.prompt, fresh.record.planFilePath, live.getPlanReferencePath())
      ) {
        record = { ...fresh.record, phase: "planning", pendingConsent: undefined, lastBlockedAt: 0 };
        records.set(sessionId, record);
      }
      pendingFreshHandoff = undefined;
    }

    const planModeActive = live.getPlanModeState()?.enabled === true;
    if (record?.phase === "planning" && planModeActive) {
      const episodeId = planModeEpisodeId(ctx);
      if (record.planningModeEntryId && episodeId && record.planningModeEntryId !== episodeId) {
        record.phase = "idle";
        record.planFilePath = undefined;
        record.proposedByToolCallId = undefined;
        record.planningModeEntryId = undefined;
        record.pendingConsent = undefined;
        record.proposalAwaitingApproval = false;
        record.approvalCompactionPending = false;
        record.offerPendingForModeEntryId = undefined;
        persist(record);
      } else if (!record.planningModeEntryId && episodeId) {
        record.planningModeEntryId = episodeId;
        persist(record);
      }
    }
    if (
      record?.phase === "planning" &&
      !planModeActive &&
      record.approvalCompactionPending === true &&
      planReferencesMatch(live.getPlanReferencePath(), record.planFilePath)
    ) {
      enterExecution(ctx, record);
    }
    let injected: string | undefined;
    let wantActivate = false;
    let wantRelease = false;

    if (record?.phase === "executing") {
      wantRelease = true;
      injected = await atlasBlock(ctx, record);
    } else if (record?.phase === "planning") {
      if (planModeActive) {
        injected = await planningBlock(ctx);
      } else if (isApprovedPlanHandoff(event.prompt, record.planFilePath, live.getPlanReferencePath())) {
        enterExecution(ctx, record);
        wantRelease = true;
        injected = await atlasBlock(ctx, record);
      } else {
        record.phase = "idle";
        record.planFilePath = undefined;
        record.proposedByToolCallId = undefined;
        record.planningModeEntryId = undefined;
        record.pendingConsent = undefined;
        record.proposalAwaitingApproval = false;
        record.approvalCompactionPending = false;
        record.offerPendingForModeEntryId = undefined;
        persist(record);
      }
    } else if (planModeActive) {
      const episodeId = planModeEpisodeId(ctx);
      const tracked = record ?? recordFor(sessionId);
      if (episodeId && tracked.suppressedForModeEntryId !== episodeId) {
        wantActivate = true;
        if (tracked.offeredForModeEntryId !== episodeId) {
          tracked.offerPendingForModeEntryId = episodeId;
          injected = OPT_IN_ADDENDUM;
        }
      }
    }

    await syncTools(wantActivate, wantRelease);
    if (!injected) return undefined;
    return { systemPrompt: [...event.systemPrompt, injected] };
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!mainSession(ctx)) return;
    const record = records.get(ctx.sessionManager.getSessionId());
    if (!record?.offerPendingForModeEntryId) return;
    record.offeredForModeEntryId = record.offerPendingForModeEntryId;
    record.offerPendingForModeEntryId = undefined;
    persist(record);
  });

  pi.on("context", async (event, ctx) => {
    const live = mainSession(ctx);
    if (!live) return undefined;
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (!record || (record.phase !== "planning" && record.phase !== "executing")) return undefined;
    if (record.phase === "planning" && live.getPlanModeState()?.enabled !== true) return undefined;

    const planning = record.phase === "planning";
    const policyHeading = planning ? "# Prometheus planning workflow (active)" : "# Prometheus execution (Atlas)";
    const policyAlreadyInSystem = ctx.getSystemPrompt().some((part) => part.includes(policyHeading));
    const content = policyAlreadyInSystem
      ? `${policyHeading}\n\nThe complete Prometheus policy is active in the system prompt; this message replaces conflicting native plan context.`
      : planning
        ? await planningBlock(ctx)
        : await atlasBlock(ctx, record);
    const customType = record.phase === "planning" ? PLANNING_CONTEXT_TYPE : EXECUTION_CONTEXT_TYPE;
    const policyMessage = {
      role: "custom" as const,
      customType,
      content,
      display: false,
      attribution: "agent" as const,
      timestamp: Date.now(),
    };
    const messages = [] as typeof event.messages;
    let inserted = false;
    for (const message of event.messages) {
      const replace =
        message.role === "custom" &&
        (message.customType === NATIVE_PLAN_CONTEXT_TYPE ||
          message.customType === PLANNING_CONTEXT_TYPE ||
          message.customType === EXECUTION_CONTEXT_TYPE);
      if (!replace) {
        messages.push(message);
        continue;
      }
      if (!inserted) {
        messages.push(policyMessage);
        inserted = true;
      }
    }
    if (!inserted) messages.push(policyMessage);
    return { messages };
  });

  pi.on("tool_call", (event, ctx) => {
    const live = mainSession(ctx);
    if (event.toolName === ACTIVATE_TOOL) {
      if (!live || !ctx.hasUI) return { block: true, reason: "Prometheus activation requires an interactive main session." };
      const provenance = toolProvenance(ACTIVATE_TOOL);
      if (provenance?.source !== "extension" || provenance.path !== RUNTIME_SOURCE_PATH) {
        return { block: true, reason: "Prometheus activation tool provenance is not trusted." };
      }
      const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      const params = event.input as { questionId?: unknown; selectedOptionIndex?: unknown };
      const episodeId = planModeEpisodeId(ctx);
      const consent = record?.pendingConsent;
      const authorized =
        record?.phase === "idle" &&
        live.getPlanModeState()?.enabled === true &&
        typeof episodeId === "string" &&
        consent?.modeEntryId === episodeId &&
        params.questionId === PROMETHEUS_OPT_IN_QUESTION_ID &&
        params.selectedOptionIndex === PROMETHEUS_DEEP_OPTION_INDEX;
      if (!authorized || !record || !consent) {
        return {
          block: true,
          reason: "Prometheus activation was denied: no matching non-timeout native ask selection for this plan-mode episode.",
        };
      }
      record.pendingConsent = undefined;
      authorizedActivationCalls.set(event.toolCallId, consent.askToolCallId);
      return undefined;
    }
    if (!live) return undefined;
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (event.toolName === "ask" && record) record.pendingConsent = undefined;
    if (record?.phase !== "executing") return undefined;

    let detail = executionBlockReason(event.toolName, event.input);
    if (!detail) detail = provenanceBlockReason(event.toolName);
    const nested = event.toolName === "write" ? nestedXdevToolCall(event.input) : undefined;
    if (!detail && nested) detail = provenanceBlockReason(nested.toolName);
    if (!detail) return undefined;

    const now = Date.now();
    if (now - record.lastBlockedAt > BLOCK_NOTICE_BURST_MS) notify(ctx, BLOCKED_TOOL_NOTICE, "warning");
    record.lastBlockedAt = now;
    return { block: true, reason: blockedToolMessage(event.toolName, detail) };
  });

  pi.on("tool_result", async (event, ctx) => {
    const live = mainSession(ctx);
    if (!live) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const record = records.get(sessionId) ?? rehydrate(ctx) ?? recordFor(sessionId);

    if (event.toolName === "ask") {
      record.pendingConsent = undefined;
      const episodeId = planModeEpisodeId(ctx);
      const fixedQuestion = provenanceBlockReason("ask") === undefined && isPrometheusOptInQuestion(event.input);
      if (record.phase === "idle" && live.getPlanModeState()?.enabled === true && episodeId && fixedQuestion) {
        if (isPrometheusOptInConsent(event.input, event.details, event.isError, ctx.hasUI)) {
          record.pendingConsent = { askToolCallId: event.toolCallId, modeEntryId: episodeId };
        } else {
          record.suppressedForModeEntryId = episodeId;
          persist(record);
          await syncTools(false, false);
        }
      }
      return undefined;
    }

    const proposedPath = proposedPlanPathFromToolResult(event.toolName, event.isError, event.details);
    if (!proposedPath || provenanceBlockReason("write") !== undefined || record.phase !== "planning") return undefined;
    record.planFilePath = proposedPath;
    record.proposedByToolCallId = event.toolCallId;
    record.proposalAwaitingApproval = true;
    record.approvalCompactionPending = false;
    persist(record);

    const approvedInResult = event.content.some((part) => part.type === "text" && part.text.trimStart().startsWith("Plan approved at "));
    if (approvedInResult && live.getPlanModeState()?.enabled !== true && planReferencesMatch(live.getPlanReferencePath(), proposedPath)) {
      enterExecution(ctx, record);
      await syncTools(false, true);
    }
    return undefined;
  });

  pi.on("session_before_compact", (_event, ctx) => {
    const live = mainSession(ctx);
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (
      live &&
      record?.phase === "planning" &&
      record.proposalAwaitingApproval === true &&
      live.getPlanModeState()?.enabled !== true &&
      planReferencesMatch(live.getPlanReferencePath(), record.planFilePath)
    ) {
      record.approvalCompactionPending = true;
    }
    return undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase === "planning" && record.approvalCompactionPending === true) {
      enterExecution(ctx, record);
      await syncTools(false, true);
    }
  });

  pi.on("session_before_switch", (event, ctx) => {
    pendingFreshHandoff = undefined;
    if (event.reason !== "new") return undefined;
    const live = mainSession(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const record = records.get(sessionId) ?? rehydrate(ctx);
    if (
      live &&
      record?.phase === "planning" &&
      record.planFilePath &&
      record.proposedByToolCallId &&
      record.proposalAwaitingApproval === true &&
      live.getPlanModeState()?.enabled !== true
    ) {
      pendingFreshHandoff = {
        sourceSessionId: sessionId,
        sourceSession: live,
        record: { ...record, pendingConsent: undefined, lastBlockedAt: 0 },
      };
    }
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const restored = rehydrate(ctx, true);
    await syncTools(false, restored?.phase === "executing");
  });

  pi.on("session_switch", async (event, ctx) => {
    const live = mainSession(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    authorizedActivationCalls.clear();
    if (event.reason === "new") {
      if (pendingFreshHandoff && live === pendingFreshHandoff.sourceSession) {
        records.delete(pendingFreshHandoff.sourceSessionId);
        pendingFreshHandoff.targetSessionId = sessionId;
      } else {
        pendingFreshHandoff = undefined;
      }
      records.delete(sessionId);
      await syncTools(false, false);
      return;
    }
    pendingFreshHandoff = undefined;
    const restored = rehydrate(ctx, true);
    await syncTools(false, restored?.phase === "executing");
  });

  pi.on("session_branch", async (_event, ctx) => {
    pendingFreshHandoff = undefined;
    authorizedActivationCalls.clear();
    const restored = rehydrate(ctx, true);
    await syncTools(false, restored?.phase === "executing");
  });

  pi.on("session_tree", async (_event, ctx) => {
    pendingFreshHandoff = undefined;
    authorizedActivationCalls.clear();
    const restored = rehydrate(ctx, true);
    await syncTools(false, restored?.phase === "executing");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    records.delete(ctx.sessionManager.getSessionId());
    authorizedActivationCalls.clear();
    pendingFreshHandoff = undefined;
  });
}
