import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export interface RoadmapStage {
  repoRoot: string;
  id: string;
}

export interface RoadmapBinding {
  v: 1;
  sessionId: string;
  requestId: string;
  repoRoot: string;
  toolSourcePath: string;
  stage?: { id: string; title: string; round: string };
}

export interface AtlasCompleted {
  v: 1;
  sessionId: string;
  planId: string;
  roadmapStage: RoadmapStage;
  gates: Array<{ gateId: string; verdict: string; summary: string }>;
  /** Present when the plan delivers through a pull request; emitted only after its P1 row is done. */
  delivery?: { mode: "pr" | "ship"; summary: string };
  at: string;
}

interface ContractEvents {
  on(channel: string, listener: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRoadmapStage(value: unknown): value is RoadmapStage {
  return (
    object(value) &&
    typeof value.repoRoot === "string" &&
    isAbsolute(value.repoRoot) &&
    typeof value.id === "string" &&
    /^S\d+$/.test(value.id)
  );
}

/** Optional synchronous handshake; a late answer cannot grant tool provenance, and a missed one is retried on the next request. */
export class RoadmapContract {
  readonly #bindings = new Map<string, RoadmapBinding>();
  readonly #completed = new Set<string>();

  constructor(readonly events: ContractEvents) {}

  requestBinding(sessionId: string): RoadmapBinding | undefined {
    const requestId = randomUUID();
    let binding: RoadmapBinding | undefined;
    const unsubscribe = this.events.on("roadmap:binding", (payload) => {
      if (
        !object(payload) ||
        payload.v !== 1 ||
        payload.sessionId !== sessionId ||
        payload.requestId !== requestId ||
        typeof payload.repoRoot !== "string" ||
        !isAbsolute(payload.repoRoot) ||
        typeof payload.toolSourcePath !== "string" ||
        !isAbsolute(payload.toolSourcePath)
      )
        return;
      if (
        payload.stage !== undefined &&
        (!object(payload.stage) ||
          typeof payload.stage.id !== "string" ||
          !/^S\d+$/.test(payload.stage.id) ||
          typeof payload.stage.title !== "string" ||
          !payload.stage.title.trim() ||
          typeof payload.stage.round !== "string" ||
          !/^R\d+$/.test(payload.stage.round))
      )
        return;
      binding = payload as unknown as RoadmapBinding;
    });
    try {
      this.events.emit("roadmap:binding-request", { v: 1, sessionId, requestId });
    } finally {
      unsubscribe();
    }
    if (binding) this.#bindings.set(sessionId, binding);
    else this.#bindings.delete(sessionId);
    return binding;
  }

  /** The tool source is stable for a session, so a confirmed answer is reused; the bound stage may be stale. */
  binding(sessionId: string): RoadmapBinding | undefined {
    return this.#bindings.get(sessionId) ?? this.requestBinding(sessionId);
  }

  emitCompleted(event: Omit<AtlasCompleted, "v" | "at">): void {
    if (this.#completed.has(event.planId)) return;
    this.#completed.add(event.planId);
    this.events.emit("atlas:completed", { ...event, v: 1, at: new Date().toISOString() } satisfies AtlasCompleted);
  }

  forget(sessionId: string): void {
    this.#bindings.delete(sessionId);
  }
}
