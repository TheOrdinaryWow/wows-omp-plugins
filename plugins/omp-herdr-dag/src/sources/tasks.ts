import { attachTask, type DagNode, type TaskCard } from "#src/model.ts";

export interface SourceEvents {
  on(channel: string, listener: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}
export interface RegistryRef {
  id: string;
  displayName: string;
  kind: string;
  parentId?: string;
  status: string;
  sessionFile?: string | null;
  createdAt: number;
  lastActivity: number;
}
export interface TaskRegistry {
  list(): RegistryRef[];
  onChange(listener: (event: { type: string; ref: RegistryRef }) => void): () => void;
}
export interface TaskSourceOptions {
  events: SourceEvents;
  registry?: TaskRegistry;
  inProgressNode: () => DagNode | string | undefined;
  now?: () => number;
  stalledAfterSeconds?: number;
  scheduleInterval?: (callback: () => void, milliseconds: number) => () => void;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" ? (value as RecordValue) : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class TaskSource {
  #options: TaskSourceOptions;
  #cards = new Map<string, TaskCard>();
  #activity = new Map<string, number>();
  #listeners = new Set<(tasks: TaskCard[]) => void>();
  #unsubscribe: (() => void)[] = [];
  #stopTimer: () => void;

  constructor(options: TaskSourceOptions) {
    this.#options = options;
    for (const channel of ["lifecycle", "progress", "event"] as const) {
      this.#unsubscribe.push(options.events.on(`task:subagent:${channel}`, (payload) => this.#frame(channel, payload)));
    }
    if (options.registry) {
      this.#unsubscribe.push(
        options.registry.onChange((event) => {
          if (event.type === "removed" && this.#cards.get(event.ref.id)?.activityAvailable === false) {
            this.#cards.delete(event.ref.id);
            this.#activity.delete(event.ref.id);
            this.#notify();
          } else this.sample();
        }),
      );
    }
    this.sample();
    if (options.scheduleInterval) this.#stopTimer = options.scheduleInterval(() => this.sample(), 2000);
    else {
      const timer = setInterval(() => this.sample(), 2000);
      timer.unref?.();
      this.#stopTimer = () => clearInterval(timer);
    }
  }
  get tasks(): TaskCard[] {
    return [...this.#cards.values()];
  }
  get stalledTaskIds(): Set<string> {
    const now = this.#now();
    return new Set(
      this.tasks
        .filter(
          (card) =>
            card.status === "running" &&
            now - (this.#activity.get(card.id) ?? card.startedAt) >= (this.#options.stalledAfterSeconds ?? 90) * 1000,
        )
        .map((card) => card.id),
    );
  }
  subscribe(listener: (tasks: TaskCard[]) => void): () => void {
    this.#listeners.add(listener);
    listener(this.tasks);
    return () => this.#listeners.delete(listener);
  }
  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
  #notify(): void {
    const now = this.#now();
    for (const card of this.#cards.values()) {
      card.stalled =
        card.status === "running" &&
        now - (this.#activity.get(card.id) ?? card.startedAt) >= (this.#options.stalledAfterSeconds ?? 90) * 1000;
    }
    for (const listener of this.#listeners) listener(this.tasks);
  }
  #frame(channel: string, payload: unknown): void {
    const data = record(payload);
    if (!data) return;
    const progress = channel === "progress" ? record(data.progress) : data;
    const id = string(progress?.id);
    if (!id || !progress) return;
    const previous = this.#cards.get(id);
    const at = this.#now();
    if (channel === "event") {
      const event = record(data.event);
      if (!previous || !event) return;
      if (event.type === "tool_execution_start") {
        previous.currentTool = string(event.toolName);
        previous.currentToolArgs = event.args === undefined ? undefined : JSON.stringify(event.args);
      } else if (event.type === "tool_execution_end") {
        previous.currentTool = undefined;
        previous.currentToolArgs = undefined;
      }
      this.#activity.set(id, at);
      this.#notify();
      return;
    }
    const status = channel === "progress" ? "progress" : string(data.status);
    if (!status || !["started", "progress", "completed", "failed", "aborted"].includes(status)) return;
    const node = status === "started" ? this.#options.inProgressNode() : undefined;
    const retry = record(progress.retryState);
    const card = attachTask(previous, {
      id,
      status: status as "started" | "progress" | "completed" | "failed" | "aborted",
      at,
      nodeId: typeof node === "string" ? node : node?.id,
      agent: string(data.agent),
      detached: typeof data.detached === "boolean" ? data.detached : undefined,
      tokens: number(progress.tokens),
      costUsd: number(progress.cost),
      durationMs: number(progress.durationMs),
      currentTool: string(progress.currentTool),
      currentToolArgs: string(progress.currentToolArgs),
      recentOutput: Array.isArray(progress.recentOutput)
        ? progress.recentOutput.filter((line): line is string => typeof line === "string")
        : undefined,
      model: string(progress.resolvedModel),
      retry:
        retry && number(retry.attempt) !== undefined && number(retry.maxAttempts) !== undefined
          ? {
              attempt: retry.attempt as number,
              maxAttempts: retry.maxAttempts as number,
              errorMessage: string(retry.errorMessage) ?? "",
            }
          : undefined,
    });
    if (status === "started") card.nodeId = typeof node === "string" ? node : node?.id;
    if (channel === "progress" && card.status === "running") {
      card.currentTool = string(progress.currentTool);
      card.currentToolArgs = string(progress.currentToolArgs);
      if (!retry) card.retry = undefined;
    }
    card.description = string(data.description) ?? string(progress.description) ?? card.description;
    card.sessionFile = string(data.sessionFile) ?? card.sessionFile;
    card.activityAvailable = true;
    this.#cards.set(id, card);
    this.#activity.set(id, at);
    this.sample();
  }
  sample(): void {
    const refs = this.#options.registry?.list() ?? [];
    const byId = new Map(refs.map((ref) => [ref.id, ref]));
    for (const ref of refs) {
      if ((ref.kind !== "sub" && ref.kind !== "subagent") || !ref.parentId) continue;
      const parent = this.#cards.get(ref.parentId);
      if (parent?.depth !== 1) continue;
      const existing = this.#cards.get(ref.id);
      if (existing?.activityAvailable) continue;
      const card = existing ?? attachTask(undefined, { id: ref.id, status: "started", at: ref.createdAt, agent: ref.displayName });
      card.parentTaskId = ref.parentId;
      card.depth = 2;
      card.activityAvailable = false;
      card.sessionFile = ref.sessionFile ?? undefined;
      card.status =
        ref.status === "running" ? "running" : ref.status === "failed" ? "failed" : ref.status === "aborted" ? "aborted" : "completed";
      card.finishedAt = card.status === "running" ? undefined : ref.lastActivity;
      this.#cards.set(ref.id, card);
      this.#activity.set(ref.id, ref.lastActivity);
    }
    for (const card of this.#cards.values()) {
      if (!card.activityAvailable && !byId.has(card.id)) this.#cards.delete(card.id);
    }
    this.#notify();
  }
  dispose(): void {
    this.#stopTimer();
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#listeners.clear();
  }
}
