import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import type { Snapshot } from "./model.ts";
import { encodeFrame, type Frame, FrameParser, MAX_FRAME_BYTES, type Op, type SessionPaths } from "./protocol.ts";

export const HEARTBEAT_MS = 2_000;
export const DELTA_COALESCE_MS = 100;
export const MAX_BACKLOG_BYTES = 256 * 1024;

export function herdrSocketPath(paneId: string, pid: number, root = tmpdir()): string {
  const key = createHash("sha256").update(`${paneId}\n${pid}`).digest("hex").slice(0, 16);
  return `${root}/omp-herdr-dag/${key}.sock`;
}

export interface SnapshotTimer {
  setTimeout(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout | undefined): void;
  setInterval(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout | undefined): void;
}

const systemTimer: SnapshotTimer = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle),
};

type OutboundFrame = Extract<Frame, { type: "hello" | "snapshot" | "delta" | "heartbeat" | "bye" }>;
type FrameBody<T> = T extends Frame ? Omit<T, "v" | "seq"> : never;

export interface SnapshotServerOptions {
  socketPath: string;
  sessionId: string;
  paths: SessionPaths;
  snapshot: Snapshot;
  onClosed?: () => void | Promise<void>;
  onReady?: (size: { cols: number; rows: number }) => void;
  onHeartbeat?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  timer?: SnapshotTimer;
}

interface Client {
  socket: Socket;
  parser: FrameParser;
  pendingOps: Op[];
  pendingBytes: number;
  pendingBase?: number;
  flushTimer?: NodeJS.Timeout;
  lastStateSeq: number;
  needsSnapshot: boolean;
  closed: boolean;
}

/**
 * The host side of the Herdr viewer wire protocol. State sequence numbers only advance for
 * snapshots and deltas; heartbeat and hello frames never invalidate a viewer's base sequence.
 */
export class SnapshotServer {
  readonly #options: SnapshotServerOptions;
  readonly #timer: SnapshotTimer;
  readonly #clients = new Set<Client>();
  #server?: Server;
  #heartbeat?: NodeJS.Timeout;
  #snapshot: Snapshot;
  #paths: SessionPaths;
  #stateSeq = 0;
  #started = false;

  constructor(options: SnapshotServerOptions) {
    this.#options = options;
    this.#timer = options.timer ?? systemTimer;
    this.#snapshot = options.snapshot;
    this.#paths = options.paths;
  }

  get snapshot(): Snapshot {
    return this.#snapshot;
  }

  get stateSeq(): number {
    return this.#stateSeq;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await mkdir(dirname(this.#options.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#options.socketPath), 0o700);
    await unlink(this.#options.socketPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.#server as Server;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#options.socketPath);
    });
    this.#started = true;
    this.#heartbeat = this.#timer.setInterval(() => {
      void Promise.resolve()
        .then(() => this.#options.onHeartbeat?.())
        .catch((error: unknown) => this.#options.onError?.(error));
      for (const client of this.#clients) this.#send(client, { type: "heartbeat", at: Date.now() });
    }, HEARTBEAT_MS);
  }

  async stop(reason: "shutdown" | "switch" = "shutdown"): Promise<void> {
    if (!this.#started && !this.#server) return;
    this.#timer.clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    for (const client of [...this.#clients]) {
      this.#send(client, { type: "bye", reason });
      this.#closeClient(client, true);
    }
    const server = this.#server;
    this.#server = undefined;
    this.#started = false;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.#options.socketPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  /** Publish a state change. The caller supplies operations so small changes stay streaming deltas. */
  publish(snapshot: Snapshot, operations: readonly Op[] = []): void {
    const generationChanged = snapshot.generation !== this.#snapshot.generation;
    this.#snapshot = snapshot;
    this.#stateSeq += 1;
    for (const client of this.#clients) {
      if (client.needsSnapshot) continue;
      if (generationChanged || operations.length === 0) {
        if (generationChanged) this.#hello(client);
        this.#sendSnapshot(client);
        continue;
      }
      if (client.pendingBase === undefined) client.pendingBase = client.lastStateSeq;
      client.pendingOps.push(...operations);
      client.pendingBytes += operations.reduce((sum, operation) => sum + Buffer.byteLength(JSON.stringify(operation)), 0);
      if (client.pendingBytes > MAX_BACKLOG_BYTES || client.socket.writableLength > MAX_BACKLOG_BYTES) {
        this.#sendSnapshot(client);
        continue;
      }
      this.#scheduleFlush(client);
    }
  }

  updateSession(sessionId: string, paths: SessionPaths, snapshot: Snapshot): void {
    this.#options.sessionId = sessionId;
    this.#paths = paths;
    this.#snapshot = snapshot;
    this.#stateSeq += 1;
    for (const client of this.#clients) {
      this.#send(client, { type: "bye", reason: "switch" });
      this.#send(client, {
        type: "delta",
        base: client.lastStateSeq,
        ops: [{ op: "session", sessionId, sessionName: snapshot.sessionName, generation: snapshot.generation, paths }],
      });
      this.#hello(client);
      this.#sendSnapshot(client);
    }
  }

  sendBye(reason: "shutdown" | "switch"): void {
    for (const client of this.#clients) this.#send(client, { type: "bye", reason });
  }

  #accept(socket: Socket): void {
    const client: Client = {
      socket,
      parser: new FrameParser(),
      pendingOps: [],
      pendingBytes: 0,
      lastStateSeq: this.#stateSeq,
      needsSnapshot: false,
      closed: false,
    };
    this.#clients.add(client);
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      for (const frame of client.parser.feed(chunk)) this.#receive(client, frame);
      if (client.parser.dropped) this.#closeClient(client);
    });
    socket.on("close", () => this.#closeClient(client));
    socket.on("error", () => this.#closeClient(client));
    socket.on("drain", () => {
      if (!client.needsSnapshot || client.closed) return;
      client.needsSnapshot = false;
      this.#hello(client);
      this.#sendSnapshot(client);
    });
    this.#hello(client);
    this.#sendSnapshot(client);
  }

  #hello(client: Client): void {
    this.#send(client, {
      type: "hello",
      sessionId: this.#options.sessionId,
      pid: process.pid,
      generation: this.#snapshot.generation,
      paths: this.#paths,
    });
  }

  #receive(client: Client, frame: Frame): void {
    if (client.closed) return;
    if (frame.type === "ready") {
      this.#options.onReady?.({ cols: frame.cols, rows: frame.rows });
    } else if (frame.type === "resync") {
      this.#sendSnapshot(client);
    } else if (frame.type === "closed") {
      void Promise.resolve()
        .then(() => this.#options.onClosed?.())
        .catch((error: unknown) => this.#options.onError?.(error));
    }
  }

  #scheduleFlush(client: Client): void {
    if (client.flushTimer || client.closed) return;
    client.flushTimer = this.#timer.setTimeout(() => {
      client.flushTimer = undefined;
      this.#flush(client);
    }, DELTA_COALESCE_MS);
  }

  #flush(client: Client): void {
    if (client.closed || client.pendingBase === undefined) return;
    if (client.pendingBytes > MAX_BACKLOG_BYTES || client.socket.writableLength > MAX_BACKLOG_BYTES) {
      this.#sendSnapshot(client);
      return;
    }
    const base = client.pendingBase;
    const ops = client.pendingOps;
    client.pendingBase = undefined;
    client.pendingOps = [];
    client.pendingBytes = 0;
    this.#send(client, { type: "delta", base, ops });
    client.lastStateSeq = this.#stateSeq;
  }

  #sendSnapshot(client: Client): void {
    if (client.closed) return;
    this.#timer.clearTimeout(client.flushTimer);
    client.flushTimer = undefined;
    client.pendingBase = undefined;
    client.pendingOps = [];
    client.pendingBytes = 0;
    this.#send(client, { type: "snapshot", snapshot: this.#snapshot });
    client.lastStateSeq = this.#stateSeq;
  }

  #send(client: Client, body: FrameBody<OutboundFrame>): void {
    if (client.closed || client.socket.destroyed) return;
    if (body.type !== "bye" && client.socket.writableLength > MAX_BACKLOG_BYTES) {
      client.needsSnapshot = true;
      return;
    }
    const frame = { v: 1, seq: this.#stateSeq, ...body } as Frame;
    const encoded = encodeFrame(frame);
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
      this.#options.onError?.(new Error("Herdr DAG frame exceeds the 1 MiB limit"));
      this.#closeClient(client);
      return;
    }
    try {
      client.socket.write(encoded);
    } catch (error) {
      this.#options.onError?.(error);
      this.#closeClient(client);
    }
  }

  #closeClient(client: Client, graceful = false): void {
    if (client.closed) return;
    client.closed = true;
    this.#timer.clearTimeout(client.flushTimer);
    client.flushTimer = undefined;
    this.#clients.delete(client);
    if (graceful && !client.socket.destroyed) {
      client.socket.end();
      const deadline = setTimeout(() => client.socket.destroy(), 50);
      client.socket.once("close", () => clearTimeout(deadline));
    } else client.socket.destroy();
  }
}

export interface SnapshotWriterOptions {
  file: string;
  timer?: SnapshotTimer;
  delayMs?: number;
  onError?: (error: unknown) => void;
}

/** Debounced, atomic snapshot persistence used only for viewer recovery. */
export class SnapshotWriter {
  readonly #options: SnapshotWriterOptions;
  readonly #timer: SnapshotTimer;
  #pending?: Snapshot;
  #timerHandle?: NodeJS.Timeout;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: SnapshotWriterOptions) {
    this.#options = options;
    this.#timer = options.timer ?? systemTimer;
  }

  schedule(snapshot: Snapshot): void {
    this.#pending = structuredClone(snapshot);
    this.#timer.clearTimeout(this.#timerHandle);
    this.#timerHandle = this.#timer.setTimeout(() => {
      this.#timerHandle = undefined;
      this.#queue = this.#queue.then(() => this.#writePending());
      // Attach a rejection observer immediately; flush still reports the original I/O failure.
      void this.#queue.catch((error: unknown) => this.#options.onError?.(error));
    }, this.#options.delayMs ?? 250);
  }

  async flush(): Promise<void> {
    if (this.#timerHandle) {
      this.#timer.clearTimeout(this.#timerHandle);
      this.#timerHandle = undefined;
      this.#queue = this.#queue.then(() => this.#writePending());
    }
    await this.#queue;
  }

  async #writePending(): Promise<void> {
    const snapshot = this.#pending;
    this.#pending = undefined;
    if (!snapshot) return;
    await mkdir(dirname(this.#options.file), { recursive: true, mode: 0o700 });
    const temp = `${this.#options.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      await rename(temp, this.#options.file);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
