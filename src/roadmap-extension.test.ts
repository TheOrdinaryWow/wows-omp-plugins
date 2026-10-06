import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionRunner } from "@oh-my-pi/pi-coding-agent";

import { loadAll, loadRepo, type Model, type Repo, roundFiles, roundSha256 } from "../plugins/roadmap/src/documents.ts";
import { discoverRepo } from "../plugins/roadmap/src/git.ts";
import { withRepoLock } from "../plugins/roadmap/src/numbering.ts";
import { type Actor, closeRound, type InitInput, initProject, openRound, stage } from "../plugins/roadmap/src/operations.ts";
import { ENTRY_PREFIX, type UiFactory } from "../plugins/roadmap/src/ses.ts";
import type { ToolReceipt } from "../plugins/roadmap/src/tools.ts";
import {
  HeadlessUi,
  type OverlapAnswer,
  type OverlapQuestion,
  type RoadmapUi,
  type RoundTodoDispositionChoice,
  type StatusMenuChoice,
} from "../plugins/roadmap/src/ui.ts";

const CHILD_ENV = "ROADMAP_EXTENSION_CASE";
const THIS_FILE = fileURLToPath(import.meta.url);
const ENTRY = fileURLToPath(new URL("../plugins/roadmap/src/index.ts", import.meta.url));
const main: Actor = { sessionId: "fixture-main", kind: "main" };
const draft: InitInput = {
  project: { name: "Shop", description: "A small verified shop." },
  round: { title: "Launch", goal: "Customers can check out", constraints: [], non_goals: [], principles: [] },
  stages: [
    {
      title: "Checkout",
      objective: "Customers pay",
      scope_in: ["Payments"],
      scope_out: ["Refunds"],
      done_criteria: [{ id: "DC1", statement: "Checkout works", verify: "bun test checkout" }],
    },
  ],
  adrs: [],
};
const closeInput = {
  action: "close" as const,
  id: "S01",
  delivered: "Checkout shipped.",
  deviations: "None.",
  evidence: [{ criterion: "DC1", result: "pass" as const, method: "bun test checkout", summary: "Pass", commit: "abc1234" }],
};

class ScriptedUi implements RoadmapUi {
  overlapCalls: OverlapQuestion[] = [];
  previewCalls: Array<{ title: string; files: Array<{ path: string; content: string }> }> = [];
  notifications: Array<{ message: string; level: string }> = [];
  answer: OverlapAnswer | undefined = "free";
  confirmed: boolean | undefined = true;
  menu: StatusMenuChoice | undefined;
  preview?: RoadmapUi["previewConfirm"];
  dispositions: RoundTodoDispositionChoice[] | undefined = [];

  async overlap(q: OverlapQuestion) {
    this.overlapCalls.push(q);
    return this.answer;
  }

  async previewConfirm(p: { title: string; files: Array<{ path: string; content: string }> }) {
    this.previewCalls.push(p);
    return this.preview ? this.preview(p) : this.confirmed;
  }

  async statusMenu() {
    return this.menu;
  }

  async closeRoundDispositions() {
    return this.dispositions;
  }

  notify(message: string, level: "info" | "warning" | "error") {
    this.notifications.push({ message, level });
  }
}

interface Harness {
  session: AgentSession;
  runner: ExtensionRunner;
  ui: ScriptedUi;
  kickoffs: string[];
  messages: string[];
  setUi: (factory?: UiFactory) => void;
}

async function git(root: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, `${stdout}\n${stderr}`);
}

async function createHarness(root: string, options: { sub?: boolean; applyPatch?: boolean } = {}): Promise<Harness> {
  // These imports intentionally exercise the loader boundary after the child's isolated HOME is set.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  await initTheme();
  const ui = new ScriptedUi();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.create(root, join(root, "sessions")),
    settings: Settings.isolated({
      "tools.approvalMode": "yolo",
      "autolearn.enabled": false,
      "edit.mode": options.applyPatch ? "apply_patch" : "hashline",
    }),
    toolNames: ["write", "edit", "ast_edit", "bash"],
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
    ...(options.sub ? { taskDepth: 1, agentId: "roadmap-sdk-child", agentName: "task", parentTaskPrefix: "roadmap-child" } : {}),
  });
  await initializeExtensions(session, {
    reportSendError: (_action, error) => {
      throw error;
    },
    reportRuntimeError: (error) => {
      throw new Error(error.error);
    },
  });
  assert.deepEqual(extensionsResult.errors, []);
  const factory = extensionsResult.preparedExtensions?.find((extension) => extension.resolvedPath === ENTRY)?.factory;
  assert(factory && "__setUiFactory" in factory && typeof factory.__setUiFactory === "function");
  const setter = factory.__setUiFactory;
  const setUi = (value?: UiFactory): void => {
    setter(value);
  };
  setUi(() => ui);
  const runner = session.extensionRunner;
  assert(runner);
  const kickoffs: string[] = [];
  const messages: string[] = [];
  // Preserve command dispatch while recording its kickoff instead of making a provider request.
  extensionsResult.runtime.sendUserMessage = (content) => {
    assert.equal(typeof content, "string");
    if (typeof content === "string") kickoffs.push(content);
  };
  extensionsResult.runtime.sendMessage = (message) => {
    const content = typeof message === "string" ? message : message.content;
    assert.equal(typeof content, "string");
    if (typeof content === "string") messages.push(content);
  };
  for (const name of [
    "write",
    "edit",
    "ast_edit",
    "bash",
    "roadmap_status",
    "roadmap_stage",
    "roadmap_todo",
    "roadmap_adr",
    "roadmap_check",
    "roadmap_overlap",
    "roadmap_init",
    "roadmap_round_open",
  ]) {
    assert(session.getToolByName(name), `Real loader must register ${name}`);
  }
  assert.equal(runner.createContext().agent.kind, options.sub ? "sub" : "main");
  return { session, runner, ui, kickoffs, messages, setUi };
}

async function command(h: Harness, name: string, args = ""): Promise<void> {
  const registered = h.runner.getCommand(name);
  assert(registered);
  await registered.handler(args, h.runner.createCommandContext());
}

async function call(h: Harness, name: string, input: object): Promise<ToolReceipt> {
  const tool = h.session.getToolByName(name);
  assert(tool);
  const result = await tool.execute(`sdk-${name}-${crypto.randomUUID()}`, input);
  // The SDK erases the in-process extension detail type; validate its discriminator at this boundary.
  assert(result.details && typeof result.details === "object" && "ok" in result.details && typeof result.details.ok === "boolean");
  const details = result.details as ToolReceipt;
  assert.equal(Boolean(result.isError), !details.ok);
  return details;
}

async function initialized(root: string): Promise<Repo> {
  const info = discoverRepo(root);
  assert(info);
  const repo: Repo = { ...info, roadmapDir: join(root, "docs/roadmap"), adrDir: join(root, "docs/adr") };
  const receipt = await initProject(repo, main, draft);
  assert(receipt.ok, JSON.stringify(receipt));
  return repo;
}

async function injection(h: Harness): Promise<string> {
  const result = await h.runner.emitBeforeAgentStart("Continue", undefined, ["Original host policy"]);
  if (!result?.systemPrompt) return "";
  assert.equal(result.systemPrompt[0], "Original host policy");
  return result.systemPrompt.slice(1).join("\n");
}

const CASES: Record<string, string> = {
  interception: "initialized repositories block native mutators and allow other files",
  patch: "the real apply_patch edit mode is intercepted",
  uninitialized: "repositories without the marker allow native mutation hooks",
  worktree: "targets use their own worktree and symlink resolution",
  injection: "context is recomputed each turn and disappears after round close",
  subagent: "SDK subagents receive context and cannot decide ADR status",
  init: "init requires command arming, confirmation and consumes authorization",
  stale: "init releases the preview lock and rejects files appearing before confirmation",
  overlap: "free overlap asks once and persists without duplicating its log",
  binding: "roadmap overlap starts, binds and returns its handoff",
  headless: "headless overlap and previews report no answer available",
  "bound-start": "started stages bypass the overlap dialog and free-work log",
  "bound-join": "joined stages bypass the overlap dialog and free-work log",
  "bound-start-headless": "started stages remain in-system without a UI",
  "bound-join-headless": "joined stages remain in-system without a UI",
  external: "an externally closed stage drops its binding with a one-turn notice",
  round: "round commands collect dispositions, arm previews and import carried TODOs",
  "round-close-stale": "round-close dialogs cannot authorize closing a replacement round",
  rebuild: "session start, switch, branch and tree rebuild from the active branch",
  pending: "pending-close reminders retain evidence and remain bounded",
  preflight: "init command preflight rejects existing directories and non-git roots",
};

async function acceptance(name: string, root: string): Promise<void> {
  const h = await createHarness(root, { sub: name === "subagent", applyPatch: name === "patch" });
  try {
    if (name === "interception" || name === "patch" || name === "worktree") {
      const repo = await initialized(root);
      const model = await loadAll(repo);
      const current = model.stages[0];
      assert(current);
      const before = await readFile(current.path, "utf8");
      if (name === "interception") {
        for (const [toolName, input] of [
          ["write", { path: "docs/roadmap/x.md", content: "bad" }],
          ["edit", { input: `[${current.path}#ABCD]\nPUT <1:\n+bad` }],
          ["ast_edit", { ops: [{ pat: "x", out: "y" }], paths: ["docs"] }],
          ["ast_edit", { ops: [{ pat: "x", out: "y" }], paths: ["docs/**/*.md"] }],
          ["bash", { command: "echo x > docs/adr/0001-a.md" }],
          ["bash", { command: "printf x | tee 'docs/adr/0001-a.md'" }],
          ["bash", { command: "rm -rf docs/roadmap" }],
        ] as Array<[string, Record<string, unknown>]>) {
          const tool = h.session.getToolByName(toolName);
          assert(tool);
          await assert.rejects(tool.execute(`block-${crypto.randomUUID()}`, input), /roadmap_stage/);
        }
        const write = h.session.getToolByName("write");
        assert(write);
        await write.execute("allow-other", { path: "docs/other.md", content: "allowed\n" });
        assert.equal(await readFile(join(root, "docs/other.md"), "utf8"), "allowed\n");
        for (const input of [
          { action: "rename_file", file: "docs/other.md", new_name: "docs/adr/renamed.md" },
          { action: "rename", file: "docs/roadmap", symbol: "x", new_name: "y" },
        ])
          assert.equal(
            (await h.runner.emitToolCall({ type: "tool_call", toolName: "lsp", toolCallId: crypto.randomUUID(), input }))?.block,
            true,
          );
        // A corrupt marker must not downgrade to an unprotected repository.
        await writeFile(join(repo.roadmapDir, "README.md"), "---\nformat: 99\nroadmap: { format: 99 }\n---\n");
        await assert.rejects(write.execute("invalid-marker", { path: "docs/adr/x.md", content: "bad" }), /could not validate/);
      } else if (name === "patch") {
        const edit = h.session.getToolByName("edit");
        assert(edit);
        await assert.rejects(
          edit.execute("patch-block", {
            input: `*** Begin Patch\n*** Update File: ${current.path}\n@@\n-# Checkout\n+# Bad\n*** End Patch`,
          }),
          /roadmap_stage/,
        );
        const result = await h.runner.emitToolCall({
          type: "tool_call",
          toolName: "apply_patch",
          toolCallId: "patch-alias",
          input: { input: `*** Begin Patch\n*** Add File: docs/adr/x.md\n+x\n*** End Patch` },
        });
        assert.equal(result?.block, true);
        const moved = await h.runner.emitToolCall({
          type: "tool_call",
          toolName: "edit",
          toolCallId: "patch-move",
          input: { input: "*** Begin Patch\n*** Update File: docs/other.md\n*** Move to: docs/adr/moved.md\n@@\n-x\n+y\n*** End Patch" },
        });
        assert.equal(moved?.block, true);
      } else {
        await git(root, ["add", "docs"]);
        await git(root, ["-c", "user.name=SDK", "-c", "user.email=sdk@example.invalid", "commit", "-qm", "fixture"]);
        const tree = join(dirname(root), "isolated-worktree");
        await git(root, ["worktree", "add", "-q", "-b", "isolated", tree]);
        const write = h.session.getToolByName("write");
        assert(write);
        await assert.rejects(write.execute("worktree-target", { path: join(tree, "docs/roadmap/x.md"), content: "bad" }), /roadmap_stage/);
        await symlink(join(tree, "docs/adr"), join(root, "adr-alias"));
        await assert.rejects(write.execute("symlink-target", { path: "adr-alias/x.md", content: "bad" }), /roadmap_stage/);
        const unmarked = join(dirname(root), "unmarked-worktree");
        await git(root, ["worktree", "add", "-q", "-b", "unmarked", unmarked]);
        await rm(join(unmarked, "docs/roadmap/README.md"));
        await write.execute("unmarked-target", { path: join(unmarked, "docs/adr/x.md"), content: "allowed" });
        assert.equal(await readFile(join(unmarked, "docs/adr/x.md"), "utf8"), "allowed");
      }
      assert.equal(await readFile(current.path, "utf8"), before);
    } else if (name === "uninitialized") {
      assert.equal(await injection(h), "");
      for (const [toolName, input] of [
        ["write", { path: "docs/roadmap/x.md", content: "x" }],
        ["edit", { input: "[docs/roadmap/x.md#ABCD]\nPUT <1:\n+x" }],
        ["apply_patch", { input: "*** Begin Patch\n*** Add File: docs/adr/x.md\n+x\n*** End Patch" }],
        ["ast_edit", { paths: ["docs"], ops: [{ pat: "x", out: "y" }] }],
        ["bash", { command: "echo x > docs/adr/x.md" }],
        ["lsp", { action: "rename_file", file: "docs/x.md", new_name: "docs/adr/x.md" }],
      ] as Array<[string, Record<string, unknown>]>) {
        assert.equal(await h.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input }), undefined);
      }
      const write = h.session.getToolByName("write");
      assert(write);
      await write.execute("uninitialized-write", { path: "docs/roadmap/x.md", content: "allowed" });
      assert.equal(await readFile(join(root, "docs/roadmap/x.md"), "utf8"), "allowed");
    } else if (name === "init" || name === "stale" || name === "headless") {
      const unarmed = await h.runner.emitToolCall({
        type: "tool_call",
        toolName: "roadmap_init",
        toolCallId: "unarmed",
        input: { ...draft },
      });
      assert.equal(unarmed?.block, true);
      assert.match(unarmed?.reason ?? "", /unarmed/);
      await command(h, "init-project");
      assert.equal(h.kickoffs.length, 1);
      assert.match(h.kickoffs[0] ?? "", /skill.*interview/);
      if (name === "init") {
        h.ui.confirmed = false;
        const declined = await call(h, "roadmap_init", draft);
        assert.equal(declined.ok, false);
        assert.equal(await loadRepo(root), null);
        h.ui.confirmed = true;
        const receipt = await call(h, "roadmap_init", draft);
        assert(receipt.ok, JSON.stringify(receipt));
        assert(receipt.changedFiles.length >= 5);
        assert(
          h.ui.previewCalls.every((preview) =>
            preview.files.some((file) => file.path.endsWith("README.md") && file.content.includes("Managed by")),
          ),
        );
        assert(await loadRepo(root));
        assert.equal(
          (await h.runner.emitToolCall({ type: "tool_call", toolName: "roadmap_init", toolCallId: "consumed", input: { ...draft } }))
            ?.block,
          true,
        );
        assert(
          h.session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === `${ENTRY_PREFIX}disarmed`),
        );
      } else if (name === "stale") {
        const gitInfo = discoverRepo(root);
        assert(gitInfo);
        const repo: Repo = { ...gitInfo, roadmapDir: join(root, "docs/roadmap"), adrDir: join(root, "docs/adr") };
        h.ui.preview = async () => {
          await withRepoLock(repo, async () => {
            await mkdir(repo.roadmapDir, { recursive: true });
            await writeFile(join(repo.roadmapDir, "external.md"), "External write\n");
          });
          return true;
        };
        const receipt = await call(h, "roadmap_init", draft);
        assert(!receipt.ok);
        assert.match(receipt.reason, /stale/);
        assert.equal(await readFile(join(repo.roadmapDir, "external.md"), "utf8"), "External write\n");
        assert.equal(await loadRepo(root), null);
      } else {
        h.setUi(() => new HeadlessUi());
        const receipt = await call(h, "roadmap_init", draft);
        assert(!receipt.ok);
        assert.match(receipt.reason, /no answer available/);
        assert.equal(await loadRepo(root), null);
        const repo = await initialized(root);
        const current = (await loadAll(repo)).stages[0];
        assert(current);
        const overlap = await call(h, "roadmap_overlap", { stage: current.id, intent: "Fix checkout" });
        assert(!overlap.ok);
        assert.match(overlap.reason, /no answer available/);
        assert.equal(h.ui.overlapCalls.length, 0);
      }
    } else if (name === "preflight") {
      await mkdir(join(root, "docs/adr"), { recursive: true });
      await writeFile(join(root, "docs/adr/existing.md"), "user's ADR");
      await command(h, "init-project");
      assert.match(h.ui.notifications.at(-1)?.message ?? "", /absent or empty/);
      assert.equal(h.kickoffs.length, 0);
      await rm(join(root, "docs/adr"), { recursive: true });
      await mkdir(join(root, "docs/roadmap"));
      await command(h, "init-project");
      assert.match(h.ui.notifications.at(-1)?.message ?? "", /already exists/);
      assert.equal(h.kickoffs.length, 0);
      await rm(join(root, ".git"), { recursive: true });
      await command(h, "init-project");
      assert.match(h.ui.notifications.at(-1)?.message ?? "", /git work tree/);
    } else {
      const repo = await initialized(root);
      if (name === "injection") {
        const block = await injection(h);
        assert.match(block, /\[Roadmap status\]/);
        assert.match(block, /R1/);
        assert(block.split("\n").length <= 40);
        assert((await call(h, "roadmap_stage", { action: "start", id: "S01" })).ok);
        assert.match(await injection(h), /Bound stage: S01/);
        assert((await call(h, "roadmap_stage", closeInput)).ok);
        await command(h, "roadmap", "close-round");
        assert.equal((await loadAll(repo)).rounds[0]?.status, "closed");
        assert.equal(await injection(h), "");
        const write = h.session.getToolByName("write");
        assert(write);
        await assert.rejects(write.execute("adr-after-close", { path: "docs/adr/x.md", content: "bad" }), /roadmap_adr/);
        assert(
          (
            await call(h, "roadmap_adr", {
              action: "create",
              title: "Choice",
              status: "accepted",
              sections: { context: "Need a choice", options: ["A"], outcome: "A" },
            })
          ).ok,
        );
      } else if (name === "subagent") {
        assert.match(await injection(h), /\[Roadmap status\]/);
        assert(
          (
            await call(h, "roadmap_adr", {
              action: "create",
              title: "Choice",
              status: "accepted",
              sections: { context: "Need a choice", options: ["A"], outcome: "A" },
            })
          ).ok,
        );
        assert.equal((await loadAll(repo)).adrs[0]?.status, "proposed");
        const receipt = await call(h, "roadmap_adr", { action: "set_status", id: "ADR-0001", status: "accepted" });
        assert(!receipt.ok);
        assert.match(receipt.reason, /main/);
        assert((await call(h, "roadmap_overlap", { stage: "S01", intent: "Fix checkout" })).ok);
        assert.equal(h.ui.overlapCalls.length, 0);
        const write = h.session.getToolByName("write");
        assert(write);
        await assert.rejects(write.execute("sub-write", { path: "docs/roadmap/x.md", content: "bad" }), /roadmap_stage/);
      } else if (name === "overlap") {
        const first = await call(h, "roadmap_overlap", { stage: "S01", intent: "Fix free checkout" });
        assert(first.ok);
        assert.equal(first.answer, "free");
        await h.runner.emit({ type: "session_start" });
        const second = await call(h, "roadmap_overlap", { stage: "S01", intent: "A second intent" });
        assert(second.ok);
        assert.equal(second.answer, "free");
        assert.equal(h.ui.overlapCalls.length, 1);
        const log = (await loadAll(repo)).stages[0]?.free_work_log ?? "";
        assert.match(log, /Fix free checkout/);
        assert.match(log, new RegExp(h.session.sessionManager.getSessionId()));
        assert.equal(log.split("\n").filter((line) => line.startsWith("- ")).length, 1);
      } else if (name === "binding" || name === "external") {
        h.ui.answer = "roadmap";
        const receipt = await call(h, "roadmap_overlap", { stage: "S01", intent: "Build checkout" });
        assert(receipt.ok);
        assert.match(receipt.handoff ?? "", /DC1/);
        assert.match(await injection(h), /Bound stage: S01/);
        await h.runner.emit({ type: "session_start" });
        assert.match(await injection(h), /Bound stage: S01/);
        if (name === "binding") {
          assert((await call(h, "roadmap_overlap", { stage: "S01", intent: "Continue" })).ok);
          assert.equal(h.ui.overlapCalls.length, 1);
          await command(h, "roadmap", "stage S01");
          assert.match(h.messages.at(-1) ?? "", /DC1/);
          const options = h.runner.getCommand("roadmap")?.getArgumentCompletions?.("stage S");
          assert(options?.some((option) => option.value === "stage S01"));
          const status = await call(h, "roadmap_status", { stage: "S01" });
          assert(status.ok);
          assert.match(status.handoff ?? "", /DC1/);
        } else {
          assert((await stage(repo, { sessionId: "external-process", kind: "main" }, closeInput)).ok);
          const block = await injection(h);
          assert.match(block, /Previous binding S01.*dropped/);
          assert(!block.includes("Bound stage:"));
          assert(!(await injection(h)).includes("Previous binding"));
          await h.runner.emit({ type: "session_start" });
          assert(!(await injection(h)).includes("Bound stage:"));
        }
      } else if (name.startsWith("bound-")) {
        if (name.includes("join")) assert((await stage(repo, main, { action: "start", id: "S01" })).ok);
        const started = await call(h, "roadmap_stage", { action: "start", id: "S01" });
        assert(started.ok);
        if (name.includes("join")) assert(started.warnings.includes("another session may be working on this stage"));
        const before = await readFile((await loadAll(repo)).stages[0]?.path as string, "utf8");
        let uiCalls = 0;
        h.setUi(() => {
          uiCalls++;
          return name.endsWith("headless") ? new HeadlessUi() : h.ui;
        });
        for (const stored of [false, true]) {
          if (stored) {
            h.session.sessionManager.appendCustomEntry(`${ENTRY_PREFIX}overlap`, {
              v: 1,
              repoRoot: root,
              stage: "S01",
              answer: "free",
              at: new Date().toISOString(),
            });
            await h.runner.emit({ type: "session_start" });
          }
          const receipt = await call(h, "roadmap_overlap", { stage: "S01", intent: "Continue checkout" });
          assert(receipt.ok, JSON.stringify(receipt));
          assert.equal(receipt.answer, "roadmap");
          assert.match(receipt.summary, /already working in-system/);
          assert.match(receipt.handoff ?? "", /DC1/);
          assert.deepEqual(receipt.changedFiles, []);
          assert.equal(h.ui.overlapCalls.length, 0);
          assert.equal(uiCalls, 0);
          assert.equal((await loadAll(repo)).stages[0]?.free_work_log, "");
          assert.equal(await readFile((await loadAll(repo)).stages[0]?.path as string, "utf8"), before);
        }
      } else if (name === "round-close-stale") {
        assert((await call(h, "roadmap_stage", { action: "drop", id: "S01", reason: "Defer" })).ok);
        let before: Model["files"];
        h.ui.closeRoundDispositions = async () => {
          const reviewed = await loadAll(repo);
          const round = reviewed.rounds.find((candidate) => candidate.status === "active");
          assert.equal(round?.id, "R1");
          assert(round);
          const other: Actor = { sessionId: "other-main", kind: "main" };
          assert(
            (
              await closeRound(repo, other, {
                expected: { id: round.id, sha256: roundSha256(roundFiles(reviewed, round)) },
                dispositions: [],
              })
            ).ok,
          );
          assert((await openRound(repo, other, { round: { ...draft.round, title: "Replacement" }, import_todos: [] })).ok);
          before = (await loadAll(repo)).files;
          return [];
        };
        await command(h, "roadmap", "close-round");
        const model = await loadAll(repo);
        assert.deepEqual(model.rounds.map((round) => [round.id, round.status]).sort(), [
          ["R1", "closed"],
          ["R2", "active"],
        ]);
        assert(before);
        assert.deepEqual(model.files, before);
        assert.match(h.messages.at(-1) ?? "", /stale/);
        assert.match(h.messages.at(-1) ?? "", /Run \/roadmap close-round again/);
      } else if (name === "round") {
        assert(
          (await call(h, "roadmap_todo", { action: "add", title: "Later", severity: "normal", source: "User", trigger: "Next round" })).ok,
        );
        assert((await call(h, "roadmap_stage", { action: "drop", id: "S01", reason: "Defer" })).ok);
        h.ui.dispositions = [{ id: "T001", disposition: "carried" }];
        await command(h, "roadmap", "close-round");
        assert.equal((await loadAll(repo)).rounds[0]?.status, "closed");
        const input = { round: { ...draft.round, title: "Next" }, import_todos: ["T001"] };
        assert.equal(
          (await h.runner.emitToolCall({ type: "tool_call", toolName: "roadmap_round_open", toolCallId: "unarmed-round", input }))?.block,
          true,
        );
        await command(h, "roadmap", "new-round");
        assert.match(h.kickoffs.at(-1) ?? "", /roadmap_round_open/);
        h.ui.confirmed = false;
        assert(!(await call(h, "roadmap_round_open", input)).ok);
        assert.equal((await loadAll(repo)).rounds.length, 1);
        h.ui.confirmed = true;
        assert((await call(h, "roadmap_round_open", input)).ok);
        const model = await loadAll(repo);
        const active = model.rounds.find((round) => round.status === "active");
        assert(active);
        assert(Number(active.id.slice(1)) > 1);
        assert.equal(model.todos.find((todo) => todo.round === active.id)?.items[0]?.carried_from, "T001 (R1)");
        assert.equal(
          (await h.runner.emitToolCall({ type: "tool_call", toolName: "roadmap_round_open", toolCallId: "consumed-round", input }))?.block,
          true,
        );
        assert((await call(h, "roadmap_check", {})).ok);
        h.ui.menu = { action: "check" };
        await command(h, "roadmap");
        assert.match(h.messages.at(-1) ?? "", /check passed/);
      } else if (name === "rebuild") {
        assert((await call(h, "roadmap_overlap", { stage: "S01", intent: "Free" })).ok);
        for (const type of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
          const earlier = h.session.sessionManager.getLeafId();
          assert(earlier);
          const latest = h.session.sessionManager.appendCustomEntry(`${ENTRY_PREFIX}overlap`, {
            v: 1,
            repoRoot: root,
            stage: "S01",
            answer: "unrelated",
            at: new Date().toISOString(),
          });
          if (type === "session_start") await h.runner.emit({ type });
          if (type === "session_switch") await h.runner.emit({ type, reason: "resume", previousSessionFile: undefined });
          if (type === "session_branch") await h.runner.emit({ type, previousSessionFile: undefined });
          if (type === "session_tree") await h.runner.emit({ type, oldLeafId: earlier, newLeafId: latest });
          assert.equal((await call(h, "roadmap_overlap", { stage: "S01", intent: "Read restored answer" })).answer, "unrelated");
          h.session.sessionManager.branch(earlier);
          await h.runner.emit({ type: "session_tree", oldLeafId: latest, newLeafId: earlier });
          assert.equal((await call(h, "roadmap_overlap", { stage: "S01", intent: "Read earlier branch" })).answer, "free");
        }
        assert.equal(h.ui.overlapCalls.length, 1);
      } else if (name === "pending") {
        assert((await call(h, "roadmap_stage", { action: "start", id: "S01" })).ok);
        h.session.sessionManager.appendCustomEntry(`${ENTRY_PREFIX}pending-close`, {
          v: 1,
          repoRoot: root,
          stage: "S01",
          planId: "approved-plan",
          at: new Date().toISOString(),
          gates: Array.from({ length: 8 }, (_, index) => ({
            gateId: `F${index + 1}`,
            verdict: "PASS",
            summary: "Tests passed\n".repeat(100),
          })),
        });
        await h.runner.emit({ type: "session_start" });
        const block = await injection(h);
        assert.match(block, /Plan approved-plan completed/);
        for (const gateId of ["F1", "F2", "F3", "F4"]) assert.match(block, new RegExp(`${gateId}: PASS — Tests passed`));
        assert(!block.includes("F5: PASS"));
        assert.match(block, /evidence candidates/);
        assert(block.split("\n").length <= 40);
        assert(block.length < 6000);
        assert((await call(h, "roadmap_stage", closeInput)).ok);
        assert(!(await injection(h)).includes("Plan approved-plan"));
      } else throw new Error(`Unknown acceptance case: ${name}`);
    }
    console.log(`ROADMAP_EXTENSION_OK ${name}`);
  } finally {
    h.setUi();
    await h.session.dispose();
  }
}

if (process.env[CHILD_ENV]) {
  await acceptance(process.env[CHILD_ENV] as string, process.env.ROADMAP_EXTENSION_ROOT as string);
} else {
  // A plain Bun child cannot import bun:test; this branch owns only the parent test runner.
  const { expect, test } = await import("bun:test");
  for (const [name, description] of Object.entries(CASES)) {
    test(`real SDK roadmap: ${description}`, async () => {
      const home = await mkdtemp(join(tmpdir(), "roadmap-extension-"));
      try {
        const cwd = join(home, "repo");
        await mkdir(cwd);
        await git(cwd, ["init", "-q"]);
        const child = Bun.spawn([process.execPath, THIS_FILE], {
          cwd,
          env: { ...process.env, [CHILD_ENV]: name, ROADMAP_EXTENSION_ROOT: cwd, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toContain(`ROADMAP_EXTENSION_OK ${name}`);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }, 60_000);
  }
}
