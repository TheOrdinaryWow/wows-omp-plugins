import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const CHILD_ENV = "ULTRAWORK_EXTENSION_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
interface Message {
  customType: string;
  content: string;
  display: boolean;
  attribution: string;
  deliverAs?: string;
}

async function scenario(name: string, root: string): Promise<void> {
  // Host modules must load after the executable child receives its isolated HOME and agent directory.
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { z } = await import("zod");
  const { default: register } = await import("../plugins/omo-ultrawork/src/index.ts");
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  let manager = SessionManager.create(cwd, join(root, "sessions"));
  const settings = await Settings.loadIsolated({ cwd, agentDir: join(root, "agent") });
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const messages: Message[] = [];
  const notices: string[] = [];
  const requests: string[] = [];
  const warnings: string[] = [];
  let idle = true;
  const ctx = {
    cwd,
    hasUI: name === "tui" || name === "rpc",
    mode: name === "rpc" ? "rpc" : "tui",
    get sessionManager() {
      return manager;
    },
    isIdle: () => idle,
    ui: { notify: (text: string) => notices.push(text), setStatus() {} },
  } as unknown as ExtensionCommandContext;
  AgentRegistry.resetGlobalForTests();
  const live = {
    get sessionManager() {
      return manager;
    },
    settings,
    getEnabledToolNames: () => ["task"],
    getGoalModeState: () => undefined,
    getPlanModeState: () => undefined,
    getVibeModeState: () => undefined,
  } as unknown as AgentSession;
  AgentRegistry.global().register({ id: "Main", kind: "main", displayName: "Main", session: live });
  const api = {
    logger: { warn: (text: string) => warnings.push(text) },
    zod: z,
    on: (event: string, hook: Hook) => hooks.set(event, [...(hooks.get(event) ?? []), hook]),
    registerTool: () => {},
    events: { emit: () => {} },
    registerCommand: (command: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) =>
      commands.set(command, spec.handler),
    appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
    sendMessage: (message: Message, options?: { deliverAs?: string }) => messages.push({ ...message, deliverAs: options?.deliverAs }),
    sendUserMessage: (text: string) => requests.push(text),
    registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI;
  register(api);
  const hook = async (event: string, payload: Record<string, unknown> = {}) => {
    const handlers = hooks.get(event);
    assert(handlers);
    let result: unknown;
    for (const handler of handlers) {
      const value = await handler({ type: event, ...payload }, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  };
  const command = async (name: string, args = "") => {
    const handler = commands.get(name);
    assert(handler);
    await handler(args, ctx);
  };
  const stateFile = () => join(root, "run", "wows-omp-plugins", "plugin-state", manager.getSessionId(), "omo-ultrawork.json");
  const snapshot = async () => {
    // Switching to the same branch flushes pending writes and restores the authoritative session entry.
    await hook("session_switch");
    return JSON.parse(await readFile(stateFile(), "utf8"));
  };
  const payload = (mode: boolean, armed: boolean) => ({ kind: "omo-ultrawork/mode", version: 1, mode, armed });
  if (name === "publish-failure") {
    await mkdir(join(root, "run", "wows-omp-plugins"), { recursive: true, mode: 0o700 });
    await Bun.write(join(root, "run", "wows-omp-plugins", "plugin-state"), "not a directory");
    try {
      await hook("session_start");
      await command("ulw");
      await hook("session_switch");
      await command("ulw");
      await hook("session_shutdown");
      assert.deepEqual(
        messages.filter((message) => message.display).map((message) => message.content),
        ["Ultrawork mode on", "Ultrawork mode off"],
      );
      assert.equal(warnings.filter((text) => text === "ultrawork could not publish plugin state").length, 1);
    } finally {
      await hook("session_shutdown");
      AgentRegistry.resetGlobalForTests();
    }
    return;
  }
  try {
    await hook("session_start");
    if (name === "pointers") {
      const plan = (await hook("input", { source: "user", text: "ulw plan the upload change" })) as { text: string };
      assert(plan.text.includes("<omo-prometheus-pointer>"));
      const loop = (await hook("input", { source: "user", text: "what is ulw loop?" })) as { text: string };
      assert(loop.text.includes("<omo-ulw-loop-pointer>"));
      assert.equal(await Bun.file(join(manager.getSessionDir(), "ulw-loop", manager.getSessionId(), "state.json")).exists(), false);
      const discussion = (await hook("input", { source: "user", text: "what is ulw research?" })) as { text: string };
      assert(discussion.text.includes("<omo-ulw-research-pointer>"));
      assert(!discussion.text.includes("<omo-ulw-research-mode>"));
      const input = "use ulw research to compare storage modes";
      idle = false;
      const images = [{ type: "image", data: "fixture", mimeType: "image/png" }];
      const binding = (await hook("input", { source: "rpc", text: input, images })) as { text: string; images: unknown };
      assert(binding.text.includes("<omo-ulw-research-mode>"));
      assert(binding.text.includes("<omo-ulw-research-companions>"));
      assert.equal(binding.images, images);
      await command("ulw-research", input);
      assert(requests.at(-1));
      assert(
        binding.text.startsWith(requests.at(-1) as string),
        "command and binding input must use the same procedure/assets payload builder",
      );
      assert.equal(messages.length, 0, "binding a queued research input must not steer running work");
      assert.equal(await hook("input", { source: "extension", text: input }), undefined);
      assert.equal(await hook("input", { source: "user", text: "/ulw-plan" }), undefined);
      return;
    }
    if (name === "busy-input") {
      idle = false;
      const images = [{ type: "image", data: "fixture", mimeType: "image/png" }];
      const first = (await hook("input", { source: "user", text: "ulw fix the parser", images })) as { text: string; images: unknown };
      assert(first.text.startsWith("ulw fix the parser\n\n<ultrawork-mode>"));
      assert.equal(first.images, images);
      const second = (await hook("input", { source: "user", text: "ulw add the regression" })) as { text: string };
      assert(second.text.startsWith("ulw add the regression\n\n<omo-ultrawork-reminder>"));
      await hook("session_compact");
      const compacted = (await hook("input", { source: "user", text: "ulw continue" })) as { text: string };
      assert(compacted.text.startsWith("ulw continue\n\n<ultrawork-mode>"));
      idle = true;
      const last = (await hook("input", { source: "user", text: "ulw finish" })) as { text: string };
      assert(last.text.startsWith("ulw finish\n\n<omo-ultrawork-reminder>"));
      assert.equal(messages.length, 0, "queued input must not send an aside into currently running work");
      assert.deepEqual((await snapshot()).state, payload(false, true));
      return;
    }
    if (name === "todo-reminder") {
      const todo = (op: string, isError = false, toolName = "todo") => hook("tool_result", { toolName, input: { op }, isError });
      assert.equal(await todo("init"), undefined);
      manager.appendCustomMessageEntry("wows-omp-omo-ultrawork.fanout-reminder", "Legacy fan-out reminder", false);
      await hook("session_tree");
      assert.equal((await snapshot()).state, null);
      await hook("input", { source: "user", text: "ulw fix the parser" });
      const messageCount = messages.length;
      assert.equal(await todo("init", true), undefined);
      assert.equal(await todo("start"), undefined);
      assert.equal(await todo("init", false, "task"), undefined);
      const result = (await todo("append")) as { additionalContext?: string } | undefined;
      assert(result);
      assert(result.additionalContext?.includes("COMPUTE the fan-out decision"));
      assert.deepEqual(Object.keys(result), ["additionalContext"]);
      assert.equal(messages.length, messageCount, "the reminder must not enqueue an aside message");
      assert.equal(await todo("init"), undefined);
      await hook("session_switch");
      assert.equal(await todo("append"), undefined, "the sent flag must survive resume");
      await hook("session_compact");
      await hook("input", { source: "user", text: "ulw continue" });
      assert.deepEqual(await todo("init"), result, "compaction rearms the fan-out reminder");
      return;
    }
    const initial = await snapshot();
    assert.equal(initial.state, null);
    assert.deepEqual(Object.keys(initial).sort(), ["plugin", "schema", "seq", "sessionId", "state", "updatedAt", "version"]);
    assert.equal(initial.schema, "wows-omp-plugins/plugin-state");
    assert.equal(initial.version, 1);
    assert.equal(initial.plugin, "omo-ultrawork");
    assert.equal(initial.sessionId, manager.getSessionId());
    assert.equal(initial.seq, 1);
    assert(Number.isFinite(Date.parse(initial.updatedAt)));
    await command("hyperplan");
    await command("ulw-research");
    await command("ulw", "orchestrate the migration");
    assert.equal((await snapshot()).state, null);
    const feedback = () => (ctx.hasUI ? notices : messages.filter((message) => message.display).map((message) => message.content));
    assert.deepEqual(feedback().slice(0, 2), ["Usage: /hyperplan <request>", "Usage: /ulw-research <request>"]);
    assert(feedback()[2]?.startsWith("Ultrawork mode not enabled:"));
    await command("ultrawork");
    const enabled = await snapshot();
    assert.deepEqual(enabled.state, payload(true, false));
    assert(enabled.seq > initial.seq);
    const transformed = (await hook("input", { source: "user", text: "continue the work" })) as { text: string };
    assert(transformed.text.includes("<ultrawork-mode>"));
    assert.deepEqual((await snapshot()).state, payload(true, true));
    await hook("input", { source: "user", text: "orchestrate this" });
    assert(feedback().some((text) => text.startsWith("Ultrawork skipped for this message:")));
    await command("ulw");
    assert.deepEqual((await snapshot()).state, null);
    assert(feedback().includes("Ultrawork mode on"));
    assert(feedback().includes("Ultrawork mode off"));
    await hook("input", { source: "user", text: "ulw fix the parser" });
    assert.deepEqual((await snapshot()).state, payload(false, true));
    await hook("session_compact");
    await hook("input", { source: "user", text: "ulw continue" });
    assert.deepEqual((await snapshot()).state, payload(false, true));
    const previous = stateFile();
    manager = SessionManager.create(cwd, join(root, "sessions"));
    await hook("session_switch");
    assert.deepEqual(JSON.parse(await readFile(previous, "utf8")).state, payload(false, true));
    assert.equal((await snapshot()).state, null);
    manager.appendCustomEntry("wows-omp-omo-ultrawork.state", { version: 1, armed: true });
    await hook("session_tree");
    assert.deepEqual((await snapshot()).state, payload(false, true));
    await command("ultrawork", "fix the parser");
    assert.deepEqual((await snapshot()).state, payload(true, true));
    assert.deepEqual(requests, ["fix the parser"]);
    await hook("session_shutdown");
    assert.deepEqual(JSON.parse(await readFile(stateFile(), "utf8")).state, payload(true, true));
    if (ctx.hasUI) assert.equal(messages.filter((message) => message.display).length, 0);
    else {
      assert.equal(notices.length, 0);
      assert(messages.filter((message) => message.display).every((message) => message.attribution === "agent"));
    }
    AgentRegistry.resetGlobalForTests();
    manager = SessionManager.create(cwd, join(root, "sessions"));
    await hook("session_start");
    await command("ulw");
    await hook("input", { source: "user", text: "ulw continue" });
    await hook("session_shutdown");
    assert.equal(await Bun.file(stateFile()).exists(), false, "non-main sessions must not publish workflow state");
    assert(feedback().includes("ultrawork runs in the main session only"));
    assert.deepEqual(warnings, []);
  } finally {
    await hook("session_shutdown");
    AgentRegistry.resetGlobalForTests();
  }
}

if (process.env[CHILD_ENV]) {
  await scenario(process.env[CHILD_ENV] as string, process.env.ULTRAWORK_EXTENSION_ROOT as string);
  console.log("ULTRAWORK_EXTENSION_OK");
} else {
  // bun:test cannot load in the executable child; this intentionally exercises an isolated module-loading boundary.
  const { describe, expect, test } = await import("bun:test");
  describe("ultrawork command feedback and session state projection", () => {
    for (const name of ["headless", "tui", "rpc", "publish-failure", "busy-input", "todo-reminder", "pointers"]) {
      test(name, async () => {
        const root = await mkdtemp(join(tmpdir(), "ultrawork-extension-"));
        try {
          const child = Bun.spawn([process.execPath, THIS_FILE], {
            env: {
              ...process.env,
              [CHILD_ENV]: name,
              ULTRAWORK_EXTENSION_ROOT: root,
              HOME: root,
              XDG_RUNTIME_DIR: join(root, "run"),
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
          expect(stdout).toContain("ULTRAWORK_EXTENSION_OK");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 20_000);
    }
  });
}
