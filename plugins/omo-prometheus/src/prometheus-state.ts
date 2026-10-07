import type { AtlasRow, AtlasSnapshot } from "./herdr-dag-contract.ts";
import type { PrometheusPhase } from "./workflow.ts";

export const PROMETHEUS_STATE_KIND = "omo-prometheus/state";

export type PrometheusStatePhase = "planning" | "awaiting-approval" | "executing";

export interface PrometheusStateRow {
  id: string;
  title: string;
  status: AtlasRow["status"];
  kind: AtlasRow["kind"];
  agent: string;
  dependsOn: string[];
  attempt?: string;
  startedAt?: number;
  evidence?: string;
  /** Fix rows name the gate that requested them. */
  origin?: string;
  /** Native child observed for the row's current attempt. */
  child?: { id: string; status: string; currentTool?: string };
}

export interface PrometheusStateGate {
  id: string;
  title: string;
  /** `done` means the gate passed with verified evidence. */
  status: AtlasRow["status"];
  evidence?: string;
}

export interface PrometheusAtlasState {
  planId?: string;
  name?: string;
  /** Why execution is paused; dispatch and completion are refused until it clears. */
  paused?: string;
  /** The remaining fields appear once the live ledger observation has published. */
  status?: string;
  done?: number;
  total?: number;
  startedAt?: number;
  runningChildren?: number;
  rows?: PrometheusStateRow[];
  gates?: PrometheusStateGate[];
}

export interface PrometheusStateV1 {
  kind: typeof PROMETHEUS_STATE_KIND;
  version: 1;
  phase: PrometheusStatePhase;
  /** Prometheus proposal (`local://` URL) while planning. */
  planFilePath?: string;
  atlas?: PrometheusAtlasState;
}

export interface PrometheusStateInput {
  phase: PrometheusPhase;
  proposalAwaitingApproval?: boolean;
  planFilePath?: string;
  atlasPlanId?: string;
  planName?: string;
  ledgerError?: string;
  /** The snapshot last published to the Herdr DAG contract for the bound plan. */
  snapshot?: AtlasSnapshot;
}

const RUNNING: Record<string, true> = { started: true, running: true };

/** Output-only sidecar payload; `null` while no workflow is active. */
export function prometheusState(input: PrometheusStateInput): PrometheusStateV1 | null {
  if (input.phase === "idle") return null;
  if (input.phase === "planning") {
    return {
      kind: PROMETHEUS_STATE_KIND,
      version: 1,
      phase: input.proposalAwaitingApproval ? "awaiting-approval" : "planning",
      planFilePath: input.planFilePath,
    };
  }
  const snapshot = input.snapshot?.plan.id === input.atlasPlanId ? input.snapshot : undefined;
  const atlas: PrometheusAtlasState = {
    planId: input.atlasPlanId,
    name: snapshot?.plan.name ?? input.planName,
    paused: input.ledgerError,
  };
  if (snapshot) {
    const running = new Set<string>();
    const rows = snapshot.rows.map((row): PrometheusStateRow => {
      const live = snapshot.live[row.id];
      const current = live && live.attempt === row.attempt ? live : undefined;
      if (current && row.status === "in_progress" && RUNNING[current.status]) running.add(current.childAgentId);
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        kind: row.kind,
        agent: row.agent,
        dependsOn: [...row.dependsOn],
        attempt: row.attempt,
        startedAt: row.startedAt,
        evidence: row.evidence,
        origin: row.origin,
        child: current ? { id: current.childAgentId, status: current.status, currentTool: current.progress?.currentTool } : undefined,
      };
    });
    atlas.status = snapshot.status;
    atlas.done = snapshot.done;
    atlas.total = snapshot.total;
    atlas.startedAt = snapshot.startedAt;
    atlas.runningChildren = running.size;
    atlas.rows = rows;
    atlas.gates = rows
      .filter((row) => row.kind === "gate")
      .map((row) => ({ id: row.id, title: row.title, status: row.status, evidence: row.evidence }));
  }
  return { kind: PROMETHEUS_STATE_KIND, version: 1, phase: "executing", atlas };
}
