import {
  type AuditState,
  type ConclusionEvidence,
  type ConclusionKind,
  type Finding,
  remainingFindings,
  type Severity,
  type SeverityCounts,
  totals,
  type Verdict,
  verdict,
} from "#src/ledger.ts";

export const AUDIT_PAYLOAD_KIND = "audit-goal/audit";

export type AuditPayloadStatus = "running" | "awaiting-limit-decision" | "converged" | "saturated" | "stopped";

export interface AuditPayloadRound {
  index: number;
  counts: SeverityCounts;
  rejected: number;
  loopInduced: number;
  /** Exit-gate verdict after this round, evaluated against the current round limit. */
  verdict: Verdict;
}

export interface AuditPayloadFinding {
  id: string;
  severity: Severity;
  summary: string;
  origin: Finding["origin"];
}

export interface AuditPayload {
  kind: typeof AUDIT_PAYLOAD_KIND;
  version: 1;
  status: AuditPayloadStatus;
  /** True once the audit goal completed, was dropped, or was replaced. */
  ended: boolean;
  target: string;
  intensity: AuditState["intensity"];
  maxRounds: number | null;
  laneLimit: number | null;
  baseline: string | null;
  rounds: AuditPayloadRound[];
  totals: SeverityCounts & { rejected: number; loopInduced: number };
  openFindings: { counts: SeverityCounts; items: AuditPayloadFinding[] };
  conclusion: { kind: ConclusionKind; reason: string; evidence: ConclusionEvidence[] } | null;
  stopReason: string | null;
  artifactAccepted: false;
}

/** Published when the latest persisted ledger entry is malformed or could not be saved. */
export interface InvalidAuditPayload {
  kind: typeof AUDIT_PAYLOAD_KIND;
  version: 1;
  status: "invalid";
}

const STATUS_BY_CONCLUSION: Record<ConclusionKind, AuditPayloadStatus> = {
  "threshold-convergence": "converged",
  "capability-saturation": "saturated",
  stop: "stopped",
};

export function invalidAuditPayload(): InvalidAuditPayload {
  return { kind: AUDIT_PAYLOAD_KIND, version: 1, status: "invalid" };
}

/** Derives the sidecar payload from the persisted ledger; never a second source of truth. */
export function auditPayload(state: AuditState): AuditPayload {
  const remaining = remainingFindings(state.rounds);
  const conclusion = state.conclusion;
  return {
    kind: AUDIT_PAYLOAD_KIND,
    version: 1,
    status: conclusion ? STATUS_BY_CONCLUSION[conclusion.kind] : state.capPending ? "awaiting-limit-decision" : "running",
    ended: state.status === "ended",
    target: state.target,
    intensity: state.intensity,
    maxRounds: state.maxRounds,
    laneLimit: state.laneLimit,
    baseline: state.baseline,
    rounds: state.rounds.map((round, index) => ({
      index: round.round,
      counts: { critical: round.critical, major: round.major, minor: round.minor, picky: round.picky },
      rejected: round.rejected,
      loopInduced: round.loopInduced,
      verdict: verdict({ intensity: state.intensity, maxRounds: state.maxRounds, rounds: state.rounds.slice(0, index + 1) }),
    })),
    totals: totals(state.rounds),
    openFindings: {
      counts: remaining.counts,
      items: remaining.findings.map(({ id, severity, summary, origin }) => ({ id, severity, summary, origin })),
    },
    conclusion: conclusion ? { kind: conclusion.kind, reason: conclusion.reason, evidence: conclusion.evidence } : null,
    stopReason: conclusion?.kind === "stop" ? conclusion.reason : null,
    artifactAccepted: false,
  };
}
