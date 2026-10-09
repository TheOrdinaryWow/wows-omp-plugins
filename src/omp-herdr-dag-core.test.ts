import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crossingCount, GRID, laneMargin, layoutRun, type RunLayout, rowBudget, rowSpan } from "../plugins/omp-herdr-dag/src/layout.ts";
import {
  type AtlasRow,
  atlasRun,
  attachTask,
  type Run,
  runStats,
  type Snapshot,
  sanitizeText,
  type TodoPhase,
  taskTotals,
  todoRun,
  validateTodoEdges,
} from "../plugins/omp-herdr-dag/src/model.ts";
import {
  type PaneState,
  readPane,
  readSnapshot,
  readVersioned,
  readViewState,
  type ViewState,
  writePane,
  writeSnapshot,
  writeViewState,
} from "../plugins/omp-herdr-dag/src/persisted.ts";
import { applyOps, encodeFrame, type Frame, FrameParser, MAX_FRAME_BYTES, type Op } from "../plugins/omp-herdr-dag/src/protocol.ts";

function phases(): TodoPhase[] {
  return [
    {
      name: "Build",
      tasks: [
        { content: "A", status: "in_progress" },
        { content: "B", status: "pending" },
      ],
    },
    {
      name: "Check",
      tasks: [
        { content: "C", status: "blocked" },
        { content: "D", status: "completed" },
        { content: "E", status: "abandoned" },
      ],
    },
  ];
}

export function snapshot(runs: Run[] = []): Snapshot {
  return {
    version: 2,
    sessionId: "session",
    generation: 1,
    connected: true,
    at: 100,
    runs,
    tasks: [],
    atlasAvailable: false,
    theme: {
      text: "#ffffff",
      muted: "#aaaaaa",
      dim: "#777777",
      accent: "#eeeeee",
      success: "#00ff00",
      error: "#ff0000",
      warning: "#ffff00",
      border: "#888888",
      borderAccent: "#eeeeee",
      borderMuted: "#444444",
    },
    sources: { todo: "#4f8cff", plan: "#a371f7", atlas: "#3fb950" },
  };
}

describe("DAG model", () => {
  test("todo bands, exact ids, states, init generation, removed nodes and edges", () => {
    const first = todoRun({ sessionId: "session", generation: 1, phases: phases(), now: 100, edges: [{ task: "B", after: ["A"] }] });
    expect(first.id).toBe("todo:session:1");
    expect(first.nodes[0]?.id).toBe("todo:1:0:6dcd4ce23d");
    expect(first.nodes.map((node) => node.state)).toEqual(["running", "pending", "blocked", "done", "abandoned"]);
    expect(first.nodes.map((node) => node.band)).toEqual([0, 0, 1, 1, 1]);
    const rm = phases();
    rm[0]?.tasks.shift();
    const second = todoRun({ sessionId: "session", generation: 1, phases: rm, previous: first, now: 150 });
    expect(second.nodes).toHaveLength(4);
    expect(second.edges).toEqual([]);
    const drop = todoRun({ sessionId: "session", generation: 1, phases: rm.slice(1), previous: second, now: 200 });
    expect(drop.nodes.map((node) => node.label)).toEqual(["C", "D", "E"]);
    const init = todoRun({ sessionId: "session", generation: 2, phases: phases(), previous: first, now: 250 });
    expect(init.id).toBe("todo:session:2");
    expect(init.createdAt).toBe(250);
    expect(init.edges).toEqual([]);
    const rename = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [{ name: "Build", tasks: [{ content: "renamed", status: "pending" }] }],
      previous: first,
    });
    expect(rename.nodes[0]?.id).not.toBe(first.nodes[0]?.id);
    expect(rename.edges).toEqual([]);
  });

  test("edge validation keeps valid dependencies and reports malformed, unknown and cyclic edges", () => {
    const valid = validateTodoEdges(phases(), [
      { task: "B", after: ["A", "missing"] },
      { task: "A", after: ["B"] },
      null,
      { task: "D", after: ["D"] },
    ]);
    expect(valid.edges).toEqual([{ task: "B", after: ["A"] }]);
    expect(valid.warnings).toHaveLength(4);
    expect(validateTodoEdges(phases(), "invalid").warnings).toHaveLength(1);
    const run = todoRun({ sessionId: "session", generation: 1, phases: phases(), edges: valid.edges });
    expect(run.edges).toEqual([{ from: run.nodes[0]?.id as string, to: run.nodes[1]?.id as string, kind: "depends" }]);
  });

  test("Atlas depends and fix edges, gates last, preserved children and timestamps", () => {
    const rows: AtlasRow[] = [
      { id: "F1", title: "Gate", kind: "gate", status: "open", agent: "reviewer", dependsOn: ["T1"], updatedAt: 10 },
      {
        id: "T1",
        title: "Work",
        kind: "task",
        status: "done",
        agent: "worker",
        dependsOn: [],
        updatedAt: 12,
        childAgentId: "child",
        startedAt: 2,
      },
      { id: "X1", title: "Fix", kind: "fix", status: "in_progress", agent: "worker", dependsOn: ["T1"], origin: "F1", updatedAt: 15 },
    ];
    const run = atlasRun({ plan: { id: "p", name: "Plan" }, rows, at: 20 });
    expect(run.source).toBe("atlas");
    expect(run.id).toBe("atlas:p");
    expect(run.nodes.find((node) => node.id === "atlas:F1")?.band).toBe(3);
    expect(run.edges).toContainEqual({ from: "atlas:T1", to: "atlas:F1", kind: "depends" });
    expect(run.edges).toContainEqual({ from: "atlas:X1", to: "atlas:F1", kind: "fix" });
    expect(run.nodes.find((node) => node.id === "atlas:T1")?.taskIds).toEqual(["child"]);
    expect(run.nodes.find((node) => node.id === "atlas:T1")?.finishedAt).toBe(12);
  });

  test("activation restarts retain totals, repeat progress replaces counters and duplicate linked rows count once", () => {
    let card = attachTask(undefined, { id: "child", status: "started", at: 100, nodeId: "n", agent: "worker" });
    card = attachTask(card, { id: "child", status: "progress", at: 150, tokens: 100, costUsd: 0.1, durationMs: 50 });
    card = attachTask(card, { id: "child", status: "completed", at: 200, durationMs: 100 });
    expect(taskTotals(card)).toEqual({ tokens: 100, costUsd: 0.1, durationMs: 100 });
    card = attachTask(card, { id: "child", status: "completed", at: 205, tokens: 100 });
    card = attachTask(card, { id: "child", status: "started", at: 250, detached: true });
    for (let index = 0; index < 2; index += 1)
      card = attachTask(card, { id: "child", status: "progress", at: 260, tokens: 20, costUsd: 0.02, durationMs: 10 });
    expect(taskTotals(card).tokens).toBe(120);
    card = attachTask(card, { id: "child", status: "completed", at: 300, durationMs: 50 });
    expect(card.activations).toBe(2);
    expect(taskTotals(card)).toEqual({ tokens: 120, costUsd: 0.12000000000000001, durationMs: 150 });
    const run = todoRun({ sessionId: "session", generation: 1, phases: phases(), now: 100 });
    run.nodes.slice(0, 2).forEach((node) => {
      node.taskIds = ["child"];
    });
    expect(runStats(run, [card, card], 400)).toEqual({ done: 2, total: 5, elapsedMs: 300, tokens: 120, costUsd: 0.12000000000000001 });
    expect(runStats(run, [], 400).tokens).toBeUndefined();
  });

  test("terminal elapsed freezes; blocked is not done; text strips controls but preserves CJK and lines", () => {
    const run = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [{ name: "Work", tasks: [{ content: "A", status: "in_progress" }] }],
      now: 100,
    });
    const done = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [{ name: "Work", tasks: [{ content: "A", status: "completed" }] }],
      previous: run,
      now: 200,
    });
    expect(runStats(done, [], 500).elapsedMs).toBe(100);
    expect(sanitizeText("\u001b[31m中文\u001b[0m\u001b]0;bad\u0007\u001bPbad\u001b\\\u0000\nnext")).toBe("中文\nnext");
  });
});

describe("wire protocol and persistence", () => {
  test("streaming partial UTF-8, concatenated frames, invalid/version rejection and byte limit", () => {
    const parser = new FrameParser();
    const first: Frame = { v: 1, seq: 1, type: "hello", sessionId: "中文", pid: 10, generation: 1, paths: { snapshot: "a", state: "b" } };
    const bytes = Buffer.from(encodeFrame(first));
    const split = bytes.indexOf(Buffer.from("中")) + 1;
    expect(parser.feed(bytes.subarray(0, split))).toEqual([]);
    expect(parser.feed(bytes.subarray(split))).toEqual([first]);
    const heartbeat: Frame = { v: 1, seq: 2, type: "heartbeat", at: 100 };
    expect(parser.feed(`${encodeFrame(heartbeat)}bad\n{"v":2,"seq":3,"type":"ready"}\n${encodeFrame(heartbeat)}`)).toEqual([
      heartbeat,
      heartbeat,
    ]);
    expect(parser.ignored).toBe(2);
    const oversized = new FrameParser();
    expect(oversized.feed("x".repeat(MAX_FRAME_BYTES))).toEqual([]);
    expect(oversized.dropped).toBe(false);
    oversized.feed("x");
    expect(oversized.dropped).toBe(true);
    expect(oversized.feed(encodeFrame(heartbeat))).toEqual([]);
    const single = new FrameParser();
    single.feed(`${"中".repeat(Math.ceil(MAX_FRAME_BYTES / 3))}\n`);
    expect(single.dropped).toBe(true);
  });

  test("operations reproduce snapshots, removals and session paths; mismatch changes nothing", () => {
    const initial = snapshot();
    const run = todoRun({ sessionId: "session", generation: 1, phases: phases(), now: 100 });
    const task = attachTask(undefined, { id: "child", status: "started", at: 100 });
    const ops: Op[] = [
      { op: "run", run },
      { op: "task", task },
      { op: "atlas", available: true },
      { op: "theme", theme: { ...initial.theme, accent: "#123456" } },
    ];
    const first = applyOps(initial, { v: 1, seq: 2, type: "delta", base: 1, ops }, 1);
    expect(first.snapshot).toEqual({
      ...initial,
      runs: [run],
      tasks: [task],
      atlasAvailable: true,
      theme: { ...initial.theme, accent: "#123456" },
    });
    const bad = applyOps(first.snapshot, { v: 1, seq: 4, type: "delta", base: 3, ops: [] }, 2);
    expect(bad.baseMismatch).toBe(true);
    expect(bad.snapshot).toBe(first.snapshot);
    expect(bad.seq).toBe(2);
    const removed = applyOps(
      first.snapshot,
      {
        v: 1,
        seq: 3,
        type: "delta",
        base: 2,
        ops: [
          { op: "removeRun", id: run.id },
          { op: "removeTask", id: task.id },
        ],
      },
      2,
    );
    expect(removed.snapshot.runs).toEqual([]);
    expect(removed.snapshot.tasks).toEqual([]);
    const paths = { snapshot: "new/snapshot.json", state: "new/view-state.json" };
    const rebound = applyOps(
      first.snapshot,
      { v: 1, seq: 3, type: "delta", base: 2, ops: [{ op: "session", sessionId: "new", sessionName: "Next", generation: 2, paths }] },
      2,
    );
    expect(rebound.paths).toEqual(paths);
    expect(rebound.snapshot).toEqual({
      ...first.snapshot,
      sessionId: "new",
      sessionName: "Next",
      generation: 2,
      runs: [],
      tasks: [],
      atlasAvailable: false,
    });
  });

  test("the snapshot reader upgrades a v1 disk snapshot without losing recovery data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dag-core-upgrade-"));
    try {
      const run = todoRun({ sessionId: "session", generation: 3, phases: phases(), now: 100, edges: [{ task: "B", after: ["A"] }] });
      const card = attachTask(undefined, { id: "child", status: "started", agent: "worker", at: 100, nodeId: run.nodes[0]?.id });
      card.completed = { tokens: 100, costUsd: 0.1, durationMs: 40 };
      card.current = { tokens: 20, costUsd: 0.02, durationMs: 10 };
      card.activations = 2;
      card.sessionFile = "/session/child.jsonl";
      const previous = { ...snapshot([run]), version: 1, tasks: [card], sessionName: "In flight", generation: 3 };
      delete previous.tasks[0]?.stalled;
      const path = join(dir, "snapshot.json");
      await writeFile(path, JSON.stringify(previous));
      const restored = await readSnapshot(path);
      expect(restored?.version).toBe(2);
      expect(restored).toEqual(JSON.parse(JSON.stringify({ ...previous, version: 2 })));
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(restored);
      expect(await readSnapshot(path)).toEqual(restored);
      expect(taskTotals(restored?.tasks[0] as NonNullable<typeof restored>["tasks"][number]).tokens).toBe(120);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("v2 snapshot and pane plus v1 view state write/reopen; unknown version ignored and reset atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dag-core-"));
    try {
      const snap = snapshot();
      const pane: PaneState = {
        version: 2,
        phase: "open",
        paneId: "pane",
        tabId: "tab",
        hostPaneId: "host",
        orientation: "landscape",
        position: "right",
        launchedAt: 100,
        dismissed: false,
      };
      const state: ViewState = { version: 1, folded: ["layer"], view: "tasks", selectedRun: "run", criticalPath: true };
      await writeSnapshot(join(dir, "snapshot.json"), snap);
      await writePane(join(dir, "pane.json"), pane);
      await writeViewState(join(dir, "view-state.json"), state);
      expect(await readSnapshot(join(dir, "snapshot.json"))).toEqual(snap);
      expect(await readPane(join(dir, "pane.json"))).toEqual(pane);
      expect(await readViewState(join(dir, "view-state.json"))).toEqual(state);
      await writeFile(join(dir, "snapshot.json"), '{"version":99}');
      expect(await readSnapshot(join(dir, "snapshot.json"))).toBeUndefined();
      expect(await readVersioned(join(dir, "snapshot.json"), snap)).toEqual(snap);
      expect(JSON.parse(await readFile(join(dir, "snapshot.json"), "utf8"))).toEqual(snap);
      await writeFile(join(dir, "view-state.json"), "{");
      expect(await readViewState(join(dir, "view-state.json"))).toBeUndefined();
      expect((await readdir(dir)).sort()).toEqual(["pane.json", "snapshot.json", "view-state.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("deterministic layered layout", () => {
  test("forward longest paths, band ordering, long edge dummy routing and critical path weights", () => {
    const run = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [
        { name: "Build", tasks: ["A", "B", "C"].map((content) => ({ content, status: "pending" as const })) },
        { name: "Check", tasks: [{ content: "D", status: "pending" }] },
      ],
      edges: [
        { task: "B", after: ["A"] },
        { task: "C", after: ["B"] },
        { task: "D", after: ["A", "C"] },
      ],
      now: 100,
    });
    const layout = layoutRun(run, { foldCompleted: false, width: 80, now: 200 });
    expect(layout.layers.map((layer) => layer.nodes.filter((node) => !node.dummy).map((node) => node.node?.label))).toEqual([
      ["A"],
      ["B"],
      ["C"],
      ["D"],
    ]);
    // A → D is implied by A → B → C → D: the reduced graph leaves it out, every edge routes it through two dummies.
    const isAD = (route: RunLayout["edges"][number]): boolean => route.edge.from === run.nodes[0]?.id && route.edge.to === run.nodes[3]?.id;
    expect(layout.dummies).toHaveLength(0);
    expect(layout.edges.some(isAD)).toBe(false);
    const all = layoutRun(run, { foldCompleted: false, width: 80, now: 200, allEdges: true });
    expect(all.dummies).toHaveLength(2);
    expect(all.edges.find(isAD)?.points).toHaveLength(4);
    // The critical path weighs every dependency, drawn or not.
    expect(layout.criticalPath).toEqual(run.nodes.map((node) => node.id));
    expect(all.criticalPath).toEqual(layout.criticalPath);
    run.nodes.forEach((node, index) => {
      node.startedAt = 100;
      node.finishedAt = 100 + (index + 1) * 10;
    });
    const weighted = layoutRun(run, { foldCompleted: false, width: 80, now: 200 });
    expect(weighted.criticalPath).toEqual(run.nodes.map((node) => node.id));
    const [a, b, c, d] = run.nodes;
    if (!a || !b || !c || !d) throw new Error("fixture missing nodes");
    b.finishedAt = 300;
    run.edges = [
      { from: a.id, to: b.id, kind: "depends" },
      { from: b.id, to: d.id, kind: "depends" },
      { from: a.id, to: c.id, kind: "depends" },
      { from: c.id, to: d.id, kind: "depends" },
    ];
    expect(layoutRun(run, { foldCompleted: false, width: 80 }).criticalPath).toEqual([a.id, b.id, d.id]);
    run.edges = [{ from: a.id, to: d.id, kind: "fix" }];
    expect(layoutRun(run, { foldCompleted: false, width: 80 }).criticalPath).toEqual([]);
  });

  test("two-band backward dependency terminates, retains bands/edge and includes it in critical path", () => {
    const run = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [
        { name: "First", tasks: [{ content: "A", status: "pending" }] },
        { name: "Second", tasks: [{ content: "B", status: "pending" }] },
      ],
      edges: [{ task: "A", after: ["B"] }],
      now: 100,
    });
    const layout = layoutRun(run, { foldCompleted: false, width: 50 });
    expect(layout.layers.map((layer) => layer.band)).toEqual([0, 1]);
    expect(layout.layers.map((layer) => layer.nodes[0]?.node?.label)).toEqual(["A", "B"]);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.backward).toBe(true);
    expect(layout.layers[0]?.nodes[0]?.backReferences).toEqual([{ from: run.nodes[1]?.id as string, label: "B" }]);
    expect(layout.criticalPath).toEqual([run.nodes[1]?.id as string, run.nodes[0]?.id as string]);
    // Invalid external cycles are tolerated without converting band order into dependencies.
    run.edges.push({ from: run.nodes[0]?.id as string, to: run.nodes[1]?.id as string, kind: "depends" });
    expect(layoutRun(run, { foldCompleted: false, width: 50 }).layers).toHaveLength(2);
  });

  test("barycenter sweeps reduce crossings in a six-node fixture and deterministic ties use ids", () => {
    const run = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [
        { name: "Sources", tasks: ["A", "B", "C"].map((content) => ({ content, status: "pending" as const })) },
        { name: "Targets", tasks: ["D", "E", "F"].map((content) => ({ content, status: "pending" as const })) },
      ],
      now: 100,
    });
    run.nodes.forEach((node) => {
      node.id = node.label;
    });
    run.edges = [
      { from: "A", to: "F", kind: "depends" },
      { from: "B", to: "E", kind: "depends" },
      { from: "C", to: "D", kind: "depends" },
    ];
    const result = layoutRun(run, { foldCompleted: false, width: 80 });
    const inputOrder = result.layers.map((layer) => ({ ...layer, nodes: [...layer.nodes].sort((a, b) => a.id.localeCompare(b.id)) }));
    expect(crossingCount(inputOrder, result.edges)).toBe(3);
    expect(crossingCount(result.layers, result.edges)).toBe(0);
    const reversed = { ...run, nodes: [...run.nodes].reverse(), edges: [...run.edges].reverse() };
    expect(layoutRun(reversed, { foldCompleted: false, width: 80 })).toEqual(result);
    const independent = layoutRun({ ...run, edges: [] }, { foldCompleted: false, width: 80 });
    expect(independent.layers.map((layer) => layer.nodes.map((node) => node.id))).toEqual([
      ["A", "B", "C"],
      ["D", "E", "F"],
    ]);
    expect(independent.criticalPath).toEqual([]);
  });

  test("folding yields one summary per terminal layer without losing cross-layer edges", () => {
    const run = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [
        {
          name: "Done",
          tasks: [
            { content: "A", status: "completed" },
            { content: "B", status: "abandoned" },
          ],
        },
        { name: "Working", tasks: [{ content: "C", status: "in_progress" }] },
      ],
      edges: [{ task: "C", after: ["A"] }],
      now: 100,
    });
    const folded = layoutRun(run, { foldCompleted: true, width: 30 });
    expect(folded.folded).toHaveLength(1);
    expect(folded.folded[0]?.count).toBe(2);
    expect(folded.folded[0]?.bandName).toBe("Done");
    expect(folded.layers.map((layer) => layer.folded)).toEqual([true, false]);
    expect(folded.edges.map((route) => route.edge)).toEqual(run.edges);
    expect(layoutRun(run, { foldCompleted: false, width: 30 }).folded).toEqual([]);
    expect(layoutRun({ ...run, nodes: [], edges: [] }, { foldCompleted: true, width: 30 })).toEqual({
      layers: [],
      dummies: [],
      criticalPath: [],
      folded: [],
      edges: [],
      align: "centered",
    });
  });

  test("only layers wider than the overflow budget wrap into rows inside their band; others stay one row and scroll", () => {
    const upgrades = ["C", "D", "E", "F", "G", "H", "I", "J"];
    const run = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [
        { name: "Preflight", tasks: ["A", "B"].map((content) => ({ content, status: "completed" as const })) },
        { name: "Upgrade", tasks: upgrades.map((content) => ({ content, status: "pending" as const })) },
      ],
      now: 100,
    });
    const ids = (layout: RunLayout): string[][] => layout.layers.map((layer) => layer.nodes.map((node) => node.id));
    const wide = layoutRun(run, { foldCompleted: false, width: Number.POSITIVE_INFINITY });
    expect(ids(wide)).toHaveLength(2);
    const [preflight, upgrade] = ids(wide) as [string[], string[]];
    // Eight boxes need 174 columns: they fit a 100-column pane's budget of 200, so the layer pans instead of wrapping.
    expect(rowSpan(8, 0, GRID.minNode)).toBe(174);
    expect(rowBudget(100)).toBe(200);
    expect(layoutRun(run, { foldCompleted: false, width: 100 })).toEqual(wide);
    // A 30-column pane still allows 120 columns, five boxes; the eight wrap into two even rows of four.
    expect(rowBudget(30)).toBe(120);
    const narrow = layoutRun(run, { foldCompleted: false, width: 30 });
    expect(ids(narrow)).toEqual([preflight, upgrade.slice(0, 4), upgrade.slice(4)]);
    expect(narrow.layers.map((layer) => layer.bandName)).toEqual(["Preflight", "Upgrade", "Upgrade"]);
    // Small layers never wrap, however narrow the pane.
    const few = todoRun({
      sessionId: "few",
      generation: 1,
      phases: [{ name: "Gates", tasks: upgrades.slice(0, 4).map((content) => ({ content, status: "pending" as const })) }],
      now: 100,
    });
    expect(layoutRun(few, { foldCompleted: false, width: 30 }).layers).toHaveLength(1);
    // A folded layer stays one summary row however narrow the pane is.
    const folded = layoutRun(run, { foldCompleted: true, width: 30 });
    expect(folded.folded).toEqual([{ layer: 0, band: 0, bandName: "Preflight", count: 2, nodeIds: preflight }]);
    expect(folded.layers.map((layer) => layer.folded)).toEqual([true, false, false]);
  });

  test("wrapped rows keep every edge connected, add no false paths and fit the pane at the minimum node width", () => {
    const leaves = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
    const run = todoRun({
      sessionId: "session",
      generation: 1,
      phases: [
        { name: "Plan", tasks: [{ content: "Root", status: "completed" }] },
        { name: "Build", tasks: leaves.map((content) => ({ content, status: "pending" as const })) },
        { name: "Ship", tasks: ["Sink", "Docs"].map((content) => ({ content, status: "pending" as const })) },
      ],
      edges: [...leaves.map((task) => ({ task, after: ["Root"] })), { task: "Sink", after: leaves }, { task: "Root", after: ["Docs"] }],
      now: 100,
    });
    const id = (label: string): string => run.nodes.find((node) => node.label === label)?.id as string;
    const wide = layoutRun(run, { foldCompleted: false, width: Number.POSITIVE_INFINITY });
    for (const width of [30, 120]) {
      const layout = layoutRun(run, { foldCompleted: false, width });
      const real = (layer: RunLayout["layers"][number]) => layer.nodes.filter((node) => !node.dummy);
      // Wrapping never reorders nodes: rows read left to right, then top to bottom, in the wide order.
      expect(layout.layers.flatMap((layer) => real(layer).map((node) => node.id))).toEqual(
        wide.layers.flatMap((layer) => real(layer).map((node) => node.id)),
      );
      expect(layout.layers.filter((layer) => layer.band === 1).map((layer) => real(layer).length)).toEqual(width === 30 ? [4, 4] : [8]);
      const available = rowBudget(width) - laneMargin(layout.edges.filter((route) => route.backward).length);
      for (const layer of layout.layers) {
        expect(rowSpan(real(layer).length, layer.nodes.length - real(layer).length, GRID.minNode)).toBeLessThanOrEqual(available);
      }
      const level = new Map(layout.layers.flatMap((layer) => layer.nodes.map((node) => [node.id, layer.index] as const)));
      const successors = new Map<string, Set<string>>();
      for (const route of layout.edges) {
        expect(route.points[0]).toBe(route.edge.from);
        expect(route.points.at(-1)).toBe(route.edge.to);
        if (route.backward) continue;
        route.points.slice(1).forEach((point, index) => {
          const previous = route.points[index] as string;
          expect(level.get(point)).toBe((level.get(previous) as number) + 1);
          successors.set(previous, (successors.get(previous) ?? new Set()).add(point));
        });
      }
      // Shared connectors merge only fan-outs of one source or fan-ins to one target, so drawn paths match the edges.
      for (const node of run.nodes) {
        const reached = new Set<string>();
        const queue = [...(successors.get(node.id) ?? [])];
        while (queue.length) {
          const next = queue.pop() as string;
          if (next.startsWith("dummy:")) queue.push(...(successors.get(next) ?? []));
          else reached.add(next);
        }
        const expected = layout.edges.filter((route) => !route.backward && route.edge.from === node.id).map((route) => route.edge.to);
        expect([...reached].sort()).toEqual(expected.sort());
      }
      const back = layout.edges.filter((route) => route.backward);
      expect(back.map((route) => [route.edge.from, route.edge.to])).toEqual([[id("Docs"), id("Root")]]);
      expect(layout.layers.flatMap((layer) => layer.nodes).find((node) => node.id === id("Root"))?.backReferences).toEqual([
        { from: id("Docs"), label: "Docs" },
      ]);
      expect(layout.criticalPath).toEqual(wide.criticalPath);
    }
  });
});
