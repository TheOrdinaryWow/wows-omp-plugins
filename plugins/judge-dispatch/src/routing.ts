/** Coarse per-spawn thinking effort the host task tool accepts; it maps onto the target model's supported thinking levels. */
export const TASK_EFFORTS = ["lo", "med", "hi"] as const;
export type TaskEffort = (typeof TASK_EFFORTS)[number];

/** One judged difficulty drives both the thinking effort and the budget model tier, so the two never disagree. */
export const TASK_DIFFICULTIES = ["routine", "standard", "demanding"] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

export const DIFFICULTY_EFFORT: Record<TaskDifficulty, TaskEffort> = { routine: "lo", standard: "med", demanding: "hi" };

export const MODEL_BUDGETS = ["off", "minimum", "balanced", "max"] as const;
export type ModelBudget = (typeof MODEL_BUDGETS)[number];

export interface JudgeDispatchSettings {
  minimumConfidence: number;
  includeSharedContext: boolean;
  judgeEffort: boolean;
  modelBudget: ModelBudget;
  indicator: boolean;
}

export interface CandidateModelSummary {
  patterns: readonly string[];
  role?: string;
  selected?: string;
  fallbackChain: readonly string[];
}

export interface RoutingCandidate {
  name: string;
  description: string;
  source: string;
  readOnly: boolean;
  model: CandidateModelSummary;
  /** Agent-frontmatter selectors before settings and session inheritance are applied. */
  declaredModelPatterns?: readonly string[];
}

export interface ParsedTaskRoute {
  /** `null` identifies the flat task shape; a number identifies a batch item. */
  index: number | null;
  assignment: string;
  context?: string;
  requestedAgent?: string;
  /** Spawn label the caller supplied, if any. */
  name?: string;
}

export interface SerializedCandidate {
  name: string;
  description: string;
  source: string;
  access: "read-only" | "write-capable";
  model: {
    declared?: string[];
    effective: string[];
    role?: string;
    selected?: string;
    fallbacks: string[];
  };
}

export interface RoutingDecision {
  kind: string;
  choice: string;
  confidence: number;
}

/** Accepted judgments for one route; an absent field leaves that part of the call as requested. */
export interface RouteChoice {
  agent?: string;
  effort?: TaskEffort;
  agentConfidence?: number;
  effortConfidence?: number;
  /** Spawn label to write when the call has none, so the spawn hook can find this route's budget decision. */
  name?: string;
}

/** Accepted answers from one native judgment; an absent field was not asked or not confident enough. */
export interface JudgedRoute {
  agent?: string;
  difficulty?: TaskDifficulty;
  agentConfidence?: number;
  difficultyConfidence?: number;
  /** The agent question was asked but no legal answer cleared `minimumConfidence`. */
  agentUndecided?: boolean;
}

/** Why a route kept its requested agent without a usable judgment. */
export type KeptReason = "workflow-owned or unknown agent" | "no alternatives" | "judge unavailable" | "judge failed" | "timed out";

export type RouteOutcome = JudgedRoute | KeptReason;

const DESCRIPTION_LIMIT = 320;
const MAX_ROUTING_DEADLINE_MS = 8_000;
const TOOL_CALL_SAFETY_MARGIN_MS = 1_000;
const MINIMUM_USEFUL_DEADLINE_MS = 250;

/** Fit routing safely inside OMP's scoped tool-call handler timeout. */
export function routingDeadlineMs(toolCallTimeoutMs: unknown): number | undefined {
  if (typeof toolCallTimeoutMs !== "number" || !Number.isFinite(toolCallTimeoutMs)) return undefined;
  const deadline = Math.min(MAX_ROUTING_DEADLINE_MS, Math.floor(toolCallTimeoutMs) - TOOL_CALL_SAFETY_MARGIN_MS);
  return deadline >= MINIMUM_USEFUL_DEADLINE_MS ? deadline : undefined;
}

const AVAILABLE_AGENTS_HEADING = "# Available Agents";
const AGENT_HEADING_PATTERN = /^###\s+([A-Za-z0-9_-]+)(?:\s|$)/;
const AGENT_BULLET_PATTERN = /^-\s+`([A-Za-z0-9_-]+)`(?:\s|:|$)/;

/**
 * Read the spawnable agent names out of the live `task` tool description. The
 * host renders that list after applying the session's spawn policy and
 * disabled-agent settings, so it is the only authoritative legal set a plugin
 * can observe from a `tool_call` hook. An absent or unrecognized section is
 * unknown; only an explicit disabled message means an empty legal set.
 */
export function parseLegalAgentNames(taskDescription: string): string[] | undefined {
  const headingIndex = taskDescription.indexOf(AVAILABLE_AGENTS_HEADING);
  if (headingIndex < 0) return undefined;
  const names: string[] = [];
  const section = taskDescription.slice(headingIndex + AVAILABLE_AGENTS_HEADING.length);
  let disabled = false;
  for (const line of section.split("\n")) {
    if (/^#{1,2}(?:\s|$)/.test(line)) break;
    if (line.includes("Agent spawning is currently disabled.")) disabled = true;
    const name = AGENT_HEADING_PATTERN.exec(line)?.[1] ?? AGENT_BULLET_PATTERN.exec(line)?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length) return names;
  return disabled ? [] : undefined;
}

function compactDescription(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= DESCRIPTION_LIMIT) return compact;
  return `${compact.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Parse only valid ordinary task-tool wire shapes; malformed calls remain untouched. */
export function parseTaskInput(input: unknown): ParsedTaskRoute[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;

  if (Object.hasOwn(record, "tasks")) {
    if (!Array.isArray(record.tasks) || record.tasks.length === 0) return undefined;
    if (Object.hasOwn(record, "task")) return undefined;
    const context = optionalNonEmptyString(record.context);
    if (!context) return undefined;

    const routes: ParsedTaskRoute[] = [];
    for (const [index, rawItem] of record.tasks.entries()) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return undefined;
      const item = rawItem as Record<string, unknown>;
      const assignment = optionalNonEmptyString(item.task);
      if (!assignment) return undefined;
      if (Object.hasOwn(item, "agent") && typeof item.agent !== "string") return undefined;
      const name = optionalNonEmptyString(item.name);
      routes.push({
        index,
        assignment,
        context,
        requestedAgent: optionalNonEmptyString(item.agent),
        ...(name ? { name } : {}),
      });
    }
    return routes;
  }

  const assignment = optionalNonEmptyString(record.task);
  if (!assignment) return undefined;
  if (Object.hasOwn(record, "agent") && typeof record.agent !== "string") return undefined;
  const context = optionalNonEmptyString(record.context);
  const name = optionalNonEmptyString(record.name);
  return [
    {
      index: null,
      assignment,
      ...(context ? { context } : {}),
      requestedAgent: optionalNonEmptyString(record.agent),
      ...(name ? { name } : {}),
    },
  ];
}

function rewriteTaskItem(
  item: Record<string, unknown>,
  requestedAgent: string | undefined,
  choice: RouteChoice | undefined,
): Record<string, unknown> {
  const agentChanged = choice?.agent !== undefined && choice.agent !== requestedAgent;
  const effortChanged = choice?.effort !== undefined && choice.effort !== item.effort;
  const nameAdded = choice?.name !== undefined && optionalNonEmptyString(item.name) === undefined;
  if (!agentChanged && !effortChanged && !nameAdded) return item;
  return {
    ...item,
    ...(agentChanged ? { agent: choice.agent } : {}),
    ...(effortChanged ? { effort: choice.effort } : {}),
    ...(nameAdded ? { name: choice.name } : {}),
  };
}

export function rewriteTaskRoutes(
  input: Record<string, unknown>,
  routes: readonly ParsedTaskRoute[],
  choices: readonly (RouteChoice | undefined)[],
): Record<string, unknown> {
  if (routes.length !== choices.length) return input;

  const flatRoute = routes.length === 1 && routes[0]?.index === null ? routes[0] : undefined;
  if (flatRoute) return rewriteTaskItem(input, flatRoute.requestedAgent, choices[0]);

  if (!Array.isArray(input.tasks)) return input;
  let changed = false;
  const tasks = [...input.tasks];
  for (const [routeIndex, route] of routes.entries()) {
    if (route.index === null) continue;
    const item = tasks[route.index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return input;
    const rewritten = rewriteTaskItem(item as Record<string, unknown>, route.requestedAgent, choices[routeIndex]);
    if (rewritten === item) continue;
    tasks[route.index] = rewritten;
    changed = true;
  }
  return changed ? { ...input, tasks } : input;
}

/** Produce the bounded candidate data allowed to leave the host for routing. */
export function serializeCandidate(candidate: RoutingCandidate): SerializedCandidate {
  const declared = candidate.declaredModelPatterns?.filter(Boolean);
  return {
    name: candidate.name,
    description: compactDescription(candidate.description),
    source: candidate.source,
    access: candidate.readOnly ? "read-only" : "write-capable",
    model: {
      ...(declared && declared.length > 0 ? { declared: [...declared] } : {}),
      effective: [...candidate.model.patterns],
      ...(candidate.model.role ? { role: candidate.model.role } : {}),
      ...(candidate.model.selected ? { selected: candidate.model.selected } : {}),
      fallbacks: [...candidate.model.fallbackChain],
    },
  };
}

/** Workflow-owned review roles retain their own agent and effort policy. */
const RESERVED_AGENT_PREFIX = "audit-";
const RESERVED_AGENT_NAMES: Record<string, true> = { metis: true, momus: true, oracle: true };

/** Candidates consistent with the requested authority, or undefined when access is unresolved. */
export function routableCandidates<T extends { name: string; readOnly: boolean }>(
  requestedAgent: string | undefined,
  candidates: readonly T[],
): T[] | undefined {
  if (requestedAgent && (requestedAgent.startsWith(RESERVED_AGENT_PREFIX) || Object.hasOwn(RESERVED_AGENT_NAMES, requestedAgent))) {
    return undefined;
  }
  const requested = requestedAgent ? candidates.find((candidate) => candidate.name === requestedAgent) : undefined;
  if (requestedAgent && !requested) return undefined;
  return candidates.filter(
    (candidate) =>
      !candidate.name.startsWith(RESERVED_AGENT_PREFIX) &&
      !Object.hasOwn(RESERVED_AGENT_NAMES, candidate.name) &&
      (!requested?.readOnly || candidate.readOnly),
  );
}

/** Accept only a legal, sufficiently confident answer from a native judgment transport. */
export function acceptRoutingDecision<T extends string>(
  decision: RoutingDecision,
  legalChoices: readonly T[],
  minimumConfidence: number,
): T | undefined {
  if (decision.kind !== "native") return undefined;
  if (!Number.isFinite(decision.confidence) || decision.confidence < minimumConfidence) return undefined;
  return legalChoices.find((choice) => choice === decision.choice);
}

/** A spawn candidate resolved to a registry model that carries a catalog intelligence score and price. */
export interface ScoredModelOption {
  /** The selector exactly as configured, so its thinking suffix and routing survive. */
  pattern: string;
  intelligence: number;
  /** USD per million tokens, blended 3:1 input to output. */
  blendedPrice: number;
}

/** Minimum share of the strongest option's intelligence an option needs to be eligible, per budget and difficulty. */
const CAPABILITY_FLOORS: Record<Exclude<ModelBudget, "off" | "max">, Record<TaskDifficulty, number>> = {
  minimum: { routine: 0.7, standard: 0.8, demanding: 0.95 },
  balanced: { routine: 0.8, standard: 0.9, demanding: 1 },
};

export function blendedPrice(cost: { input: number; output: number }): number {
  return (3 * cost.input + cost.output) / 4;
}

/**
 * Pick the spawn model for a budget. `max` takes the strongest option; the other
 * budgets take the cheapest option whose intelligence clears a floor relative to
 * the strongest one, so a weak last-resort fallback is never chosen to save money.
 */
export function chooseBudgetModel(
  options: readonly ScoredModelOption[],
  difficulty: TaskDifficulty,
  budget: Exclude<ModelBudget, "off">,
): ScoredModelOption | undefined {
  const strongest = Math.max(...options.map((option) => option.intelligence));
  if (!Number.isFinite(strongest) || strongest <= 0) return undefined;
  if (budget === "max") {
    return options.reduce<ScoredModelOption | undefined>(
      (best, option) =>
        !best ||
        option.intelligence > best.intelligence ||
        (option.intelligence === best.intelligence && option.blendedPrice < best.blendedPrice)
          ? option
          : best,
      undefined,
    );
  }
  const floor = strongest * CAPABILITY_FLOORS[budget][difficulty];
  return options
    .filter((option) => option.intelligence >= floor)
    .reduce<ScoredModelOption | undefined>(
      (best, option) =>
        !best ||
        option.blendedPrice < best.blendedPrice ||
        (option.blendedPrice === best.blendedPrice && option.intelligence > best.intelligence)
          ? option
          : best,
      undefined,
    );
}

export interface PendingSpawnRoute {
  /** Agent the rewritten call spawns; absent when the call relies on the host's default agent. */
  agent?: string;
  difficulty: TaskDifficulty;
}

const PENDING_SPAWN_LIMIT = 256;
const SPAWN_SUFFIX_PATTERN = /-\d+$/;

/**
 * Budget decisions made at `tool_call` time, waiting for the matching
 * `before_subagent_spawn`. That event carries no assignment, only a spawn key the
 * host derives from the task item's `name` (`<parent>.<name>`, `-N` on collision),
 * so decisions are keyed by name. A name claimed twice is dropped for both spawns.
 */
export class PendingSpawnRoutes {
  #routes = new Map<string, PendingSpawnRoute | null>();

  add(name: string, route: PendingSpawnRoute): void {
    if (this.#routes.has(name)) {
      this.#routes.set(name, null);
      return;
    }
    this.#routes.set(name, route);
    while (this.#routes.size > PENDING_SPAWN_LIMIT) {
      const oldest = this.#routes.keys().next().value;
      if (oldest === undefined) break;
      this.#routes.delete(oldest);
    }
  }

  /** Consume the decision for a spawn of `agent`, if one is unambiguously pending under this key. */
  take(spawnKey: string, agent: string): PendingSpawnRoute | undefined {
    const leaf = spawnKey.slice(spawnKey.lastIndexOf(".") + 1);
    for (const name of [leaf, leaf.replace(SPAWN_SUFFIX_PATTERN, "")]) {
      if (!this.#routes.has(name)) continue;
      const route = this.#routes.get(name);
      this.#routes.delete(name);
      if (!route || (route.agent !== undefined && route.agent !== agent)) return undefined;
      return route;
    }
    return undefined;
  }
}
