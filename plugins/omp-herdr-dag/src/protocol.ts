import type { Run, Snapshot, TaskCard, ThemeColors } from "./model.ts";

export interface SessionPaths {
  snapshot: string;
  state: string;
}
export type Op =
  | { op: "run"; run: Run }
  | { op: "removeRun"; id: string }
  | { op: "task"; task: TaskCard }
  | { op: "removeTask"; id: string }
  | { op: "theme"; theme: ThemeColors }
  | { op: "session"; sessionId: string; sessionName?: string; generation: number; paths: SessionPaths }
  | { op: "atlas"; available: boolean };
export type Frame = { v: 1; seq: number } & (
  | { type: "hello"; sessionId: string; pid: number; generation: number; paths: SessionPaths }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "delta"; base: number; ops: Op[] }
  | { type: "heartbeat"; at: number }
  | { type: "bye"; reason: "shutdown" | "switch" }
  | { type: "ready"; cols: number; rows: number }
  | { type: "resync" }
  | { type: "closed" }
);
export type DeltaFrame = Extract<Frame, { type: "delta" }>;
export const MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** A fatal oversized line requires the socket owner to close its connection. */
export class FrameParser {
  ignored = 0;
  dropped = false;
  #parts: Buffer[] = [];
  #bytes = 0;

  feed(chunk: string | Uint8Array): Frame[] {
    if (this.dropped) return [];
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: Frame[] = [];
    let start = 0;
    for (let index = 0; index <= buffer.length; index += 1) {
      if (index !== buffer.length && buffer[index] !== 10) continue;
      const part = buffer.subarray(start, index);
      this.#bytes += part.length;
      if (this.#bytes > MAX_FRAME_BYTES) {
        this.dropped = true;
        this.#parts = [];
        this.#bytes = 0;
        return frames;
      }
      if (part.length) this.#parts.push(part);
      if (index === buffer.length) break;
      const line = Buffer.concat(this.#parts, this.#bytes).toString("utf8");
      this.#parts = [];
      this.#bytes = 0;
      start = index + 1;
      try {
        const frame = JSON.parse(line);
        if (
          frame?.v !== 1 ||
          !Number.isSafeInteger(frame.seq) ||
          !["hello", "snapshot", "delta", "heartbeat", "bye", "ready", "resync", "closed"].includes(frame.type)
        ) {
          this.ignored += 1;
          continue;
        }
        frames.push(frame as Frame);
      } catch {
        this.ignored += 1;
      }
    }
    return frames;
  }
}

export interface AppliedOps {
  snapshot: Snapshot;
  seq: number;
  paths?: SessionPaths;
  baseMismatch: boolean;
}
/** Sequence numbers refer to the last applied snapshot/delta, not heartbeat frames. */
export function applyOps(snapshot: Snapshot, frame: DeltaFrame, seq: number, paths?: SessionPaths): AppliedOps {
  if (frame.base !== seq) return { snapshot, seq, paths, baseMismatch: true };
  let next: Snapshot = { ...snapshot };
  let nextPaths = paths;
  let runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  let tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const operation of frame.ops) {
    switch (operation.op) {
      case "run":
        runs.set(operation.run.id, operation.run);
        break;
      case "removeRun":
        runs.delete(operation.id);
        break;
      case "task":
        tasks.set(operation.task.id, operation.task);
        break;
      case "removeTask":
        tasks.delete(operation.id);
        break;
      case "theme":
        next.theme = operation.theme;
        break;
      case "atlas":
        next.atlasAvailable = operation.available;
        break;
      case "session":
        next = {
          ...next,
          sessionId: operation.sessionId,
          sessionName: operation.sessionName,
          generation: operation.generation,
          atlasAvailable: false,
        };
        nextPaths = operation.paths;
        runs = new Map();
        tasks = new Map();
        break;
    }
  }
  next.runs = [...runs.values()];
  next.tasks = [...tasks.values()];
  return { snapshot: next, seq: frame.seq, paths: nextPaths, baseMismatch: false };
}
