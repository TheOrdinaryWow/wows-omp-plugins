import {
  type SubagentProgressPayload,
  TASK_SUBAGENT_LIFECYCLE_CHANNEL,
  TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";

import type { AtlasPlanDetail } from "#src/atlas-store.ts";
import type { ChildEvidence } from "#src/evidence.ts";

export type AtlasProgress = SubagentProgressPayload["progress"];

export interface AtlasLiveRow {
  attempt: string;
  childAgentId: string;
  status: string;
  progress?: AtlasProgress;
}

export interface AtlasLiveSnapshot {
  detail: AtlasPlanDetail;
  rows: ReadonlyMap<string, AtlasLiveRow>;
  at: number;
  runningChildren: number;
}

interface LiveOptions {
  sessionId: string;
  events?: { on(channel: string, listener: (payload: unknown) => void): () => void };
  reload: () => Promise<AtlasPlanDetail | undefined>;
  subscribeLedger: (listener: () => void) => () => void;
  warn: (error: unknown) => void;
}

const TERMINAL: Record<string, true> = { completed: true, failed: true, aborted: true };

/** Session-owned observation, not a second execution ledger. Only notified commits reload disk state. */
export class AtlasLive {
  readonly #rows = new Map<string, AtlasLiveRow>();
  readonly #listeners = new Set<(snapshot: AtlasLiveSnapshot) => void>();
  readonly #unsubscribe: (() => void)[] = [];
  #timer?: NodeJS.Timeout;
  #tick?: NodeJS.Timeout;
  #reloadPending = false;
  #loading = false;
  #disposed = false;
  #detail: AtlasPlanDetail;
  snapshot: AtlasLiveSnapshot;

  constructor(
    detail: AtlasPlanDetail,
    readonly evidence: ChildEvidence,
    readonly options: LiveOptions,
  ) {
    this.#detail = detail;
    this.snapshot = this.#snapshot();
    this.#unsubscribe.push(options.subscribeLedger(() => this.#schedule(true)));
    if (options.events) {
      for (const [channel, listener] of [
        [TASK_SUBAGENT_PROGRESS_CHANNEL, (payload: unknown) => this.observeProgress(payload)],
        [TASK_SUBAGENT_LIFECYCLE_CHANNEL, (payload: unknown) => this.observeLifecycle(payload)],
      ] as const) {
        try {
          this.#unsubscribe.push(options.events.on(channel, listener));
        } catch (error) {
          options.warn(error);
        }
      }
    }
    this.#syncTick();
  }

  #snapshot(): AtlasLiveSnapshot {
    const running = new Set<string>();
    for (const row of this.#detail.rows) {
      if (row.status !== "in_progress") continue;
      const live = this.#rows.get(row.id);
      if (live && (live.status === "started" || live.status === "running")) running.add(live.childAgentId);
    }
    return { detail: this.#detail, rows: new Map(this.#rows), at: Date.now(), runningChildren: running.size };
  }

  subscribe(listener: (snapshot: AtlasLiveSnapshot) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  updateDetail(detail: AtlasPlanDetail): void {
    if (this.#disposed || detail.plan.id !== this.#detail.plan.id) return;
    this.#detail = detail;
    for (const [id, live] of this.#rows) {
      const row = detail.rows.find((item) => item.id === id);
      if (row?.status !== "in_progress" || row.attempt !== live.attempt) this.#rows.delete(id);
    }
    this.snapshot = this.#snapshot();
    this.#syncTick();
  }

  observeProgress(payload: unknown): void {
    if (this.#disposed || payload === null || typeof payload !== "object" || !("progress" in payload)) return;
    const progress = payload.progress;
    if (progress === null || typeof progress !== "object" || !("status" in progress) || typeof progress.status !== "string") return;
    const matches = this.evidence.matchDispatch(payload);
    for (const match of matches) {
      if (match.sessionId !== this.options.sessionId || match.planSha256 !== this.#detail.plan.planSha256) continue;
      for (const [id, attempt] of Object.entries(match.rows)) {
        const row = this.#detail.rows.find((item) => item.id === id);
        if (row?.status !== "in_progress" || row.attempt !== attempt) continue;
        const previous = this.#rows.get(id);
        // Late aggregated progress must not resurrect a terminal lifecycle generation.
        const status = Object.hasOwn(TERMINAL, progress.status)
          ? progress.status
          : (match.status ?? (previous && Object.hasOwn(TERMINAL, previous.status) ? previous.status : progress.status));
        this.#rows.set(id, {
          attempt,
          childAgentId: match.childAgentId,
          status,
          progress: Object.hasOwn(TERMINAL, status) || Object.hasOwn(TERMINAL, progress.status) ? undefined : (progress as AtlasProgress),
        });
      }
    }
    if (matches.length) this.#schedule();
  }

  observeLifecycle(payload: unknown): void {
    if (this.#disposed || payload === null || typeof payload !== "object" || !("status" in payload) || typeof payload.status !== "string")
      return;
    const matches = this.evidence.matchDispatch(payload);
    for (const match of matches) {
      if (match.sessionId !== this.options.sessionId || match.planSha256 !== this.#detail.plan.planSha256) continue;
      for (const [id, attempt] of Object.entries(match.rows)) {
        const row = this.#detail.rows.find((item) => item.id === id);
        if (row?.status !== "in_progress" || row.attempt !== attempt) continue;
        const previous = this.#rows.get(id);
        this.#rows.set(id, {
          attempt,
          childAgentId: match.childAgentId,
          status: payload.status,
          progress:
            Object.hasOwn(TERMINAL, payload.status) || Object.hasOwn(TERMINAL, previous?.status ?? "") ? undefined : previous?.progress,
        });
      }
    }
    if (matches.length) this.#schedule();
  }

  #syncTick(): void {
    const running = this.#detail.rows.some((row) => row.status === "in_progress");
    if (running && !this.#tick) {
      this.#tick = setInterval(() => this.#schedule(), 1_000);
      this.#tick.unref?.();
    } else if (!running && this.#tick) {
      clearInterval(this.#tick);
      this.#tick = undefined;
    }
  }

  #schedule(reload = false): void {
    if (this.#disposed) return;
    this.#reloadPending ||= reload;
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, 250);
    this.#timer.unref?.();
  }

  async #flush(): Promise<void> {
    if (this.#disposed) return;
    if (this.#loading) {
      this.#schedule();
      return;
    }
    if (this.#reloadPending) {
      this.#reloadPending = false;
      this.#loading = true;
      try {
        const detail = await this.options.reload();
        if (detail) this.updateDetail(detail);
      } catch (error) {
        this.options.warn(error);
      } finally {
        this.#loading = false;
      }
    }
    if (this.#disposed) return;
    this.snapshot = this.#snapshot();
    for (const listener of this.#listeners) {
      try {
        listener(this.snapshot);
      } catch (error) {
        this.options.warn(error);
      }
    }
    if (this.#reloadPending) this.#schedule();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#timer);
    clearInterval(this.#tick);
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#listeners.clear();
    this.#rows.clear();
  }
}
