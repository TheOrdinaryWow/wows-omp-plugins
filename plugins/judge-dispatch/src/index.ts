import type { ChoiceQuestion, JudgmentState } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  formatModelStringWithRouting,
  normalizeModelPatternList,
  resolveAgentModelSelection,
  resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { type ChainJudge, type JudgmentUsageLedger, journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type AgentDefinition, discoverAgents, isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";

import { readHostSetting } from "#src/host-settings.ts";
import {
  acceptRoutingDecision,
  type IntegrationMode,
  type JudgeDispatchSettings,
  type ParsedTaskRoute,
  parseLegalAgentNames,
  parseTaskInput,
  type RouteChoice,
  type RoutingCandidate,
  rewriteTaskRoutes,
  routableCandidates,
  type SerializedCandidate,
  selectRoutingSurface,
  serializeCandidate,
  standardRoutingDeadlineMs,
  TASK_EFFORTS,
  type TaskEffort,
} from "#src/routing.ts";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
const MAX_ROUTING_DEADLINE_MS = 8_000;
const DEFAULT_SETTINGS: JudgeDispatchSettings = {
  integrationMode: "standard",
  minimumConfidence: 0.7,
  includeSharedContext: true,
  judgeEffort: false,
};

interface BeforeSubagentSpawnEvent {
  type: "before_subagent_spawn";
  invocationKind: "task" | "eval";
  assignment: string;
  context?: string;
  requestedAgent: string;
  candidates: RoutingCandidate[];
}

interface BeforeSubagentSpawnResult {
  agent?: string;
}

type BeforeSubagentSpawnHandler = (
  event: BeforeSubagentSpawnEvent,
  ctx: ExtensionContext,
) => Promise<BeforeSubagentSpawnResult | undefined> | BeforeSubagentSpawnResult | undefined;

type EnhancedOn = (event: "before_subagent_spawn", handler: BeforeSubagentSpawnHandler) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withRoutingDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    const error = new DOMException(`judge-dispatch routing exceeded ${timeoutMs}ms`, "TimeoutError");
    controller.abort(error);
    timeout.reject(error);
  }, timeoutMs);

  try {
    return await Promise.race([operation(controller.signal), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function parseIntegrationMode(value: unknown): IntegrationMode {
  if (value === undefined) return DEFAULT_SETTINGS.integrationMode;
  if (value === "standard" || value === "enhanced") return value;
  throw new Error(`invalid integrationMode ${JSON.stringify(value)}`);
}

function parseSettings(raw: Record<string, unknown>): JudgeDispatchSettings {
  const minimumConfidence = raw.minimumConfidence ?? DEFAULT_SETTINGS.minimumConfidence;
  if (typeof minimumConfidence !== "number" || !Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error(`invalid minimumConfidence ${JSON.stringify(minimumConfidence)}`);
  }

  const includeSharedContext = raw.includeSharedContext ?? DEFAULT_SETTINGS.includeSharedContext;
  if (typeof includeSharedContext !== "boolean") {
    throw new Error(`invalid includeSharedContext ${JSON.stringify(includeSharedContext)}`);
  }

  const judgeEffort = raw.judgeEffort ?? DEFAULT_SETTINGS.judgeEffort;
  if (typeof judgeEffort !== "boolean") {
    throw new Error(`invalid judgeEffort ${JSON.stringify(judgeEffort)}`);
  }

  return {
    integrationMode: parseIntegrationMode(raw.integrationMode),
    minimumConfidence,
    includeSharedContext,
    judgeEffort,
  };
}

async function effectivePluginSettings(cwd: string): Promise<JudgeDispatchSettings> {
  return parseSettings(await getPluginSettings(PACKAGE_NAME, cwd));
}

function scopedSettings(ctx: ExtensionContext): Settings {
  const settings = findScopedSettings(ctx.cwd);
  if (!settings) throw new Error("the active session has no scoped Settings instance");
  return settings;
}

function deduplicateAgents(agents: readonly AgentDefinition[]): AgentDefinition[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    if (seen.has(agent.name)) return false;
    seen.add(agent.name);
    return true;
  });
}

function selectedModel(patterns: readonly string[], settings: Settings, ctx: ExtensionContext): string | undefined {
  const resolved = resolveModelOverride([...patterns], ctx.modelRegistry, settings);
  if (!resolved.model) return undefined;
  const selector = formatModelStringWithRouting(resolved.model);
  return resolved.explicitThinkingLevel && resolved.thinkingLevel ? `${selector}:${resolved.thinkingLevel}` : selector;
}

function fallbackChain(patterns: readonly string[], role: string | undefined, chains: Record<string, unknown>): string[] {
  if (patterns.length > 1) return patterns.slice(1);
  const inherited = chains[role ?? "default"] ?? (role ? chains.default : undefined);
  return Array.isArray(inherited) ? inherited.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Standard mode has no host preflight event, so the legal candidate set comes
 * from the host's own rendered `task` agent list (`legalNames`). Discovery here
 * only adds model metadata for those names; an agent the host did not list is
 * never described to a judge or selected.
 */
async function discoverStandardCandidates(
  ctx: ExtensionContext,
  settings: Settings,
  legalNames: readonly string[],
): Promise<RoutingCandidate[]> {
  if (legalNames.length === 0) return [];
  const currentSession = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
  const discovery = await discoverAgents(ctx.cwd, undefined, currentSession?.effectiveExtensionRoots);
  const agents = deduplicateAgents([...discovery.agents, ...(currentSession?.getSessionAgents() ?? [])]);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const blockedAgent = process.env.PI_BLOCKED_AGENT?.trim();
  const modelOverrides = (await readHostSetting(settings, "task.agentModelOverrides")) as Record<string, string | string[] | undefined>;
  const fallbackChains = (await readHostSetting(settings, "retry.fallbackChains")) as Record<string, unknown>;
  const activeModelPattern = ctx.model ? formatModelStringWithRouting(ctx.model) : undefined;

  return legalNames
    .filter((name) => name !== blockedAgent)
    .map((name) => byName.get(name))
    .filter((agent): agent is AgentDefinition => agent !== undefined)
    .map((agent) => {
      const selection = resolveAgentModelSelection({
        settingsOverride: modelOverrides[agent.name],
        agentModel: agent.model,
        settings,
        activeModelPattern,
        fallbackModelPattern: activeModelPattern,
      });
      const selected = selectedModel(selection.patterns, settings, ctx);
      return {
        name: agent.name,
        description: agent.description,
        source: agent.source,
        readOnly: isReadOnlyAgent(agent),
        declaredModelPatterns: normalizeModelPatternList(agent.model),
        model: {
          patterns: selection.patterns,
          ...(selection.role ? { role: selection.role } : {}),
          ...(selected ? { selected } : {}),
          fallbackChain: fallbackChain(selection.patterns, selection.role, fallbackChains),
        },
      } satisfies RoutingCandidate;
    });
}

function candidateCriterion(candidate: SerializedCandidate): string {
  const model = candidate.model;
  const selectors = [
    model.declared?.length ? `declared ${model.declared.join(", ")}` : undefined,
    model.effective.length ? `effective ${model.effective.join(", ")}` : undefined,
    model.role ? `role ${model.role}` : undefined,
    model.selected ? `selected ${model.selected}` : undefined,
    model.fallbacks.length ? `fallbacks ${model.fallbacks.join(", ")}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
  return `${candidate.description} [${candidate.source}; ${candidate.access}${selectors ? `; ${selectors}` : ""}]`;
}

/** The `judge` role chain did not reach a native judgment candidate: missing credentials or a chat-model judge role. */
const JUDGE_UNAVAILABLE = Symbol("judge-unavailable");

function sessionJudge(ctx: ExtensionContext, settings: Settings): ChainJudge {
  return resolveJudge({
    settings,
    registry: ctx.modelRegistry,
    sessionId: ctx.sessionManager.getSessionId(),
    onUsage: journalJudgmentUsage(ctx.sessionManager as unknown as Partial<JudgmentUsageLedger>, "judge-dispatch"),
  });
}

const EFFORT_QUESTION: ChoiceQuestion<TaskEffort> = {
  type: "choice",
  instructions:
    "Choose how much thinking effort the subagent needs for this assignment, judged by how open-ended the problem is rather than by how much work it involves.",
  criteria: {
    lo: "Mechanical or fully specified work: the fix or steps are given and little reasoning is needed.",
    med: "Ordinary multi-step work whose approach is mostly settled but still needs some reasoning.",
    hi: "Open-ended, ambiguous, or logic-heavy work where causes or designs remain open.",
  },
};

async function judgeRoute(
  route: Pick<ParsedTaskRoute, "assignment" | "context" | "requestedAgent">,
  allCandidates: readonly RoutingCandidate[],
  config: JudgeDispatchSettings,
  judge: ChainJudge,
  signal: AbortSignal,
): Promise<RouteChoice | undefined | typeof JUDGE_UNAVAILABLE> {
  signal.throwIfAborted();
  const candidates = routableCandidates(route.requestedAgent, allCandidates);
  if (!candidates) return undefined;
  const routesAgent = candidates.length >= 2;
  if (!routesAgent && !config.judgeEffort) return undefined;

  const serialized = candidates.map(serializeCandidate);
  const candidateNames = serialized.map((candidate) => candidate.name);
  const state = {
    assignment: route.assignment,
    ...(config.includeSharedContext && route.context ? { context: route.context } : {}),
    requestedAgent: route.requestedAgent ?? null,
    candidates: serialized,
  } as unknown as JudgmentState;
  const questions: Record<string, ChoiceQuestion> = {};
  if (routesAgent) {
    questions.agent = {
      type: "choice",
      instructions:
        "Choose the single agent type best suited to complete this assignment. Match the declared specialization and access needs; do not classify effort.",
      criteria: Object.fromEntries(serialized.map((candidate) => [candidate.name, candidateCriterion(candidate)])),
    };
  }
  if (config.judgeEffort) questions.effort = EFFORT_QUESTION;

  // A chat-model judge cannot reproduce a native judge's calibrated confidence, so
  // the chain's first usable candidate must be native; anything else is never called.
  let reachedNative = false;
  try {
    return await judge.withCandidate(
      async (candidate, kind) => {
        if (kind !== "native") return JUDGE_UNAVAILABLE;
        reachedNative = true;
        const { answers } = await candidate.judge({ state, questions }, { signal });
        const accept = <T extends string>(id: string, legal: readonly T[]): T | undefined => {
          const answer = answers[id];
          return (
            answer && acceptRoutingDecision({ kind, choice: answer.choice, confidence: answer.confidence }, legal, config.minimumConfidence)
          );
        };
        const agent = routesAgent ? accept("agent", candidateNames) : undefined;
        const effort = config.judgeEffort ? accept("effort", TASK_EFFORTS) : undefined;
        return { ...(agent ? { agent } : {}), ...(effort ? { effort } : {}) };
      },
      { signal },
    );
  } catch (error) {
    if (!reachedNative && !signal.aborted) return JUDGE_UNAVAILABLE;
    throw error;
  }
}

interface RoutingSession {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: JudgeDispatchSettings;
  judge: ChainJudge;
  notifyUnavailable(ctx: ExtensionContext): void;
}

async function judgeRouteFailOpen(
  session: RoutingSession,
  route: Pick<ParsedTaskRoute, "assignment" | "context" | "requestedAgent">,
  candidates: readonly RoutingCandidate[],
  signal: AbortSignal,
): Promise<RouteChoice | undefined> {
  try {
    const choice = await judgeRoute(route, candidates, session.config, session.judge, signal);
    if (choice !== JUDGE_UNAVAILABLE) return choice;
    session.notifyUnavailable(session.ctx);
  } catch {
    session.pi.logger.warn("judge-dispatch judgment failed; preserving the original route");
  }
  return undefined;
}

/** Warn once per session that routing is idle until the host's judge role reaches a native judgment model. */
function unavailableNotifier(pi: ExtensionAPI): (ctx: ExtensionContext) => void {
  let shown = false;
  return (ctx) => {
    if (shown) return;
    shown = true;
    try {
      ctx.ui.notify(
        "judge-dispatch needs OMP's judge role to resolve to a native judgment model such as TypeSafe Jev; keeping requested agents. Run /login typesafe or set TYPESAFE_API_KEY.",
        "warning",
      );
    } catch (error) {
      pi.logger.warn("judge-dispatch could not display its judge availability warning", { error: errorMessage(error) });
    }
  };
}

function registerStandard(pi: ExtensionAPI, warnAboutEnhancedFallback: boolean): void {
  let fallbackWarningShown = false;
  const notifyUnavailable = unavailableNotifier(pi);
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return undefined;
    if (warnAboutEnhancedFallback && !fallbackWarningShown) {
      fallbackWarningShown = true;
      try {
        ctx.ui.notify(
          "judge-dispatch enhanced mode requires OMP subagent routing API v2; using standard task interception instead.",
          "warning",
        );
      } catch (error) {
        pi.logger.warn("judge-dispatch could not display its enhanced-mode fallback warning", {
          error: errorMessage(error),
        });
      }
    }

    try {
      const config = await effectivePluginSettings(ctx.cwd);
      const settings = scopedSettings(ctx);
      const deadlineMs = standardRoutingDeadlineMs(await readHostSetting(settings, "extensionHandlers.toolCallTimeoutMs"));
      if (deadlineMs === undefined) return undefined;
      const taskTool = pi.getAllTools().find((tool) => tool.name === "task");
      const legalNames = taskTool ? parseLegalAgentNames(taskTool.description) : undefined;
      if (!legalNames) return undefined;
      return await withRoutingDeadline(deadlineMs, async (signal) => {
        const input = event.input as Record<string, unknown>;
        const routes = parseTaskInput(input);
        if (!routes) return undefined;
        const candidates = await discoverStandardCandidates(ctx, settings, legalNames);
        const session = { pi, ctx, config, judge: sessionJudge(ctx, settings), notifyUnavailable };
        const choices = await Promise.all(routes.map((route) => judgeRouteFailOpen(session, route, candidates, signal)));
        const rewritten = rewriteTaskRoutes(input, routes, choices);
        return rewritten === input ? undefined : { input: rewritten };
      });
    } catch (error) {
      pi.logger.warn("judge-dispatch task interception failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}

function registerEnhanced(pi: ExtensionAPI): void {
  const enhancedPi = pi as unknown as { on: EnhancedOn };
  const notifyUnavailable = unavailableNotifier(pi);
  enhancedPi.on("before_subagent_spawn", async (event, ctx) => {
    try {
      return await withRoutingDeadline(MAX_ROUTING_DEADLINE_MS, async (signal) => {
        // The API v2 spawn result carries only `agent`, so enhanced routing never asks for an effort it cannot apply.
        const config = { ...(await effectivePluginSettings(ctx.cwd)), judgeEffort: false };
        const session = { pi, ctx, config, judge: sessionJudge(ctx, scopedSettings(ctx)), notifyUnavailable };
        const choice = await judgeRouteFailOpen(
          session,
          {
            assignment: event.assignment,
            context: event.context,
            requestedAgent: event.requestedAgent,
          },
          event.candidates,
          signal,
        );
        return choice?.agent ? { agent: choice.agent } : undefined;
      });
    } catch (error) {
      pi.logger.warn("judge-dispatch enhanced routing failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}

export default function judgeDispatch(pi: ExtensionAPI): void {
  let bootstrapped = false;
  pi.on("session_start", async (_event, ctx) => {
    if (bootstrapped) return;
    bootstrapped = true;

    let mode: IntegrationMode = DEFAULT_SETTINGS.integrationMode;
    try {
      mode = (await withRoutingDeadline(MAX_ROUTING_DEADLINE_MS, () => effectivePluginSettings(ctx.cwd))).integrationMode;
    } catch (error) {
      pi.logger.warn("judge-dispatch configuration is invalid; loading standard fail-open interception", {
        error: errorMessage(error),
      });
    }

    const host = pi.pi as typeof pi.pi & { SUBAGENT_ROUTING_EXTENSION_API_VERSION?: unknown };
    const selection = selectRoutingSurface(mode, host.SUBAGENT_ROUTING_EXTENSION_API_VERSION);
    if (selection.surface === "enhanced") {
      registerEnhanced(pi);
      return;
    }
    registerStandard(pi, selection.warnAboutEnhancedFallback);
  });
}
