import type { Snapshot } from "../src/model.ts";
import { DEFAULT_VIEW_STATE, readSnapshot, readViewState, type ViewState, writeViewState } from "../src/persisted.ts";
import { applyOps, encodeFrame, type Frame, FrameParser, type SessionPaths } from "../src/protocol.ts";
import { handleInput, type Input, InputReader } from "./keys.ts";
import { createUi, type LinkState, render, type UiState } from "./render.ts";
import { type ColorMode, detectColorMode } from "./theme.ts";
import { TranscriptReader, transcriptLines } from "./transcript.ts";

export type FinishBehavior = "close-with-omp" | "keep-open";
export interface Connection {
  write(data: string): void;
  close(): void;
}
export interface ConnectionHandlers {
  data(chunk: string | Uint8Array): void;
  close(): void;
}
export type Connect = (path: string, handlers: ConnectionHandlers) => Promise<Connection>;
export type Exec = (argv: string[]) => Promise<{ code: number; stdout: string }>;
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
export interface Screen {
  columns: number;
  rows: number;
  write(text: string): void;
}
export interface ViewerOptions {
  socket?: string;
  snapshot?: string;
  state?: string;
  pane?: string;
  finish: FinishBehavior;
}
export interface ViewerDeps {
  connect?: Connect;
  exec?: Exec;
  clock?: Clock;
  screen?: Screen;
  exit?: (code: number) => void;
  mode?: ColorMode;
}

export const HEARTBEAT_MS = 2000;
export const MISSED_HEARTBEATS = 3;
export const RETRY_MS = 1000;
const WATCHDOG_MS = 1000;
const TICK_MS = 250;
const RENDER_DELAY_MS = 16;
const HERDR_TIMEOUT_MS = 5000;

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as Timer),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as Timer),
};

async function connectUnix(path: string, handlers: ConnectionHandlers): Promise<Connection> {
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data: (_socket, chunk) => handlers.data(chunk),
      close: () => handlers.close(),
      error: () => handlers.close(),
    },
  });
  return { write: (data) => void socket.write(data), close: () => socket.end() };
}

async function execHerdr(argv: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), HERDR_TIMEOUT_MS);
  try {
    const stdout = await new Response(child.stdout).text();
    return { code: await child.exited, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The pane process: mirrors the host snapshot over the socket, watches heartbeats and applies the
 * finish behavior when the host goes away. All I/O is injectable so tests drive it with fakes.
 */
export class Viewer {
  snapshot?: Snapshot;
  seq = 0;
  paths: SessionPaths;
  viewState: ViewState = { ...DEFAULT_VIEW_STATE, folded: [] };
  readonly ui: UiState = createUi();
  link: LinkState = "connecting";
  ignored = 0;
  hostGone = false;
  exiting = false;
  tick = 0;
  readonly #connect: Connect;
  readonly #exec: Exec;
  readonly #clock: Clock;
  readonly #screen: Screen;
  readonly #exit: (code: number) => void;
  readonly #mode: ColorMode;
  #conn?: Connection;
  #attempt = 0;
  #connecting = false;
  #retry?: unknown;
  #renderTimer?: unknown;
  #intervals: unknown[] = [];
  #lastBeat = 0;
  #outSeq = 0;
  #awaitingResync = false;
  #writes: Promise<void> = Promise.resolve();
  #transcript?: TranscriptReader;
  #polling = false;
  #lastFrame = "";

  constructor(
    readonly options: ViewerOptions,
    deps: ViewerDeps = {},
  ) {
    this.paths = { snapshot: options.snapshot ?? "", state: options.state ?? "" };
    this.#connect = deps.connect ?? connectUnix;
    this.#exec = deps.exec ?? execHerdr;
    this.#clock = deps.clock ?? systemClock;
    this.#screen = deps.screen ?? { columns: 80, rows: 24, write: () => {} };
    this.#exit = deps.exit ?? ((code) => process.exit(code));
    this.#mode = deps.mode ?? detectColorMode();
  }

  async start(): Promise<void> {
    this.#lastBeat = this.#clock.now();
    // A recovery snapshot is only something to look at while connecting; it never proves the host is alive.
    if (this.paths.snapshot) this.snapshot = await readSnapshot(this.paths.snapshot).catch(() => undefined);
    if (this.paths.state) {
      const stored = await readViewState(this.paths.state).catch(() => undefined);
      if (stored) this.viewState = { ...stored, view: stored.view === "transcript" ? "dag" : stored.view, folded: [...stored.folded] };
    }
    this.#intervals.push(
      this.#clock.setInterval(() => this.#watchdog(), WATCHDOG_MS),
      this.#clock.setInterval(() => this.#onTick(), TICK_MS),
    );
    this.draw();
    await this.#open();
  }

  stop(): void {
    for (const handle of this.#intervals) this.#clock.clearInterval(handle);
    this.#intervals = [];
    if (this.#retry !== undefined) this.#clock.clearTimeout(this.#retry);
    if (this.#renderTimer !== undefined) this.#clock.clearTimeout(this.#renderTimer);
    this.#retry = undefined;
    this.#renderTimer = undefined;
    this.#drop();
  }

  /** Resolves when every queued view-state write has landed. */
  flush(): Promise<void> {
    return this.#writes;
  }

  frame(): string[] {
    return render({
      snapshot: this.snapshot,
      viewState: this.viewState,
      ui: this.ui,
      cols: this.#screen.columns,
      rows: this.#screen.rows,
      now: this.#clock.now(),
      tick: this.tick,
      mode: this.#mode,
      link: this.link,
      finish: this.options.finish,
      ignored: this.ignored,
    });
  }

  draw(): void {
    if (this.exiting) return;
    // Clear each line before drawing it: erasing after a full-width line would hit the pending-wrap cell and eat its last glyph.
    const lines = this.frame();
    const rest = lines.length < this.#screen.rows ? "\r\n\x1b[J" : "";
    const text = `\x1b[H${lines.map((line) => `\x1b[2K${line}`).join("\r\n")}${rest}`;
    if (text === this.#lastFrame) return;
    this.#lastFrame = text;
    this.#screen.write(text);
  }

  resize(): void {
    this.#lastFrame = "";
    this.#schedule();
  }

  /** One key press or mouse event from the terminal. */
  async input(input: Input): Promise<void> {
    for (const effect of handleInput({ snapshot: this.snapshot, viewState: this.viewState, ui: this.ui, now: this.#clock.now() }, input)) {
      if (effect.type === "quit") return this.quit();
      if (effect.type === "persist") this.#persist();
      if (effect.type === "transcript") {
        this.#transcript = effect.file ? new TranscriptReader(effect.file) : undefined;
        await this.#pollTranscript();
      }
    }
    this.#schedule();
  }

  /** `q`: tell the host the user dismissed the pane, then close our own pane. */
  async quit(): Promise<void> {
    if (this.exiting) return;
    this.#send({ type: "closed" });
    await this.#closeAndExit();
  }

  #schedule(): void {
    if (this.#renderTimer !== undefined || this.exiting) return;
    this.#renderTimer = this.#clock.setTimeout(() => {
      this.#renderTimer = undefined;
      this.draw();
    }, RENDER_DELAY_MS);
  }

  async #open(): Promise<void> {
    if (this.#conn || this.#connecting || this.exiting || !this.options.socket) return;
    this.#connecting = true;
    const attempt = ++this.#attempt;
    const parser = new FrameParser();
    try {
      const conn = await this.#connect(this.options.socket, {
        data: (chunk) => {
          if (attempt === this.#attempt) this.#receive(parser, chunk);
        },
        close: () => {
          if (attempt !== this.#attempt) return;
          this.#conn = undefined;
          this.#attempt += 1;
          this.#lost();
        },
      });
      if (attempt !== this.#attempt || this.exiting) {
        conn.close();
        return;
      }
      this.#conn = conn;
      this.#send({ type: "ready", cols: this.#screen.columns, rows: this.#screen.rows });
    } catch {
      if (attempt === this.#attempt) this.#lost();
    } finally {
      this.#connecting = false;
    }
  }

  #lost(): void {
    if (this.exiting) return;
    this.link = "lost";
    this.#awaitingResync = false;
    this.#schedule();
    if (this.#retry !== undefined) return;
    this.#retry = this.#clock.setTimeout(() => {
      this.#retry = undefined;
      void this.#open();
    }, RETRY_MS);
  }

  #drop(): void {
    const conn = this.#conn;
    this.#conn = undefined;
    this.#attempt += 1;
    conn?.close();
  }

  #send(frame: Record<string, unknown> & { type: string }): void {
    this.#conn?.write(encodeFrame({ v: 1, seq: ++this.#outSeq, ...frame } as Frame));
  }

  #receive(parser: FrameParser, chunk: string | Uint8Array): void {
    const before = parser.ignored;
    const frames = parser.feed(chunk);
    this.ignored += parser.ignored - before;
    for (const frame of frames) this.#handle(frame);
    if (parser.dropped) {
      this.#drop();
      this.#lost();
    }
    this.#schedule();
  }

  #alive(): void {
    this.#lastBeat = this.#clock.now();
    this.hostGone = false;
    this.link = "live";
  }

  #handle(frame: Frame): void {
    switch (frame.type) {
      case "hello":
        this.#alive();
        this.#rebind(frame.paths);
        return;
      case "snapshot":
        this.#alive();
        if (this.snapshot?.sessionId !== frame.snapshot.sessionId) this.ui.selected.clear();
        this.snapshot = frame.snapshot;
        this.seq = frame.seq;
        this.#awaitingResync = false;
        return;
      case "delta": {
        this.#alive();
        if (!this.snapshot) {
          this.#requestResync();
          return;
        }
        const applied = applyOps(this.snapshot, frame, this.seq, this.paths);
        if (applied.baseMismatch) {
          this.#requestResync();
          return;
        }
        if (applied.snapshot.sessionId !== this.snapshot.sessionId) this.ui.selected.clear();
        this.snapshot = applied.snapshot;
        this.seq = applied.seq;
        if (applied.paths) this.#rebind(applied.paths);
        return;
      }
      case "heartbeat":
        this.#alive();
        return;
      case "bye":
        if (frame.reason === "shutdown") this.#hostLost();
        return;
    }
  }

  #requestResync(): void {
    if (this.#awaitingResync) return;
    this.#awaitingResync = true;
    this.#send({ type: "resync" });
  }

  /** A session switch moves the durable files; from now on view state is written next to the new session. */
  #rebind(paths: SessionPaths): void {
    const changed = paths.state !== this.paths.state;
    this.paths = { ...paths };
    if (changed) this.#persist();
  }

  #persist(): void {
    const file = this.paths.state;
    if (!file) return;
    const state: ViewState = { ...this.viewState, folded: [...this.viewState.folded] };
    this.#writes = this.#writes.then(() => writeViewState(file, state)).catch(() => {});
  }

  #watchdog(): void {
    if (this.exiting || this.hostGone) return;
    if (this.#clock.now() - this.#lastBeat >= HEARTBEAT_MS * MISSED_HEARTBEATS) this.#hostLost();
  }

  #hostLost(): void {
    if (this.exiting || this.hostGone) return;
    this.hostGone = true;
    if (this.options.finish === "close-with-omp") {
      void this.#closeAndExit();
      return;
    }
    // keep-open: drop a silent socket so the 1 s retry loop takes over, and show the banner.
    this.#drop();
    this.#lost();
  }

  async #closeAndExit(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.stop();
    if (this.options.pane) await this.#exec(["herdr", "pane", "close", this.options.pane]).catch(() => undefined);
    await this.#writes;
    this.#exit(0);
  }

  #onTick(): void {
    if (this.exiting) return;
    this.tick += 1;
    if (this.tick % 2 === 0) void this.#pollTranscript();
    const busy =
      this.viewState.view === "transcript" ||
      this.snapshot?.tasks.some((task) => task.status === "running") ||
      this.snapshot?.runs.some((run) => run.nodes.some((node) => node.state === "running"));
    if (busy) this.#schedule();
  }

  async #pollTranscript(): Promise<void> {
    const reader = this.#transcript;
    const view = this.ui.transcript;
    if (!reader || !view || this.viewState.view !== "transcript" || this.#polling) return;
    this.#polling = true;
    try {
      const { entries, reset } = await reader.read();
      if (reset) view.lines = [];
      if (entries.length || reset) {
        view.lines.push(...transcriptLines(entries));
        this.#schedule();
      }
    } catch {
      // The child may still be creating its session file; the next poll retries.
    } finally {
      this.#polling = false;
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export interface CliOptions extends ViewerOptions {
  once: boolean;
  cols?: number;
  rows?: number;
  view?: ViewState["view"];
  fold: boolean;
  critical: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { finish: "close-with-omp", once: false, fold: false, critical: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--once":
        options.once = true;
        continue;
      case "--fold":
        options.fold = true;
        continue;
      case "--critical":
        options.critical = true;
        continue;
      case "--socket":
      case "--snapshot":
      case "--state":
      case "--pane":
        if (value !== undefined) options[flag.slice(2) as "socket" | "snapshot" | "state" | "pane"] = value;
        break;
      case "--finish":
        if (value === "keep-open" || value === "close-with-omp") options.finish = value;
        break;
      case "--cols":
      case "--rows":
        if (value !== undefined && Number.isFinite(Number(value))) options[flag.slice(2) as "cols" | "rows"] = Number(value);
        break;
      case "--view":
        if (value === "dag" || value === "tasks" || value === "transcript") options.view = value;
        break;
      default:
        continue;
    }
    index += 1;
  }
  return options;
}

/** Renders one frame of a snapshot file without a terminal; used by fixtures and visual checks. */
export async function renderOnce(options: CliOptions): Promise<string[]> {
  if (!options.snapshot) throw new Error("--once needs --snapshot <file>");
  const snapshot = await readSnapshot(options.snapshot);
  if (!snapshot) throw new Error(`no supported snapshot in ${options.snapshot}`);
  const stored = options.state ? await readViewState(options.state) : undefined;
  const viewState: ViewState = { ...(stored ?? DEFAULT_VIEW_STATE), folded: [...(stored?.folded ?? [])] };
  if (options.view) viewState.view = options.view;
  if (options.fold) viewState.folded = snapshot.runs.map((run) => run.id);
  if (options.critical) viewState.criticalPath = true;
  return render({
    snapshot,
    viewState,
    ui: createUi(),
    cols: options.cols ?? process.stdout.columns ?? 80,
    rows: options.rows ?? process.stdout.rows ?? 24,
    now: snapshot.at,
    tick: 0,
    mode: detectColorMode(),
    link: snapshot.connected ? "live" : "lost",
    finish: options.finish,
    ignored: 0,
  });
}

/** Alternate screen, hidden cursor and SGR mouse reporting (presses and wheel); the restore sequence undoes them in reverse. */
const TERMINAL_ENTER = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h";
const TERMINAL_RESTORE = "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l";

async function runLive(options: CliOptions): Promise<void> {
  const stdout = process.stdout;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    stdout.write(TERMINAL_RESTORE);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  const viewer = new Viewer(options, {
    screen: {
      get columns() {
        return stdout.columns ?? 80;
      },
      get rows() {
        return stdout.rows ?? 24;
      },
      write: (text) => void stdout.write(text),
    },
    exit: (code) => {
      restore();
      process.exit(code);
    },
  });
  stdout.write(TERMINAL_ENTER);
  // A crash must not leave the shell in the alternate screen with mouse reporting on.
  process.on("exit", restore);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  const reader = new InputReader();
  process.stdin.on("data", (chunk: string) => {
    for (const input of reader.feed(chunk)) void viewer.input(input);
  });
  stdout.on("resize", () => viewer.resize());
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(signal, () => {
      viewer.stop();
      restore();
      process.exit(0);
    });
  }
  await viewer.start();
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (options.once) {
    try {
      process.stdout.write(`${(await renderOnce(options)).join("\n")}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  } else {
    await runLive(options);
  }
}
