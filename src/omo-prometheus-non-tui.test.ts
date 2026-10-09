import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { PrometheusStateV1 } from "../plugins/omo-prometheus/src/prometheus-state.ts";
import { parseAtlasSubcommand } from "../plugins/omo-prometheus/src/workflow.ts";

const CHILD = "PROMETHEUS_NON_TUI_SCENARIO";
const content = `# Non-TUI test

## Tasks
- [ ] T1. Observe input
  - Agent: task
  - Depends on: none
  - Acceptance: input is observed
- [ ] T2. Consume input
  - Agent: task
  - Depends on: T1
  - Acceptance: input is consumed

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

interface Envelope {
  schema: string;
  version: number;
  plugin: string;
  sessionId: string;
  seq: number;
  updatedAt: string;
  state: PrometheusStateV1 | null;
}

/** Real host registry and event bus in an isolated child, as in the other Prometheus suites. */
async function scenario(name: "rpc" | "headless", root: string): Promise<void> {
  // Static host imports would initialize HOME-scoped state in the parent rather than the isolated child.
  const { EventBus } = await import("@oh-my-pi/pi-coding-agent/utils/event-bus");
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { z } = await import("zod");
  const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
  const { default: register } = await import("../plugins/omo-prometheus/src/index.ts");
  const dir = join(root, "sessions");
  const artifacts = join(root, "artifacts");
  await mkdir(dir);
  await mkdir(artifacts);
  await mkdir(join(root, ".omp"));
  await writeFile(
    join(root, ".omp", "plugin-overrides.json"),
    JSON.stringify({ settings: { "wows-omp-plugin-omo-prometheus": { herdrDag: false } } }),
  );
  const store = new AtlasStore(dir);
  const create = (planName: string) =>
    store.create({
      name: planName,
      content,
      cwd: root,
      sourcePlanPath: "local://PLAN.md",
      sourceSessionId: "session-a",
      proposedByToolCallId: `proposal-${planName}`,
      availableAgents: ["task"],
    });
  const plan = await create("Contract test");
  const spare = await create("Spare plan");
  const sessionId = "session-a";
  const entries: unknown[] = [];
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionDir: () => dir,
    getArtifactsDir: () => artifacts,
    getBranch: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  let reference = "local://PLAN.md";
  const live = {
    settings: Settings.isolated(),
    sessionManager,
    getPlanModeState: () => ({ enabled: false }),
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
  type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: { text: string }[] }> };
  const hooks = new Map<string, Hook>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const messages: string[] = [];
  const notices: string[] = [];
  const widgets: unknown[] = [];
  const dialogs: Array<{ kind: string; title: string; options?: string[] }> = [];
  const answers: Array<(options: string[]) => string | undefined> = [];
  let customCalls = 0;
  const ctx = {
    cwd: root,
    mode: name === "rpc" ? "rpc" : "print",
    hasUI: name === "rpc",
    sessionManager,
    ui: {
      setWidget: (_key: string, value: unknown) => widgets.push(value),
      notify: (message: string) => notices.push(message),
      // RPC hosts return undefined from ui.custom (rpc-mode.ts), so any component flow must not reach it.
      custom: async () => {
        customCalls += 1;
        return undefined;
      },
      select: async (title: string, options: string[]) => {
        dialogs.push({ kind: "select", title, options });
        const answer = answers.shift();
        assert(answer, `Unexpected select: ${title}`);
        return answer(options);
      },
      confirm: async (title: string) => {
        dialogs.push({ kind: "confirm", title });
        return true;
      },
      input: async (title: string) => {
        dialogs.push({ kind: "input", title });
        return undefined;
      },
      editor: async (title: string, prefill?: string) => {
        dialogs.push({ kind: "editor", title, options: [prefill ?? ""] });
        return prefill;
      },
    },
  } as unknown as ExtensionContext;
  register({
    events: new EventBus(),
    zod: z,
    on: (event: string, handler: Hook) => hooks.set(event, handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (command: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      commands.set(command, spec.handler),
    logger: { warn() {} },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [{ name: "task", description: "# Available Agents\n- `task`: worker", sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["task"],
    setActiveTools: async () => {},
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI);
  const hook = async (type: string, event: Record<string, unknown> = {}) => {
    const handler = hooks.get(type);
    assert(handler);
    await handler({ type, ...event }, ctx);
  };
  const atlas = async (args: string) => {
    const command = commands.get("atlas");
    assert(command);
    await command(args, ctx);
  };
  const stateFile = join(root, "run", "wows-omp-plugins", "plugin-state", sessionId, "omo-prometheus.json");
  // AtlasLive and the publisher coalesce on real timers and the file is the observable output, so poll it.
  const sidecar = async (predicate: (envelope: Envelope) => boolean): Promise<Envelope> => {
    const deadline = Date.now() + 5_000;
    let last: Envelope | undefined;
    while (Date.now() < deadline) {
      try {
        last = JSON.parse(await readFile(stateFile, "utf8")) as Envelope;
        if (predicate(last)) return last;
      } catch {}
      await Bun.sleep(25);
    }
    throw new Error(`Sidecar never matched; last: ${JSON.stringify(last)}`);
  };
  const output = name === "rpc" ? () => notices.at(-1) ?? "" : () => messages.at(-1) ?? "";
  await hook("session_start");

  if (name === "headless") {
    await atlas("");
    assert.match(output(), /Atlas is inactive/);
    assert.match(output(), new RegExp(plan.id));
    await atlas("list");
    assert.match(output(), new RegExp(`Contract test \\(${plan.id}\\)`));
    assert.match(output(), new RegExp(spare.id));
    await atlas("show Contract test");
    assert.match(output(), /T1\. Observe input/);
    assert.match(output(), /Acceptance: input is consumed/);
    await atlas(`resume ${plan.id}`);
    assert.match(output(), /has not started yet; start it instead/);
    await atlas(`rename ${plan.id} Renamed plan`);
    assert.match(output(), /renamed to Renamed plan/);
    await atlas("list");
    assert.match(output(), new RegExp(`Renamed plan \\(${plan.id}\\)`));
    await atlas(`delete ${spare.id}`);
    assert.match(output(), /--yes/);
    assert.equal((await store.list()).length, 2);
    await atlas(`delete ${spare.id} --yes`);
    assert.match(output(), /deleted/);
    assert.deepEqual(
      (await store.list()).map((item) => item.id),
      [plan.id],
    );
    await atlas("rename");
    assert.match(output(), /needs a plan id and a new name/);
    await atlas("start Renamed plan");
    assert.equal(reference, `atlas://${plan.id}/plan.md`);
    assert.match(messages.at(-1) ?? "", /Execute the approved plan Renamed plan/);
  } else {
    // Resume is refused before the plan has started; the dialog repeats the plan's actions with the reason.
    answers.push(
      (options) => options.find((option) => option.startsWith("Spare plan")),
      (options) => options.find((option) => option === "Resume"),
      (options) => options.find((option) => option === "Back"),
      (options) => options.find((option) => option === "Close"),
    );
    await atlas("");
    assert.match(dialogs.at(-2)?.title ?? "", /has not started yet; start it instead/);
    answers.push(
      (options) => options.find((option) => option.startsWith("Contract test")),
      (options) => options.find((option) => option === "View details"),
      (options) => options.find((option) => option === "Start"),
    );
    const opened = dialogs.length;
    await atlas("");
    assert.equal(customCalls, 0);
    assert.deepEqual(dialogs[opened]?.options?.slice(-2), ["Show all plans (display only)", "Close"]);
    assert.deepEqual(dialogs[opened + 1]?.options, ["Start", "Resume", "View details", "Rename", "Delete", "Back"]);
    const editor = dialogs.find((dialog) => dialog.kind === "editor");
    assert.match(editor?.options?.[0] ?? "", /Acceptance: input is observed/);
    assert.equal(reference, `atlas://${plan.id}/plan.md`);
    // Active: bare /atlas shows the summary dialog instead of the component view.
    answers.push((options) => options.find((option) => option === "Keep Atlas running"));
    await atlas("");
    assert.match(dialogs.at(-1)?.title ?? "", /Atlas is executing Contract test/);
    assert.equal(answers.length, 0);
  }

  const executing = await sidecar((envelope) => envelope.state?.atlas?.rows !== undefined);
  assert.equal(executing.schema, "wows-omp-plugins/plugin-state");
  assert.equal(executing.version, 1);
  assert.equal(executing.plugin, "omo-prometheus");
  assert.equal(executing.sessionId, sessionId);
  assert.deepEqual(Object.keys(executing).sort(), ["plugin", "schema", "seq", "sessionId", "state", "updatedAt", "version"]);
  assert.equal(executing.state?.kind, "omo-prometheus/state");
  assert.equal(executing.state?.version, 1);
  assert.equal(executing.state?.phase, "executing");
  assert.equal(executing.state?.atlas?.planId, plan.id);
  assert.equal(executing.state?.atlas?.total, 6);
  assert.deepEqual(
    executing.state?.atlas?.gates?.map((gate) => gate.id),
    ["F1", "F2", "F3", "F4"],
  );
  assert.equal(executing.state?.atlas?.rows?.find((row) => row.id === "T2")?.dependsOn[0], "T1");

  await atlas("list");
  assert.match(output(), /Switching plans is not allowed/);

  const ledger = tools.get("atlas_ledger");
  assert(ledger);
  const started = await ledger.execute("call-1", { action: "start", id: "T1" }, undefined, undefined, ctx);
  assert(!started.isError, started.content[0]?.text ?? "atlas_ledger start failed");
  const progressed = await sidecar((envelope) => envelope.state?.atlas?.rows?.[0]?.status === "in_progress");
  assert(progressed.seq > executing.seq);
  assert.equal(progressed.state?.atlas?.rows?.[0]?.attempt !== undefined, true);

  if (name === "rpc") {
    // The widget is throttled on a real timer; wait for the line describing the started row.
    const deadline = Date.now() + 5_000;
    let lines: string[] | undefined;
    while (Date.now() < deadline && !lines?.[1]) {
      lines = widgets.filter((widget): widget is string[] => Array.isArray(widget)).at(-1);
      await Bun.sleep(25);
    }
    assert(lines, "RPC hosts receive string-array widget lines");
    assert(!widgets.some((widget) => typeof widget === "function"), "component widgets are TUI-only");
    assert.match(lines[0] ?? "", /^Atlas Contract test \[[#-]{10}\] 0\/6 · 0 running · gates 0\/4$/);
    assert.match(lines[1] ?? "", /^T1 Observe input \(task\) · waiting for child$/);
    answers.push((options) => options.find((option) => option === "Exit Atlas"));
    await atlas("");
    assert.equal(dialogs.at(-1)?.kind, "confirm");
  } else {
    await atlas("");
    assert.match(output(), /Atlas is executing Renamed plan\. Run \/atlas exit/);
    await atlas("exit");
  }
  assert.match(output(), /Atlas exited/);
  const idle = await sidecar((envelope) => envelope.state === null);
  assert(idle.seq > progressed.seq);
  if (name === "headless") {
    await atlas(`resume ${plan.id}`);
    assert.match(output(), /no session in this project has executed Renamed plan/);
  }
  await hook("session_shutdown");
}

if (process.env[CHILD]) {
  await scenario(process.env[CHILD] as "rpc" | "headless", await realpath(process.env.PROMETHEUS_NON_TUI_ROOT as string));
  console.log("PROMETHEUS_NON_TUI_OK");
} else {
  const { describe, expect, test } = await import("bun:test");
  describe("Prometheus outside the TUI", () => {
    for (const name of ["rpc", "headless"]) {
      test(`registered extension: ${name}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "prometheus-non-tui-"));
        try {
          const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
            env: {
              ...process.env,
              [CHILD]: name,
              PROMETHEUS_NON_TUI_ROOT: root,
              HOME: root,
              XDG_RUNTIME_DIR: join(root, "run"),
              PI_CODING_AGENT_DIR: join(root, "agent"),
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(code, stderr).toBe(0);
          expect(stdout).toContain("PROMETHEUS_NON_TUI_OK");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 30_000);
    }

    test("subcommand keywords win over plan names; ids and start reach keyword-named plans", () => {
      expect(parseAtlasSubcommand("")).toEqual({ kind: "menu" });
      expect(parseAtlasSubcommand("list")).toEqual({ kind: "list" });
      expect(parseAtlasSubcommand("show list")).toEqual({ kind: "show", selector: "list" });
      expect(parseAtlasSubcommand("start  My plan ")).toEqual({ kind: "start", selector: "My plan" });
      expect(parseAtlasSubcommand("rename plan--id New  name")).toEqual({ kind: "rename", planId: "plan--id", name: "New  name" });
      expect(parseAtlasSubcommand("delete --yes plan--id")).toEqual({ kind: "delete", planId: "plan--id", confirmed: true });
      expect(parseAtlasSubcommand("delete plan--id")).toEqual({ kind: "delete", planId: "plan--id", confirmed: false });
      expect(parseAtlasSubcommand("Release notes")).toEqual({ kind: "enter", selector: "Release notes" });
      for (const usage of ["exit now", "list all", "show", "resume", "rename id", "delete a b"]) {
        expect(parseAtlasSubcommand(usage).kind).toBe("usage");
      }
    });
  });
}
