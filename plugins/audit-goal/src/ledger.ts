import { isRecord } from "./type-guard.ts";

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

export const SEVERITIES = ["critical", "major", "minor", "picky"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type SeverityCounts = Record<Severity, number>;

export interface Finding {
  id: string;
  severity: Severity;
  summary: string;
  evidence: string;
  origin: "pre-existing" | "loop-induced";
  /** A finding fixed in its discovery round still counts as discovered, but is not open. */
  status: "open" | "resolved";
  resolution?: string;
}

export interface Resolution {
  findingId: string;
  evidence: string;
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
  /** Auditor model identities used this round; comparable model sets inform saturation. */
  auditorModels: string[];
  coverage: string;
  checks: string;
  findings: Finding[];
  resolutions: Resolution[];
  rejectedEvidence: string[];
}

export type Verdict = "continue" | "threshold-ready" | "cap-reached";
export type ConclusionKind = "threshold-convergence" | "capability-saturation" | "stop";

export interface ConclusionEvidence {
  round: number;
  observation: string;
}

export interface RemainingFindings {
  counts: SeverityCounts;
  findings: Finding[];
}

export interface AuditConclusion {
  kind: ConclusionKind;
  reason: string;
  evidence: ConclusionEvidence[];
  remaining: RemainingFindings;
  /** An audit conclusion never constitutes the user's acceptance of the audited artifact. */
  artifactAccepted: false;
}

export interface AuditState {
  version: 2;
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
  conclusion: AuditConclusion | null;
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
  if (exitGateMet(state.intensity, state.rounds)) return "threshold-ready";
  if (state.maxRounds !== null && state.rounds.length >= state.maxRounds) return "cap-reached";
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

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns an error message, or undefined when the record is acceptable as the next round. */
export function validateRound(state: AuditState, input: RoundRecord): string | undefined {
  if (state.conclusion) return "The audit already has a recorded conclusion; no further rounds can be recorded.";
  if (state.capPending) return "The round limit is exhausted. Report to the user, then call audit_round with op=extend.";
  const expected = state.rounds.length + 1;
  if (input.round !== expected) return `Round ${input.round} is out of order; the next round to record is ${expected}.`;
  for (const key of ["critical", "major", "minor", "picky", "rejected", "loopInduced"] as const) {
    const value = input[key];
    if (!Number.isSafeInteger(value) || value < 0) return `${key} must be a non-negative integer.`;
  }
  if (
    !Array.isArray(input.auditorModels) ||
    input.auditorModels.length === 0 ||
    input.auditorModels.some((model) => !nonempty(model)) ||
    new Set(input.auditorModels).size !== input.auditorModels.length ||
    !nonempty(input.coverage) ||
    !nonempty(input.checks)
  ) {
    return "auditorModels (a nonempty set), coverage, and checks must contain concrete round evidence.";
  }
  if (!Array.isArray(input.findings) || !Array.isArray(input.resolutions) || !Array.isArray(input.rejectedEvidence)) {
    return "findings, resolutions, and rejectedEvidence must be arrays (empty arrays are allowed).";
  }
  const existing = new Set<string>();
  for (const round of state.rounds) for (const finding of round.findings) existing.add(finding.id);
  const open = new Set<string>();
  for (const finding of remainingFindings(state.rounds).findings) open.add(finding.id);
  const discovered: SeverityCounts = { critical: 0, major: 0, minor: 0, picky: 0 };
  let induced = 0;
  for (const finding of input.findings) {
    if (
      !isRecord(finding) ||
      !nonempty(finding.id) ||
      !nonempty(finding.summary) ||
      !nonempty(finding.evidence) ||
      !SEVERITIES.includes(finding.severity as Severity) ||
      (finding.origin !== "pre-existing" && finding.origin !== "loop-induced") ||
      (finding.status !== "open" && finding.status !== "resolved") ||
      (finding.status === "resolved" && !nonempty(finding.resolution)) ||
      (finding.status === "open" && finding.resolution !== undefined)
    )
      return "Each finding needs a unique id, severity, summary, evidence, origin, status, and resolution evidence when resolved.";
    if (existing.has(finding.id)) return `Finding ${finding.id} was already recorded; use resolutions for earlier findings.`;
    existing.add(finding.id);
    discovered[finding.severity as Severity]++;
    if (finding.origin === "loop-induced") induced++;
  }
  for (const resolution of input.resolutions) {
    if (!isRecord(resolution) || !nonempty(resolution.findingId) || !nonempty(resolution.evidence) || !open.delete(resolution.findingId)) {
      return "Each resolution must cite a distinct, previously open finding ID and concrete repair evidence.";
    }
  }
  for (const rejected of input.rejectedEvidence) {
    if (!nonempty(rejected)) return "Each rejected finding needs a concrete rejection reason.";
  }
  if (SEVERITIES.some((severity) => discovered[severity] !== input[severity])) {
    return "Severity counts must match the verified findings listed in this round.";
  }
  if (input.rejectedEvidence.length !== input.rejected || induced !== input.loopInduced) {
    return "rejected and loopInduced must match the listed evidence and provenance.";
  }
  return undefined;
}

export function totals(rounds: readonly RoundRecord[]): SeverityCounts & { rejected: number; loopInduced: number } {
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

export function remainingFindings(rounds: readonly RoundRecord[]): RemainingFindings {
  const open = new Map<string, Finding>();
  for (const round of rounds) {
    for (const resolution of round.resolutions) open.delete(resolution.findingId);
    for (const finding of round.findings) if (finding.status === "open") open.set(finding.id, finding);
  }
  const findings = [...open.values()];
  const counts: SeverityCounts = { critical: 0, major: 0, minor: 0, picky: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return { counts, findings };
}

export function validateConclusion(
  state: AuditState,
  kind: ConclusionKind,
  reason: string,
  evidence: ConclusionEvidence[],
): string | undefined {
  if (!["threshold-convergence", "capability-saturation", "stop"].includes(kind)) return "Unknown audit conclusion kind.";
  if (!nonempty(reason)) return "A conclusion needs a concrete reason.";
  if (!Array.isArray(evidence)) return "Conclusion evidence must be an array.";
  const cited = new Set<number>();
  for (const entry of evidence) {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.round) ||
      entry.round < 1 ||
      entry.round > state.rounds.length ||
      !nonempty(entry.observation) ||
      cited.has(entry.round)
    ) {
      return "Each conclusion observation must cite a distinct recorded round and concrete evidence.";
    }
    cited.add(entry.round);
  }
  if (kind === "stop") return undefined;
  if (state.capPending) return "The round limit requires an explicit user extension or stop decision.";
  if (!cited.has(state.rounds.length)) return "Conclusion evidence must include the latest round.";
  if (kind === "threshold-convergence") {
    return exitGateMet(state.intensity, state.rounds) ? undefined : "The configured intensity exit gate is not met.";
  }
  if (state.maxRounds !== null)
    return "Capability saturation is available only with an unlimited round limit; handle the finite cap explicitly.";
  if (exitGateMet(state.intensity, state.rounds)) return "The exit gate is met; use threshold convergence instead.";
  if (state.rounds.length < 3) return "Capability saturation needs at least three documented rounds.";
  const first = state.rounds[state.rounds.length - 3];
  if (!first) return "Capability saturation needs at least three documented rounds.";
  let variedCoverage = false;
  for (let index = state.rounds.length - 3; index < state.rounds.length; index++) {
    const round = state.rounds[index];
    if (!round) return "Capability saturation needs three documented rounds.";
    if (
      round.auditorModels.length !== first.auditorModels.length ||
      round.auditorModels.some((model) => !first.auditorModels.includes(model))
    ) {
      return "Capability saturation needs three comparable rounds audited by the same model set.";
    }
    if (round.coverage !== first.coverage) variedCoverage = true;
    if (!cited.has(round.round)) return "Capability saturation needs concrete observations from each of the last three rounds.";
  }
  if (!variedCoverage) return "Capability saturation needs different documented audit axes, not repeated identical coverage.";
  return undefined;
}

export function createConclusion(state: AuditState, kind: ConclusionKind, reason: string, evidence: ConclusionEvidence[]): AuditConclusion {
  return { kind, reason: reason.trim(), evidence, remaining: remainingFindings(state.rounds), artifactAccepted: false };
}

/** Persisted session entries are untrusted after import, branch selection, or manual edits. */
export function restoreAuditState(raw: unknown): AuditState | undefined {
  if (!isRecord(raw) || raw.version !== 2 || !["active", "ended"].includes(raw.status as string)) return undefined;
  if (!nonempty(raw.goalId) || !nonempty(raw.target) || !INTENSITIES.includes(raw.intensity as Intensity)) return undefined;
  if (
    (raw.maxRounds !== null && (typeof raw.maxRounds !== "number" || !Number.isSafeInteger(raw.maxRounds) || raw.maxRounds < 1)) ||
    (raw.laneLimit !== null && (typeof raw.laneLimit !== "number" || !Number.isSafeInteger(raw.laneLimit) || raw.laneLimit < 1))
  )
    return undefined;
  if (raw.baseline !== null && typeof raw.baseline !== "string") return undefined;
  if (!Array.isArray(raw.rounds) || typeof raw.capPending !== "boolean" || !Array.isArray(raw.addedTools)) return undefined;
  if (raw.addedTools.some((name) => name !== "goal" && name !== "audit_round") || new Set(raw.addedTools).size !== raw.addedTools.length)
    return undefined;
  if (raw.conclusion !== null && !isRecord(raw.conclusion)) return undefined;
  let state: AuditState;
  try {
    state = structuredClone(raw) as unknown as AuditState;
  } catch {
    return undefined;
  }
  const verified: RoundRecord[] = [];
  for (const round of state.rounds) {
    if (!isRecord(round) || validateRound({ ...state, rounds: verified, capPending: false, conclusion: null }, round)) return undefined;
    verified.push(round);
  }
  if (state.maxRounds !== null && state.rounds.length > state.maxRounds) return undefined;
  if (state.capPending !== (state.conclusion === null && verdict(state) === "cap-reached")) return undefined;
  if (state.status === "ended" && state.conclusion === null) return undefined;
  if (state.conclusion) {
    const { kind, reason, evidence, remaining, artifactAccepted } = state.conclusion;
    if (validateConclusion({ ...state, capPending: false }, kind, reason, evidence)) return undefined;
    if (!isRecord(remaining) || artifactAccepted !== false || JSON.stringify(remaining) !== JSON.stringify(remainingFindings(state.rounds)))
      return undefined;
  }
  return state;
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
