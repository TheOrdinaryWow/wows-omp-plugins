import type { JudgmentState } from "@oh-my-pi/pi-ai";
import { TypeSafeJudge, typesafeBaseUrl, typesafeModel } from "@oh-my-pi/pi-ai/judgment";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  formatModelStringWithRouting,
  normalizeModelPatternList,
  resolveAgentModelSelection,
  resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { type JudgmentUsageLedger, journalJudgmentUsage } from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type AgentDefinition, discoverAgents, isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";

import {
  acceptRoutingDecision,
  type IntegrationMode,
  isNativeJevCandidate,
  type JevDispatchSettings,
  MissingJevApiKeyError,
  type ParsedTaskRoute,
  parseLegalAgentNames,
  parseTaskInput,
  type RoutingCandidate,
  rewriteTaskAgents,
  type SerializedCandidate,
  selectJevApiKey,
  selectRoutingSurface,
  serializeCandidate,
  standardRoutingDeadlineMs,
} from "#src/routing.ts";

const PACKAGE_NAME = "wows-omp-plugin-jev-dispatch";
const MAX_ROUTING_DEADLINE_MS = 8_000;
const DEFAULT_SETTINGS: JevDispatchSettings = {
  integrationMode: "standard",
  minimumConfidence: 0.7,
  includeSharedContext: true,
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
  block?: boolean;
  reason?: string;
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
    const error = new DOMException(`jev-dispatch routing exceeded ${timeoutMs}ms`, "TimeoutError");
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

function parseSettings(raw: Record<string, unknown>): JevDispatchSettings {
  const minimumConfidence = raw.minimumConfidence ?? DEFAULT_SETTINGS.minimumConfidence;
  if (typeof minimumConfidence !== "number" || !Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error(`invalid minimumConfidence ${JSON.stringify(minimumConfidence)}`);
  }

  const includeSharedContext = raw.includeSharedContext ?? DEFAULT_SETTINGS.includeSharedContext;
  if (typeof includeSharedContext !== "boolean") {
    throw new Error(`invalid includeSharedContext ${JSON.stringify(includeSharedContext)}`);
  }

  const apiKey = raw.apiKey;
  if (apiKey !== undefined && typeof apiKey !== "string") {
    throw new Error("invalid apiKey setting: expected a string");
  }

  return {
    integrationMode: parseIntegrationMode(raw.integrationMode),
    minimumConfidence,
    includeSharedContext,
    ...(typeof apiKey === "string" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  };
}

async function effectivePluginSettings(cwd: string): Promise<JevDispatchSettings> {
  return parseSettings(await getPluginSettings(PACKAGE_NAME, cwd));
}

function requireJevApiKey(config: JevDispatchSettings): string {
  const selection = selectJevApiKey(process.env.TYPESAFE_API_KEY, config.apiKey);
  if (!selection) throw new MissingJevApiKeyError();
  return selection.key;
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

function fallbackChain(patterns: readonly string[], role: string | undefined, settings: Settings): string[] {
  if (patterns.length > 1) return patterns.slice(1);
  const chains = settings.get("retry.fallbackChains");
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
  const modelOverrides = settings.get("task.agentModelOverrides") as Record<string, string | string[] | undefined>;
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
          fallbackChain: fallbackChain(selection.patterns, selection.role, settings),
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

async function routeAgent(
  route: Pick<ParsedTaskRoute, "assignment" | "context" | "requestedAgent">,
  candidates: readonly RoutingCandidate[],
  config: JevDispatchSettings,
  apiKey: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  if (candidates.length < 2) return undefined;
  const serialized = candidates.map(serializeCandidate);
  const criteria = Object.fromEntries(serialized.map((candidate) => [candidate.name, candidateCriterion(candidate)]));
  const state = {
    assignment: route.assignment,
    ...(config.includeSharedContext && route.context ? { context: route.context } : {}),
    requestedAgent: route.requestedAgent ?? null,
    candidates: serialized,
  } as unknown as JudgmentState;
  const questions = {
    agent: {
      type: "choice" as const,
      instructions:
        "Choose the single agent type best suited to complete this assignment. Match the declared specialization and access needs; do not classify effort.",
      criteria,
    },
  };
  const judge = new TypeSafeJudge({
    apiKey,
    baseUrl: typesafeBaseUrl(),
    model: typesafeModel(),
  });
  if (!isNativeJevCandidate("native", judge.label)) throw new Error("jev-dispatch requires a Jev model");
  const judged = await judge.judge({ state, questions }, { signal });
  const model = ctx.modelRegistry.find("typesafe", judged.model) ?? ctx.modelRegistry.find("typesafe", judge.model);
  if (model && judged.usage.cost.total === 0) calculateCost(model, judged.usage);
  journalJudgmentUsage(
    ctx.sessionManager as unknown as Partial<JudgmentUsageLedger>,
    "jev-dispatch",
  )?.({
    role: "typesafe",
    api: judged.api,
    provider: judged.provider,
    model: judged.model,
    usage: judged.usage,
    stopReason: "stop",
  });
  const answer = judged.answers.agent;
  return acceptRoutingDecision(
    {
      kind: "native",
      api: judged.api,
      model: judged.model,
      choice: answer.choice,
      confidence: answer.confidence,
    },
    candidates.map((candidate) => candidate.name),
    config.minimumConfidence,
  );
}

async function routeAgentFailOpen(
  pi: ExtensionAPI,
  route: Pick<ParsedTaskRoute, "assignment" | "context" | "requestedAgent">,
  candidates: readonly RoutingCandidate[],
  config: JevDispatchSettings,
  apiKey: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    return await routeAgent(route, candidates, config, apiKey, ctx, signal);
  } catch {
    pi.logger.warn("jev-dispatch judgment failed; preserving the original agent");
    return undefined;
  }
}

function registerStandard(pi: ExtensionAPI, warnAboutEnhancedFallback: boolean): void {
  let fallbackWarningShown = false;
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return undefined;
    if (warnAboutEnhancedFallback && !fallbackWarningShown) {
      fallbackWarningShown = true;
      try {
        ctx.ui.notify(
          "jev-dispatch enhanced mode requires OMP subagent routing API v2; using standard task interception instead.",
          "warning",
        );
      } catch (error) {
        pi.logger.warn("jev-dispatch could not display its enhanced-mode fallback warning", {
          error: errorMessage(error),
        });
      }
    }

    try {
      const config = await effectivePluginSettings(ctx.cwd);
      const apiKey = requireJevApiKey(config);
      const settings = scopedSettings(ctx);
      const deadlineMs = standardRoutingDeadlineMs(settings.get("extensionHandlers.toolCallTimeoutMs"));
      if (deadlineMs === undefined) return undefined;
      const taskTool = pi.getAllTools().find((tool) => tool.name === "task");
      const legalNames = taskTool ? parseLegalAgentNames(taskTool.description) : undefined;
      if (!legalNames) return undefined;
      return await withRoutingDeadline(deadlineMs, async (signal) => {
        const input = event.input as Record<string, unknown>;
        const routes = parseTaskInput(input);
        if (!routes) return undefined;
        const candidates = await discoverStandardCandidates(ctx, settings, legalNames);
        const choices = await Promise.all(routes.map((route) => routeAgentFailOpen(pi, route, candidates, config, apiKey, ctx, signal)));
        const rewritten = rewriteTaskAgents(input, routes, choices);
        return rewritten === input ? undefined : { input: rewritten };
      });
    } catch (error) {
      if (error instanceof MissingJevApiKeyError) {
        return { block: true, reason: error.message };
      }
      pi.logger.warn("jev-dispatch task interception failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}

function registerEnhanced(pi: ExtensionAPI): void {
  const enhancedPi = pi as unknown as { on: EnhancedOn };
  enhancedPi.on("before_subagent_spawn", async (event, ctx) => {
    try {
      return await withRoutingDeadline(MAX_ROUTING_DEADLINE_MS, async (signal) => {
        const config = await effectivePluginSettings(ctx.cwd);
        const apiKey = requireJevApiKey(config);
        const agent = await routeAgentFailOpen(
          pi,
          {
            assignment: event.assignment,
            context: event.context,
            requestedAgent: event.requestedAgent,
          },
          event.candidates,
          config,
          apiKey,
          ctx,
          signal,
        );
        return agent ? { agent } : undefined;
      });
    } catch (error) {
      if (error instanceof MissingJevApiKeyError) {
        return { block: true, reason: error.message };
      }
      pi.logger.warn("jev-dispatch enhanced routing failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}

export default function jevDispatch(pi: ExtensionAPI): void {
  let bootstrapped = false;
  pi.on("session_start", async (_event, ctx) => {
    if (bootstrapped) return;
    bootstrapped = true;

    let mode: IntegrationMode = DEFAULT_SETTINGS.integrationMode;
    try {
      mode = (await withRoutingDeadline(MAX_ROUTING_DEADLINE_MS, () => effectivePluginSettings(ctx.cwd))).integrationMode;
    } catch (error) {
      pi.logger.warn("jev-dispatch configuration is invalid; loading standard fail-open interception", {
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
