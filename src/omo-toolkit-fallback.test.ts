import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { registerFallbackArchitect } from "../plugins/omo-toolkit/src/fallback-architect.ts";
import { DEFAULT_SETTINGS, TOOLKIT_PACKAGE } from "../plugins/omo-toolkit/src/settings.ts";

const CHILD_ENV = "TOOLKIT_FALLBACK_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
const ENTRY = fileURLToPath(new URL("../plugins/omo-toolkit/src/index.ts", import.meta.url));

function message(model = "source", stopReason: "error" | "stop" = "error", refusal = true): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "toolkit-fixture-api",
    provider: "toolkit-fixture",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === "error"
      ? {
          errorMessage: refusal ? "Provider classifier refusal" : "Connection failed",
          stopDetails: { type: refusal ? "refusal" : "error" },
        }
      : {}),
    timestamp: Date.now(),
  };
}

async function scenario(name: string, root: string): Promise<void> {
  if (name === "correlation") {
    type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
    const hooks = new Map<string, Hook[]>();
    let enabled = true;
    let roster = true;
    const ctx = {
      agent: { kind: "main" },
      model: { provider: "toolkit-fixture", id: "target" },
      sessionManager: { getSessionId: () => "fallback" },
    } as unknown as ExtensionContext;
    const pi = {
      on: (event: string, hook: Hook) => hooks.set(event, [...(hooks.get(event) ?? []), hook]),
      getActiveTools: () => ["task"],
      getAllTools: () => [
        {
          name: "task",
          description: roster ? "# Available Agents\n- `architect`: Read-only review" : "# Available Agents\n- `task`: General work",
        },
      ],
    } as unknown as ExtensionAPI;
    registerFallbackArchitect(pi, () => ({ ...DEFAULT_SETTINGS, fallbackArchitect: enabled }));
    const emit = async (name: string, event: Record<string, unknown> = {}) => {
      let result: unknown;
      for (const hook of hooks.get(name) ?? []) result = await hook({ type: name, ...event }, ctx);
      return result as { messages: Array<{ role: string; content: string }> } | undefined;
    };
    const refusal = () => emit("message_end", { message: message() });
    const applied = (extra: Record<string, unknown> = {}) =>
      emit("retry_fallback_applied", {
        from: "toolkit-fixture/source:high",
        to: "toolkit-fixture/target:low",
        role: "default",
        reason: "RAW_REFUSAL_REASON",
        ...extra,
      });
    const context = () => emit("context", { messages: [] });
    await refusal();
    assert.equal(await context(), undefined, "refusal alone cannot inject anything");
    await applied();
    const hint = await context();
    assert.equal(hint?.messages.length, 1);
    assert.equal(hint?.messages[0]?.role, "developer");
    assert(hint?.messages[0]?.content.includes("architect"));
    assert(!hint?.messages[0]?.content.includes("RAW_REFUSAL_REASON"));
    assert.equal(await context(), undefined);
    await emit("retry_fallback_succeeded", { model: "toolkit-fixture/target", role: "default" });
    assert.equal(await context(), undefined);
    await applied();
    assert.equal(await context(), undefined, "fallback without pending typed refusal is unrelated");
    for (const variant of [
      "ordinary-error",
      "success-before-fallback",
      "source-mismatch",
      "target-mismatch",
      "no-architect",
      "user-input",
      "switch",
      "disabled",
      "subagent",
    ]) {
      await emit("session_start");
      enabled = variant !== "disabled";
      roster = variant !== "no-architect";
      Object.assign(ctx, { agent: { kind: variant === "subagent" ? "sub" : "main" } });
      if (variant === "ordinary-error") await emit("message_end", { message: message("source", "error", false) });
      else await refusal();
      if (variant === "success-before-fallback") await emit("message_end", { message: message("source", "stop") });
      if (variant === "user-input") await emit("input", { source: "interactive", text: "new request" });
      if (variant === "switch") await emit("session_switch");
      await applied(
        variant === "source-mismatch"
          ? { from: "other/source" }
          : variant === "target-mismatch"
            ? { to: "other/target", role: "smol" }
            : {},
      );
      assert.equal(await context(), undefined, variant);
    }
    console.log(
      "FALLBACK_CORRELATION_OK: typed refusal plus matching primary fallback; one-shot context; no success rearm; ordinary/unrelated/advisor/subagent/disabled/reset exclusions",
    );
    return;
  }

  // SDK/provider imports intentionally load only after this executable child's isolated HOME is installed.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { AssistantMessageEventStream } = await import("@oh-my-pi/pi-ai/utils/event-stream");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  await initTheme();
  await mkdir(join(root, ".omp", "agents"), { recursive: true });
  await writeFile(
    join(root, ".omp", "agents", "architect.md"),
    await readFile(fileURLToPath(new URL("../plugins/omo-toolkit/agents/architect.md", import.meta.url)), "utf8"),
  );
  await writeFile(
    join(root, ".omp", "plugin-overrides.json"),
    JSON.stringify({ settings: { [TOOLKIT_PACKAGE]: { fallbackArchitect: true, initDeepAdvisor: false } } }),
  );
  const requests: Array<{ model: string; messages: Context["messages"] }> = [];
  const events: string[] = [];
  const settings = Settings.isolated({
    "tools.approvalMode": "yolo",
    "autolearn.enabled": false,
    "retry.enabled": true,
    "retry.modelFallback": true,
    "retry.maxRetries": 0,
    "retry.baseDelayMs": 0,
    "retry.fallbackChains": { default: ["toolkit-fixture/target"] },
  });
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.create(root, join(root, "sessions")),
    settings,
    modelPattern: "toolkit-fixture/source",
    toolNames: ["read", "task"],
    additionalExtensionPaths: [ENTRY],
    disableExtensionDiscovery: true,
    extensions: [
      (pi) =>
        pi.registerProvider("toolkit-fixture", {
          api: "toolkit-fixture-api",
          baseUrl: "https://fixture.invalid",
          apiKey: "fixture-key",
          models: ["source", "target"].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8_192,
          })),
          streamSimple(model, context) {
            requests.push({ model: model.id, messages: structuredClone(context.messages) });
            const stream = new AssistantMessageEventStream();
            queueMicrotask(() => {
              if (model.id === "source") stream.push({ type: "error", reason: "error", error: message() });
              else {
                const final = {
                  ...message("target", "stop"),
                  content: [{ type: "text" as const, text: "The existing module boundary is appropriate." }],
                };
                stream.push({ type: "done", reason: "stop", message: final });
              }
            });
            return stream;
          },
        }),
    ],
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
    assert.deepEqual(extensionsResult.errors, []);
    const runner = session.extensionRunner;
    assert(runner);
    assert(
      extensionsResult.runtime
        .getAllTools()
        .find((tool) => tool.name === "task")
        ?.description.includes("architect"),
    );
    session.subscribe((event) => {
      events.push(event.type);
    });
    await runner.emit({ type: "session_start" });
    await session.prompt("Give a short high-level opinion about keeping an existing module boundary. No code changes are requested.");
    assert.deepEqual(
      requests.map((request) => request.model),
      ["source", "target"],
    );
    const hints = (requests[1]?.messages ?? []).filter(
      (message) => message.role === "developer" && typeof message.content === "string" && message.content.includes("design continuity"),
    );
    assert.equal(hints.length, 1, "the real automatic fallback request must receive exactly one engineering hint");
    assert(events.includes("retry_fallback_applied"));
    assert(events.includes("retry_fallback_succeeded"));
    assert.equal((await runner.emitContext([])).length, 0, "success cannot leave a persistent reminder");
    console.log(
      "SDK_FALLBACK_OK: real local provider refusal -> native retry_fallback_applied -> automatic target request with exactly one architect continuity hint -> retry_fallback_succeeded; no later hint",
    );
  } finally {
    await session.dispose();
  }
}

if (process.env[CHILD_ENV]) {
  await scenario(process.env[CHILD_ENV] as string, process.env.TOOLKIT_FALLBACK_ROOT as string);
} else {
  // bun:test cannot load in the executable child; tests intentionally cross the real SDK module boundary.
  const { describe, expect, test } = await import("bun:test");
  describe("omo-toolkit fallback architect continuity", () => {
    for (const name of ["correlation", "sdk"]) {
      test(name, async () => {
        const root = await mkdtemp(join(tmpdir(), "toolkit-fallback-"));
        try {
          const child = Bun.spawn([process.execPath, THIS_FILE], {
            env: { ...process.env, [CHILD_ENV]: name, TOOLKIT_FALLBACK_ROOT: root, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(code, stderr).toBe(0);
          console.log(stdout.trim());
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  });
}
