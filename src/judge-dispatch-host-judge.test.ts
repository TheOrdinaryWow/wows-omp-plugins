import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TaskTool as NativeTaskTool } from "@oh-my-pi/pi-coding-agent/task";

const PACKAGE_NAME = "wows-omp-plugin-judge-dispatch";
const CHILD_SCENARIO_ENV = "JUDGE_DISPATCH_HOST_JUDGE_SCENARIO";
const CHILD_OUTPUT_MARKER = "JUDGE_DISPATCH_HOST_JUDGE_RESULT:";
const THIS_FILE = fileURLToPath(import.meta.url);
const PLUGIN_URL = pathToFileURL(join(dirname(THIS_FILE), "../plugins/judge-dispatch/src/judge-dispatch.ts")).href;
const HOST_KEY = ["host", "typesafe", "key"].join("-");

/** One hook-level action, replayed in order after a session's other fields; each pushes one entry to `steps`. */
type HookStep =
  | { call: Record<string, unknown>; id: string; validate?: boolean; direct?: boolean; nameFrom?: string; captureInput?: boolean }
  | { executeDirect: Record<string, unknown>; id: string }
  | { assistant: { id: string; args: Record<string, unknown> }[] }
  | { end: string; result: Record<string, unknown>; isError?: boolean }
  | { update: string; result: Record<string, unknown> }
  /**
   * The spawn key comes from `spawn.spawnKey`, or is allocated through a real session-scoped AgentOutputManager
   * as background task jobs do: for the literal `allocate` name, or for item `item` of call `from` as dispatched.
   */
  | { spawn: Record<string, unknown>; allocate?: string; from?: string; item?: number }
  /** Registers a real host job that stays running until a later `finish` step. */
  | { job: string; owner?: string }
  | { finish: string; output: string; failed?: boolean; expire?: boolean }
  /** Appends entries to the active branch. */
  | { branch: unknown[] };

interface SessionSpec {
  project: string;
  calls: number;
  description?: string;
  parentSpawns?: string;
  disabledAgents?: string[];
  maxDepth?: number;
  batch?: boolean;
  inputs?: Record<string, unknown>[];
  branch?: unknown[];
  spawns?: Record<string, unknown>[];
  steps?: HookStep[];
  costGate?: { cap: number; spent: number };
  jobRetention?: number;
  toolCallTimeoutMs?: number;
}

interface ChildScenario {
  sessions: SessionSpec[];
  response: "success" | "unauthorized" | "network-error";
  agentChoice?: string;
  /** The difficulty the stub judge answers; the hardest offered by default. */
  difficultyChoice?: string;
  difficultyConfidence?: number;
  hostKey?: string;
  explicitRole?: boolean;
  disabledProviders?: string[];
  /** `task.agentModelOverrides` entries. */
  agentModels?: Record<string, string[]>;
  maxEffort?: string;
  slowAssignment?: string;
}

interface RecordedRequest {
  authorization: string | null;
  body: string;
}

/** Results cross a JSON boundary, so a fail-open `undefined` arrives as `null`. */
interface SessionReport {
  results: unknown[];
  warnings: unknown[];
  notifications: { message: unknown; level?: unknown }[];
  usage: unknown[];
  /** Working-message calls in order; a restore (`undefined`) arrives as `null`. */
  working: unknown[];
  /** Custom message types that remain after the plugin's `context` hook, given a legacy route record plus one ordinary message. */
  modelView: unknown[];
  spawnResults: unknown[];
  steps: unknown[];
  costSpent?: number;
}

interface ChildReport {
  requests: RecordedRequest[];
  sessions: SessionReport[];
}

type TestHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

/** Bundled OMP agents, so candidate discovery finds real definitions for both names. */
const TASK_DESCRIPTION = "# Available Agents\n### scout\nRead-only investigator\n### task\nGeneral-purpose agent";

function startTypeSafeServer(scenario: ChildScenario, requests: RecordedRequest[]): { origin: string; stop(): void } {
  if (scenario.response === "network-error") return { origin: "http://127.0.0.1:1", stop() {} };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/systemone") return new Response(null, { status: 404 });
      const body = await request.text();
      requests.push({ authorization: request.headers.get("authorization"), body });
      if (scenario.response === "unauthorized") return new Response("invalid api key", { status: 401 });
      if (scenario.slowAssignment && body.includes(scenario.slowAssignment)) return Promise.withResolvers<Response>().promise;

      // Controlled native answer; only offer the named choice when it is legal.
      const payload = JSON.parse(body) as { questions?: Record<string, { criteria?: Record<string, unknown> }> };
      const answers = Object.fromEntries(
        Object.entries(payload.questions ?? {}).map(([id, question]) => {
          const choices = Object.keys(question.criteria ?? {});
          const choice =
            (id === "agent"
              ? choices.find((name) => name === (scenario.agentChoice ?? "scout"))
              : (choices.find((name) => name === scenario.difficultyChoice) ?? choices.at(-1))) ??
            choices[0] ??
            "";
          return [
            id,
            {
              type: "choice",
              choice,
              probabilities: Object.fromEntries(choices.map((name) => [name, name === choice ? 1 : 0])),
              confidence: id === "difficulty" ? (scenario.difficultyConfidence ?? 0.99) : 0.99,
            },
          ];
        }),
      );
      return Response.json({
        model: "system-one",
        answers,
        usage: { input_tokens: 17, output_tokens: 3 },
      });
    },
  });
  return { origin: server.url.origin, stop: () => server.stop(true) };
}

async function executeChildScenario(scenario: ChildScenario): Promise<ChildReport> {
  const requests: RecordedRequest[] = [];
  const server = startTypeSafeServer(scenario, requests);
  try {
    if (scenario.hostKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = scenario.hostKey;
    if (scenario.agentModels || scenario.explicitRole) process.env.OPENAI_API_KEY = "fixture-openai-key";

    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "models.yml"), `providers:\n  typesafe:\n    baseUrl: ${server.origin}\n`);

    // The child runs outside the test runner with its own HOME, so host modules load only after isolation is in place.
    const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
    const { Settings, withActiveSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent/sdk");
    const { cfgDisabledProviders, cfgModelRoles } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
    const { cfgRetryFallbackChains, cfgSessionMaxCost } = await import("@oh-my-pi/pi-coding-agent/session/settings");
    const { CostGate } = await import("@oh-my-pi/pi-coding-agent/session/cost-gate");
    const { AgentOutputManager } = await import("@oh-my-pi/pi-coding-agent/task/output-manager");
    const { TaskTool } = await import("@oh-my-pi/pi-coding-agent/task");
    const { ModelMentionRegistry } = await import("@oh-my-pi/pi-coding-agent/session/model-mentions");
    const {
      cfgTaskAgentModelOverrides,
      cfgTaskBatch,
      cfgTaskDisabledAgents,
      cfgTaskMaxEffort,
      cfgTaskMaxRecursionDepth,
      cfgTaskPerCallModel,
    } = await import("@oh-my-pi/pi-coding-agent/task/settings");
    const { cfgToolsApprovalMode } = await import("@oh-my-pi/pi-coding-agent/tools/settings");
    const { ExtensionToolWrapper } = await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper");
    const { cfgExtensionHandlersToolCallTimeoutMs } = await import("@oh-my-pi/pi-coding-agent/extensibility/settings");
    const { AsyncJobManager } = await import("@oh-my-pi/pi-coding-agent/async/job-manager");
    const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
    // This runtime-selected absolute URL keeps the child fixture on the same plugin source as the parent checkout.
    const { default: registerJudgeDispatch } = await import(PLUGIN_URL);

    const sessionReports: SessionReport[] = [];
    for (const [sessionIndex, session] of scenario.sessions.entries()) {
      const settings = await Settings.loadIsolated({ cwd: session.project, agentDir });
      if (session.batch !== undefined) cfgTaskBatch.override(settings, session.batch);
      if (session.disabledAgents) cfgTaskDisabledAgents.override(settings, session.disabledAgents);
      if (session.maxDepth !== undefined) cfgTaskMaxRecursionDepth.override(settings, session.maxDepth);
      if (session.toolCallTimeoutMs !== undefined) cfgExtensionHandlersToolCallTimeoutMs.override(settings, session.toolCallTimeoutMs);
      if (scenario.explicitRole) {
        cfgModelRoles.override(settings, { abliterated: "openai/gpt-5-mini", task: "openai/gpt-5" });
        cfgRetryFallbackChains.override(settings, {
          abliterated: ["openai/gpt-5"],
          task: ["openai/gpt-5-mini"],
        });
      }
      if (scenario.disabledProviders) cfgDisabledProviders.override(settings, scenario.disabledProviders);
      if (scenario.agentModels) cfgTaskAgentModelOverrides.override(settings, scenario.agentModels);
      if (scenario.maxEffort) cfgTaskMaxEffort.override(settings, scenario.maxEffort as never);
      if (session.costGate) cfgSessionMaxCost.override(settings, session.costGate.cap);
      const costGate = session.costGate ? new CostGate(settings, session.costGate.spent, () => {}) : undefined;
      const registry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"), { settings });
      const handlers = new Map<string, TestHandler[]>();
      const report: SessionReport = {
        results: [],
        warnings: [],
        notifications: [],
        usage: [],
        working: [],
        modelView: [],
        spawnResults: [],
        steps: [],
      };
      let branch: unknown[] = [...(session.branch ?? [])];
      let taskTool: NativeTaskTool | undefined;

      const api = {
        logger: {
          warn(message: unknown, details?: unknown) {
            report.warnings.push(details === undefined ? message : [message, details]);
          },
        },
        on(event: string, handler: TestHandler) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        getAllTools: () => [
          { name: "task", description: session.description ?? taskTool?.description ?? TASK_DESCRIPTION, parameters: taskTool?.parameters },
        ],
        registerMessageRenderer() {},
      } as unknown as ExtensionAPI;

      const context = {
        cwd: session.project,
        ui: {
          notify(message: unknown, level?: unknown) {
            report.notifications.push({ message, level });
          },
          setWorkingMessage(message?: unknown) {
            report.working.push(message ?? null);
          },
        },
        sessionManager: {
          getSessionId: () => `host-judge-session-${sessionIndex}`,
          getBranch: () => branch,
          getLeafId: () => `host-judge-leaf-${sessionIndex}`,
          appendModelUsage(entry: unknown) {
            report.usage.push(entry);
          },
        },
        modelRegistry: registry,
      } as unknown as ExtensionContext;

      const modelMentions = new ModelMentionRegistry({
        sessionManager: context.sessionManager as SessionManager,
        modelRegistry: registry,
        scopedModels: () => [],
      });
      modelMentions.syncFromBranch();
      const getSessionAgents = () => modelMentions.sessionAgents();
      if (session.parentSpawns !== undefined) {
        taskTool = await TaskTool.create({
          cwd: session.project,
          hasUI: false,
          getSessionFile: () => null,
          settings,
          getSessionSpawns: () => session.parentSpawns ?? "*",
          getSessionAgents,
          modelRegistry: registry,
        });
      }
      const jobs = new AsyncJobManager({ onJobComplete() {}, retentionMs: session.jobRetention });
      const jobOutcomes = new Map<string, PromiseWithResolvers<string>>();
      const ownerId = `fixture-parent-${sessionIndex}`;
      jobs.registerDeliverySink(ownerId, () => {});
      if (session.parentSpawns !== undefined || costGate || session.steps?.some((step) => "job" in step)) {
        AgentRegistry.global().register({
          id: ownerId,
          displayName: ownerId,
          kind: "main",
          session: {
            sessionManager: context.sessionManager,
            asyncJobManager: jobs,
            costGate,
            getSessionAgents,
          } as unknown as AgentSession,
        });
      }

      const onlyHandler = (event: string): TestHandler => {
        const registered = handlers.get(event) ?? [];
        if (registered.length !== 1) throw new Error(`expected one ${event} handler, received ${registered.length}`);
        return (payload, ctx) => withActiveSettings(settings, () => (registered[0] as TestHandler)(payload, ctx));
      };

      registerJudgeDispatch(api);

      const interceptCall = async (id: string, args: Record<string, unknown>, nativeTool?: NativeTaskTool, direct = false) => {
        const call = { type: "toolCall" as const, id, name: "task", arguments: args };
        if (!direct && handlers.has("assistant_message")) {
          await onlyHandler("assistant_message")({ type: "assistant_message", message: { content: [structuredClone(call)] } }, context);
        }
        const input = nativeTool ? validateToolArguments(nativeTool, call) : args;
        const result = await onlyHandler("tool_call")({ type: "tool_call", toolCallId: id, toolName: "task", input }, context);
        return { input, result };
      };

      for (let call = 0; call < session.calls; call += 1) {
        const input = session.inputs?.[call] ?? { task: "Implement the requested repository change", agent: "task" };
        const { result } = await interceptCall(`host-judge-tool-${sessionIndex}-${call}`, input);
        report.results.push(result);
      }
      for (const spawn of session.spawns ?? []) {
        report.spawnResults.push(
          await onlyHandler("before_subagent_spawn")({ type: "before_subagent_spawn", invocationKind: "task", ...spawn }, context),
        );
      }
      const outputManager = new AgentOutputManager(() => null);
      // Item names each call step dispatched after the plugin's rewrite, for spawn steps that follow it.
      const dispatchedNames = new Map<string, unknown[]>();
      for (const step of session.steps ?? []) {
        if ("call" in step) {
          const name = step.nameFrom === undefined ? undefined : dispatchedNames.get(step.nameFrom)?.[0];
          if (step.nameFrom !== undefined && typeof name !== "string") throw new Error(`call ${step.nameFrom} dispatched no name`);
          const args = typeof name === "string" ? { ...step.call, name } : step.call;
          if (step.validate && !taskTool) throw new Error("validation requires a native task tool");
          const { input, result } = await interceptCall(step.id, args, step.validate ? taskTool : undefined, step.direct);
          const sent =
            result && typeof result === "object" && "input" in result && result.input && typeof result.input === "object"
              ? result.input
              : input;
          const items: unknown[] = "tasks" in sent && Array.isArray(sent.tasks) ? sent.tasks : [sent];
          dispatchedNames.set(
            step.id,
            items.map((item) => (item && typeof item === "object" && "name" in item ? item.name : undefined)),
          );
          report.steps.push(step.captureInput ? sent : result);
        } else if ("executeDirect" in step) {
          if (!taskTool) throw new Error("direct execution requires a native task tool");
          cfgTaskPerCallModel.override(settings, "off");
          cfgToolsApprovalMode.override(settings, "yolo");
          const runner = {
            cwd: session.project,
            sessionSettings: settings,
            sessionId: context.sessionManager.getSessionId(),
            consumeToolCallEmitted: () => false,
            hasHandlers: (event: string) => handlers.has(event),
            emitToolCall: (event: Record<string, unknown>) => onlyHandler("tool_call")(event, context),
            runScoped: <T>(execute: () => T) => withActiveSettings(settings, execute),
          } as unknown as ConstructorParameters<typeof ExtensionToolWrapper>[1];
          const wrapper = new ExtensionToolWrapper(
            {
              name: taskTool.name,
              label: taskTool.label,
              description: taskTool.description,
              parameters: taskTool.parameters,
              execute: taskTool.execute.bind(taskTool),
            },
            runner,
          );
          const result = await wrapper.execute(step.id, step.executeDirect);
          report.steps.push(result);
        } else if ("assistant" in step) {
          if (handlers.has("assistant_message")) {
            const content = step.assistant.map(({ id, args }) => ({ type: "toolCall", name: "task", id, arguments: args }));
            await onlyHandler("assistant_message")({ type: "assistant_message", message: { content } }, context);
          }
          report.steps.push(null);
        } else if ("end" in step) {
          const end = {
            type: "tool_execution_end",
            toolCallId: step.end,
            toolName: "task",
            result: step.result,
            isError: step.isError ?? false,
          };
          report.steps.push(await onlyHandler("tool_execution_end")(end, context));
        } else if ("update" in step) {
          const update = { type: "tool_execution_update", toolCallId: step.update, toolName: "task", partialResult: step.result };
          report.steps.push(handlers.has(update.type) ? await onlyHandler(update.type)(update, context) : null);
        } else if ("spawn" in step) {
          const dispatched = step.from === undefined ? undefined : dispatchedNames.get(step.from)?.[step.item ?? 0];
          if (step.from !== undefined && typeof dispatched !== "string") throw new Error(`call ${step.from} dispatched no item name`);
          const allocated = step.allocate ?? (typeof dispatched === "string" ? dispatched.trim() : undefined);
          const spawnKey = allocated === undefined ? step.spawn.spawnKey : await outputManager.allocate(allocated);
          const result = await onlyHandler("before_subagent_spawn")(
            { type: "before_subagent_spawn", invocationKind: "task", ...step.spawn, spawnKey },
            context,
          );
          report.steps.push({ spawnKey, result: result ?? null });
        } else if ("job" in step) {
          const outcome = Promise.withResolvers<string>();
          const jobId = jobs.register("task", step.job, () => outcome.promise, {
            id: step.job,
            agentId: step.job,
            ownerId: step.owner ?? ownerId,
          });
          jobOutcomes.set(jobId, outcome);
          report.steps.push(null);
        } else if ("finish" in step) {
          const outcome = jobOutcomes.get(step.finish);
          if (!outcome) throw new Error(`no background job ${step.finish}`);
          if (step.failed) outcome.reject(new Error(step.output));
          else outcome.resolve(step.output);
          await jobs.getJob(step.finish)?.promise;
          if (step.expire && jobs.getJob(step.finish)) {
            const expired = Promise.withResolvers<void>();
            const unsubscribe = jobs.onJobsChanged(() => {
              if (!jobs.getJob(step.finish)) expired.resolve();
            });
            await expired.promise.finally(unsubscribe);
          }
          report.steps.push(null);
        } else {
          branch = [...branch, ...step.branch];
          report.steps.push(null);
        }
      }
      const filtered = (await onlyHandler("context")(
        {
          type: "context",
          messages: [
            { role: "custom", customType: "other-plugin.note", content: "kept" },
            { role: "custom", customType: "wows-omp-judge-dispatch.route", content: "judge-dispatch  task → scout (0.99)" },
          ],
        },
        context,
      )) as { messages: { customType?: string }[] };
      report.modelView = filtered.messages.map((message) => message.customType);
      if (costGate) report.costSpent = costGate.spent;
      AgentRegistry.global().unregister(ownerId);
      await jobs.dispose();
      sessionReports.push(report);
    }

    return { requests, sessions: sessionReports };
  } finally {
    server.stop();
  }
}

async function createProject(settings: Record<string, unknown>): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "judge-dispatch-host-judge-"));
  const configDirectory = join(project, ".omp");
  await mkdir(configDirectory, { recursive: true });
  await Bun.write(join(configDirectory, "plugin-overrides.json"), JSON.stringify({ settings: { [PACKAGE_NAME]: settings } }));
  return project;
}

async function withProjects<T>(settings: Record<string, unknown>[], run: (projects: string[]) => Promise<T>): Promise<T> {
  const projects: string[] = [];
  try {
    for (const projectSettings of settings) projects.push(await createProject(projectSettings));
    return await run(projects);
  } finally {
    await Promise.all(projects.map((project) => rm(project, { recursive: true, force: true })));
  }
}

async function runIsolatedScenario(scenario: ChildScenario): Promise<ChildReport> {
  const isolationRoot = scenario.sessions[0]?.project;
  if (!isolationRoot) throw new Error("host judge scenario requires at least one session");

  const child = Bun.spawn({
    cmd: [process.execPath, THIS_FILE],
    cwd: isolationRoot,
    env: {
      HOME: isolationRoot,
      XDG_CACHE_HOME: join(isolationRoot, ".xdg-cache"),
      XDG_CONFIG_HOME: join(isolationRoot, ".xdg-config"),
      XDG_DATA_HOME: join(isolationRoot, ".xdg-data"),
      XDG_STATE_HOME: join(isolationRoot, ".xdg-state"),
      PI_CODING_AGENT_DIR: join(isolationRoot, ".agent"),
      NO_COLOR: "1",
      [CHILD_SCENARIO_ENV]: JSON.stringify(scenario),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`isolated host judge fixture exited ${exitCode}\n${stderr}\n${stdout}`);

  const resultLine = stdout.split("\n").find((line) => line.startsWith(CHILD_OUTPUT_MARKER));
  if (!resultLine) throw new Error(`isolated host judge fixture returned no result\n${stderr}\n${stdout}`);
  return JSON.parse(resultLine.slice(CHILD_OUTPUT_MARKER.length)) as ChildReport;
}

function diagnostics(report: ChildReport): string {
  return JSON.stringify({ sessions: report.sessions, bodies: report.requests.map(({ body }) => body) });
}

async function registerTests(): Promise<void> {
  // The child fixture executes this file outside Bun's test runner, so only the parent branch may load bun:test.
  const { describe, expect, setDefaultTimeout, test } = await import("bun:test");
  // Every test boots a real host in a child process; the 5s default is too tight when the suite runs in parallel.
  setDefaultTimeout(30_000);
  const reviewTask = (name: string, agent: string) => ({ task: `Review ${name}`, agent, name });
  const taskSpawn = { agent: "task", modelRole: "task", patterns: ["openai/gpt-5"] };

  describe.serial("judge-dispatch through the host judge role", () => {
    test("a native judge that is not Jev routes task calls and journals usage", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "success",
          hostKey: HOST_KEY,
        });

        expect(report.requests.map((request) => request.authorization)).toEqual([`Bearer ${HOST_KEY}`]);
        expect(report.sessions[0]?.results).toEqual([{ input: { task: "Implement the requested repository change", agent: "scout" } }]);
        expect(report.sessions[0]?.usage).toEqual([expect.objectContaining({ purpose: "judge-dispatch" })]);
        expect(report.sessions[0]?.notifications).toEqual([{ message: "judge-dispatch  task → scout (0.99)", level: "info" }]);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });

    test("routing judgments honor the local session cost gate and still journal allowed usage", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: project as string, calls: 1, costGate: { cap: 1, spent: 1 } },
            { project: project as string, calls: 1, costGate: { cap: 1, spent: 0 } },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        expect(report.requests).toHaveLength(1);
        expect(report.sessions[0]?.results, diagnostics(report)).toEqual([null]);
        expect(report.sessions[0]?.usage).toEqual([]);
        expect(report.sessions[0]?.costSpent).toBe(1);
        expect(report.sessions[1]?.results).toEqual([{ input: { task: "Implement the requested repository change", agent: "scout" } }]);
        expect(report.sessions[1]?.usage).toEqual([expect.objectContaining({ purpose: "judge-dispatch" })]);
        const billed = report.sessions[1]?.usage[0] as { usage: { cost: { total: number } } };
        expect(report.sessions[1]?.costSpent).toBe(billed.usage.cost.total);
      });
    });

    test("a steps batch item is routed beside its inline sibling", async () => {
      const staged = { name: "Staged", agent: "task", steps: ["Read the module", "Change it"] };
      const inline = reviewTask("Inline", "task");
      const input = { context: "shared", tasks: [staged, inline] };
      const scoutSpawn = { agent: "scout", patterns: ["openai/gpt-5"] };
      const raised = { model: ["openai/gpt-5:high"], note: "judge-dispatch demanding task: thinking medium → high" };
      await withProjects([{ judgeEffort: true }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: input, id: "mixed" },
                { spawn: scoutSpawn, from: "mixed", item: 0 },
                { spawn: scoutSpawn, from: "mixed", item: 1 },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          {
            input: {
              ...input,
              tasks: [
                { ...staged, agent: "scout" },
                { ...inline, agent: "scout" },
              ],
            },
          },
          { spawnKey: "Staged", result: raised },
          { spawnKey: "Inline", result: raised },
        ]);
        expect(report.requests.map((request) => JSON.parse(request.body ?? "{}").state.assignment)).toEqual([
          "1. Read the module\n2. Change it",
          inline.task,
        ]);
      });
    });

    test("native item models keep their agent, exact selector and effort without tiers or thinking steps", async () => {
      const native = { ...reviewTask("Native", "task"), model: " openai/gpt-5:low " };
      const effort = { ...reviewTask("Effort", "task"), model: "openai/gpt-5:high", effort: "lo" };
      const inline = reviewTask("Inline", "task");
      const batch = { context: "shared", tasks: [native, effort, inline] };
      await withProjects([{ judgeEffort: true, modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: native, id: "flat" },
                { spawn: { ...taskSpawn, patterns: ["openai/gpt-5:low"] }, from: "flat" },
                { call: batch, id: "batch" },
                { spawn: { ...taskSpawn, patterns: ["openai/gpt-5:low"] }, from: "batch", item: 0 },
                { spawn: { ...taskSpawn, patterns: ["openai/gpt-5:high"] }, from: "batch", item: 1 },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "batch", item: 2 },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          null,
          { spawnKey: "Native", result: null },
          { input: { ...batch, tasks: [native, effort, { ...inline, agent: "scout" }] } },
          { spawnKey: "Native-2", result: null },
          { spawnKey: "Effort", result: null },
          {
            spawnKey: "Inline",
            result: { model: ["openai/gpt-5-mini", "openai/gpt-5"], note: "judge-dispatch demanding tier @abliterated" },
          },
        ]);
        expect(report.requests).toHaveLength(1);
      });
    });

    test("native models cannot inherit a same-named pending tier from another dispatch", async () => {
      const routed = reviewTask("Shared", "task");
      const native = { ...routed, model: "openai/gpt-5" };
      await withProjects([{ routeAgent: false, judgeEffort: true, modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: routed, id: "routed" },
                { call: native, id: "native" },
                { spawn: taskSpawn, from: "native" },
                { spawn: taskSpawn, from: "routed" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          null,
          null,
          { spawnKey: "Shared", result: null },
          { spawnKey: "Shared-2", result: null },
        ]);
        expect(report.requests).toHaveLength(1);
      });
    });

    test("a call with an unresolved default still counts toward overlapping name ambiguity", async () => {
      await withProjects([{ routeAgent: false, modelTiers: "demanding=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const input = reviewTask("Shared", "task");
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              steps: [
                { call: { name: input.name, task: input.task }, id: "skipped", direct: true },
                { call: input, id: "routed" },
                { spawn: taskSpawn, from: "routed" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([null, null, { spawnKey: "Shared", result: null }]);
        expect(report.requests).toHaveLength(1);
      });
    });

    test("a direct SDK rejection without an execution-end event leaves the same name ambiguous", async () => {
      await withProjects([{ routeAgent: false, modelTiers: "demanding=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const input = reviewTask("Shared", "task");
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              batch: true,
              parentSpawns: "task,scout",
              steps: [
                {
                  executeDirect: {
                    context: "Independent tasks",
                    tasks: [input, { ...reviewTask("Native", "scout"), model: "openai/gpt-5" }],
                  },
                  id: "rejected",
                },
                { call: input, id: "routed", direct: true },
                { spawn: taskSpawn, from: "routed" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          expect.objectContaining({
            isError: true,
            content: [expect.objectContaining({ text: expect.stringContaining("Per-call model is disabled for task calls") })],
            details: expect.objectContaining({ results: [] }),
          }),
          null,
          { spawnKey: "Shared", result: null },
        ]);
        expect(report.requests).toHaveLength(2);
      });
    });

    test("a dispatch that times out cannot borrow a pending same-name tier", async () => {
      await withProjects([{ routeAgent: false, modelTiers: "demanding=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const input = reviewTask("Shared", "task");
        const slowAssignment = "Wait for the slow judge";
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              toolCallTimeoutMs: 1_800,
              steps: [
                { call: input, id: "pending" },
                { call: { ...input, task: slowAssignment }, id: "timed-out" },
                { spawn: taskSpawn, from: "timed-out" },
                { spawn: taskSpawn, from: "pending" },
                { end: "timed-out", result: {} },
                { end: "pending", result: {} },
                { call: input, id: "clear" },
                { spawn: taskSpawn, from: "clear" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"] },
          slowAssignment,
        });
        const session = report.sessions[0];
        expect(
          session?.notifications.some(({ message }) => String(message).includes("routing timed out")),
          diagnostics(report),
        ).toBe(true);
        expect(session?.steps.slice(2, 4), diagnostics(report)).toEqual([
          { spawnKey: "Shared", result: null },
          { spawnKey: "Shared-2", result: null },
        ]);
        expect(session?.steps.at(-1)).toEqual({
          spawnKey: "Shared-3",
          result: expect.objectContaining({ note: "judge-dispatch demanding tier @abliterated" }),
        });
      });
    });

    test("evicting a pending spawn disables overrides for that session", async () => {
      await withProjects([{ routeAgent: false, modelTiers: "task.demanding=@abliterated", judgeEffort: true }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const input = reviewTask("Shared", "task");
        const unnamed = {
          context: "Independent reviews",
          tasks: [
            { task: "Review with a model tier", agent: "task" },
            { task: "Review with a thinking step", agent: "scout" },
          ],
        };
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              steps: [
                { call: input, id: "oldest" },
                { call: reviewTask("Recent", "task"), id: "recent" },
                ...Array.from({ length: 254 }, (_, index) => ({
                  call: { ...reviewTask(`Filler${index}`, "scout"), model: "openai/gpt-5" },
                  id: `filler-${index}`,
                })),
                { call: input, id: "routed" },
                { spawn: taskSpawn, from: "oldest" },
                { end: "oldest", result: {} },
                { spawn: taskSpawn, from: "routed" },
                { spawn: taskSpawn, from: "recent" },
                { end: "routed", result: {} },
                { call: input, id: "after-completion" },
                { spawn: taskSpawn, from: "after-completion" },
                { call: unnamed, id: "unnamed-after-eviction", captureInput: true },
              ],
            },
            {
              project,
              calls: 0,
              steps: [
                { call: input, id: "fresh" },
                { spawn: taskSpawn, from: "fresh" },
                { call: unnamed, id: "unnamed-fresh" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5:medium"] },
        });
        const [evicted, fresh] = report.sessions;
        expect(evicted?.steps.slice(-8, -1)).toEqual([
          { spawnKey: "Shared", result: null },
          null,
          { spawnKey: "Shared-2", result: null },
          { spawnKey: "Recent", result: null },
          null,
          null,
          { spawnKey: "Shared-3", result: null },
        ]);
        expect(fresh?.steps.at(-2)).toEqual({
          spawnKey: "Shared",
          result: expect.objectContaining({ note: "judge-dispatch demanding tier @abliterated" }),
        });
        expect(fresh?.steps.at(-1)).toEqual({
          input: {
            context: unnamed.context,
            tasks: [
              { ...unnamed.tasks[0], name: expect.stringMatching(/^task-[0-9a-f]{8}$/) },
              { ...unnamed.tasks[1], name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) },
            ],
          },
        });
        expect(fresh?.notifications.at(-1)?.message).toBe(
          "judge-dispatch  #1 task · model openai/gpt-5 → @abliterated (0.99) ; #2 scout · thinking medium → high (0.99)",
        );
        expect({ notice: evicted?.notifications.at(-1)?.message, input: evicted?.steps.at(-1) }).toEqual({
          notice: "judge-dispatch  #1 task · difficulty demanding (0.99) ; #2 scout · difficulty demanding (0.99)",
          input: unnamed,
        });
        expect(report.requests).toHaveLength(9);
      });
    });

    test("shows a status line for every routed call and keeps legacy route records from the model", async () => {
      await withProjects([{ judgeEffort: true }, { judgeEffort: true, indicator: false }], async ([shown, hidden]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: shown as string, calls: 1 },
            { project: hidden as string, calls: 1 },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        const rewritten = { input: { task: "Implement the requested repository change", agent: "scout" } };
        const [visible, silent] = report.sessions;

        expect(visible?.results).toEqual([rewritten]);
        expect(visible?.working).toEqual(["judge-dispatch: routing 1 task…", null]);
        expect(visible?.notifications).toEqual([
          { message: "judge-dispatch  task → scout (0.99) · difficulty demanding (0.99)", level: "info" },
        ]);
        expect(visible?.modelView).toEqual(["other-plugin.note"]);

        expect(silent?.results).toEqual([rewritten]);
        expect(silent?.working).toEqual([]);
        expect(silent?.notifications).toEqual([]);
      });

      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "success",
          agentChoice: "task",
          hostKey: HOST_KEY,
        });
        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[0]?.working).toEqual(["judge-dispatch: routing 1 task…", null]);
        expect(report.sessions[0]?.notifications).toEqual([{ message: "judge-dispatch  task kept (0.99)", level: "info" }]);
      });
    });

    test("judgeEffort adds the difficulty question but never writes task effort", async () => {
      await withProjects([{}, { judgeEffort: true }], async ([plain, effort]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: plain as string, calls: 1 },
            { project: effort as string, calls: 1 },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });

        const askedQuestions = report.requests.map((request) => Object.keys(JSON.parse(request.body).questions ?? {}));
        expect(askedQuestions).toEqual([["agent"], ["agent", "difficulty"]]);
        expect(report.sessions[1]?.results).toEqual([{ input: { task: "Implement the requested repository change", agent: "scout" } }]);
      });
    });

    test("the caller's solutionSpace reaches the judgment for flat calls and batch items", async () => {
      await withProjects([{ judgeEffort: true }], async ([project]) => {
        const inputs = [
          { task: "Fix the flaky test", agent: "task", solutionSpace: "cause open, no repro" },
          {
            context: "Shared release constraints",
            tasks: [
              { task: "Rename the helper", agent: "task", solutionSpace: "one fix: rename, names given" },
              { task: "Sketch the migration", agent: "task" },
            ],
          },
        ];
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: inputs.length, inputs }],
          response: "success",
          hostKey: HOST_KEY,
        });
        // Batch items are judged concurrently, so their requests may arrive in either order.
        const bodies = new Map(
          report.requests.map((request) => {
            const body = JSON.parse(request.body) as {
              state: { assignment: string; solutionSpace?: string };
              questions: { difficulty?: { instructions?: string } };
            };
            return [body.state.assignment, body] as const;
          }),
        );
        expect(report.requests).toHaveLength(3);
        expect(bodies.get("Fix the flaky test")?.state.solutionSpace).toBe("cause open, no repro");
        expect(bodies.get("Rename the helper")?.state.solutionSpace).toBe("one fix: rename, names given");
        expect(bodies.get("Sketch the migration")?.state).not.toHaveProperty("solutionSpace");
        expect(bodies.get("Fix the flaky test")?.questions.difficulty?.instructions).toContain("solutionSpace");
      });
    });

    test("judgeEffort steps the spawn's thinking level from the level its agent would use", async () => {
      const named = (name: string, extra: Record<string, unknown> = {}) => ({
        task: `Implement ${name}`,
        agent: "task",
        name,
        ...extra,
      });
      const scoutSpawn = { agent: "scout", patterns: ["openai/gpt-5"] };
      await withProjects([{ judgeEffort: true }], async ([project]) => {
        // scout runs at its frontmatter level (medium); the task agent's selector carries its own level.
        const routed = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: named("Deep"), id: "deep" },
                { spawn: scoutSpawn, from: "deep" },
                { call: named("Moved"), id: "moved" },
                { spawn: { ...scoutSpawn, patterns: ["openai/gpt-5-mini"] }, from: "moved" },
                { call: named("Chosen", { effort: "lo" }), id: "chosen" },
                { spawn: scoutSpawn, from: "chosen" },
                { call: { task: "Implement Unnamed", agent: "task" }, id: "unnamed" },
                { spawn: scoutSpawn, from: "unnamed" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          agentModels: { scout: ["openai/gpt-5"], task: ["openai/gpt-5:low"] },
        });
        const step = { model: ["openai/gpt-5:high"], note: "judge-dispatch demanding task: thinking medium → high" };
        expect(routed.sessions[0]?.steps, diagnostics(routed)).toEqual([
          { input: { ...named("Deep"), agent: "scout" } },
          { spawnKey: "Deep", result: step },
          { input: { ...named("Moved"), agent: "scout" } },
          { spawnKey: "Moved", result: null },
          { input: { ...named("Chosen", { effort: "lo" }), agent: "scout" } },
          { spawnKey: "Chosen", result: null },
          { input: { task: "Implement Unnamed", agent: "scout", name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) } },
          { spawnKey: expect.stringMatching(/^scout-[0-9a-f]{8}$/), result: step },
        ]);
        expect(routed.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · thinking medium → high (0.99)",
          "judge-dispatch  task → scout (0.99) · thinking medium → high (0.99)",
          // An explicit effort leaves nothing for a difficulty to change, so none is asked.
          "judge-dispatch  task → scout (0.99)",
          "judge-dispatch  task → scout (0.99) · thinking medium → high (0.99)",
        ]);

        const kept = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 1,
              inputs: [named("Own")],
              spawns: [{ agent: "task", spawnKey: "Own", patterns: ["gpt-5:low", "openai/gpt-5-mini"] }],
            },
          ],
          response: "success",
          agentChoice: "task",
          hostKey: HOST_KEY,
          agentModels: { scout: ["openai/gpt-5"], task: ["openai/gpt-5:low"] },
        });
        expect(kept.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task kept (0.99) · thinking low → medium (0.99)",
        ]);
        expect(kept.sessions[0]?.spawnResults).toEqual([
          { model: ["gpt-5:medium", "openai/gpt-5-mini"], note: "judge-dispatch demanding task: thinking low → medium" },
        ]);

        // The task agent's own level is auto, and task.maxEffort caps read-only scout at the level it already has.
        const untouched = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 2, inputs: [named("Auto"), named("Capped", { agent: "scout" })] }],
          response: "success",
          agentChoice: "task",
          hostKey: HOST_KEY,
          agentModels: { scout: ["openai/gpt-5"], task: ["openai/gpt-5"] },
          maxEffort: "medium",
        });
        expect(untouched.sessions[0]?.results).toEqual([null, null]);
        expect(untouched.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task kept (0.99) · difficulty demanding (0.99)",
          "judge-dispatch  scout · difficulty demanding (0.99)",
        ]);
      });
    });

    test("model tiers swap the spawn model by difficulty, an agent's own tier first, and fail open", async () => {
      const tierSpawn = { model: ["openai/gpt-5-mini", "openai/gpt-5"], note: "judge-dispatch demanding tier @abliterated" };
      const projects = [
        { judgeEffort: true, modelTiers: "demanding=@task,scout.demanding=@abliterated" },
        { modelTiers: "demanding=@missing-role" },
        { modelTiers: "scout.demanding=@abliterated", minimumConfidence: 0.995 },
      ];
      await withProjects(projects, async ([agentTier, missing, unsure]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: agentTier as string,
              calls: 0,
              steps: [
                { call: reviewTask("Tiered", "task"), id: "tiered" },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "tiered" },
              ],
            },
            { project: missing as string, calls: 1, inputs: [reviewTask("Missing", "task")] },
            { project: unsure as string, calls: 1, inputs: [reviewTask("Unsure", "task")] },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { scout: ["openai/gpt-5"], task: ["openai/gpt-5"] },
        });
        const [tiered, failOpen, lowConfidence] = report.sessions;
        expect(tiered?.steps, diagnostics(report)).toEqual([
          { input: { ...reviewTask("Tiered", "task"), agent: "scout" } },
          { spawnKey: "Tiered", result: tierSpawn },
        ]);
        expect(tiered?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
        expect(failOpen?.results).toEqual([{ input: { ...reviewTask("Missing", "task"), agent: "scout" } }]);
        expect(failOpen?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 kept (tier @missing-role: unknown model role missing-role) · difficulty demanding (0.99)",
        ]);
        expect(lowConfidence?.results).toEqual([null]);
        expect(lowConfidence?.notifications.map((notice) => notice.message)).toEqual(["judge-dispatch  task kept (no confident choice)"]);
      });
    });

    test("an agent-specific tier asks difficulty only after the final agent can use it", async () => {
      await withProjects([{ modelTiers: "scout.demanding=@abliterated" }], async ([project]) => {
        const scenario: ChildScenario = {
          sessions: [{ project: project as string, calls: 1 }],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
        };
        const kept = await runIsolatedScenario({ ...scenario, agentChoice: "task" });
        expect(kept.requests.map((request) => Object.keys(JSON.parse(request.body).questions))).toEqual([["agent"]]);
        expect(kept.sessions[0]?.results).toEqual([null]);

        const tiered = await runIsolatedScenario(scenario);
        expect(tiered.requests.map((request) => Object.keys(JSON.parse(request.body).questions))).toEqual([["agent"], ["difficulty"]]);
        expect(tiered.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
      });
    });

    test("standard work, a low-confidence difficulty, and a tier equal to the primary leave the spawn unchanged", async () => {
      await withProjects([{ modelTiers: "demanding=@abliterated" }, { modelTiers: "demanding=@task" }], async ([tier, same]) => {
        const input = reviewTask("Keep", "scout");
        const scenario = (project: string): ChildScenario => ({
          sessions: [
            {
              project,
              calls: 0,
              steps: [
                { call: input, id: "keep" },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "keep" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { scout: ["openai/gpt-5"] },
        });
        const standard = await runIsolatedScenario({ ...scenario(tier as string), difficultyChoice: "standard" });
        const unsure = await runIsolatedScenario({ ...scenario(tier as string), difficultyConfidence: 0.5 });
        const noOp = await runIsolatedScenario(scenario(same as string));
        for (const report of [standard, unsure, noOp]) {
          expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([null, { spawnKey: "Keep", result: null }]);
        }
        expect(standard.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  scout · difficulty standard (0.99)",
        ]);
        expect(unsure.sessions[0]?.notifications.map((notice) => notice.message)).toEqual(["judge-dispatch  scout"]);
        expect(noOp.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  scout · difficulty demanding (0.99)",
        ]);
      });
    });

    test("routes a bullet roster but excludes write-capable metadata from read-only requests", async () => {
      await withProjects([{}, { judgeEffort: true }], async ([ordinary, readOnly]) => {
        const description = [
          "# Available Agents",
          "- `task`: General-purpose agent",
          "- `scout` (READ-ONLY; investigation only, no edits): Research",
          "- `security-reviewer` (READ-ONLY; investigation only, no edits): Security research",
          "# Other Section",
          "- `oracle`: Not available in this task roster",
        ].join("\n");
        const report = await runIsolatedScenario({
          sessions: [
            { project: ordinary as string, calls: 1, description },
            {
              project: readOnly as string,
              calls: 1,
              description,
              inputs: [{ task: "Investigate a security issue", agent: "scout" }],
            },
          ],
          response: "success",
          agentChoice: "security-reviewer",
          hostKey: HOST_KEY,
        });

        expect(report.sessions[0]?.results).toEqual([
          { input: { task: "Implement the requested repository change", agent: "security-reviewer" } },
        ]);
        expect(report.sessions[1]?.results).toEqual([null]);
        const requests = report.requests.map(
          (request) =>
            JSON.parse(request.body) as {
              state: { candidates: { name: string }[] };
              questions: Record<string, unknown>;
            },
        );
        expect(requests.map((request) => request.state.candidates.map((candidate) => candidate.name))).toEqual([
          ["task", "scout", "security-reviewer"],
          ["scout"],
        ]);
        expect(requests.map((request) => Object.keys(request.questions))).toEqual([["agent"], ["difficulty"]]);
      });
    });

    test("read-only routing excludes other agents with a spawn grant", async () => {
      await withProjects([{}, {}], async ([project, overridden]) => {
        if (!project || !overridden) throw new Error("missing projects");
        const policies = { wild: '"*"', delegator: "sonic", tasker: "task", observer: "scout", relay: "delegator", missing: "unknown" };
        for (const dir of [project, overridden]) {
          const path = join(dir, ".omp", "agents");
          await mkdir(path, { recursive: true });
          await Bun.write(join(path, "inspector.md"), "---\nname: inspector\ndescription: Inspect the project\ntools: read\n---\nInspect.");
          for (const [name, spawns] of Object.entries(policies)) {
            await Bun.write(
              join(path, `${name}.md`),
              `---\nname: ${name}\ndescription: Inspect the project\ntools: read\nspawns: ${spawns}\n---\nInspect.`,
            );
          }
        }
        await Bun.write(
          join(overridden, ".omp", "agents", "sonic.md"),
          "---\nname: sonic\ndescription: Read-only project override\ntools: read\n---\nInspect.",
        );
        const leaves = ["inspector", "scout"];
        const grants = Object.keys(policies);
        const roster = [...leaves, ...grants, "sonic", "task"];
        const sources = [...leaves, ...grants, "sonic"];
        const parentSpawns = roster.join(",");
        const probeSources = ["scout", "delegator"];
        const probe = { parentSpawns, calls: probeSources.length, inputs: probeSources.map((agent) => reviewTask(agent, agent)) };
        const report = await runIsolatedScenario({
          sessions: [
            { project, parentSpawns, calls: sources.length, inputs: sources.map((agent) => reviewTask(agent, agent)) },
            { ...probe, project, disabledAgents: ["sonic"] },
            { ...probe, project, maxDepth: 1 },
            { ...probe, project: overridden },
          ],
          response: "success",
          hostKey: HOST_KEY,
          agentChoice: "relay",
        });
        const choices = report.requests.map(({ body }) => {
          const { state } = JSON.parse(body);
          return { source: state.requestedAgent, candidates: state.candidates.map(({ name }: { name: string }) => name).sort() };
        });
        expect(choices, diagnostics(report)).toEqual([
          ...leaves.map((source) => ({ source, candidates: leaves })),
          ...grants.map((source) => ({ source, candidates: [...leaves, source].sort() })),
          { source: "sonic", candidates: roster.toSorted() },
          ...[leaves, leaves, [...leaves, "sonic"]].flatMap((candidates) =>
            probeSources.map((source) => ({
              source,
              candidates: (source === "delegator" ? [...candidates, source] : [...candidates]).sort(),
            })),
          ),
        ]);
        expect(report.sessions[0]?.results.at(-1)).toEqual({ input: { ...reviewTask("sonic", "sonic"), agent: "relay" } });
      });
    });

    for (const leaves of [["scout"], ["scout", "inspector"]]) {
      test(`a read-only source with ${leaves.length} eligible ${leaves.length === 1 ? "leaf" : "leaves"} can be kept by the judge`, async () => {
        await withProjects([{}], async ([project]) => {
          if (!project) throw new Error("missing project");
          const agents = join(project, ".omp", "agents");
          await mkdir(agents, { recursive: true });
          await Bun.write(
            join(agents, "delegator.md"),
            "---\nname: delegator\ndescription: Inspect the project\ntools: read\nspawns: task\n---\nInspect.",
          );
          await Bun.write(
            join(agents, "inspector.md"),
            "---\nname: inspector\ndescription: Inspect the project\ntools: read\n---\nInspect.",
          );
          const report = await runIsolatedScenario({
            sessions: [
              { project, parentSpawns: ["delegator", ...leaves].join(","), calls: 1, inputs: [reviewTask("Inspect", "delegator")] },
            ],
            response: "success",
            hostKey: HOST_KEY,
            agentChoice: "delegator",
          });
          expect(report.requests, diagnostics(report)).toHaveLength(1);
          const question = JSON.parse(report.requests[0]?.body ?? "{}").questions?.agent;
          expect(Object.keys(question?.criteria ?? {}).sort()).toEqual(["delegator", ...leaves].sort());
          expect(report.sessions[0]?.results).toEqual([null]);
        });
      });
    }

    test("uses validated defaults for flat, batch, and direct calls even without a described default", async () => {
      await withProjects([{ modelTiers: "scout.demanding=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const omitted = { task: "Inspect the file", solutionSpace: "Read only" };
        const explicit = { ...omitted, agent: "scout" };
        const batch = { context: "Independent tasks", tasks: [omitted, explicit] };
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              parentSpawns: "scout,task",
              batch: false,
              steps: [{ call: omitted, id: "flat", validate: true }],
            },
            {
              project,
              calls: 0,
              parentSpawns: "scout,task",
              steps: [{ call: batch, id: "batch", validate: true }],
            },
            {
              project,
              calls: 0,
              parentSpawns: "scout,task",
              batch: false,
              description: TASK_DESCRIPTION,
              steps: [
                { call: omitted, id: "unreadable", validate: true },
                { call: explicit, id: "written", validate: true },
                { call: omitted, id: "direct", validate: true, direct: true },
                { call: omitted, id: "really-absent", direct: true },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { scout: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          { input: { ...explicit, name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) } },
        ]);
        expect(report.sessions[1]?.steps).toEqual([
          {
            input: {
              context: batch.context,
              tasks: [
                { ...explicit, name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) },
                { ...explicit, name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) },
              ],
            },
          },
        ]);
        expect(report.sessions[2]?.steps).toEqual([
          ...Array.from({ length: 3 }, () => ({ input: { ...explicit, name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) } })),
          null,
        ]);
        expect(report.requests).toHaveLength(6);
      });
    });

    test("uses the validated agent in a batch whose raw keys needed repair", async () => {
      await withProjects([{ modelTiers: "scout.demanding=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const task = { task: "Inspect the file", agent: "scout", solutionSpace: "Read only" };
        const context = "Independent research";
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              parentSpawns: "task,scout",
              description: TASK_DESCRIPTION,
              steps: [{ call: { context, '"tasks"': [task] }, id: "repaired", validate: true }],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { scout: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          { input: { context, tasks: [{ ...task, name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) }] } },
        ]);
        expect(JSON.parse(report.requests[0]?.body ?? "{}").state?.requestedAgent).toBe("scout");
      });
    });

    test("uses each validated agent when assistant tool-call IDs are duplicated", async () => {
      await withProjects([{ modelTiers: "scout.demanding=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const first = { task: "Inspect the file", agent: "scout", solutionSpace: "Read only" };
        const second = { task: "Change the setting", solutionSpace: "Known change" };
        const id = "duplicate";
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              parentSpawns: "task,scout",
              batch: false,
              steps: [
                {
                  assistant: [
                    { id, args: first },
                    { id, args: second },
                  ],
                },
                { call: first, id, validate: true, direct: true },
                { end: id, result: {} },
                { call: second, id, validate: true, direct: true },
              ],
            },
          ],
          response: "success",
          agentChoice: "task",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { scout: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          null,
          { input: { ...first, name: expect.stringMatching(/^scout-[0-9a-f]{8}$/) } },
          null,
          null,
        ]);
        expect(report.requests.map(({ body }) => JSON.parse(body).state.requestedAgent)).toEqual(["scout", "task"]);
      });
    });

    test("an omitted agent uses the live read-only default for both routing and tiers", async () => {
      await withProjects([{ modelTiers: "scout.demanding=@abliterated" }], async ([project]) => {
        const input = { task: "Investigate the deadlock", name: "Default" };
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              parentSpawns: "scout,task",
              steps: [
                { call: input, id: "omitted" },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "omitted" },
              ],
            },
            { project: project as string, calls: 1, inputs: [input], parentSpawns: "unknown,scout,task" },
            { project: project as string, calls: 1, inputs: [input], description: TASK_DESCRIPTION },
            { project: project as string, calls: 1, inputs: [input], parentSpawns: "*" },
          ],
          response: "success",
          agentChoice: "task",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { scout: ["openai/gpt-5"] },
        });

        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          null,
          {
            spawnKey: "Default",
            result: { model: ["openai/gpt-5-mini", "openai/gpt-5"], note: "judge-dispatch demanding tier @abliterated" },
          },
        ]);
        expect(report.sessions.slice(1).map((session) => session.results)).toEqual([[null], [null], [null]]);
        expect(report.requests).toHaveLength(2);
        expect(JSON.parse(report.requests[1]?.body ?? "").state.requestedAgent).toBe("task");
        const judgment = JSON.parse(report.requests[0]?.body ?? "");
        expect(judgment.state.requestedAgent).toBe("scout");
        expect(judgment.state.candidates.map((candidate: { name: string }) => candidate.name)).toEqual(["scout"]);
        expect(Object.keys(judgment.questions)).toEqual(["difficulty"]);
      });
    });

    test("user-tagged model agents are left as written and disk agents can shadow them", async () => {
      await withProjects([{ judgeEffort: true, modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const path = join(project as string, ".omp", "agents");
        await mkdir(path, { recursive: true });
        await Bun.write(join(path, "m2.md"), "---\nname: m2\ndescription: Project specialist\n---\nReview the project.");
        const tagged = reviewTask("Tagged", "m1");
        const retry = { ...tagged, agent: "task", task: "Retry the assignment with an ordinary agent" };
        const disk = reviewTask("Disk", "m2");
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              parentSpawns: "task,scout,m1,m2",
              branch: [
                { type: "custom", customType: "model_mention", data: { agent: "m1", selector: "openai/gpt-5:low", name: "Tagged" } },
                { type: "custom", customType: "model_mention", data: { agent: "m2", selector: "openai/gpt-5", name: "Shadowed" } },
              ],
              steps: [
                { call: tagged, id: "tagged" },
                { spawn: { agent: "m1", patterns: ["openai/gpt-5:low"] }, from: "tagged" },
                {
                  end: "tagged",
                  result: { details: { results: [{ id: "Tagged", index: 0, agent: "m1", exitCode: 0, output: "ESCALATE: deep-high" }] } },
                },
                { call: retry, id: "retry" },
                { call: disk, id: "disk" },
              ],
            },
          ],
          response: "success",
          agentChoice: "m1",
          hostKey: HOST_KEY,
          explicitRole: true,
        });

        expect(report.sessions[0]?.steps.slice(0, 3), diagnostics(report)).toEqual([null, { spawnKey: "Tagged", result: null }, null]);
        const judgments = report.requests.map(({ body }) => JSON.parse(body).state);
        expect(judgments.map((state) => state.assignment)).toEqual([retry.task, disk.task]);
        for (const state of judgments) {
          expect(state.candidates.map((candidate: { name: string }) => candidate.name).sort()).toEqual(["m2", "scout", "task"]);
        }
        expect(judgments[1].requestedAgent).toBe("m2");
      });
    });

    test("unknown or disabled rosters, unresolved access, reserved sources and agent@model forms do not change agent or effort", async () => {
      await withProjects([{ judgeEffort: true }], async ([project]) => {
        const inputs = ["metis", "momus", "oracle", "audit-auditor", "unknown-agent", "deep-low@abliterated"].map((agent) => ({
          agent,
          task: "Review this plan",
          effort: "lo",
        }));
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: inputs.length, inputs }],
          response: "success",
          hostKey: HOST_KEY,
        });
        expect(report.requests).toEqual([]);
        expect(report.sessions[0]?.results).toEqual(inputs.map(() => null));
      });
      await withProjects([{ judgeEffort: true }, { judgeEffort: true }], async ([unknown, disabled]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: unknown as string, calls: 1, description: "# Available Agents\nUnrecognized listing format" },
            { project: disabled as string, calls: 1, description: "# Available Agents\nAgent spawning is currently disabled." },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        expect(report.requests).toEqual([]);
        expect(report.sessions.map((session) => session.results)).toEqual([[null], [null]]);
      });
    });

    test("active Atlas execution owns agent and effort; an idle state restores ordinary routing", async () => {
      await withProjects([{ judgeEffort: true }, { judgeEffort: true }], async ([executing, idle]) => {
        const state = (phase: string) => ({ type: "custom", customType: "wows-omp-omo-prometheus.state", data: { phase } });
        const input = {
          agent: "task",
          task: 'Implement T1\natlas_assignment: {"planSha256":"approved","rows":{"T1":"attempt"}}',
          effort: "lo",
        };
        const report = await runIsolatedScenario({
          sessions: [
            { project: executing as string, calls: 1, inputs: [input], branch: [state("planning"), state("executing")] },
            { project: idle as string, calls: 1, inputs: [input], branch: [state("executing"), state("idle")] },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        expect(report.requests).toHaveLength(1);
        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[1]?.results).toEqual([{ input: { ...input, agent: "scout" } }]);
      });
    });

    test("Atlas spawns cannot inherit a pending tier from before execution began", async () => {
      await withProjects([{ routeAgent: false, modelTiers: "demanding=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const input = reviewTask("Shared", "task");
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              steps: [
                { call: input, id: "before-atlas" },
                { branch: [{ type: "custom", customType: "wows-omp-omo-prometheus.state", data: { phase: "executing" } }] },
                { call: input, id: "atlas" },
                { spawn: taskSpawn, from: "atlas" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps.at(-1), diagnostics(report)).toEqual({ spawnKey: "Shared", result: null });
        expect(report.requests).toHaveLength(1);
      });
    });

    test("an escalated or failed lowered child raises its next same-named dispatch once, keeping the requested agent", async () => {
      const fix = { task: "Fix the deadlock", agent: "task", name: "Fix" };
      const scoutSpawn = { agent: "scout", patterns: ["openai/gpt-5"] };
      const childResult = (id: string, agent: string, output: string, failed = false, index = 0) => ({
        content: [{ type: "text", text: "<task-result>" }],
        details: {
          projectAgentsDir: null,
          totalDurationMs: 1,
          results: [
            {
              ...{ index, id, agent, agentSource: "bundled", task: "", output, stderr: "", truncated: false },
              ...{ durationMs: 1, tokens: 0, requests: 1, exitCode: failed ? 1 : 0 },
              ...(failed ? { error: "child failed" } : {}),
            },
          ],
        },
      });
      const tierSpawn = (difficulty: string) => ({
        model: ["openai/gpt-5-mini", "openai/gpt-5"],
        note: `judge-dispatch ${difficulty} tier @abliterated`,
      });
      const scenario: Omit<ChildScenario, "sessions"> = {
        response: "success",
        hostKey: HOST_KEY,
        explicitRole: true,
        agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
      };

      await withProjects([{ modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          ...scenario,
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: fix, id: "first" },
                { spawn: scoutSpawn, from: "first" },
                { end: "first", result: childResult("Fix", "scout", "\nESCALATE: deep-high\nThe cause is still open.") },
                { call: fix, id: "escalated" },
                { spawn: { agent: "task", patterns: ["openai/gpt-5"] }, from: "escalated" },
                { call: fix, id: "again" },
              ],
            },
          ],
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          { input: { ...fix, agent: "scout" } },
          { spawnKey: "Fix", result: tierSpawn("demanding") },
          null,
          null,
          { spawnKey: "Fix-2", result: tierSpawn("demanding") },
          { input: { ...fix, agent: "scout" } },
        ]);
        expect(report.requests).toHaveLength(2);
        expect(report.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task · escalated to demanding after ESCALATE: deep-high · model openai/gpt-5 → @abliterated",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
      });

      const cheap = { ...fix, name: "Cheap" };
      const plain = { ...fix, name: "Plain", model: "openai/gpt-5" };
      const batch = { context: "Independent fixes", tasks: [plain, cheap] };
      await withProjects([{ modelTiers: "routine=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          ...scenario,
          difficultyChoice: "routine",
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: batch, id: "cheap" },
                { spawn: { ...scoutSpawn, spawnKey: "Cheap" } },
                { call: cheap, id: "overlapping" },
                { spawn: { ...scoutSpawn, spawnKey: "Cheap", patterns: [] } },
                { end: "overlapping", result: childResult("Cheap", "scout", "Unchanged sibling failed.", true) },
                { call: cheap, id: "ordinary-retry" },
                { spawn: { ...scoutSpawn, spawnKey: "Cheap" } },
                { end: "cheap", result: childResult("parent.Cheap-2", "scout", "Could not finish.", true, 1) },
                { call: cheap, id: "raised" },
              ],
            },
          ],
        });
        expect(report.sessions[0]?.steps, diagnostics(report)).toEqual([
          { input: { ...batch, tasks: [plain, { ...cheap, agent: "scout" }] } },
          { spawnKey: "Cheap", result: tierSpawn("routine") },
          { input: { ...cheap, agent: "scout" } },
          { spawnKey: "Cheap", result: null },
          null,
          { input: { ...cheap, agent: "scout" } },
          { spawnKey: "Cheap", result: tierSpawn("routine") },
          null,
          null,
        ]);
        expect(report.requests).toHaveLength(3);
        expect(report.sessions[0]?.notifications.map((notice) => notice.message)).toEqual([
          "judge-dispatch  #1 task kept (native model) ; #2 task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task · raised to standard after a failed lowered run",
        ]);
      });
    });

    test("escalation records keep the caller's exact names, even names ending in a number", async () => {
      const lane = (name: string) => ({ task: `Fix ${name}`, agent: "task", name });
      // OMP allocated `Lane-1-2` for the retried `Lane-1`, because an earlier `Lane-1` child still holds `Lane-1`.
      const escalated = {
        details: {
          projectAgentsDir: null,
          totalDurationMs: 1,
          results: [
            {
              ...{ index: 0, id: "Lane-1-2", agent: "scout", agentSource: "bundled", task: "", stderr: "", truncated: false },
              ...{ output: "ESCALATE: deep-high", durationMs: 1, tokens: 0, requests: 1, exitCode: 0 },
            },
          ],
        },
      };
      await withProjects([{ modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: lane("Lane-1"), id: "first" },
                { end: "first", result: escalated },
                { call: lane("Lane-2"), id: "sibling" },
                { call: lane("Lane"), id: "prefix" },
                { call: lane("Lane-1"), id: "retry" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
        });
        // Lane-1, then Lane-2 and Lane are judged normally; only the retried Lane-1 is raised.
        expect(
          report.sessions[0]?.notifications.map((notice) => notice.message),
          diagnostics(report),
        ).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  task · escalated to demanding after ESCALATE: deep-high · model openai/gpt-5 → @abliterated",
        ]);
        // Only the retry under the escalated name skips the judge.
        expect(report.requests).toHaveLength(3);
      });
    });

    test("a kept route leaves the escalation record for the next routed dispatch under that name", async () => {
      const fix = (agent: string) => ({ task: "Fix the deadlock", agent, name: "Fix" });
      const escalated = {
        details: {
          projectAgentsDir: null,
          totalDurationMs: 1,
          results: [
            {
              ...{ index: 0, id: "Fix", agent: "scout", agentSource: "bundled", task: "", stderr: "", truncated: false },
              ...{ output: "ESCALATE: deep-high", durationMs: 1, tokens: 0, requests: 1, exitCode: 0 },
            },
          ],
        },
      };
      await withProjects([{ modelTiers: "demanding=@abliterated" }], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [
            {
              project: project as string,
              calls: 0,
              steps: [
                { call: fix("task"), id: "first" },
                { end: "first", result: escalated },
                // Workflow-owned and unlisted agents keep their route, so neither may use up the record.
                { call: fix("metis"), id: "owned" },
                { call: fix("unknown-agent"), id: "unlisted" },
                { call: fix("task"), id: "retry" },
                { call: fix("task"), id: "again" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
        });
        expect(
          report.sessions[0]?.notifications.map((notice) => notice.message),
          diagnostics(report),
        ).toEqual([
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
          "judge-dispatch  metis kept (workflow-owned or unknown agent)",
          "judge-dispatch  unknown-agent kept (workflow-owned or unknown agent)",
          "judge-dispatch  task · escalated to demanding after ESCALATE: deep-high · model openai/gpt-5 → @abliterated",
          "judge-dispatch  task → scout (0.99) · model openai/gpt-5 → @abliterated (0.99)",
        ]);
      });
    });

    test("a tier naming the agent's own model at another thinking level applies that level instead of a step", async () => {
      const own = reviewTask("Own", "scout");
      await withProjects(
        [{ modelTiers: "scout.demanding=openai/gpt-5:high" }, { judgeEffort: true, modelTiers: "scout.demanding=openai/gpt-5:high" }],
        async ([tierOnly, withSteps]) => {
          const report = await runIsolatedScenario({
            sessions: [tierOnly, withSteps].map((project) => ({
              project: project as string,
              calls: 0,
              steps: [
                { call: own, id: "own" },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "own" },
              ],
            })),
            response: "success",
            hostKey: HOST_KEY,
            explicitRole: true,
            agentModels: { scout: ["openai/gpt-5"] },
          });
          const tierSpawn = { model: ["openai/gpt-5:high"], note: "judge-dispatch demanding tier openai/gpt-5:high" };
          for (const session of report.sessions) {
            // scout's own level is its frontmatter `medium`; the tier's explicit `high` must win, not be skipped or stepped.
            expect(session.steps, diagnostics(report)).toEqual([null, { spawnKey: "Own", result: tierSpawn }]);
            expect(session.notifications.map((notice) => notice.message)).toEqual([
              "judge-dispatch  scout · model openai/gpt-5 → openai/gpt-5:high (0.99)",
            ]);
          }
        },
      );
    });

    test("overlapping names and allocation suffixes cannot take another item's tier or lowering", async () => {
      await withProjects([{ routeAgent: false, modelTiers: "routine=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const lane = reviewTask("Lane", "task");
        const suffix = reviewTask("Lane-2", "task");
        const failed = { details: { results: [{ index: 0, id: "Lane-2", agent: "task", exitCode: 1, output: "Failed." }] } };
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              steps: [
                { spawn: taskSpawn, allocate: "Lane" },
                { call: lane, id: "base" },
                { call: suffix, id: "suffix" },
                { spawn: taskSpawn, from: "base" },
                { spawn: taskSpawn, from: "suffix" },
                { end: "base", result: failed },
                { end: "suffix", result: { details: { results: [{ ...failed.details.results[0], id: "Lane-2-2" }] } } },
                { call: lane, id: "retry" },
                { spawn: taskSpawn, from: "retry" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          difficultyChoice: "routine",
          agentModels: { task: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps.slice(3, 5), diagnostics(report)).toEqual([
          { spawnKey: "Lane-2", result: null },
          { spawnKey: "Lane-2-2", result: null },
        ]);
        expect(report.sessions[0]?.steps.at(-1)).toEqual({
          spawnKey: "Lane-3",
          result: expect.objectContaining({ note: "judge-dispatch routine tier @abliterated" }),
        });
        expect(report.requests).toHaveLength(3);
      });
    });

    test.each(["empty results", "a successful sibling"])(
      "a synchronous error with %s raises only lowered items without rows",
      async (mode) => {
        await withProjects([{ routeAgent: false, modelTiers: "routine=@abliterated" }], async ([project]) => {
          if (!project) throw new Error("missing project");
          const lowered = reviewTask("Lowered", "task");
          const unchanged = reviewTask("Unchanged", "task");
          const successful = reviewTask("Successful", "task");
          const hasSibling = mode === "a successful sibling";
          const tasks = hasSibling ? [lowered, unchanged, successful] : [lowered, unchanged];
          const results = hasSibling ? [{ index: 2, id: "Successful", agent: "task", exitCode: 0, output: "Done." }] : [];
          const report = await runIsolatedScenario({
            sessions: [
              {
                project,
                calls: 0,
                steps: [
                  { call: { context: "Independent tasks", tasks }, id: "batch" },
                  { spawn: taskSpawn, from: "batch" },
                  { spawn: { ...taskSpawn, patterns: [] }, from: "batch", item: 1 },
                  ...(hasSibling ? [{ spawn: taskSpawn, from: "batch", item: 2 }] : []),
                  { end: "batch", isError: true, result: { details: { results } } },
                  { call: lowered, id: "raised" },
                  { call: unchanged, id: "judged" },
                  ...(hasSibling ? [{ call: successful, id: "judged-success" }] : []),
                ],
              },
            ],
            response: "success",
            hostKey: HOST_KEY,
            explicitRole: true,
            difficultyChoice: "routine",
            agentModels: { task: ["openai/gpt-5"] },
          });
          expect(
            report.sessions[0]?.notifications.slice(-tasks.length).map(({ message }) => message),
            diagnostics(report),
          ).toEqual([
            "judge-dispatch  task · raised to standard after a failed lowered run",
            "judge-dispatch  task · model openai/gpt-5 → @abliterated (0.99)",
            ...(hasSibling ? ["judge-dispatch  task · model openai/gpt-5 → @abliterated (0.99)"] : []),
          ]);
          expect(report.requests).toHaveLength(2 * tasks.length - 1);
        });
      },
    );

    test("a failed routine spawn raises a retry under its plugin-generated name", async () => {
      await withProjects([{ routeAgent: false, modelTiers: "routine=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const input = { task: "Inspect the file", agent: "task" };
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              steps: [
                { call: input, id: "unnamed" },
                { spawn: taskSpawn, from: "unnamed" },
                {
                  end: "unnamed",
                  result: { details: { results: [{ index: 0, agent: "task", id: "Child", exitCode: 1, output: "Failed." }] } },
                },
                { call: input, id: "retry", nameFrom: "unnamed" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          difficultyChoice: "routine",
          agentModels: { task: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.steps[0]).toEqual({ input: { ...input, name: expect.stringMatching(/^task-[0-9a-f]{8}$/) } });
        expect(report.sessions[0]?.notifications.at(-1)?.message, diagnostics(report)).toBe(
          "judge-dispatch  task · raised to standard after a failed lowered run",
        );
        expect(report.requests).toHaveLength(1);
      });
    });

    test("a background failure survives job expiry before its blocking sibling returns", async () => {
      await withProjects([{ routeAgent: false, modelTiers: "task.routine=@abliterated" }], async ([project]) => {
        if (!project) throw new Error("missing project");
        const background = reviewTask("Background", "task");
        const inline = reviewTask("Inline", "scout");
        const pending = {
          details: {
            results: [],
            progress: [
              { index: 0, id: background.name, agent: "task", status: "pending" },
              { index: 1, id: inline.name, agent: "scout", status: "pending" },
            ],
            async: { state: "running", jobId: background.name, type: "task" },
          },
        };
        const report = await runIsolatedScenario({
          sessions: [
            {
              project,
              calls: 0,
              jobRetention: 20,
              steps: [
                { call: { context: "Independent tasks", tasks: [background, inline] }, id: "mixed" },
                { job: background.name },
                { update: "mixed", result: pending },
                { spawn: taskSpawn, from: "mixed" },
                { finish: background.name, failed: true, output: "Could not finish.", expire: true },
                { end: "mixed", result: pending },
                { call: background, id: "retry" },
              ],
            },
          ],
          response: "success",
          hostKey: HOST_KEY,
          explicitRole: true,
          difficultyChoice: "routine",
          agentModels: { task: ["openai/gpt-5"] },
        });
        expect(report.sessions[0]?.notifications.at(-1)?.message, diagnostics(report)).toBe(
          "judge-dispatch  task · raised to standard after a failed lowered run",
        );
        expect(report.requests).toHaveLength(1);
      });
    });

    test("background jobs are remembered only at terminal settlement and only for their owning session", async () => {
      await withProjects(
        Array.from({ length: 3 }, () => ({ modelTiers: "routine=@abliterated,demanding=@abliterated" })),
        async (projects) => {
          const input = reviewTask("Fix", "task");
          const pending = {
            details: {
              results: [],
              progress: [{ index: 0, id: "Fix", agent: "scout", status: "running" }],
              async: { state: "running", jobId: "Fix", type: "task" },
            },
          };
          const sessions = projects.map(
            (project, index): SessionSpec => ({
              project,
              calls: 0,
              steps: [
                { call: input, id: "first" },
                { job: "Fix", ...(index === 2 ? { owner: "another-session" } : {}) },
                { end: "first", result: pending },
                { spawn: { agent: "scout", patterns: ["openai/gpt-5"] }, from: "first" },
                {
                  finish: "Fix",
                  failed: index === 1,
                  output: `<task-result id="Fix">\n<output>\n${index === 1 ? "Unable to finish." : "ESCALATE: deep-high"}\n</output>\n</task-result>`,
                },
                { call: input, id: "retry" },
              ],
            }),
          );
          const report = await runIsolatedScenario({
            sessions,
            response: "success",
            hostKey: HOST_KEY,
            explicitRole: true,
            difficultyChoice: "routine",
            agentModels: { task: ["openai/gpt-5"], scout: ["openai/gpt-5"] },
          });
          expect(report.requests).toHaveLength(4);
          expect(report.sessions[0]?.steps.at(-1), diagnostics(report)).toBeNull();
          expect(report.sessions[0]?.notifications.at(-1)?.message).toBe(
            "judge-dispatch  task · escalated to demanding after ESCALATE: deep-high · model openai/gpt-5 → @abliterated",
          );
          expect(report.sessions[1]?.steps.at(-1), diagnostics(report)).toBeNull();
          expect(report.sessions[1]?.notifications.at(-1)?.message).toBe(
            "judge-dispatch  task · raised to standard after a failed lowered run",
          );
          expect(report.sessions[2]?.steps.at(-1), diagnostics(report)).toEqual({ input: { ...input, agent: "scout" } });
        },
      );
    });

    test("unknown stored settings warn once per session and a malformed modelTiers keeps every call as requested", async () => {
      await withProjects([{ legacyKnob: true }, { modelTiers: "routine=nonsense" }], async ([unknown, malformed]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: unknown as string, calls: 2 },
            { project: malformed as string, calls: 1 },
          ],
          response: "success",
          hostKey: HOST_KEY,
        });
        const [ignored, invalid] = report.sessions;
        expect(ignored?.results).toEqual([
          { input: { task: "Implement the requested repository change", agent: "scout" } },
          { input: { task: "Implement the requested repository change", agent: "scout" } },
        ]);
        expect(ignored?.notifications.filter((notice) => notice.level === "warning")).toEqual([
          { message: expect.stringMatching(/legacyKnob.*modelTiers/), level: "warning" },
        ]);
        expect(invalid?.results).toEqual([null]);
        expect(JSON.stringify(invalid?.warnings)).toContain("invalid modelTiers entry");
        expect(report.requests).toHaveLength(2);
      });
    });

    test("without a host credential task calls keep the requested agent and warn once per session", async () => {
      await withProjects([{}, {}], async ([first, second]) => {
        const report = await runIsolatedScenario({
          sessions: [
            { project: first as string, calls: 2 },
            { project: second as string, calls: 2 },
          ],
          response: "success",
        });

        expect(report.requests).toHaveLength(0);
        for (const session of report.sessions) {
          expect(session.results).toEqual([null, null]);
          expect(session.usage).toHaveLength(0);
          expect(session.notifications.filter((notice) => notice.level === "warning")).toHaveLength(1);
          expect(session.notifications.filter((notice) => notice.level === "info")).toEqual([
            { message: "judge-dispatch  task kept (judge unavailable)", level: "info" },
            { message: "judge-dispatch  task kept (judge unavailable)", level: "info" },
          ]);
        }
      });
    });

    test("a rejected host credential fails open without the availability warning or leaking the key", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "unauthorized",
          hostKey: HOST_KEY,
        });

        expect(report.requests).toHaveLength(1);
        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[0]?.notifications).toEqual([{ message: "judge-dispatch  task kept (judge failed)", level: "info" }]);
        expect(report.sessions[0]?.warnings.length).toBeGreaterThan(0);
        expect(report.requests[0]?.body).not.toContain(HOST_KEY);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });

    test("a transport failure fails open without the availability warning", async () => {
      await withProjects([{}], async ([project]) => {
        const report = await runIsolatedScenario({
          sessions: [{ project: project as string, calls: 1 }],
          response: "network-error",
          hostKey: HOST_KEY,
        });

        expect(report.sessions[0]?.results).toEqual([null]);
        expect(report.sessions[0]?.notifications).toEqual([{ message: "judge-dispatch  task kept (judge failed)", level: "info" }]);
        expect(report.sessions[0]?.working).toEqual(["judge-dispatch: routing 1 task…", null]);
        expect(report.sessions[0]?.warnings.length).toBeGreaterThan(0);
        expect(diagnostics(report)).not.toContain(HOST_KEY);
      });
    });
  });
}

const childScenario = process.env[CHILD_SCENARIO_ENV];
if (childScenario !== undefined) {
  try {
    const report = await executeChildScenario(JSON.parse(childScenario) as ChildScenario);
    console.log(`${CHILD_OUTPUT_MARKER}${JSON.stringify(report)}`);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else {
  await registerTests();
}
