export type IntegrationMode = "standard" | "enhanced";

export interface JevDispatchSettings {
  integrationMode: IntegrationMode;
  minimumConfidence: number;
  includeSharedContext: boolean;
}

export interface RoutingSurfaceSelection {
  surface: IntegrationMode;
  warnAboutEnhancedFallback: boolean;
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
  api: string;
  model: string;
  choice: string;
  confidence: number;
}

const NATIVE_JEV_APIS: Record<string, true> = {
  typesafe: true,
  "openrouter-decisions": true,
};
const JEV_MODEL_ID_PATTERN = /^jev(?:$|[-_.:]|\d)/i;
const DESCRIPTION_LIMIT = 320;
const STANDARD_MAX_DEADLINE_MS = 8_000;
const TOOL_CALL_SAFETY_MARGIN_MS = 1_000;
const MINIMUM_USEFUL_DEADLINE_MS = 250;

/** Select exactly one routing event surface for a session-bound extension instance. */
export function selectRoutingSurface(mode: IntegrationMode, apiVersion: unknown): RoutingSurfaceSelection {
  if (mode === "enhanced" && apiVersion === 1) {
    return { surface: "enhanced", warnAboutEnhancedFallback: false };
  }
  return { surface: "standard", warnAboutEnhancedFallback: mode === "enhanced" };
}

/** Fit standard routing safely inside OMP's scoped tool-call handler timeout. */
export function standardRoutingDeadlineMs(toolCallTimeoutMs: unknown): number | undefined {
  if (typeof toolCallTimeoutMs !== "number" || !Number.isFinite(toolCallTimeoutMs)) return undefined;
  const deadline = Math.min(STANDARD_MAX_DEADLINE_MS, Math.floor(toolCallTimeoutMs) - TOOL_CALL_SAFETY_MARGIN_MS);
  return deadline >= MINIMUM_USEFUL_DEADLINE_MS ? deadline : undefined;
}

function compactDescription(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= DESCRIPTION_LIMIT) return compact;
  return `${compact.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
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

/** Clone only records whose agent changes, preserving effort and every unrelated field. */
export function rewriteTaskAgents(
  input: Record<string, unknown>,
  routes: readonly ParsedTaskRoute[],
  choices: readonly (string | undefined)[],
): Record<string, unknown> {
  if (routes.length !== choices.length) return input;

  const flatRoute = routes.length === 1 && routes[0]?.index === null ? routes[0] : undefined;
  if (flatRoute) {
    const choice = choices[0];
    if (!choice || choice === flatRoute.requestedAgent) return input;
    return { ...input, agent: choice };
  }

  if (!Array.isArray(input.tasks)) return input;
  let changed = false;
  const tasks = [...input.tasks];
  for (const [routeIndex, route] of routes.entries()) {
    const choice = choices[routeIndex];
    if (!choice || route.index === null || choice === route.requestedAgent) continue;
    const item = tasks[route.index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return input;
    tasks[route.index] = { ...(item as Record<string, unknown>), agent: choice };
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

/** Identify native judge candidates whose model id is explicitly Jev. */
export function isNativeJevCandidate(kind: string, label: string): boolean {
  const modelId = label.slice(label.lastIndexOf("/") + 1);
  return kind === "native" && JEV_MODEL_ID_PATTERN.test(modelId);
}

/** Ordinary control-flow error: ChainJudge catches it and advances without invoking this candidate. */
export class NonJevJudgeCandidateError extends Error {
  override readonly name = "NonJevJudgeCandidateError";

  constructor(label: string) {
    super(`jev-dispatch skipped non-Jev judge candidate ${label}`);
  }
}

export function assertNativeJevCandidate(kind: string, label: string): void {
  if (!isNativeJevCandidate(kind, label)) throw new NonJevJudgeCandidateError(label);
}

/** Accept only a legal, sufficiently confident answer from a native Jev transport. */
export function acceptRoutingDecision(
  decision: RoutingDecision,
  candidateNames: readonly string[],
  minimumConfidence: number,
): string | undefined {
  if (!isNativeJevCandidate(decision.kind, decision.model) || NATIVE_JEV_APIS[decision.api] !== true) return undefined;
  if (!Number.isFinite(decision.confidence) || decision.confidence < minimumConfidence) return undefined;
  return candidateNames.includes(decision.choice) ? decision.choice : undefined;
}
