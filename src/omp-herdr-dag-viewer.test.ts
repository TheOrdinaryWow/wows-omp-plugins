import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DagNode, NodeState, Run, Snapshot } from "../plugins/omp-herdr-dag/src/model.ts";
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

// ── Frame geometry ────────────────────────────────────────────────────────────

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Terminal cells of a frame; a wide grapheme is followed by an empty continuation cell. */
function cells(lines: string[]): string[][] {
  return lines.map((line) =>
    Array.from(SEGMENTER.segment(strip(line)), ({ segment }) => segment).flatMap((segment) =>
      Bun.stringWidth(segment) === 2 ? [segment, ""] : [segment],
    ),
  );
}
/** Cell content; a space outside the frame or on a wide grapheme's continuation. */
const at = (grid: string[][], x: number, y: number): string => grid[y]?.[x] || " ";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** The node box whose first label line starts with `label`, found by its complete border. */
function boxOf(grid: string[][], label: string): Rect | undefined {
  for (let y = 1; y < grid.length; y += 1) {
    for (let x = 4; x < (grid[y]?.length ?? 0); x += 1) {
      // A label starts after the left border, a space, the state icon and a space.
      const left = x - 4;
      if (grid[y]?.slice(x, x + label.length).join("") !== label) continue;
      if (!"│║┃".includes(at(grid, left, y)) || !"╭╔┏".includes(at(grid, left, y - 1))) continue;
      let right = left + 1;
      while (right < (grid[y - 1]?.length ?? 0) && !"╮╗┓".includes(at(grid, right, y - 1))) right += 1;
      let bottom = y;
      while ("│║┃".includes(at(grid, left, bottom))) bottom += 1;
      if ("╮╗┓".includes(at(grid, right, y - 1)) && "╰╚┗".includes(at(grid, left, bottom))) {
        return { x: left, y: y - 1, w: right - left + 1, h: bottom - y + 2 };
      }
    }
  }
  return undefined;
}

/** Directions each connector glyph joins: up 1, right 2, down 4, left 8 (light, heavy and dotted strokes). */
const JOINS: Record<string, number> = {
  "╵": 1,
  "╷": 4,
  "╴": 8,
  "╶": 2,
  "│": 5,
  "─": 10,
  "╰": 3,
  "╯": 9,
  "╭": 6,
  "╮": 12,
  "├": 7,
  "┤": 13,
  "┬": 14,
  "┴": 11,
  "┼": 15,
  "╹": 1,
  "╻": 4,
  "╸": 8,
  "╺": 2,
  "┃": 5,
  "━": 10,
  "┗": 3,
  "┛": 9,
  "┏": 6,
  "┓": 12,
  "┣": 7,
  "┫": 13,
  "┳": 14,
  "┻": 11,
  "╋": 15,
  "┆": 5,
  "┄": 10,
  "▼": 1,
};
const HEAVY = "╹╻╸╺┃━┗┛┏┓┣┫┳┻╋";

/**
 * Labels of the boxes whose entry arrow is reached from `from`'s outgoing tee by following joined connector glyphs
 * around other boxes. Forward edges run only down and sideways; `upward` also follows backward lanes and `heavyOnly`
 * only critical-path strokes.
 */
function reached(
  grid: string[][],
  boxes: Map<string, Rect>,
  from: string,
  options: { upward?: boolean; heavyOnly?: boolean } = {},
): string[] {
  const source = boxes.get(from) as Rect;
  const bottom = source.y + source.h - 1;
  const queue: Array<[number, number]> = [];
  for (let x = source.x; x < source.x + source.w; x += 1) {
    if ("┬╦┳".includes(at(grid, x, bottom)) && (JOINS[at(grid, x, bottom + 1)] ?? 0) & 1) queue.push([x, bottom + 1]);
  }
  const seen = new Set<string>();
  const found = new Set<string>();
  while (queue.length) {
    const [x, y] = queue.pop() as [number, number];
    if (seen.has(`${x},${y}`)) continue;
    seen.add(`${x},${y}`);
    const cell = at(grid, x, y);
    if (cell === "▼") {
      for (const [label, box] of boxes) if (box.y === y + 1 && x > box.x && x < box.x + box.w - 1) found.add(label);
      continue;
    }
    if (options.heavyOnly && !HEAVY.includes(cell)) continue;
    for (const [bit, dx, dy, back] of [
      [1, 0, -1, 4],
      [2, 1, 0, 8],
      [4, 0, 1, 1],
      [8, -1, 0, 2],
    ] as const) {
      const [nx, ny] = [x + dx, y + dy];
      if (!((JOINS[cell] ?? 0) & bit) || (bit === 1 && !options.upward)) continue;
      if ([...boxes.values()].some((box) => nx >= box.x && nx < box.x + box.w && ny >= box.y && ny < box.y + box.h)) continue;
      if ((JOINS[at(grid, nx, ny)] ?? 0) & back) queue.push([nx, ny]);
    }
  }
  return [...found].sort();
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

  test("narrow panes wrap a band's nodes onto extra rows instead of scrolling sideways", async () => {
    const snapshot = await fixture("narrow");
    const labels = ["Check omp", "Back up", "Upgrade omp", "Migrate", "Run smoke"];
    const boxesAt = (cols: number): Rect[] => {
      const ui = createUi();
      const lines = frame(snapshot, { cols, rows: 60, ui });
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
      expect(ui.scrollX).toBe(0);
      // One titled separator per band; wrapped rows of a band get none between them.
      expect(lines.map(strip).filter((line) => line.includes("╌"))).toEqual([
        expect.stringContaining(" Preflight "),
        expect.stringContaining(" Upgrade "),
      ]);
      const grid = cells(lines);
      return labels.map((label) => {
        const box = boxOf(grid, label);
        if (!box) throw new Error(`${label} is not fully visible at ${cols} columns`);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(cols);
        return box;
      });
    };
    // 30 columns: one node per row, in order, down both bands.
    const narrow = boxesAt(30).map((box) => box.y);
    expect(new Set(narrow).size).toBe(5);
    expect(narrow).toEqual([...narrow].sort((a, b) => a - b));
    // 50 columns: two per row; the third Upgrade node starts a row below the first two.
    const [p1, p2, u1, u2, u3] = boxesAt(50) as [Rect, Rect, Rect, Rect, Rect];
    expect([p2.y, u2.y]).toEqual([p1.y, u1.y]);
    expect(p1.x).toBeLessThan(p2.x);
    expect(u1.x).toBeLessThan(u2.x);
    expect(u3.y).toBeGreaterThanOrEqual(u1.y + u1.h);
    // 100 columns: every layer stays a single row, as before wrapping existed.
    const wide = boxesAt(100);
    expect(new Set(wide.slice(0, 2).map((box) => box.y)).size).toBe(1);
    expect(new Set(wide.slice(2).map((box) => box.y)).size).toBe(1);
  });

  test("wrapped layers keep dependency, backward and critical-path connectors attached to their boxes", async () => {
    const base = await fixture("narrow");
    const node = (label: string, band: number, bandName: string, state: NodeState = "pending"): DagNode => ({
      id: label,
      label,
      state,
      band,
      bandName,
      taskIds: [],
    });
    const leaves = ["Leaf 1", "Leaf 2", "Leaf 3", "Leaf 4"];
    const run: Run = {
      id: "todo:s:1",
      source: "todo",
      title: "Deps",
      generation: 1,
      nodes: [
        { ...node("Root", 0, "Plan", "done"), startedAt: 0, finishedAt: 100 },
        ...leaves.map((label) =>
          label === "Leaf 2" ? { ...node(label, 1, "Build", "running"), startedAt: 100 } : node(label, 1, "Build"),
        ),
        node("Sink", 2, "Ship"),
        node("Docs", 2, "Ship"),
      ],
      edges: [
        ...leaves.map((label) => ({ from: "Root", to: label, kind: "depends" as const })),
        ...leaves.map((label) => ({ from: label, to: "Sink", kind: "depends" as const })),
        { from: "Docs", to: "Root", kind: "depends" },
      ],
      createdAt: 0,
      updatedAt: 100,
      stats: { done: 1, total: 7, elapsedMs: 1000 },
    };
    const snapshot: Snapshot = { ...base, at: 1000, runs: [run], tasks: [] };
    for (const cols of [30, 50]) {
      for (const criticalPath of [false, true]) {
        const ui = createUi();
        const lines = frame(snapshot, { cols, rows: 80, ui, viewState: { ...DEFAULT_VIEW_STATE, criticalPath } });
        for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(cols);
        expect(ui.scrollX).toBe(0);
        const grid = cells(lines);
        const boxes = new Map<string, Rect>();
        for (const { label } of run.nodes) {
          const box = boxOf(grid, label);
          if (!box) throw new Error(`${label} is not fully visible at ${cols} columns`);
          boxes.set(label, box);
        }
        // The 4-node layer stacks one per row at 30 columns and two per row at 50.
        expect(new Set(leaves.map((label) => boxes.get(label)?.y)).size).toBe(cols === 30 ? 4 : 2);
        for (const edge of run.edges.filter((item) => item.from !== "Docs")) expect(reached(grid, boxes, edge.from)).toContain(edge.to);
        expect(reached(grid, boxes, "Docs", { upward: true })).toContain("Root");
        const text = lines.map(strip).join("\n");
        expect(text).toContain("↑ after Docs");
        expect(lines.map(strip).filter((line) => line.includes("╌"))).toEqual(
          ["Plan", "Build", "Ship"].map((band) => expect.stringContaining(` ${band} `)),
        );
        if (!criticalPath) {
          expect(text).toContain("┆");
          expect(text).not.toContain("━");
          continue;
        }
        // Docs → Root → Leaf 2 → Sink: the heavy strokes join exactly those boxes.
        expect(reached(grid, boxes, "Docs", { upward: true, heavyOnly: true })).toEqual(["Root"]);
        expect(reached(grid, boxes, "Root", { heavyOnly: true })).toEqual(["Leaf 2"]);
        expect(reached(grid, boxes, "Leaf 2", { heavyOnly: true })).toEqual(["Sink"]);
      }
    }
  });

  test("j/k selection walks wrapped rows left to right, then top to bottom", async () => {
    const snapshot = await fixture("narrow");
    const labels = ["Check omp", "Back up", "Upgrade omp", "Migrate", "Run smoke"];
    for (const cols of [30, 50]) {
      const ui = createUi();
      const viewState: ViewState = { ...DEFAULT_VIEW_STATE, folded: [] };
      const grid = (): string[][] => cells(frame(snapshot, { cols, rows: 60, ui, viewState }));
      const first = grid();
      const visual = [...labels].sort((a, b) => {
        const [p, q] = [boxOf(first, a) as Rect, boxOf(first, b) as Rect];
        return p.y - q.y || p.x - q.x;
      });
      for (let step = 0; step < labels.length; step += 1) handleKey({ snapshot, viewState, ui, now: snapshot.at }, "up");
      const walked: Array<string | undefined> = [];
      for (let step = 0; step < labels.length; step += 1) {
        if (step) handleKey({ snapshot, viewState, ui, now: snapshot.at }, "down");
        const current = grid();
        walked.push(
          labels.find((label) => {
            const box = boxOf(current, label);
            return box !== undefined && at(current, box.x, box.y) === "╔";
          }),
        );
      }
      expect(walked).toEqual(visual);
    }
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

  test("viewer startup recovers both v1 and v2 snapshots from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-dag-viewer-upgrade-"));
    try {
      const snapshot = await fixture("tasks");
      for (const version of [1, 2]) {
        const path = join(dir, `snapshot-v${version}.json`);
        await writeFile(path, JSON.stringify({ ...snapshot, version }));
        const { viewer } = await startViewer({ snapshot: path });
        try {
          expect(viewer.snapshot).toEqual(snapshot);
          expect(viewer.snapshot?.version).toBe(2);
          expect(viewer.snapshot?.tasks.length).toBeGreaterThan(0);
          expect(await readSnapshot(path)).toEqual(snapshot);
        } finally {
          viewer.stop();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
