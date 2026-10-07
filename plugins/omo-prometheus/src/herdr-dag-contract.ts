import type { AtlasLiveSnapshot, AtlasProgress } from "./atlas-live.ts";
import type { AtlasPlan, AtlasRowDetail } from "./atlas-store.ts";
import type { AtlasEvent } from "./atlas-timeline.ts";

/** Version 1 of the observational pi.events contract; deliberately local to this plugin. */
export interface HerdrDagHello {
  v: 1;
  sessionId: string;
  requestId: string;
}

export type AtlasContractPlan = Pick<AtlasPlan, "id" | "name" | "planFilePath" | "cwd">;
export interface AtlasHello {
  v: 1;
  sessionId: string;
  requestId?: string;
  plan?: AtlasContractPlan;
}
export interface AtlasRow {
  id: string;
  title: string;
  status: "open" | "in_progress" | "done" | "blocked";
  kind: "task" | "fix" | "gate";
  agent: string;
  dispatchAgent?: string;
  dependsOn: string[];
  evidence?: string;
  attempt?: string;
  startedAt?: number;
  childAgentId?: string;
  updatedAt: number;
  origin?: string;
}
export interface AtlasContractLiveRow {
  childAgentId: string;
  status: string;
  attempt: string;
  progress?: Partial<Pick<AtlasProgress, "currentTool" | "tokens" | "cost" | "durationMs" | "resolvedModel" | "recentOutput">>;
}
export interface AtlasSnapshot {
  v: 1;
  sessionId: string;
  plan: AtlasContractPlan;
  status: string;
  done: number;
  total: number;
  startedAt?: number;
  rows: AtlasRow[];
  live: Record<string, AtlasContractLiveRow>;
  timeline: AtlasEvent[];
  at: number;
}
export interface AtlasReleased {
  v: 1;
  sessionId: string;
  planId: string;
  reason: "exit" | "session-switch" | "shutdown";
}
interface ContractEvents {
  on(channel: string, listener: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}
interface Binding {
  plan: AtlasPlan;
  snapshot?: AtlasSnapshot;
  rows: Map<string, AtlasContractLiveRow>;
}

export function contractPlan(plan: AtlasPlan): AtlasContractPlan {
  return { id: plan.id, name: plan.name, planFilePath: plan.planFilePath, cwd: plan.cwd };
}

export function contractRow(row: AtlasRowDetail): AtlasRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    kind: row.id.startsWith("X") ? "fix" : row.id.startsWith("F") ? "gate" : "task",
    agent: row.originalAgent ?? row.agent,
    dispatchAgent: row.dispatchAgent,
    dependsOn: [...row.dependsOn],
    evidence: row.evidence,
    attempt: row.attempt,
    startedAt: row.startedAt,
    childAgentId: row.childAgentId,
    updatedAt: row.updatedAt,
    origin: row.origin,
  };
}

/** Session-scoped producer: never grants ownership or changes execution state. */
export class HerdrDagContract {
  readonly #enabled = new Map<string, boolean>();
  readonly #bindings = new Map<string, Binding>();
  #sessionId?: string;

  constructor(readonly events?: ContractEvents) {
    events?.on("herdr-dag:hello", (payload) => {
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
      const hello = payload as Partial<HerdrDagHello>;
      if (hello.v !== 1 || typeof hello.sessionId !== "string" || typeof hello.requestId !== "string") return;
      if (hello.sessionId !== this.#sessionId || this.#enabled.get(hello.sessionId) !== true) return;
      this.#hello(hello.sessionId, hello.requestId);
      const snapshot = this.#bindings.get(hello.sessionId)?.snapshot;
      if (snapshot) this.#emit(hello.sessionId, "atlas:snapshot", snapshot);
    });
  }

  configure(sessionId: string, enabled: boolean): void {
    this.#sessionId = sessionId;
    this.#enabled.set(sessionId, enabled);
  }

  enabled(sessionId: string): boolean {
    return this.#enabled.get(sessionId) === true;
  }

  announce(sessionId: string): void {
    if (!this.#bindings.has(sessionId)) this.#hello(sessionId);
  }

  #emit(sessionId: string, channel: string, payload: unknown): void {
    if (this.#enabled.get(sessionId) === true) this.events?.emit(channel, payload);
  }

  #hello(sessionId: string, requestId?: string): void {
    const plan = this.#bindings.get(sessionId)?.plan;
    this.#emit(sessionId, "atlas:hello", { v: 1, sessionId, requestId, plan: plan ? contractPlan(plan) : undefined } satisfies AtlasHello);
  }

  bind(sessionId: string, plan: AtlasPlan): void {
    this.#bindings.set(sessionId, { plan, rows: new Map() });
    this.#hello(sessionId);
  }

  publish(sessionId: string, snapshot: AtlasLiveSnapshot): void {
    const binding = this.#bindings.get(sessionId);
    if (!binding || binding.plan.id !== snapshot.detail.plan.id) return;
    // Finished rows leave AtlasLive's map. Retain their last progress, but never carry it into a new attempt.
    const retained = new Map<string, AtlasContractLiveRow>();
    for (const row of snapshot.detail.rows) {
      const previous = binding.rows.get(row.id);
      const live = snapshot.rows.get(row.id);
      if (live && live.attempt === row.attempt) {
        const progress = live.progress;
        retained.set(row.id, {
          childAgentId: live.childAgentId,
          status: live.status,
          attempt: live.attempt,
          progress: progress
            ? {
                currentTool: progress.currentTool,
                tokens: progress.tokens,
                cost: progress.cost,
                durationMs: progress.durationMs,
                resolvedModel: progress.resolvedModel,
                recentOutput: [...progress.recentOutput],
              }
            : previous?.attempt === live.attempt && previous.childAgentId === live.childAgentId
              ? previous.progress
              : undefined,
        });
      } else if (previous && previous.attempt === row.attempt) {
        retained.set(row.id, {
          ...previous,
          status: row.status === "done" ? "completed" : row.status === "blocked" ? "blocked" : previous.status,
        });
      }
    }
    binding.rows = retained;
    const detail = snapshot.detail;
    binding.snapshot = {
      v: 1,
      sessionId,
      plan: contractPlan(detail.plan),
      status: detail.status,
      done: detail.done,
      total: detail.total,
      startedAt: detail.startedAt,
      rows: detail.rows.map(contractRow),
      live: Object.fromEntries(retained),
      timeline: detail.timeline.slice(-50).map((event) => ({ ...event })),
      at: snapshot.at,
    };
    this.#emit(sessionId, "atlas:snapshot", binding.snapshot);
  }

  /** The last snapshot built for the session's bound plan, published or not. */
  snapshot(sessionId: string): AtlasSnapshot | undefined {
    return this.#bindings.get(sessionId)?.snapshot;
  }

  release(sessionId: string, reason: AtlasReleased["reason"]): void {
    const binding = this.#bindings.get(sessionId);
    if (!binding) return;
    this.#bindings.delete(sessionId);
    this.#emit(sessionId, "atlas:released", { v: 1, sessionId, planId: binding.plan.id, reason } satisfies AtlasReleased);
    this.#hello(sessionId);
  }

  forget(sessionId: string): void {
    this.#bindings.delete(sessionId);
    this.#enabled.delete(sessionId);
    if (this.#sessionId === sessionId) this.#sessionId = undefined;
  }
}
