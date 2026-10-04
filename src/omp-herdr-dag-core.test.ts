import { describe, expect, test } from "bun:test";

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
    version: 1,
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
    expect(run.nodes.find((node) => node.id === "atlas:F1")?.band).toBe(2);
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
