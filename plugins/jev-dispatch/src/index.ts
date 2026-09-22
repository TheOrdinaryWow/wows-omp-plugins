import type { JudgmentState } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  formatModelStringWithRouting,
  normalizeModelPatternList,
  resolveAgentModelSelection,
  resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { type JudgmentUsageLedger, journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { extractSessionInit } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentDefinition, discoverAgents, isReadOnlyAgent } from "@oh-my-pi/pi-coding-agent/task";
import { resolveSpawnPolicy } from "@oh-my-pi/pi-coding-agent/task/spawn-policy";

import {
  acceptRoutingDecision,
  assertNativeJevCandidate,
  type IntegrationMode,
  type JevDispatchSettings,
  type ParsedTaskRoute,
  parseTaskInput,
  type RoutingCandidate,
  rewriteTaskAgents,
  type SerializedCandidate,
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

  return {
    integrationMode: parseIntegrationMode(raw.integrationMode),
    minimumConfidence,
    includeSharedContext,
  };
}

async function effectivePluginSettings(cwd: string): Promise<JevDispatchSettings> {
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

function fallbackChain(patterns: readonly string[], role: string | undefined, settings: Settings): string[] {
  if (patterns.length > 1) return patterns.slice(1);
  const chains = settings.get("retry.fallbackChains");
  const inherited = chains[role ?? "default"] ?? (role ? chains.default : undefined);
  return Array.isArray(inherited) ? inherited.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Standard mode has no host preflight event. Route only when both the live
 * session and its exact persisted spawn allowlist are available; an unknown
 * policy must not produce an over-broad external candidate inventory.
 */
async function discoverStandardCandidates(ctx: ExtensionContext, settings: Settings): Promise<RoutingCandidate[] | undefined> {
  const currentRef = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager);
  const currentSession = currentRef?.session;
  const sessionInit = extractSessionInit(ctx.sessionManager.getEntries());
  if (!currentSession || !sessionInit || typeof sessionInit.spawns !== "string") return undefined;

  const spawnPolicy = resolveSpawnPolicy(sessionInit.spawns);
  if (!spawnPolicy.enabled) return [];
  const discovery = await discoverAgents(ctx.cwd, undefined, currentSession.effectiveExtensionRoots);
  const agents = deduplicateAgents([...discovery.agents, ...currentSession.getSessionAgents()]);
  const disabled = new Set(settings.get("task.disabledAgents") as string[]);
  const allowed = spawnPolicy.allowedAgents ? new Set(spawnPolicy.allowedAgents) : undefined;
  const blockedAgent = process.env.PI_BLOCKED_AGENT?.trim();
  const modelOverrides = settings.get("task.agentModelOverrides") as Record<string, string | string[] | undefined>;
  const activeModelPattern = ctx.model ? formatModelStringWithRouting(ctx.model) : undefined;

  return agents
    .filter((agent) => !disabled.has(agent.name))
    .filter((agent) => !allowed || allowed.has(agent.name))
    .filter((agent) => !blockedAgent || agent.name !== blockedAgent)
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
  const settings = scopedSettings(ctx);
  const judge = resolveJudge({
    settings,
    registry: ctx.modelRegistry,
    sessionModel: ctx.model,
    sessionId: ctx.sessionManager.getSessionId(),
    onUsage: journalJudgmentUsage(ctx.sessionManager as unknown as Partial<JudgmentUsageLedger>, "jev-dispatch"),
  });
  const judged = await judge.withCandidate(
    async (candidate, kind) => {
      signal.throwIfAborted();
      assertNativeJevCandidate(kind, candidate.label);
      return {
        kind,
        result: await candidate.judge({ state, questions }, { signal }),
      };
    },
    { signal },
  );
  const answer = judged.result.answers.agent;
  return acceptRoutingDecision(
    {
      kind: judged.kind,
      api: judged.result.api,
      model: judged.result.model,
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
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    return await routeAgent(route, candidates, config, ctx, signal);
  } catch (error) {
    pi.logger.warn("jev-dispatch routing failed open", { error: errorMessage(error) });
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
          "jev-dispatch enhanced mode requires OMP subagent routing API v1; using standard task interception instead.",
          "warning",
        );
      } catch (error) {
        pi.logger.warn("jev-dispatch could not display its enhanced-mode fallback warning", {
          error: errorMessage(error),
        });
      }
    }

    try {
      const settings = scopedSettings(ctx);
      const deadlineMs = standardRoutingDeadlineMs(settings.get("extensionHandlers.toolCallTimeoutMs"));
      if (deadlineMs === undefined) return undefined;
      return await withRoutingDeadline(deadlineMs, async (signal) => {
        const input = event.input as Record<string, unknown>;
        const routes = parseTaskInput(input);
        if (!routes) return undefined;
        const candidates = await discoverStandardCandidates(ctx, settings);
        if (candidates === undefined) return undefined;
        const config = await effectivePluginSettings(ctx.cwd);
        const choices = await Promise.all(routes.map((route) => routeAgentFailOpen(pi, route, candidates, config, ctx, signal)));
        const rewritten = rewriteTaskAgents(input, routes, choices);
        return rewritten === input ? undefined : { input: rewritten };
      });
    } catch (error) {
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
        const agent = await routeAgentFailOpen(
          pi,
          {
            assignment: event.assignment,
            context: event.context,
            requestedAgent: event.requestedAgent,
          },
          event.candidates,
          config,
          ctx,
          signal,
        );
        return agent ? { agent } : undefined;
      });
    } catch (error) {
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
