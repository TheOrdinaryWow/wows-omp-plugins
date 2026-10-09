/** Prometheus plans through native approval; Atlas executes shared approved plans. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { isTodoPhase, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

import { parseLegalAgentNames } from "./agents.ts";
import { ATLAS_ASSET, loadPromptAsset, loadRequiredPromptAssets, SKILL_ASSET } from "./assets.ts";
import { AtlasLive } from "./atlas-live.ts";
import {
  type AtlasFilter,
  AtlasMenu,
  type AtlasMenuAction,
  AtlasPlanView,
  type AtlasPlanViewAction,
  type AtlasPlanViewMode,
  atlasPlanList,
  atlasPlanText,
  dispatchBlock,
  formatTime,
} from "./atlas-menu.ts";
import { AtlasPlanReferences, atlasPlanUrl } from "./atlas-plan-url.ts";
import { applyAtlasModel, exposeAtlasApprovalTier, registerAtlasModelRole, restoreApprovalTiers } from "./atlas-role.ts";
import { findPlanSessions } from "./atlas-sessions.ts";
import { type AtlasPlan, type AtlasPlanDetail, AtlasStore } from "./atlas-store.ts";
import { retitleForAtlas } from "./atlas-title.ts";
import { atlasTodoRefreshCall, mergeAtlasTodos, syncAtlasTodos } from "./atlas-todo.ts";
import { AtlasStatusWidget, atlasWidgetLines } from "./atlas-widget.ts";
import { ChildEvidence, gateOutputSchema } from "./evidence.ts";
import { collectComplianceEvidence } from "./git-evidence.ts";
import { HerdrDagContract } from "./herdr-dag-contract.ts";
import {
  addFixRow,
  type ExecutionLedger,
  isComplete,
  type LedgerItem,
  ledgerRows,
  parsePlanChecklist,
  planDigest,
  refreshDispatchAgents,
  renderLedgerSummary,
  reopenRow,
  startRow,
} from "./ledger.ts";
import { writeLedgerAtomic } from "./ledger-store.ts";
import { PluginStatePublisher } from "./plugin-state.ts";
import { prometheusState } from "./prometheus-state.ts";
import { type AtlasCompleted, isRoadmapStage, RoadmapContract, type RoadmapStage } from "./roadmap-contract.ts";
import {
  ATLAS_USAGE,
  type AtlasCompletionPlan,
  atlasArgumentCompletions,
  BLOCKED_TOOL_NOTICE,
  blockedToolMessage,
  EXECUTION_PREAMBLE,
  EXECUTION_START_NOTICE,
  executionBlockReason,
  executionToolSourceBlockReason,
  inlinesApprovedPlan,
  isApprovedPlanHandoff,
  isPrometheusOptInConsent,
  isPrometheusOptInQuestion,
  nestedXdevToolCall,
  OPT_IN_ADDENDUM,
  PLANNING_PREAMBLE,
  PLUGIN_OWNED_TOOLS,
  PROMETHEUS_DEEP_OPTION_INDEX,
  PROMETHEUS_OPT_IN_QUESTION_ID,
  parseAtlasCommand,
  parseAtlasSubcommand,
  parsePrometheusCommand,
  planReferencesMatch,
  prometheusArtifactUrl,
  proposedPlanPathFromToolResult,
  proposedPlanUrl,
  taskSpawnBlockReason,
} from "./workflow.ts";

const ACTIVATE_TOOL = "prometheus_activate";
const RELEASE_TOOL = "atlas_release";
const LEDGER_TOOL = "atlas_ledger";
const STATE_ENTRY = "wows-omp-omo-prometheus.state";
const ATLAS_START_TYPE = "wows-omp-omo-prometheus.atlas-start";
const PLANNING_CONTEXT_TYPE = "wows-omp-omo-prometheus.planning-context";
const EXECUTION_CONTEXT_TYPE = "wows-omp-omo-prometheus.execution-context";
const NATIVE_PLAN_CONTEXT_TYPE = "plan-mode-context";
const BLOCK_NOTICE_BURST_MS = 5_000;
const PLAN_MODE_DISABLED =
  "Prometheus needs OMP plan mode, which is turned off in settings. Enable plan mode (plan.enabled), then run /prometheus again.";
const RUNTIME_SOURCE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PLAN_REFERENCE = "local://PLAN.md";
const PACKAGE_NAME = "wows-omp-plugin-omo-prometheus";

type ReviewLevel = "off" | "ask" | "standard" | "high-accuracy";

function parseReviewLevel(value: unknown): ReviewLevel {
  if (value === undefined) return "ask";
  if (value === "off" || value === "ask" || value === "standard" || value === "high-accuracy") return value;
  throw new Error(`invalid reviewLevel ${JSON.stringify(value)}`);
}

type Phase = "idle" | "planning" | "executing";

interface Ownership {
  store: AtlasStore;
  plan: AtlasPlan;
  sessionId: string;
  live: AgentSession;
  parentAgentId: string;
  ledgerId: string;
  detached: boolean;
  operations: number;
  releasing?: Promise<void>;
}

interface SessionRecord {
  phase: Phase;
  /** Canonical path returned by the host's successful xd://propose dispatch. */
  planFilePath?: string;
  /** Exact content observed at the successful native proposal. */
  planSha256?: string;
  /** Tool-call provenance for the proposal that chose planFilePath. */
  proposedByToolCallId?: string;
  roadmapStage?: RoadmapStage;
  /** `mode_change` entry for which native opt-in guidance was already supplied. */
  offerPendingForModeEntryId?: string;
  planningModeEntryId?: string;
  offeredForModeEntryId?: string;
  suppressedForModeEntryId?: string;
  pendingConsent?: { askToolCallId: string; modeEntryId: string };
  proposalAwaitingApproval?: boolean;
  approvalCompactionPending?: boolean;
  /** In-memory, single-use proof that this native compact approval may reset the host reference. */
  compactHandoffPending?: boolean;
  /** Shared pointer only; approval, attempts and proof are owned by AtlasStore. */
  atlasPlanId?: string;
  sourceSessionId?: string;
  ledgerPath?: string;
  ledgerError?: string;
  /** Never persisted: a pathname/session entry cannot grant execution ownership. */
  ownership?: Ownership;
  activation?: object;
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
  const atlasWidgets = new Map<string, boolean>();
  const childEvidence = new ChildEvidence();
  const stores = new Map<string, AtlasStore>();
  const ownerships = new Set<Ownership>();
  const liveModels = new Map<string, AtlasLive>();
  const herdrDag = new HerdrDagContract(pi.events);
  const roadmap = new RoadmapContract(pi.events);
  const WIDGET_KEY = "atlas";
  let stateWarned = false;
  const statePublisher = new PluginStatePublisher("omo-prometheus", (error) => {
    if (stateWarned) return;
    stateWarned = true;
    pi.logger.warn("prometheus could not write its plugin state file", { error: errorMessage(error) });
  });
  /** Last serialized sidecar state per session; an unpublished session counts as `null`. */
  const publishedStates = new Map<string, string>();
  let atlasPlans: AtlasCompletionPlan[] = [];
  let planReferences = new AtlasPlanReferences();
  const hostBindings = new WeakMap<AgentSession, { sessionId: string; planUrl: string; previousReference: string | undefined }>();
  let settlementTimer: NodeJS.Timeout | undefined;
  const evidenceSubscription = pi.events?.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (payload) => {
    childEvidence.observe(payload);
    // Wake turns reuse the original dispatch id; retain their exact jobs before history eviction.
    for (const ownership of ownerships) {
      try {
        observeNativeJobs(ownership.sessionId, ownership.live, ownership.parentAgentId);
      } catch (error) {
        pi.logger.warn("Atlas could not observe native child reactivation", { error: errorMessage(error) });
      }
    }
  });

  const loadReviewLevel = async (ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    let herdrDagEnabled = true;
    try {
      const settings = await getPluginSettings(PACKAGE_NAME, ctx.cwd);
      herdrDagEnabled = settings.herdrDag !== false;
      reviewLevels.set(sessionId, parseReviewLevel(settings.reviewLevel));
      atlasWidgets.set(sessionId, settings.atlasWidget !== false);
    } catch (error) {
      reviewLevels.set(sessionId, "ask");
      atlasWidgets.set(sessionId, true);
      pi.logger.warn("prometheus reviewLevel is invalid; using ask", { error: errorMessage(error) });
    } finally {
      if (mainSession(ctx)) herdrDag.configure(sessionId, herdrDagEnabled);
    }
  };

  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void => {
    try {
      ctx.ui.notify(message, type);
    } catch (error) {
      pi.logger.warn("prometheus could not display a notice", { error: errorMessage(error) });
    }
  };

  const commandNotice = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void => {
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

  /** Prometheus plans inside native plan mode; with plan.enabled off the host refuses /plan and xd://propose never exists. */
  const planModeDisabled = (live: AgentSession): boolean => !cfgPlanEnabled.get(live.settings);

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

  /**
   * The host appends another `plan` mode_change without leaving plan mode when it restores a resumed session
   * or retargets the plan file at approval, so an episode starts at the first `plan` entry after a non-plan one.
   */
  const planModeEpisodeId = (ctx: ExtensionContext): string | undefined => {
    const branch = ctx.sessionManager.getBranch();
    let episodeId: string | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "mode_change") continue;
      if (entry.mode !== "plan") break;
      episodeId = entry.id;
    }
    return episodeId;
  };

  const recordFor = (sessionId: string): SessionRecord => {
    const existing = records.get(sessionId);
    if (existing) return existing;
    const created: SessionRecord = { phase: "idle", lastBlockedAt: 0, stallCount: 0 };
    records.set(sessionId, created);
    return created;
  };

  const persist = (ctx: ExtensionContext, record: SessionRecord): void => {
    try {
      pi.appendEntry(STATE_ENTRY, {
        version: 3,
        phase: record.phase,
        planningModeEntryId: record.planningModeEntryId,
        planFilePath: record.planFilePath,
        planSha256: record.planSha256,
        proposedByToolCallId: record.proposedByToolCallId,
        atlasPlanId: record.atlasPlanId,
        sourceSessionId: record.sourceSessionId,
        roadmapStage: record.roadmapStage,
        offeredForModeEntryId: record.offeredForModeEntryId,
        suppressedForModeEntryId: record.suppressedForModeEntryId,
        ledgerPath: record.ledgerPath,
      });
    } catch (error) {
      pi.logger.warn("prometheus could not persist workflow state", { error: errorMessage(error) });
    }
    publishState(ctx);
  };

  /** Output-only sidecar for RPC/ACP/SDK clients, derived from the session record and the Herdr DAG snapshot. */
  const publishState = (ctx: ExtensionContext): void => {
    if (!mainSession(ctx)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const record = records.get(sessionId);
    const state = prometheusState({
      phase: record?.phase ?? "idle",
      proposalAwaitingApproval: record?.proposalAwaitingApproval,
      planFilePath: record?.planFilePath,
      atlasPlanId: record?.atlasPlanId,
      planName: record?.ownership?.plan.name,
      ledgerError: record?.ledgerError,
      snapshot: herdrDag.snapshot(sessionId),
    });
    const serialized = JSON.stringify(state);
    if ((publishedStates.get(sessionId) ?? "null") === serialized) return;
    publishedStates.set(sessionId, serialized);
    statePublisher.publish(sessionId, state);
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
            atlasPlanId?: unknown;
            sourceSessionId?: unknown;
            planFilePath?: unknown;
            planSha256?: unknown;
            planningModeEntryId?: unknown;
            proposedByToolCallId?: unknown;
            offeredForModeEntryId?: unknown;
            suppressedForModeEntryId?: unknown;
            ledgerPath?: unknown;
            roadmapStage?: unknown;
          }
        | undefined;
      if (data?.phase !== "idle" && data?.phase !== "planning" && data?.phase !== "executing") continue;
      restored = {
        phase: data.phase,
        atlasPlanId: typeof data.atlasPlanId === "string" && data.atlasPlanId ? data.atlasPlanId : undefined,
        sourceSessionId: typeof data.sourceSessionId === "string" && data.sourceSessionId ? data.sourceSessionId : undefined,
        roadmapStage: isRoadmapStage(data.roadmapStage) ? data.roadmapStage : undefined,
        planFilePath: typeof data.planFilePath === "string" && data.planFilePath.trim() ? data.planFilePath : undefined,
        planSha256: typeof data.planSha256 === "string" && /^[a-f0-9]{64}$/.test(data.planSha256) ? data.planSha256 : undefined,
        proposedByToolCallId:
          typeof data.proposedByToolCallId === "string" && data.proposedByToolCallId ? data.proposedByToolCallId : undefined,
        offeredForModeEntryId:
          typeof data.offeredForModeEntryId === "string" && data.offeredForModeEntryId ? data.offeredForModeEntryId : undefined,
        suppressedForModeEntryId:
          typeof data.suppressedForModeEntryId === "string" && data.suppressedForModeEntryId ? data.suppressedForModeEntryId : undefined,
        // The approval window lives only between one proposal and its overlay choice in this process. Older
        // entries persisted it; a reload, resume or branch must never revive it (e.g. after native "Save and quit").
        proposalAwaitingApproval: false,
        approvalCompactionPending: false,
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

  const ledgerSummary = (ledger: ExecutionLedger): string => {
    const proofs = ledgerRows(ledger).flatMap((row) =>
      row.receipt && row.status === "done"
        ? [
            `- ${row.id}: ${path.join(path.dirname(ledger.planFilePath), "evidence", `${row.receipt.receiptId}.md`)} (origin session ${row.receipt.sessionId}, child ${row.receipt.childAgentId})`,
          ]
        : [],
    );
    return `${renderLedgerSummary(ledger, availableAgents())}${proofs.length ? `\n\nShared verified outputs:\n${proofs.join("\n")}` : ""}`;
  };

  const localOptions = (ctx: ExtensionContext) => ({
    getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
    getSessionId: () => ctx.sessionManager.getSessionId(),
  });

  const clearProposalMarker = async (ctx: ExtensionContext, planFilePath: string | undefined): Promise<void> => {
    if (!planFilePath) return;
    try {
      await fs.rm(resolveLocalUrlToPath(prometheusArtifactUrl(planFilePath), localOptions(ctx)), { force: true });
    } catch (error) {
      pi.logger.warn("prometheus could not remove the proposal marker", { error: errorMessage(error) });
    }
  };

  const pauseMessage = (record: SessionRecord): string =>
    `Atlas execution paused: ${record.ledgerError ?? "the shared approved execution ledger is unavailable"}. No new task dispatch or completion is permitted. Restore the exact shared proof, or run /atlas exit and obtain fresh native approval. Existing artifacts are preserved; there is no prompt-only fallback.`;

  const storeFor = (ctx: ExtensionContext): AtlasStore => {
    if (typeof ctx.sessionManager.getSessionDir !== "function" || !ctx.sessionManager.getArtifactsDir()) {
      throw new Error("Atlas requires a file-backed session with a durable session directory");
    }
    const sessionDir = ctx.sessionManager.getSessionDir();
    if (!sessionDir) throw new Error("Atlas requires a durable session directory");
    const root = path.resolve(sessionDir);
    let store = stores.get(root);
    if (!store) {
      store = new AtlasStore(root);
      stores.set(root, store);
    }
    return store;
  };

  const clearObservation = (ctx: ExtensionContext, sessionId: string): void => {
    liveModels.get(sessionId)?.dispose();
    liveModels.delete(sessionId);
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  };

  const installObservation = async (ctx: ExtensionContext, store: AtlasStore, plan: AtlasPlan): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    clearObservation(ctx, sessionId);
    try {
      const detail = (await store.details(plan.cwd)).find((item) => item.plan.id === plan.id);
      if (!detail || detail.status.startsWith("Invalid")) return;
      const live = new AtlasLive(detail, childEvidence, {
        sessionId,
        events: pi.events,
        subscribeLedger: (listener) => store.subscribe(plan.id, listener),
        reload: async () => (await store.details(plan.cwd)).find((item) => item.plan.id === plan.id),
        warn: (error) => pi.logger.warn("Atlas live observation failed", { error: errorMessage(error) }),
      });
      liveModels.set(sessionId, live);
      herdrDag.bind(sessionId, plan);
      live.subscribe((snapshot) => {
        herdrDag.publish(sessionId, snapshot);
        if (ctx.sessionManager.getSessionId() === sessionId) publishState(ctx);
      });
      if (ctx.hasUI && atlasWidgets.get(sessionId) !== false) {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new AtlasStatusWidget(live, tui, theme), { placement: "aboveEditor" });
        } else if (ctx.mode === "rpc") {
          // RPC clients accept only string-array widgets; publish the latest snapshot at most twice a second.
          let latest = live.snapshot;
          let shown = "";
          let timer: NodeJS.Timeout | undefined;
          live.subscribe((snapshot) => {
            latest = snapshot;
            timer ??= setTimeout(() => {
              timer = undefined;
              if (liveModels.get(sessionId) !== live) return;
              const lines = atlasWidgetLines(latest);
              const text = lines.join("\n");
              if (text === shown) return;
              shown = text;
              ctx.ui.setWidget(WIDGET_KEY, lines);
            }, 500);
            timer.unref?.();
          });
        }
      }
    } catch (error) {
      pi.logger.warn("Atlas live observation could not start", { error: errorMessage(error) });
    }
  };

  const refreshAtlasCompletions = async (ctx: ExtensionContext): Promise<void> => {
    try {
      const cwd = await fs.realpath(ctx.cwd);
      atlasPlans = (await storeFor(ctx).details(cwd)).map(({ plan, unfinished }) => ({ id: plan.id, name: plan.name, unfinished }));
    } catch (error) {
      atlasPlans = [];
      pi.logger.warn("Atlas plan completions are unavailable", { error: errorMessage(error) });
    }
  };

  const observeNativeJobs = (sessionId: string, live: AgentSession, parentAgentId: string): void => {
    if (typeof live.getAsyncJobSnapshot !== "function") return;
    const manager = live.asyncJobManager;
    const native =
      typeof manager?.getAllJobs === "function"
        ? {
            ownerId: parentAgentId,
            jobs: manager.getAllJobs({ ownerId: parentAgentId }),
            onSettled: () => {
              void settleDetached();
            },
          }
        : undefined;
    childEvidence.observeAsyncJobs(sessionId, live.getAsyncJobSnapshot({ recentLimit: Number.MAX_SAFE_INTEGER }), native);
  };

  const settleDetached = async (): Promise<void> => {
    for (const ownership of ownerships) {
      if (!ownership.detached || ownership.operations > 0) continue;
      try {
        observeNativeJobs(ownership.sessionId, ownership.live, ownership.parentAgentId);
        if (childEvidence.hasPending(ownership.sessionId, ownership.ledgerId)) continue;
        ownership.releasing ??= ownership.store.release(ownership.plan.id, ownership.sessionId);
        await ownership.releasing;
        planReferences.unbind(ownership.sessionId, ownership.plan.id);
        ownerships.delete(ownership);
      } catch (error) {
        ownership.releasing = undefined;
        pi.logger.warn("Atlas could not settle detached plan ownership", { error: errorMessage(error) });
      }
    }
    if (![...ownerships].some((ownership) => ownership.detached) && settlementTimer) {
      clearInterval(settlementTimer);
      settlementTimer = undefined;
    }
  };

  const detach = (ownership: Ownership | undefined): void => {
    if (!ownership) return;
    ownership.detached = true;
    // Exit is immediate. This timer only observes native terminal results and releases locks.
    settlementTimer ??= setInterval(() => {
      void settleDetached();
    }, 250);
    settlementTimer.unref?.();
  };

  const observeFinalJobs = (ctx: ExtensionContext): void => {
    const parent = AgentRegistry.global()
      .list()
      .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager);
    if (parent?.session) observeNativeJobs(ctx.sessionManager.getSessionId(), parent.session, parent.id);
    void settleDetached();
  };

  const withExecutionLedger = async <T>(
    ctx: ExtensionContext,
    record: SessionRecord,
    run: (ledger: ExecutionLedger, plan: AtlasPlan, store: AtlasStore) => T | Promise<T>,
  ): Promise<T> => {
    const ownership = record.ownership;
    if (ownership) ownership.operations += 1;
    try {
      if (!record.atlasPlanId)
        throw new Error(record.ledgerError ?? "Legacy session-local execution is not migrated; fresh native reapproval is required");
      if (!ownership || ownership.detached || ownership.sessionId !== ctx.sessionManager.getSessionId()) {
        throw new Error("shared plan execution ownership is unavailable");
      }
      if (!planReferencesMatch(mainSession(ctx)?.getPlanReferencePath(), atlasPlanUrl(ownership.plan.id))) {
        throw new Error("the host plan reference differs from the approved Atlas plan");
      }
      if ((await fs.realpath(ctx.cwd)) !== ownership.plan.cwd) throw new Error("the approved plan belongs to a different workspace");
      let validatedLedger: ExecutionLedger | undefined;
      const result = await ownership.store.transaction(
        ownership.plan.id,
        ownership.sessionId,
        async (ledger, plan) => {
          refreshDispatchAgents(ledger, availableAgents());
          validatedLedger = ledger;
          record.ledgerError = undefined;
          return await run(ledger, plan, ownership.store);
        },
        {
          assertActive: () => {
            if (
              record.phase !== "executing" ||
              record.ownership !== ownership ||
              ownership.detached ||
              ctx.sessionManager.getSessionId() !== ownership.sessionId ||
              !planReferencesMatch(mainSession(ctx)?.getPlanReferencePath(), atlasPlanUrl(ownership.plan.id))
            )
              throw new Error("Atlas attachment changed before ledger publication");
          },
        },
      );
      if (validatedLedger && record.phase === "executing" && record.ownership === ownership && !ownership.detached)
        syncLedgerTodos(ctx, validatedLedger);
      return result;
    } catch (error) {
      if (record.ownership === ownership) record.ledgerError = errorMessage(error);
      publishState(ctx);
      throw error;
    } finally {
      if (ownership) ownership.operations -= 1;
      void settleDetached();
    }
  };

  const readLedger = async (ctx: ExtensionContext, record: SessionRecord): Promise<ExecutionLedger | undefined> => {
    try {
      return await withExecutionLedger(ctx, record, (ledger) => ledger);
    } catch (error) {
      pi.logger.warn("Atlas shared execution ledger is unavailable", { error: errorMessage(error) });
      return undefined;
    }
  };

  const syncLedgerTodos = (ctx: ExtensionContext, ledger: ExecutionLedger): void => {
    const live = mainSession(ctx);
    if (!live) return;
    try {
      syncAtlasTodos(live, live.sessionManager, ledger);
    } catch (error) {
      pi.logger.warn("Atlas could not persist session todo phases", { error: errorMessage(error) });
    }
  };

  const bindPlan = async (
    ctx: ExtensionContext,
    record: SessionRecord,
    store: AtlasStore,
    plan: AtlasPlan,
    resume: boolean,
    expectedReference?: string,
  ): Promise<void> => {
    const live = mainSession(ctx);
    const activation = record.activation;
    if (!live || typeof live.setPlanReferencePath !== "function")
      throw new Error("this host cannot bind the approved Atlas plan reference");
    if ((await fs.realpath(ctx.cwd)) !== plan.cwd) throw new Error("the approved plan belongs to a different workspace");
    const sessionId = ctx.sessionManager.getSessionId();
    await settleDetached();
    let ownership = [...ownerships].find(
      (candidate) => candidate.store === store && candidate.plan.id === plan.id && candidate.sessionId === sessionId,
    );
    if (ownership?.detached) throw new Error("this plan still has detached native work; wait for its final outcomes before entering again");
    const newlyOwned = !ownership;
    if (ownership) ownership.operations += 1;
    let acquired = false;
    try {
      await store.acquire(plan.id, sessionId);
      acquired = true;
      if (record.phase !== "executing" || record.activation !== activation)
        throw new Error("Atlas attachment changed during ownership acquisition");
      let validatedLedger: ExecutionLedger | undefined;
      const ledgerId = await store.transaction(
        plan.id,
        sessionId,
        (ledger) => {
          if (record.phase !== "executing" || record.activation !== activation)
            throw new Error("Atlas attachment changed during plan validation");
          refreshDispatchAgents(ledger, availableAgents());
          validatedLedger = ledger;
          return ledger.ledgerId;
        },
        { resume: resume && newlyOwned },
      );
      if (record.phase !== "executing" || record.activation !== activation)
        throw new Error("Atlas attachment changed during plan validation");
      const parent = AgentRegistry.global()
        .list()
        .find((candidate) => candidate.kind === "main" && candidate.session === live);
      if (!parent) throw new Error("registered native parent identity is unavailable");
      ownership ??= { store, plan, sessionId, live, parentAgentId: parent.id, ledgerId, detached: false, operations: 0 };
      ownerships.add(ownership);
      if (newlyOwned) ownership.operations += 1;
      record.ownership = ownership;
      if (expectedReference && !planReferencesMatch(live.getPlanReferencePath(), expectedReference))
        throw new Error("the native approval handoff reference changed during validation");
      planReferences = AtlasPlanReferences.current(planReferences);
      await planReferences.bind(sessionId, plan);
      if (record.phase !== "executing" || record.activation !== activation)
        throw new Error("Atlas attachment changed during plan reference binding");
      const previousReference = live.getPlanReferencePath();
      const planUrl = atlasPlanUrl(plan.id);
      live.setPlanReferencePath(planUrl);
      if (!planReferencesMatch(live.getPlanReferencePath(), planUrl)) throw new Error("the host did not bind the approved Atlas plan");
      hostBindings.set(live, { sessionId, planUrl, previousReference });
      record.atlasPlanId = plan.id;
      record.planFilePath = plan.planFilePath;
      record.planSha256 = plan.planSha256;
      record.ledgerPath = plan.ledgerPath;
      record.proposedByToolCallId = plan.proposedByToolCallId;
      record.sourceSessionId = plan.sourceSessionId;
      record.roadmapStage = plan.roadmapStage;
      record.ledgerError = undefined;
      persist(ctx, record);
      if (validatedLedger) syncLedgerTodos(ctx, validatedLedger);
      await installObservation(ctx, store, plan);
    } catch (error) {
      const binding = hostBindings.get(live);
      if (binding?.sessionId === sessionId && binding.planUrl === atlasPlanUrl(plan.id)) {
        if (planReferencesMatch(live.getPlanReferencePath(), binding.planUrl))
          live.setPlanReferencePath(binding.previousReference?.startsWith("local://") ? binding.previousReference : DEFAULT_PLAN_REFERENCE);
        hostBindings.delete(live);
      }
      if (newlyOwned && acquired) {
        if (ownership) ownerships.delete(ownership);
        if (record.ownership === ownership) record.ownership = undefined;
        planReferences.unbind(sessionId, plan.id);
        await store.release(plan.id, sessionId);
      } else if (ownership) {
        detach(ownership);
      }
      throw error;
    } finally {
      if (ownership) ownership.operations -= 1;
      void settleDetached();
    }
  };

  const resumeLedger = async (ctx: ExtensionContext, record: SessionRecord | undefined, previousReference?: string): Promise<void> => {
    if (record?.phase !== "executing") return;
    record.activation = {};
    try {
      if (!record.atlasPlanId)
        throw new Error("Legacy session-local progress is not migrated; fresh native reapproval is required. Run /atlas exit");
      const store = storeFor(ctx);
      const plan = await store.find(record.atlasPlanId);
      if (
        record.planSha256 !== plan.planSha256 ||
        record.proposedByToolCallId !== plan.proposedByToolCallId ||
        record.sourceSessionId !== plan.sourceSessionId
      ) {
        throw new Error("the session pointer does not match the shared approval provenance");
      }
      const reference = mainSession(ctx)?.getPlanReferencePath();
      if (
        reference &&
        !planReferencesMatch(reference, DEFAULT_PLAN_REFERENCE) &&
        !planReferencesMatch(reference, atlasPlanUrl(plan.id)) &&
        !planReferencesMatch(reference, plan.planFilePath) &&
        !planReferencesMatch(reference, previousReference)
      ) {
        throw new Error("the host plan reference differs from the persisted approved Atlas plan");
      }
      await bindPlan(ctx, record, store, plan, true);
    } catch (error) {
      record.ledgerError = errorMessage(error);
      publishState(ctx);
      notify(ctx, pauseMessage(record), "error");
    }
  };

  const release = async (ctx: ExtensionContext, reason: string, expected: "planning" | "executing"): Promise<void> => {
    const live = mainSession(ctx);
    if (!live) return;
    restoreApprovalTiers(live);
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase !== expected) return;
    const proposalPath = expected === "planning" ? record.planFilePath : undefined;
    const binding = hostBindings.get(live);
    if (
      expected === "executing" &&
      binding?.sessionId === ctx.sessionManager.getSessionId() &&
      planReferencesMatch(live.getPlanReferencePath(), binding.planUrl)
    ) {
      live.setPlanReferencePath(binding.previousReference?.startsWith("local://") ? binding.previousReference : DEFAULT_PLAN_REFERENCE);
    }
    const ownership = record.ownership;
    const episodeId = planModeEpisodeId(ctx);
    authorizedActivationCalls.clear();
    // Invalidate in-flight publication synchronously, before any file or UI operation.
    record.phase = "idle";
    if (expected === "executing") herdrDag.release(ctx.sessionManager.getSessionId(), "exit");
    clearObservation(ctx, ctx.sessionManager.getSessionId());
    record.ownership = undefined;
    record.activation = undefined;
    detach(ownership);
    record.planFilePath = undefined;
    record.planSha256 = undefined;
    record.atlasPlanId = undefined;
    record.sourceSessionId = undefined;
    record.roadmapStage = undefined;
    record.ledgerError = undefined;
    record.proposedByToolCallId = undefined;
    record.offeredForModeEntryId = episodeId;
    record.suppressedForModeEntryId = episodeId;
    record.pendingConsent = undefined;
    record.proposalAwaitingApproval = false;
    record.approvalCompactionPending = false;
    record.compactHandoffPending = false;
    record.planningModeEntryId = undefined;
    record.offerPendingForModeEntryId = undefined;
    record.ledgerPath = undefined;
    record.lastContinuationLedgerStamp = undefined;
    record.stallCount = 0;
    persist(ctx, record);
    await syncTools(false, false, false);
    if (proposalPath) await clearProposalMarker(ctx, proposalPath);
    await settleDetached();
    await refreshAtlasCompletions(ctx);
    commandNotice(
      ctx,
      expected === "executing"
        ? `Atlas exited (${reason}). Shared progress is preserved. Native children have not been cancelled; any unfinished native work retains its plan ownership until final outcomes.`
        : `Prometheus planning exited (${reason}).`,
    );
  };

  const atlasCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const command = parseAtlasSubcommand(args);
    const live = mainSession(ctx);
    if (!live) {
      commandNotice(ctx, "Atlas requires the registered main session.", "error");
      return;
    }
    const current = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (current?.phase === "executing") {
      if (command.kind === "exit") {
        await exitAtlas(ctx, current);
        return;
      }
      const activePlan = current.ownership?.plan.name ?? current.atlasPlanId ?? "the current plan";
      if (command.kind !== "menu") {
        commandNotice(
          ctx,
          `Already in an Atlas session for ${activePlan}. Switching plans is not allowed; run /atlas exit first, then /atlas ${args.trim()}.`,
          "error",
        );
        return;
      }
      await showActivePlan(ctx, current);
      return;
    }
    if (command.kind === "exit") {
      commandNotice(ctx, "Atlas is not active; there is nothing to exit.");
      return;
    }
    if (command.kind === "usage") {
      commandNotice(ctx, command.message, "error");
      return;
    }
    if (command.kind === "enter" || command.kind === "start") {
      await enterPlan(ctx, command.selector, true);
      return;
    }
    let store: AtlasStore;
    try {
      store = storeFor(ctx);
    } catch (error) {
      commandNotice(ctx, `Atlas entry refused: ${errorMessage(error)}`, "error");
      return;
    }
    try {
      if (command.kind === "menu") {
        if (!ctx.hasUI) {
          const details = await store.details(await fs.realpath(ctx.cwd));
          commandNotice(
            ctx,
            `Atlas is inactive. Use /atlas <plan-name-or-id> to enter an approved plan.\n${ATLAS_USAGE}\n${atlasPlanList(details)}`,
          );
        } else if (ctx.mode === "tui") {
          await dispatchMenu(ctx, store);
        } else {
          await selectDispatchMenu(ctx, store);
        }
      } else if (command.kind === "list") {
        await showText(ctx, "Atlas plans", atlasPlanList(await store.details(await fs.realpath(ctx.cwd))));
      } else if (command.kind === "show") {
        const target = await planDetail(ctx, store, command.selector);
        if (ctx.mode === "tui") await openPlanView(ctx, target, "display");
        else await showText(ctx, `Atlas plan ${target.plan.name}`, atlasPlanText(target));
      } else if (command.kind === "resume") {
        await resumeCommand(ctx, await planDetail(ctx, store, command.selector));
      } else if (command.kind === "rename") {
        await store.rename(command.planId, command.name);
        commandNotice(ctx, `Atlas plan ${command.planId} renamed to ${command.name}.`);
      } else if (command.confirmed || (ctx.hasUI && (await confirmDelete(ctx, (await store.find(command.planId)).name, command.planId)))) {
        await deletePlan(store, command.planId);
        commandNotice(ctx, `Atlas plan ${command.planId} deleted with its evidence.`);
      } else {
        commandNotice(
          ctx,
          ctx.hasUI
            ? "Atlas plan deletion cancelled."
            : `Deleting an Atlas plan is permanent; run /atlas delete ${command.planId} --yes to confirm.`,
          ctx.hasUI ? "info" : "error",
        );
      }
    } catch (error) {
      commandNotice(ctx, `Atlas command refused: ${errorMessage(error)}`, "error");
    } finally {
      await refreshAtlasCompletions(ctx);
    }
  };

  /** Read-only text: an editor dialog when a client can show one, otherwise a transcript message. */
  const showText = async (ctx: ExtensionContext, title: string, text: string): Promise<void> => {
    if (ctx.hasUI) await ctx.ui.editor(`${title} (read-only)`, text);
    else commandNotice(ctx, text);
  };

  const planDetail = async (ctx: ExtensionContext, store: AtlasStore, selector: string): Promise<AtlasPlanDetail> => {
    const plan = await store.find(selector);
    const detail = (await store.details(await fs.realpath(ctx.cwd))).find((item) => item.plan.id === plan.id);
    if (!detail) throw new Error(`Atlas plan ${plan.id} disappeared from the shared store`);
    return detail;
  };

  const confirmDelete = (ctx: ExtensionContext, name: string, planId: string): Promise<boolean> =>
    ctx.ui.confirm("Delete Atlas plan?", `Permanently remove ${name} (${planId}) and all its evidence?`);

  const deletePlan = (store: AtlasStore, planId: string): Promise<void> =>
    store.delete(
      planId,
      () =>
        [...ownerships].some((ownership) => ownership.store === store && ownership.plan.id === planId) ||
        [...records.values()].some((record) => record.phase === "executing" && record.atlasPlanId === planId),
    );

  /** Same refusals as the dispatch menu, worded for a command line. */
  const resumeRefusal = (target: AtlasPlanDetail): string | undefined =>
    target.started ? dispatchBlock(target, "resume", false) : `Cannot resume ${target.plan.name}: it has not started yet; start it instead`;

  /** `/atlas resume`: dialogs may pick a session; without them only the current session can resume. */
  const resumeCommand = async (ctx: ExtensionContext, target: AtlasPlanDetail): Promise<void> => {
    const blocked = resumeRefusal(target);
    if (blocked) {
      commandNotice(ctx, blocked, "error");
      return;
    }
    if (!ctx.hasUI) {
      const sessionDir = ctx.sessionManager.getSessionDir();
      const sessions = sessionDir ? await findPlanSessions(sessionDir, STATE_ENTRY, target.plan.id) : [];
      const only = sessions.length === 1 ? sessions[0] : undefined;
      if (only?.id !== ctx.sessionManager.getSessionId()) {
        commandNotice(
          ctx,
          sessions.length
            ? `Resuming ${target.plan.name} needs a session choice, which requires an interactive client. Open the session to resume and run /atlas resume ${target.plan.id} there:\n${sessions.map((session) => `- ${session.id} ${formatTime(session.modified)} ${session.path}`).join("\n")}`
            : `Cannot resume: no session in this project has executed ${target.plan.name}; run /atlas start ${target.plan.id}.`,
          "error",
        );
        return;
      }
    }
    const refusal = await resumePlan(ctx, target);
    if (refusal) commandNotice(ctx, refusal, "error");
  };

  const openPlanView = async (ctx: ExtensionContext, detail: AtlasPlanDetail, mode: AtlasPlanViewMode): Promise<AtlasPlanViewAction> => {
    let view: AtlasPlanView | undefined;
    try {
      return await ctx.ui.custom<AtlasPlanViewAction>(
        (tui, theme, _keys, done) => {
          view = new AtlasPlanView(
            detail,
            mode,
            theme,
            tui,
            (file) => fs.readFile(file, "utf8"),
            done,
            mode === "active" ? liveModels.get(ctx.sessionManager.getSessionId()) : undefined,
          );
          return view;
        },
        { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } },
      );
    } finally {
      view?.dispose();
    }
  };

  /** Exits right away when every row is done; otherwise asks first. Shared progress is always kept. */
  const exitAtlas = async (ctx: ExtensionContext, record: SessionRecord): Promise<void> => {
    const activePlan = record.ownership?.plan.name ?? record.atlasPlanId ?? "the current plan";
    if (ctx.hasUI) {
      // Exit must never wait on the ledger lock (an evidence capture may hold it), so this
      // advisory count reads the last published ledger directly and authorizes nothing.
      let remaining: number | undefined;
      try {
        const snapshot: unknown = JSON.parse(await fs.readFile(record.ledgerPath ?? "", "utf8"));
        const rows =
          snapshot && typeof snapshot === "object" && "items" in snapshot && "gates" in snapshot
            ? [snapshot.items, "fixes" in snapshot ? snapshot.fixes : [], snapshot.gates].flatMap((list) =>
                Array.isArray(list) ? list : [],
              )
            : [];
        if (rows.length) remaining = rows.filter((row) => row?.status !== "done" || !row.receipt).length;
      } catch {
        remaining = undefined;
      }
      if (remaining !== 0) {
        const confirmed = await ctx.ui.confirm(
          "Exit Atlas early?",
          remaining === undefined
            ? `${activePlan} progress cannot be verified. Exit Atlas anyway? Shared progress is kept.`
            : `${activePlan} still has ${remaining} unfinished item(s). Exit Atlas anyway? Shared progress is kept and you can resume later.`,
        );
        if (!confirmed) {
          commandNotice(ctx, "Atlas exit cancelled; Atlas stays active.");
          return;
        }
      }
    }
    await release(ctx, "/atlas", "executing");
  };

  /** Read-only view of the plan this session executes; the only action it offers is exit. */
  const showActivePlan = async (ctx: ExtensionContext, record: SessionRecord): Promise<void> => {
    let detail: AtlasPlanDetail | undefined;
    try {
      detail = (await storeFor(ctx).details(await fs.realpath(ctx.cwd))).find((item) => item.plan.id === record.atlasPlanId);
    } catch (error) {
      commandNotice(ctx, `Atlas plan details are unavailable: ${errorMessage(error)}. Run /atlas exit to leave Atlas.`, "error");
      return;
    }
    if (!detail) {
      commandNotice(
        ctx,
        `Atlas plan ${record.atlasPlanId ?? "(unknown)"} is not in the shared store. Run /atlas exit to leave Atlas.`,
        "error",
      );
      return;
    }
    if (ctx.mode === "tui") {
      if ((await openPlanView(ctx, detail, "active")) === "exit") await exitAtlas(ctx, record);
      return;
    }
    if (!ctx.hasUI) {
      commandNotice(ctx, `Atlas is executing ${detail.plan.name}. Run /atlas exit to leave it.\n\n${atlasPlanText(detail)}`);
      return;
    }
    const keep = "Keep Atlas running";
    const view = "View plan details";
    const exit = "Exit Atlas";
    const running = detail.rows.filter((row) => row.status === "in_progress").map((row) => `${row.id} ${row.title} (${row.agent})`);
    const summary = [`Atlas is executing ${detail.plan.name} (${detail.plan.id})`, detail.status, ...running].join("\n");
    while (true) {
      const choice = await ctx.ui.select(summary, [keep, view, exit]);
      if (choice === view) {
        await ctx.ui.editor(`Atlas plan ${detail.plan.name} (read-only)`, atlasPlanText(detail));
        continue;
      }
      if (choice === exit) await exitAtlas(ctx, record);
      return;
    }
  };

  const planningBlocks = (ctx: ExtensionContext): boolean => {
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (record?.phase !== "planning" && mainSession(ctx)?.getPlanModeState()?.enabled !== true) return false;
    commandNotice(ctx, "Atlas cannot enter during planning. Exit planning first; Atlas only executes plans with native approval.", "error");
    return true;
  };

  /** Runs in the background so a failed title never affects Atlas. */
  const retitleSession = (ctx: ExtensionContext, plan: AtlasPlan, content?: string): void => {
    const live = mainSession(ctx);
    if (!live) return;
    void (async () =>
      retitleForAtlas(live, { name: plan.name, content: content ?? (await fs.readFile(plan.planFilePath, "utf8")) }))().catch((error) =>
      pi.logger.warn("prometheus could not retitle the Atlas session", { error: errorMessage(error) }),
    );
  };

  /** Binds the plan to the current session; `autoStart` then kicks off execution like native plan approval does. */
  const enterPlan = async (ctx: ExtensionContext, selector: string, autoStart: boolean): Promise<void> => {
    const live = mainSession(ctx);
    if (!live) {
      commandNotice(ctx, "Atlas requires the registered main session.", "error");
      return;
    }
    if (planningBlocks(ctx)) return;
    const activation = {};
    const record = recordFor(ctx.sessionManager.getSessionId());
    record.phase = "executing";
    record.activation = activation;
    persist(ctx, record);
    try {
      const store = storeFor(ctx);
      const plan = await store.find(selector);
      if (record.phase !== "executing" || record.activation !== activation) throw new Error("Atlas entry changed during plan selection");
      record.atlasPlanId = plan.id;
      record.planSha256 = plan.planSha256;
      record.proposedByToolCallId = plan.proposedByToolCallId;
      record.sourceSessionId = plan.sourceSessionId;
      record.roadmapStage = plan.roadmapStage;
      persist(ctx, record);
      await bindPlan(ctx, record, store, plan, true);
      await syncTools(false, true, true);
      retitleSession(ctx, plan);
      let modelNotice = "";
      try {
        const model = await applyAtlasModel(live);
        if (model) modelNotice = ` Switched to the atlas model role (${model}).`;
      } catch (error) {
        modelNotice = ` The atlas model role could not be applied (${errorMessage(error)}); the current model is kept.`;
      }
      commandNotice(
        ctx,
        `Atlas entered ${plan.name} (${plan.id}). Shared completed rows and evidence are retained. /atlas shows the plan; /atlas exit leaves Atlas.${modelNotice}`,
      );
      await refreshAtlasCompletions(ctx);
      if (autoStart) {
        pi.sendMessage(
          {
            customType: ATLAS_START_TYPE,
            content: `Execute the approved plan ${plan.name} (${plan.id}) now. Check \`${LEDGER_TOOL}\` status, then dispatch every ready row to its assigned agent.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch (error) {
      if (record.activation !== activation) return;
      record.ledgerError = errorMessage(error);
      publishState(ctx);
      await syncTools(false, true, true);
      await refreshAtlasCompletions(ctx);
      commandNotice(ctx, pauseMessage(record), "error");
    }
  };

  const isCommandContext = (ctx: ExtensionContext): ctx is ExtensionCommandContext =>
    "newSession" in ctx && typeof ctx.newSession === "function" && "switchSession" in ctx && typeof ctx.switchSession === "function";

  const hasConversation = (ctx: ExtensionContext): boolean =>
    ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));

  /** Returns false when the user backed out, so the dispatch menu reopens. */
  const startPlan = async (ctx: ExtensionContext, target: AtlasPlanDetail): Promise<boolean> => {
    if (hasConversation(ctx)) {
      const fresh = "Start in a new session";
      const here = "Start in this session";
      const choice = await ctx.ui.select(`This session already has a conversation. Where should Atlas run ${target.plan.name}?`, [
        ...(isCommandContext(ctx) ? [fresh] : []),
        here,
        "Cancel",
      ]);
      if (choice !== fresh && choice !== here) return false;
      if (choice === fresh && isCommandContext(ctx) && (await ctx.newSession()).cancelled) {
        commandNotice(ctx, "A new session could not be started; Atlas did not start.", "warning");
        return true;
      }
    }
    await enterPlan(ctx, target.plan.id, true);
    return true;
  };

  /** Returns a refusal to show in the menu, or undefined once the plan is resumed (or the user backed out). */
  const resumePlan = async (ctx: ExtensionContext, target: AtlasPlanDetail): Promise<string | undefined | false> => {
    const live = mainSession(ctx);
    if (!live) return "Atlas requires the registered main session";
    const here = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (here?.phase === "planning" || live.getPlanModeState()?.enabled === true)
      return "Cannot resume during planning; exit planning first";
    const sessionDir = ctx.sessionManager.getSessionDir();
    const sessions = sessionDir ? await findPlanSessions(sessionDir, STATE_ENTRY, target.plan.id) : [];
    if (!sessions.length) return `Cannot resume: no session in this project has executed ${target.plan.name}; press Enter to start it`;
    const currentId = ctx.sessionManager.getSessionId();
    let session = sessions[0];
    if (sessions.length > 1) {
      const labels = sessions.map(
        (candidate) =>
          `${formatTime(candidate.modified)}  ${candidate.title.slice(0, 60) || "Untitled session"}  ${candidate.id.slice(0, 8)}${candidate.id === currentId ? "  (this session)" : ""}`,
      );
      const choice = await ctx.ui.select(`Resume ${target.plan.name} in which session? Most recent first.`, labels);
      if (choice === undefined) return false;
      session = sessions[labels.indexOf(choice)];
    }
    if (!session) return false;
    if (session.id !== currentId) {
      if (!isCommandContext(ctx)) return "Cannot resume from here: switching sessions needs the /atlas command";
      // The host keeps the plan reference across a switch; drop this idle session's stale one so the target can rebind.
      live.setPlanReferencePath(DEFAULT_PLAN_REFERENCE);
      if ((await ctx.switchSession(session.path)).cancelled) return "Session switch was cancelled";
      const restored = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      if (restored?.phase === "executing") {
        if (restored.atlasPlanId !== target.plan.id) {
          commandNotice(
            ctx,
            `This session is executing another Atlas plan (${restored.atlasPlanId ?? "unknown"}). Run /atlas exit first.`,
            "error",
          );
        } else if (!restored.ledgerError) {
          retitleSession(ctx, target.plan);
          commandNotice(ctx, `Atlas resumed ${target.plan.name} in this session. Send a message to continue; /atlas exit leaves Atlas.`);
        }
        return undefined;
      }
    }
    await enterPlan(ctx, target.plan.id, false);
    return undefined;
  };

  /** Start, resume, delete or rename one plan; `done` closes the dispatch flow, `message` is a refusal to show. */
  const runPlanAction = async (
    ctx: ExtensionContext,
    store: AtlasStore,
    target: AtlasPlanDetail,
    kind: "start" | "resume" | "delete" | "rename",
  ): Promise<{ done: boolean; message?: string }> => {
    try {
      if (kind === "start") {
        if (await startPlan(ctx, target)) return { done: true };
      } else if (kind === "resume") {
        const refusal = await resumePlan(ctx, target);
        if (refusal === undefined) return { done: true };
        if (refusal) return { done: false, message: refusal };
      } else if (kind === "delete") {
        if (await confirmDelete(ctx, target.plan.name, target.plan.id)) await deletePlan(store, target.plan.id);
      } else {
        const name = await ctx.ui.input("Rename Atlas plan", target.plan.name);
        if (name !== undefined) await store.rename(target.plan.id, name);
      }
    } catch (error) {
      return { done: false, message: `Atlas plan change refused: ${errorMessage(error)}` };
    }
    return { done: false };
  };

  const dispatchMenu = async (ctx: ExtensionContext, store: AtlasStore): Promise<void> => {
    let filter: AtlasFilter = "unfinished";
    let query = "";
    let selectedId: string | undefined;
    let message: string | undefined;
    while (true) {
      const workspace = await fs.realpath(ctx.cwd);
      const details = await store.details(workspace);
      const options = { selectedId, message };
      const action = await ctx.ui.custom<AtlasMenuAction>(
        (tui, theme, _keys, done) => new AtlasMenu(details, filter, query, theme, tui, done, options),
      );
      filter = action.filter;
      query = action.query;
      selectedId = action.planId ?? selectedId;
      message = undefined;
      if (action.kind === "cancel") return;
      const target = details.find((detail) => detail.plan.id === action.planId);
      if (!target) continue;
      let kind = action.kind;
      if (kind === "inspect") {
        const next = await openPlanView(ctx, target, action.filter === "all" ? "display" : "dispatch");
        if (next === "back" || next === "exit") continue;
        kind = next;
      }
      const outcome = await runPlanAction(ctx, store, target, kind);
      if (outcome.done) return;
      message = outcome.message;
    }
  };

  /** The dispatch menu composed from select/confirm/input/editor for clients without terminal components (RPC, ACP). */
  const selectDispatchMenu = async (ctx: ExtensionContext, store: AtlasStore): Promise<void> => {
    const actions = {
      start: "Start",
      resume: "Resume",
      view: "View details",
      rename: "Rename",
      delete: "Delete",
      back: "Back",
    } as const;
    let filter: AtlasFilter = "unfinished";
    let message: string | undefined;
    while (true) {
      const details = (await store.details(await fs.realpath(ctx.cwd))).filter((detail) => filter === "all" || detail.unfinished);
      const labels = details.map(({ plan, status }) => `${plan.name} — ${status} (${plan.id})`);
      const toggle = filter === "unfinished" ? "Show all plans (display only)" : "Show unfinished plans";
      const close = "Close";
      const heading =
        filter === "all"
          ? "All plans; display only. Show unfinished plans to start or resume."
          : details.length
            ? "Unfinished plans"
            : "No unfinished plans";
      const choice = await ctx.ui.select([`Atlas Dispatch: ${heading}`, message].filter(Boolean).join("\n"), [...labels, toggle, close]);
      message = undefined;
      if (choice === undefined || choice === close) return;
      if (choice === toggle) {
        filter = filter === "unfinished" ? "all" : "unfinished";
        continue;
      }
      const target = details[labels.indexOf(choice)];
      if (!target) continue;
      const offered =
        filter === "all"
          ? [actions.view, actions.rename, actions.delete, actions.back]
          : [actions.start, actions.resume, actions.view, actions.rename, actions.delete, actions.back];
      let note: string | undefined;
      while (true) {
        const picked = await ctx.ui.select(
          [`${target.plan.name} (${target.plan.id})`, target.status, note].filter(Boolean).join("\n"),
          offered,
        );
        note = undefined;
        if (picked === undefined || picked === actions.back) break;
        if (picked === actions.view) {
          await ctx.ui.editor(`Atlas plan ${target.plan.name} (read-only)`, atlasPlanText(target));
          continue;
        }
        const kind =
          picked === actions.start ? "start" : picked === actions.resume ? "resume" : picked === actions.rename ? "rename" : "delete";
        const blocked = kind === "start" ? dispatchBlock(target, "start", false) : kind === "resume" ? resumeRefusal(target) : undefined;
        if (blocked) {
          note = blocked;
          continue;
        }
        const outcome = await runPlanAction(ctx, store, target, kind);
        if (outcome.done) return;
        message = outcome.message;
        break;
      }
    }
  };

  const activate = async (ctx: ExtensionContext): Promise<boolean> => {
    if (!mainSession(ctx)) {
      notify(ctx, "Prometheus runs in the main session only.", "warning");
      return false;
    }
    try {
      loadRequiredPromptAssets();
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus refused activation without prompt assets", { error: detail });
      notify(ctx, `Prometheus could not load its prompt assets (${detail}); activation was refused.`, "error");
      return false;
    }
    const record = recordFor(ctx.sessionManager.getSessionId());
    if (record.phase === "executing") {
      notify(ctx, "Atlas is active. Run /atlas exit before entering Prometheus planning.", "error");
      return false;
    }
    if (record.phase !== "planning") {
      record.phase = "planning";
      record.planFilePath = undefined;
      record.planSha256 = undefined;
      record.atlasPlanId = undefined;
      record.sourceSessionId = undefined;
      record.roadmapStage = undefined;
      record.ledgerError = undefined;
      record.proposedByToolCallId = undefined;
      record.offeredForModeEntryId = undefined;
      record.suppressedForModeEntryId = undefined;
      record.pendingConsent = undefined;
      record.proposalAwaitingApproval = false;
      record.approvalCompactionPending = false;
      record.compactHandoffPending = false;
      record.offerPendingForModeEntryId = undefined;
      record.planningModeEntryId = planModeEpisodeId(ctx);
      record.ledgerPath = undefined;
      record.lastContinuationLedgerStamp = undefined;
      record.stallCount = 0;
    }
    persist(ctx, record);
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

  const provenanceBlockReason = (toolName: string, roadmapToolSourcePath?: string): string | undefined => {
    const provenance = toolProvenance(toolName);
    const trustedPrometheusTool =
      PLUGIN_OWNED_TOOLS[toolName] === true && provenance?.source === "extension" && provenance.path === RUNTIME_SOURCE_PATH;
    return executionToolSourceBlockReason(toolName, provenance?.source, trustedPrometheusTool, roadmapToolSourcePath, provenance?.path);
  };

  /** Refuses a Prometheus proposal Atlas could not execute, before the native approval overlay opens. */
  const proposalGrammarBlockReason = async (ctx: ExtensionContext, input: unknown): Promise<string | undefined> => {
    const planUrl = proposedPlanUrl(input);
    if (!planUrl) return undefined;
    let content: string;
    try {
      content = await fs.readFile(resolveLocalUrlToPath(planUrl, localOptions(ctx)), "utf8");
    } catch {
      // The host resolves the plan itself and reports a missing file.
      return undefined;
    }
    const { errors } = parsePlanChecklist(content, availableAgents());
    if (!errors.length) return undefined;
    return `Prometheus refused this proposal: ${planUrl} does not follow the plan grammar Atlas executes (${errors.join("; ")}). Rewrite it with \`## Tasks\` (sequential T rows with Agent, Depends on and Acceptance) and \`## Final gates\` (exactly F1–F4 with their required titles), then propose again.`;
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
      return `${PLANNING_PREAMBLE}\n\n${agentBlock}\n${guidance}\n\n${reviewPolicy}\n\n${loadPromptAsset(SKILL_ASSET)}`;
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
      return `${header}\n\n${loadPromptAsset(ATLAS_ASSET)}`;
    } catch (error) {
      const detail = errorMessage(error);
      pi.logger.warn("prometheus Atlas asset became unavailable", { error: detail });
      notify(ctx, `Prometheus could not load the Atlas asset (${detail}); the execution guard remains active.`, "error");
      return header;
    }
  };

  const enterExecution = async (ctx: ExtensionContext, record: SessionRecord, handoff?: string): Promise<void> => {
    if (record.phase !== "planning") return;
    const { planFilePath: sourcePlanPath, planSha256, sourceSessionId, proposedByToolCallId } = record;
    record.phase = "executing";
    const activation = {};
    record.activation = activation;
    record.pendingConsent = undefined;
    record.proposalAwaitingApproval = false;
    record.approvalCompactionPending = false;
    record.offeredForModeEntryId = undefined;
    record.offerPendingForModeEntryId = undefined;
    record.planningModeEntryId = undefined;
    record.lastContinuationLedgerStamp = undefined;
    record.stallCount = 0;
    persist(ctx, record);
    try {
      const live = mainSession(ctx);
      if (!sourcePlanPath?.startsWith("local://") || !sourceSessionId || !proposedByToolCallId || !planSha256) {
        throw new Error("Legacy or incomplete proposal provenance requires fresh native reapproval; existing artifacts are preserved");
      }
      if (!live || live.getPlanModeState()?.enabled === true || !planReferencesMatch(live.getPlanReferencePath(), sourcePlanPath)) {
        throw new Error("the native approved plan reference is unavailable or changed");
      }
      const content = await fs.readFile(resolveLocalUrlToPath(sourcePlanPath, localOptions(ctx)), "utf8");
      if (planDigest(content) !== planSha256 || (handoff !== undefined && !inlinesApprovedPlan(handoff, sourcePlanPath, content))) {
        throw new Error("the approved plan differs from the exact native proposal");
      }
      if (record.phase !== "executing" || record.activation !== activation) throw new Error("Atlas exited before shared approval storage");
      const store = storeFor(ctx);
      const plan = await store.create({
        name: path.posix.basename(sourcePlanPath).replace(/(?:-plan)?\.md$/, ""),
        content,
        cwd: await fs.realpath(ctx.cwd),
        sourcePlanPath,
        sourceSessionId,
        proposedByToolCallId,
        availableAgents: availableAgents(),
        roadmapStage: record.roadmapStage,
      });
      if (record.phase !== "executing" || record.activation !== activation)
        throw new Error("Atlas exited while the approved plan was being stored");
      record.atlasPlanId = plan.id;
      persist(ctx, record);
      await bindPlan(ctx, record, store, plan, false);
      retitleSession(ctx, plan, content);
      notify(ctx, `${EXECUTION_START_NOTICE} Plan: ${plan.name} (${plan.id}).`);
    } catch (error) {
      if (record.activation === activation) {
        record.ledgerError = errorMessage(error);
        publishState(ctx);
        notify(ctx, pauseMessage(record), "error");
      }
    }
  };

  pi.on("input", async (event, ctx) => {
    const live = mainSession(ctx);
    if (live) restoreApprovalTiers(live);
    const current = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (current && event.source !== "extension") current.stallCount = 0;
    const atlas = parseAtlasCommand(event.text);
    if (atlas) {
      // Plan selectors run here; the registered command handles the rest.
      // The dispatch menu and session-switching resume need the host command context, which only the registered command gets.
      const needsCommandContext = !atlas.selector || parseAtlasSubcommand(atlas.selector).kind === "resume";
      if (needsCommandContext && event.source === "interactive" && current?.phase !== "executing") return undefined;
      await atlasCommand(atlas.selector, ctx);
      return { handled: true };
    }
    if (current?.phase === "executing" && /^\/(?:prometheus|plan)(?:[ \t]|$)/.test(event.text.trim())) {
      notify(ctx, "Atlas is active. Run /atlas exit before entering or changing planning mode.", "error");
      return { handled: true };
    }
    const command = parsePrometheusCommand(event.text);
    if (!command) {
      const trimmed = event.text.trim();
      if (trimmed.startsWith("/") && current?.phase === "planning") current.proposalAwaitingApproval = false;
      if (trimmed.startsWith("/") && current?.phase === "planning") current.approvalCompactionPending = false;
      if (trimmed.startsWith("/") && current?.phase === "planning") publishState(ctx);
      if (/^\/plan(?:[ \t]|$)/.test(trimmed)) {
        const record = current ?? rehydrate(ctx);
        if (live?.getPlanModeState()?.enabled === true && record?.phase === "planning") {
          record.phase = "idle";
          await clearProposalMarker(ctx, record.planFilePath);
          record.planFilePath = undefined;
          record.roadmapStage = undefined;
          record.proposedByToolCallId = undefined;
          record.planningModeEntryId = undefined;
          record.pendingConsent = undefined;
          record.proposalAwaitingApproval = false;
          record.approvalCompactionPending = false;
          record.offerPendingForModeEntryId = undefined;
          persist(ctx, record);
          await syncTools(false, false, false);
        }
      }
      return undefined;
    }
    if (!live) {
      notify(ctx, "Prometheus requires the registered main session; this host/session cannot enter it.", "error");
      return { handled: true };
    }
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    const planModeActive = live.getPlanModeState()?.enabled === true;
    if (record?.phase === "planning") {
      await release(ctx, "/prometheus", "planning");
      return planModeActive ? { text: "/plan" } : { handled: true };
    }
    if (planModeDisabled(live)) {
      notify(ctx, PLAN_MODE_DISABLED, "error");
      return { handled: true };
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
    if (record?.phase === "executing") {
      commandNotice(ctx, "Atlas is active. /prometheus cannot release it; run /atlas exit.", "error");
      return;
    }
    if (record?.phase === "planning") {
      await release(ctx, "/prometheus", "planning");
      return;
    }
    if (planModeDisabled(live)) {
      commandNotice(ctx, PLAN_MODE_DISABLED, "error");
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
    description: "Toggle Prometheus planning mode (Metis, Momus)",
    handler: commandHandler,
  });

  pi.registerCommand("atlas", {
    description: "Open Atlas Dispatch, enter an approved plan, or view the running plan; /atlas exit leaves Atlas",
    getArgumentCompletions: (prefix) => atlasArgumentCompletions(prefix, atlasPlans),
    handler: atlasCommand,
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
      .enum(["status", "start", "done", "block", "reopen", "fix"])
      .describe(
        "status shows every row; start, done, block, and reopen change the row named by id; fix appends an X row for the rejecting gate named by id",
      ),
    id: z.string().optional().describe("Row id such as T3, X1, or F2; required for every action except status"),
    evidence: z
      .string()
      .optional()
      .describe(
        "Inspected observable evidence; required for done, block, and fix (the gate's rejection). Gate verdicts are read from native child output, not this text",
      ),
    childAgentId: z
      .string()
      .optional()
      .describe("Required for done: exact id of the owned native child dispatched for this started attempt"),
    title: z.string().optional().describe("Required for fix: the correction the rejecting gate asked for"),
    acceptance: z.string().optional().describe("Required for fix: the observable check that proves the correction"),
    agent: z
      .string()
      .optional()
      .describe(
        "fix: agent that performs the correction (default task). start: the listed agent to dispatch when the row shows unavailable, i.e. neither its requested agent nor a fallback can be spawned; pick the most specific fit for the row's work",
      ),
  });
  type LedgerParams = {
    action: "status" | "start" | "done" | "block" | "reopen" | "fix";
    id?: string;
    evidence?: string;
    childAgentId?: string;
    title?: string;
    acceptance?: string;
    agent?: string;
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
    label: "Atlas Release",
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
          content: [{ type: "text" as const, text: "Atlas execution is not active in this main session." }],
          isError: true,
          details: {},
        };
      }
      const ownership = record.ownership;
      const ledger = await readLedger(ctx, record);
      if (!ledger) return { content: [{ type: "text" as const, text: pauseMessage(record) }], isError: true, details: {} };
      if (!isComplete(ledger)) {
        const unfinished = ledgerRows(ledger).filter((item) => item.status !== "done");
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
          content: [{ type: "text" as const, text: "No confirmation UI is available. Ask the user to run /atlas exit." }],
          isError: true,
          details: {},
        };
      }
      let confirmed = false;
      try {
        confirmed = await ctx.ui.confirm(
          "Exit Atlas execution?",
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
        if (record.ownership !== ownership) throw new Error("The Atlas attachment changed while awaiting confirmation");
        await withExecutionLedger(ctx, record, (current) => {
          if (!isComplete(current)) throw new Error("Completion evidence changed while awaiting confirmation; release refused");
        });
        if (record.ownership !== ownership) throw new Error("The Atlas attachment changed during confirmation");
        await release(ctx, "human-confirmed completion release", "executing");
        return {
          content: [{ type: "text" as const, text: "Atlas exited by the user; shared evidence and progress are preserved." }],
          details: {},
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Release refused: ${errorMessage(error)}` }], isError: true, details: {} };
      }
    },
  });

  pi.registerTool({
    name: LEDGER_TOOL,
    sourcePath: RUNTIME_SOURCE_PATH,
    label: "Atlas Ledger",
    description:
      "Read or update the shared approved execution ledger. Start a row BEFORE task dispatch and copy its atlas_assignment binding. Done requires its real native child's final successful result and inspected evidence; verified outputs are copied into shared storage. Gates F1–F4 run together and require distinct fresh children with structured PASS output. When a gate rejects, fix appends an X correction row and reopens only that gate. Reopen/block affect only the named row.",
    parameters: ledgerParameters,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    execute: async (_toolCallId, params: LedgerParams, _signal, _onUpdate, ctx) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: {} });
      const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
      if (!mainSession(ctx) || record?.phase !== "executing") return fail("Atlas execution is not active in this main session.");
      const ownership = record.ownership;
      let changedRow: LedgerItem | undefined;
      let completion: Omit<AtlasCompleted, "v" | "at"> | undefined;
      let compliance: { cwd: string; baseline?: string; since: number } | undefined;
      try {
        const result = await withExecutionLedger(ctx, record, async (ledger, plan, store) => {
          const wasComplete = isComplete(ledger);
          if (params.action === "status") return { content: [{ type: "text" as const, text: ledgerSummary(ledger) }], details: { ledger } };
          const id = params.id?.trim();
          const item = ledgerRows(ledger).find((entry) => entry.id === id);
          if (!item) throw new Error(`Unknown ledger row ${id || "(missing id)"}`);
          const evidence = params.evidence?.trim();
          let schema: Record<string, unknown> | undefined;
          let planBinding = "";
          if (params.action === "fix") {
            const fix = addFixRow(
              ledger,
              item.id,
              {
                title: params.title ?? "",
                acceptance: params.acceptance ?? "",
                agent: params.agent?.trim() || "task",
                reason: evidence ?? "",
              },
              availableAgents(),
            );
            changedRow = fix;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${fix.id} records the correction for ${item.id}; ${item.id} reopens once ${item.dependsOn.filter((row) => row.startsWith("X")).join(", ")} are done.\n\n${ledgerSummary(ledger)}`,
                },
              ],
              details: { id: fix.id, status: fix.status, gate: item.id },
            };
          }
          if (params.action === "start") {
            if (item.id === "F1") {
              // Git runs after the ledger lock is released; an unrecorded baseline is dated by the earliest execution start.
              const starts = ledgerRows(ledger).flatMap((row) => (row.startedAt === undefined ? [] : [row.startedAt]));
              compliance = { cwd: plan.cwd, baseline: ledger.gitBaseline, since: starts.length ? Math.min(...starts) : ledger.createdAt };
              planBinding = `\nF1 plan binding (copy literally; never inline the plan text): review_kind: compliance; absolute_plan_path: ${plan.planFilePath}`;
            }
            startRow(ledger, item.id, params.agent?.trim() || undefined, availableAgents());
            if (item.id.startsWith("F")) schema = gateOutputSchema(ledger, item);
          } else if (params.action === "done") {
            const childAgentId = params.childAgentId?.trim();
            if (!evidence || !childAgentId) throw new Error(`Marking ${item.id} done requires inspected evidence and childAgentId`);
            const parent = AgentRegistry.global()
              .list()
              .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager);
            if (!parent) throw new Error("Registered parent identity is unavailable");
            observeFinalJobs(ctx);
            const receipt = await childEvidence.capture({
              registry: AgentRegistry.global(),
              parentAgentId: parent.id,
              sessionId: ctx.sessionManager.getSessionId(),
              artifactsDir: ctx.sessionManager.getArtifactsDir() as string,
              ledger,
              row: item,
              childAgentId,
              priorReceipts: ledgerRows(ledger).flatMap((row) => (row.receipt ? [row.receipt] : [])),
            });
            if (record.ownership !== ownership || ownership?.detached) throw new Error("Atlas exited during child evidence capture");
            // Only authenticated final native results can publish shared immutable proof.
            await store.saveReceipt(plan, receipt, path.join(ctx.sessionManager.getArtifactsDir() as string, `${childAgentId}.md`));
            if (record.ownership !== ownership || ownership?.detached) throw new Error("Atlas exited while child evidence was copied");
            item.receipt = receipt;
            item.childAgentId = childAgentId;
            item.evidence = `${path.join(plan.directory, "evidence", `${receipt.receiptId}.md`)}: ${evidence}`;
            item.status = "done";
            item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
            const completedNow = !wasComplete && isComplete(ledger);
            // A plan proposed before its stage was started has no approved stage; the executing session's live binding stands in.
            const liveStage = completedNow && !plan.roadmapStage ? roadmap.requestBinding(ctx.sessionManager.getSessionId()) : undefined;
            const roadmapStage =
              plan.roadmapStage ?? (liveStage?.stage ? { repoRoot: liveStage.repoRoot, id: liveStage.stage.id } : undefined);
            if (completedNow && roadmapStage) {
              const gates = await Promise.all(
                ledger.gates.map(async (gate) => {
                  if (!gate.receipt) throw new Error(`Missing verified gate receipt for ${gate.id}`);
                  const output = JSON.parse(
                    await fs.readFile(path.join(plan.directory, "evidence", `${gate.receipt.receiptId}.md`), "utf8"),
                  ) as { gateId: string; verdict: string; summary: string };
                  return { gateId: output.gateId, verdict: output.verdict, summary: output.summary };
                }),
              );
              completion = { sessionId: ctx.sessionManager.getSessionId(), planId: plan.id, roadmapStage, gates };
            }
          } else {
            if (params.action === "block" && !evidence) throw new Error("Blocking a row requires an explanation");
            if ((params.action === "reopen" && item.status === "open") || (params.action === "block" && item.status === "blocked")) {
              throw new Error(`${item.id} is already ${item.status}`);
            }
            reopenRow(ledger, item.id, evidence);
            if (params.action === "block") item.status = "blocked";
          }
          changedRow = item;
          return {
            content: [
              {
                type: "text" as const,
                text: `${item.id} is now ${item.status}.\n\n${ledgerSummary(ledger)}${schema ? `\nGate task outputSchema (use schemaMode strict): ${JSON.stringify(schema)}` : ""}${planBinding}`,
              },
            ],
            details: { id: item.id, status: item.status, outputSchema: schema },
          };
        });
        if (completion) roadmap.emitCompleted(completion);
        const gitEvidence = compliance && (await collectComplianceEvidence(compliance));
        if (changedRow) {
          return {
            ...result,
            content: [
              ...result.content,
              ...(gitEvidence ? [{ type: "text" as const, text: gitEvidence.text }] : []),
              { type: "text" as const, text: atlasTodoRefreshCall(params.action as Exclude<LedgerParams["action"], "status">, changedRow) },
            ],
            details: gitEvidence ? { ...result.details, complianceEvidence: gitEvidence } : result.details,
          };
        }
        return result;
      } catch (error) {
        return fail(
          `Ledger operation refused: ${errorMessage(error)}. Execution requires a valid shared approved ledger; /atlas exit remains the user exit.`,
        );
      }
    },
  });

  const recoverCompactHandoff = async (ctx: ExtensionContext, record: SessionRecord, prompt: string): Promise<void> => {
    const live = mainSession(ctx);
    const owned = record.phase === "executing" ? record.ownership : undefined;
    if (
      !record.compactHandoffPending ||
      !live ||
      !owned ||
      owned.detached ||
      live.getPlanModeState()?.enabled === true ||
      !isApprovedPlanHandoff(prompt, owned.plan.sourcePlanPath, live.getPlanReferencePath())
    )
      return;
    try {
      const approvedContent = await fs.readFile(owned.plan.planFilePath, "utf8");
      if (planDigest(approvedContent) !== owned.plan.planSha256 || !inlinesApprovedPlan(prompt, owned.plan.sourcePlanPath, approvedContent))
        throw new Error("the compact approval handoff differs from the exact approved plan");
      const approved = await owned.store.find(owned.plan.id);
      if (
        approved.planSha256 !== owned.plan.planSha256 ||
        approved.sourcePlanPath !== owned.plan.sourcePlanPath ||
        approved.sourceSessionId !== owned.plan.sourceSessionId ||
        approved.proposedByToolCallId !== owned.plan.proposedByToolCallId ||
        record.ownership !== owned
      )
        throw new Error("the compact approval handoff no longer matches the owned shared approval");
      // Approve+compact may reset the shared binding before a normal prompt or a queued
      // synthetic developer turn. Both paths revalidate this same single-use native transition.
      await bindPlan(ctx, record, owned.store, approved, false, owned.plan.sourcePlanPath);
      record.compactHandoffPending = false;
    } catch (error) {
      record.ledgerError = errorMessage(error);
      notify(ctx, pauseMessage(record), "error");
    }
  };

  pi.on("before_agent_start", async (event, ctx) => {
    const live = mainSession(ctx);
    if (!live) return undefined;
    restoreApprovalTiers(live);
    const sessionId = ctx.sessionManager.getSessionId();
    let record = records.get(sessionId) ?? rehydrate(ctx);
    const reference = live.getPlanReferencePath();
    if (record) await recoverCompactHandoff(ctx, record, event.prompt);
    if ((!record || record.phase === "idle") && reference && isApprovedPlanHandoff(event.prompt, reference, reference)) {
      try {
        const marker = JSON.parse(
          await fs.readFile(resolveLocalUrlToPath(prometheusArtifactUrl(reference), localOptions(ctx)), "utf8"),
        ) as {
          version?: unknown;
          planFilePath?: unknown;
          planSha256?: unknown;
          proposedByToolCallId?: unknown;
          sourceSessionId?: unknown;
          roadmapStage?: unknown;
        };
        // A present but invalid plugin marker must pause this handoff, not silently become ordinary execution.
        if (
          marker.version !== 3 ||
          typeof marker.planFilePath !== "string" ||
          !planReferencesMatch(marker.planFilePath, reference) ||
          typeof marker.proposedByToolCallId !== "string" ||
          !marker.proposedByToolCallId ||
          typeof marker.sourceSessionId !== "string" ||
          !marker.sourceSessionId
        )
          throw new Error("Invalid Prometheus proposal marker");
        record = {
          phase: "planning",
          planFilePath: reference,
          planSha256: typeof marker.planSha256 === "string" && /^[a-f0-9]{64}$/.test(marker.planSha256) ? marker.planSha256 : undefined,
          proposedByToolCallId: marker.proposedByToolCallId,
          sourceSessionId: marker.sourceSessionId,
          roadmapStage: isRoadmapStage(marker.roadmapStage) ? marker.roadmapStage : undefined,
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
        record.roadmapStage = undefined;
        record.proposedByToolCallId = undefined;
        record.planningModeEntryId = undefined;
        record.pendingConsent = undefined;
        record.proposalAwaitingApproval = false;
        record.approvalCompactionPending = false;
        record.offerPendingForModeEntryId = undefined;
        persist(ctx, record);
      } else if (!record.planningModeEntryId && episodeId) {
        record.planningModeEntryId = episodeId;
        persist(ctx, record);
      }
    }
    if (
      record?.phase === "planning" &&
      !planModeActive &&
      record.approvalCompactionPending === true &&
      planReferencesMatch(live.getPlanReferencePath(), record.planFilePath)
    ) {
      record.compactHandoffPending = true;
      await enterExecution(ctx, record);
    }
    let injected: string | undefined;
    let wantActivate = false;
    let executing = record?.phase === "executing";

    if (record?.phase === "planning") {
      if (planModeActive) {
        injected = await planningBlock(ctx);
      } else if (isApprovedPlanHandoff(event.prompt, record.planFilePath, live.getPlanReferencePath())) {
        await enterExecution(ctx, record, event.prompt);
        executing = true;
      } else {
        await clearProposalMarker(ctx, record.planFilePath);
        record.phase = "idle";
        record.planFilePath = undefined;
        record.roadmapStage = undefined;
        record.proposedByToolCallId = undefined;
        record.planningModeEntryId = undefined;
        record.pendingConsent = undefined;
        record.proposalAwaitingApproval = false;
        record.approvalCompactionPending = false;
        record.offerPendingForModeEntryId = undefined;
        persist(ctx, record);
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
    persist(ctx, record);
  });

  pi.on("context", async (event, ctx) => {
    const live = mainSession(ctx);
    if (!live) return undefined;
    observeFinalJobs(ctx);
    const record = records.get(ctx.sessionManager.getSessionId()) ?? rehydrate(ctx);
    if (!record || (record.phase !== "planning" && record.phase !== "executing")) return undefined;
    if (record.phase === "planning" && live.getPlanModeState()?.enabled !== true) return undefined;
    if (record.phase === "executing" && record.compactHandoffPending) {
      for (const message of event.messages) {
        if (message.role !== "developer" || message.attribution !== "agent" || message.synthetic !== true) continue;
        const prompt =
          typeof message.content === "string"
            ? message.content
            : message.content.length === 1 && message.content[0]?.type === "text"
              ? message.content[0].text
              : undefined;
        if (prompt) await recoverCompactHandoff(ctx, record, prompt);
        if (!record.compactHandoffPending) break;
      }
    }

    const planning = record.phase === "planning";
    const policyHeading = planning ? "# Prometheus planning workflow (active)" : "# Atlas execution (active)";
    const policyAlreadyInSystem = ctx.getSystemPrompt().some((part) => part.includes(policyHeading));
    const content = policyAlreadyInSystem
      ? `${policyHeading}\n\nThe complete workflow policy is active in the system prompt; this message replaces conflicting native plan context.`
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
    observeFinalJobs(ctx);
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
    if (event.toolName === "write" && record?.phase === "planning" && live.getPlanModeState()?.enabled === true) {
      const proposalDetail = await proposalGrammarBlockReason(ctx, event.input);
      if (proposalDetail) return { block: true, reason: proposalDetail };
    }
    if (event.toolName === "task") {
      const taskSpawnDetail = taskSpawnBlockReason(record?.phase, event.input);
      if (taskSpawnDetail) return { block: true, reason: taskSpawnDetail };
    }
    if (record?.phase !== "executing") return undefined;

    const nested = event.toolName === "write" ? nestedXdevToolCall(event.input) : undefined;
    const roadmapToolSourcePath =
      event.toolName.startsWith("roadmap_") || nested?.toolName.startsWith("roadmap_")
        ? roadmap.binding(ctx.sessionManager.getSessionId())?.toolSourcePath
        : undefined;
    let detail = executionBlockReason(event.toolName, event.input, roadmapToolSourcePath);
    if (!detail) detail = provenanceBlockReason(event.toolName, roadmapToolSourcePath);
    if (!detail && nested) detail = provenanceBlockReason(nested.toolName, roadmapToolSourcePath);
    // Native xdev task dispatch is intercepted again at its inner task boundary.
    if (!detail && event.toolName === "task") {
      const originSessionId = ctx.sessionManager.getSessionId();
      let remembered = false;
      try {
        if (!evidenceSubscription) throw new Error("native child lifecycle evidence is unavailable on this host");
        await withExecutionLedger(ctx, record, (ledger) => {
          const artifactsDir = ctx.sessionManager.getArtifactsDir();
          if (!artifactsDir) throw new Error("native task artifacts are unavailable");
          childEvidence.rememberDispatch(event.toolCallId, originSessionId, ledger, event.input, artifactsDir);
          remembered = true;
        });
      } catch (error) {
        if (remembered) childEvidence.discardUnstartedDispatch(originSessionId, event.toolCallId);
        return {
          block: true,
          reason: `Task dispatch refused: ${errorMessage(error)}. Use a valid shared ledger and its current start binding; /atlas exit is the user exit.`,
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
    const sessionId = ctx.sessionManager.getSessionId();
    if (event.toolName === "task" && provenanceBlockReason("task") === undefined) {
      childEvidence.observeTaskResult(sessionId, event.toolCallId, event.details, event.isError);
      observeFinalJobs(ctx);
      await settleDetached();
    }
    if (!live) return undefined;
    const record = records.get(sessionId) ?? rehydrate(ctx) ?? recordFor(sessionId);
    if (event.toolName === "todo" && !event.isError && record.phase === "executing") {
      const details = event.details;
      if (
        details &&
        typeof details === "object" &&
        "op" in details &&
        details.op !== "view" &&
        "phases" in details &&
        Array.isArray(details.phases) &&
        details.phases.every(isTodoPhase)
      ) {
        const ledger = await readLedger(ctx, record);
        if (!ledger) return undefined;
        // The host todo tool normalizes to one running item; restore parallel Atlas rows before
        // its tracker and HUD consume this result, while leaving non-Atlas edits intact.
        const corrected = mergeAtlasTodos(details.phases, ledger);
        if (corrected) {
          if (JSON.stringify(live.getTodoPhases()) !== JSON.stringify(corrected)) {
            live.setTodoPhases(corrected);
            live.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: corrected });
          }
          return { details: { ...details, phases: corrected } };
        }
      }
      return undefined;
    }
    observeFinalJobs(ctx);

    if (event.toolName === "ask") {
      record.pendingConsent = undefined;
      const episodeId = planModeEpisodeId(ctx);
      const fixedQuestion = provenanceBlockReason("ask") === undefined && isPrometheusOptInQuestion(event.input);
      if (record.phase === "idle" && live.getPlanModeState()?.enabled === true && episodeId && fixedQuestion) {
        if (isPrometheusOptInConsent(event.input, event.details, event.isError, ctx.hasUI)) {
          record.pendingConsent = { askToolCallId: event.toolCallId, modeEntryId: episodeId };
        } else {
          record.suppressedForModeEntryId = episodeId;
          persist(ctx, record);
          await syncTools(false, false, false);
        }
      }
      return undefined;
    }

    const proposedPath = proposedPlanPathFromToolResult(event.toolName, event.isError, event.details);
    if (!proposedPath || provenanceBlockReason("write") !== undefined || record.phase !== "planning") return undefined;
    record.planFilePath = proposedPath;
    record.proposedByToolCallId = event.toolCallId;
    record.sourceSessionId = sessionId;
    record.proposalAwaitingApproval = true;
    record.approvalCompactionPending = false;
    record.ledgerPath = undefined;
    record.planSha256 = undefined;
    const binding = roadmap.requestBinding(sessionId);
    record.roadmapStage = binding?.stage ? { repoRoot: binding.repoRoot, id: binding.stage.id } : undefined;
    try {
      record.planSha256 = planDigest(await fs.readFile(resolveLocalUrlToPath(proposedPath, localOptions(ctx)), "utf8"));
      const markerFile = resolveLocalUrlToPath(prometheusArtifactUrl(proposedPath), localOptions(ctx));
      await writeLedgerAtomic(markerFile, {
        version: 3,
        planFilePath: proposedPath,
        planSha256: record.planSha256,
        proposedByToolCallId: event.toolCallId,
        sourceSessionId: sessionId,
        roadmapStage: record.roadmapStage,
        createdAt: Date.now(),
      });
    } catch (error) {
      pi.logger.warn("prometheus could not write the proposal marker", { error: errorMessage(error) });
    }
    persist(ctx, record);
    // The native approval overlay opens after this hook and offers cycleOrder roles as execution tiers.
    exposeAtlasApprovalTier(live);

    const approvedInResult = event.content.some((part) => part.type === "text" && part.text.trimStart().startsWith("Plan approved at "));
    if (approvedInResult && live.getPlanModeState()?.enabled !== true && planReferencesMatch(live.getPlanReferencePath(), proposedPath)) {
      await enterExecution(ctx, record);
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
      record.compactHandoffPending = true;
      await enterExecution(ctx, record);
      await syncTools(false, true, true);
    }
  });

  pi.on("message_end", (_event, ctx) => observeFinalJobs(ctx));

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
    const stamp = Math.max(...ledgerRows(ledger).map((item) => item.updatedAt));
    record.stallCount = stamp === record.lastContinuationLedgerStamp ? record.stallCount + 1 : 0;
    if (record.stallCount >= 2) {
      notify(ctx, "Atlas execution stalled; run /atlas exit or send new instructions", "warning");
      return undefined;
    }
    record.lastContinuationLedgerStamp = stamp;
    return {
      continue: true,
      additionalContext: `<atlas-continuation>\n${ledgerSummary(ledger)}\nDispatch the next unblocked items with task; record progress with atlas_ledger; call atlas_release only when every T and F row is done.\n</atlas-continuation>`,
    };
  });

  const recoverSession = async (ctx: ExtensionContext, fresh = false, switched = false): Promise<void> => {
    for (const sessionId of liveModels.keys()) {
      if (switched && sessionId !== ctx.sessionManager.getSessionId()) {
        herdrDag.release(sessionId, "session-switch");
        herdrDag.forget(sessionId);
      }
      clearObservation(ctx, sessionId);
    }
    authorizedActivationCalls.clear();
    const sessionId = ctx.sessionManager.getSessionId();
    const live = mainSession(ctx);
    const knownBinding = live ? hostBindings.get(live) : undefined;
    const previousReference =
      switched && knownBinding?.sessionId !== sessionId && planReferencesMatch(live?.getPlanReferencePath(), knownBinding?.planUrl)
        ? knownBinding?.planUrl
        : undefined;
    const previous = records.get(sessionId);
    if (previous) {
      previous.ownership = undefined;
      previous.activation = undefined;
    }
    const restored = fresh ? undefined : rehydrate(ctx, true);
    if (fresh) records.delete(sessionId);
    for (const ownership of ownerships) {
      if (ownership.sessionId !== sessionId || restored?.phase !== "executing" || restored.atlasPlanId !== ownership.plan.id) {
        detach(ownership);
      }
    }
    await settleDetached();
    await resumeLedger(ctx, restored, previousReference);
    if (!restored?.ownership) herdrDag.release(sessionId, "exit");
    if (live && knownBinding && !restored?.ownership && planReferencesMatch(live.getPlanReferencePath(), knownBinding.planUrl)) {
      live.setPlanReferencePath(DEFAULT_PLAN_REFERENCE);
    }
    const executing = restored?.phase === "executing";
    await syncTools(false, executing, executing);
    publishState(ctx);
  };

  const registerRole = (ctx: ExtensionContext): void => {
    const live = mainSession(ctx);
    if (live) registerAtlasModelRole(live.settings);
  };

  pi.on("session_start", async (_event, ctx) => {
    registerRole(ctx);
    await loadReviewLevel(ctx);
    await recoverSession(ctx);
    herdrDag.announce(ctx.sessionManager.getSessionId());
    await refreshAtlasCompletions(ctx);
  });

  pi.on("session_switch", async (event, ctx) => {
    registerRole(ctx);
    await loadReviewLevel(ctx);
    await recoverSession(ctx, event.reason === "new", true);
    herdrDag.announce(ctx.sessionManager.getSessionId());
    await refreshAtlasCompletions(ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    await recoverSession(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await recoverSession(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const live = mainSession(ctx);
    if (live) restoreApprovalTiers(live);
    const sessionId = ctx.sessionManager.getSessionId();
    herdrDag.release(sessionId, "shutdown");
    clearObservation(ctx, sessionId);
    const record = records.get(sessionId);
    if (record) {
      record.phase = "idle";
      record.ownership = undefined;
      record.activation = undefined;
    }
    for (const ownership of ownerships) if (ownership.sessionId === sessionId) detach(ownership);
    // Keep observations and locks for still-live native work; process death is recovered by AtlasStore.
    await settleDetached();
    if (live) {
      const binding = hostBindings.get(live);
      if (binding?.sessionId === sessionId && planReferencesMatch(live.getPlanReferencePath(), binding.planUrl)) {
        live.setPlanReferencePath(DEFAULT_PLAN_REFERENCE);
      }
    }
    records.delete(sessionId);
    await statePublisher.flush();
    publishedStates.delete(sessionId);
    reviewLevels.delete(sessionId);
    atlasWidgets.delete(sessionId);
    herdrDag.forget(sessionId);
    roadmap.forget(sessionId);
    authorizedActivationCalls.clear();
  });
}
