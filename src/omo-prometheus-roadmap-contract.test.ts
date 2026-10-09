import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { AdrContract } from "../plugins/omo-prometheus/src/adr-contract.ts";
import { type ExecutionLedger, isComplete, ledgerRows } from "../plugins/omo-prometheus/src/ledger.ts";
import { type AtlasCompleted, RoadmapContract } from "../plugins/omo-prometheus/src/roadmap-contract.ts";
import { executionBlockReason, executionToolSourceBlockReason } from "../plugins/omo-prometheus/src/workflow.ts";

const CHILD = "PROMETHEUS_ROADMAP_CASE";
const THIS_FILE = fileURLToPath(import.meta.url);
const PROMETHEUS_ENTRY = fileURLToPath(new URL("../plugins/omo-prometheus/src/index.ts", import.meta.url));
const ROADMAP_ENTRY = fileURLToPath(new URL("../plugins/roadmap/src/index.ts", import.meta.url));
const ADR_ENTRY = fileURLToPath(new URL("../plugins/adr/src/index.ts", import.meta.url));
const content = `# Bound execution

## Tasks
- [ ] T1. Deliver the stage
  - Agent: task
  - Depends on: none
  - Acceptance: stage behavior is verified

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

class ContractEvents {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(channel: string, listener: (payload: unknown) => void): () => void {
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(payload);
  }
}

interface Result {
  isError?: boolean;
  details?: { ledger?: ExecutionLedger; outputSchema?: Record<string, unknown> };
}
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
interface RegisteredTool {
  name: string;
  execute(id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<Result>;
}

async function scenario(name: string, root: string): Promise<void> {
  // Host modules must initialize after the subprocess establishes its isolated HOME.
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const { TASK_SUBAGENT_LIFECYCLE_CHANNEL } = await import("@oh-my-pi/pi-coding-agent/task/types");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { prompt } = await import("@oh-my-pi/pi-utils");
  const { z } = await import("zod");
  const { default: register } = await import("../plugins/omo-prometheus/src/index.ts");
  const artifacts = join(root, "artifacts");
  const sessionDir = join(root, "sessions");
  await mkdir(join(artifacts, "local"), { recursive: true });
  await mkdir(sessionDir);
  await mkdir(join(root, ".omp"));
  await writeFile(
    join(root, ".omp/plugin-overrides.json"),
    JSON.stringify({ settings: { "wows-omp-plugin-omo-prometheus": { herdrDag: false, atlasWidget: false } } }),
  );
  // A `pr` delivery plan completes only once its P1 row is done.
  const planContent = name === "delivered" ? content.replace("## Tasks", "Delivery: pr\n\n## Tasks") : content;
  await writeFile(join(artifacts, "local/bound-plan.md"), planContent);
  const sessionId = "bound-session";
  const entries: Array<{ type: string; customType?: string; data?: Record<string, unknown> }> = [];
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionDir: () => sessionDir,
    getArtifactsDir: () => artifacts,
    getBranch: () => entries,
    appendCustomEntry: (customType: string, data: Record<string, unknown>) => entries.push({ type: "custom", customType, data }),
  };
  let reference = "local://bound-plan.md";
  let mode = true;
  const live = {
    settings: Settings.isolated(),
    sessionManager,
    getPlanModeState: () => ({ enabled: mode }),
    getPlanReferencePath: () => reference,
    setPlanReferencePath: (next: string) => {
      reference = next;
    },
    getTodoPhases: () => [],
    setTodoPhases() {},
    asyncJobManager: { getAllJobs: () => [] },
  } as unknown as AgentSession;
  AgentRegistry.resetGlobalForTests();
  AgentRegistry.global().register({ id: "Main", kind: "main", displayName: "Main", session: live });
  const notices: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    sessionManager,
    ui: { setWidget() {}, notify: (message: string) => notices.push(message), confirm: async () => true },
  } as unknown as ExtensionContext;
  let hooks = new Map<string, Hook>();
  let tools = new Map<string, RegisteredTool>();
  let commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  let bus = new ContractEvents();
  let sourcePath = ROADMAP_ENTRY;
  let source = "extension";
  let adrSourcePath = ADR_ENTRY;
  let requestCount = 0;
  const install = () => {
    hooks = new Map();
    tools = new Map();
    commands = new Map();
    bus = new ContractEvents();
    register({
      events: bus,
      zod: z,
      on: (type: string, handler: Hook) => hooks.set(type, handler),
      registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
      registerCommand: (command: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
        commands.set(command, spec.handler),
      logger: { warn() {} },
      appendEntry: (customType: string, data: Record<string, unknown>) => entries.push({ type: "custom", customType, data }),
      getActiveTools: () => ["task", "roadmap_stage"],
      setActiveTools: async () => {},
      getAllTools: () => [
        { name: "task", description: "# Available Agents\n- `task`: worker\n- `reviewer`: review", sourceInfo: { source: "builtin" } },
        { name: "write", sourceInfo: { source: "builtin" } },
        { name: "roadmap_stage", sourceInfo: { source, path: sourcePath } },
        { name: "adr_manage", sourceInfo: { source: "extension", path: adrSourcePath } },
        ...[...tools.values()].map((tool) => ({ name: tool.name, sourceInfo: { source: "extension", path: PROMETHEUS_ENTRY } })),
      ],
      sendMessage() {},
    } as unknown as ExtensionAPI);
  };
  const hook = async (type: string, event: Record<string, unknown> = {}) => {
    const handler = hooks.get(type);
    assert(handler);
    return await handler({ type, ...event }, ctx);
  };
  const call = async (params: Record<string, unknown>) => {
    const tool = tools.get("atlas_ledger");
    assert(tool);
    const result = await tool.execute(crypto.randomUUID(), params, undefined, undefined, ctx);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  };
  // The responder reads the live flag so a stage started during execution changes later answers.
  let stageBound = name === "bound" || name === "restored" || name === "delivered";
  const responder = () =>
    bus.on("roadmap:binding-request", (raw) => {
      const request = raw as { sessionId: string; requestId: string };
      requestCount++;
      bus.emit("roadmap:binding", {
        ...request,
        v: 1,
        repoRoot: root,
        toolSourcePath: ROADMAP_ENTRY,
        ...(stageBound ? { stage: { id: "S01", title: "Checkout", round: "R1" } } : {}),
      });
    });
  const bound = stageBound;
  install();
  if (name !== "absent" && name !== "legacy" && name !== "lazy" && name !== "adr") responder();
  await commands.get("prometheus")?.("", ctx);
  const restore = name === "restored" || name === "legacy";
  mode = restore;
  await hook("tool_result", {
    toolName: "write",
    toolCallId: "proposal",
    isError: false,
    details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: reference, planExists: true } } },
    content: [{ type: "text", text: restore ? "Plan proposal submitted" : "Plan approved at local://bound-plan.md" }],
  });
  const proposalState = entries.filter((entry) => entry.customType === "wows-omp-omo-prometheus.state").at(-1)?.data;
  assert.deepEqual(proposalState?.roadmapStage, bound ? { repoRoot: root, id: "S01" } : undefined);
  if (restore) {
    if (name === "legacy") for (const entry of entries) if (entry.data) delete entry.data.roadmapStage;
    await hook("session_shutdown");
    install();
    mode = false;
    await hook("session_start");
    const template = await readFile(
      join(dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))), "prompts/system/plan-mode-approved.md"),
      "utf8",
    );
    await hook("before_agent_start", {
      prompt: prompt.render(template, { planFilePath: reference, planContent, contextPreserved: false }),
      systemPrompt: [],
    });
  }
  assert(reference.startsWith("atlas://"), notices.join("\n"));
  const planId = reference.slice("atlas://".length, -"/plan.md".length);
  const directory = join(sessionDir, "atlas", planId);
  const ledgerPath = join(directory, "ledger.json");
  const approval = JSON.parse(await readFile(join(directory, "approval.json"), "utf8"));
  assert.equal(approval.version, 2);
  assert.deepEqual(approval.roadmapStage, bound ? { repoRoot: root, id: "S01" } : undefined);
  if (!bound) assert(!Object.hasOwn(approval, "roadmapStage"));
  const completionEvents: AtlasCompleted[] = [];
  bus.on("atlas:completed", (raw) => {
    assert(isComplete(JSON.parse(readFileSync(ledgerPath, "utf8")) as ExecutionLedger), "Event must follow the durable ledger write");
    completionEvents.push(raw as AtlasCompleted);
  });
  const roadmapDevice = (content: Record<string, unknown>) => ({
    toolName: "write",
    toolCallId: crypto.randomUUID(),
    input: { path: "xd://roadmap_stage", content: JSON.stringify(content) },
  });
  if (name === "adr") {
    // An ADR-only repository: no roadmap answers, yet the ADR tools reach Atlas through their own handshake.
    const adrCall = { toolName: "adr_manage", input: { action: "set_status", id: "ADR-0001", status: "accepted" } };
    const adrDevice = () => ({
      toolName: "write",
      toolCallId: crypto.randomUUID(),
      input: { path: "xd://adr_manage", content: JSON.stringify(adrCall.input) },
    });
    for (const event of [adrCall, adrDevice()]) {
      const denied = (await hook("tool_call", event)) as { block: boolean; reason: string };
      assert.equal(denied.block, true);
      assert.match(denied.reason, /adr plugin did not answer the binding handshake.*adr plugin is installed and enabled/);
    }
    let adrRequests = 0;
    bus.on("adr:binding-request", (raw) => {
      adrRequests++;
      bus.emit("adr:binding", { ...(raw as Record<string, unknown>), v: 1, toolSourcePath: ADR_ENTRY, api: { version: 1 } });
    });
    assert.equal(await hook("tool_call", adrCall), undefined);
    assert.equal(await hook("tool_call", adrDevice()), undefined);
    assert.equal(adrRequests, 1);
    // The ADR binding never vouches for roadmap tools.
    const roadmapDenied = (await hook("tool_call", { toolName: "roadmap_stage", input: { action: "close" } })) as { reason: string };
    assert.match(roadmapDenied.reason, /roadmap plugin did not answer the binding handshake/);
    adrSourcePath = `${ADR_ENTRY}-shadow`;
    for (const event of [adrCall, adrDevice()]) {
      const denied = (await hook("tool_call", event)) as { block: boolean; reason: string };
      assert.equal(denied.block, true);
      assert.match(denied.reason, /verified adr runtime.*-shadow/);
    }
    await hook("session_shutdown");
    console.log(`PROMETHEUS_ROADMAP_OK ${name}`);
    return;
  }
  if (name === "lazy") {
    await hook("session_shutdown");
    install();
    await hook("session_start");
    const unanswered = (await hook("tool_call", roadmapDevice({ action: "start", id: "S01" }))) as { block: boolean; reason: string };
    assert.equal(unanswered.block, true);
    assert.match(unanswered.reason, /did not answer the binding handshake/);
    const unsubscribe = responder();
    assert.equal(await hook("tool_call", { toolName: "roadmap_stage", input: { action: "close" } }), undefined);
    assert.equal(await hook("tool_call", roadmapDevice({ action: "start", id: "S01" })), undefined);
    assert.equal(requestCount, 1);
    unsubscribe();
    sourcePath = `${ROADMAP_ENTRY}-shadow`;
    for (const event of [{ toolName: "roadmap_stage", input: { action: "close" } }, roadmapDevice({ action: "close", id: "S01" })]) {
      const denied = (await hook("tool_call", event)) as { block: boolean; reason: string };
      assert.equal(denied.block, true);
      assert.match(denied.reason, /verified roadmap runtime.*-shadow/);
    }
    sourcePath = ROADMAP_ENTRY;
    source = "builtin";
    assert.equal(((await hook("tool_call", { toolName: "roadmap_stage", input: {} })) as { block: boolean }).block, true);
    await hook("session_shutdown");
    console.log(`PROMETHEUS_ROADMAP_OK ${name}`);
    return;
  }
  if (name === "bound" || name === "unbound" || name === "late") {
    assert.equal(await hook("tool_call", { toolName: "roadmap_stage", input: { action: "close" } }), undefined);
    assert.equal(await hook("tool_call", roadmapDevice({ action: "start", id: "S01" })), undefined);
    assert.equal(requestCount, 1);
  }
  // Atlas starts the stage after a proposal that carried none.
  if (name === "late") stageBound = true;
  const expectsCompletion = bound || name === "late";
  const finish = async (id: string) => {
    const started = await call({ action: "start", id });
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as ExecutionLedger;
    const row = ledgerRows(ledger).find((row) => row.id === id);
    assert(row?.attempt && row.startedAt !== undefined);
    const toolCallId = `dispatch-${id}-${crypto.randomUUID()}`;
    const input = {
      agent: row.dispatchAgent,
      task: `review_kind: compliance\natlas_assignment: ${JSON.stringify({ planSha256: ledger.planSha256, rows: { [id]: row.attempt } })}\nPerform ${row.title}.`,
      ...(started.details?.outputSchema ? { outputSchema: started.details.outputSchema, schemaMode: "strict" } : {}),
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    const childAgentId = `Child${crypto.randomUUID().replaceAll("-", "")}`;
    const sessionFile = join(artifacts, `${childAgentId}.jsonl`);
    const outputPath = join(artifacts, `${childAgentId}.md`);
    await writeFile(
      outputPath,
      id.startsWith("F")
        ? JSON.stringify({
            gateId: id,
            planSha256: ledger.planSha256,
            attempt: row.attempt,
            verdict: "PASS",
            summary: `Verified ${id} from native output`,
            evidence: ["Observed the acceptance result"],
          })
        : "Delivered the scoped behavior.",
    );
    AgentRegistry.global().register({
      id: childAgentId,
      kind: "sub",
      displayName: childAgentId,
      parentId: "Main",
      session: null,
      sessionFile,
      status: "idle",
      createdAt: row.startedAt,
      history: { outputPath },
    });
    bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
      id: childAgentId,
      agent: row.dispatchAgent,
      index: 0,
      status: "completed",
      sessionFile,
      parentToolCallId: toolCallId,
    });
    await hook("tool_result", {
      toolName: "task",
      toolCallId,
      input,
      isError: false,
      details: { results: [{ id: childAgentId, index: 0, exitCode: 0, aborted: false }] },
      content: [{ type: "text", text: "Native task finished" }],
    });
    await call({ action: "done", id, childAgentId, evidence: "Caller inspection, not the gate summary" });
  };
  for (const id of ["T1", "F1", "F2", "F3"]) {
    await finish(id);
    assert.equal(completionEvents.length, 0);
  }
  await finish("F4");
  if (name === "delivered") {
    // Every gate passed, yet the stage hears nothing until the pull request exists.
    assert.equal(completionEvents.length, 0);
    await finish("P1");
  }
  assert.equal(completionEvents.length, expectsCompletion ? 1 : 0);
  if (expectsCompletion) {
    const event = completionEvents[0];
    assert(event);
    assert.equal(event.v, 1);
    assert.equal(event.sessionId, sessionId);
    assert.equal(event.planId, planId);
    assert.deepEqual(event.roadmapStage, { repoRoot: root, id: "S01" });
    assert.deepEqual(
      event.gates,
      ["F1", "F2", "F3", "F4"].map((gateId) => ({ gateId, verdict: "PASS", summary: `Verified ${gateId} from native output` })),
    );
    assert(Number.isFinite(Date.parse(event.at)));
    assert.deepEqual(event.delivery, name === "delivered" ? { mode: "pr", summary: "Caller inspection, not the gate summary" } : undefined);
  }
  await call({ action: "status" });
  await call({ action: "reopen", id: "F4", evidence: "Recheck the gate" });
  await finish("F4");
  assert.equal(completionEvents.length, expectsCompletion ? 1 : 0);
  await hook("session_shutdown");
  console.log(`PROMETHEUS_ROADMAP_OK ${name}`);
}

if (process.env[CHILD]) {
  await scenario(process.env[CHILD] as string, process.env.PROMETHEUS_ROADMAP_ROOT as string);
} else {
  // The plain Bun child exercises module loading; bun:test belongs only to its parent runner.
  const { expect, test } = await import("bun:test");
  test("roadmap handshake accepts only correlated synchronous answers and remembers the last source", async () => {
    const bus = new ContractEvents();
    const contract = new RoadmapContract(bus);
    let source = ROADMAP_ENTRY;
    let bound = true;
    const unsubscribe = bus.on("roadmap:binding-request", (raw) => {
      const request = raw as { sessionId: string; requestId: string };
      bus.emit("roadmap:binding", { ...request, v: 2, repoRoot: "/repo", toolSourcePath: source });
      bus.emit("roadmap:binding", { ...request, v: 1, sessionId: "other", repoRoot: "/repo", toolSourcePath: source });
      bus.emit("roadmap:binding", { ...request, v: 1, requestId: "other", repoRoot: "/repo", toolSourcePath: source });
      bus.emit("roadmap:binding", {
        ...request,
        v: 1,
        repoRoot: "/repo",
        toolSourcePath: source,
        ...(bound ? { stage: { id: "S01", title: "Checkout", round: "R1" } } : {}),
      });
    });
    expect(contract.requestBinding("a")?.stage?.id).toBe("S01");
    source = "/updated/runtime.ts";
    bound = false;
    expect(contract.requestBinding("a")?.toolSourcePath).toBe(source);
    expect(contract.binding("a")?.stage).toBeUndefined();
    unsubscribe();
    expect(contract.requestBinding("a")).toBeUndefined();
    let lateRequest: { sessionId: string; requestId: string } | undefined;
    bus.on("roadmap:binding-request", (raw) => {
      lateRequest = raw as { sessionId: string; requestId: string };
      queueMicrotask(() => bus.emit("roadmap:binding", { ...lateRequest, v: 1, repoRoot: "/repo", toolSourcePath: ROADMAP_ENTRY }));
    });
    expect(contract.requestBinding("a")).toBeUndefined();
    await Promise.resolve();
    expect(contract.binding("a")).toBeUndefined();
    expect(bus.listeners.get("roadmap:binding")?.size).toBe(0);
  });
  test("ADR handshake accepts only correlated synchronous answers and ignores the api", async () => {
    const bus = new ContractEvents();
    const contract = new AdrContract(bus);
    let calls = 0;
    const api = new Proxy(
      {},
      {
        get() {
          calls++;
          return undefined;
        },
      },
    );
    const unsubscribe = bus.on("adr:binding-request", (raw) => {
      const request = raw as { sessionId: string; requestId: string };
      bus.emit("adr:binding", { ...request, v: 2, toolSourcePath: ADR_ENTRY, api });
      bus.emit("adr:binding", { ...request, v: 1, sessionId: "other", toolSourcePath: ADR_ENTRY, api });
      bus.emit("adr:binding", { ...request, v: 1, requestId: "other", toolSourcePath: ADR_ENTRY, api });
      bus.emit("adr:binding", { ...request, v: 1, toolSourcePath: "relative/index.ts", api });
      bus.emit("adr:binding", { ...request, v: 1, toolSourcePath: ADR_ENTRY, api });
    });
    expect(contract.requestBinding("a")?.toolSourcePath).toBe(ADR_ENTRY);
    unsubscribe();
    expect(contract.binding("a")?.toolSourcePath).toBe(ADR_ENTRY);
    expect(calls).toBe(0);
    contract.forget("a");
    expect(contract.binding("a")).toBeUndefined();
    let lateRequest: { sessionId: string; requestId: string } | undefined;
    bus.on("adr:binding-request", (raw) => {
      lateRequest = raw as { sessionId: string; requestId: string };
      queueMicrotask(() => bus.emit("adr:binding", { ...lateRequest, v: 1, toolSourcePath: ADR_ENTRY, api }));
    });
    expect(contract.requestBinding("a")).toBeUndefined();
    await Promise.resolve();
    expect(contract.binding("a")).toBeUndefined();
    expect(bus.listeners.get("adr:binding")?.size).toBe(0);
  });
  test("Atlas guards admit only extension tools from the handshake-declared roadmap runtime", () => {
    const trusted = { roadmap: ROADMAP_ENTRY };
    expect(executionBlockReason("roadmap_stage", {})).toBeTruthy();
    expect(executionBlockReason("roadmap_stage", {}, trusted)).toBeUndefined();
    expect(executionToolSourceBlockReason("roadmap_stage", "extension", false, trusted, ROADMAP_ENTRY)).toBeUndefined();
    for (const source of ["builtin", "mcp", undefined])
      expect(executionToolSourceBlockReason("roadmap_stage", source, false, trusted, ROADMAP_ENTRY)).toBeTruthy();
    expect(executionToolSourceBlockReason("roadmap_stage", "extension", false, trusted, "/shadow.ts")).toBeTruthy();
    expect(executionToolSourceBlockReason("roadmap_stage", "extension", true)).toBeTruthy();
    expect(executionBlockReason("bash", {}, trusted)).toBeTruthy();
    expect(executionToolSourceBlockReason("task", "extension", false, trusted, ROADMAP_ENTRY)).toBeTruthy();
  });
  test("Atlas admits ADR tools and devices only from the ADR handshake's runtime", () => {
    const trusted = { adr: ADR_ENTRY };
    const input = { action: "set_status", id: "ADR-0001", status: "accepted" };
    const device = { path: "xd://adr_manage", content: JSON.stringify(input) };
    expect(executionBlockReason("adr_manage", input, trusted)).toBeUndefined();
    expect(executionBlockReason("write", device, trusted)).toBeUndefined();
    expect(executionToolSourceBlockReason("adr_manage", "extension", false, trusted, ADR_ENTRY)).toBeUndefined();
    for (const reason of [executionBlockReason("adr_manage", input), executionBlockReason("write", device)])
      expect(reason).toMatch(/adr plugin did not answer the binding handshake.*check that the adr plugin is installed and enabled/);
    expect(executionToolSourceBlockReason("adr_manage", "extension", false, trusted, "/shadow.ts")).toMatch(
      /not from the verified adr runtime.*\/shadow\.ts/,
    );
    for (const source of ["builtin", "mcp", undefined])
      expect(executionToolSourceBlockReason("adr_manage", source, false, trusted, ADR_ENTRY)).toBeTruthy();
    // Each family is vouched for only by its own handshake, even when both name the same path.
    const roadmapOnly = { roadmap: ADR_ENTRY };
    expect(executionBlockReason("adr_manage", input, roadmapOnly)).toMatch(/adr plugin did not answer/);
    expect(executionBlockReason("write", device, roadmapOnly)).toMatch(/adr plugin did not answer/);
    expect(executionToolSourceBlockReason("adr_manage", "extension", false, roadmapOnly, ADR_ENTRY)).toMatch(/adr plugin did not answer/);
    const adrOnly = { adr: ROADMAP_ENTRY };
    const roadmapDevice = { path: "xd://roadmap_todo", content: JSON.stringify({ action: "add", title: "Later" }) };
    expect(executionBlockReason("roadmap_stage", {}, adrOnly)).toMatch(/roadmap plugin did not answer/);
    expect(executionBlockReason("write", roadmapDevice, adrOnly)).toMatch(/roadmap plugin did not answer/);
    expect(executionToolSourceBlockReason("roadmap_stage", "extension", false, adrOnly, ROADMAP_ENTRY)).toMatch(
      /roadmap plugin did not answer/,
    );
    // Both handshakes present: each tool still needs its own family's path.
    const both = { roadmap: ROADMAP_ENTRY, adr: ADR_ENTRY };
    expect(executionToolSourceBlockReason("adr_manage", "extension", false, both, ROADMAP_ENTRY)).toMatch(/verified adr runtime/);
    expect(executionToolSourceBlockReason("roadmap_stage", "extension", false, both, ADR_ENTRY)).toMatch(/verified roadmap runtime/);
  });
  test("Atlas admits the planned-round tool and device only from authenticated roadmap provenance", () => {
    const name = "roadmap_round_plan";
    const device = { path: `xd://${name}`, content: JSON.stringify({ round: { title: "Later" } }) };
    expect(executionBlockReason(name, {}, { roadmap: ROADMAP_ENTRY })).toBeUndefined();
    expect(executionBlockReason("write", device, { roadmap: ROADMAP_ENTRY })).toBeUndefined();
    expect(executionBlockReason(name, {})).toBeTruthy();
    expect(executionBlockReason("write", device)).toBeTruthy();
    expect(executionToolSourceBlockReason(name, "extension", false, { roadmap: ROADMAP_ENTRY }, ROADMAP_ENTRY)).toBeUndefined();
    expect(executionToolSourceBlockReason(name, "extension", false, { roadmap: ROADMAP_ENTRY }, "/shadow.ts")).toBeTruthy();
  });
  test("Atlas roadmap policy keeps the authenticated roadmap exception separate from direct workspace writes", () => {
    const close = { action: "close", id: "S01" };
    const trusted = { roadmap: ROADMAP_ENTRY };
    expect(executionBlockReason("roadmap_stage", close, trusted)).toBeUndefined();
    expect(executionToolSourceBlockReason("roadmap_stage", "extension", false, trusted, ROADMAP_ENTRY)).toBeUndefined();
    expect(executionBlockReason("roadmap_stage", close)).toMatch(/did not answer the binding handshake/);
    const device = { path: "xd://roadmap_todo", content: JSON.stringify({ action: "resolve", id: "T001", resolution: "done" }) };
    expect(executionBlockReason("write", device, trusted)).toBeUndefined();
    expect(executionBlockReason("write", device)).toMatch(/did not answer the binding handshake/);
    expect(executionBlockReason("write", { ...device, path: "xd://bash" }, trusted)).toMatch(/not an approved/);
    expect(executionToolSourceBlockReason("roadmap_stage", "extension", false, trusted, "/shadow.ts")).toBeTruthy();
    for (const [toolName, input] of [
      ["write", { path: "docs/roadmap/README.md", content: "changed" }],
      ["edit", { path: "docs/roadmap/README.md" }],
      ["ast_edit", { paths: ["docs/roadmap"] }],
      ["bash", { command: "echo changed > docs/roadmap/README.md" }],
      ["eval", { code: "write('docs/roadmap/README.md', 'changed')" }],
      ["lsp", { action: "rename", apply: true }],
    ] as const)
      expect(executionBlockReason(toolName, input, trusted)).toBeTruthy();
  });
  for (const name of ["bound", "absent", "unbound", "late", "restored", "legacy", "lazy", "delivered", "adr"]) {
    test(`Prometheus roadmap contract: ${name}`, async () => {
      const home = await realpath(await mkdtemp(join(tmpdir(), "prometheus-roadmap-")));
      try {
        const root = join(home, "repo");
        await mkdir(root);
        const child = Bun.spawn([process.execPath, THIS_FILE], {
          cwd: root,
          env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), [CHILD]: name, PROMETHEUS_ROADMAP_ROOT: root },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toContain(`PROMETHEUS_ROADMAP_OK ${name}`);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }, 60_000);
  }
}
