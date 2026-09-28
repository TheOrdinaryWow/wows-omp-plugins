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
 * State is tracked per session id and mirrored into session entries; proposal
 * markers and execution ledgers live in session-local artifacts that survive the
 * host's fresh-session approval handoff. No process-global handoff state is used.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";

import { parseLegalAgentNames } from "./agents.ts";
import { ATLAS_ASSET, loadPromptAsset, loadRequiredPromptAssets, SKILL_ASSET } from "./assets.ts";
import { ChildEvidence, gateOutputSchema } from "./evidence.ts";
import {
  type ChildReceipt,
  createLedger,
  type ExecutionLedger,
  invalidateRows,
  isComplete,
  planDigest,
  refreshDispatchAgents,
  renderLedgerSummary,
  restoreLedger,
  startRow,
} from "./ledger.ts";
import { withLedgerLock, writeLedgerAtomic } from "./ledger-store.ts";
import {
  BLOCKED_TOOL_NOTICE,
  blockedToolMessage,
  EXECUTION_PREAMBLE,
  EXECUTION_START_NOTICE,
  executionBlockReason,
  executionToolSourceBlockReason,
  inlineApprovedPlan,
  isApprovedPlanHandoff,
  isPrometheusOptInConsent,
  isPrometheusOptInQuestion,
  nestedXdevToolCall,
  OPT_IN_ADDENDUM,
  PLANNING_PREAMBLE,
  PLUGIN_OWNED_TOOLS,
  PROMETHEUS_DEEP_OPTION_INDEX,
  PROMETHEUS_OPT_IN_QUESTION_ID,
  parsePrometheusCommand,
  planReferencesMatch,
  prometheusArtifactUrl,
  proposedPlanPathFromToolResult,
  taskSpawnBlockReason,
} from "./workflow.ts";

const ACTIVATE_TOOL = "prometheus_activate";
const RELEASE_TOOL = "prometheus_release";
const LEDGER_TOOL = "prometheus_ledger";
const STATE_ENTRY = "wows-omp-omo-prometheus.state";
const RECEIPT_ENTRY = "wows-omp-omo-prometheus.child-receipt";
const ATTEMPTS_ENTRY = "wows-omp-omo-prometheus.execution-attempts";
const PLANNING_CONTEXT_TYPE = "wows-omp-omo-prometheus.planning-context";
const EXECUTION_CONTEXT_TYPE = "wows-omp-omo-prometheus.execution-context";
const NATIVE_PLAN_CONTEXT_TYPE = "plan-mode-context";
const BLOCK_NOTICE_BURST_MS = 5_000;
const RUNTIME_SOURCE_PATH = fileURLToPath(import.meta.url);
const PACKAGE_NAME = "wows-omp-plugin-omo-prometheus";

type ReviewLevel = "off" | "ask" | "standard" | "high-accuracy";

function parseReviewLevel(value: unknown): ReviewLevel {
  if (value === undefined) return "ask";
  if (value === "off" || value === "ask" || value === "standard" || value === "high-accuracy") return value;
  throw new Error(`invalid reviewLevel ${JSON.stringify(value)}`);
}

type Phase = "idle" | "planning" | "executing";

interface SessionRecord {
  phase: Phase;
  /** Canonical path returned by the host's successful xd://propose dispatch. */
  planFilePath?: string;
  /** Exact content observed at the successful native proposal. */
  planSha256?: string;
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
  /** Expected `local://` URL. A missing/corrupt ledger pauses, never disables, enforcement. */
  ledgerPath?: string;
  ledgerError?: string;
  /** Set only by the native approval transition, never restored from session state. */
  mayInitializeLedger?: boolean;
  /** In-memory: newest ledger `updatedAt` seen by the last session_stop continuation. */
  lastContinuationLedgerStamp?: number;
  /** In-memory: consecutive session_stop continuations without ledger progress. */
  stallCount: number;
  lastBlockedAt: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function prometheus(pi: ExtensionAPI): void {
  const records = new Map<string, SessionRecord>();
  const authorizedActivationCalls = new Map<string, string>();
  const reviewLevels = new Map<string, ReviewLevel>();
  const childEvidence = new ChildEvidence();
  const evidenceSubscription = pi.events?.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (payload) => childEvidence.observe(payload));

  const loadReviewLevel = async (ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      reviewLevels.set(sessionId, parseReviewLevel((await getPluginSettings(PACKAGE_NAME, ctx.cwd)).reviewLevel));
    } catch (error) {
      reviewLevels.set(sessionId, "ask");
      pi.logger.warn("prometheus reviewLevel is invalid; using ask", { error: errorMessage(error) });
    }
  };

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
      customType: "wows-omp-omo-prometheus.command-status",
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
    const created: SessionRecord = { phase: "idle", lastBlockedAt: 0, stallCount: 0 };
    records.set(sessionId, created);
    return created;
  };

  const persist = (record: SessionRecord): void => {
    try {
      pi.appendEntry(STATE_ENTRY, {
        version: 2,
        phase: record.phase,
        planningModeEntryId: record.planningModeEntryId,
        planFilePath: record.planFilePath,
        planSha256: record.planSha256,
        proposedByToolCallId: record.proposedByToolCallId,
        offeredForModeEntryId: record.offeredForModeEntryId,
        suppressedForModeEntryId: record.suppressedForModeEntryId,
        proposalAwaitingApproval: record.proposalAwaitingApproval === true,
        approvalCompactionPending: record.approvalCompactionPending === true,
        ledgerPath: record.ledgerPath,
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
            planSha256?: unknown;
            planningModeEntryId?: unknown;
            proposedByToolCallId?: unknown;
            offeredForModeEntryId?: unknown;
            suppressedForModeEntryId?: unknown;
            proposalAwaitingApproval?: unknown;
            approvalCompactionPending?: unknown;
            ledgerPath?: unknown;
          }
        | undefined;
      if (data?.phase !== "idle" && data?.phase !== "planning" && data?.phase !== "executing") continue;
      restored = {
        phase: data.phase,
        planFilePath: typeof data.planFilePath === "string" && data.planFilePath.trim() ? data.planFilePath : undefined,
        planSha256: typeof data.planSha256 === "string" && /^[a-f0-9]{64}$/.test(data.planSha256) ? data.planSha256 : undefined,
        proposedByToolCallId:
          typeof data.proposedByToolCallId === "string" && data.proposedByToolCallId ? data.proposedByToolCallId : undefined,
        offeredForModeEntryId:
          typeof data.offeredForModeEntryId === "string" && data.offeredForModeEntryId ? data.offeredForModeEntryId : undefined,
        suppressedForModeEntryId:
          typeof data.suppressedForModeEntryId === "string" && data.suppressedForModeEntryId ? data.suppressedForModeEntryId : undefined,
        proposalAwaitingApproval: typeof data.proposalAwaitingApproval === "boolean" ? data.proposalAwaitingApproval : false,
        approvalCompactionPending: typeof data.approvalCompactionPending === "boolean" ? data.approvalCompactionPending : false,
        ledgerPath: typeof data.ledgerPath === "string" && data.ledgerPath ? data.ledgerPath : undefined,
        stallCount: 0,
        lastBlockedAt: 0,
        planningModeEntryId:
          typeof data.planningModeEntryId === "string" && data.planningModeEntryId ? data.planningModeEntryId : undefined,
      };
    }
    if (restored) records.set(sessionId, restored);
    return restored;
  };

  const syncTools = async (wantActivate: boolean, wantRelease: boolean, wantLedger: boolean): Promise<void> => {
    try {
      const active = pi.getActiveTools();
      const desired = new Set(active);
      if (wantActivate) desired.add(ACTIVATE_TOOL);
      else desired.delete(ACTIVATE_TOOL);
      if (wantRelease) desired.add(RELEASE_TOOL);
      else desired.delete(RELEASE_TOOL);
      if (wantLedger) desired.add(LEDGER_TOOL);
      else desired.delete(LEDGER_TOOL);
      if (desired.size === active.length && active.every((name) => desired.has(name))) return;
      await pi.setActiveTools([...desired]);
    } catch (error) {
      pi.logger.warn("prometheus could not reconcile workflow tools", { error: errorMessage(error) });
    }
  };

  const availableAgents = (): string[] | undefined => {
    try {
      const description = pi.getAllTools().find((tool) => tool.name === "task")?.description;
      return typeof description === "string" ? parseLegalAgentNames(description) : undefined;
    } catch (error) {
      pi.logger.warn("prometheus could not inspect available task agents", { error: errorMessage(error) });
      return undefined;
    }
  };

  const ledgerSummary = (ledger: ExecutionLedger): string => renderLedgerSummary(ledger, availableAgents());

  const localOptions = (ctx: ExtensionContext) => ({
    getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
    getSessionId: () => ctx.sessionManager.getSessionId(),
  });

  const clearProposalMarker = async (ctx: ExtensionContext, planFilePath: string | undefined): Promise<void> => {
    if (!planFilePath) return;
    try {
      await fs.rm(resolveLocalUrlToPath(prometheusArtifactUrl(planFilePath, "proposal"), localOptions(ctx)), { force: true });
    } catch (error) {
      pi.logger.warn("prometheus could not remove the proposal marker", { error: errorMessage(error) });
    }
  };

  const pauseMessage = (record: SessionRecord): string =>
    `Prometheus execution paused: ${record.ledgerError ?? "the approved execution ledger is unavailable"}. No new task dispatch or completion is permitted. Restore the exact approved plan/ledger, or run /prometheus to exit and obtain fresh native approval; do not use prompt-only execution.`;

  const receiptEntries = (ctx: ExtensionContext): ChildReceipt[] => {
    const receipts: ChildReceipt[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== RECEIPT_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      // Only the plugin writes this entry. Full equality with the ledger receipt is checked before use.
      const receipt = entry.data as ChildReceipt;
      if (typeof receipt.receiptId === "string" && typeof receipt.childAgentId === "string") receipts.push(receipt);
    }
    return receipts;
  };

  const currentAttempts = (ctx: ExtensionContext, ledgerId: string): Map<string, string | null> => {
    let attempts = new Map<string, string | null>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ATTEMPTS_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      if (!("ledgerId" in entry.data) || entry.data.ledgerId !== ledgerId) continue;
      if (!("attempts" in entry.data) || !entry.data.attempts || typeof entry.data.attempts !== "object")
        throw new Error("Invalid attempt checkpoint");
      attempts = new Map();
      for (const [id, attempt] of Object.entries(entry.data.attempts)) {
        if (attempt !== null && typeof attempt !== "string") throw new Error("Invalid attempt checkpoint");
        attempts.set(id, attempt);
      }
    }
    return attempts;
  };

  const persistAttempts = (ledger: ExecutionLedger): void => {
    pi.appendEntry(ATTEMPTS_ENTRY, {
      ledgerId: ledger.ledgerId,
      attempts: Object.fromEntries([...ledger.items, ...ledger.gates].map((row) => [row.id, row.attempt ?? null])),
    });
  };

  const withExecutionLedger = async <T>(
    ctx: ExtensionContext,
    record: SessionRecord,
    run: (ledger: ExecutionLedger) => T | Promise<T>,
    save = false,
    resume = false,
  ): Promise<T> => {
    try {
      if (!record.ledgerPath || record.ledgerPath === "disabled" || !record.planFilePath || !ctx.sessionManager.getArtifactsDir()) {
        throw new Error("missing execution ledger or durable approved-plan binding");
      }
      if (!planReferencesMatch(mainSession(ctx)?.getPlanReferencePath(), record.planFilePath)) {
        throw new Error("the host plan reference differs from the approved execution plan");
      }
      const ledgerFile = resolveLocalUrlToPath(record.ledgerPath, localOptions(ctx));
      if (record.ledgerPath !== prometheusArtifactUrl(record.planFilePath, "ledger")) throw new Error("unexpected execution ledger path");
      return await withLedgerLock(ledgerFile, async () => {
        if (record.phase !== "executing") throw new Error("execution is no longer active");
        const data: unknown = JSON.parse(await fs.readFile(ledgerFile, "utf8"));
        const content = await fs.readFile(resolveLocalUrlToPath(record.planFilePath as string, localOptions(ctx)), "utf8");
        // Version-one ledgers already pinned the approved bytes, but had no trustworthy completion receipts.
        if (
          !record.planSha256 &&
          data &&
          typeof data === "object" &&
          "version" in data &&
          data.version === 1 &&
          "planSha256" in data &&
          data.planSha256 === planDigest(content)
        ) {
          record.planSha256 = data.planSha256 as string;
          persist(record);
        }
        if (!record.planSha256) throw new Error("the exact approved plan hash is missing; fresh native approval is required");
        const ledger = restoreLedger(data, record.planFilePath as string, content, record.planSha256);
        let changed = ledger !== data;
        const receipts = receiptEntries(ctx);
        const attempts = currentAttempts(ctx, ledger.ledgerId);
        const artifactsDir = ctx.sessionManager.getArtifactsDir() as string;
        for (const row of [...ledger.items, ...ledger.gates]) {
          if (row.status === "in_progress" && (resume || attempts.get(row.id) !== row.attempt)) {
            invalidateRows(ledger, row.id, "Unrecorded or invalidated attempt reopened; cancel old work and dispatch a fresh child.");
            changed = true;
          }
          if (row.status !== "done") continue;
          const receipt = row.receipt;
          let valid =
            receipt !== undefined &&
            receipt !== null &&
            typeof receipt === "object" &&
            receipt.ledgerId === ledger.ledgerId &&
            receipt.planSha256 === ledger.planSha256 &&
            receipt.rowId === row.id &&
            receipt.attempt === row.attempt &&
            attempts.get(row.id) === row.attempt &&
            receipt.childAgentId === row.childAgentId &&
            receipt.sessionId === ctx.sessionManager.getSessionId() &&
            receipts.some((saved) => JSON.stringify(saved) === JSON.stringify(receipt));
          if (valid && receipt) {
            try {
              const file = path.join(artifactsDir, `${receipt.childAgentId}.md`);
              const child = AgentRegistry.global().get(receipt.childAgentId);
              valid =
                (await fs.lstat(file)).isFile() &&
                planDigest(await fs.readFile(file, "utf8")) === receipt.outputSha256 &&
                (!child ||
                  (child.parentId === receipt.parentAgentId &&
                    (child.status === "idle" || child.status === "parked") &&
                    child.sessionFile !== null &&
                    path.resolve(child.sessionFile) === path.resolve(artifactsDir, `${receipt.childAgentId}.jsonl`)));
            } catch {
              valid = false;
            }
          }
          if (!valid) {
            invalidateRows(ledger, row.id, "Historical child proof is missing or changed; a fresh child must revalidate this row.");
            changed = true;
          }
        }
        changed = refreshDispatchAgents(ledger, availableAgents()) || changed;
        // Recovery invalidations must survive even when the requested mutation is refused.
        if (changed) {
          persistAttempts(ledger);
          await writeLedgerAtomic(ledgerFile, ledger);
        }
        record.ledgerError = undefined;
        const result = await run(ledger);
        if (save) {
          if (record.phase !== "executing") throw new Error("execution was released during the ledger update");
          persistAttempts(ledger);
          await writeLedgerAtomic(ledgerFile, ledger);
        }
        return result;
      });
    } catch (error) {
      record.ledgerError = errorMessage(error);
      throw error;
    }
  };

  const readLedger = async (ctx: ExtensionContext, record: SessionRecord): Promise<ExecutionLedger | undefined> => {
    try {
      return await withExecutionLedger(ctx, record, (ledger) => ledger);
    } catch (error) {
      pi.logger.warn("prometheus execution ledger is unavailable", { error: errorMessage(error) });
      return undefined;
    }
  };

  /** Only a newly approved execution may initialize a ledger. Resume never reconstructs a missing file. */
  const ensureLedger = async (ctx: ExtensionContext, record: SessionRecord, planContent?: string): Promise<void> => {
    const planFilePath = record.planFilePath;
    if (record.ledgerPath || !planFilePath || !record.mayInitializeLedger) return;
    record.mayInitializeLedger = false;
    record.ledgerPath = prometheusArtifactUrl(planFilePath, "ledger");
    persist(record);
    try {
      if (!ctx.sessionManager.getArtifactsDir()) throw new Error("this session has no durable artifact directory");
      const content = await fs.readFile(resolveLocalUrlToPath(planFilePath, localOptions(ctx)), "utf8");
      if (
        !record.planSha256 ||
        planDigest(content) !== record.planSha256 ||
        (planContent !== undefined && planDigest(planContent) !== record.planSha256)
      ) {
        throw new Error("the current or handed-off plan differs from the exact native proposal");
      }
      const file = resolveLocalUrlToPath(record.ledgerPath, localOptions(ctx));
      await withLedgerLock(file, () => writeLedgerAtomic(file, createLedger(planFilePath, content, availableAgents())));
      record.ledgerError = undefined;
    } catch (error) {
      record.ledgerError = errorMessage(error);
      notify(ctx, pauseMessage(record), "error");
    }
  };

  const resumeLedger = async (ctx: ExtensionContext, record: SessionRecord | undefined): Promise<void> => {
    if (record?.phase !== "executing") return;
    try {
      await withExecutionLedger(ctx, record, () => undefined, false, true);
    } catch {
      notify(ctx, pauseMessage(record), "error");
    }
  };

  const release = async (ctx: ExtensionContext, reason: string): Promise<void> => {
    if (!mainSession(ctx)) {
      notify(ctx, "Prometheus runs in the main session only.", "warning");
      return;
    }
    const episodeId = planModeEpisodeId(ctx);
    authorizedActivationCalls.clear();
    const record =
      records.get(ctx.sessionManager.getSessionId()) ??
      rehydrate(ctx) ??
      (episodeId ? recordFor(ctx.sessionManager.getSessionId()) : undefined);
    if (!record) {
      notify(ctx, "Prometheus is not active in this session.");
      await syncTools(false, false, false);
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
      await syncTools(false, false, false);
      notify(ctx, episodeId ? "Prometheus opt-in is off for this native plan-mode session." : "Prometheus is not active in this session.");
      return;
    }
    const wasExecuting = record.phase === "executing";
    await clearProposalMarker(ctx, record.planFilePath);
    record.phase = "idle";
    record.planFilePath = undefined;
    record.planSha256 = undefined;
    record.ledgerError = undefined;
    childEvidence.clearSession(ctx.sessionManager.getSessionId());
    record.proposedByToolCallId = undefined;
    record.offeredForModeEntryId = episodeId;
    record.suppressedForModeEntryId = episodeId;
    record.pendingConsent = undefined;
    record.proposalAwaitingApproval = false;
    record.approvalCompactionPending = false;
    record.planningModeEntryId = undefined;
    record.offerPendingForModeEntryId = undefined;
    record.ledgerPath = undefined;
    record.lastContinuationLedgerStamp = undefined;
    record.stallCount = 0;
    persist(record);
    await syncTools(false, false, false);
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
      record.planSha256 = undefined;
      record.ledgerError = undefined;
      record.proposedByToolCallId = undefined;
      record.offeredForModeEntryId = undefined;
      record.suppressedForModeEntryId = undefined;
      record.pendingConsent = undefined;
      record.proposalAwaitingApproval = false;
      record.approvalCompactionPending = false;
      record.offerPendingForModeEntryId = undefined;
      record.planningModeEntryId = planModeEpisodeId(ctx);
      record.ledgerPath = undefined;
      record.lastContinuationLedgerStamp = undefined;
      record.stallCount = 0;
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
      PLUGIN_OWNED_TOOLS.has(toolName) && provenance?.source === "extension" && provenance.path === RUNTIME_SOURCE_PATH;
    return executionToolSourceBlockReason(toolName, provenance?.source, trustedPrometheusTool);
  };

  const planningBlock = async (ctx: ExtensionContext): Promise<string> => {
    const roster = availableAgents();
    const agentBlock = roster
      ? `<available-agents>\n${roster.join("\n") || "(none; spawning is disabled)"}\n</available-agents>`
      : '<available-agents status="unknown">The task tool\'s spawnable-agent list could not be parsed; use only known agents with documented fallbacks.</available-agents>';
    const guidance =
      "Choose the most specific listed specialist for each Agent: row; prefer installed specialist agents (including omo-toolkit) over task/sonic. Names not listed are allowed only when they have a known fallback. Pass this exact available-agents list (or unknown) into every Momus review binding.";
    const reviewPolicy =
      `<review-policy level="${reviewLevels.get(ctx.sessionManager.getSessionId()) ?? "ask"}">` +
      "Apply this session's plan-review setting in section 7 of the planning skill.</review-policy>";
    try {
      return `${PLANNING_PREAMBLE}\n\n${agentBlock}\n${guidance}\n\n${reviewPolicy}\n\n${await loadPromptAsset(SKILL_ASSET)}`;
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus planning asset became unavailable", { error: detail });
      notify(ctx, `Prometheus planning instructions could not be loaded (${detail}).`, "error");
      return `${PLANNING_PREAMBLE}\n\n${agentBlock}\n${guidance}\n\n${reviewPolicy}`;
    }
  };

  const atlasBlock = async (ctx: ExtensionContext, record: SessionRecord): Promise<string> => {
    const planPath = record.planFilePath ?? "unavailable (retain the inline native plan and report this recovery limitation)";
    const taskIssue =
      provenanceBlockReason("task") ??
      (pi.getActiveTools().includes("task") ? undefined : "the native task tool is disabled in this session");
    const capability = taskIssue
      ? `\n\n<capability-block>The required native task tool is unavailable: ${taskIssue}. Report this blocker; do not implement in the parent.</capability-block>`
      : "";
    const ledger = await readLedger(ctx, record);
    const ledgerBlock = ledger
      ? `\n\n<execution-ledger path="${record.ledgerPath}">\n${ledgerSummary(ledger)}\n</execution-ledger>`
      : `\n\n<execution-ledger status="paused">${pauseMessage(record)}</execution-ledger>`;
    const header = `${EXECUTION_PREAMBLE}\n\n<approved-plan-reference path="${planPath}" provenance="native-xd-propose" />${ledgerBlock}${capability}`;
    try {
      return `${header}\n\n${await loadPromptAsset(ATLAS_ASSET)}`;
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus Atlas asset became unavailable", { error: detail });
      notify(ctx, `Prometheus could not load the Atlas asset (${detail}); the execution guard remains active.`, "error");
      return header;
    }
  };

  const enterExecution = (ctx: ExtensionContext, record: SessionRecord): void => {
    record.phase = "executing";
    record.mayInitializeLedger = record.ledgerPath === undefined;
    record.pendingConsent = undefined;
    record.proposalAwaitingApproval = false;
    record.approvalCompactionPending = false;
    record.offeredForModeEntryId = undefined;
    record.offerPendingForModeEntryId = undefined;
    record.planningModeEntryId = undefined;
    record.lastContinuationLedgerStamp = undefined;
    record.stallCount = 0;
    persist(record);
    notify(ctx, EXECUTION_START_NOTICE);
  };

  pi.on("input", async (event, ctx) => {
    const current = records.get(ctx.sessionManager.getSessionId());
    if (current && event.source !== "extension") current.stallCount = 0;
    const command = parsePrometheusCommand(event.text);
    if (!command) {
      const trimmed = event.text.trim();
      if (trimmed.startsWith("/") && current?.phase === "planning") current.proposalAwaitingApproval = false;
      if (trimmed.startsWith("/") && current?.phase === "planning") current.approvalCompactionPending = false;
      if (/^\/plan(?:[ \t]|$)/.test(trimmed)) {
        const live = mainSession(ctx);
        const record = current ?? rehydrate(ctx);
        if (live?.getPlanModeState()?.enabled === true && record?.phase === "planning") {
          record.phase = "idle";
          await clearProposalMarker(ctx, record.planFilePath);
          record.planFilePath = undefined;
          record.proposedByToolCallId = undefined;
          record.planningModeEntryId = undefined;
          record.pendingConsent = undefined;
          record.proposalAwaitingApproval = false;
          record.approvalCompactionPending = false;
          record.offerPendingForModeEntryId = undefined;
          persist(record);
          await syncTools(false, false, false);
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
  const ledgerParameters = z.object({
    action: z
      .enum(["status", "start", "done", "block", "reopen"])
      .describe("status shows every row; start, done, block, and reopen change the row named by id"),
    id: z.string().optional().describe("Plan row id such as T3 or F2; required for every action except status"),
    evidence: z
      .string()
      .optional()
      .describe(
        "Inspected observable evidence; required for done and block. Gate verdicts are read from native child output, not this text",
      ),
    childAgentId: z
      .string()
      .optional()
      .describe("Required for done: exact id of the owned native child dispatched for this started attempt"),
  });
  type LedgerParams = {
    action: "status" | "start" | "done" | "block" | "reopen";
    id?: string;
    evidence?: string;
    childAgentId?: string;
  };

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
      await syncTools(false, false, false);
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
      "After every delegated plan item and final gate has verified child evidence, request human confirmation to release Atlas. Refused while execution-ledger rows remain unfinished; never releases without confirmation.",
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
      const ledger = await readLedger(ctx, record);
      if (!ledger) return { content: [{ type: "text" as const, text: pauseMessage(record) }], isError: true, details: {} };
      if (!isComplete(ledger)) {
        const unfinished = [...ledger.items, ...ledger.gates].filter((item) => item.status !== "done");
        return {
          content: [
            {
              type: "text" as const,
              text: `Release refused: unfinished ledger rows remain (${unfinished.map((item) => `${item.id} ${item.status}`).join(", ")}). Keep delegating.\n\n${ledgerSummary(ledger)}`,
            },
          ],
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
      try {
        return await withExecutionLedger(ctx, record, async (current) => {
          if (!isComplete(current)) throw new Error("Completion evidence changed while awaiting confirmation; release refused");
          await release(ctx, "human-confirmed completion release");
          return { content: [{ type: "text" as const, text: "Prometheus execution guard released by the user." }], details: {} };
        });
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Release refused: ${errorMessage(error)}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: LEDGER_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Prometheus Ledger",
    description:
      "Read or update the approved execution ledger. Start a row BEFORE task dispatch and copy its prometheus_assignment binding. Done requires the id of its real completed native child and inspected evidence. Gates require distinct fresh children with structured PASS output; F4 follows F1–F3. Reopen/block invalidates descendants and stale gate attempts.",
    parameters: ledgerParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (_toolCallId, params: LedgerParams, _signal, _onUpdate, ctx) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: {} });
      const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      if (!mainSession(ctx) || record?.phase !== "executing") return fail("Prometheus Atlas execution is not active in this main session.");
      try {
        return await withExecutionLedger(
          ctx,
          record,
          async (ledger) => {
            if (params.action === "status")
              return { content: [{ type: "text" as const, text: ledgerSummary(ledger) }], details: { ledger } };
            const id = params.id?.trim();
            const item = [...ledger.items, ...ledger.gates].find((entry) => entry.id === id);
            if (!item) throw new Error(`Unknown ledger row ${id || "(missing id)"}`);
            const evidence = params.evidence?.trim();
            let schema: Record<string, unknown> | undefined;
            if (params.action === "start") {
              startRow(ledger, item.id);
              if (item.id.startsWith("F")) schema = gateOutputSchema(ledger, item);
            } else if (params.action === "done") {
              const childAgentId = params.childAgentId?.trim();
              if (!evidence || !childAgentId) throw new Error(`Marking ${item.id} done requires inspected evidence and childAgentId`);
              const parent = AgentRegistry.global()
                .list()
                .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager);
              if (!parent) throw new Error("Registered parent identity is unavailable");
              const receipt = await childEvidence.capture({
                registry: AgentRegistry.global(),
                parentAgentId: parent.id,
                sessionId: ctx.sessionManager.getSessionId(),
                artifactsDir: ctx.sessionManager.getArtifactsDir() as string,
                ledger,
                row: item,
                childAgentId,
                priorReceipts: receiptEntries(ctx),
              });
              // Persist the host-observed receipt independently before publishing completion in the ledger.
              pi.appendEntry(RECEIPT_ENTRY, receipt);
              item.receipt = receipt;
              item.childAgentId = childAgentId;
              item.evidence = `agent://${childAgentId}: ${evidence}`;
              item.status = "done";
              item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
            } else {
              if (params.action === "block" && !evidence) throw new Error("Blocking a row requires an explanation");
              if ((params.action === "reopen" && item.status === "open") || (params.action === "block" && item.status === "blocked")) {
                throw new Error(`${item.id} is already ${item.status}`);
              }
              invalidateRows(ledger, item.id, evidence);
              if (params.action === "block") item.status = "blocked";
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${item.id} is now ${item.status}.\n\n${ledgerSummary(ledger)}${schema ? `\nGate task outputSchema (use schemaMode strict): ${JSON.stringify(schema)}` : ""}`,
                },
              ],
              details: { id: item.id, status: item.status, outputSchema: schema },
            };
          },
          params.action !== "status",
        );
      } catch (error) {
        return fail(
          `Ledger operation refused: ${errorMessage(error)}. Execution requires a valid approved ledger; /prometheus remains the user exit.`,
        );
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const live = mainSession(ctx);
    if (!live) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    let record = records.get(sessionId) ?? rehydrate(ctx);
    const reference = live.getPlanReferencePath();
    if ((!record || record.phase === "idle") && reference && isApprovedPlanHandoff(event.prompt, reference, reference)) {
      try {
        const marker = JSON.parse(
          await fs.readFile(resolveLocalUrlToPath(prometheusArtifactUrl(reference, "proposal"), localOptions(ctx)), "utf8"),
        ) as { version?: unknown; planFilePath?: unknown; planSha256?: unknown; proposedByToolCallId?: unknown };
        // A present but invalid plugin marker must pause this handoff, not silently become ordinary execution.
        if (
          (marker.version !== 1 && marker.version !== 2) ||
          typeof marker.planFilePath !== "string" ||
          !planReferencesMatch(marker.planFilePath, reference) ||
          typeof marker.proposedByToolCallId !== "string" ||
          !marker.proposedByToolCallId
        )
          throw new Error("Invalid Prometheus proposal marker");
        record = {
          phase: "planning",
          planFilePath: reference,
          planSha256: typeof marker.planSha256 === "string" && /^[a-f0-9]{64}$/.test(marker.planSha256) ? marker.planSha256 : undefined,
          proposedByToolCallId: marker.proposedByToolCallId,
          lastBlockedAt: 0,
          stallCount: 0,
        };
        records.set(sessionId, record);
      } catch (error) {
        // No marker means an ordinary native plan approval, which stays untouched.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          pi.logger.warn("prometheus could not read the proposal marker", { error: errorMessage(error) });
          record = { phase: "planning", planFilePath: reference, lastBlockedAt: 0, stallCount: 0 };
          records.set(sessionId, record);
        }
      }
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
    let executing = record?.phase === "executing";

    if (record?.phase === "planning") {
      if (planModeActive) {
        injected = await planningBlock(ctx);
      } else if (isApprovedPlanHandoff(event.prompt, record.planFilePath, live.getPlanReferencePath())) {
        enterExecution(ctx, record);
        executing = true;
      } else {
        await clearProposalMarker(ctx, record.planFilePath);
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
    } else if (!executing && planModeActive) {
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

    if (executing && record) {
      if (record.ledgerPath === undefined) {
        const inlinePlan =
          record.planFilePath && isApprovedPlanHandoff(event.prompt, record.planFilePath, live.getPlanReferencePath())
            ? inlineApprovedPlan(event.prompt, record.planFilePath)
            : undefined;
        await ensureLedger(ctx, record, inlinePlan);
      }
      injected = await atlasBlock(ctx, record);
    }

    await syncTools(wantActivate, executing, executing);
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

  pi.on("tool_call", async (event, ctx) => {
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
    if (event.toolName === "task") {
      const taskSpawnDetail = taskSpawnBlockReason(record?.phase, event.input);
      if (taskSpawnDetail) return { block: true, reason: taskSpawnDetail };
    }
    if (record?.phase !== "executing") return undefined;

    let detail = executionBlockReason(event.toolName, event.input);
    if (!detail) detail = provenanceBlockReason(event.toolName);
    const nested = event.toolName === "write" ? nestedXdevToolCall(event.input) : undefined;
    if (!detail && nested) detail = provenanceBlockReason(nested.toolName);
    if (!detail && (event.toolName === "task" || nested?.toolName === "task")) {
      try {
        if (!evidenceSubscription) throw new Error("native child lifecycle evidence is unavailable on this host");
        await withExecutionLedger(ctx, record, (ledger) => {
          childEvidence.rememberDispatch(event.toolCallId, ctx.sessionManager.getSessionId(), ledger, nested?.input ?? event.input);
        });
      } catch (error) {
        return {
          block: true,
          reason: `Task dispatch refused: ${errorMessage(error)}. Use a valid ledger and its current start binding; /prometheus is the user exit.`,
        };
      }
    }
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
          await syncTools(false, false, false);
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
    record.ledgerPath = undefined;
    record.planSha256 = undefined;
    try {
      record.planSha256 = planDigest(await fs.readFile(resolveLocalUrlToPath(proposedPath, localOptions(ctx)), "utf8"));
      const markerFile = resolveLocalUrlToPath(prometheusArtifactUrl(proposedPath, "proposal"), localOptions(ctx));
      await writeLedgerAtomic(markerFile, {
        version: 2,
        planFilePath: proposedPath,
        planSha256: record.planSha256,
        proposedByToolCallId: event.toolCallId,
        createdAt: Date.now(),
      });
    } catch (error) {
      pi.logger.warn("prometheus could not write the proposal marker", { error: errorMessage(error) });
    }
    persist(record);

    const approvedInResult = event.content.some((part) => part.type === "text" && part.text.trimStart().startsWith("Plan approved at "));
    if (approvedInResult && live.getPlanModeState()?.enabled !== true && planReferencesMatch(live.getPlanReferencePath(), proposedPath)) {
      enterExecution(ctx, record);
      await ensureLedger(ctx, record);
      await syncTools(false, true, true);
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
      await syncTools(false, true, true);
    }
  });

  pi.on("session_stop", async (_event, ctx) => {
    if (!mainSession(ctx)) return undefined;
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase !== "executing") return undefined;
    const ledger = await readLedger(ctx, record);
    if (!ledger) {
      notify(ctx, pauseMessage(record), "error");
      return undefined;
    }
    if (isComplete(ledger)) return undefined;
    const stamp = Math.max(...[...ledger.items, ...ledger.gates].map((item) => item.updatedAt));
    record.stallCount = stamp === record.lastContinuationLedgerStamp ? record.stallCount + 1 : 0;
    if (record.stallCount >= 2) {
      notify(ctx, "Prometheus: execution stalled; run /prometheus to release or send new instructions", "warning");
      return undefined;
    }
    record.lastContinuationLedgerStamp = stamp;
    return {
      continue: true,
      additionalContext: `<prometheus-continuation>\n${ledgerSummary(ledger)}\nDispatch the next unblocked items with task; record progress with prometheus_ledger; call prometheus_release only when every T and F row is done.\n</prometheus-continuation>`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await loadReviewLevel(ctx);
    const restored = rehydrate(ctx, true);
    await resumeLedger(ctx, restored);
    const executing = restored?.phase === "executing";
    await syncTools(false, executing, executing);
  });

  pi.on("session_switch", async (event, ctx) => {
    authorizedActivationCalls.clear();
    await loadReviewLevel(ctx);
    if (event.reason === "new") {
      records.delete(ctx.sessionManager.getSessionId());
      await syncTools(false, false, false);
      return;
    }
    const restored = rehydrate(ctx, true);
    await resumeLedger(ctx, restored);
    const executing = restored?.phase === "executing";
    await syncTools(false, executing, executing);
  });

  pi.on("session_branch", async (_event, ctx) => {
    authorizedActivationCalls.clear();
    const restored = rehydrate(ctx, true);
    await resumeLedger(ctx, restored);
    const executing = restored?.phase === "executing";
    await syncTools(false, executing, executing);
  });

  pi.on("session_tree", async (_event, ctx) => {
    authorizedActivationCalls.clear();
    const restored = rehydrate(ctx, true);
    await resumeLedger(ctx, restored);
    const executing = restored?.phase === "executing";
    await syncTools(false, executing, executing);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    records.delete(ctx.sessionManager.getSessionId());
    childEvidence.clearSession(ctx.sessionManager.getSessionId());
    reviewLevels.delete(ctx.sessionManager.getSessionId());
    authorizedActivationCalls.clear();
  });
}
