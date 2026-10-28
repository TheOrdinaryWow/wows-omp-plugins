import assert from "node:assert/strict";
import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { COMMENT_CHECKER_PACKAGE, registerCommentChecker } from "../plugins/omo-toolkit/src/comment-checker.ts";
import { checkerTargets } from "../plugins/omo-toolkit/src/comment-checker-input.ts";
import {
  CHECKER_KILL_GRACE_MS,
  CHECKER_TIMEOUT_MS,
  type CheckerInput,
  runCommentChecker,
} from "../plugins/omo-toolkit/src/comment-checker-runner.ts";
import { DEFAULT_SETTINGS, parseToolkitSettings, TOOLKIT_PACKAGE } from "../plugins/omo-toolkit/src/settings.ts";

const CHILD_ENV = "TOOLKIT_CHECKER_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
const ENTRY = fileURLToPath(new URL("../plugins/omo-toolkit/src/index.ts", import.meta.url));

function context(root: string, id = "checker-session"): ExtensionContext {
  return {
    cwd: root,
    hasUI: false,
    sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
}

function result(toolName: string, details: unknown, input: Record<string, unknown> = {}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: crypto.randomUUID(),
    toolName,
    input,
    details,
    content: [{ type: "text", text: "original result" }],
    isError: false,
  };
}

async function executable(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}

async function scenario(name: string, root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  if (name === "boundaries") {
    const ctx = context(root);
    const first = join(root, "first.ts");
    const moved = join(root, "renamed.ts");
    await writeFile(first, "// formatted final file\nexport const a = 1;\n");
    await writeFile(moved, "// renamed\nexport const b = 2;\n");
    const write = await checkerTargets(result("write", { resolvedPath: first }, { path: "first.ts", content: "raw input" }), ctx);
    assert.equal(write[0]?.input.tool_input.content, await readFile(first, "utf8"));
    assert.equal(write[0]?.scope, "file-wide write");
    const edit = await checkerTargets(
      result("edit", {
        perFileResults: [
          { path: first, oldText: "old", newText: "new", op: "update" },
          { path: moved, sourcePath: "old.ts", move: moved, snapshotsPruned: true },
          { path: "gone.ts", op: "delete" },
        ],
      }),
      ctx,
    );
    assert.equal(edit.length, 2);
    assert.equal(edit[0]?.input.tool_input.old_string, "old");
    assert.equal(edit[0]?.input.tool_input.new_string, "new");
    assert.match(edit[1]?.scope ?? "", /file-wide fallback.*may predate/);
    const ast = await checkerTargets(
      result(
        "write",
        {
          xdev: {
            tool: "resolve",
            mode: "execute",
            inner: { action: "apply", sourceToolName: "ast_edit", sourceResultDetails: { applied: true, files: [first] } },
          },
        },
        { path: "xd://resolve" },
      ),
      ctx,
    );
    assert.equal(ast[0]?.path, first);
    assert.match(ast[0]?.scope ?? "", /file-wide fallback/);
    assert.deepEqual(await checkerTargets(result("ast_edit", { applied: false, files: [first] }), ctx), []);
    assert.deepEqual(
      await checkerTargets(result("apply_patch", { path: first, oldText: "before", newText: "after" }), ctx).then((targets) =>
        targets.map((target) => target.path),
      ),
      [first],
    );
    for (const path of ["xd://anything", "agent://Main", "proc://1", "local://scratch.ts", "archive.zip:member.ts", "state.db:table"]) {
      assert.deepEqual(await checkerTargets(result("write", { resolvedPath: first }, { path }), ctx), []);
    }
    assert.deepEqual(await checkerTargets({ ...result("edit", { path: first }), isError: true }, ctx), []);
    assert.deepEqual(
      await checkerTargets(
        result("write", { xdev: { tool: "lsp", mode: "execute", inner: { success: true } } }, { path: "xd://lsp" }),
        ctx,
      ),
      [],
    );
    assert.deepEqual(await checkerTargets(result("edit", { path: first, oldText: "same", newText: "same" }), ctx), []);
    const warnings: string[] = [];
    const parsed = parseToolkitSettings(
      { commentChecker: true, commentCheckerPath: 7, initDeepAdvisor: "true", fallbackArchitect: true },
      (text) => warnings.push(text),
    );
    assert.equal(parsed.commentChecker, false);
    assert.equal(parsed.initDeepAdvisor, false);
    assert.equal(parsed.fallbackArchitect, true);
    assert.equal(warnings.length, 2);
    console.log(
      "CHECKER_BOUNDARIES_OK: write final bytes; multi-file/rename/delete; snapshot fallback; AST resolution; protocol exclusion; isolated settings errors",
    );
    return;
  }
  if (name === "process") {
    const input: CheckerInput = {
      session_id: "runner",
      transcript_path: "",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "write",
      tool_input: { file_path: join(root, "a.ts"), content: "// comment\n" },
    };
    for (const [code, kind] of [
      [0, "clean"],
      [2, "findings"],
      [3, "failed"],
    ] as const) {
      const path = await executable(
        root,
        `checker-${code}`,
        `await Bun.stdin.text(); console.error("untrusted findings"); process.exit(${code});`,
      );
      assert.equal((await runCommentChecker([path], input)).kind, kind);
    }
    assert.equal((await runCommentChecker([join(root, "missing")], input)).kind, "failed");
    const noPermission = join(root, "no-permission");
    await writeFile(noPermission, "not executable", { mode: 0o600 });
    assert.equal((await runCommentChecker([noPermission], input)).kind, "failed");
    const earlyExit = await executable(root, "early-exit", "process.stdin.destroy(); process.exit(2);");
    const largeInput = { ...input, tool_input: { ...input.tool_input, content: "x".repeat(2_000_000) } };
    assert.equal((await runCommentChecker([earlyExit], largeInput)).kind, "failed");
    // This integration case deliberately exercises real process deadlines and SIGKILL, not a guessed async wait.
    const hung = await executable(root, "hung", "process.on('SIGTERM', () => {}); await Bun.stdin.text(); setInterval(() => {}, 1000);");
    const start = Date.now();
    const timed = await runCommentChecker([hung], input, { timeoutMs: 100, killGraceMs: 50 });
    assert.equal(timed.kind, "failed");
    assert(timed.kind === "failed" && timed.message.includes("timed out"));
    assert(Date.now() - start < 2_000, "SIGKILL grace must terminate a checker ignoring SIGTERM");
    console.log("CHECKER_PROCESS_OK: 0/2/nonprotocol; ENOENT/EACCES; EPIPE; timeout plus forced termination");
    return;
  }
  if (name === "sessions") {
    type Hook = (event: ToolResultEvent | { type: string }, ctx: ExtensionContext) => unknown;
    const hooks = new Map<string, Hook[]>();
    const warnings: string[] = [];
    const api = {
      on: (event: string, handler: Hook) => hooks.set(event, [...(hooks.get(event) ?? []), handler]),
      logger: { warn: (text: string) => warnings.push(text) },
    } as unknown as ExtensionAPI;
    let enabled = false;
    const log = join(root, "runs.jsonl");
    const checker = await executable(
      root,
      "checker",
      `import { appendFileSync } from "node:fs"; const input = JSON.parse(await Bun.stdin.text()); appendFileSync(${JSON.stringify(log)}, JSON.stringify(input)+"\\n"); if(input.tool_input.content?.includes("bad")) {console.error("RAW_UNTRUSTED_CHECKER_TEXT"); process.exit(2);}`,
    );
    let configuredPath = checker;
    registerCommentChecker(api, () => ({ ...DEFAULT_SETTINGS, commentChecker: enabled, commentCheckerPath: configuredPath }));
    const emit = async (event: string, payload: ToolResultEvent | { type: string }, ctx: ExtensionContext) => {
      let output: unknown;
      for (const hook of hooks.get(event) ?? []) output = await hook(payload, ctx);
      return output as { content: Array<{ text: string }>; additionalContext: string } | undefined;
    };
    const ctx = context(root);
    await emit("session_start", { type: "session_start" }, ctx);
    assert(!hooks.has("tool_result"), "default off must leave speculation untouched");
    enabled = true;
    await emit("session_switch", { type: "session_switch" }, ctx);
    const path = join(root, "source.ts");
    await writeFile(path, "clean");
    const event = result("write", { resolvedPath: path }, { path });
    assert.equal(await emit("tool_result", event, ctx), undefined);
    await writeFile(path, "bad comment");
    const feedback = await emit("tool_result", event, ctx);
    assert(feedback?.content.at(-1)?.text.includes("RAW_UNTRUSTED_CHECKER_TEXT"));
    assert(!feedback?.additionalContext.includes("RAW_UNTRUSTED_CHECKER_TEXT"));
    assert.deepEqual(event.content, [{ type: "text", text: "original result" }]);
    assert.equal(await emit("tool_result", event, ctx), undefined);
    await emit("tool_result", event, context(root, "second-session"));
    await emit("turn_start", { type: "turn_start" }, ctx);
    await emit("tool_result", event, ctx);
    assert.equal(
      (await readFile(log, "utf8")).trim().split("\n").length,
      4,
      "clean checks may rerun; reports dedupe per actual session and turn",
    );
    assert.deepEqual(warnings, []);
    configuredPath = join(root, "missing-checker");
    const failedContext = context(root, "missing-binary");
    const unavailable = await emit("tool_result", event, failedContext);
    assert(unavailable?.content.at(-1)?.text.includes("file not checked"));
    assert.equal(await emit("tool_result", event, failedContext), undefined);
    assert.equal(warnings.length, 1, "an unavailable binary disables checking and warns only once per session");
    console.log(
      "CHECKER_DEDUPE_OK: disabled hook absent; clean reruns; feedback once per turn; separate sessions; raw findings stay out of trusted context",
    );
    return;
  }
  if (name === "budget") {
    type Hook = (event: ToolResultEvent | { type: string }, ctx: ExtensionContext) => unknown;
    const hooks = new Map<string, Hook[]>();
    const warnings: string[] = [];
    const api = {
      on: (event: string, hook: Hook) => hooks.set(event, [...(hooks.get(event) ?? []), hook]),
      logger: { warn: (text: string) => warnings.push(text) },
    } as unknown as ExtensionAPI;
    const readyPath = join(root, "checker-ready");
    const log = join(root, "budget-runs.jsonl");
    const checker = await executable(
      root,
      "budget-checker",
      `
      import { appendFileSync, renameSync, watch, writeFileSync } from "node:fs";
      const released = Promise.withResolvers();
      const held = watch(${JSON.stringify(root)}, () => {});
      process.on("SIGUSR2", released.resolve);
      appendFileSync(${JSON.stringify(log)}, await Bun.stdin.text() + "\\n");
      writeFileSync(${JSON.stringify(`${readyPath}.tmp`)}, String(process.pid));
      renameSync(${JSON.stringify(`${readyPath}.tmp`)}, ${JSON.stringify(readyPath)});
      await released.promise;
      held.close();
      console.error("QUEUED_BUDGET_FINDING");
      process.exit(2);
    `,
    );
    registerCommentChecker(api, () => ({ ...DEFAULT_SETTINGS, commentChecker: true, commentCheckerPath: checker }));
    const emit = async (event: string, payload: ToolResultEvent | { type: string }) => {
      let output: unknown;
      for (const hook of hooks.get(event) ?? []) output = await hook(payload, context(root));
      return output as { content: Array<{ text: string }>; additionalContext: string } | undefined;
    };
    const firstPath = join(root, "first.ts");
    const secondPath = join(root, "second.ts");
    await writeFile(firstPath, "// first\n");
    await writeFile(secondPath, "// second\n");
    await emit("session_start", { type: "session_start" });
    const ready = Promise.withResolvers<void>();
    const watcher = watch(root, (_event, file) => {
      if (file === "checker-ready") ready.resolve();
    });
    const originalNow = performance.now;
    let clock = 0;
    let pid: number | undefined;
    performance.now = () => clock;
    try {
      assert.equal(CHECKER_TIMEOUT_MS, 20_000);
      assert.equal(CHECKER_KILL_GRACE_MS, 1_000);
      const first = emit("tool_result", result("write", { resolvedPath: firstPath }, { path: firstPath }));
      await ready.promise;
      pid = Number(await readFile(readyPath, "utf8"));
      const second = emit("tool_result", result("write", { resolvedPath: secondPath }, { path: secondPath }));
      // Advance only the elapsed-time source: no wall-clock sleep or guessed process-start delay.
      clock = 9_000;
      process.kill(pid, "SIGUSR2");
      assert((await first)?.content.at(-1)?.text.includes("QUEUED_BUDGET_FINDING"));
      const skipped = await second;
      assert(skipped?.content.at(-1)?.text.includes("Insufficient result-handler budget"));
      assert.equal(skipped?.content[0]?.text, "original result");
      assert.equal(
        (await readFile(log, "utf8")).trim().split("\n").length,
        1,
        "the queued checker must not start without its full timeout and kill grace",
      );
      assert.equal(await emit("tool_result", result("write", { resolvedPath: secondPath }, { path: secondPath })), undefined);
      assert.equal(warnings.length, 1, "budget exhaustion uses the same one-warning, session-inert failure path");
      console.log(
        "CHECKER_BUDGET_OK: 20s process cap + 1s grace; simulated 9s queue wait skips second launch within 29s result budget; first findings retained; one warning only",
      );
    } finally {
      performance.now = originalNow;
      watcher.close();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* The checker normally exited before cleanup. */
        }
      }
    }
    return;
  }
  if (name === "bunx") {
    type Hook = (event: ToolResultEvent | { type: string }, ctx: ExtensionContext) => unknown;
    const register = (sessionId: string) => {
      const hooks = new Map<string, Hook[]>();
      const warnings: string[] = [];
      const notices: string[] = [];
      const api = {
        on: (event: string, hook: Hook) => hooks.set(event, [...(hooks.get(event) ?? []), hook]),
        logger: { warn: (text: string) => warnings.push(text), info: (text: string) => notices.push(text) },
      } as unknown as ExtensionAPI;
      registerCommentChecker(api, () => ({ ...DEFAULT_SETTINGS, commentChecker: true, commentCheckerPath: "" }));
      const emit = async (event: string, payload: ToolResultEvent | { type: string }) => {
        let output: unknown;
        for (const hook of hooks.get(event) ?? []) output = await hook(payload, context(root, sessionId));
        return output as { content: Array<{ text: string }> } | undefined;
      };
      return { emit, warnings, notices };
    };
    const bin = join(root, "bin");
    await mkdir(bin);
    const log = join(root, "bun-argv.jsonl");
    const readyPath = join(root, "warm-up-ready");
    const failFlag = join(root, "fail-warm-up");
    // A stand-in for Bun on PATH: records argv, holds the warm-up until SIGUSR2, then speaks the checker protocol.
    await executable(
      bin,
      "bun",
      `
      import { appendFileSync, existsSync, renameSync, watch, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
      if (args.at(-1) === "--help") {
        if (existsSync(${JSON.stringify(failFlag)})) { console.error("ConnectionRefused downloading package manifest"); process.exit(1); }
        const released = Promise.withResolvers();
        const held = watch(${JSON.stringify(root)}, () => {});
        process.on("SIGUSR2", released.resolve);
        writeFileSync(${JSON.stringify(`${readyPath}.tmp`)}, String(process.pid));
        renameSync(${JSON.stringify(`${readyPath}.tmp`)}, ${JSON.stringify(readyPath)});
        await released.promise;
        held.close();
        process.exit(0);
      }
      const input = JSON.parse(await Bun.stdin.text());
      if (input.tool_input.content?.includes("//")) { console.error("BUNX_FINDING"); process.exit(2); }
    `,
    );
    const originalPath = process.env.PATH;
    const originalNow = performance.now;
    process.env.PATH = `${bin}:${originalPath}`;
    const ready = Promise.withResolvers<void>();
    const watcher = watch(root, (_event, file) => {
      if (file === "warm-up-ready") ready.resolve();
    });
    let pid: number | undefined;
    try {
      const path = join(root, "a.ts");
      await writeFile(path, "// explain\n");
      const edit = () => result("write", { resolvedPath: path }, { path });
      const pending = register("bunx-pending");
      await pending.emit("session_start", { type: "session_start" });
      await ready.promise;
      pid = Number(await readFile(readyPath, "utf8"));
      // The handler reads the clock for its deadline, then the check sees 10s gone: no window left to wait for the download.
      for (let skipped = 0; skipped < 2; skipped++) {
        let reads = 0;
        performance.now = () => (reads++ === 0 ? 0 : 10_000);
        assert.equal(await pending.emit("tool_result", edit()), undefined, "an edit is skipped while the download outlasts the budget");
        performance.now = originalNow;
      }
      assert.equal(pending.notices.length, 1, "the download notice is shown once");
      assert.deepEqual(pending.warnings, [], "a pending download does not disable checking");
      const checked = pending.emit("tool_result", edit());
      process.kill(pid, "SIGUSR2");
      assert((await checked)?.content.at(-1)?.text.includes("BUNX_FINDING"), "a check waits for a download that finishes within budget");
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls, [
        ["x", COMMENT_CHECKER_PACKAGE, "--help"],
        ["x", COMMENT_CHECKER_PACKAGE, "check"],
      ]);

      await writeFile(failFlag, "");
      const failed = register("bunx-failed");
      await failed.emit("session_start", { type: "session_start" });
      const warned = await failed.emit("tool_result", edit());
      assert(warned?.content.at(-1)?.text.includes("ConnectionRefused"));
      assert.equal(await failed.emit("tool_result", edit()), undefined);
      assert.equal(failed.warnings.length, 1, "a failed download warns once and disables checking for the session");
      console.log(
        "CHECKER_BUNX_OK: pinned bun x warm-up; over-budget skip with one notice; in-budget wait then check; failed download warns once",
      );
    } finally {
      performance.now = originalNow;
      process.env.PATH = originalPath;
      watcher.close();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* The stand-in normally exited after release. */
        }
      }
    }
    return;
  }
  // Host imports deliberately occur inside the executable child after isolated HOME/agent-dir setup.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  await initTheme();
  const bin = join(root, "bin");
  await mkdir(bin);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const log = join(root, "sdk-checks.jsonl");
  await executable(
    bin,
    "configured-checker",
    `import { appendFileSync } from "node:fs"; const input=JSON.parse(await Bun.stdin.text()); appendFileSync(${JSON.stringify(log)}, JSON.stringify(input)+"\\n"); console.error("SDK_CHECKER_FINDING"); process.exit(2);`,
  );
  await mkdir(join(root, ".omp"));
  await writeFile(
    join(root, ".omp", "plugin-overrides.json"),
    JSON.stringify({
      settings: { [TOOLKIT_PACKAGE]: { commentChecker: true, commentCheckerPath: "configured-checker", initDeepAdvisor: false } },
    }),
  );
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.create(root, join(root, "sessions")),
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false, "edit.mode": "replace" }),
    toolNames: ["read", "write", "edit"],
    additionalExtensionPaths: [ENTRY],
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
  });
  try {
    assert(!session.extensionRunner?.hasHandlers("tool_result"), "disabled-at-load hook must be absent before session_start");
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
    assert(runner.hasHandlers("tool_result"), "late registration must be visible to the real runner");
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    const edit = session.getToolByName("edit");
    assert(edit);
    const first = await edit.execute("sdk-edit-1", { path: "source.ts", old_string: "value = 1", new_string: "value = 2" });
    assert(!first.isError);
    assert(first.content.some((block) => block.type === "text" && block.text.includes("SDK_CHECKER_FINDING")));
    const second = await edit.execute("sdk-edit-2", { path: "source.ts", old_string: "value = 2", new_string: "value = 3" });
    assert(!second.content.some((block) => block.type === "text" && block.text.includes("SDK_CHECKER_FINDING")));
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
    const recorded: CheckerInput = JSON.parse((await readFile(log, "utf8")).trim());
    assert.equal(recorded.tool_name, "edit");
    assert(recorded.tool_input.old_string?.includes("value = 1"));
    console.log(
      "SDK_CHECKER_OK: real native edit result received one finding; second same-turn edit received none; configured executable resolved through PATH; exact old/new snapshots delivered",
    );
  } finally {
    await session.dispose();
  }
}

if (process.env[CHILD_ENV]) {
  await scenario(process.env[CHILD_ENV] as string, process.env.TOOLKIT_CHECKER_ROOT as string);
} else {
  const { describe, expect, test } = await import("bun:test");
  describe("omo-toolkit native comment-checker integration", () => {
    for (const name of ["boundaries", "process", "sessions", "budget", "bunx", "sdk"]) {
      test(name, async () => {
        const root = await mkdtemp(join(tmpdir(), "toolkit-checker-"));
        try {
          const child = Bun.spawn([process.execPath, THIS_FILE], {
            env: { ...process.env, [CHILD_ENV]: name, TOOLKIT_CHECKER_ROOT: root, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") },
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
