import { randomUUID } from "node:crypto";

import { type AtlasRow, atlasRun, type Run } from "#src/model.ts";

import type { SourceEvents } from "./tasks.ts";

export interface AtlasPlan {
  id: string;
  name: string;
  planFilePath: string;
  cwd: string;
}
export interface HerdrDagHello {
  v: 1;
  sessionId: string;
  requestId: string;
}
export interface AtlasHello {
  v: 1;
  sessionId: string;
  requestId?: string;
  plan?: AtlasPlan;
}
export interface AtlasEvent {
  version: 1;
  at: number;
  kind:
    | "attached"
    | "released"
    | "started"
    | "done"
    | "reopened"
    | "blocked"
    | "fix_added"
    | "gate_passed"
    | "gate_failed"
    | "discovered"
    | "implemented"
    | "verify_started"
    | "verify_passed"
    | "verify_failed";
  row?: string;
  attempt?: string;
  sessionId: string;
  detail?: string;
  derived?: true;
}
export interface AtlasSnapshot {
  v: 1;
  sessionId: string;
  plan: AtlasPlan;
  status: string;
  done: number;
  total: number;
  startedAt?: number;
  rows: AtlasRow[];
  live: Record<
    string,
    {
      childAgentId: string;
      status: string;
      attempt: string;
      progress?: {
        currentTool?: string;
        tokens?: number;
        cost?: number;
        durationMs?: number;
        resolvedModel?: string;
        recentOutput?: string[];
      };
    }
  >;
  timeline: AtlasEvent[];
  at: number;
}
export interface AtlasReleased {
  v: 1;
  sessionId: string;
  planId: string;
  reason: "exit" | "session-switch" | "shutdown";
}
export interface AtlasSourceOptions {
  events: SourceEvents;
  sessionId: string;
  generation?: number;
}
export interface AtlasSourceState {
  available: boolean;
  bound: boolean;
  run?: Run;
  snapshot?: AtlasSnapshot;
}

export class AtlasSource {
  #options: AtlasSourceOptions;
  #state: AtlasSourceState = { available: false, bound: false };
  #pending = new Set<string>();
  #listeners = new Set<(state: AtlasSourceState) => void>();
  #unsubscribe: (() => void)[];
  constructor(options: AtlasSourceOptions) {
    this.#options = options;
    this.#unsubscribe = ["hello", "snapshot", "released"].map((kind) =>
      options.events.on(`atlas:${kind}`, (payload) => {
        if (!payload || typeof payload !== "object") return;
        const frame = payload as AtlasHello | AtlasSnapshot | AtlasReleased;
        if (frame.v !== 1 || frame.sessionId !== this.#options.sessionId) return;
        if (kind === "hello") {
          const hello = frame as AtlasHello;
          if (hello.requestId && !this.#pending.delete(hello.requestId)) return;
          this.#state = hello.plan ? { ...this.#state, available: true, bound: true } : { available: true, bound: false };
          if (hello.plan && this.#state.run?.id !== `atlas:${hello.plan.id}`) {
            this.#state.run = undefined;
            this.#state.snapshot = undefined;
          }
        } else if (kind === "snapshot") {
          const snapshot = frame as AtlasSnapshot;
          if (!snapshot.plan || !Array.isArray(snapshot.rows)) return;
          this.#state = {
            available: true,
            bound: true,
            snapshot,
            run: atlasRun({
              plan: snapshot.plan,
              rows: snapshot.rows,
              previous: this.#state.run,
              generation: options.generation,
              startedAt: snapshot.startedAt,
              at: snapshot.at,
            }),
          };
        } else {
          if (this.#state.run && this.#state.run.id !== `atlas:${(frame as AtlasReleased).planId}`) return;
          this.#state = { available: true, bound: false };
        }
        for (const listener of this.#listeners) listener(this.#state);
      }),
    );
    this.activate();
  }
  get state(): AtlasSourceState {
    return this.#state;
  }
  get run(): Run | undefined {
    return this.#state.run;
  }
  subscribe(listener: (state: AtlasSourceState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }
  activate(): string {
    const requestId = randomUUID();
    this.#pending.clear();
    this.#pending.add(requestId);
    this.#options.events.emit("herdr-dag:hello", { v: 1, sessionId: this.#options.sessionId, requestId } satisfies HerdrDagHello);
    return requestId;
  }
  dispose(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#listeners.clear();
    this.#pending.clear();
  }
}
