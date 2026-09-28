import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { ExecutionLedger, LedgerItem } from "../plugins/omo-prometheus/src/ledger.ts";

const CHILD_ENV = "PROMETHEUS_EXECUTION_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
const plan = `# Execution integrity

## Tasks
- [ ] T1. Implement the prerequisite
  - Agent: task
  - Depends on: none
  - Acceptance: prerequisite behavior is observed
- [ ] T2. Exercise the dependent behavior
  - Agent: task
  - Depends on: T1
  - Acceptance: dependent behavior is observed
- [ ] T3. Update independent behavior
  - Agent: task
  - Depends on: none
  - Acceptance: independent behavior is observed

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

interface Result {
  isError?: boolean;
  content: { type: string; text?: string }[];
  details?: { outputSchema?: Record<string, unknown>; ledger?: ExecutionLedger };
}
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
interface RegisteredTool {
  name: string;
  execute(id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<Result>;
}

interface PreparedAssignment {
  item: LedgerItem;
  current: ExecutionLedger;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** Real extension entry and native registry/event bus; model execution is a controlled terminal-result boundary. */
async function scenario(name: string, root: string): Promise<void> {
  // Host modules intentionally load only in the child process, after HOME and host state are isolated.
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const { EventBus } = await import("@oh-my-pi/pi-coding-agent/utils/event-bus");
  const { TASK_SUBAGENT_LIFECYCLE_CHANNEL } = await import("@oh-my-pi/pi-coding-agent/task/types");
  const { z } = await import("zod");
  const { default: register } = await import("../plugins/omo-prometheus/src/index.ts");
  const artifacts = join(root, "artifacts");
  await mkdir(join(artifacts, "local", "prometheus"), { recursive: true });
  const planFile = join(artifacts, "local", "integrity-plan.md");
  const ledgerFile = join(artifacts, "local", "prometheus", "integrity-ledger.json");
  const entries: unknown[] = [{ type: "mode_change", id: "plan-mode", mode: "plan" }];
  let hooks = new Map<string, Hook>();
  let tools = new Map<string, RegisteredTool>();
  let bus = new EventBus();
  let mode = true;
  let reference: string | undefined;
  let sequence = 0;
  let confirmations = 0;
  const nativeJobs: Array<{ id: string; agentId: string; type: "task"; status: string; startTime: number; label: string }> = [];
  const sessionManager = {
    getSessionId: () => "integrity-session",
    getArtifactsDir: () => artifacts,
    getBranch: () => entries,
  };
  const live = {
    sessionManager,
    getPlanModeState: () => ({ enabled: mode }),
    getPlanReferencePath: () => reference,
    getAsyncJobSnapshot: () => ({
      running: nativeJobs.filter((job) => job.status === "running"),
      recent: nativeJobs.filter((job) => job.status !== "running"),
      delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    }),
  } as unknown as AgentSession;
  const ctx = {
    cwd: root,
    hasUI: true,
    sessionManager,
    getSystemPrompt: () => [],
    ui: {
      notify() {},
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    },
  } as unknown as ExtensionContext;
  let command: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
  const install = () => {
    hooks = new Map();
    tools = new Map();
    bus = new EventBus();
    const api = {
      zod: z,
      events: bus,
      logger: { warn() {} },
      registerCommand: (_name: string, spec: { handler: typeof command }) => {
        command = spec.handler;
      },
      registerTool: (tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      },
      on: (event: string, handler: Hook) => {
        hooks.set(event, handler);
      },
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
      },
      getActiveTools: () => ["task", "read", "write", "prometheus_ledger", "prometheus_release"],
      setActiveTools: async () => {},
      getAllTools: () => [
        { name: "task", description: "# Available Agents\n### task\nworker\n### reviewer\nreview", sourceInfo: { source: "builtin" } },
        { name: "write", sourceInfo: { source: "builtin" } },
        ...[...tools.values()].map((tool) => ({
          name: tool.name,
          sourceInfo: { source: "extension", path: fileURLToPath(new URL("../plugins/omo-prometheus/src/index.ts", import.meta.url)) },
        })),
      ],
      sendMessage() {},
      sendUserMessage() {},
    } as unknown as ExtensionAPI;
    register(api);
  };
  const main = () => AgentRegistry.global().register({ id: "Main", kind: "main", displayName: "Main", session: live });
  AgentRegistry.resetGlobalForTests();
  main();
  install();
  const hook = async (event: string, data: Record<string, unknown> = {}) => {
    const handler = hooks.get(event);
    assert(handler, `Missing ${event} hook`);
    return handler({ type: event, ...data }, ctx);
  };
  const call = async (params: Record<string, unknown>, toolName = "prometheus_ledger") => {
    const tool = tools.get(toolName);
    assert(tool, `Missing ${toolName}`);
    return tool.execute(`ledger-${sequence++}`, params, undefined, undefined, ctx);
  };
  const ok = (result: Result) => {
    assert.notEqual(result.isError, true, JSON.stringify(result));
  };
  const refused = (result: Result) => {
    assert.equal(result.isError, true, JSON.stringify(result));
  };
  const ledger = async (): Promise<ExecutionLedger> => JSON.parse(await readFile(ledgerFile, "utf8"));
  const row = async (id: string): Promise<LedgerItem> => {
    const current = await ledger();
    const item = [...current.items, ...current.gates].find((item) => item.id === id);
    assert(item);
    return item;
  };
  await writeFile(planFile, name === "cycle" ? plan.replace("Depends on: none", "Depends on: T2") : plan);
  assert(command);
  await command("", ctx);
  mode = false;
  reference = "local://integrity-plan.md";
  await hook("tool_result", {
    toolName: "write",
    toolCallId: "proposal",
    isError: false,
    details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: reference, planExists: true } } },
    content: [{ type: "text", text: "Plan approved at local://integrity-plan.md" }],
  });

  const prepare = async (id: string): Promise<PreparedAssignment> => {
    const result = await call({ action: "start", id });
    ok(result);
    const item = await row(id);
    const current = await ledger();
    const toolCallId = `dispatch-${sequence++}`;
    const input = {
      agent: item.dispatchAgent,
      task: `review_kind: compliance\nprometheus_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { [id]: item.attempt } })}\nPerform ${item.title}; acceptance: ${item.acceptance}`,
      solutionSpace: "Known scoped assignment",
      ...(result.details?.outputSchema ? { outputSchema: result.details.outputSchema, schemaMode: "strict" } : {}),
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    return { item, current, toolCallId, input };
  };
  const publish = async (
    prepared: PreparedAssignment,
    childAgentId: string,
    options: {
      parentId?: string;
      status?: "running" | "idle";
      content?: string;
      observe?: boolean;
      createdAt?: number;
      nativeStatus?: string;
      finalResult?: boolean;
      finalError?: string;
      asyncStatus?: string;
    } = {},
  ) => {
    const reviewed =
      prepared.item.id === "F4"
        ? Object.fromEntries(prepared.current.gates.slice(0, 3).map((item) => [item.id, item.receipt?.outputSha256]))
        : {};
    const content =
      options.content ??
      (prepared.item.id.startsWith("F")
        ? JSON.stringify({
            gateId: prepared.item.id,
            planSha256: prepared.current.planSha256,
            attempt: prepared.item.attempt,
            verdict: "PASS",
            summary: "The named criteria were exercised",
            evidence: ["actual command and observed result"],
            reviewedGates: reviewed,
          })
        : "Implemented assigned behavior; command observed the expected result.");
    await writeFile(join(artifacts, `${childAgentId}.md`), content);
    const sessionFile = join(artifacts, `${childAgentId}.jsonl`);
    AgentRegistry.global().register({
      id: childAgentId,
      kind: "sub",
      displayName: childAgentId,
      parentId: options.parentId ?? "Main",
      session: null,
      sessionFile,
      status: options.status ?? "idle",
      createdAt: options.createdAt ?? (prepared.item.startedAt ?? 0) + 1,
      history: { outputPath: join(artifacts, `${childAgentId}.md`) },
    });
    if (options.observe !== false)
      bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
        id: childAgentId,
        agent: prepared.item.dispatchAgent,
        index: 0,
        status: options.nativeStatus ?? "completed",
        sessionFile,
        parentToolCallId: prepared.toolCallId,
      });
    if (options.asyncStatus !== undefined) {
      nativeJobs.push({
        id: `job-${childAgentId}`,
        agentId: childAgentId,
        type: "task",
        status: options.asyncStatus,
        startTime: Date.now(),
        label: childAgentId,
      });
    } else if (options.finalResult !== false) {
      await hook("tool_result", {
        toolName: "task",
        toolCallId: prepared.toolCallId,
        input: prepared.input,
        isError: false,
        details: { results: [{ id: childAgentId, index: 0, exitCode: 0, aborted: false, error: options.finalError }] },
        content: [{ type: "text", text: options.finalError ?? "Native task finished" }],
      });
    }
  };
  const done = (id: string, childAgentId: string) =>
    call({ action: "done", id, childAgentId, evidence: "Inspected behavior and child output" });
  const finish = async (id: string) => {
    const prepared = await prepare(id);
    const child = `Child${sequence++}`;
    await publish(prepared, child);
    ok(await done(id, child));
    return child;
  };
  const tasksDone = async () => {
    await finish("T1");
    await finish("T2");
    await finish("T3");
  };
  const gatesDone = async () => {
    await finish("F1");
    await finish("F2");
    await finish("F3");
    await finish("F4");
  };

  if (name === "cycle") {
    refused(await call({ action: "status" }));
    assert.notEqual(await hook("tool_call", { toolName: "task", toolCallId: "bad", input: { task: "implement" } }), undefined);
    assert.equal(await hook("session_stop"), undefined);
    return;
  }
  if (name === "fresh-handoff") {
    entries.length = 0;
    install();
    await hook("before_agent_start", {
      prompt: `Plan approved.\nFull plan inlined below; durable copy at \`${reference}\`\n<plan path="${reference}">\n${plan}\n</plan>`,
      systemPrompt: [],
    });
    ok(await call({ action: "status" }));
    await finish("T1");
    return;
  }
  if (name === "resume-missing-ledger") {
    await rm(ledgerFile);
    install();
    await hook("session_start");
    await hook("before_agent_start", { prompt: "Continue", systemPrompt: [] });
    refused(await call({ action: "status" }));
    await assert.rejects(readFile(ledgerFile), { code: "ENOENT" });
    assert.equal(await hook("session_stop"), undefined);
    return;
  }
  if (name === "concurrent") {
    const [first, independent] = await Promise.all([prepare("T1"), prepare("T3")]);
    await Promise.all([publish(first, "First"), publish(independent, "Independent")]);
    const results = await Promise.all([done("T1", "First"), done("T3", "Independent")]);
    results.forEach(ok);
    assert.equal((await row("T1")).status, "done");
    assert.equal((await row("T3")).status, "done");
    assert.equal((await row("T2")).status, "open");
    return;
  }
  if (name === "multi-row") {
    ok(await call({ action: "start", id: "T1" }));
    ok(await call({ action: "start", id: "T3" }));
    const current = await ledger();
    const first = await row("T1");
    const third = await row("T3");
    const toolCallId = "multi-row-dispatch";
    const input = {
      agent: "task",
      task: `prometheus_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { T1: first.attempt, T3: third.attempt } })}\nImplement both independent criteria.`,
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    await publish({ item: first, current, toolCallId, input }, "Combined", {
      createdAt: Math.max(first.startedAt ?? 0, third.startedAt ?? 0) + 1,
    });
    ok(await done("T1", "Combined"));
    ok(await done("T3", "Combined"));
    const second = await prepare("T2");
    refused(await done("T2", "Combined"));
    await publish(second, "Second");
    ok(await done("T2", "Second"));
    return;
  }
  if (name === "invalid-ledger") {
    for (const mutation of ["changed-plan", "corrupt", "missing"]) {
      const original = await readFile(ledgerFile, "utf8");
      if (mutation === "changed-plan") await writeFile(planFile, `${plan}\nChanged acceptance`);
      if (mutation === "corrupt") await writeFile(ledgerFile, "{broken");
      if (mutation === "missing") await rm(ledgerFile);
      refused(await call({ action: "status" }));
      refused(await call({ reason: "claim complete" }, "prometheus_release"));
      assert.notEqual(await hook("tool_call", { toolName: "task", toolCallId: "blocked", input: { task: "implement" } }), undefined);
      assert.equal(await hook("session_stop"), undefined);
      assert.equal(confirmations, 0);
      await writeFile(planFile, plan);
      await writeFile(ledgerFile, original);
    }
    await hook("input", { text: "/prometheus", source: "user" });
    assert.equal(
      await hook("tool_call", { toolName: "task", toolCallId: "outside", input: { agent: "task", task: "ordinary work" } }),
      undefined,
    );
    return;
  }
  if (name === "ordering") {
    refused(await call({ action: "start", id: "T2" }));
    refused(await call({ action: "done", id: "T1", childAgentId: "Bogus", evidence: "agent://Bogus PASS" }));
    refused(await call({ action: "start", id: "F1" }));
    await tasksDone();
    refused(await call({ action: "start", id: "F4" }));
    await finish("F1");
    await finish("F2");
    refused(await call({ action: "start", id: "F4" }));
    await finish("F3");
    const synthesis = await prepare("F4");
    await publish(synthesis, "WrongReports", {
      content: JSON.stringify({
        gateId: "F4",
        planSha256: synthesis.current.planSha256,
        attempt: synthesis.item.attempt,
        verdict: "PASS",
        summary: "claims success",
        evidence: ["report"],
        reviewedGates: {},
      }),
    });
    refused(await done("F4", "WrongReports"));
    await publish(synthesis, "Synthesis");
    ok(await done("F4", "Synthesis"));
    return;
  }
  if (name === "final-native-outcome") {
    const prepared = await prepare("T1");
    await publish(prepared, "EarlyCompletion", { finalResult: false });
    refused(await done("T1", "EarlyCompletion"));
    await publish(prepared, "CaptureFailed", { finalError: "Isolated patch capture failed after subprocess completion" });
    refused(await done("T1", "CaptureFailed"));
    await publish(prepared, "PendingCapture", { asyncStatus: "running" });
    refused(await done("T1", "PendingCapture"));
    const pending = nativeJobs.find((job) => job.agentId === "PendingCapture");
    assert(pending);
    pending.status = "failed";
    refused(await done("T1", "PendingCapture"));
    await publish(prepared, "SuccessfulCapture", { asyncStatus: "completed" });
    await hook("context", { messages: [] });
    nativeJobs.length = 0;
    ok(await done("T1", "SuccessfulCapture"));
    assert.equal((await row("T1")).status, "done");
    assert.equal((await row("T2")).status, "open");
    return;
  }
  await tasksDone();
  if (name === "untrusted-children") {
    const review = await prepare("F1");
    await writeFile(join(artifacts, "Bogus.md"), "PASS");
    refused(await done("F1", "Bogus"));
    for (const [child, options] of [
      ["Foreign", { parentId: "Other" }],
      ["Running", { status: "running" as const }],
      ["NoNativeResult", { observe: false }],
      ["Failed", { nativeStatus: "failed" }],
      ["Old", { createdAt: 0 }],
      ["Prose", { content: "The failure mentions PASS but I reject this gate." }],
    ] as const) {
      await publish(review, child, options);
      refused(await done("F1", child));
    }
    await publish(review, "Rejected", {
      content: JSON.stringify({
        gateId: "F1",
        planSha256: review.current.planSha256,
        attempt: review.item.attempt,
        verdict: "FAIL",
        summary: "Not fixed",
        evidence: ["failing scenario"],
        reviewedGates: {},
      }),
    });
    refused(await done("F1", "Rejected"));
    await publish(review, "Approved");
    ok(await done("F1", "Approved"));
    const next = await prepare("F2");
    await publish(next, "Approved");
    refused(await done("F2", "Approved"));
    return;
  }
  if (name === "reopen-running") {
    await finish("F1");
    await finish("F2");
    await finish("F3");
    const running = await prepare("F4");
    ok(await call({ action: "reopen", id: "F2" }));
    assert.equal((await row("F1")).status, "done");
    assert.equal((await row("F3")).status, "done");
    assert.equal((await row("F4")).attempt, undefined);
    await publish(running, "StaleSynthesis");
    refused(await done("F4", "StaleSynthesis"));
    await finish("F2");
    await finish("F4");
    ok(await call({ action: "reopen", id: "T1" }));
    const current = await ledger();
    assert.equal(current.items[2]?.status, "done");
    assert.equal(current.items[0]?.status, "open");
    assert.equal(current.items[1]?.status, "open");
    assert(current.gates.every((item) => item.status === "open" && item.receipt === undefined));
    refused(await call({ reason: "stale success" }, "prometheus_release"));
    return;
  }
  await gatesDone();
  if (name === "rollback") {
    const completed = await readFile(ledgerFile, "utf8");
    ok(await call({ action: "reopen", id: "T1" }));
    await writeFile(ledgerFile, completed);
    install();
    await hook("session_start");
    const current = await ledger();
    assert.equal(current.items[0]?.status, "open");
    assert.equal(current.items[1]?.status, "open");
    assert.equal(current.items[2]?.status, "done");
    assert(current.gates.every((item) => item.status === "open"));
    return;
  }
  if (name === "changed-output") {
    const original = await row("T1");
    await writeFile(join(artifacts, `${original.childAgentId}.md`), "Different unverified output");
    ok(await call({ action: "status" }));
    assert.equal((await row("T1")).status, "open");
    assert.equal((await row("T2")).status, "open");
    assert((await ledger()).gates.every((item) => item.status === "open"));
    return;
  }
  if (name === "resume") {
    AgentRegistry.resetGlobalForTests();
    main();
    install();
    await hook("session_start");
    const status = await call({ action: "status" });
    ok(status);
    assert(status.details?.ledger?.gates.every((item) => item.status === "done"));
    ok(await call({ reason: "verified completion" }, "prometheus_release"));
    assert.equal(confirmations, 1);
    return;
  }
  if (name === "missing-proof") {
    const current = await ledger();
    if (current.items[0]) delete current.items[0].receipt;
    await writeFile(ledgerFile, JSON.stringify(current));
    AgentRegistry.resetGlobalForTests();
    main();
    install();
    await hook("session_start");
    const reopened = await ledger();
    assert.equal(reopened.items[0]?.status, "open");
    assert.equal(reopened.items[1]?.status, "open");
    assert.equal(reopened.items[2]?.status, "done");
    assert(reopened.gates.every((item) => item.status === "open"));
    const next = await prepare("T1");
    await publish(next, "HistoricalFile", { observe: false });
    refused(await done("T1", "HistoricalFile"));
    return;
  }
  throw new Error(`Unknown scenario ${name}`);
}

if (process.env[CHILD_ENV]) {
  await scenario(process.env[CHILD_ENV] as string, process.env.PROMETHEUS_EXECUTION_ROOT as string);
  console.log("PROMETHEUS_EXECUTION_OK");
} else {
  // The scenario is also an executable child script, where importing bun:test would be invalid.
  const { describe, expect, test } = await import("bun:test");
  describe("Prometheus registered execution tools and hooks", () => {
    for (const name of [
      "cycle",
      "fresh-handoff",
      "resume-missing-ledger",
      "rollback",
      "changed-output",
      "concurrent",
      "multi-row",
      "invalid-ledger",
      "ordering",
      "untrusted-children",
      "final-native-outcome",
      "reopen-running",
      "resume",
      "missing-proof",
    ]) {
      test(name, async () => {
        const root = await mkdtemp(join(tmpdir(), "prometheus-execution-"));
        try {
          const child = Bun.spawn([process.execPath, THIS_FILE], {
            env: {
              ...process.env,
              [CHILD_ENV]: name,
              PROMETHEUS_EXECUTION_ROOT: root,
              HOME: root,
              PI_CODING_AGENT_DIR: join(root, "agent"),
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(exitCode, stderr).toBe(0);
          expect(stdout).toContain("PROMETHEUS_EXECUTION_OK");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  });
}
