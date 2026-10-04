import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@oh-my-pi/omptype/typebox";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

import type { TodoPhase } from "../plugins/omp-herdr-dag/src/model.ts";
import {
  isApprovedPlanHandoff,
  PLAN_EXECUTION_ENTRY,
  type PlanExecutionState,
  PlanExecutionTracker,
} from "../plugins/omp-herdr-dag/src/sources/plan-execution.ts";
import { TODO_EDGES_ENTRY, type TodoEdgesEntry, TodoSource, todoGeneration } from "../plugins/omp-herdr-dag/src/sources/todo.ts";
import { registerTodoWrapper } from "../plugins/omp-herdr-dag/src/sources/todo-wrapper.ts";

const CHILD_ENV = "HERDR_DAG_TODO_HOST_CHECK";
const THIS_FILE = fileURLToPath(import.meta.url);
const phases: TodoPhase[] = [
  {
    name: "Build",
    tasks: [
      { content: "A", status: "in_progress" },
      { content: "B", status: "pending" },
    ],
  },
];
const handoff =
  'Plan approved.\n\n<plan path="local://approved.md">\n# Plan\n</plan>\nFull plan inlined below; durable copy at `local://approved.md`';
const resultEvent = (op = "init", list = phases) => ({
  toolName: "todo",
  isError: false,
  details: { op, phases: list, storage: "session" },
});
const messageEntry = (id: string, op = "init", list = phases): SessionEntry =>
  ({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(1_000).toISOString(),
    message: { role: "toolResult", ...resultEvent(op, list) },
  }) as SessionEntry;
const customEntry = (customType: string, data: unknown): SessionEntry =>
  ({ type: "custom", id: "custom", parentId: null, timestamp: new Date(1_000).toISOString(), customType, data }) as SessionEntry;

async function hostCheck(root: string): Promise<void> {
  // Import the SDK only after this process has its own HOME, cwd and host-state directory.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { getLatestTodoPhasesFromEntries } = await import("@oh-my-pi/pi-coding-agent/tools/todo");
  const { toolRenderers } = await import("@oh-my-pi/pi-tui/tools");
  const tui = await import("@oh-my-pi/pi-tui");
  await tui.initTheme();
  const edges: TodoEdgesEntry[] = [];
  const observed: Array<{ toolName: string; details?: unknown }> = [];
  const manager = SessionManager.create(root, join(root, "sessions"));
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false }),
    toolNames: ["todo"],
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    cacheWarming: false,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    extensions: [
      (pi) =>
        registerTodoWrapper(pi, {
          enabled: true,
          onEdges(data) {
            edges.push(data);
            pi.appendEntry(TODO_EDGES_ENTRY, data);
          },
        }),
      (pi) =>
        pi.on("tool_result", (event) => {
          observed.push({ toolName: event.toolName, details: event.details });
        }),
    ],
  });
  try {
    await initializeExtensions(session, {
      reportSendError: (_action, error) => {
        throw error;
      },
      reportRuntimeError: (error) => {
        throw new Error(error.error);
      },
    });
    assert.equal(extensionsResult.errors.length, 0);
    const tool = session.getToolByName("todo");
    assert(tool);
    const properties = tool as typeof tool & {
      concurrency?: string;
      lenientArgValidation?: boolean;
      renderResult?: ToolDefinition["renderResult"];
    };
    assert.equal(tool.approval, "read");
    assert.equal(properties.concurrency, "exclusive");
    assert.equal(properties.lenientArgValidation, true);
    assert.equal(tool.strict, true);
    assert.equal(tool.loadMode, "discoverable");
    const call = async (id: string, input: Record<string, unknown>) => {
      const result = await tool.execute(id, input);
      // Direct registry calls bypass the agent loop's message_end persistence. Commit exactly
      // the native toolResult entry the loop writes, through the real SessionManager API.
      manager.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: "todo",
        ...result,
        isError: result.isError === true,
        timestamp: Date.now(),
      });
      return result;
    };
    const input = { op: "init", list: [{ phase: "Build", items: ["A", "B"] }], edges: [{ task: "B", after: ["A"] }] };
    const initialized = await call("init", input);
    assert(!initialized.isError);
    assert.deepEqual(initialized.details.phases, phases);
    assert.equal(observed.at(-1)?.toolName, "todo");
    assert.equal(observed.at(-1)?.details, initialized.details);
    assert.deepEqual(getLatestTodoPhasesFromEntries(manager.getBranch()), phases);
    assert.deepEqual(edges.at(-1), { v: 1, generation: 1, edges: [{ task: "B", after: ["A"] }] });
    assert(properties.renderResult);
    const options = { expanded: true, isPartial: false };
    const actualRender = properties.renderResult(initialized, options, tui.theme, input).render(100);
    const nativeRender = toolRenderers.todo?.renderResult?.(initialized, options, tui.theme, input)?.render(100);
    assert.deepEqual(actualRender, nativeRender);
    assert(actualRender.join("\n").includes("A"));
    const repaired = await call("omitted", { list: [{ phase: "Next", items: ["C", "D"] }], edges: [{ task: "D", after: ["C"] }] });
    assert(!repaired.isError);
    assert.equal(repaired.details.op, "init");
    assert.equal(edges.at(-1)?.generation, 2);
    const before = getLatestTodoPhasesFromEntries(manager.getBranch());
    const count = edges.length;
    const invalid = await call("atomic", { op: "append", phase: "Next", items: ["E", "C"], edges: [{ task: "E", after: ["D"] }] });
    assert(invalid.isError);
    assert.equal(edges.length, count);
    assert.deepEqual(getLatestTodoPhasesFromEntries(manager.getBranch()), before);
    assert.deepEqual(invalid.details.phases, before);
    const malformed = await call("malformed-edges", { op: "start", task: "D", edges: [{ task: "D", after: ["missing"] }, null] });
    assert(!malformed.isError);
    assert(malformed.content.some((item) => item.type === "text" && item.text.includes("Herdr DAG edges:")));
    assert.equal(malformed.details.phases[0]?.tasks[1]?.status, "in_progress");
    console.log("HERDR_DAG_TODO_HOST_OK");
  } finally {
    await session.dispose();
  }
}

// The same file is an executable child; bun:test may only be imported by its test-runner parent.
if (process.env[CHILD_ENV]) {
  await hostCheck(process.env.HERDR_DAG_TODO_ROOT as string);
} else {
  const { describe, expect, test } = await import("bun:test");
  describe("native todo source", () => {
    test("tool results and canonical branch writers reconstruct the same run", () => {
      const live = new TodoSource({ sessionId: "session", now: () => 1_000 });
      expect(live.observeResult(resultEvent())).toBe(true);
      const branch = new TodoSource({ sessionId: "session", now: () => 1_000 });
      branch.replay([messageEntry("init")]);
      expect(branch.current).toEqual(live.current);
      const editor = new TodoSource({ sessionId: "session", now: () => 1_000 });
      editor.replay([customEntry("user_todo_edit", { phases })]);
      expect(editor.current).toEqual(live.current);
      const original = live.current;
      expect(live.observeResult(resultEvent("view"))).toBe(false);
      expect(live.observeResult({ ...resultEvent(), isError: true })).toBe(false);
      expect(live.observeResult({ ...resultEvent(), toolName: "task" })).toBe(false);
      expect(live.observeResult({ toolName: "todo", details: { phases: "bad" } })).toBe(false);
      expect(live.current).toBe(original);
    });

    test("poll reads only a changed leaf and does not double-count init", () => {
      const source = new TodoSource({ sessionId: "session", now: () => 1_000 });
      let leaf = "initial";
      let reads = 0;
      let entries = [messageEntry("init")];
      const manager = {
        getLeafId: () => leaf,
        getBranch: () => {
          reads++;
          return entries;
        },
      };
      source.observeResult(resultEvent());
      expect(source.poll(manager)).toBe(true);
      expect(source.generation).toBe(1);
      expect(source.poll(manager)).toBe(false);
      expect(reads).toBe(1);
      leaf = "edit";
      entries = [
        ...entries,
        customEntry("user_todo_edit", { phases: [{ name: "Edited", tasks: [{ content: "New", status: "blocked" }] }] }),
      ];
      expect(source.poll(manager)).toBe(true);
      expect(source.current?.nodes.map((node) => [node.label, node.state])).toEqual([["New", "blocked"]]);
      expect(reads).toBe(2);
    });

    test("Atlas mirrors are hidden only while bound, including an all-mirror list", () => {
      const source = new TodoSource({ sessionId: "session", now: () => 1_000 });
      const mirrored = ["Atlas tasks", "Atlas fixes", "Atlas final gates"].map(
        (name): TodoPhase => ({ name, tasks: [{ content: name, status: "pending" }] }),
      );
      source.observeResult(
        resultEvent("init", [...phases, ...mirrored, { name: "Atlas tasks extra", tasks: [{ content: "Keep", status: "pending" }] }]),
      );
      source.setAtlasBound(true);
      expect(source.current?.nodes.map((node) => node.label)).toEqual(["A", "B", "Keep"]);
      source.setAtlasBound(false);
      expect(source.current?.nodes).toHaveLength(6);
      source.observeResult(resultEvent("init", mirrored));
      source.setAtlasBound(true);
      expect(source.current).toBeUndefined();
      source.setAtlasBound(false);
      expect(source.current?.source).toBe("todo");
      expect(source.current?.nodes).toHaveLength(3);
    });

    test("generation-scoped edges survive replay and are pruned by removals", () => {
      const source = new TodoSource({ sessionId: "session", now: () => 1_000 });
      const edges: TodoEdgesEntry = { v: 1, generation: 1, edges: [{ task: "B", after: ["A"] }] };
      source.setEdges(edges);
      source.observeResult(resultEvent());
      expect(source.current?.edges).toHaveLength(1);
      const replay = new TodoSource({ sessionId: "session", now: () => 1_000 });
      replay.replay([customEntry(TODO_EDGES_ENTRY, edges), messageEntry("init")]);
      expect(replay.current).toEqual(source.current);
      source.observeResult(resultEvent("rm", [{ name: "Build", tasks: [{ content: "A", status: "in_progress" }] }]));
      expect(source.current?.edges).toEqual([]);
      source.observeResult(resultEvent());
      expect(source.generation).toBe(2);
      expect(source.current?.edges).toEqual([]);
      expect(source.runs).toHaveLength(2);
      expect(source.runs[0]?.finishedAt).toBe(1_000);
      expect(todoGeneration([messageEntry("one"), messageEntry("two", "start")])).toBe(1);
    });
  });

  describe("plan execution epoch", () => {
    test("requires proposal, matching host reference and the complete approval envelope", () => {
      const tracker = new PlanExecutionTracker({ now: () => 1_000 });
      expect(tracker.beforeAgentStart(handoff, "local://approved.md")).toBe(false);
      expect(
        tracker.observeResult({
          toolName: "write",
          details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: "local:/approved.md", planExists: true } } },
        }),
      ).toBe(true);
      expect(tracker.state.state).toBe("proposed");
      expect(tracker.beforeAgentStart("Plan approved.\nuser text", "local://approved.md")).toBe(false);
      expect(tracker.beforeAgentStart(handoff, "local://other.md")).toBe(false);
      expect(isApprovedPlanHandoff(handoff.replace("</plan>", ""), "local://approved.md", "local://approved.md")).toBe(false);
      expect(isApprovedPlanHandoff(handoff.replace("Full plan inlined below", "Other"), "local://approved.md", "local://approved.md")).toBe(
        false,
      );
      tracker.replay([customEntry(PLAN_EXECUTION_ENTRY, tracker.state)]);
      expect(tracker.state.state).toBe("proposed"); // A bare switch/new only replays; it is not approval.
      expect(tracker.beforeAgentStart(handoff, "local:/approved.md")).toBe(true);
      expect(tracker.state.state).toBe("executing");
    });

    test("only the first nonempty new list is purple and completion waits for the final turn", () => {
      const entries: SessionEntry[] = [];
      const tracker = new PlanExecutionTracker({
        now: () => 1_000,
        persist: (data) => {
          entries.push(customEntry(PLAN_EXECUTION_ENTRY, data));
        },
      });
      const source = new TodoSource({ sessionId: "session", plan: tracker, now: () => 1_000 });
      source.observeResult(resultEvent());
      tracker.observeResult({
        toolName: "write",
        details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: "local://approved.md", planExists: true } } },
      });
      tracker.beforeAgentStart(handoff, "local://approved.md");
      expect(tracker.claimRun("empty", [])).toBe("todo");
      source.observeResult(resultEvent("start"));
      expect(source.current?.source).toBe("todo");
      source.observeResult(resultEvent());
      expect(source.current?.source).toBe("plan");
      expect(tracker.state.runId).toBe("todo:session:2");
      expect(tracker.agentEnd(source.current)).toBe(false);
      source.observeResult(
        resultEvent("done", [
          {
            name: "Build",
            tasks: [
              { content: "A", status: "completed" },
              { content: "B", status: "abandoned" },
            ],
          },
        ]),
      );
      expect(tracker.agentEnd(source.current, true)).toBe(false);
      expect(tracker.state.state).toBe("executing");
      expect(tracker.agentEnd(source.current)).toBe(true);
      expect(tracker.state.state).toBe("idle");
      source.observeResult(resultEvent());
      expect(source.current?.source).toBe("todo");
      const resumed = new PlanExecutionTracker({ now: () => 1_000 });
      resumed.replay(entries);
      expect(resumed.state.state).toBe("idle");
      expect(resumed.sourceForRun("todo:session:2")).toBe("plan");
      const executing = entries.findLastIndex((entry) => entry.type === "custom" && (entry.data as PlanExecutionState).runId !== undefined);
      resumed.replay(entries.slice(0, executing + 1));
      expect(resumed.state.runId).toBe("todo:session:2");
      resumed.replay([customEntry(PLAN_EXECUTION_ENTRY, { v: 2, state: "executing", at: 1 })]);
      expect(resumed.state.state).toBe("idle");
    });

    test("approval clear and compact retain only a proposal until the verified handoff", () => {
      const tracker = new PlanExecutionTracker({ now: () => 1_000 });
      tracker.observeResult({
        toolName: "write",
        details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: "local://approved.md", planExists: true } } },
      });
      const source = new TodoSource({ sessionId: "new-session", plan: tracker, now: () => 1_000 });
      source.replay([], "cleared", true);
      expect(tracker.state.state).toBe("proposed");
      expect(source.current).toBeUndefined();
      expect(tracker.beforeAgentStart("Plan approved.\nordinary text", "local://approved.md")).toBe(false);
      expect(tracker.beforeAgentStart(handoff, "local://approved.md")).toBe(true);
      source.observeResult(resultEvent());
      expect(source.current?.source).toBe("plan");
      tracker.replay([], true);
      expect(tracker.state.state).toBe("idle");
    });

    test("branch and session replay retain source attribution without writing entries", () => {
      let writes = 0;
      const tracker = new PlanExecutionTracker({
        now: () => 1_000,
        persist: () => {
          writes++;
        },
      });
      const source = new TodoSource({ sessionId: "session", plan: tracker, now: () => 1_000 });
      const entries = [
        customEntry(PLAN_EXECUTION_ENTRY, {
          v: 1,
          state: "executing",
          planFilePath: "local://approved.md",
          runId: "todo:session:1",
          at: 1_000,
        }),
        messageEntry("init"),
      ];
      source.replay(entries);
      expect(source.current?.source).toBe("plan");
      source.replay(entries);
      expect(source.current?.id).toBe("todo:session:1");
      expect(writes).toBe(0);
      source.replay([]);
      expect(source.current).toBeUndefined();
      expect(tracker.state.state).toBe("idle");
    });
  });

  describe("native todo wrapper", () => {
    function harness(enabled: boolean | ((ctx: ExtensionContext) => boolean) = true) {
      let definition: ToolDefinition | undefined;
      const entries: SessionEntry[] = [];
      const records: TodoEdgesEntry[] = [];
      const forwarded: Record<string, unknown>[] = [];
      const warnings: string[] = [];
      let native = {
        content: [{ type: "text" as const, text: "Native text" }],
        details: { op: "init", phases, storage: "session" },
        isError: false,
      };
      const pi = {
        typebox: { Type },
        logger: {
          warn: (text: string) => {
            warnings.push(text);
          },
        },
        registerTool: (tool: ToolDefinition) => {
          definition = tool;
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        sessionManager: { getBranch: () => entries },
        invokeTool: async (args: Record<string, unknown>) => {
          forwarded.push(args);
          return native;
        },
      } as unknown as ExtensionContext;
      registerTodoWrapper(pi, {
        enabled,
        onEdges: (data) => {
          records.push(data);
          entries.push(customEntry(TODO_EDGES_ENTRY, data));
        },
      });
      return {
        get definition() {
          return definition;
        },
        entries,
        records,
        forwarded,
        warnings,
        ctx,
        get native() {
          return native;
        },
        set native(value) {
          native = value;
        },
      };
    }

    test("strips only edges and retains native text, details and tool metadata", async () => {
      const h = harness();
      const args = { op: "init", list: [{ phase: "Build", items: ["A", "B"] }], reason: "verbatim", edges: [{ task: "B", after: ["A"] }] };
      const result = await h.definition?.execute("call", args, undefined, undefined, h.ctx);
      expect(h.forwarded).toEqual([{ op: "init", list: args.list, reason: "verbatim" }]);
      expect(result).toBe(h.native);
      expect(result?.details).toBe(h.native.details);
      expect(h.records).toEqual([{ v: 1, generation: 1, edges: args.edges }]);
      expect(h.definition?.approval).toBe("read");
      expect(h.definition?.strict).toBe(true);
      expect(h.definition?.loadMode).toBe("discoverable");
      expect(h.definition?.renderCall).toBeFunction();
      expect(h.definition?.renderResult).toBeFunction();
    });

    test("drops malformed, unknown and cyclic edges with one warning line after native text", async () => {
      const h = harness();
      const result = await h.definition?.execute(
        "call",
        { op: "init", edges: [{ task: "B", after: ["A"] }, { task: "A", after: ["B"] }, { task: "Missing", after: ["A"] }, null] },
        undefined,
        undefined,
        h.ctx,
      );
      expect(result?.isError).toBe(false);
      expect(result?.details).toBe(h.native.details);
      expect(h.records[0]?.edges).toEqual([{ task: "B", after: ["A"] }]);
      expect(result?.content[0]).toEqual({
        type: "text",
        text: "Native text\nHerdr DAG edges: Cyclic dependency B → A was dropped. Unknown or malformed dependency was dropped. Malformed edge was dropped.",
      });
      expect(h.native.content[0]?.text).toBe("Native text");
    });

    test("keeps generations isolated, preserves edges across changes and records nothing for error/view", async () => {
      const h = harness();
      await h.definition?.execute("init", { op: "init", edges: [{ task: "B", after: ["A"] }] }, undefined, undefined, h.ctx);
      h.entries.push(messageEntry("init"));
      h.native = { ...h.native, details: { ...h.native.details, op: "start" } };
      await h.definition?.execute("start", { op: "start", task: "B" }, undefined, undefined, h.ctx);
      expect(h.records.at(-1)).toEqual({ v: 1, generation: 1, edges: [{ task: "B", after: ["A"] }] });
      h.native = { ...h.native, isError: true };
      await h.definition?.execute("bad", { op: "append", edges: [] }, undefined, undefined, h.ctx);
      expect(h.records).toHaveLength(2);
      h.native = { ...h.native, isError: false, details: { ...h.native.details, op: "view" } };
      await h.definition?.execute("view", { op: "view", edges: [] }, undefined, undefined, h.ctx);
      expect(h.records).toHaveLength(2);
      h.native = { ...h.native, details: { ...h.native.details, op: "init" } };
      await h.definition?.execute("init-again", { op: "init" }, undefined, undefined, h.ctx);
      expect(h.records.at(-1)).toEqual({ v: 1, generation: 2, edges: [] });
    });

    test("disabled registration and dynamic disabling leave native behavior unchanged", async () => {
      expect(harness(false).definition).toBeUndefined();
      const h = harness(() => false);
      expect(await h.definition?.execute("disabled", { op: "init", edges: "malformed" }, undefined, undefined, h.ctx)).toBe(h.native);
      expect(h.records).toEqual([]);
    });

    test("missing invokeTool returns a versioned error and logs once", async () => {
      const h = harness();
      const ctx = { sessionManager: h.ctx.sessionManager } as ExtensionContext;
      const result = await h.definition?.execute("missing", { op: "init" }, undefined, undefined, ctx);
      expect(result?.isError).toBe(true);
      expect(result?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("OMP 18.3.1 or newer") });
      await h.definition?.execute("missing-again", { op: "init" }, undefined, undefined, ctx);
      expect(h.warnings).toHaveLength(1);
      expect(h.forwarded).toEqual([]);
    });
  });

  test("real SDK registry delegates to native todo, preserves hooks/rendering and atomic failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-dag-todo-"));
    try {
      await mkdir(join(root, "cwd"));
      const cwd = join(root, "cwd");
      const child = Bun.spawn([process.execPath, THIS_FILE], {
        cwd,
        env: { ...process.env, [CHILD_ENV]: "1", HERDR_DAG_TODO_ROOT: cwd, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("HERDR_DAG_TODO_HOST_OK");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
}
