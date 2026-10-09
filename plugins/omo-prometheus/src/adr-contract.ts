import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

/** The part of an `adr:binding` reply Prometheus uses; the reply's `api` is never read or called here. */
export interface AdrBinding {
  v: 1;
  sessionId: string;
  requestId: string;
  toolSourcePath: string;
}

interface ContractEvents {
  on(channel: string, listener: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Optional synchronous `adr` v1 handshake; a late answer cannot grant tool provenance, and a missed one is retried on the next request. */
export class AdrContract {
  readonly #bindings = new Map<string, AdrBinding>();

  constructor(readonly events: ContractEvents) {}

  requestBinding(sessionId: string): AdrBinding | undefined {
    const requestId = randomUUID();
    let binding: AdrBinding | undefined;
    const unsubscribe = this.events.on("adr:binding", (payload) => {
      if (
        !object(payload) ||
        payload.v !== 1 ||
        payload.sessionId !== sessionId ||
        payload.requestId !== requestId ||
        typeof payload.toolSourcePath !== "string" ||
        !isAbsolute(payload.toolSourcePath)
      )
        return;
      binding = { v: 1, sessionId, requestId, toolSourcePath: payload.toolSourcePath };
    });
    try {
      this.events.emit("adr:binding-request", { v: 1, sessionId, requestId });
    } finally {
      unsubscribe();
    }
    if (binding) this.#bindings.set(sessionId, binding);
    else this.#bindings.delete(sessionId);
    return binding;
  }

  /** The tool source is stable for a session, so a confirmed answer is reused. */
  binding(sessionId: string): AdrBinding | undefined {
    return this.#bindings.get(sessionId) ?? this.requestBinding(sessionId);
  }

  forget(sessionId: string): void {
    this.#bindings.delete(sessionId);
  }
}
