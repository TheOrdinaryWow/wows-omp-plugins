import { describe, expect, test } from "bun:test";

import { taskTotals } from "../plugins/omp-herdr-dag/src/model.ts";
import { type AtlasSnapshot, AtlasSource } from "../plugins/omp-herdr-dag/src/sources/atlas.ts";
import { type RegistryRef, type SourceEvents, TaskSource } from "../plugins/omp-herdr-dag/src/sources/tasks.ts";

function firstCard(source: TaskSource) {
  const card = source.tasks[0];
  if (!card) throw new Error("Expected first task card");
  return card;
}

class Events implements SourceEvents {
  listeners = new Map<string, Set<(data: unknown) => void>>();
  sent: { channel: string; data: unknown }[] = [];
  on(channel: string, listener: (data: unknown) => void) {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
  emit(channel: string, data: unknown) {
    this.sent.push({ channel, data });
    for (const listener of this.listeners.get(channel) ?? []) listener(data);
  }
}

describe("task sources", () => {
  test("binds at spawn and accounts repeated progress per activation, including eval and workpool ids", () => {
    const events = new Events();
    let node = "todo:first";
    let now = 100;
    const source = new TaskSource({ events, inProgressNode: () => node, now: () => now, stalledAfterSeconds: 10 });
    try {
      events.emit("task:subagent:lifecycle", { id: "a", agent: "worker", status: "started", description: "work", sessionFile: "/a" });
      node = "todo:later";
      const progress = {
        id: "a",
        tokens: 100,
        cost: 0.2,
        durationMs: 1000,
        currentTool: "read",
        currentToolArgs: "file",
        recentOutput: ["new", "old"],
        resolvedModel: "provider/model",
        retryState: { attempt: 1, maxAttempts: 3, errorMessage: "retry" },
      };
      events.emit("task:subagent:progress", { agent: "worker", progress });
      events.emit("task:subagent:progress", { agent: "worker", progress });
      expect(source.tasks[0]?.nodeId).toBe("todo:first");
      expect(source.tasks[0]?.model).toBe("provider/model");
      expect(source.tasks[0]?.retry?.maxAttempts).toBe(3);
      expect(source.tasks[0]?.recentOutput).toEqual(["new", "old"]);
      events.emit("task:subagent:lifecycle", { id: "a", status: "completed" });
      expect(taskTotals(firstCard(source)).tokens).toBe(100);
      now = 200;
      events.emit("task:subagent:lifecycle", { id: "a", status: "started", detached: true });
      expect(source.tasks[0]?.current.tokens).toBeUndefined();
      expect(source.tasks[0]?.completed.tokens).toBe(100);
      expect(source.tasks[0]?.nodeId).toBe("todo:later");
      for (let i = 0; i < 2; i++) events.emit("task:subagent:progress", { progress: { id: "a", tokens: 20, cost: 0.1, durationMs: 500 } });
      expect(source.tasks[0]?.retry).toBeUndefined();
      expect(taskTotals(firstCard(source)).tokens).toBe(120);
      events.emit("task:subagent:lifecycle", { id: "a", status: "completed" });
      expect(source.tasks[0]?.activations).toBe(2);
      expect(taskTotals(firstCard(source))).toEqual({ tokens: 120, costUsd: 0.30000000000000004, durationMs: 1500 });
      for (const [id, status] of [
        ["eval", "failed"],
        ["pool", "aborted"],
      ] as const) {
        events.emit("task:subagent:lifecycle", { id, status: "started", index: 0 });
        events.emit("task:subagent:progress", { index: 0, progress: { id, tokens: 5 } });
        events.emit("task:subagent:lifecycle", { id, status });
        expect(source.tasks.find((card) => card.id === id)?.completed.tokens).toBe(5);
        expect(source.tasks.find((card) => card.id === id)?.status).toBe(status);
      }
      events.emit("task:subagent:lifecycle", { id: "live", status: "started" });
      events.emit("task:subagent:event", {
        id: "live",
        event: { type: "tool_execution_start", toolName: "bash", args: { command: "pwd" } },
      });
      expect(source.tasks.find((card) => card.id === "live")?.currentTool).toBe("bash");
      now += 10001;
      expect(source.stalledTaskIds.has("live")).toBe(true);
      events.emit("task:subagent:event", { id: "live", event: { type: "tool_execution_end" } });
      expect(source.stalledTaskIds.has("live")).toBe(false);
    } finally {
      source.dispose();
    }
  });

  test("samples scoped depth-two registry activity every two seconds and handles removals", () => {
    const events = new Events();
    const refs: RegistryRef[] = [
      {
        id: "grand",
        parentId: "parent",
        kind: "subagent",
        displayName: "nested",
        status: "running",
        sessionFile: "/grand",
        createdAt: 1,
        lastActivity: 2,
      },
      { id: "foreign", parentId: "other", kind: "subagent", displayName: "foreign", status: "running", createdAt: 1, lastActivity: 2 },
    ];
    let changed: ((event: { type: string; ref: RegistryRef }) => void) | undefined;
    let tick: (() => void) | undefined;
    const source = new TaskSource({
      events,
      scheduleInterval: (callback, milliseconds) => {
        expect(milliseconds).toBe(2000);
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
      inProgressNode: () => undefined,
      registry: {
        list: () => refs,
        onChange: (listener) => {
          changed = listener;
          return () => {
            changed = undefined;
          };
        },
      },
    });
    try {
      events.emit("task:subagent:lifecycle", { id: "parent", status: "started" });
      expect(source.tasks.find((card) => card.id === "grand")?.depth).toBe(2);
      expect(source.tasks.find((card) => card.id === "grand")?.activityAvailable).toBe(false);
      expect(source.tasks.some((card) => card.id === "foreign")).toBe(false);
      const grandchild = refs[0];
      if (!grandchild) throw new Error("Expected grandchild reference");
      grandchild.status = "failed";
      tick?.();
      expect(source.tasks.find((card) => card.id === "grand")?.status).toBe("failed");
      const removed = refs.shift();
      if (!removed) throw new Error("Expected removed reference");
      changed?.({ type: "removed", ref: removed });
      expect(source.tasks.some((card) => card.id === "grand")).toBe(false);
    } finally {
      source.dispose();
    }
  });
});

const snapshot: AtlasSnapshot = {
  v: 1,
  sessionId: "session",
  plan: { id: "p", name: "Plan", planFilePath: "/plan", cwd: "/" },
  status: "running",
  done: 0,
  total: 1,
  rows: [{ id: "T1", title: "First", status: "in_progress", kind: "task", agent: "worker", dependsOn: [], updatedAt: 10 }],
  live: {},
  timeline: [],
  at: 10,
};

test("Atlas activation, synchronous correlation, filtering, snapshots, hello clear and release", () => {
  const events = new Events();
  events.on("herdr-dag:hello", (payload) => {
    const hello = payload as { requestId: string };
    events.emit("atlas:hello", { v: 1, sessionId: "session", requestId: hello.requestId, plan: snapshot.plan });
    events.emit("atlas:snapshot", snapshot);
  });
  const source = new AtlasSource({ events, sessionId: "session", generation: 4 });
  try {
    expect(events.sent[0]?.channel).toBe("herdr-dag:hello");
    expect(source.state.available).toBe(true);
    expect(source.run?.generation).toBe(4);
    expect(source.run?.nodes[0]?.state).toBe("running");
    events.emit("atlas:hello", { v: 1, sessionId: "session", requestId: "wrong" });
    expect(source.state.bound).toBe(true);
    for (const frame of [
      { ...snapshot, v: 2 },
      { ...snapshot, sessionId: "foreign" },
    ])
      events.emit("atlas:snapshot", frame);
    expect(source.run?.id).toBe("atlas:p");
    events.emit("atlas:snapshot", { ...snapshot, at: 20, rows: [{ ...snapshot.rows[0], status: "done", updatedAt: 20 }] });
    expect(source.run?.nodes[0]?.state).toBe("done");
    events.emit("atlas:released", { v: 1, sessionId: "foreign", planId: "p", reason: "exit" });
    expect(source.state.bound).toBe(true);
    events.emit("atlas:hello", { v: 1, sessionId: "session" });
    expect(source.run).toBeUndefined();
    events.emit("atlas:snapshot", snapshot);
    events.emit("atlas:released", { v: 1, sessionId: "session", planId: "p", reason: "exit" });
    expect(source.state).toEqual({ available: true, bound: false });
    source.activate();
    expect(source.run?.id).toBe("atlas:p");
  } finally {
    source.dispose();
  }
});
