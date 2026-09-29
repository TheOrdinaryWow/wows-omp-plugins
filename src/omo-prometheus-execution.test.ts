import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { prompt as hostPrompt } from "@oh-my-pi/pi-utils";

import type { ExecutionLedger, LedgerItem } from "../plugins/omo-prometheus/src/ledger.ts";

const CHILD_ENV = "PROMETHEUS_EXECUTION_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
// Padded table cells and trailing spaces are rewritten by the host prompt formatter in the approval handoff.
const plan = `# Execution integrity  

| Area     | Owner |
|----------|-------|
| runtime  | T1    |


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
// The host bundles this template without exporting it; render it exactly as the approval handoff does.
const planModeApprovedPrompt = await readFile(
  join(dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))), "prompts/system/plan-mode-approved.md"),
  "utf8",
);
const approvedHandoff = (planFilePath: string | undefined, planContent: string) =>
  hostPrompt.render(planModeApprovedPrompt, { planFilePath, planContent, contextPreserved: false });

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
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { cfgCycleOrder } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
  const { getKnownRoleIds } = await import("@oh-my-pi/pi-coding-agent/config/model-roles");
  const settings = Settings.isolated();
  const appliedRoles: Array<{ role: string; model: string }> = [];
  const { InternalUrlRouter } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
  const { loadOverallPlanReference } = await import("@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff");
  const { default: register } = await import("../plugins/omo-prometheus/src/index.ts");
  let artifacts = join(root, "artifacts");
  await mkdir(join(artifacts, "local", "prometheus"), { recursive: true });
  await mkdir(join(root, "sessions"));
  const sourcePlanFile = join(artifacts, "local", "integrity-plan.md");
  let planFile = sourcePlanFile;
  let ledgerFile = "";
  const entries: unknown[] = [{ type: "mode_change", id: "plan-mode", mode: "plan" }];
  let hooks = new Map<string, Hook>();
  let tools = new Map<string, RegisteredTool>();
  let bus = new EventBus();
  let mode = true;
  let reference: string | undefined;
  let sequence = 0;
  let confirmations = 0;
  let sessionId = "integrity-session";
  const notices: string[] = [];
  const menuRenders: string[] = [];
  let menuKey = "\x1b";
  const completions = new Map<string, (prefix: string) => Array<{ value: string; description?: string }> | null>();
  const commands = new Map<string, (args: string, context: ExtensionContext) => Promise<void>>();
  const nativeJobs: Array<{
    id: string;
    agentId: string;
    type: "task";
    status: string;
    startTime: number;
    label: string;
    ownerId?: string;
    promise?: Promise<void>;
  }> = [];
  let settleNativeJob: (() => void) | undefined;
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionDir: () => join(root, "sessions"),
    getArtifactsDir: () => artifacts,
    getBranch: () => entries,
  };
  const localProtocolOptions = { getSessionId: () => sessionId, getArtifactsDir: () => artifacts };
  const cycledOrders: string[][] = [];
  // Ctrl+P reaches AgentSession.cycleRoleModels, a prototype method the plugin may shadow.
  const sessionPrototype = {
    cycleRoleModels: async (roleOrder: readonly string[]) => {
      cycledOrders.push([...roleOrder]);
      return undefined;
    },
  };
  const live = Object.assign(Object.create(sessionPrototype), {
    settings,
    resolveRoleModelWithThinking: (role: string) => {
      const selector = settings.getModelRole(role);
      const [provider, id] = selector?.split("/") ?? [];
      return { model: provider && id ? { provider, id } : undefined, explicitThinkingLevel: false, warning: undefined };
    },
    applyRoleModel: async (entry: { role: string; model: { provider: string; id: string } }) => {
      appliedRoles.push({ role: entry.role, model: `${entry.model.provider}/${entry.model.id}` });
    },
    sessionManager,
    getPlanModeState: () => ({ enabled: mode }),
    getPlanReferencePath: () => reference,
    setPlanReferencePath: (path: string) => {
      reference = path;
    },
    asyncJobManager: { getAllJobs: ({ ownerId }: { ownerId: string }) => nativeJobs.filter((job) => job.ownerId === ownerId) },
    getAsyncJobSnapshot: () => ({
      running: nativeJobs.filter((job) => job.status === "running"),
      recent: nativeJobs.filter((job) => job.status !== "running"),
      delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    }),
  }) as AgentSession;
  const ctx = {
    cwd: root,
    hasUI: true,
    sessionManager,
    getSystemPrompt: () => [],
    ui: {
      notify(message: string) {
        notices.push(message);
      },
      confirm: async () => {
        confirmations += 1;
        return true;
      },
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: (result: unknown) => void,
        ) => { render(width: number): readonly string[]; handleInput(key: string): void },
      ) =>
        await new Promise<unknown>((resolve) => {
          const component = factory({ requestRender() {} }, { fg: (_color: string, value: string) => value }, {}, resolve);
          menuRenders.push(component.render(120).join("\n"));
          component.handleInput(menuKey);
        }),
    },
  } as unknown as ExtensionContext;
  const install = (registerExtension: typeof register = register) => {
    hooks = new Map();
    tools = new Map();
    bus = new EventBus();
    const api = {
      zod: z,
      events: bus,
      logger: { warn() {} },
      registerCommand: (
        name: string,
        spec: {
          handler: (args: string, context: ExtensionContext) => Promise<void>;
          getArgumentCompletions?: (prefix: string) => Array<{ value: string; description?: string }> | null;
        },
      ) => {
        commands.set(name, spec.handler);
        if (spec.getArgumentCompletions) completions.set(name, spec.getArgumentCompletions);
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
      getActiveTools: () => ["task", "read", "write", "atlas_ledger", "atlas_release"],
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
    registerExtension(api);
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
  const call = async (params: Record<string, unknown>, toolName = "atlas_ledger") => {
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
  if (name === "plain-plan-approval") {
    // Ordinary Plan Mode proposals never expose the atlas tier.
    reference = "local://integrity-plan.md";
    await hook("tool_result", {
      toolName: "write",
      toolCallId: "plain-proposal",
      isError: false,
      details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: reference, planExists: true } } },
      content: [{ type: "text", text: "Plan proposal submitted" }],
    });
    assert.deepEqual(cfgCycleOrder.get(settings), ["smol", "default", "slow"]);
    assert.equal(settings.getProvenance(cfgCycleOrder), "default");
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
    return;
  }
  await writeFile(sourcePlanFile, name === "cycle" ? plan.replace("Depends on: none", "Depends on: T2") : plan);
  await commands.get("prometheus")?.("", ctx);
  mode = false;
  reference = "local://integrity-plan.md";
  await hook("tool_result", {
    toolName: "write",
    toolCallId: "proposal",
    isError: false,
    details: { xdev: { tool: "propose", mode: "execute", inner: { planFilePath: reference, planExists: true } } },
    content: [
      {
        type: "text",
        text:
          name === "fresh-handoff" || name.startsWith("compact-")
            ? "Plan proposal submitted"
            : "Plan approved at local://integrity-plan.md",
      },
    ],
  });
  if (name !== "cycle" && name !== "fresh-handoff" && !name.startsWith("compact-"))
    assert(reference?.startsWith("atlas://"), notices.join("\n"));
  if (reference?.startsWith("atlas://")) {
    planFile = join(sessionManager.getSessionDir(), "atlas", reference.slice("atlas://".length, -"/plan.md".length), "plan.md");
    ledgerFile = join(dirname(planFile), "ledger.json");
  }
  const approvalFile = () => join(dirname(planFile), "approval.json");
  const reload = async () => {
    await hook("session_shutdown");
    install();
    await hook("session_start");
  };
  if (name === "url-boundaries") {
    const approvedUrl = reference as string;
    assert.equal(InternalUrlRouter.instance().getHandler("atlas")?.spec.write, undefined);
    assert.deepEqual(InternalUrlRouter.instance().writeTier(approvedUrl, "replacement", undefined), {
      tier: "write",
      policy: "deny",
      reason: "atlas:// URLs are read-only",
    });
    await assert.rejects(
      InternalUrlRouter.instance().requireLocal(approvedUrl, "load plan from", {
        localProtocolOptions,
        sessionId: "foreign-session",
      }),
      /unavailable/,
    );
    assert.deepEqual(await loadOverallPlanReference(approvedUrl, localProtocolOptions), { path: approvedUrl, content: plan });
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const approved = await new AtlasStore(sessionManager.getSessionDir()).find("integrity");
    const { AtlasPlanReferences } = await import("../plugins/omo-prometheus/src/atlas-plan-url.ts");
    const handler = InternalUrlRouter.instance().getHandler("atlas") as InstanceType<typeof AtlasPlanReferences>;
    const pending = handler.bind("pending-session", approved);
    handler.unbind(sessionId, approved.id);
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), handler);
    await pending;
    assert.deepEqual(await loadOverallPlanReference(approvedUrl, { getSessionId: () => "pending-session" }), {
      path: approvedUrl,
      content: plan,
    });
    await handler.bind(sessionId, approved);
    handler.unbind("pending-session", approved.id);
    assert.equal(
      await InternalUrlRouter.instance().requireLocal(approvedUrl, "load plan from", {
        sessionId: "native-child-session",
        localProtocolOptions,
        session: { localProtocolOptions } as ToolSession,
      }),
      planFile,
    );
    await assert.rejects(
      InternalUrlRouter.instance().requireLocal(approvedUrl, "load plan from", {
        sessionId: "native-child-session",
        localProtocolOptions,
      }),
      /unavailable/,
    );
    await assert.rejects(loadOverallPlanReference(approvedUrl, { getSessionId: () => "foreign-session" }), /unavailable/);
    await assert.rejects(InternalUrlRouter.instance().requireLocal(approvedUrl, "load plan from"), /unavailable/);
    for (const invalid of [approvedUrl.replace("/plan.md", "/ledger.json"), `${approvedUrl}?x=1`, `${approvedUrl}/../plan.md`]) {
      await assert.rejects(loadOverallPlanReference(invalid, localProtocolOptions));
    }
    const bundleDir = dirname(planFile);
    const movedBundle = `${bundleDir}-moved`;
    await rename(bundleDir, movedBundle);
    await symlink(movedBundle, bundleDir, "dir");
    try {
      await assert.rejects(loadOverallPlanReference(approvedUrl, localProtocolOptions), /backing changed/);
    } finally {
      await rm(bundleDir);
      await rename(movedBundle, bundleDir);
    }
    await writeFile(planFile, `${plan}\nChanged`);
    await assert.rejects(loadOverallPlanReference(approvedUrl, localProtocolOptions), /content changed/);
    await writeFile(planFile, plan);
    await commands.get("atlas")?.("", ctx);
    assert.equal(reference, "local://integrity-plan.md");
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
    await assert.rejects(loadOverallPlanReference(approvedUrl, localProtocolOptions));
    await commands.get("atlas")?.("integrity", ctx);
    assert.deepEqual(await loadOverallPlanReference(approvedUrl, localProtocolOptions), { path: approvedUrl, content: plan });
    reference = "local://explicit-user-plan.md";
    await commands.get("atlas")?.("", ctx);
    assert.equal(reference, "local://explicit-user-plan.md");
    const foreignHandler = {
      scheme: "atlas",
      spec: { backing: "virtual" as const, selectors: "none" as const, immutable: true },
      resolve: async () => ({ url: approvedUrl, content: "", contentType: "text/plain" as const }),
    };
    InternalUrlRouter.instance().register(foreignHandler);
    await commands.get("atlas")?.("integrity", ctx);
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), foreignHandler);
    assert.equal(reference, "local://explicit-user-plan.md");
    refused(await call({ action: "status" }));
    await commands.get("atlas")?.("", ctx);
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), foreignHandler);
    InternalUrlRouter.instance().unregister("atlas");
    return;
  }
  if (name === "exit-during-url-binding") {
    await commands.get("atlas")?.("", ctx);
    const { AtlasPlanReferences } = await import("../plugins/omo-prometheus/src/atlas-plan-url.ts");
    const original = AtlasPlanReferences.prototype.bind;
    let entered!: () => void;
    let continueBind!: () => void;
    const atBind = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumeBind = new Promise<void>((resolve) => {
      continueBind = resolve;
    });
    AtlasPlanReferences.prototype.bind = async function (session, approved) {
      entered();
      await resumeBind;
      return original.call(this, session, approved);
    };
    try {
      const entering = commands.get("atlas")?.("integrity", ctx);
      await atBind;
      await commands.get("atlas")?.("", ctx);
      continueBind();
      await entering;
      assert.equal(reference, "local://integrity-plan.md");
      assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
      refused(await call({ action: "status" }));
    } finally {
      continueBind();
      AtlasPlanReferences.prototype.bind = original;
    }
    return;
  }
  if (name === "parallel-url-bindings") {
    const firstUrl = reference as string;
    const firstSession = sessionId;
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const second = await new AtlasStore(sessionManager.getSessionDir()).create({
      name: "parallel",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://parallel-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "parallel-proposal",
      availableAgents: ["task", "reviewer"],
    });
    sessionId = "parallel-session";
    entries.length = 0;
    reference = "local://PLAN.md";
    const { loadLegacyPiModule } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat");
    const loaded = (await loadLegacyPiModule(fileURLToPath(new URL("../plugins/omo-prometheus/src/index.ts", import.meta.url)))) as {
      default: typeof register;
    };
    assert.notEqual(loaded.default, register, "the host reload must use a distinct extension module identity");
    install(loaded.default); // Native loads use distinct module identities, but share the host's router.
    await hook("session_start");
    await commands.get("atlas")?.("parallel", ctx);
    const secondUrl = reference as string;
    assert.equal(secondUrl, `atlas://${second.id}/plan.md`);
    assert.deepEqual(await loadOverallPlanReference(secondUrl, localProtocolOptions), { path: secondUrl, content: plan });
    await assert.rejects(loadOverallPlanReference(firstUrl, localProtocolOptions), /unavailable/);
    await commands.get("atlas")?.("", ctx);
    assert(InternalUrlRouter.instance().getHandler("atlas"), "the first Atlas session still owns its URL");
    assert.deepEqual(await loadOverallPlanReference(firstUrl, { getSessionId: () => firstSession }), {
      path: firstUrl,
      content: plan,
    });
    await assert.rejects(loadOverallPlanReference(secondUrl, localProtocolOptions), /unavailable/);
    return;
  }
  if (name === "resume-absolute-reference") {
    reference = planFile;
    await reload();
    assert(reference?.startsWith("atlas://"));
    assert.deepEqual(await loadOverallPlanReference(reference, localProtocolOptions), { path: reference, content: plan });
    ok(await call({ action: "status" }));
    return;
  }

  const prepare = async (id: string): Promise<PreparedAssignment> => {
    const result = await call({ action: "start", id });
    ok(result);
    const item = await row(id);
    const current = await ledger();
    const toolCallId = `dispatch-${sequence++}`;
    const input = {
      agent: item.dispatchAgent,
      task: `review_kind: compliance\natlas_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { [id]: item.attempt } })}\nPerform ${item.title}; acceptance: ${item.acceptance}`,
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
      createdAt: options.createdAt ?? prepared.item.startedAt ?? 0,
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
        ...(name === "cancelled-live-child"
          ? {
              ownerId: "Main",
              promise: new Promise<void>((resolve) => {
                settleNativeJob = resolve;
              }),
            }
          : {}),
      });
      await hook("tool_result", {
        toolName: "task",
        toolCallId: prepared.toolCallId,
        input: prepared.input,
        isError: false,
        details: {
          results: [],
          async: { state: "running", jobId: `job-${childAgentId}`, type: "task" },
          progress: [{ id: childAgentId, index: 0 }],
        },
        content: [{ type: "text", text: "Native task scheduled" }],
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

  if (name === "atlas-autocomplete") {
    await tasksDone();
    await gatesDone();
    await commands.get("atlas")?.("", ctx);
    // Host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const store = new AtlasStore(sessionManager.getSessionDir());
    const current = await store.create({
      name: "Current work",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://current-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "current-proposal",
      availableAgents: ["task", "reviewer"],
    });
    const foreign = join(root, "other-workspace");
    await mkdir(foreign);
    await store.create({
      name: "Foreign work",
      content: plan,
      cwd: foreign,
      sourcePlanPath: "local://foreign-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "foreign-proposal",
      availableAgents: ["task", "reviewer"],
    });
    await commands.get("atlas")?.("", ctx);
    const complete = completions.get("atlas");
    assert(complete);
    assert.deepEqual(complete("Current"), [{ value: "Current work", label: "Current work", description: current.id }]);
    assert.deepEqual(complete(current.id.slice(0, 14)), [{ value: "Current work", label: "Current work", description: current.id }]);
    assert.equal(complete("integrity"), null);
    assert.equal(complete("Foreign"), null);
    assert.match(menuRenders.at(-1) ?? "", /Current work/);
    assert.doesNotMatch(menuRenders.at(-1) ?? "", /Foreign work/);
    menuKey = " ";
    await commands.get("atlas")?.("", ctx);
    assert.equal(reference, `atlas://${current.id}/plan.md`);
    return;
  }

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
      prompt: approvedHandoff(reference, plan),
      systemPrompt: [],
    });
    assert(reference?.startsWith("atlas://"), notices.join("\n"));
    planFile = join(sessionManager.getSessionDir(), "atlas", reference.slice("atlas://".length, -"/plan.md".length), "plan.md");
    ledgerFile = join(dirname(planFile), "ledger.json");
    ok(await call({ action: "status" }));
    await finish("T1");
    return;
  }
  if (name.startsWith("compact-")) {
    const sourceReference = reference;
    await hook("session_before_compact");
    await hook("session_compact");
    const boundUrl = reference;
    assert(reference?.startsWith("atlas://"), notices.join("\n"));
    planFile = join(sessionManager.getSessionDir(), "atlas", reference.slice("atlas://".length, -"/plan.md".length), "plan.md");
    ledgerFile = join(dirname(planFile), "ledger.json");
    const originalLedgerId = (await ledger()).ledgerId;
    // The host restores its source local:// reference after the session_compact callback.
    reference = name.endsWith("reference-mismatch") ? "local://unrelated-plan.md" : sourceReference;
    const inline = name.endsWith("inline-mismatch") ? `${plan}\nAltered acceptance` : plan;
    const prompt = approvedHandoff(reference, inline);
    const queued = name.startsWith("compact-queued");
    const message = {
      role: name.endsWith("user-role") ? "user" : "developer",
      content: [{ type: "text", text: prompt }],
      attribution: name.endsWith("user-attribution") ? "user" : "agent",
      synthetic: true,
      timestamp: Date.now(),
    };
    if (queued) await hook("context", { messages: [message] });
    else await hook("before_agent_start", { prompt, systemPrompt: [] });
    if (name === "compact-handoff" || name === "compact-queued-handoff") {
      ok(await call({ action: "status" }));
      ok(await call({ action: "start", id: "T1" }));
      assert.equal(reference, boundUrl);
      if (queued) {
        reference = sourceReference;
        await hook("context", { messages: [message] });
        refused(await call({ action: "status" }));
        assert.equal(reference, sourceReference, "consumed native compact handoff must not authorize a later reference overwrite");
      }
    } else {
      refused(await call({ action: "status" }));
      assert.notEqual(reference, boundUrl);
    }
    assert.equal((await ledger()).ledgerId, originalLedgerId);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    assert.equal((await new AtlasStore(sessionManager.getSessionDir()).list()).length, 1);
    return;
  }
  if (name === "resume-missing-ledger") {
    await rm(ledgerFile);
    reference = "local://PLAN.md";
    await reload();
    assert.equal(reference, "local://PLAN.md");
    await hook("before_agent_start", { prompt: "Continue", systemPrompt: [] });
    refused(await call({ action: "status" }));
    await assert.rejects(readFile(ledgerFile), { code: "ENOENT" });
    assert.equal(await hook("session_stop"), undefined);
    return;
  }
  if (name === "resume-reference-mismatch") {
    reference = "local://other-plan.md";
    await reload();
    assert.equal(reference, "local://other-plan.md");
    refused(await call({ action: "status" }));
    return;
  }
  if (name === "resume-invalid-approval") {
    const marker = JSON.parse(await readFile(approvalFile(), "utf8")) as Record<string, unknown>;
    marker.planSha256 = "0".repeat(64);
    await writeFile(approvalFile(), JSON.stringify(marker));
    reference = "local://PLAN.md";
    await reload();
    assert.equal(reference, "local://PLAN.md");
    refused(await call({ action: "status" }));
    return;
  }
  if (name === "resume-missing-provenance") {
    const marker = JSON.parse(await readFile(approvalFile(), "utf8")) as Record<string, unknown>;
    delete marker.proposedByToolCallId;
    await writeFile(approvalFile(), JSON.stringify(marker));
    const checkpoint = entries.findLast(
      (entry) =>
        entry !== null && typeof entry === "object" && "customType" in entry && entry.customType === "wows-omp-omo-prometheus.state",
    );
    assert(checkpoint && typeof checkpoint === "object" && "data" in checkpoint && checkpoint.data && typeof checkpoint.data === "object");
    const data: Record<string, unknown> = { ...checkpoint.data };
    delete data.proposedByToolCallId;
    entries.push({ type: "custom", customType: "wows-omp-omo-prometheus.state", data });
    reference = "local://PLAN.md";
    await reload();
    assert.equal(reference, "local://PLAN.md");
    refused(await call({ action: "status" }));
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
      task: `atlas_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { T1: first.attempt, T3: third.attempt } })}\nImplement both independent criteria.`,
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    await publish({ item: first, current, toolCallId, input }, "Combined", {
      createdAt: Math.max(first.startedAt ?? 0, third.startedAt ?? 0),
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
      refused(await call({ reason: "claim complete" }, "atlas_release"));
      assert.notEqual(await hook("tool_call", { toolName: "task", toolCallId: "blocked", input: { task: "implement" } }), undefined);
      assert.equal(await hook("session_stop"), undefined);
      assert.equal(confirmations, 0);
      await writeFile(planFile, plan);
      await writeFile(ledgerFile, original);
    }
    await hook("input", { text: "/atlas", source: "user" });
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
    let prepared = await prepare("T1");
    await publish(prepared, "EarlyCompletion", { finalResult: false });
    refused(await done("T1", "EarlyCompletion"));
    await publish(prepared, "CaptureFailed", { finalError: "Isolated patch capture failed after subprocess completion" });
    refused(await done("T1", "CaptureFailed"));
    ok(await call({ action: "reopen", id: "T1" }));
    prepared = await prepare("T1");
    await publish(prepared, "PendingCapture", { asyncStatus: "running" });
    refused(await done("T1", "PendingCapture"));
    const pending = nativeJobs.find((job) => job.agentId === "PendingCapture");
    assert(pending);
    pending.status = "failed";
    refused(await done("T1", "PendingCapture"));
    ok(await call({ action: "reopen", id: "T1" }));
    prepared = await prepare("T1");
    await publish(prepared, "SuccessfulCapture", { asyncStatus: "completed" });
    await hook("context", { messages: [] });
    nativeJobs.length = 0;
    ok(await done("T1", "SuccessfulCapture"));
    assert.equal((await row("T1")).status, "done");
    assert.equal((await row("T2")).status, "open");
    return;
  }
  if (name === "wake-ownership" || name === "wake-native-success" || name === "wake-native-failure" || name === "wake-missing-lifecycle") {
    const prepared = await prepare("T1");
    await publish(prepared, "WokenChild", {
      asyncStatus: "completed",
      nativeStatus: name === "wake-missing-lifecycle" ? "started" : "completed",
    });
    if (name === "wake-ownership") ok(await done("T1", "WokenChild"));
    assert.equal(
      await hook("tool_call", {
        toolName: "write",
        toolCallId: "wake-message",
        input: { path: "agent://WokenChild", content: "Inspect this follow-up" },
      }),
      undefined,
    );
    await publish(prepared, "WokenChild", { status: "running", nativeStatus: "started", finalResult: false });
    // Native wake jobs are registered on yield, later than the original task's returnedAt.
    // Until a wake job exists, the new lifecycle generation itself retains writer ownership.
    if (name === "wake-ownership") await commands.get("atlas")?.("", ctx);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const rival = new AtlasStore(sessionManager.getSessionDir());
    const shared = await rival.find("integrity");
    if (name === "wake-ownership") await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    let settleWake!: () => void;
    const wakeJob = {
      id: "job-WokenChild-2",
      agentId: "WokenChild",
      type: "task" as const,
      ownerId: "Main",
      startTime: Date.now(),
      label: "IRC follow-up",
      status: "running",
      promise: new Promise<void>((resolve) => {
        settleWake = resolve;
      }),
    };
    nativeJobs.push(wakeJob);
    await publish(prepared, "WokenChild", { nativeStatus: "completed", finalResult: false, content: "New output from the wake turn" });
    // An old synchronous final result and an old completed native job cannot authorize overwritten output.
    await hook("tool_result", {
      toolName: "task",
      toolCallId: prepared.toolCallId,
      isError: false,
      details: { results: [{ id: "WokenChild", index: 0, exitCode: 0, aborted: false }] },
      content: [],
    });
    if (name !== "wake-ownership") refused(await done("T1", "WokenChild"));
    else await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    wakeJob.status = name === "wake-native-success" || name === "wake-missing-lifecycle" ? "completed" : "failed";
    await hook("context", { messages: [] });
    // Even a terminal-looking wake job row does not settle its retained native promise.
    if (name !== "wake-ownership") refused(await done("T1", "WokenChild"));
    else await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    settleWake();
    await hook("tool_result", { toolName: "task", toolCallId: "unrelated", isError: false, details: {}, content: [] });
    if (name === "wake-native-success" || name === "wake-missing-lifecycle") {
      ok(await done("T1", "WokenChild"));
      const receipt = (await row("T1")).receipt;
      assert(receipt);
      assert.equal(await readFile(join(dirname(planFile), "evidence", `${receipt.receiptId}.md`), "utf8"), "New output from the wake turn");
    } else if (name === "wake-native-failure") refused(await done("T1", "WokenChild"));
    if (name !== "wake-ownership") await commands.get("atlas")?.("", ctx);
    await rival.acquire(shared.id, "rival");
    await rival.release(shared.id, "rival");
    return;
  }
  if (name === "wake-wrapper-cancel" || name === "wake-wrapper-direct-abort") {
    const prepared = await prepare("T1");
    await publish(prepared, "AbortableWake", { asyncStatus: "completed" });
    await publish(prepared, "AbortableWake", { status: "running", nativeStatus: "started", finalResult: false });
    // These real host modules load only inside the isolated child process.
    const { AsyncJobManager } = await import("@oh-my-pi/pi-coding-agent/async");
    const { untilAborted } = await import("@oh-my-pi/pi-utils");
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const manager = new AsyncJobManager({ onJobComplete() {} });
    Object.defineProperty(live, "asyncJobManager", { value: manager, configurable: true });
    let resolveOutcome!: (text: string) => void;
    let underlyingFinished = false;
    const outcome = new Promise<string>((resolve) => {
      resolveOutcome = resolve;
    }).then((text) => {
      underlyingFinished = true;
      return text;
    });
    const id = manager.register("task", "AbortableWake", ({ signal }) => untilAborted(signal, outcome), {
      id: "AbortableWake-revived",
      agentId: "AbortableWake",
      ownerId: "Main",
    });
    const job = manager.getJob(id);
    assert(job);
    nativeJobs.push({
      id: job.id,
      agentId: "AbortableWake",
      type: "task",
      startTime: job.startTime,
      label: job.label,
      get status() {
        return job.status;
      },
    });
    try {
      await hook("context", { messages: [] });
      if (name === "wake-wrapper-cancel") assert(manager.cancel(id, { ownerId: "Main" }));
      else job.abortController.abort();
      await job.promise;
      assert.equal(job.status, name === "wake-wrapper-cancel" ? "cancelled" : "failed");
      assert.equal(underlyingFinished, false, "native abort wrapper must settle while underlying wake is still pending");
      await publish(prepared, "AbortableWake", { nativeStatus: "completed", finalResult: false, content: "Unsettled wake output" });
      refused(await done("T1", "AbortableWake"));
      await commands.get("atlas")?.("", ctx);
      const rival = new AtlasStore(sessionManager.getSessionDir());
      const shared = await rival.find("integrity");
      await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
      resolveOutcome("The unwrapped wake finally completed");
      await outcome;
      assert.equal(underlyingFinished, true);
      await hook("tool_result", { toolName: "task", toolCallId: "unrelated", isError: false, details: {}, content: [] });
      // The plugin has only the cancelled wrapper; lifecycle and caller knowledge of the
      // unwrapped promise are not a native final handle and cannot release its lock.
      await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    } finally {
      resolveOutcome("Cleanup");
      await outcome;
      await manager.dispose({ timeoutMs: 100 });
    }
    return;
  }
  if (name === "mixed-schedule-failure" || name === "mixed-inline-failure") {
    ok(await call({ action: "start", id: "T1" }));
    ok(await call({ action: "start", id: "T3" }));
    const current = await ledger();
    const first = await row("T1");
    const third = await row("T3");
    const toolCallId = "mixed-dispatch";
    const input = {
      context: "Independent native task members",
      tasks: [first, third].map((item) => ({
        agent: item.dispatchAgent,
        task: `atlas_assignment: ${JSON.stringify({ planSha256: current.planSha256, rows: { [item.id]: item.attempt } })}\nExecute ${item.id}`,
      })),
    };
    assert.equal(await hook("tool_call", { toolName: "task", toolCallId, input }), undefined);
    await publish({ item: first, current, toolCallId, input }, "RunningSibling", { asyncStatus: "running" });
    if (name === "mixed-inline-failure")
      bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
        id: "FailedMember",
        index: 1,
        status: "failed",
        sessionFile: join(artifacts, "FailedMember.jsonl"),
        parentToolCallId: toolCallId,
      });
    const details = {
      results: [],
      async: { state: "running", type: "task", jobId: "job-RunningSibling" },
      progress: [
        { id: "RunningSibling", index: 0, status: "running" },
        { id: "FailedMember", index: 1, status: name === "mixed-inline-failure" ? "aborted" : "failed" },
      ],
    };
    await hook("tool_result", { toolName: "task", toolCallId, input, isError: false, details, content: [] });
    refused(await done("T3", "FailedMember"));
    await commands.get("atlas")?.("", ctx);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const rival = new AtlasStore(sessionManager.getSessionDir());
    const shared = await rival.find("integrity");
    await assert.rejects(rival.acquire(shared.id, "rival"), /live execution owner/);
    const sibling = nativeJobs.find((job) => job.agentId === "RunningSibling");
    assert(sibling);
    sibling.status = "completed";
    await hook("tool_result", { toolName: "task", toolCallId, input, isError: false, details, content: [] });
    await rival.acquire(shared.id, "rival");
    await rival.release(shared.id, "rival");
    await commands.get("atlas")?.("integrity", ctx);
    ok(await call({ action: "status" }));
    assert.equal((await row("T3")).status, "open");
    return;
  }
  if (name === "atlas-model-role") {
    const cycle = () => cfgCycleOrder.get(settings);
    assert(getKnownRoleIds(settings).includes("atlas"), "atlas is listed as a model role");
    // The approved proposal exposed the atlas tier to the native approval slider.
    assert.deepEqual(cycle(), ["atlas", "smol", "default", "slow"]);
    // Ctrl+P keeps cycling only the user's roles while the approval tier is exposed.
    await live.cycleRoleModels(cycle(), "forward");
    assert.deepEqual(cycledOrders, [["smol", "default", "slow"]]);
    await commands.get("atlas")?.("", ctx);
    assert.deepEqual(cycle(), ["smol", "default", "slow"]);
    assert(!Object.hasOwn(live, "cycleRoleModels"), "Ctrl+P returns to the host implementation");
    assert.equal(settings.getProvenance(cfgCycleOrder), "default");
    await commands.get("atlas")?.("integrity", ctx);
    assert.deepEqual(appliedRoles, []);
    assert.doesNotMatch(notices.at(-1) ?? "", /atlas model role/);
    await commands.get("atlas")?.("", ctx);
    settings.overrideModelRoles({ atlas: "test/atlas-model" });
    await commands.get("atlas")?.("integrity", ctx);
    assert.deepEqual(appliedRoles, [{ role: "atlas", model: "test/atlas-model" }]);
    assert.match(notices.at(-1) ?? "", /Switched to the atlas model role \(test\/atlas-model\)/);
    assert.deepEqual(cycle(), ["smol", "default", "slow"]);
    return;
  }
  if (name === "cross-session") {
    const approvedUrl = reference;
    await finish("T1");
    const origin = (await row("T1")).receipt;
    assert(origin);
    ok(await call({ action: "start", id: "T3" }));
    const originalArtifacts = artifacts;
    await hook("input", { text: "/atlas", source: "user" });
    await hook("session_shutdown");
    sessionId = "successor-session";
    artifacts = join(root, "successor-artifacts");
    await mkdir(artifacts, { recursive: true });
    await rm(originalArtifacts, { recursive: true, force: true });
    entries.length = 0;
    reference = "local://PLAN.md";
    AgentRegistry.resetGlobalForTests();
    main();
    install();
    await hook("session_start");
    await commands.get("atlas")?.("missing-plan", ctx);
    assert.match(notices.at(-1) ?? "", /No approved Atlas plan named missing-plan; available: integrity/);
    await commands.get("atlas")?.("", ctx);
    // The proposal file name, including its `-plan` suffix, selects the same bundle.
    await commands.get("atlas")?.("integrity-plan", ctx);
    const status = await call({ action: "status" });
    ok(status);
    assert.equal(reference, approvedUrl);
    assert.deepEqual(await loadOverallPlanReference(reference as string, localProtocolOptions), { path: reference, content: plan });
    assert.deepEqual((await row("T1")).receipt, origin);
    assert.equal((await row("T3")).status, "open");
    assert(status.content.some((part) => part.text?.includes(join(dirname(planFile), "evidence", `${origin.receiptId}.md`))));
    await finish("T2");
    await finish("T3");
    const gate = await prepare("F1");
    // Native child ids can repeat across sessions; origin session is part of freshness.
    await publish(gate, origin.childAgentId);
    ok(await done("F1", origin.childAgentId));
    await finish("F2");
    await finish("F3");
    await finish("F4");
    ok(await call({ reason: "shared verification complete" }, "atlas_release"));
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
    return;
  }
  if (name === "switch-reference") {
    await finish("T1");
    const firstEntries = entries.slice();
    const firstReference = reference;
    sessionId = "second-session";
    entries.length = 0;
    await hook("session_switch", { reason: "new" });
    // The host can retain the previous reference on the same AgentSession object.
    assert.equal(reference, "local://PLAN.md");
    await assert.rejects(loadOverallPlanReference(firstReference as string, localProtocolOptions));
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const second = await new AtlasStore(sessionManager.getSessionDir()).create({
      name: "second",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://second-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "second-native",
      availableAgents: ["task", "reviewer"],
    });
    await commands.get("atlas")?.("second", ctx);
    assert.equal(reference, `atlas://${second.id}/plan.md`);
    const secondEntries = entries.slice();
    sessionId = "integrity-session";
    entries.splice(0, entries.length, ...firstEntries);
    await hook("session_switch", { reason: "resume" });
    ok(await call({ action: "status" }));
    assert.equal(reference, firstReference);
    assert.equal((await row("T1")).status, "done");
    sessionId = "second-session";
    entries.splice(0, entries.length, ...secondEntries);
    reference = "local://explicit-unrelated-plan.md";
    await hook("session_switch", { reason: "resume" });
    refused(await call({ action: "status" }));
    assert.equal(reference, "local://explicit-unrelated-plan.md");
    return;
  }
  if (name === "exact-commands") {
    assert(!tools.has("prometheus_ledger") && !tools.has("prometheus_release"));
    const approvedReference = reference;
    for (const selector of ["integrity", "missing-plan"]) {
      await commands.get("atlas")?.(selector, ctx);
      assert.match(notices.at(-1) ?? "", /already active/);
      await hook("input", { text: `/atlas ${selector}`, source: "user" });
      assert.match(notices.at(-1) ?? "", /already active/);
      assert.equal(reference, approvedReference);
    }
    await commands.get("prometheus")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /cannot release/);
    await hook("input", { text: "/prometheus", source: "user" });
    assert.match(notices.at(-1) ?? "", /Atlas is active/);
    ok(await call({ action: "status" }));
    assert.notEqual(await hook("tool_call", { toolName: "edit", input: { path: "implementation.ts" } }), undefined);
    await commands.get("atlas")?.("", ctx);
    refused(await call({ action: "status" }));
    await commands.get("atlas")?.("", ctx);
    assert.match(menuRenders.at(-1) ?? "", /integrity/);
    refused(await call({ action: "status" }));
    await commands.get("atlas")?.("missing-plan", ctx);
    assert.match(notices.at(-1) ?? "", /Atlas execution paused/);
    assert.notEqual(await hook("tool_call", { toolName: "edit", input: { path: "implementation.ts" } }), undefined);
    await commands.get("atlas")?.("", ctx);
    assert.equal(await hook("tool_call", { toolName: "edit", input: { path: "implementation.ts" } }), undefined);
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const other = await new AtlasStore(sessionManager.getSessionDir()).create({
      name: "second",
      content: plan,
      cwd: root,
      sourcePlanPath: "local://second-plan.md",
      sourceSessionId: "approved-origin",
      proposedByToolCallId: "native-second",
      availableAgents: ["task", "reviewer"],
    });
    await commands.get("atlas")?.("second", ctx);
    ok(await call({ action: "status" }));
    assert.equal(reference, `atlas://${other.id}/plan.md`);
    await commands.get("atlas")?.("", ctx);
    await hook("input", { text: "/atlas integrity", source: "user" });
    assert.equal(reference, approvedReference);
    ok(await call({ action: "status" }));
    await commands.get("atlas")?.("", ctx);
    mode = true;
    await commands.get("prometheus")?.("", ctx);
    await commands.get("atlas")?.("integrity", ctx);
    assert.match(notices.at(-1) ?? "", /cannot enter during planning/);
    await hook("input", { text: "/atlas integrity", source: "user" });
    assert.match(notices.at(-1) ?? "", /cannot enter during planning/);
    await commands.get("atlas")?.("", ctx);
    assert.match(menuRenders.at(-1) ?? "", /All|Unfinished/);
    refused(await call({ action: "status" }));
    return;
  }
  if (name === "exit-live-child" || name === "shutdown-live-child" || name === "cancelled-live-child") {
    const prepared = await prepare("T1");
    await publish(prepared, "PendingChild", { asyncStatus: "running" });
    const originalAttempt = prepared.item.attempt;
    await hook("session_tree");
    assert.equal((await row("T1")).attempt, originalAttempt);
    assert.equal((await row("T1")).status, "in_progress");
    // Loading host-dependent storage stays inside the isolated child process.
    const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
    const rival = new AtlasStore(sessionManager.getSessionDir());
    const shared = await rival.find("integrity");
    if (name === "shutdown-live-child") await hook("session_shutdown");
    else await commands.get("atlas")?.("", ctx);
    assert.deepEqual(await loadOverallPlanReference(`atlas://${shared.id}/plan.md`, localProtocolOptions), {
      path: `atlas://${shared.id}/plan.md`,
      content: plan,
    });
    if (name === "exit-live-child")
      assert.equal(await hook("tool_call", { toolName: "edit", input: { path: "implementation.ts" } }), undefined);
    await assert.rejects(rival.acquire(shared.id, "session-b"), /live execution owner/);
    if (name === "exit-live-child") {
      await commands.get("atlas")?.("integrity", ctx);
      refused(await call({ action: "status" }));
      assert.equal((await row("T1")).attempt, originalAttempt);
      await commands.get("atlas")?.("", ctx);
      const other = await rival.create({
        name: "unrelated",
        content: plan,
        cwd: root,
        sourcePlanPath: "local://unrelated-plan.md",
        sourceSessionId: "origin",
        proposedByToolCallId: "other-proposal",
        availableAgents: ["task", "reviewer"],
      });
      await commands.get("atlas")?.("unrelated", ctx);
      assert.equal(reference, `atlas://${other.id}/plan.md`);
      ok(await call({ action: "status" }));
      await commands.get("atlas")?.("", ctx);
    }
    const job = nativeJobs.find((job) => job.agentId === "PendingChild");
    assert(job);
    if (name === "cancelled-live-child") {
      job.status = "cancelled";
      await hook("context", { messages: [] });
      await assert.rejects(rival.acquire(shared.id, "session-b"), /live execution owner/);
      nativeJobs.length = 0; // The exact observed promise must survive native history eviction.
      assert(settleNativeJob);
      settleNativeJob();
    } else job.status = "failed";
    await hook("tool_result", {
      toolName: "task",
      toolCallId: prepared.toolCallId,
      isError: false,
      details: { async: { state: "failed", type: "task", jobId: job.id }, results: [] },
      content: [],
    });
    await rival.acquire(shared.id, "session-b");
    assert.equal(InternalUrlRouter.instance().getHandler("atlas"), undefined);
    await rival.release(shared.id, "session-b");
    if (name === "shutdown-live-child") await commands.get("atlas")?.("", ctx);
    await commands.get("atlas")?.("integrity", ctx);
    ok(await call({ action: "status" }));
    assert.equal((await row("T1")).status, "open");
    return;
  }
  if (name === "exit-during-capture") {
    const prepared = await prepare("T1");
    await publish(prepared, "FinishingChild");
    // This test intercepts the module instance loaded by the isolated extension above.
    const { ChildEvidence } = await import("../plugins/omo-prometheus/src/evidence.ts");
    const original = ChildEvidence.prototype.capture;
    let entered!: () => void;
    let continueCapture!: () => void;
    const captured = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      continueCapture = resolve;
    });
    ChildEvidence.prototype.capture = async function (options) {
      const receipt = await original.call(this, options);
      entered();
      await resume;
      return receipt;
    };
    try {
      const pending = done("T1", "FinishingChild");
      await captured;
      await commands.get("atlas")?.("", ctx);
      continueCapture();
      refused(await pending);
      assert.equal((await row("T1")).status, "in_progress");
      await commands.get("atlas")?.("integrity", ctx);
      ok(await call({ action: "status" }));
      assert.equal((await row("T1")).status, "open");
    } finally {
      continueCapture();
      ChildEvidence.prototype.capture = original;
    }
    return;
  }
  if (name === "legacy-pauses") {
    const oldLedger = join(artifacts, "local", "prometheus", "integrity-ledger.json");
    const oldMarker = join(artifacts, "local", "prometheus", "integrity.proposal.json");
    const progress = await readFile(ledgerFile, "utf8");
    const proposal = await readFile(oldMarker, "utf8");
    await writeFile(oldLedger, progress);
    await hook("session_shutdown");
    entries.length = 0;
    entries.push({
      type: "custom",
      customType: "wows-omp-omo-prometheus.state",
      data: {
        version: 2,
        phase: "executing",
        planFilePath: "local://integrity-plan.md",
        ledgerPath: "local://prometheus/integrity-ledger.json",
        planSha256: (await ledger()).planSha256,
        proposedByToolCallId: "old-proposal",
      },
    });
    reference = "local://integrity-plan.md";
    install();
    await hook("session_start");
    refused(await call({ action: "status" }));
    assert.match(notices.join("\n"), /fresh native reapproval/);
    await commands.get("atlas")?.("", ctx);
    assert.equal(await readFile(oldLedger, "utf8"), progress);
    assert.equal(await readFile(oldMarker, "utf8"), proposal);
    assert.equal(await readFile(sourcePlanFile, "utf8"), plan);
    return;
  }
  if (name === "workspace-mismatch") {
    await commands.get("atlas")?.("", ctx);
    const otherCwd = join(root, "different-worktree");
    await mkdir(otherCwd);
    const foreignContext = { ...ctx, cwd: otherCwd } as ExtensionContext;
    await commands.get("atlas")?.("integrity", foreignContext);
    assert.match(notices.at(-1) ?? "", /different workspace/);
    refused(await call({ action: "status" }));
    await commands.get("atlas")?.("", foreignContext);
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
    refused(await call({ reason: "stale success" }, "atlas_release"));
    return;
  }
  if (name === "branch-keeps-progress") {
    const snapshot = entries.slice();
    await finish("F1");
    const receipt = (await row("F1")).receipt;
    entries.splice(0, entries.length, ...snapshot);
    await hook("session_tree");
    ok(await call({ action: "status" }));
    assert.deepEqual((await row("F1")).receipt, receipt);
    assert.equal((await row("F1")).status, "done");
    await writeFile(join(artifacts, `${receipt?.childAgentId}.md`), "Changed old local output");
    ok(await call({ action: "status" }));
    assert.equal((await row("F1")).status, "done");
    return;
  }
  await gatesDone();
  if (name === "rollback") {
    const completed = await readFile(ledgerFile, "utf8");
    ok(await call({ action: "reopen", id: "T1" }));
    await writeFile(ledgerFile, completed);
    await reload();
    const current = await ledger();
    assert.equal(current.items[0]?.status, "open");
    assert.equal(current.items[1]?.status, "open");
    assert.equal(current.items[2]?.status, "done");
    assert(current.gates.every((item) => item.status === "open"));
    return;
  }
  if (name === "changed-output") {
    const original = await row("T1");
    assert(original.receipt);
    await writeFile(join(dirname(planFile), "evidence", `${original.receipt.receiptId}.md`), "Different unverified output");
    ok(await call({ action: "status" }));
    assert.equal((await row("T1")).status, "open");
    assert.equal((await row("T2")).status, "open");
    assert((await ledger()).gates.every((item) => item.status === "open"));
    return;
  }
  if (name === "resume") {
    AgentRegistry.resetGlobalForTests();
    main();
    await reload();
    const status = await call({ action: "status" });
    ok(status);
    assert(status.details?.ledger?.gates.every((item) => item.status === "done"));
    ok(await call({ reason: "verified completion" }, "atlas_release"));
    assert.equal(confirmations, 1);
    return;
  }
  if (name === "resume-default-reference") {
    reference = "local://PLAN.md";
    AgentRegistry.resetGlobalForTests();
    main();
    await reload();
    assert.equal(reference, `atlas://${basename(dirname(planFile))}/plan.md`);
    const status = await call({ action: "status" });
    ok(status);
    assert(status.details?.ledger?.gates.every((item) => item.status === "done"));
    ok(await call({ reason: "verified completion" }, "atlas_release"));
    assert.equal(confirmations, 1);
    return;
  }
  if (name === "missing-proof") {
    const current = await ledger();
    if (current.items[0]) delete current.items[0].receipt;
    await writeFile(ledgerFile, JSON.stringify(current));
    AgentRegistry.resetGlobalForTests();
    main();
    await reload();
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
      "url-boundaries",
      "parallel-url-bindings",
      "exit-during-url-binding",
      "resume-absolute-reference",
      "resume-missing-ledger",
      "rollback",
      "changed-output",
      "concurrent",
      "multi-row",
      "resume-reference-mismatch",
      "resume-invalid-approval",
      "resume-missing-provenance",
      "invalid-ledger",
      "ordering",
      "untrusted-children",
      "final-native-outcome",
      "reopen-running",
      "resume",
      "resume-default-reference",
      "missing-proof",
      "cross-session",
      "exact-commands",
      "atlas-autocomplete",
      "atlas-model-role",
      "plain-plan-approval",
      "exit-live-child",
      "shutdown-live-child",
      "cancelled-live-child",
      "exit-during-capture",
      "legacy-pauses",
      "workspace-mismatch",
      "branch-keeps-progress",
      "switch-reference",
      "wake-ownership",
      "wake-native-success",
      "wake-native-failure",
      "wake-missing-lifecycle",
      "wake-wrapper-cancel",
      "wake-wrapper-direct-abort",
      "mixed-schedule-failure",
      "mixed-inline-failure",
      "compact-handoff",
      "compact-inline-mismatch",
      "compact-reference-mismatch",
      "compact-queued-handoff",
      "compact-queued-inline-mismatch",
      "compact-queued-reference-mismatch",
      "compact-queued-user-role",
      "compact-queued-user-attribution",
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
