export const AUDIT_AGENTS: readonly string[] = ["audit-auditor", "audit-fixer"];

export const INTENSITIES = ["relaxed", "standard", "strict"] as const;
export type Intensity = (typeof INTENSITIES)[number];

export interface AuditSettings {
  intensity: Intensity;
  /** Undefined means no round limit. */
  maxRounds: number | undefined;
  /** Undefined means only OMP's own task concurrency applies. */
  maxParallelLanes: number | undefined;
}

export interface RoundRecord {
  round: number;
  critical: number;
  major: number;
  minor: number;
  picky: number;
  rejected: number;
  /** Verified findings whose root cause lies in code the loop itself changed since its baseline. */
  loopInduced: number;
}

export type Verdict = "continue" | "converged" | "self-feeding" | "cap-reached";

export interface AuditState {
  version: 1;
  status: "active" | "ended";
  goalId: string;
  target: string;
  intensity: Intensity;
  /** Null means no round limit. */
  maxRounds: number | null;
  /** Null means neither the plugin nor the host reported a concurrency limit. */
  laneLimit: number | null;
  /** HEAD when the loop started; commits after it belong to the loop. Null outside a git repository. */
  baseline: string | null;
  rounds: RoundRecord[];
  capPending: boolean;
  /** Tools this plugin activated for the loop and must deactivate when it ends. */
  addedTools: string[];
}

export const DEFAULT_SETTINGS: AuditSettings = { intensity: "standard", maxRounds: undefined, maxParallelLanes: undefined };

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer or empty`);
  }
  return value;
}

export function parseSettings(raw: Record<string, unknown>): AuditSettings {
  const intensity = raw.intensity ?? DEFAULT_SETTINGS.intensity;
  if (typeof intensity !== "string" || !(INTENSITIES as readonly string[]).includes(intensity)) {
    throw new Error(`intensity must be one of ${INTENSITIES.join(", ")}`);
  }
  return {
    intensity: intensity as Intensity,
    maxRounds: optionalPositiveInteger(raw.maxRounds, "maxRounds"),
    maxParallelLanes: optionalPositiveInteger(raw.maxParallelLanes, "maxParallelLanes"),
  };
}

/** OMP's own `task.maxConcurrency` always caps the plugin setting. */
export function effectiveLaneLimit(configured: number | undefined, hostMaxConcurrency: unknown): number | null {
  const host =
    typeof hostMaxConcurrency === "number" && Number.isInteger(hostMaxConcurrency) && hostMaxConcurrency > 0
      ? hostMaxConcurrency
      : undefined;
  if (configured === undefined) return host ?? null;
  return host === undefined ? configured : Math.min(configured, host);
}

function blocking(record: RoundRecord): number {
  return record.critical + record.major;
}

export function exitGateMet(intensity: Intensity, rounds: readonly RoundRecord[]): boolean {
  const last = rounds.at(-1);
  if (!last) return false;
  if (intensity === "relaxed") return blocking(last) === 0;
  const previous = rounds.at(-2);
  if (!previous) return false;
  if (intensity === "standard") return blocking(last) === 0 && blocking(previous) === 0;
  return blocking(last) + last.minor === 0 && blocking(previous) + previous.minor === 0;
}

/** Severity strictly falls when the (critical, major, minor, picky) tuple is lexicographically smaller. */
function severityFell(current: RoundRecord, previous: RoundRecord): boolean {
  const a = [current.critical, current.major, current.minor, current.picky];
  const b = [previous.critical, previous.major, previous.minor, previous.picky];
  for (let index = 0; index < a.length; index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/**
 * The loop is fixing its own fixes: either every finding of the last round is loop-induced while severity falls,
 * or loop-induced findings make up at least half of each of the last two rounds.
 */
export function selfFeedingSignal(rounds: readonly RoundRecord[]): boolean {
  const last = rounds.at(-1);
  const previous = rounds.at(-2);
  if (!last || !previous) return false;
  const found = (record: RoundRecord) => blocking(record) + record.minor + record.picky;
  const lastFound = found(last);
  if (lastFound > 0 && last.loopInduced === lastFound && severityFell(last, previous)) return true;
  return [last, previous].every((record) => found(record) > 0 && record.loopInduced * 2 >= found(record));
}

export function verdict(state: Pick<AuditState, "intensity" | "maxRounds" | "rounds">): Verdict {
  if (exitGateMet(state.intensity, state.rounds)) return "converged";
  if (state.maxRounds !== null && state.rounds.length >= state.maxRounds) return "cap-reached";
  if (selfFeedingSignal(state.rounds)) return "self-feeding";
  return "continue";
}

export interface ExtensionChoice {
  label: string;
  /** Null removes the limit; undefined stops the audit. */
  newLimit: number | null | undefined;
}

export function extensionChoices(currentLimit: number): ExtensionChoice[] {
  const half = Math.ceil(currentLimit / 2);
  const additions = half === currentLimit ? [currentLimit] : [half, currentLimit];
  return [
    ...additions.map((add) => ({
      label: `Add ${add} round${add === 1 ? "" : "s"} (limit ${currentLimit + add})`,
      newLimit: currentLimit + add,
    })),
    { label: "Remove the round limit", newLimit: null },
    { label: "Stop the audit", newLimit: undefined },
  ];
}

/** Returns an error message, or undefined when the record is acceptable as the next round. */
export function validateRound(state: AuditState, input: RoundRecord): string | undefined {
  if (state.capPending) return "The round limit is exhausted. Report to the user, then call audit_round with op=extend.";
  const expected = state.rounds.length + 1;
  if (input.round !== expected) return `Round ${input.round} is out of order; the next round to record is ${expected}.`;
  for (const key of ["critical", "major", "minor", "picky", "rejected", "loopInduced"] as const) {
    const value = input[key];
    if (!Number.isInteger(value) || value < 0) return `${key} must be a non-negative integer.`;
  }
  if (input.loopInduced > input.critical + input.major + input.minor + input.picky) {
    return "loopInduced cannot exceed the round's verified findings.";
  }
  return undefined;
}

export function totals(rounds: readonly RoundRecord[]): Omit<RoundRecord, "round"> {
  const sum = { critical: 0, major: 0, minor: 0, picky: 0, rejected: 0, loopInduced: 0 };
  for (const round of rounds) {
    sum.critical += round.critical;
    sum.major += round.major;
    sum.minor += round.minor;
    sum.picky += round.picky;
    sum.rejected += round.rejected;
    sum.loopInduced += round.loopInduced;
  }
  return sum;
}

export function limitLabel(maxRounds: number | null): string {
  return maxRounds === null ? "unlimited" : `${maxRounds} rounds`;
}

export function laneLabel(laneLimit: number | null): string {
  return laneLimit === null ? "no fixed limit" : String(laneLimit);
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) rendered = rendered.replaceAll(`{{${key}}}`, value);
  const leftover = /\{\{(\w+)\}\}/.exec(rendered);
  if (leftover) throw new Error(`prompt asset references unknown placeholder ${leftover[0]}`);
  return rendered;
}

export function isAuditAgent(name: unknown): boolean {
  return typeof name === "string" && AUDIT_AGENTS.includes(name);
}

/** Counts audit-agent items in a `task` call; the host defaults an omitted agent to `task`. */
export function auditItemsIn(input: Record<string, unknown>): number {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
  let count = 0;
  for (const item of tasks) {
    if (item && typeof item === "object" && "agent" in item && isAuditAgent(item.agent)) count++;
  }
  return count;
}
