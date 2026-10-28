import assert from "node:assert/strict";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

import { registerInitDeepAdvisor } from "../plugins/omo-toolkit/src/init-deep-advisor.ts";
import {
  COOLDOWN_MS,
  computeProposal,
  driftProposal,
  git,
  gitRepository,
  MS_PER_DAY,
  parseChurn,
  projectMetrics,
  type SnapshotFields,
} from "../plugins/omo-toolkit/src/init-deep-metrics.ts";
import {
  advisorPaths,
  readAdvisorState,
  readGlobalState,
  readSnapshot,
  updateAdvisorState,
  writeState,
} from "../plugins/omo-toolkit/src/init-deep-state.ts";
import { DEFAULT_SETTINGS } from "../plugins/omo-toolkit/src/settings.ts";

const CHILD_ENV = "TOOLKIT_ADVISOR_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
const ENTRY = fileURLToPath(new URL("../plugins/omo-toolkit/src/index.ts", import.meta.url));

async function repository(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await git(root, ["init", "--initial-branch=main"]);
  for (let index = 0; index < 8; index += 1)
    await writeFile(join(root, "src", `file-${index}.ts`), `export const value${index} = ${index};\n`);
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial fixture"]);
}

async function scenario(name: string, root: string): Promise<void> {
  // Host module loading may provision files under HOME; keep those outside the Git fixture inventory.
  root = join(root, "workspace");
  await repository(root);
  const repo = await gitRepository(root);
  assert(repo);
  if (name === "metrics") {
    const metrics = await projectMetrics(root);
    assert.equal(metrics.tracked.length, 8);
    assert.equal(metrics.loc, 8);
    assert.deepEqual(await metrics.coverage(), { candidateDirs: 1, coveredDirs: 0, missingRatio: 1 });
    assert.equal((await computeProposal(repo, null, metrics))?.trigger, "coverage-gap");
    await writeFile(join(root, "AGENTS.md"), "Root coverage\n");
    assert.deepEqual(await (await projectMetrics(root)).coverage(), { candidateDirs: 1, coveredDirs: 1, missingRatio: 0 });
    assert.equal(await computeProposal(repo, null, await projectMetrics(root)), null);
    const baseline: SnapshotFields = { commitSha: repo.head, fileCount: 999, loc: 999, timestamp: Date.now(), mode: "local" };
    assert.equal(await computeProposal(repo, baseline, metrics), null);
    assert.equal((await computeProposal(repo, { ...baseline, timestamp: Date.now() - 90 * MS_PER_DAY }, metrics))?.trigger, "snapshot-age");
    assert.equal((await computeProposal(repo, { ...baseline, commitSha: "f".repeat(40) }, metrics))?.trigger, "snapshot-invalid");
    assert.equal((await computeProposal(repo, "invalid", metrics))?.trigger, "snapshot-invalid");
    const below = { commitsSince: 29, touchedRatio: 0.15, churnLocRatio: 0.249, daysSince: 89.99 };
    assert.equal(driftProposal(below), null);
    assert.equal(driftProposal({ ...below, commitsSince: 30 })?.trigger, "commit-and-touch");
    assert.equal(driftProposal({ ...below, commitsSince: 30, touchedRatio: 0.149 }), null);
    assert.equal(driftProposal({ ...below, churnLocRatio: 0.25 })?.trigger, "loc-churn");
    assert.equal(driftProposal({ commitsSince: 30, touchedRatio: 0.15, churnLocRatio: 0.25, daysSince: 90 })?.trigger, "commit-and-touch");
    assert.equal(parseChurn(["1\t2\ta.ts", "-\t-\timage.bin", "0\t0\t", "old.ts", "new.ts", ""].join("\0")), 3);
    await git(root, ["mv", "src/file-0.ts", "src/renamed.ts"]);
    await writeFile(join(root, "src", "file-1.ts"), "export const changed = 1;\n// churn\n");
    await git(root, ["add", "."]);
    await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "drift fixture"]);
    const changed = await gitRepository(root);
    assert(changed);
    const drift = await computeProposal(changed, baseline, await projectMetrics(root));
    assert.equal(drift?.trigger, "loc-churn");
    assert(drift?.drift && "churnLocRatio" in drift.drift);
    assert.equal(
      drift.drift.churnLocRatio,
      3 / 9,
      "net rename carries zero churn; generated AGENTS.md is excluded; denominator uses current LOC",
    );
    await mkdir(join(root, "vendor", "generated"), { recursive: true });
    for (let index = 0; index < 8; index += 1) await writeFile(join(root, "vendor", "generated", `${index}.ts`), "ignored\n");
    await symlink(join(root, "src"), join(root, "linked"));
    assert.equal((await (await projectMetrics(root)).coverage())?.candidateDirs, 1);
    const tiny = join(root, "tiny");
    await mkdir(tiny);
    assert.equal(await (await projectMetrics(tiny)).coverage(), null, "no candidate directories means no proposal");
    const locScope = join(root, "loc-scope");
    await mkdir(join(locScope, "sub"), { recursive: true });
    await writeFile(join(locScope, "sub", "one.py"), "\n".repeat(499));
    assert.equal((await (await projectMetrics(locScope)).coverage())?.candidateDirs, 1, "500 direct LOC qualifies without eight files");
    console.log(
      "ADVISOR_METRICS_OK: coverage ancestors; exact threshold edges; net-diff rename/binary handling; excluded guide churn; stale SHA; current denominators",
    );
    return;
  }
  if (name === "state") {
    const paths = advisorPaths(repo);
    const initial = await readAdvisorState(paths.project);
    await writeState(paths.project, { ...initial, declined: true });
    await updateAdvisorState(paths.project, { lastProposedHead: repo.head, lastProposedAt: 123 });
    assert.equal((await readAdvisorState(paths.project)).declined, true);
    const fields: SnapshotFields = { commitSha: repo.head, fileCount: 8, loc: 8, timestamp: 123, mode: "local" };
    await writeState(paths.snapshot, { version: 1, ...fields });
    assert.deepEqual(await readSnapshot(paths.snapshot), { version: 1, ...fields });
    assert.equal((await stat(paths.snapshot)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(paths.snapshot))).mode & 0o777, 0o700);
    await mkdir(join(root, "session-artifacts"));
    const legacy = join(root, "session-artifacts", "snapshot.json");
    await writeFile(legacy, JSON.stringify(fields));
    const worktree = join(dirname(root), `${root.split("/").at(-1)}-linked`);
    try {
      await git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
      const linked = await gitRepository(worktree);
      assert(linked);
      const linkedPaths = advisorPaths(linked);
      assert.equal(paths.project, linkedPaths.project);
      assert.notEqual(paths.snapshot, linkedPaths.snapshot);
      assert.equal(await readSnapshot(linkedPaths.snapshot), null);
      assert.equal((await readAdvisorState(linkedPaths.project)).declined, true);
      await writeState(paths.global, { version: 1, declined: true, declinedAt: 456 });
      assert.equal((await readGlobalState(linkedPaths.global)).declined, true);
    } finally {
      await git(root, ["worktree", "remove", "--force", worktree]);
    }
    await writeFile(paths.snapshot, JSON.stringify({ version: 2, ...fields }));
    await assert.rejects(readSnapshot(paths.snapshot), /Unsupported.*preserved/);
    await writeFile(paths.project, "{invalid");
    await assert.rejects(updateAdvisorState(paths.project, { declined: false }), /Invalid.*preserved/);
    assert.equal(await readFile(paths.project, "utf8"), "{invalid");
    assert.deepEqual(JSON.parse(await readFile(legacy, "utf8")), fields);
    console.log(
      "ADVISOR_STATE_OK: private atomic v1 persistence; shared worktree Never; distinct snapshots; global Never; future/corrupt states preserved; legacy artifacts unchanged",
    );
    return;
  }
  if (name === "choices") {
    // The timer callback is captured and awaited, not driven by a wall-clock sleep.
    const { z } = await import("@oh-my-pi/pi-coding-agent");
    type Hook = (event: { type: string }, ctx: ExtensionContext) => unknown;
    const hooks = new Map<string, Hook[]>();
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const messages: Array<{ content: string; display: boolean }> = [];
    const warnings: string[] = [];
    let callbacks: Array<() => unknown> = [];
    let choice: string | undefined;
    let selects = 0;
    const paths = advisorPaths(repo);
    const ctx = {
      cwd: root,
      hasUI: true,
      mode: "rpc",
      agent: { kind: "main" },
      sessionManager: { getSessionId: () => "advisor" },
      setTimeout: (fn: () => unknown) => {
        callbacks.push(fn);
        return callbacks.length;
      },
      clearTimer: () => {
        callbacks = [];
      },
      ui: {
        select: async (_title: string, choices: string[], options: { timeout: number }) => {
          selects += 1;
          assert.deepEqual(choices, ["Run now", "Skip this time", "Never in this project", "Never anywhere"]);
          assert.equal(options.timeout, 60_000);
          return choice;
        },
        custom: () => {
          throw new Error("RPC must never use custom components");
        },
        notify: () => {},
      },
    } as unknown as ExtensionCommandContext;
    const api = {
      zod: z,
      on: (event: string, fn: Hook) => hooks.set(event, [...(hooks.get(event) ?? []), fn]),
      registerCommand: (command: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) =>
        commands.set(command, spec.handler),
      registerTool: () => {},
      appendEntry: () => {},
      sendMessage: (message: { content: string; display: boolean }) => messages.push(message),
      logger: { warn: (text: string) => warnings.push(text) },
    } as unknown as ExtensionAPI;
    registerInitDeepAdvisor(api, () => DEFAULT_SETTINGS);
    const start = async () => {
      for (const hook of hooks.get("session_start") ?? []) await hook({ type: "session_start" }, ctx);
      for (const callback of callbacks.splice(0)) await callback();
    };
    const command = async (arg: string) => {
      const handler = commands.get("init-deep-advisor");
      assert(handler);
      await handler(arg, ctx);
    };
    choice = "Skip this time";
    const before = Date.now();
    await start();
    assert((await readAdvisorState(paths.project)).cooldownUntil >= before + COOLDOWN_MS);
    await start();
    assert.equal(selects, 1);
    await updateAdvisorState(paths.project, { cooldownUntil: 0 });
    await start();
    assert.equal(selects, 1, "same HEAD remains suppressed after cooldown expiry");
    await command("reset-project");
    choice = undefined;
    await start();
    assert((await readAdvisorState(paths.project)).cooldownUntil > Date.now());
    await command("reset-project");
    choice = "Never in this project";
    await start();
    assert((await readAdvisorState(paths.project)).declined);
    const count = selects;
    await start();
    assert.equal(selects, count);
    await command("reset-project");
    choice = "Never anywhere";
    await start();
    assert((await readGlobalState(paths.global)).declined);
    await command("reset-global");
    await command("reset-project");
    choice = "Run now";
    await start();
    assert.equal(messages.filter((message) => !message.display).length, 1);
    assert.equal(await readSnapshot(paths.snapshot), null, "consent alone must never manufacture a baseline");
    await command("reset-project");
    Object.assign(ctx, { hasUI: false });
    await start();
    assert.equal(selects, count + 2);
    await command("status");
    assert(messages.some((message) => message.display));
    Object.assign(ctx, { hasUI: true, agent: { kind: "sub" } });
    await start();
    assert.equal(selects, count + 2);
    Object.assign(ctx, { agent: { kind: "main" } });
    await command("reset-project");
    const shown = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<string | undefined>();
    let dialogSignal: AbortSignal | undefined;
    ctx.ui.select = async (_title, _choices, options) => {
      dialogSignal = options?.signal;
      shown.resolve();
      return answer.promise;
    };
    const pendingStart = start();
    await shown.promise;
    for (const hook of hooks.get("session_switch") ?? []) await hook({ type: "session_switch" }, ctx);
    assert(dialogSignal?.aborted);
    answer.resolve("Run now");
    await pendingStart;
    assert.equal(
      messages.filter((message) => !message.display).length,
      1,
      "a stale dialog answer cannot invoke the skill in another session",
    );
    assert.deepEqual(warnings, []);
    console.log(
      "ADVISOR_CHOICES_OK: all four choices and timeout; same-HEAD/cooldown; reset commands; RPC select only; silent no-UI/subagent startup; consent does not record baseline",
    );
    return;
  }
  // SDK imports deliberately happen inside the isolated executable child, after HOME/agent-dir setup.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  await initTheme();
  const paths = advisorPaths(repo);
  const declined = Promise.withResolvers<void>();
  let selectorCalls = 0;
  let watcher: FSWatcher | undefined;
  const ui = {
    select: async () => {
      selectorCalls += 1;
      watcher = watch(dirname(paths.project), async (_event, file) => {
        if (file !== "advisor.json") return;
        if ((await readAdvisorState(paths.project)).declined) {
          watcher?.close();
          declined.resolve();
        }
      });
      return "Never in this project";
    },
    notify: () => {},
    setWidget: () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setTitle: () => {},
    custom: () => {
      throw new Error("Only built-in selectors are allowed");
    },
  } as unknown as ExtensionUIContext;
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.create(root, join(root, "sessions")),
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false }),
    toolNames: ["read", "write"],
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
    await initializeExtensions(session, {
      mode: name === "sdk-rpc" ? "rpc" : "tui",
      uiContext: ui,
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
    await runner.emit({ type: "session_start" });
    await declined.promise;
    assert.equal(selectorCalls, 1);
    await runner.emit({ type: "session_start" });
    const tool = session.getToolByName("toolkit_init_deep");
    assert(tool, "real SDK must expose snapshot seam");
    const invalid = await tool.execute("record-missing-mode", { action: "record" });
    assert(invalid.isError);
    const recorded = await tool.execute("record-local", { action: "record", mode: "local" });
    assert(!recorded.isError);
    const fields = recorded.details as SnapshotFields;
    assert.deepEqual(Object.keys(fields).sort(), ["commitSha", "fileCount", "loc", "mode", "timestamp"]);
    assert.equal(fields.commitSha, repo.head);
    assert.equal(fields.fileCount, 8);
    assert.equal(fields.loc, 8);
    assert.deepEqual(await readSnapshot(paths.snapshot), { version: 1, ...fields });
    assert.equal(selectorCalls, 1);
    console.log(
      `SDK_ADVISOR_OK (${name === "sdk-rpc" ? "rpc" : "tui"}): missing AGENTS coverage offered native select; Never persisted; restart did not offer again; real toolkit_init_deep record captured HEAD/8 files/8 LOC`,
    );
  } finally {
    watcher?.close();
    await session.dispose();
  }
}

if (process.env[CHILD_ENV]) {
  await scenario(process.env[CHILD_ENV] as string, process.env.TOOLKIT_ADVISOR_ROOT as string);
} else {
  // bun:test cannot load in the executable child; these scenarios test the real module-loading boundary.
  const { describe, expect, test } = await import("bun:test");
  describe("omo-toolkit init-deep advisor", () => {
    for (const name of ["metrics", "state", "choices", "sdk-tui", "sdk-rpc"]) {
      test(name, async () => {
        const root = await mkdtemp(join(tmpdir(), "toolkit-advisor-"));
        try {
          const child = Bun.spawn([process.execPath, THIS_FILE], {
            env: { ...process.env, [CHILD_ENV]: name, TOOLKIT_ADVISOR_ROOT: root, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") },
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
