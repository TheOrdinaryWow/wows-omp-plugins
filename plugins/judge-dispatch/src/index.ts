import type { ChoiceQuestion, Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  disabledProviderIds,
  extractExplicitThinkingSelector,
  formatModelStringWithRouting,
  resolveAgentModelSelection,
  resolveConfiguredModelPatterns,
  resolveExplicitModelRole,
  resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { type ChainJudge, journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { type AgentDefinition, discoverAgents, isReadOnlyAgent, type TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task";
import { isRecord } from "@oh-my-pi/pi-utils";

import { EscalationMemo, taskResultOutput } from "#src/escalation.ts";
import { readHostSetting } from "#src/host-settings.ts";
import { registerLegacyRouteRecords, setRoutingWorkingMessage, showRouteOutcomes, showRoutingStatus } from "#src/indicator.ts";
import {
  acceptRoutingDecision,
  type DispatchedTaskItem,
  hasTier,
  isPendingSpawn,
  isWorkflowOwnedAgent,
  type JudgeDispatchSettings,
  type ParsedTaskRoute,
  type PendingSpawnRoute,
  parseDefaultAgent,
  parseLegalAgentNames,
  parseModelTiers,
  parseTaskInput,
  type RouteChoice,
  type RouteOutcome,
  type RoutingCandidate,
  rewriteTaskRoutes,
  routableCandidates,
  routingDeadlineMs,
  serializeCandidate,
  TASK_DIFFICULTIES,
  type TaskDifficulty,
  takeSpawnItem,
  thinkingStep,
  tierFor,
} from "#src/routing.ts";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
/** Every setting the manifest declares; anything else stored for the plugin is ignored with a warning. */
const SETTING_KEYS: Record<string, true> = {
  routeAgent: true,
  judgeEffort: true,
  modelTiers: true,
  minimumConfidence: true,
  includeSharedContext: true,
  indicator: true,
};
const DISPATCH_RECORD_LIMIT = 256;

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

function booleanSetting(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key] ?? fallback;
  if (typeof value !== "boolean") throw new Error(`invalid ${key} ${JSON.stringify(value)}`);
  return value;
}

function parseSettings(raw: Record<string, unknown>): JudgeDispatchSettings {
  const minimumConfidence = raw.minimumConfidence ?? 0.7;
  if (typeof minimumConfidence !== "number" || !Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error(`invalid minimumConfidence ${JSON.stringify(minimumConfidence)}`);
  }
  const modelTiers = raw.modelTiers ?? "";
  if (typeof modelTiers !== "string") throw new Error(`invalid modelTiers ${JSON.stringify(modelTiers)}`);

  return {
    routeAgent: booleanSetting(raw, "routeAgent", true),
    judgeEffort: booleanSetting(raw, "judgeEffort", false),
    modelTiers: parseModelTiers(modelTiers),
    minimumConfidence,
    includeSharedContext: booleanSetting(raw, "includeSharedContext", true),
    indicator: booleanSetting(raw, "indicator", true),
  };
}

function scopedSettings(ctx: ExtensionContext): Settings {
  const settings = findScopedSettings(ctx.cwd);
  if (!settings) throw new Error("the active session has no scoped Settings instance");
  return settings;
}

/** The selector a spawn starts on and what it resolves to. */
interface ResolvedPrimary {
  /** Index of the first selector that resolves; the host spawns with it. */
  index: number;
  model: Model;
  /** `provider/id[@upstream]`. */
  key: string;
  thinkingLevel?: AgentDefinition["thinkingLevel"];
  explicitThinkingLevel: boolean;
}

/** Resolve selectors in attempt order as the spawn does, with disabled providers removed first. */
function resolvePrimary(patterns: readonly string[], settings: Settings, ctx: ExtensionContext): ResolvedPrimary | undefined {
  const disabled = disabledProviderIds(settings);
  const enabled = ctx.modelRegistry.getAvailable().filter((model) => !disabled.has(model.provider));
  const registry = { getAvailable: () => enabled };
  for (const [index, pattern] of patterns.entries()) {
    const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride([pattern], registry, settings);
    if (model) return { index, model, key: formatModelStringWithRouting(model), thinkingLevel, explicitThinkingLevel };
  }
  return undefined;
}

/**
 * A `tool_call` hook sees no host spawn preflight, so the legal candidate set comes
 * from the host's own rendered `task` agent list (`legalNames`). Discovery adds
 * the listed agents' permissions and model configuration.
 */
async function discoverCandidates(ctx: ExtensionContext, settings: Settings, legalNames: readonly string[]): Promise<RoutingCandidate[]> {
  if (legalNames.length === 0) return [];
  const currentSession = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
  const discovery = await discoverAgents(ctx.cwd, undefined, currentSession?.effectiveExtensionRoots);
  const byName = new Map(discovery.agents.map((agent) => [agent.name, agent]));
  const taggedModels = new Set<string>();
  for (const agent of currentSession?.getSessionAgents() ?? []) {
    if (byName.has(agent.name)) continue;
    byName.set(agent.name, agent);
    taggedModels.add(agent.name);
  }
  const blockedAgent = process.env.PI_BLOCKED_AGENT?.trim();
  const modelOverrides = readHostSetting(settings, "task.agentModelOverrides") as Record<string, string | string[] | undefined>;
  const activeModelPattern = ctx.model ? formatModelStringWithRouting(ctx.model) : undefined;

  return legalNames
    .filter((name) => name !== blockedAgent)
    .map((name) => byName.get(name))
    .filter((agent): agent is AgentDefinition => agent !== undefined)
    .map((agent) => ({
      name: agent.name,
      description: agent.description,
      source: agent.source,
      readOnly: isReadOnlyAgent(agent),
      hasSpawnGrant: (agent.spawns?.length ?? 0) > 0,
      taggedModel: taggedModels.has(agent.name),
      patterns: resolveAgentModelSelection({
        settingsOverride: modelOverrides[agent.name],
        agentModel: agent.model,
        settings,
        activeModelPattern,
        fallbackModelPattern: activeModelPattern,
      }).patterns,
      ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
    }));
}

/** The `judge` role chain did not reach a native judgment candidate: missing credentials or a chat-model judge role. */
const JUDGE_UNAVAILABLE = Symbol("judge-unavailable");

function sessionJudge(ctx: ExtensionContext, settings: Settings): ChainJudge {
  const currentSession = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
  return resolveJudge({
    settings,
    registry: ctx.modelRegistry,
    sessionModel: ctx.model,
    sessionId: ctx.sessionManager.getSessionId(),
    purpose: "judge-dispatch",
    onUsage: journalJudgmentUsage(ctx.sessionManager),
    costGate: currentSession && isLocalAgentSession(currentSession) ? currentSession.costGate : undefined,
  });
}

const DIFFICULTY_QUESTION: ChoiceQuestion<TaskDifficulty> = {
  type: "choice",
  instructions:
    "Classify how demanding this assignment is for the subagent, judged by how open-ended the problem is rather than by how much work it involves. A solutionSpace in the state is the caller's own description of how open the problem is: whether the fix or design is given, or which causes or designs remain open.",
  criteria: {
    routine: "Mechanical or fully specified work: the fix or steps are given and little reasoning is needed.",
    standard: "Ordinary multi-step work whose approach is mostly settled but still needs some reasoning.",
    demanding: "Open-ended, ambiguous, or logic-heavy work where causes or designs remain open.",
  },
};

async function judgeRoute(
  route: ParsedTaskRoute,
  spawnAgent: string,
  routable: readonly RoutingCandidate[],
  config: JudgeDispatchSettings,
  judge: ChainJudge,
  signal: AbortSignal,
  beforeJudge: () => void,
): Promise<RouteOutcome | typeof JUDGE_UNAVAILABLE> {
  signal.throwIfAborted();
  const candidates = config.routeAgent ? routable : routable.filter((candidate) => candidate.name === spawnAgent);
  const routesAgent = config.routeAgent && candidates.length >= 2;
  const difficultyApplies = (agent: string): boolean => (config.judgeEffort && !route.explicitEffort) || hasTier(config.modelTiers, agent);
  // Ask both together only if every possible final agent can use the difficulty.
  // Agent-specific tiers otherwise need the agent answer before difficulty can matter.
  const judgesDifficulty = routesAgent ? candidates.every((candidate) => difficultyApplies(candidate.name)) : difficultyApplies(spawnAgent);
  if (!routesAgent && !judgesDifficulty) return "no alternatives";

  const serialized = candidates.map(serializeCandidate);
  const candidateNames = serialized.map((candidate) => candidate.name);
  const state = {
    assignment: route.assignment,
    ...(route.solutionSpace ? { solutionSpace: route.solutionSpace } : {}),
    ...(config.includeSharedContext && route.context ? { context: route.context } : {}),
    requestedAgent: spawnAgent,
    candidates: serialized.map((candidate) => ({ ...candidate })),
  };
  const questions: Record<string, ChoiceQuestion> = {};
  if (routesAgent) {
    questions.agent = {
      type: "choice",
      instructions:
        "Choose the single agent type best suited to complete this assignment. Match the declared specialization and access needs; do not classify effort.",
      criteria: Object.fromEntries(
        serialized.map((candidate) => [candidate.name, `${candidate.description} [${candidate.source}; ${candidate.access}]`]),
      ),
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
        const agentAnswer = routesAgent ? answers.agent : undefined;
        const agent = agentAnswer
          ? acceptRoutingDecision(
              { kind, choice: agentAnswer.choice, confidence: agentAnswer.confidence },
              candidateNames,
              config.minimumConfidence,
            )
          : undefined;
        let difficultyAnswer = judgesDifficulty ? answers.difficulty : undefined;
        if (!judgesDifficulty && difficultyApplies(agent ?? spawnAgent)) {
          const result = await candidate.judge(
            { state: { ...state, finalAgent: agent ?? spawnAgent }, questions: { difficulty: DIFFICULTY_QUESTION } },
            { signal },
          );
          difficultyAnswer = result.answers.difficulty;
        }
        const difficulty = difficultyAnswer
          ? acceptRoutingDecision(
              { kind, choice: difficultyAnswer.choice, confidence: difficultyAnswer.confidence },
              TASK_DIFFICULTIES,
              config.minimumConfidence,
            )
          : undefined;
        return {
          ...(agent ? { agent, agentConfidence: agentAnswer?.confidence } : {}),
          ...(routesAgent && !agent ? { agentUndecided: true } : {}),
          ...(difficulty ? { difficulty, difficultyConfidence: difficultyAnswer?.confidence } : {}),
        };
      },
      { signal },
    );
  } catch (error) {
    if (!reachedNative && !signal.aborted) return JUDGE_UNAVAILABLE;
    throw error;
  }
}

/**
 * Routing state of one parent session. `before_subagent_spawn` and
 * `tool_execution_end` carry that session's context, so each finds its own.
 */
interface SessionRouting {
  escalations: EscalationMemo;
  dispatched: Map<string, TaskDispatch>;
  lostPendingSpawn: boolean;
}

interface TaskDispatch {
  at: number;
  items: (DispatchedTaskItem | undefined)[];
  ended?: boolean;
}

function recordDispatch(routing: SessionRouting, toolCallId: string, input: Record<string, unknown>): TaskDispatch {
  const items = (Array.isArray(input.tasks) ? input.tasks : [input]).map((item: unknown) => {
    if (!isRecord(item)) return undefined;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    return name ? { name } : {};
  });
  const dispatch: TaskDispatch = { at: Date.now(), items };
  const previous = routing.dispatched.get(toolCallId);
  if (previous) routing.lostPendingSpawn ||= previous.items.some(isPendingSpawn);
  routing.dispatched.delete(toolCallId);
  routing.dispatched.set(toolCallId, dispatch);
  if (routing.dispatched.size > DISPATCH_RECORD_LIMIT) {
    const oldest = routing.dispatched.entries().next();
    if (!oldest.done) {
      const [id, evicted] = oldest.value;
      // A forgotten item can still spawn under a name reused later in this session.
      routing.lostPendingSpawn ||= evicted.items.some(isPendingSpawn);
      routing.dispatched.delete(id);
    }
  }
  return dispatch;
}

interface RoutingSession {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: JudgeDispatchSettings;
  judge: ChainJudge;
  escalations: EscalationMemo;
  notifyUnavailable(ctx: ExtensionContext): void;
  beforeJudge(): void;
}

/**
 * An item re-dispatched under a remembered name keeps its agent and takes the
 * remembered difficulty without a judgment. The record is only read here; the
 * caller consumes it once the routed call is actually returned.
 */
async function routeOutcome(
  session: RoutingSession,
  route: ParsedTaskRoute,
  candidates: readonly RoutingCandidate[],
  signal: AbortSignal,
): Promise<RouteOutcome> {
  if (route.nativeModel) return "native model";
  const requestedAgent = route.requestedAgent;
  if (!requestedAgent) return "unknown default agent";
  const routable = routableCandidates(requestedAgent, candidates);
  if (!routable) {
    return candidates.some((candidate) => candidate.name === requestedAgent && candidate.taggedModel)
      ? "user-tagged model agent"
      : "workflow-owned or unknown agent";
  }
  const escalation = route.name ? session.escalations.peek(route.name) : undefined;
  if (escalation) return { difficulty: escalation.difficulty, escalation: escalation.reason };
  try {
    const judged = await judgeRoute(route, requestedAgent, routable, session.config, session.judge, signal, session.beforeJudge);
    if (judged !== JUDGE_UNAVAILABLE) return judged;
    session.notifyUnavailable(session.ctx);
    return "judge unavailable";
  } catch {
    session.pi.logger.warn("judge-dispatch judgment failed; preserving the original route");
    return signal.aborted ? "timed out" : "judge failed";
  }
}

/**
 * Turn an outcome into the task-call rewrite, recording the spawn change its hook
 * will apply: a configured model tier for a routine or demanding difficulty, else,
 * with `judgeEffort`, one thinking-level step.
 */
function planRoute(
  route: ParsedTaskRoute,
  outcome: RouteOutcome,
  config: JudgeDispatchSettings,
  candidates: readonly RoutingCandidate[],
  queueSpawn: (name: string, spawn: PendingSpawnRoute) => void,
  settings: Settings,
  ctx: ExtensionContext,
): RouteChoice | undefined {
  if (typeof outcome === "string") return undefined;
  const choice: RouteChoice = {
    ...(outcome.agent ? { agent: outcome.agent, agentConfidence: outcome.agentConfidence } : {}),
    ...(outcome.difficulty ? { difficulty: outcome.difficulty, difficultyConfidence: outcome.difficultyConfidence } : {}),
    ...(outcome.escalation ? { escalation: outcome.escalation } : {}),
  };
  const difficulty = outcome.difficulty;
  if (!difficulty || difficulty === "standard") return choice;
  const agent = outcome.agent ?? route.requestedAgent;
  const candidate = candidates.find((entry) => entry.name === agent);
  if (!agent || !candidate) return choice;

  const primary = resolvePrimary(candidate.patterns, settings, ctx);
  const name = route.name ?? `${agent}-${crypto.randomUUID().slice(0, 8)}`;
  const tier = tierFor(config.modelTiers, agent, difficulty);
  if (tier) {
    try {
      const model = tierSpawnModel(tier.startsWith("@") ? tier.slice(1) : tier, ctx);
      const tierPrimary = resolvePrimary(model.patterns, settings, ctx);
      // A selector without its own level runs at the agent's `thinkingLevel`, for the tier as for the agent's model.
      const level = (resolved: ResolvedPrimary | undefined) =>
        resolved?.explicitThinkingLevel ? resolved.thinkingLevel : candidate.thinkingLevel;
      // Only a tier that resolves to the agent's own model at its own level changes nothing; then the thinking step may still apply.
      if (tierPrimary?.key !== primary?.key || level(tierPrimary) !== level(primary)) {
        queueSpawn(name, {
          kind: "tier",
          agent,
          primary: primary?.key,
          difficulty,
          patterns: model.patterns,
          note: `judge-dispatch ${difficulty} tier ${model.target}`,
        });
        choice.model = { primary: primary?.key, tier };
        if (!route.name) choice.name = name;
        return choice;
      }
    } catch (error) {
      choice.model = { primary: primary?.key, tier, keptReason: errorMessage(error) };
    }
  }

  if (!config.judgeEffort || route.explicitEffort || !primary) return choice;
  const thinking = thinkingStep(
    primary.model,
    primary.explicitThinkingLevel ? primary.thinkingLevel : candidate.thinkingLevel,
    difficulty,
    readHostSetting(settings, "task.maxEffort") as Effort,
  );
  if (!thinking) return choice;
  queueSpawn(name, {
    kind: "thinking",
    agent,
    primary: primary.key,
    difficulty,
    to: thinking.to,
    ...(candidate.thinkingLevel ? { thinkingLevel: candidate.thinkingLevel } : {}),
    note: `judge-dispatch ${difficulty} task: thinking ${thinking.from} → ${thinking.to}`,
  });
  choice.thinking = thinking;
  if (!route.name) choice.name = name;
  return choice;
}

function taskDetails(result: unknown): Partial<TaskToolDetails> | undefined {
  return isRecord(result) && isRecord(result.details) ? (result.details as Partial<TaskToolDetails>) : undefined;
}

function forgetFinishedDispatch(routing: SessionRouting, toolCallId: string, dispatch: TaskDispatch): void {
  if (dispatch.ended && !dispatch.items.some((item) => item?.background || isPendingSpawn(item))) {
    routing.dispatched.delete(toolCallId);
  }
}

/** Native task progress carries item positions and allocated IDs as soon as background jobs are registered. */
function bindBackgroundJobs(
  routing: SessionRouting,
  ctx: ExtensionContext,
  toolCallId: string,
  dispatch: TaskDispatch,
  details: Partial<TaskToolDetails> | undefined,
): void {
  if (!details?.async || !Array.isArray(details.progress)) return;
  const background = new Map<string, number>();
  const synchronous = new Set(Array.isArray(details.results) ? details.results.map(({ index }) => index) : []);
  for (const row of details.progress) {
    const item = dispatch.items[row.index];
    if (!item) continue;
    item.allocatedId = row.id;
    if (isWorkflowOwnedAgent(row.agent)) item.observesOutcome = false;
    if (!item.background && !synchronous.has(row.index)) background.set(row.id, row.index);
  }
  if (background.size === 0) return;
  const parent = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager);
  if (!parent?.session || !isLocalAgentSession(parent.session)) return;
  const manager = parent.session.asyncJobManager;
  for (const job of manager?.getAllJobs({ ownerId: parent.id }) ?? []) {
    const childId = job.agentId;
    const index = childId === undefined ? undefined : background.get(childId);
    const item = index === undefined ? undefined : dispatch.items[index];
    if (job.type !== "task" || childId === undefined || index === undefined || !item || job.startTime < dispatch.at) continue;
    background.delete(childId);
    item.background = true;
    const settle = () => {
      const current = routing.dispatched.get(toolCallId);
      const currentItem = current?.items[index];
      if (!current || currentItem?.allocatedId !== childId || !currentItem.background) return;
      current.items[index] = undefined;
      forgetFinishedDispatch(routing, toolCallId, current);
      // Worker job managers return snapshots, so read the terminal row at settlement.
      const final = manager?.getJob(job.id) ?? job;
      if (final.status === "running" || !currentItem.name || !currentItem.observesOutcome) return;
      const lowered = currentItem.lowered === true && currentItem.spawnKey === childId;
      routing.escalations.settle(
        currentItem.name,
        final.status !== "completed",
        taskResultOutput(final.resultText ?? final.errorText ?? ""),
        lowered,
      );
    };
    void job.promise.then(settle, settle);
  }
}

function observeTaskOutcomes(
  routing: SessionRouting,
  dispatch: TaskDispatch,
  details: Partial<TaskToolDetails> | undefined,
  isError: boolean,
): void {
  const results = Array.isArray(details?.results) ? details.results : [];
  for (const result of results) {
    const item = dispatch.items[result.index];
    if (!item?.name || !item.observesOutcome || item.background || isWorkflowOwnedAgent(result.agent)) continue;
    const failed = result.aborted === true || result.exitCode !== 0 || result.error !== undefined;
    routing.escalations.settle(item.name, failed, result.output, item.lowered === true);
  }
  if (!isError) return;
  const reported = new Set(results.map(({ index }) => index));
  for (const [index, item] of dispatch.items.entries()) {
    if (item?.name && item.observesOutcome && item.lowered && !item.background && !reported.has(index)) {
      routing.escalations.settle(item.name, true, "", true);
    }
  }
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

/** Warn once per session about stored settings the manifest no longer declares; they are ignored. */
function unknownSettingsNotifier(pi: ExtensionAPI): (ctx: ExtensionContext, raw: Record<string, unknown>) => void {
  const warned = new WeakSet<object>();
  return (ctx, raw) => {
    const unknown = Object.keys(raw).filter((key) => !Object.hasOwn(SETTING_KEYS, key));
    if (unknown.length === 0 || warned.has(ctx.sessionManager)) return;
    warned.add(ctx.sessionManager);
    const message = `judge-dispatch ignores settings it no longer has: ${unknown.join(", ")}. Choose models per difficulty with modelTiers instead.`;
    pi.logger.warn(message);
    try {
      ctx.ui.notify(message, "warning");
    } catch (error) {
      pi.logger.warn("judge-dispatch could not display its settings warning", { error: errorMessage(error) });
    }
  };
}

/** Resolve a tier target to the patterns its spawn receives, refusing one the host would not resolve as named. */
function tierSpawnModel(target: string, ctx: ExtensionContext): { target: string; patterns: string[] } {
  const settings = scopedSettings(ctx);
  const role = target.includes("/") ? undefined : target;
  const display = role === undefined ? target : `@${role}`;
  if (role !== undefined && resolveExplicitModelRole(display, settings) !== role) throw new Error(`unknown model role ${role}`);
  // A role alias or list here would expand to that role's selectors and then take the default chain instead of the role's own.
  if (role === undefined && (target.startsWith("@") || target.startsWith("pi/") || target.includes(","))) {
    throw new Error("a concrete model must be a single provider/model selector");
  }
  const selectors = resolveConfiguredModelPatterns(display, settings);
  if (selectors.length === 0) throw new Error(`no models are configured for ${display}`);

  const chains = readHostSetting(settings, "retry.fallbackChains") as Record<string, unknown>;
  const chain = (role === undefined ? undefined : chains[role]) ?? chains.default ?? [];
  if (!Array.isArray(chain) || !chain.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`the fallback chain for ${display} is invalid`);
  }
  if (chain.some((entry) => entry.endsWith("/*"))) throw new Error("provider wildcard fallback chains cannot be applied per task");
  // Match the spawn-time lookup: disabled providers leave the registry before any selector resolves.
  const disabled = disabledProviderIds(settings);
  const enabled = ctx.modelRegistry.getAvailable().filter((model) => !disabled.has(model.provider));
  // A concrete model must resolve itself; a role may resolve through its own fallback chain.
  if (!resolveModelOverride(role === undefined ? selectors : [...selectors, ...chain], { getAvailable: () => enabled }, settings).model) {
    throw new Error(`no enabled model resolves for ${display}`);
  }
  return { target: display, patterns: [...selectors, ...chain] };
}

/** Whether an approved Prometheus plan executes on this branch, read from its latest valid workflow state rather than wording. */
function prometheusExecuting(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== "wows-omp-omo-prometheus.state") continue;
    const data: unknown = entry.data;
    const phase = data && typeof data === "object" && "phase" in data ? data.phase : undefined;
    if (phase === "idle" || phase === "planning") return false;
    if (phase === "executing") return true;
  }
  return false;
}

export default function judgeDispatch(pi: ExtensionAPI): void {
  const notifyUnavailable = unavailableNotifier(pi);
  const warnUnknownSettings = unknownSettingsNotifier(pi);
  registerLegacyRouteRecords(pi);
  const routingBySession = new WeakMap<object, SessionRouting>();
  const routingFor = (ctx: ExtensionContext): SessionRouting => {
    let routing = routingBySession.get(ctx.sessionManager);
    if (!routing) {
      routing = { escalations: new EscalationMemo(), dispatched: new Map(), lostPendingSpawn: false };
      routingBySession.set(ctx.sessionManager, routing);
    }
    return routing;
  };

  pi.on("tool_execution_update", (event, ctx) => {
    if (event.toolName !== "task") return;
    const routing = routingFor(ctx);
    const dispatch = routing.dispatched.get(event.toolCallId);
    if (!dispatch) return;
    try {
      bindBackgroundJobs(routing, ctx, event.toolCallId, dispatch, taskDetails(event.partialResult));
    } catch (error) {
      pi.logger.warn("judge-dispatch could not observe background jobs", { error: errorMessage(error) });
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "task") return;
    const routing = routingFor(ctx);
    const dispatch = routing.dispatched.get(event.toolCallId);
    if (!dispatch) return;
    const details = taskDetails(event.result);
    try {
      bindBackgroundJobs(routing, ctx, event.toolCallId, dispatch, details);
      observeTaskOutcomes(routing, dispatch, details, event.isError);
    } catch (error) {
      pi.logger.warn("judge-dispatch could not observe task outcomes", { error: errorMessage(error) });
    } finally {
      dispatch.ended = true;
      const queuedIds = new Set(
        details?.async && Array.isArray(details.progress)
          ? details.progress.filter(({ status }) => status === "pending" || status === "running").map(({ id }) => id)
          : [],
      );
      for (const [index, item] of dispatch.items.entries()) {
        if (!item?.background && !(isPendingSpawn(item) && item.allocatedId && queuedIds.has(item.allocatedId))) {
          dispatch.items[index] = undefined;
        }
      }
      forgetFinishedDispatch(routing, event.toolCallId, dispatch);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return undefined;
    const input = event.input;
    const routing = routingFor(ctx);
    const dispatch = recordDispatch(routing, event.toolCallId, input);
    let working = false;
    let indicator = false;
    try {
      if (prometheusExecuting(ctx)) return undefined;
      const rawSettings = await getPluginSettings(PACKAGE_NAME, ctx.cwd);
      warnUnknownSettings(ctx, rawSettings);
      const config = parseSettings(rawSettings);
      indicator = config.indicator;
      const settings = scopedSettings(ctx);
      const deadlineMs = routingDeadlineMs(readHostSetting(settings, "extensionHandlers.toolCallTimeoutMs"));
      if (deadlineMs === undefined) {
        if (indicator) showRoutingStatus(pi, ctx, "kept the requested agent: extensionHandlers.toolCallTimeoutMs leaves no time to judge");
        return undefined;
      }
      const tool = pi.getAllTools().find((tool) => tool.name === "task");
      const legalNames = tool && parseLegalAgentNames(tool.description);
      if (!tool || !legalNames?.length) {
        if (indicator) showRoutingStatus(pi, ctx, "kept the requested agent: the task tool lists no agents to route between");
        return undefined;
      }
      const routes = parseTaskInput(input);
      if (!routes) return undefined;
      const missingAgent = routes.some((route) => route.requestedAgent === undefined);
      const defaultAgent = missingAgent ? parseDefaultAgent(tool.description) : undefined;
      if (missingAgent && defaultAgent === undefined) {
        if (indicator)
          showRouteOutcomes(
            pi,
            ctx,
            routes,
            routes.map(() => "unknown default agent"),
            [],
          );
        return undefined;
      }
      const judged = routes.map((route) => ({ ...route, requestedAgent: route.requestedAgent ?? defaultAgent }));
      return await withRoutingDeadline(deadlineMs, async (signal) => {
        const candidates = await discoverCandidates(ctx, settings, legalNames);
        signal.throwIfAborted();
        const session: RoutingSession = {
          pi,
          ctx,
          config,
          judge: sessionJudge(ctx, settings),
          escalations: routing.escalations,
          notifyUnavailable,
          beforeJudge() {
            // A judgment that starts after the deadline would set a message the finally block already restored.
            if (!config.indicator || working || signal.aborted) return;
            working = true;
            setRoutingWorkingMessage(pi, ctx, `judge-dispatch: routing ${judged.length} ${judged.length === 1 ? "task" : "tasks"}…`);
          },
        };
        const outcomes = await Promise.all(judged.map((route) => routeOutcome(session, route, candidates, signal)));
        signal.throwIfAborted();
        const pending = new Map<DispatchedTaskItem, { name: string; route: PendingSpawnRoute }>();
        const choices = judged.map((route, index) => {
          const outcome = outcomes[index] as RouteOutcome;
          const observesOutcome =
            outcome !== "native model" &&
            outcome !== "workflow-owned or unknown agent" &&
            outcome !== "user-tagged model agent" &&
            outcome !== "unknown default agent";
          const position = route.index ?? 0;
          const item = dispatch.items[position];
          if (item) item.observesOutcome = observesOutcome;
          const choice = planRoute(
            route,
            outcome,
            config,
            candidates,
            (name, spawn) => {
              if (item && !routing.lostPendingSpawn) pending.set(item, { name, route: spawn });
            },
            settings,
            ctx,
          );
          if (!routing.lostPendingSpawn || !choice) return choice;
          const { model: _model, thinking: _thinking, name: _name, ...agentOnly } = choice;
          return agentOnly;
        });
        const rewritten = rewriteTaskRoutes(input, judged, choices);
        if (indicator) showRouteOutcomes(pi, ctx, judged, outcomes, choices);
        for (const [item, spawn] of pending) Object.assign(item, spawn);
        // Past the last abort check nothing can fail open any more, so the raised routes are the ones this call returns.
        for (const [index, route] of judged.entries()) {
          const outcome = outcomes[index];
          if (route.name && typeof outcome === "object" && outcome.escalation) routing.escalations.consume(route.name);
        }
        return rewritten === input ? undefined : { input: rewritten };
      });
    } catch (error) {
      pi.logger.warn("judge-dispatch task interception failed open", { error: errorMessage(error) });
      if (indicator) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        showRoutingStatus(pi, ctx, `kept the requested agent: routing ${timedOut ? "timed out" : "failed"}`);
      }
      return undefined;
    } finally {
      if (working) setRoutingWorkingMessage(pi, ctx);
    }
  });

  pi.on("before_subagent_spawn", async (event, ctx) => {
    if (event.invocationKind !== "task" || !event.spawnKey) return undefined;
    try {
      const routing = routingFor(ctx);
      if (routing.lostPendingSpawn || routing.dispatched.size === 0 || prometheusExecuting(ctx)) return undefined;
      const item = takeSpawnItem(
        [...routing.dispatched.values()].flatMap((dispatch) => dispatch.items),
        event.spawnKey,
      );
      const route = item?.route;
      if (!item || !route || route.agent !== event.agent) return undefined;
      // The decision was made against the agent's selectors at `tool_call`; skip it if the host now starts elsewhere.
      const settings = scopedSettings(ctx);
      const primary = resolvePrimary(event.patterns, settings, ctx);
      if (primary?.key !== route.primary) return undefined;
      let model = route.kind === "tier" ? route.patterns : undefined;
      if (route.kind === "thinking" && primary) {
        const thinking = thinkingStep(
          primary.model,
          primary.explicitThinkingLevel ? primary.thinkingLevel : route.thinkingLevel,
          route.difficulty,
          readHostSetting(settings, "task.maxEffort") as Effort,
        );
        if (thinking?.to !== route.to) return undefined;
        const pattern = event.patterns[primary.index];
        if (pattern === undefined) return undefined;
        const base =
          primary.explicitThinkingLevel && extractExplicitThinkingSelector(pattern) !== undefined
            ? pattern.slice(0, pattern.lastIndexOf(":"))
            : pattern;
        model = event.patterns.with(primary.index, `${base}:${thinking.to}`);
      }
      if (!model) return undefined;
      if (route.difficulty === "routine") item.lowered = true;
      return { model, note: route.note };
    } catch (error) {
      pi.logger.warn("judge-dispatch spawn routing failed open", { error: errorMessage(error) });
      return undefined;
    }
  });
}
