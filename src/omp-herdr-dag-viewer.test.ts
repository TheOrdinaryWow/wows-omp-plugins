import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeState, Run, Snapshot } from "../plugins/omp-herdr-dag/src/model.ts";
import { DEFAULT_VIEW_STATE, readSnapshot, readViewState, type ViewState } from "../plugins/omp-herdr-dag/src/persisted.ts";
import { encodeFrame, type Frame, FrameParser } from "../plugins/omp-herdr-dag/src/protocol.ts";
import { handleKey, parseKeys } from "../plugins/omp-herdr-dag/viewer/keys.ts";
import { type Clock, type Connect, type ConnectionHandlers, Viewer } from "../plugins/omp-herdr-dag/viewer/main.ts";
import { createUi, type RenderInput, render } from "../plugins/omp-herdr-dag/viewer/render.ts";
import { TranscriptReader, transcriptLines } from "../plugins/omp-herdr-dag/viewer/transcript.ts";

const VIEWER = join(import.meta.dir, "../plugins/omp-herdr-dag/viewer");
const FIXTURES = join(VIEWER, "fixtures");
// biome-ignore lint/suspicious/noControlCharactersInRegex: Tests inspect terminal output.
const SGR = /\x1b\[[0-9;]*m/g;
const strip = (text: string): string => text.replace(SGR, "");
const color = (hex: string): string => `38;2;${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(";")}`;

async function fixture(name: string): Promise<Snapshot> {
  const snapshot = await readSnapshot(join(FIXTURES, `${name}.json`));
  if (!snapshot) throw new Error(`fixture ${name} missing`);
  return snapshot;
}

function frame(snapshot: Snapshot | undefined, options: Partial<RenderInput> & { view?: ViewState["view"] } = {}): string[] {
  const viewState: ViewState = options.viewState ?? { ...DEFAULT_VIEW_STATE, folded: [], view: options.view ?? "dag" };
  return render({
    snapshot,
    viewState,
    ui: options.ui ?? createUi(),
    cols: options.cols ?? 50,
    rows: options.rows ?? 40,
    now: options.now ?? snapshot?.at ?? 0,
    tick: 0,
    mode: "truecolor",
    link: options.link ?? "live",
    finish: options.finish ?? "close-with-omp",
    ignored: options.ignored ?? 0,
  });
}

describe("omp-herdr-dag viewer rendering", () => {
  test("every fixture renders through --once within the requested size", async () => {
    const names = (await readdir(FIXTURES)).filter((name) => name.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const result = Bun.spawnSync([
        process.execPath,
        join(VIEWER, "main.ts"),
        "--snapshot",
        join(FIXTURES, name),
        "--once",
        "--cols",
        "50",
        "--rows",
        "40",
      ]);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.toString().replace(/\n$/, "").split("\n");
      expect(lines.length).toBeLessThanOrEqual(40);
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(50);
    }
  });

  test("no rendered line exceeds the width in any view, size or toggle", async () => {
    const names = (await readdir(FIXTURES)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
    for (const name of names) {
      const snapshot = await fixture(name);
      for (const [cols, rows] of [
        [50, 40],
        [30, 60],
        [100, 50],
        [24, 12],
      ] as const) {
        for (const view of ["dag", "tasks"] as const) {
          for (const toggles of [false, true]) {
            const viewState: ViewState = {
              ...DEFAULT_VIEW_STATE,
              view,
              criticalPath: toggles,
              folded: toggles ? snapshot.runs.map((run) => run.id) : [],
            };
            const lines = frame(snapshot, { cols, rows, viewState, link: snapshot.connected ? "live" : "lost", ignored: toggles ? 2 : 0 });
            expect(lines.length).toBeLessThanOrEqual(rows);
            for (const line of lines) {
              expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
              expect(Bun.stringWidth(strip(line))).toBeLessThanOrEqual(cols);
            }
          }
        }
      }
    }
  });

  test("source colors mark run headers and node borders", async () => {
    for (const [name, hex] of [
      ["todo-only", "#4f8cff"],
      ["plan", "#a371f7"],
      ["atlas", "#3fb950"],
    ] as const) {
      const snapshot = await fixture(name);
      expect(snapshot.sources[snapshot.runs[0]?.source ?? "todo"]).toBe(hex);
      const lines = frame(snapshot, { cols: 100 });
      const label = { "todo-only": "TODO", plan: "PLAN", atlas: "ATLAS" }[name];
      expect(lines.some((line) => line.includes(`\x1b[1;7;${color(hex)}m ${label} `))).toBe(true);
      expect(lines.some((line) => line.includes(`\x1b[${color(hex)}m╭`))).toBe(true);
    }
  });

  test("each state has its own icon in its state color", async () => {
    const base = await fixture("todo-only");
    const states: NodeState[] = ["pending", "running", "done", "failed", "blocked", "abandoned"];
    const run: Run = {
      id: "todo:s:1",
      source: "todo",
      title: "States",
      generation: 1,
      nodes: states.map((state, index) => ({ id: `n${index}`, label: `node ${state}`, state, band: 0, bandName: "All", taskIds: [] })),
      edges: [],
      createdAt: 0,
      updatedAt: 0,
      stats: { done: 0, total: 6, elapsedMs: 0 },
    };
    const text = frame({ ...base, runs: [run], tasks: [] }, { cols: 200, rows: 30 }).join("\n");
    const theme = base.theme;
    const expected: Record<NodeState, string> = {
      pending: `\x1b[${color(theme.muted)}m○`,
      running: `\x1b[1;${color(theme.accent)}m◐`,
      done: `\x1b[${color(theme.success)}m✔`,
      failed: `\x1b[${color(theme.error)}m✖`,
      blocked: `\x1b[${color(theme.warning)}m⊘`,
      abandoned: `\x1b[${color(theme.dim)}m⊖`,
    };
    for (const state of states) {
      expect(text).toContain(`${expected[state]}\x1b[0m\x1b`);
      expect(strip(text)).toContain(`node ${state}`);
    }
  });

  test("a backward edge is an annotated back-reference with both nodes kept in their bands", async () => {
    const lines = frame(await fixture("backward-edge")).map(strip);
    const row = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    expect(row("↑ after Implement")).toBeGreaterThan(-1);
    expect(row("Design")).toBeLessThan(row("Define schema"));
    expect(row("Define schema")).toBeLessThan(row("Build"));
    expect(row("Build")).toBeLessThan(row("Implement parser"));
    expect(row("↑ after Implement")).toBeLessThan(row("Build"));
    expect(lines.some((line) => line.includes("┆"))).toBe(true);
  });

  test("folded layers collapse into summary rows", async () => {
    const snapshot = await fixture("folded");
    const unfolded = frame(snapshot).map(strip).join("\n");
    expect(unfolded).toContain("Install toolchain");
    const viewState: ViewState = { ...DEFAULT_VIEW_STATE, folded: [snapshot.runs[0]?.id ?? ""] };
    const folded = frame(snapshot, { viewState }).map(strip).join("\n");
    expect(folded).toContain("✔ 2 done (Setup)");
    expect(folded).toContain("✔ 2 done (Migrate)");
    expect(folded).not.toContain("Install toolchain");
    expect(folded).toContain("Theme sync");
    expect(folded).toContain("▼");
  });

  test("critical path is highlighted only when toggled and only for runs with dependencies", async () => {
    const atlas = await fixture("atlas");
    const off = frame(atlas, { cols: 100, rows: 60 }).join("\n");
    expect(off).not.toContain("┏");
    const on = frame(atlas, { cols: 100, rows: 60, viewState: { ...DEFAULT_VIEW_STATE, criticalPath: true } }).join("\n");
    expect(on).toContain(`\x1b[1;${color(atlas.theme.accent)}m┏`);
    expect(strip(on)).toContain("━");
    const plain = await fixture("disconnected");
    expect(plain.runs[0]?.edges).toEqual([]);
    const none = frame(plain, { viewState: { ...DEFAULT_VIEW_STATE, criticalPath: true } }).join("\n");
    expect(none).not.toContain("┏");
    expect(strip(none)).not.toContain("p path");
  });

  test("unavailable metrics render as an em dash", async () => {
    const plan = strip(frame(await fixture("plan")).join("\n"));
    expect(plan).toContain("tok — · —");
    const tasks = strip(frame(await fixture("tasks"), { view: "tasks", rows: 60 }).join("\n"));
    expect(tasks).toContain("tok — · cost — · model —");
    expect(tasks).not.toMatch(/tok 0\b/);
  });

  test("tasks view shows tool, output, totals across activations, retry, failure and status-only cards", async () => {
    const snapshot = await fixture("tasks");
    const raw = frame(snapshot, { view: "tasks", rows: 60 });
    const text = raw.map(strip);
    const joined = text.join("\n");
    expect(joined).toContain("▸ grep(pattern=FrameParser path=plugins/)");
    expect(joined).toContain("Found 4 matches in protocol.ts");
    expect(joined).not.toContain("older line");
    expect(joined).toContain("tok 15.4k · cost $0.061 · claude-haiku-4-5");
    // 100 + 20 tokens and $0.50 + $0.25 over two activations.
    expect(joined).toContain("tok 120 · cost $0.750 · ×2 activations");
    expect(joined).toContain("activity unavailable");
    expect(text.some((line) => line.startsWith("  ╭─") && line.includes("librarian"))).toBe(true);
    expect(raw.some((line) => line.includes(`\x1b[${color(snapshot.theme.warning)}m↻ retry 2/3 · 429 rate limited by provider`))).toBe(
      true,
    );
    expect(raw.some((line) => line.includes(`\x1b[1;${color(snapshot.theme.error)}m failed`))).toBe(true);
    expect(raw.some((line) => line.includes(`\x1b[${color(snapshot.theme.error)}m╭─ `))).toBe(true);
    expect(joined).toContain("↳ Fix flaky test");
  });

  test("stalled running cards use warning borders, spinner and label whether linked or unlinked", async () => {
    const snapshot = await fixture("tasks");
    const running = snapshot.tasks.find((task) => task.status === "running");
    expect(running).toBeDefined();
    if (!running) throw new Error("Expected running fixture card");
    const linkedNode = snapshot.runs.flatMap((run) => run.nodes).find((node) => node.state === "running");
    if (!linkedNode) throw new Error("Expected running fixture node");
    for (const nodeId of [undefined, linkedNode.id]) {
      const task = { ...running, nodeId, retry: undefined, stalled: true };
      const stalled = frame({ ...snapshot, tasks: [task] }, { view: "tasks", cols: 90 }).join("\n");
      expect(stalled).toContain(`\x1b[1;${color(snapshot.theme.warning)}m stalled`);
      expect(stalled).toContain(`\x1b[1;${color(snapshot.theme.warning)}m╔═ `);
      expect(stalled).toContain(`\x1b[1;${color(snapshot.theme.warning)}m⠋`);
      const normal = frame({ ...snapshot, tasks: [{ ...task, stalled: false }] }, { view: "tasks", cols: 90 }).join("\n");
      expect(strip(normal)).not.toContain("stalled");
      expect(normal).toContain(`\x1b[1;${color(snapshot.theme.accent)}m⠋`);
      expect(normal).not.toContain(`\x1b[1;${color(snapshot.theme.warning)}m╔═ `);
    }
  });

  test("selection moves through nodes and the footer shows the selected node's detail", async () => {
    const snapshot = await fixture("atlas");
    const viewState: ViewState = { ...DEFAULT_VIEW_STATE, folded: [] };
    const ui = createUi();
    const footer = (): string => frame(snapshot, { cols: 60, rows: 40, ui, viewState }).slice(-6).map(strip).join("\n");
    expect(footer()).toContain("◐ T4. Viewer process");
    handleKey({ snapshot, viewState, ui, now: snapshot.at }, "down");
    expect(footer()).toContain("○ T5. Extension integration");
    for (let step = 0; step < 6; step += 1) handleKey({ snapshot, viewState, ui, now: snapshot.at }, "up");
    const top = footer();
    expect(top).toContain("✔ T1. Scaffold the plugin package");
    expect(top).toContain("bun run check-catalog passed");
  });

  test("control sequences in user text are stripped before output", async () => {
    const base = await fixture("todo-only");
    const run = structuredClone(base.runs[0] as Run);
    const node = run.nodes[0];
    if (!node) throw new Error("fixture has no nodes");
    node.label = "\x1b]0;owned\x07Hack\x1b[31mRed\x1b[0m\x1b[2J";
    node.bandName = "Band\x1b[H\x9b1;1H";
    node.detail = "detail\x1bPpayload\x1b\\ok";
    const ui = createUi();
    ui.selected.set(run.id, node.id);
    const text = frame({ ...base, runs: [run] }, { cols: 80, ui }).join("\n");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Asserts no raw control bytes survive.
    expect(text.replace(SGR, "")).not.toMatch(/[\x1b\x9b\x07]/);
    expect(strip(text)).toContain("HackRed");
    expect(strip(text)).toContain("detailok");
  });

  test("key parser maps terminal sequences", () => {
    expect(parseKeys("jk\x1b[A\x1b[B\x1b[C\x1b[D\x1b[5~\x1b[6~\r\x1bq?tcpoh\x1b[1;5C")).toEqual([
      "down",
      "up",
      "up",
      "down",
      "right",
      "left",
      "pageup",
      "pagedown",
      "enter",
      "escape",
      "quit",
      "help",
      "toggle",
      "fold",
      "critical",
      "open",
      "history",
    ]);
  });
});

describe("omp-herdr-dag transcript reader", () => {
  test("returns only new complete entries and resets after truncation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-dag-transcript-"));
    try {
      const file = join(dir, "child.jsonl");
      const entry = (text: string): string =>
        `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
      const reader = new TranscriptReader(file);
      expect(await reader.read()).toEqual({ entries: [], reset: false });
      await writeFile(file, `${JSON.stringify({ type: "session", id: "c" })}\n${entry("one")}`);
      expect((await reader.read()).entries).toHaveLength(2);
      const partial = entry("three");
      await appendFile(file, `${entry("two")}${partial.slice(0, 10)}`);
      const second = await reader.read();
      expect(second.reset).toBe(false);
      expect(transcriptLines(second.entries)).toEqual([{ tone: "text", text: "two" }]);
      await appendFile(file, partial.slice(10));
      expect(transcriptLines((await reader.read()).entries)).toEqual([{ tone: "text", text: "three" }]);
      expect((await reader.read()).entries).toEqual([]);
      await writeFile(file, entry("fresh"));
      const truncated = await reader.read();
      expect(truncated.reset).toBe(true);
      expect(transcriptLines(truncated.entries)).toEqual([{ tone: "text", text: "fresh" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formats tool calls, the first result lines and errors", () => {
    const lines = transcriptLines([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }] },
      },
      {
        type: "message",
        message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "a\nb\nc\nd\ne" }], isError: false },
      },
      {
        type: "message",
        message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "missing\x1b[31m" }], isError: true },
      },
      { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" } },
    ]);
    expect(lines).toEqual([
      { tone: "tool", text: "bash(bun test)" },
      { tone: "result", text: "  a" },
      { tone: "result", text: "  b" },
      { tone: "result", text: "  c" },
      { tone: "result", text: "  … 2 more lines" },
      { tone: "error", text: "  missing" },
      { tone: "error", text: "overloaded" },
    ]);
  });
});

// ── Live process with fakes ───────────────────────────────────────────────────

class FakeClock implements Clock {
  time = 1_000_000;
  #id = 0;
  #timers = new Map<number, { at: number; every?: number; callback: () => void }>();
  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): number {
    this.#timers.set(++this.#id, { at: this.time + ms, callback });
    return this.#id;
  }
  setInterval(callback: () => void, ms: number): number {
    this.#timers.set(++this.#id, { at: this.time + ms, every: ms, callback });
    return this.#id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      let next: [number, { at: number; every?: number; callback: () => void }] | undefined;
      for (const entry of this.#timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      this.time = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.#timers.delete(id);
      timer.callback();
      await settle();
    }
    this.time = end;
  }
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
};

interface Peer {
  handlers: ConnectionHandlers;
  written: string[];
  closed: boolean;
}
function fakeNetwork() {
  const network = {
    peers: [] as Peer[],
    attempts: 0,
    refuse: false,
    connect: (async (_path, handlers) => {
      network.attempts += 1;
      if (network.refuse) throw new Error("ECONNREFUSED");
      const peer: Peer = { handlers, written: [], closed: false };
      network.peers.push(peer);
      return {
        write: (data) => void peer.written.push(data),
        close: () => {
          peer.closed = true;
        },
      };
    }) as Connect,
  };
  return network;
}
function send(peer: Peer | undefined, frame: Record<string, unknown> & { seq: number; type: Frame["type"] }): void {
  peer?.handlers.data(encodeFrame({ v: 1, ...frame } as Frame));
}
function received(peer: Peer | undefined): Frame[] {
  return new FrameParser().feed(peer?.written.join("") ?? "");
}

async function startViewer(options: { finish?: "close-with-omp" | "keep-open"; state?: string; snapshot?: string } = {}) {
  const clock = new FakeClock();
  const network = fakeNetwork();
  const execs: string[][] = [];
  const exits: number[] = [];
  const viewer = new Viewer(
    {
      socket: "/tmp/fake.sock",
      pane: "pane-7",
      finish: options.finish ?? "close-with-omp",
      state: options.state,
      snapshot: options.snapshot,
    },
    {
      clock,
      connect: network.connect,
      exec: async (argv) => {
        execs.push(argv);
        return { code: 0, stdout: "" };
      },
      exit: (code) => void exits.push(code),
      screen: { columns: 60, rows: 30, write: () => {} },
      mode: "truecolor",
    },
  );
  await viewer.start();
  return { viewer, clock, network, execs, exits };
}

describe("omp-herdr-dag viewer process", () => {
  test("delta base mismatch requests a resync", async () => {
    const snapshot = await fixture("todo-only");
    const { viewer, network } = await startViewer();
    const peer = network.peers[0];
    expect(received(peer).map((frame) => frame.type)).toEqual(["ready"]);
    send(peer, { seq: 1, type: "hello", sessionId: snapshot.sessionId, pid: 1, generation: 1, paths: { snapshot: "", state: "" } });
    send(peer, { seq: 2, type: "snapshot", snapshot });
    send(peer, { seq: 3, type: "delta", base: 2, ops: [{ op: "removeTask", id: "sub-model" }] });
    expect(viewer.seq).toBe(3);
    expect(viewer.snapshot?.tasks).toEqual([]);
    send(peer, { seq: 9, type: "delta", base: 7, ops: [{ op: "removeRun", id: snapshot.runs[0]?.id ?? "" }] });
    send(peer, { seq: 10, type: "delta", base: 9, ops: [] });
    expect(received(peer).filter((frame) => frame.type === "resync")).toHaveLength(1);
    expect(viewer.snapshot?.runs).toHaveLength(1);
    send(peer, { seq: 11, type: "snapshot", snapshot });
    send(peer, { seq: 12, type: "delta", base: 99, ops: [] });
    expect(received(peer).filter((frame) => frame.type === "resync")).toHaveLength(2);
    viewer.stop();
  });

  test("a session op rebinds snapshot and view-state paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-dag-viewer-"));
    try {
      const oldPaths = { snapshot: join(dir, "a", "snapshot.json"), state: join(dir, "a", "view-state.json") };
      const newPaths = { snapshot: join(dir, "b", "snapshot.json"), state: join(dir, "b", "view-state.json") };
      const snapshot = await fixture("todo-only");
      const { viewer, network } = await startViewer({ state: oldPaths.state, snapshot: oldPaths.snapshot });
      const peer = network.peers[0];
      send(peer, { seq: 1, type: "hello", sessionId: snapshot.sessionId, pid: 1, generation: 1, paths: oldPaths });
      send(peer, { seq: 2, type: "snapshot", snapshot });
      await viewer.key("toggle");
      await viewer.flush();
      expect((await readViewState(oldPaths.state))?.view).toBe("tasks");
      send(peer, {
        seq: 3,
        type: "delta",
        base: 2,
        ops: [{ op: "session", sessionId: "next-session", sessionName: "next", generation: 2, paths: newPaths }],
      });
      expect(viewer.paths).toEqual(newPaths);
      expect(viewer.snapshot?.runs).toEqual([]);
      await viewer.key("critical");
      await viewer.flush();
      expect(await readViewState(newPaths.state)).toMatchObject({ version: 1, view: "tasks", criticalPath: true });
      expect((await readViewState(oldPaths.state))?.criticalPath).toBe(false);
      viewer.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("three missed heartbeats under close-with-omp close the own pane and exit", async () => {
    const { viewer, clock, network, execs, exits } = await startViewer();
    const peer = network.peers[0];
    send(peer, { seq: 1, type: "hello", sessionId: "s", pid: 1, generation: 1, paths: { snapshot: "", state: "" } });
    for (let beat = 0; beat < 3; beat += 1) {
      await clock.advance(2000);
      send(peer, { seq: 1, type: "heartbeat", at: clock.now() });
    }
    expect(execs).toEqual([]);
    await clock.advance(5000);
    expect(execs).toEqual([]);
    await clock.advance(1000);
    expect(execs).toEqual([["herdr", "pane", "close", "pane-7"]]);
    expect(exits).toEqual([0]);
    expect(viewer.exiting).toBe(true);
  });

  test("three missed heartbeats under keep-open show the banner and keep retrying every second", async () => {
    const { viewer, clock, network, execs, exits } = await startViewer({ finish: "keep-open" });
    const snapshot = await fixture("todo-only");
    const first = network.peers[0];
    send(first, { seq: 1, type: "hello", sessionId: snapshot.sessionId, pid: 1, generation: 1, paths: { snapshot: "", state: "" } });
    send(first, { seq: 2, type: "snapshot", snapshot });
    expect(viewer.frame().map(strip).join("\n")).not.toContain("disconnected");
    network.refuse = true;
    await clock.advance(6000);
    expect(viewer.hostGone).toBe(true);
    expect(first?.closed).toBe(true);
    expect(viewer.frame().map(strip).join("\n")).toContain("disconnected from OMP · retrying every 1 s");
    const before = network.attempts;
    await clock.advance(3000);
    expect(network.attempts - before).toBe(3);
    expect(execs).toEqual([]);
    expect(exits).toEqual([]);
    network.refuse = false;
    await clock.advance(1000);
    const second = network.peers[1];
    expect(received(second).map((frame) => frame.type)).toEqual(["ready"]);
    send(second, { seq: 1, type: "hello", sessionId: snapshot.sessionId, pid: 1, generation: 2, paths: { snapshot: "", state: "" } });
    send(second, { seq: 2, type: "heartbeat", at: clock.now() });
    expect(viewer.link).toBe("live");
    expect(viewer.frame().map(strip).join("\n")).not.toContain("disconnected");
    viewer.stop();
  });

  test("q sends closed, closes the own pane and exits", async () => {
    const { viewer, network, execs, exits } = await startViewer();
    await viewer.key("quit");
    expect(received(network.peers[0]).map((frame) => frame.type)).toEqual(["ready", "closed"]);
    expect(execs).toEqual([["herdr", "pane", "close", "pane-7"]]);
    expect(exits).toEqual([0]);
  });

  test("connects over a real Unix socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hd-"));
    const path = join(dir, "v.sock");
    const snapshot = await fixture("plan");
    const ready = Promise.withResolvers<string>();
    const drawn = Promise.withResolvers<string>();
    const server = Bun.listen({
      unix: path,
      socket: {
        data(socket, chunk) {
          ready.resolve(chunk.toString());
          const paths = { snapshot: "", state: "" };
          socket.write(encodeFrame({ v: 1, seq: 1, type: "hello", sessionId: snapshot.sessionId, pid: 1, generation: 1, paths }));
          socket.write(encodeFrame({ v: 1, seq: 2, type: "snapshot", snapshot }));
        },
      },
    });
    // Renders run on a microtask and the watchdog never fires, so the test waits only on socket I/O.
    const clock: Clock = {
      now: () => snapshot.at,
      setTimeout: (callback) => queueMicrotask(callback),
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    };
    const screen = {
      columns: 50,
      rows: 20,
      write: (text: string) => {
        if (strip(text).includes("Plan: Herdr DAG pane")) drawn.resolve(text);
      },
    };
    const viewer = new Viewer({ socket: path, finish: "close-with-omp" }, { screen, clock, exit: () => {} });
    try {
      await viewer.start();
      expect(new FrameParser().feed(await ready.promise).map((frame) => frame.type)).toEqual(["ready"]);
      await drawn.promise;
      expect(viewer.snapshot?.runs[0]?.source).toBe("plan");
      expect(viewer.link).toBe("live");
    } finally {
      viewer.stop();
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
