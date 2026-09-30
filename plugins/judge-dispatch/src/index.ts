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
import { registerRouteIndicator, setRoutingWorkingMessage } from "#src/indicator.ts";
import {
  acceptRoutingDecision,
  blendedPrice,
  chooseBudgetModel,
  DIFFICULTY_EFFORT,
  type JudgeDispatchSettings,
  MODEL_BUDGETS,
  type ModelBudget,
  type ParsedTaskRoute,
  PendingSpawnRoutes,
  parseLegalAgentNames,
  parseTaskInput,
  type RouteChoice,
  type RoutingCandidate,
  rewriteTaskRoutes,
  routableCandidates,
  routingDeadlineMs,
  type ScoredModelOption,
  type SerializedCandidate,
  serializeCandidate,
  TASK_DIFFICULTIES,
  type TaskDifficulty,
} from "#src/routing.ts";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
const DEFAULT_SETTINGS: JudgeDispatchSettings = {
  minimumConfidence: 0.7,
  includeSharedContext: true,
  judgeEffort: false,
  modelBudget: "off",
  indicator: true,
};

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

  const modelBudget = raw.modelBudget ?? DEFAULT_SETTINGS.modelBudget;
  if (!MODEL_BUDGETS.includes(modelBudget as ModelBudget)) {
    throw new Error(`invalid modelBudget ${JSON.stringify(modelBudget)}`);
  }

  const indicator = raw.indicator ?? DEFAULT_SETTINGS.indicator;
  if (typeof indicator !== "boolean") {
    throw new Error(`invalid indicator ${JSON.stringify(indicator)}`);
  }

  return {
    minimumConfidence,
    includeSharedContext,
    judgeEffort,
    modelBudget: modelBudget as ModelBudget,
    indicator,
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
 * A `tool_call` hook sees no host spawn preflight, so the legal candidate set comes
 * from the host's own rendered `task` agent list (`legalNames`). Discovery here
 * only adds model metadata for those names; an agent the host did not list is
 * never described to a judge or selected.
 */
async function discoverCandidates(ctx: ExtensionContext, settings: Settings, legalNames: readonly string[]): Promise<RoutingCandidate[]> {
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

const DIFFICULTY_QUESTION: ChoiceQuestion<TaskDifficulty> = {
  type: "choice",
  instructions:
    "Classify how demanding this assignment is for the subagent, judged by how open-ended the problem is rather than by how much work it involves.",
  criteria: {
    routine: "Mechanical or fully specified work: the fix or steps are given and little reasoning is needed.",
    standard: "Ordinary multi-step work whose approach is mostly settled but still needs some reasoning.",
    demanding: "Open-ended, ambiguous, or logic-heavy work where causes or designs remain open.",
  },
};

interface JudgedRoute {
  agent?: string;
  difficulty?: TaskDifficulty;
  agentConfidence?: number;
  difficultyConfidence?: number;
}

async function judgeRoute(
  route: ParsedTaskRoute,
  allCandidates: readonly RoutingCandidate[],
  config: JudgeDispatchSettings,
  judge: ChainJudge,
  signal: AbortSignal,
  beforeJudge: () => void,
): Promise<JudgedRoute | undefined | typeof JUDGE_UNAVAILABLE> {
  signal.throwIfAborted();
  const candidates = routableCandidates(route.requestedAgent, allCandidates);
  if (!candidates) return undefined;
  if (candidates.length === 0) return undefined;
  const routesAgent = candidates.length >= 2;
  const judgesDifficulty = config.judgeEffort || config.modelBudget !== "off";
  if (!routesAgent && !judgesDifficulty) return undefined;

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
  if (judgesDifficulty) questions.difficulty = DIFFICULTY_QUESTION;

  // A chat-model judge cannot reproduce a native judge's calibrated confidence, so
  // the chain's first usable candidate must be native; anything else is never called.
  let reachedNative = false;
  try {
    beforeJudge();
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
        const difficulty = judgesDifficulty ? accept("difficulty", TASK_DIFFICULTIES) : undefined;
        return {
          ...(agent ? { agent, agentConfidence: answers.agent?.confidence } : {}),
          ...(difficulty ? { difficulty, difficultyConfidence: answers.difficulty?.confidence } : {}),
        };
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
  beforeJudge(): void;
}

async function judgeRouteFailOpen(
  session: RoutingSession,
  route: ParsedTaskRoute,
  candidates: readonly RoutingCandidate[],
  signal: AbortSignal,
): Promise<JudgedRoute | undefined> {
  try {
    const judged = await judgeRoute(route, candidates, session.config, session.judge, signal, session.beforeJudge);
    if (judged !== JUDGE_UNAVAILABLE) return judged;
    session.notifyUnavailable(session.ctx);
  } catch {
    session.pi.logger.warn("judge-dispatch judgment failed; preserving the original route");
  }
  return undefined;
}

/** Turn a judgment into the task-call rewrite, recording the budget decision its spawn hook will look up. */
function routeChoice(
  route: ParsedTaskRoute,
  judged: JudgedRoute | undefined,
  config: JudgeDispatchSettings,
  pending: PendingSpawnRoutes,
): RouteChoice | undefined {
  if (!judged) return undefined;
  const choice: RouteChoice = {
    ...(judged.agent ? { agent: judged.agent, agentConfidence: judged.agentConfidence } : {}),
    ...(config.judgeEffort && judged.difficulty
      ? { effort: DIFFICULTY_EFFORT[judged.difficulty], effortConfidence: judged.difficultyConfidence }
      : {}),
  };
  if (config.modelBudget !== "off" && judged.difficulty) {
    const agent = judged.agent ?? route.requestedAgent;
    const name = route.name ?? `${agent ?? "task"}-${crypto.randomUUID().slice(0, 8)}`;
    if (!route.name) choice.name = name;
    pending.add(name, { ...(agent ? { agent } : {}), difficulty: judged.difficulty });
  }
  return choice;
}

/** Registry models behind the spawn's configured selectors, keeping only available ones with a catalog score and price. */
function scoredSpawnOptions(patterns: readonly string[], settings: Settings, ctx: ExtensionContext): ScoredModelOption[] | undefined {
  const available = new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
  const options: ScoredModelOption[] = [];
  for (const [position, pattern] of patterns.entries()) {
    const model = resolveModelOverride([pattern], ctx.modelRegistry, settings).model;
    const scored = model && available.has(`${model.provider}/${model.id}`) && model.int != null && Number.isFinite(model.int);
    // Without the first choice's score there is no reference for what a fallback gives up.
    if (!scored) {
      if (position === 0) return undefined;
      continue;
    }
    options.push({ pattern, intelligence: model.int as number, blendedPrice: blendedPrice(model.cost) });
  }
  return options;
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

export default function judgeDispatch(pi: ExtensionAPI): void {
  const notifyUnavailable = unavailableNotifier(pi);
  const recordRoutes = registerRouteIndicator(pi);
  const pendingBySession = new WeakMap<object, PendingSpawnRoutes>();
  const pendingFor = (ctx: ExtensionContext): PendingSpawnRoutes => {
    let pending = pendingBySession.get(ctx.sessionManager);
    if (!pending) {
      pending = new PendingSpawnRoutes();
      pendingBySession.set(ctx.sessionManager, pending);
    }
    return pending;
  };

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return undefined;
    let working = false;
    try {
      // Prometheus owns agent and effort choices while executing its approved plan.
      // Read the latest valid workflow state on this branch, not assignment wording.
      const branch = ctx.sessionManager.getBranch();
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry?.type !== "custom" || entry.customType !== "wows-omp-omo-prometheus.state") continue;
        const phase = (entry.data as { phase?: unknown } | undefined)?.phase;
        if (phase !== "idle" && phase !== "planning" && phase !== "executing") continue;
        if (phase === "executing") return undefined;
        break;
      }
      const config = await effectivePluginSettings(ctx.cwd);
      const settings = scopedSettings(ctx);
      const deadlineMs = routingDeadlineMs(await readHostSetting(settings, "extensionHandlers.toolCallTimeoutMs"));
      if (deadlineMs === undefined) return undefined;
      const taskTool = pi.getAllTools().find((tool) => tool.name === "task");
      const legalNames = taskTool ? parseLegalAgentNames(taskTool.description) : undefined;
      if (!legalNames?.length) return undefined;
      return await withRoutingDeadline(deadlineMs, async (signal) => {
        const input = event.input as Record<string, unknown>;
        const routes = parseTaskInput(input);
        if (!routes) return undefined;
        const candidates = await discoverCandidates(ctx, settings, legalNames);
        signal.throwIfAborted();
        const session: RoutingSession = {
          pi,
          ctx,
          config,
          judge: sessionJudge(ctx, settings),
          notifyUnavailable,
          beforeJudge() {
            // A judgment that starts after the deadline would set a message the finally block already restored.
            if (!config.indicator || working || signal.aborted) return;
            working = true;
            setRoutingWorkingMessage(pi, ctx, `judge-dispatch: routing ${routes.length} ${routes.length === 1 ? "task" : "tasks"}…`);
          },
        };
        const judged = await Promise.all(routes.map((route) => judgeRouteFailOpen(session, route, candidates, signal)));
        signal.throwIfAborted();
        const pending = pendingFor(ctx);
        const choices = routes.map((route, index) => routeChoice(route, judged[index], config, pending));
        const rewritten = rewriteTaskRoutes(input, routes, choices);
        if (config.indicator && rewritten !== input) recordRoutes(input, routes, choices);
        return rewritten === input ? undefined : { input: rewritten };
      });
    } catch (error) {
      pi.logger.warn("judge-dispatch task interception failed open", { error: errorMessage(error) });
      return undefined;
    } finally {
      if (working) setRoutingWorkingMessage(pi, ctx);
    }
  });

  pi.on("before_subagent_spawn", async (event, ctx) => {
    if (event.invocationKind !== "task" || !event.spawnKey) return undefined;
    try {
      const route = pendingFor(ctx).take(event.spawnKey, event.agent);
      if (!route) return undefined;
      const { modelBudget } = await effectivePluginSettings(ctx.cwd);
      if (modelBudget === "off") return undefined;
      const settings = scopedSettings(ctx);
      const chains = (await readHostSetting(settings, "retry.fallbackChains")) as Record<string, unknown>;
      const patterns = [...new Set([...event.patterns, ...fallbackChain(event.patterns, event.modelRole, chains)])];
      const options = scoredSpawnOptions(patterns, settings, ctx);
      const chosen = options && chooseBudgetModel(options, route.difficulty, modelBudget);
      if (!chosen || chosen.pattern === event.patterns[0]) return undefined;
      return {
        model: [chosen.pattern, ...event.patterns.filter((pattern) => pattern !== chosen.pattern)],
        note: `judge-dispatch ${modelBudget} budget, ${route.difficulty} task: intelligence ${chosen.intelligence}, $${chosen.blendedPrice.toFixed(2)}/M blended`,
      };
    } catch (error) {
      pi.logger.warn("judge-dispatch budget model selection failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}
