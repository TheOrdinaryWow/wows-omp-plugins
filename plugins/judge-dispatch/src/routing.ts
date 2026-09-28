/** Coarse per-spawn thinking effort the host task tool accepts; it maps onto the target model's supported thinking levels. */
export const TASK_EFFORTS = ["lo", "med", "hi"] as const;
export type TaskEffort = (typeof TASK_EFFORTS)[number];

export interface JudgeDispatchSettings {
  minimumConfidence: number;
  includeSharedContext: boolean;
  judgeEffort: boolean;
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
}

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
const AGENT_HEADING_PATTERN = /^###\s+([A-Za-z0-9_-]+)/;

/**
 * Read the spawnable agent names out of the live `task` tool description. The
 * host renders that list after applying the session's spawn policy and
 * disabled-agent settings, so it is the only authoritative legal set a plugin
 * can observe from a `tool_call` hook. Returns `undefined` when the section is absent,
 * which callers MUST treat as "policy unknown" rather than "everything".
 */
export function parseLegalAgentNames(taskDescription: string): string[] | undefined {
  const headingIndex = taskDescription.indexOf(AVAILABLE_AGENTS_HEADING);
  if (headingIndex < 0) return undefined;
  const names: string[] = [];
  for (const line of taskDescription.slice(headingIndex + AVAILABLE_AGENTS_HEADING.length).split("\n")) {
    const match = AGENT_HEADING_PATTERN.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
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
      routes.push({
        index,
        assignment,
        context,
        requestedAgent: optionalNonEmptyString(item.agent),
      });
    }
    return routes;
  }

  const assignment = optionalNonEmptyString(record.task);
  if (!assignment) return undefined;
  if (Object.hasOwn(record, "agent") && typeof record.agent !== "string") return undefined;
  const context = optionalNonEmptyString(record.context);
  return [
    {
      index: null,
      assignment,
      ...(context ? { context } : {}),
      requestedAgent: optionalNonEmptyString(record.agent),
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
  if (!agentChanged && !effortChanged) return item;
  return {
    ...item,
    ...(agentChanged ? { agent: choice.agent } : {}),
    ...(effortChanged ? { effort: choice.effort } : {}),
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

/** The audit-goal plugin dispatches these agents under its own guard; routing must neither leave nor enter them. */
const RESERVED_AGENT_PREFIX = "audit-";

/** Candidates routing may choose from, or undefined when the requested agent is reserved and must be kept. */
export function routableCandidates<T extends { name: string }>(
  requestedAgent: string | undefined,
  candidates: readonly T[],
): T[] | undefined {
  if (requestedAgent?.startsWith(RESERVED_AGENT_PREFIX)) return undefined;
  return candidates.filter((candidate) => !candidate.name.startsWith(RESERVED_AGENT_PREFIX));
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
