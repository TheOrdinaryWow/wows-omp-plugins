import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { scheduler } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentSession, AgentToolResult, ExtensionRunner } from "@oh-my-pi/pi-coding-agent";

import { loadAll, loadRepo, type Model, type Repo, replaceGenerated, roundFiles, roundSha256 } from "../plugins/roadmap/src/documents.ts";
import { discoverRepo } from "../plugins/roadmap/src/git.ts";
import { withRepoLock } from "../plugins/roadmap/src/numbering.ts";
import {
  type Actor,
  applyPrepared,
  atomicWrite,
  closeRound,
  type InitInput,
  initProject,
  openRound,
  prepareInit,
  stage,
} from "../plugins/roadmap/src/operations.ts";
import { ENTRY_PREFIX, type UiFactory } from "../plugins/roadmap/src/ses.ts";
import type { ToolReceipt } from "../plugins/roadmap/src/tools.ts";
import {
  createTuiUi,
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
const EDIT_MODES = ["hashline", "replace", "patch", "apply_patch", "sloppy"] as const;
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
  previewCalls: Array<Parameters<RoadmapUi["previewConfirm"]>[0]> = [];
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

  async previewConfirm(p: Parameters<RoadmapUi["previewConfirm"]>[0]) {
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

async function createHarness(
  root: string,
  options: { sub?: boolean; editMode?: (typeof EDIT_MODES)[number]; lsp?: boolean } = {},
): Promise<Harness> {
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
      "edit.mode": options.editMode ?? "hashline",
    }),
    toolNames: ["read", "write", "edit", "ast_edit", "bash", ...(options.lsp ? ["lsp"] : [])],
    additionalExtensionPaths: [ENTRY],
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: options.lsp ?? false,
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

async function call(h: Harness, name: string, input: object, signal?: AbortSignal): Promise<ToolReceipt> {
  const tool = h.session.getToolByName(name);
  assert(tool);
  const result = await tool.execute(`sdk-${name}-${crypto.randomUUID()}`, input, signal);
  // The SDK erases the in-process extension detail type; validate its discriminator at this boundary.
  assert(result.details && typeof result.details === "object" && "ok" in result.details && typeof result.details.ok === "boolean");
  const details = result.details as ToolReceipt;
  assert.equal(Boolean(result.isError), !details.ok);
  return details;
}

function cancelAfterCommit(path: string, before?: string, controller = new AbortController()): AbortSignal {
  Object.defineProperty(controller.signal, "aborted", {
    get() {
      if (!controller.signal.reason && existsSync(path) && readFileSync(path, "utf8") !== before) controller.abort();
      return controller.signal.reason !== undefined;
    },
  });
  return controller.signal;
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

function holdOverlap(h: Harness, stageId = "S01") {
  const shown = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<OverlapAnswer | undefined>();
  h.ui.overlap = async (question) => {
    h.ui.overlapCalls.push(question);
    if (question.stage.id !== stageId) return h.ui.answer;
    shown.resolve();
    return answer.promise;
  };
  return { shown: shown.promise, resolve: answer.resolve, reject: answer.reject };
}

function observeLockWaits() {
  const original = scheduler.wait;
  const requests = new AsyncLocalStorage<() => void>();
  let active = 0;
  const observed = (...args: Parameters<typeof scheduler.wait>) => {
    requests.getStore()?.();
    return original.call(scheduler, ...args);
  };
  return <T>(operation: () => Promise<T>) => {
    const waiting = Promise.withResolvers<void>();
    if (active++ === 0) scheduler.wait = observed;
    const pending = requests.run(waiting.resolve, operation).finally(() => {
      if (--active === 0) scheduler.wait = original;
    });
    return { pending, waiting: waiting.promise };
  };
}

async function confirmedPreviewBehindLock(
  h: Harness,
  repo: Repo,
  toolName: "roadmap_init" | "roadmap_round_open",
  input: object,
  whileLocked: (preview: ScriptedUi["previewCalls"][number]) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ receipt: ToolReceipt; preview: ScriptedUi["previewCalls"][number] }> {
  const shown = Promise.withResolvers<ScriptedUi["previewCalls"][number]>();
  const confirmation = Promise.withResolvers<boolean>();
  h.ui.preview = async (preview) => {
    shown.resolve(preview);
    return confirmation.promise;
  };
  const queued = observeLockWaits()(() => call(h, toolName, input, signal));
  const preview = await shown.promise;
  let settled = false;
  const pending = queued.pending.finally(() => {
    settled = true;
  });
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = withRepoLock(repo, async () => {
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  try {
    confirmation.resolve(true);
    await queued.waiting;
    assert.equal(settled, false, `${toolName} must still be waiting for the repository lock`);
    await whileLocked(preview);
  } finally {
    confirmation.resolve(true);
    release.resolve();
    await holding;
  }
  return { receipt: await pending, preview };
}

const CASES: Record<string, string> = {
  interception: "initialized repositories block native mutators and allow other files",
  patch: "the real apply_patch edit mode is intercepted",
  "interception-lsp-rename": "LSP symbol rename identifiers are not paths while managed file renames remain blocked",
  "interception-dangling": "dangling-symlink writes protect nonexistent managed targets but allow unmanaged targets",
  "interception-globs": "partial-name ast_edit globs protect managed directories",
  "interception-ast-scope-delimited": "delimited ast_edit scopes protect both managed roots and allow unrelated files",
  "interception-ast-scope-quoted": "quoted ast_edit scopes protect both managed roots and allow unrelated files",
  "interception-ast-scope-padded": "whitespace-padded ast_edit scopes protect both managed roots and allow unrelated files",
  "interception-ast-scope-backslashes": "backslash ast_edit scopes protect both managed roots and allow unrelated files",
  "interception-ast-scope-errors": "invalid ast_edit scopes fail closed without changing managed bytes",
  "interception-write-aliases": "native write aliases cannot change managed bytes",
  "interception-replace-aliases": "native replace-edit aliases cannot change managed bytes",
  "interception-hashline-aliases": "native hashline-edit aliases cannot change managed bytes",
  "interception-patch-aliases": "native apply_patch aliases cannot change managed bytes",
  "interception-errors": "path-resolution errors refuse native writes without changing managed bytes",
  ...Object.fromEntries(EDIT_MODES.map((mode) => [`interception-mode-${mode}`, `native ${mode} edits protect both managed roots`])),
  "interception-write-hardlinks": "native writes reject inside and outside hardlink aliases but allow distinct inodes",
  "interception-replace-hardlinks": "native replace edits reject inside and outside hardlink aliases but allow distinct inodes",
  "interception-hardlink-errors": "hardlink stat errors refuse native mutations without changing managed bytes",
  "interception-outside-scopes": "outside-repository AST ancestors and globs protect managed files but allow unrelated scopes",
  uninitialized: "repositories without the marker allow native mutation hooks",
  worktree: "targets use their own worktree and symlink resolution",
  injection: "context is recomputed each turn and disappears after round close",
  subagent: "SDK subagents receive context and cannot decide ADR status",
  "closure-stage-status": "a changed stage status cannot bypass its retained closure hash through native tools",
  "closure-round-status": "a changed round status cannot unlock its frozen directory through native tools",
  init: "init requires command arming, confirmation and consumes authorization",
  "init-lock-authority": "confirmed init queued under the lock refuses rebuilt session authority and succeeds in the unchanged session",
  "round-lock-authority":
    "confirmed round open queued under the lock refuses rebuilt session authority and succeeds in the unchanged session",
  "init-lock-cancel": "confirmed init cancelled while waiting for the repository lock writes nothing and retains arming",
  "round-lock-cancel": "confirmed round open cancelled while waiting for the repository lock preserves managed bytes and arming",
  "mutation-lock-cancel":
    "stage, TODO, ADR, overlap and check tools cancelled while waiting for the repository lock preserve managed bytes",
  "prewrite-cancel": "mutations cancelled during locked validation cannot begin writing prepared or ordinary files",
  "midwrite-stage-start": "cancelled stage start stops after its stage file, preserves binding and is repaired by roadmap_check fix",
  "midwrite-stage-close": "cancelled stage close stops after its stage file without running binding cleanup",
  "midwrite-init": "cancelled initialization stops after its first previewed file without consuming arming",
  "midwrite-round-open": "cancelled round open stops after its first previewed file without consuming arming",
  "midwrite-overlap-free": "cancelled free-work commit does not persist its overlap answer",
  ...Object.fromEntries(
    [0, 1, 2, 3].map((count) => [
      `check-fix-cancel-${count}`,
      `cancelled check fixes report all ${count} committed files and a retry path`,
    ]),
  ),
  "check-fix-queued-objective": "queued no-op fix does not attribute another operation's objective edit",
  ...Object.fromEntries(
    [false, true].flatMap((cancelled) =>
      [0, 1, 2, 3].map((count) => [
        `check-fix-queued-${cancelled ? "cancel" : "success"}-${count}`,
        `queued ${cancelled ? "cancelled" : "successful"} fix reports only its ${count} renames after another operation commits`,
      ]),
    ),
  ),
  stale: "init releases the preview lock and rejects files appearing before confirmation",
  overlap: "free overlap asks once and persists without duplicating its log",
  "overlap-flight-concurrent": "concurrent overlap calls share one dialog and one free-work entry",
  "overlap-flight-start": "a stage started during an overlap dialog discards a late free-work answer",
  "overlap-flight-join": "a stage joined during an overlap dialog discards a late free-work answer",
  "overlap-flight-closed": "a stage closed during an overlap dialog discards its late answer without writing",
  "overlap-flight-dropped": "a stage dropped during an overlap dialog discards its late answer without writing",
  "overlap-flight-rebuild": "session rebuilds invalidate pending overlap answers without writing into the new branch",
  "overlap-flight-cancel": "cancelled shared overlap dialogs can be retried without duplicating free work",
  "overlap-flight-error": "failed shared overlap dialogs can be retried without duplicating free work",
  "overlap-flight-isolated": "pending overlap dialogs are isolated by stage and session",
  "overlap-lock-rebuild": "answered overlap mutations queued behind a lock cannot write after branch or tree rebuilds",
  "overlap-lock-start": "a queued native start binds before a late free-work answer can write",
  "overlap-lock-terminal": "a queued terminal transition invalidates a late overlap mutation under the lock",
  binding: "roadmap overlap starts, binds and returns its handoff",
  headless: "headless overlap and previews report no answer available",
  "bound-start": "started stages bypass the overlap dialog and free-work log",
  "bound-join": "joined stages bypass the overlap dialog and free-work log",
  "bound-start-headless": "started stages remain in-system without a UI",
  "bound-join-headless": "joined stages remain in-system without a UI",
  external: "an externally closed stage drops its binding with a one-turn notice",
  round: "round commands collect dispositions, arm previews and import carried TODOs",
  "round-close-stale": "round-close dialogs cannot authorize closing a replacement round",
  "round-menu-stale": "status-menu close cannot authorize closing a replacement round",
  "round-menu-changed": "status-menu close cannot authorize changed round files",
  "round-menu-close": "status-menu close freezes the reviewed unchanged round",
  rebuild: "session start, switch, branch and tree rebuild from the active branch",
  pending: "pending-close reminders retain evidence and remain bounded",
  menu: "status-menu stage close gives tool guidance without writing files",
  preflight: "init command preflight rejects existing directories and non-git roots",
};

async function acceptance(name: string, root: string): Promise<void> {
  const h = await createHarness(root, {
    sub: name === "subagent",
    lsp: name === "interception-lsp-rename",
    editMode:
      EDIT_MODES.find((mode) => name === `interception-mode-${mode}`) ??
      (name === "patch" || name === "interception-patch-aliases"
        ? "apply_patch"
        : name === "interception-replace-aliases" || name === "interception-replace-hardlinks" || name === "interception-hardlink-errors"
          ? "replace"
          : "hashline"),
  });
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
        const adrPath = join(repo.adrDir, "README.md");
        const adrBefore = await readFile(adrPath, "utf8");
        const edit = h.session.getToolByName("edit");
        assert(edit);
        for (const prefix of ["scratch[old]", "scratch*old", "scratch?old", "scratch{old}"]) {
          for (const path of [current.path, adrPath]) {
            const literal = `${prefix}/../${relative(root, path)}`;
            await assert.rejects(write.execute(`literal-write-${crypto.randomUUID()}`, { path: literal, content: "bad" }), /roadmap_stage/);
            await assert.rejects(
              edit.execute(`literal-edit-${crypto.randomUUID()}`, { input: `[${literal}#ABCD]\nPUT <1:\n+bad` }),
              /roadmap_stage/,
            );
          }
        }
        assert.equal(await readFile(current.path, "utf8"), before);
        assert.equal(await readFile(adrPath, "utf8"), adrBefore);
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
        for (const prefix of ["scratch[old]", "scratch*old", "scratch?old", "scratch{old}"]) {
          const path = `${prefix}/../${relative(root, current.path)}`;
          await assert.rejects(
            edit.execute(`literal-patch-${crypto.randomUUID()}`, {
              input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-# Checkout\n+# Bad\n*** End Patch`,
            }),
            /roadmap_stage/,
          );
        }
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
    } else if (name.startsWith("interception-")) {
      const repo = await initialized(root);
      const model = await loadAll(repo);
      const current = model.stages[0];
      assert(current);
      const write = h.session.getToolByName("write");
      assert(write);
      if (name === "interception-lsp-rename") {
        const lsp = h.session.getToolByName("lsp");
        assert(lsp, "The real SDK must register the native LSP tool");
        const source = "const oldName = 1;\n";
        await writeFile(join(root, "source.ts"), source);
        for (const apply of [true, false]) {
          const rename = { action: "rename", file: "source.ts", line: 1, symbol: "oldName", apply };
          const ordinary: AgentToolResult<unknown> = await lsp.execute(`symbol-rename-records-${apply}`, {
            ...rename,
            new_name: "records",
          });
          assert.match(JSON.stringify(ordinary), /No language server found for this action/);
          const docs: AgentToolResult<unknown> = await lsp.execute(`symbol-rename-docs-${apply}`, { ...rename, new_name: "docs" });
          assert.deepEqual(docs, ordinary, "Renaming a symbol to docs must reach the same native implementation as records");
        }
        for (const path of [current.path, join(repo.adrDir, "README.md")]) {
          const before = await readFile(path, "utf8");
          await assert.rejects(
            lsp.execute(`managed-rename-destination-${crypto.randomUUID()}`, {
              action: "rename_file",
              file: "source.ts",
              new_name: relative(root, path),
            }),
            /roadmap_stage/,
          );
          await assert.rejects(
            lsp.execute(`managed-rename-source-${crypto.randomUUID()}`, {
              action: "rename_file",
              file: relative(root, path),
              new_name: "renamed.md",
            }),
            /roadmap_stage/,
          );
          await assert.rejects(
            lsp.execute(`managed-symbol-source-${crypto.randomUUID()}`, {
              action: "rename",
              file: relative(root, path),
              line: 1,
              symbol: "oldName",
              new_name: "records",
              apply: true,
            }),
            /roadmap_stage/,
          );
          assert.equal(await readFile(path, "utf8"), before);
        }
        assert.equal(await readFile(join(root, "source.ts"), "utf8"), source);
      } else if (name === "interception-dangling") {
        for (const [alias, target] of [
          ["outside-alias.md", "docs/adr/9999-new.md"],
          ["outside-directory", "docs/roadmap/missing-directory"],
        ]) {
          assert(alias && target);
          await symlink(target, join(root, alias));
          const path = alias === "outside-directory" ? `${alias}/new.md` : alias;
          await assert.rejects(write.execute(`dangling-${alias}`, { path, content: "bad" }), /roadmap_stage/);
          await assert.rejects(readFile(join(root, alias === "outside-directory" ? `${target}/new.md` : target)), { code: "ENOENT" });
        }
        await symlink("outside-alias.md", join(root, "outside-chain.md"));
        await assert.rejects(write.execute("dangling-chain", { path: "outside-chain.md", content: "bad" }), /roadmap_stage/);
        await symlink("docs/unmanaged-new.md", join(root, "unmanaged-alias.md"));
        await write.execute("dangling-unmanaged", { path: "unmanaged-alias.md", content: "allowed\n" });
        assert.equal(await readFile(join(root, "docs/unmanaged-new.md"), "utf8"), "allowed\n");
      } else if (name === "interception-globs") {
        const source = "const guarded = 1;\n";
        const path = join(repo.roadmapDir, "guard.ts");
        await writeFile(path, source);
        const ast = h.session.getToolByName("ast_edit");
        assert(ast);
        for (const pattern of ["docs/roadm*/**/*.ts", "docs/roa?map/**/*.md"]) {
          await assert.rejects(
            ast.execute(`partial-glob-${crypto.randomUUID()}`, {
              ops: [{ pat: "const guarded = 1;", out: "const guarded = 2;" }],
              paths: [pattern],
            }),
            /roadmap_stage/,
          );
          assert.equal(await readFile(path, "utf8"), source);
        }
        await rm(path);
      } else if (name.startsWith("interception-ast-scope-")) {
        const source = "const guarded = 1;\n";
        const guards = [join(repo.roadmapDir, "guard.ts"), join(repo.adrDir, "guard.ts")];
        const ordinary = join(root, "ordinary.ts");
        const second = join(root, "second.ts");
        const ast = h.session.getToolByName("ast_edit");
        assert(ast);
        const ops = [{ pat: "const guarded = 1;", out: "const guarded = 2;" }];
        function scopes(path: string): string[] {
          if (name.endsWith("delimited")) return [`ordinary.ts;${path}`, `ordinary.ts,${path}`, `ordinary.ts ${path}`];
          if (name.endsWith("quoted")) return [`"${path}"`];
          if (name.endsWith("padded")) return [` \t${path} \n`];
          if (name.endsWith("backslashes")) return [path.replaceAll("/", "\\")];
          return ["", " \t", '""'];
        }
        try {
          for (const path of [...guards, ordinary, second]) await writeFile(path, source);
          for (const guard of guards) {
            for (const scope of scopes(relative(root, guard))) {
              await assert.rejects(
                ast.execute(`normalized-scope-${crypto.randomUUID()}`, { ops, paths: [scope] }),
                name.endsWith("errors") ? /could not validate/ : /roadmap_stage/,
                `ast_edit must refuse scope ${JSON.stringify(scope)}`,
              );
              for (const path of guards) assert.equal(await readFile(path, "utf8"), source);
            }
          }
          if (!name.endsWith("errors")) {
            for (const scope of ["ordinary.ts", ...scopes("second.ts")]) {
              for (const path of [ordinary, second]) await writeFile(path, source);
              const preview: AgentToolResult<unknown> = await ast.execute(`unrelated-normalized-${crypto.randomUUID()}`, {
                ops,
                paths: [scope],
              });
              assert(!preview.isError, JSON.stringify(preview));
              const applied: AgentToolResult<unknown> = await write.execute(`apply-normalized-${crypto.randomUUID()}`, {
                path: "xd://resolve",
                content: "Apply the unrelated AST edit.",
              });
              assert(!applied.isError, JSON.stringify(applied));
              const changed = scope === "ordinary.ts" ? ordinary : second;
              assert.equal(await readFile(changed, "utf8"), "const guarded = 2;\n");
              for (const path of guards) assert.equal(await readFile(path, "utf8"), source);
            }
          }
        } finally {
          for (const path of guards) await rm(path);
        }
      } else if (name.startsWith("interception-mode-")) {
        const mode = EDIT_MODES.find((candidate) => name === `interception-mode-${candidate}`);
        const edit = h.session.getToolByName("edit");
        const read = h.session.getToolByName("read");
        assert(mode && edit && read);
        async function inputFor(path: string): Promise<Record<string, unknown>> {
          const source = await readFile(path, "utf8");
          const heading = source.split("\n").find((line) => line.startsWith("# "));
          assert(heading);
          if (mode === "replace") return { path, old_string: heading, new_string: "# Changed" };
          if (mode === "patch") return { path, edits: [{ diff: `@@\n-${heading}\n+# Changed` }] };
          if (mode === "apply_patch") {
            return { input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-${heading}\n+# Changed\n*** End Patch` };
          }
          if (mode === "sloppy") return { input: `*** Edit File: ${path}\n*** Find\n${heading}\n*** Replace\n# Changed` };
          assert(read);
          const snapshot: AgentToolResult<unknown> = await read.execute(`mode-read-${crypto.randomUUID()}`, { path });
          const text = snapshot.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
          const tag = /\[[^\r\n]+#([A-Fa-f\d]{4})\]/.exec(text)?.[1];
          assert(tag, text);
          return { input: `[${path}#${tag}]\nPUT >$:\n+# Changed` };
        }
        for (const path of [current.path, join(repo.adrDir, "README.md")]) {
          const source = await readFile(path, "utf8");
          await assert.rejects(edit.execute(`managed-${mode}-${crypto.randomUUID()}`, await inputFor(path)), /roadmap_stage/);
          assert.equal(await readFile(path, "utf8"), source);
        }
        const ordinary = join(root, "ordinary.md");
        await writeFile(ordinary, "# Ordinary\n");
        const allowed: AgentToolResult<unknown> = await edit.execute(`ordinary-${mode}`, await inputFor(ordinary));
        assert(!allowed.isError, JSON.stringify(allowed));
        assert.match(await readFile(ordinary, "utf8"), /# Changed/);
        await assert.rejects(edit.execute(`unknown-${mode}`, { input: "Unrecognized native edit grammar" }), /could not validate/);
      } else if (name === "interception-write-hardlinks" || name === "interception-replace-hardlinks") {
        const edit = h.session.getToolByName("edit");
        assert(edit);
        for (const [index, path] of [current.path, join(repo.adrDir, "README.md")].entries()) {
          const source = await readFile(path, "utf8");
          const aliases = [join(root, `hardlink-${index}.md`), join(dirname(root), `outside-hardlink-${index}.md`)];
          for (const alias of aliases) await link(path, alias);
          const original = await stat(path, { bigint: true });
          assert.equal(original.nlink, 3n);
          for (const alias of aliases) {
            const identity = await stat(alias, { bigint: true });
            assert.equal(identity.dev, original.dev);
            assert.equal(identity.ino, original.ino);
            const mutation =
              name === "interception-write-hardlinks"
                ? write.execute(`hardlink-write-${crypto.randomUUID()}`, { path: alias, content: "bad\n" })
                : edit.execute(`hardlink-edit-${crypto.randomUUID()}`, { path: alias, old_string: source, new_string: "bad\n" });
            await assert.rejects(mutation, /roadmap_stage/);
            assert.equal(await readFile(path, "utf8"), source);
            assert.equal(await readFile(alias, "utf8"), source);
          }
          const ordinary = join(root, `ordinary-${index}.md`);
          const ordinaryAlias = join(dirname(root), `ordinary-alias-${index}.md`);
          await writeFile(ordinary, source);
          await link(ordinary, ordinaryAlias);
          const unrelated = await stat(ordinaryAlias, { bigint: true });
          assert(unrelated.dev !== original.dev || unrelated.ino !== original.ino);
          const allowed: AgentToolResult<unknown> =
            name === "interception-write-hardlinks"
              ? await write.execute(`ordinary-write-${index}`, { path: ordinaryAlias, content: "allowed\n" })
              : await edit.execute(`ordinary-edit-${index}`, { path: ordinaryAlias, old_string: source, new_string: "allowed\n" });
          assert(!allowed.isError, JSON.stringify(allowed));
          assert.equal(await readFile(ordinary, "utf8"), "allowed\n");
          assert.equal(await readFile(path, "utf8"), source);
        }
      } else if (name === "interception-hardlink-errors") {
        const edit = h.session.getToolByName("edit");
        assert(edit);
        const alias = join(dirname(root), "stat-error-alias.md");
        const dangling = join(repo.adrDir, "dangling.md");
        const source = await readFile(current.path, "utf8");
        await link(current.path, alias);
        await symlink(join(root, "nonexistent.md"), dangling);
        try {
          await assert.rejects(write.execute("hardlink-stat-write", { path: alias, content: "bad\n" }), /could not validate/);
          await assert.rejects(
            edit.execute("hardlink-stat-edit", { path: alias, old_string: source, new_string: "bad\n" }),
            /could not validate/,
          );
          assert.equal(await readFile(current.path, "utf8"), source);
        } finally {
          await rm(dangling);
        }
      } else if (name === "interception-outside-scopes") {
        const ast = h.session.getToolByName("ast_edit");
        assert(ast);
        const source = "const guarded = 1;\n";
        const guards = [join(repo.roadmapDir, "guard.ts"), join(repo.adrDir, "guard.ts")];
        for (const path of guards) await writeFile(path, source);
        try {
          for (const scope of [dirname(root), join(dirname(root), "re*/docs/roadmap/*.ts"), join(dirname(root), "re*/docs/adr/*.ts")]) {
            await assert.rejects(
              ast.execute(`outside-scope-${crypto.randomUUID()}`, {
                ops: [{ pat: "const guarded = 1;", out: "const guarded = 2;" }],
                paths: [scope],
              }),
              /roadmap_stage/,
            );
            for (const path of guards) assert.equal(await readFile(path, "utf8"), source);
          }
          const ordinaryDir = join(dirname(root), "unrelated");
          const ordinary = join(ordinaryDir, "ordinary.ts");
          await mkdir(ordinaryDir);
          await writeFile(ordinary, source);
          for (const scope of [ordinaryDir, join(ordinaryDir, "ord*.ts")]) {
            await writeFile(ordinary, source);
            const preview: AgentToolResult<unknown> = await ast.execute(`unrelated-scope-${crypto.randomUUID()}`, {
              ops: [{ pat: "const guarded = 1;", out: "const guarded = 2;" }],
              paths: [scope],
            });
            assert(!preview.isError, JSON.stringify(preview));
            assert.equal(await readFile(ordinary, "utf8"), source);
            const applied: AgentToolResult<unknown> = await write.execute(`apply-unrelated-${crypto.randomUUID()}`, {
              path: "xd://resolve",
              content: "Apply the unrelated AST edit.",
            });
            assert(!applied.isError, JSON.stringify(applied));
            assert.equal(await readFile(ordinary, "utf8"), "const guarded = 2;\n");
            for (const path of guards) assert.equal(await readFile(path, "utf8"), source);
          }
        } finally {
          for (const path of guards) await rm(path);
        }
      } else if (name === "interception-errors") {
        await symlink("cycle-b", join(root, "cycle-a"));
        await symlink("cycle-a", join(root, "cycle-b"));
        await writeFile(join(root, "ordinary.md"), "Not a directory\n");
        for (const path of ["cycle-a", "ordinary.md/child.md"]) {
          await assert.rejects(write.execute(`resolution-error-${crypto.randomUUID()}`, { path, content: "bad" }), /could not validate/);
        }
        assert.equal(await readFile(join(root, "ordinary.md"), "utf8"), "Not a directory\n");
      } else {
        const edit = h.session.getToolByName("edit");
        const read = h.session.getToolByName("read");
        assert(edit && read);
        for (const [index, absolute] of [current.path, join(repo.adrDir, "README.md")].entries()) {
          const source = await readFile(absolute, "utf8");
          const path = relative(root, absolute);
          const alias = `managed-alias-${index}.md`;
          await symlink(absolute, join(root, alias));
          const paths = [`@${absolute}`, `:${absolute}`, `~/${relative(homedir(), absolute)}`, pathToFileURL(absolute).href, alias];
          if (name === "interception-write-aliases") {
            paths.push(`[${path}#ABCD]`, `[${path}]`, `[@${absolute}#ABCD]`);
            for (const target of paths) {
              await assert.rejects(write.execute(`alias-write-${crypto.randomUUID()}`, { path: target, content: "bad" }), /roadmap_stage/);
              assert.equal(await readFile(absolute, "utf8"), source);
            }
          } else if (name === "interception-replace-aliases") {
            for (const target of paths) {
              await assert.rejects(
                edit.execute(`alias-replace-${crypto.randomUUID()}`, { path: target, old_string: source, new_string: "bad\n" }),
                /roadmap_stage/,
              );
              assert.equal(await readFile(absolute, "utf8"), source);
            }
          } else if (name === "interception-hashline-aliases") {
            const snapshot: AgentToolResult<unknown> = await read.execute(`alias-read-${index}`, { path: absolute });
            const text = snapshot.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
            const tag = /\[[^\r\n]+#([A-Fa-f\d]{4})\]/.exec(text)?.[1];
            assert(tag, text);
            for (const target of paths) {
              await assert.rejects(
                edit.execute(`alias-hashline-${crypto.randomUUID()}`, { input: `[${target}#${tag}]\nPUT >$:\n+bad` }),
                /roadmap_stage/,
              );
              assert.equal(await readFile(absolute, "utf8"), source);
            }
          } else if (name === "interception-patch-aliases") {
            const heading = source.split("\n").find((line) => line.startsWith("# "));
            assert(heading);
            for (const target of paths) {
              await assert.rejects(
                edit.execute(`alias-patch-${crypto.randomUUID()}`, {
                  input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-${heading}\n+# Bad\n*** End Patch`,
                }),
                /roadmap_stage/,
              );
              assert.equal(await readFile(absolute, "utf8"), source);
            }
          } else throw new Error(`Unknown interception case: ${name}`);
        }
      }
      assert.deepEqual((await loadAll(repo)).files, model.files);
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
    } else if (name === "closure-stage-status" || name === "closure-round-status") {
      const repo = await initialized(root);
      assert((await call(h, "roadmap_stage", { action: "start", id: "S01" })).ok);
      assert((await call(h, "roadmap_stage", closeInput)).ok);
      const isRound = name === "closure-round-status";
      if (isRound) await command(h, "roadmap", "close-round");
      const model = await loadAll(repo);
      const current = isRound ? model.rounds[0] : model.stages[0];
      assert(current);
      const raw = await readFile(current.path, "utf8");
      await writeFile(current.path, raw.replace(/^status: "closed"$/m, `status: "${isRound ? "active" : "planned"}"`));
      const before = (await loadAll(repo)).files;
      const prefix = isRound ? "frozen-round" : "closed-stage";
      for (const fix of [false, true]) {
        const receipt = await call(h, "roadmap_check", { fix });
        assert(!receipt.ok, JSON.stringify(receipt));
        for (const suffix of ["status", "hash"]) {
          assert(receipt.diagnostics?.some((item) => item.rule === `${prefix}-${suffix}` && item.severity === "error" && !item.fixable));
        }
        assert.deepEqual((await loadAll(repo)).files, before);
      }
      const initial = draft.stages[0];
      assert(initial);
      for (const [toolName, input] of [
        ["roadmap_stage", { action: "edit", id: "S01", objective: "Forbidden rewrite" }],
        ["roadmap_stage", { action: "add", ...initial, title: "Forbidden addition" }],
        ["roadmap_todo", { action: "add", title: "Forbidden TODO", severity: "low", source: "Review", trigger: "Later" }],
        [
          "roadmap_adr",
          {
            action: "create",
            title: "Forbidden ADR",
            status: "accepted",
            sections: { context: "Review", options: ["Host"], outcome: "Host" },
          },
        ],
      ] as const) {
        const receipt = await call(h, toolName, input);
        assert(!receipt.ok, JSON.stringify(receipt));
        assert(
          receipt.hints.some((hint) => hint.includes(`${prefix}-status`)),
          JSON.stringify(receipt),
        );
        assert.deepEqual((await loadAll(repo)).files, before);
      }
    } else if (name.startsWith("check-fix-queued-")) {
      const repo = await initialized(root);
      const model = await loadAll(repo);
      assert(model.stages[0] && model.rounds[0] && model.adrIndex);
      const objectiveOnly = name.endsWith("objective");
      const count = objectiveOnly ? 0 : Number(name.at(-1));
      const cancelled = name.includes("-cancel-");
      const paths = [model.index.path, model.rounds[0].path, model.adrIndex.path];
      const names = ["status", "stages", "adrs"];
      const stale = new Map<string, string>();
      let precedingWritten = false;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const preceding = stage(
        repo,
        main,
        objectiveOnly ? { action: "edit", id: "S01", objective: "Unrelated objective edit." } : { action: "start", id: "S01" },
        {
          async writeFile(path, content, options) {
            entered.resolve();
            await release.promise;
            await atomicWrite(path, content, options);
            if (path === model.index.path) {
              for (const [index, repairPath] of paths.slice(0, count).entries()) {
                const text = replaceGenerated(await readFile(repairPath, "utf8"), names[index] as string, "Stale table");
                await atomicWrite(repairPath, text);
                stale.set(repairPath, text);
              }
              precedingWritten = true;
            }
          },
        },
      );
      await entered.promise;
      const controller = new AbortController();
      let guardReads = 0;
      if (cancelled && count === 0) {
        Object.defineProperty(controller.signal, "aborted", {
          get() {
            // The first guard runs under the lock; the second is the final no-op guard.
            if (precedingWritten && ++guardReads === 2) controller.abort();
            return controller.signal.reason !== undefined;
          },
        });
      } else if (cancelled) {
        const last = paths[count - 1];
        assert(last);
        Object.defineProperty(controller.signal, "aborted", {
          get() {
            if (stale.has(last) && readFileSync(last, "utf8") !== stale.get(last) && !controller.signal.reason) controller.abort();
            return controller.signal.reason !== undefined;
          },
        });
      }
      const tool = h.session.getToolByName("roadmap_check");
      assert(tool);
      const queued = observeLockWaits()(() => tool.execute(name, { fix: true }, controller.signal));
      try {
        await queued.waiting;
        assert.deepEqual((await loadAll(repo)).files, model.files, "preceding operation is held before its first write");
      } finally {
        release.resolve();
        const receipt = await preceding;
        assert(receipt.ok, JSON.stringify(receipt));
        assert.equal(receipt.changedFiles.length, objectiveOnly ? 1 : 3);
      }
      const result = await queued.pending;
      const receipt = result.details as ToolReceipt;
      assert.equal(receipt.ok, !cancelled, JSON.stringify(receipt));
      assert.deepEqual(receipt.changedFiles?.toSorted(), paths.slice(0, count).toSorted());
      if (!receipt.ok) {
        assert.equal(result.isError, true);
        assert.deepEqual(
          receipt.diagnostics?.map((item) => item.rule),
          ["cancelled"],
        );
        const hints = receipt.hints.join("\n");
        const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
        for (const path of [model.stages[0].path, ...paths]) {
          assert.equal(hints.includes(path), paths.slice(0, count).includes(path));
        }
        if (count === 0) {
          assert.match(hints, /No files were committed by the interrupted fix/);
          assert(!hints.includes("Files committed by the interrupted fix:"));
          assert(!text.includes("Files committed by the interrupted fix:"));
          assert.equal(guardReads, 2, "zero-write cancellation occurs at the final guard");
        }
      }
      const after = await loadAll(repo);
      assert.equal(after.stages[0]?.status, objectiveOnly ? "planned" : "active");
      if (objectiveOnly) assert.equal(after.stages[0]?.objective, "Unrelated objective edit.");
      assert((await call(h, "roadmap_check", {})).ok);
      const noop = await call(h, "roadmap_check", { fix: true });
      assert(noop.ok && noop.changedFiles.length === 0);
    } else if (name.startsWith("check-fix-cancel-")) {
      const repo = await initialized(root);
      const model = await loadAll(repo);
      assert(model.rounds[0] && model.adrIndex);
      const paths = [model.index.path, model.rounds[0].path, model.adrIndex.path];
      const names = ["status", "stages", "adrs"];
      const expected = new Map<string, string>();
      const stale = new Map<string, string>();
      for (const [index, path] of paths.entries()) {
        const raw = await readFile(path, "utf8");
        const text = replaceGenerated(raw, names[index] as string, "Stale table");
        expected.set(path, raw);
        stale.set(path, text);
        await writeFile(path, text);
      }
      const before = (await loadAll(repo)).files;
      const committedCount = Number(name.slice("check-fix-cancel-".length));
      const controller = new AbortController();
      if (committedCount > 0) {
        const triggerPath = paths[committedCount - 1];
        assert(triggerPath);
        cancelAfterCommit(triggerPath, stale.get(triggerPath), controller);
      }
      const readonly = await call(h, "roadmap_check", {}, controller.signal);
      assert(!readonly.ok && readonly.diagnostics?.every((item) => item.rule === "generated"));
      assert.deepEqual((await loadAll(repo)).files, before, "read-only check ignores the fix cancellation signal and preserves bytes");
      const tool = h.session.getToolByName("roadmap_check");
      assert(tool);
      const execute = () => tool.execute(`check-cancel-${committedCount}`, { fix: true }, controller.signal);
      let result: AgentToolResult<unknown>;
      if (committedCount === 0) {
        const locked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const holding = withRepoLock(repo, async () => {
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const queued = observeLockWaits()(execute);
        try {
          await queued.waiting;
          controller.abort();
        } finally {
          release.resolve();
          await holding;
        }
        result = await queued.pending;
      } else result = await execute();
      const receipt = result.details as ToolReceipt;
      assert(controller.signal.aborted);
      assert(!receipt.ok && result.isError, JSON.stringify(receipt));
      assert.deepEqual(
        receipt.diagnostics?.map((item) => item.rule),
        ["cancelled"],
      );
      assert.deepEqual(receipt.changedFiles?.toSorted(), paths.slice(0, committedCount).toSorted());
      const hints = receipt.hints.join("\n");
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      assert.match(hints, /roadmap_check.*fix: true/);
      assert.match(text, /roadmap_check.*fix: true/);
      for (const [index, path] of paths.entries()) {
        if (index < committedCount) {
          assert(hints.includes(path) && text.includes(path));
          assert.equal(await readFile(path, "utf8"), expected.get(path));
        } else {
          assert(!hints.includes(path));
          assert.equal(await readFile(path, "utf8"), stale.get(path));
        }
      }
      assert.deepEqual(
        readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".tmp")),
        [],
      );
      const recovered = await call(h, "roadmap_check", { fix: true });
      assert(recovered.ok, JSON.stringify(recovered));
      assert.deepEqual(recovered.changedFiles.toSorted(), paths.slice(committedCount).toSorted());
      assert((await call(h, "roadmap_check", {})).ok);
      const noChanges = await call(h, "roadmap_check", { fix: true });
      assert(noChanges.ok);
      assert.deepEqual(noChanges.changedFiles, []);
    } else if (name === "prewrite-cancel") {
      const info = discoverRepo(root);
      assert(info);
      const repo: Repo = { ...info, roadmapDir: join(root, "docs/roadmap"), adrDir: join(root, "docs/adr") };
      const preview = await prepareInit(repo, main, draft);
      assert(preview.ok, JSON.stringify(preview));
      const preparedController = new AbortController();
      const preparedReceipt = await applyPrepared(repo, main, preview.prepared, {
        signal: preparedController.signal,
        guard() {
          preparedController.abort();
          return undefined;
        },
      });
      assert(!preparedReceipt.ok, JSON.stringify(preparedReceipt));
      assert.match(preparedReceipt.reason, /cancelled/i);
      for (const file of preview.files) assert.equal(await Bun.file(file.path).exists(), false);
      assert((await applyPrepared(repo, main, preview.prepared)).ok, "cancelled prepared operations remain retryable");
      const before = (await loadAll(repo)).files;
      const controller = new AbortController();
      const receipt = await stage(
        repo,
        main,
        { action: "start", id: "S01" },
        {
          signal: controller.signal,
          guard() {
            controller.abort();
            return undefined;
          },
        },
      );
      assert(!receipt.ok, JSON.stringify(receipt));
      assert.match(receipt.reason, /cancelled/i);
      assert.deepEqual((await loadAll(repo)).files, before);
    } else if (name === "midwrite-stage-start" || name === "midwrite-stage-close") {
      const repo = await initialized(root);
      assert((await call(h, "roadmap_stage", { action: "start", id: "S01" })).ok);
      const starting = name === "midwrite-stage-start";
      if (starting) {
        const initial = draft.stages[0];
        assert(initial);
        assert((await call(h, "roadmap_stage", { action: "add", ...initial, title: "Cancellation" })).ok);
      }
      const before = await loadAll(repo);
      const current = before.stages.find((candidate) => candidate.id === (starting ? "S02" : "S01"));
      assert(current);
      const stateEntries = () =>
        h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType.startsWith(ENTRY_PREFIX));
      const sessionBefore = stateEntries();
      const signal = cancelAfterCommit(current.path, await readFile(current.path, "utf8"));
      const receipt = await call(h, "roadmap_stage", starting ? { action: "start", id: current.id } : closeInput, signal);
      assert(signal.aborted);
      assert(!receipt.ok, JSON.stringify(receipt));
      assert.match(receipt.reason, /cancelled/i);
      assert(receipt.hints.some((hint) => hint.includes(relative(root, current.path))));
      assert(receipt.hints.some((hint) => hint.includes("roadmap_check") && hint.includes("fix: true")));
      const partial = await loadAll(repo);
      assert.equal(partial.stages.find((candidate) => candidate.id === current.id)?.status, starting ? "active" : "closed");
      assert.deepEqual(
        Object.entries(partial.files ?? {})
          .filter(([path, content]) => !Buffer.from(content).equals(Buffer.from(before.files?.[path] ?? "")))
          .map(([path]) => path),
        [current.path],
        "cancellation must preserve both remaining generated indexes",
      );
      assert.deepEqual(stateEntries(), sessionBefore, "cancellation must not append binding or binding-cleanup entries");
      assert.deepEqual(
        readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".tmp")),
        [],
      );
      const stale = await call(h, "roadmap_check", {});
      assert(!stale.ok);
      assert(stale.diagnostics?.some((item) => item.rule === "generated" && item.fixable));
      const fixed = await call(h, "roadmap_check", { fix: true });
      assert(fixed.ok, JSON.stringify(fixed));
      const checked = await call(h, "roadmap_check", {});
      assert(checked.ok, JSON.stringify(checked));
      assert.deepEqual(checked.diagnostics, []);
      assert.deepEqual(stateEntries(), sessionBefore);
      if (starting) assert.match(await injection(h), /Bound stage: S01/);
    } else if (name === "midwrite-init" || name === "midwrite-round-open") {
      const initializing = name === "midwrite-init";
      let before: Model["files"] = {};
      if (!initializing) {
        const repo = await initialized(root);
        assert((await call(h, "roadmap_stage", { action: "drop", id: "S01", reason: "Deferred" })).ok);
        await command(h, "roadmap", "close-round");
        before = (await loadAll(repo)).files;
      }
      await command(h, initializing ? "init-project" : "roadmap", initializing ? "" : "new-round");
      const stateEntries = () =>
        h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType.startsWith(ENTRY_PREFIX));
      const sessionBefore = stateEntries();
      const controller = new AbortController();
      let first: string | undefined;
      h.ui.preview = async (preview) => {
        first = preview.files[0]?.path;
        assert(first);
        const content = before?.[first];
        cancelAfterCommit(first, content === undefined ? undefined : Buffer.from(content).toString("utf8"), controller);
        return true;
      };
      const toolName = initializing ? "roadmap_init" : "roadmap_round_open";
      const input = initializing ? { ...draft } : { round: { ...draft.round, title: "Next" }, import_todos: [] };
      const receipt = await call(h, toolName, input, controller.signal);
      assert(controller.signal.aborted);
      assert(!receipt.ok, JSON.stringify(receipt));
      assert.match(receipt.reason, /cancelled/i);
      assert(first);
      const firstPath = relative(root, first);
      assert(receipt.hints.some((hint) => hint.includes(firstPath)));
      const preview = h.ui.previewCalls[0];
      assert(preview);
      for (const file of preview.files) {
        const original = before?.[file.path];
        if (file.path === first) assert.equal(await readFile(file.path, "utf8"), file.content);
        else if (original !== undefined) assert.equal(await readFile(file.path, "utf8"), Buffer.from(original).toString("utf8"));
        else assert.equal(await Bun.file(file.path).exists(), false, `${file.path} was written after cancellation`);
      }
      for (const [path, content] of Object.entries(before ?? {})) {
        if (path !== first) assert.equal(await readFile(path, "utf8"), Buffer.from(content).toString("utf8"));
      }
      assert.deepEqual(stateEntries(), sessionBefore, "cancellation must not consume initialization or round-opening arming");
      assert.equal(await h.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input }), undefined);
      assert.deepEqual(stateEntries(), sessionBefore);
      assert.deepEqual(
        readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".tmp")),
        [],
      );
    } else if (name === "midwrite-overlap-free") {
      const repo = await initialized(root);
      const before = await loadAll(repo);
      const current = before.stages[0];
      assert(current);
      const original = await readFile(current.path, "utf8");
      const signal = cancelAfterCommit(current.path, original);
      const receipt = await call(h, "roadmap_overlap", { stage: current.id, intent: "Inspect cancelled free work" }, signal);
      assert(signal.aborted);
      assert(!receipt.ok, JSON.stringify(receipt));
      assert.match(receipt.reason, /cancelled/i);
      assert.equal(
        h.session.sessionManager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom" && (entry.customType === `${ENTRY_PREFIX}binding` || entry.customType === `${ENTRY_PREFIX}overlap`),
          ).length,
        0,
      );
      const partial = await loadAll(repo);
      assert.match(partial.stages[0]?.free_work_log ?? "", /Inspect cancelled free work/);
      for (const [path, content] of Object.entries(before.files ?? {})) {
        if (path !== current.path) assert.equal(await readFile(path, "utf8"), Buffer.from(content).toString("utf8"));
      }
      assert.deepEqual(
        readdirSync(join(root, "docs"), { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".tmp")),
        [],
      );
      await writeFile(current.path, original);
      const retry = await call(h, "roadmap_overlap", { stage: current.id, intent: "Inspect uncancelled free work" });
      assert(retry.ok, JSON.stringify(retry));
      assert.equal(retry.answer, "free");
      assert.equal(h.ui.overlapCalls.length, 2, "a cancelled commit must not cache the dialog answer");
      assert.equal((await loadAll(repo)).stages[0]?.free_work_log.split("\n").length, 1);
    } else if (name === "init-lock-cancel" || name === "round-lock-cancel") {
      const init = name === "init-lock-cancel";
      const info = discoverRepo(root);
      assert(info);
      const repo: Repo = init
        ? { ...info, roadmapDir: join(root, "docs/roadmap"), adrDir: join(root, "docs/adr") }
        : await initialized(root);
      if (!init) {
        assert((await call(h, "roadmap_stage", { action: "drop", id: "S01", reason: "Defer" })).ok);
        await command(h, "roadmap", "close-round");
        assert.equal((await loadAll(repo)).rounds[0]?.status, "closed");
      }
      const before = init ? undefined : (await loadAll(repo)).files;
      const toolName = init ? "roadmap_init" : "roadmap_round_open";
      const input = init ? { ...draft } : { round: { ...draft.round, title: "Next" }, import_todos: [] };
      await command(h, init ? "init-project" : "roadmap", init ? "" : "new-round");
      const disarms = () =>
        h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === `${ENTRY_PREFIX}disarmed`)
          .length;
      const initialDisarms = disarms();
      const controller = new AbortController();
      const { receipt, preview } = await confirmedPreviewBehindLock(
        h,
        repo,
        toolName,
        input,
        async () => controller.abort(),
        controller.signal,
      );
      assert(controller.signal.aborted);
      assert(!receipt.ok, JSON.stringify(receipt));
      assert.match(receipt.reason, /cancelled/i);
      if (init) {
        assert.equal(await loadRepo(root), null);
        assert.equal(await Bun.file(repo.roadmapDir).exists(), false);
        for (const file of preview.files)
          assert.equal(await Bun.file(file.path).exists(), false, `${file.path} was written after cancellation`);
      } else {
        assert.deepEqual((await loadAll(repo)).files, before, "cancelled round open must preserve all managed bytes");
        for (const file of preview.files.filter((file) => !(file.path in (before ?? {}))))
          assert.equal(await Bun.file(file.path).exists(), false, `${file.path} was written after cancellation`);
      }
      assert.equal(disarms(), initialDisarms, "cancellation must not consume arming");
      assert.equal(await h.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input }), undefined);
      const retry = await confirmedPreviewBehindLock(h, repo, toolName, input, async () => {});
      assert(retry.receipt.ok, JSON.stringify(retry.receipt));
      for (const file of retry.preview.files) assert.equal(await readFile(file.path, "utf8"), file.content);
      assert.equal(disarms(), initialDisarms + 1, "only the successful retry consumes arming");
    } else if (name === "mutation-lock-cancel") {
      const repo = await initialized(root);
      const indexPath = join(repo.roadmapDir, "README.md");
      const expectedIndex = await readFile(indexPath, "utf8");
      await writeFile(indexPath, replaceGenerated(expectedIndex, "status", "Stale status awaiting repair"));
      const before = (await loadAll(repo)).files;
      for (const [toolName, input] of [
        ["roadmap_stage", { action: "start", id: "S01" }],
        ["roadmap_todo", { action: "add", title: "Check retry", severity: "normal", source: "Review", target: "S01" }],
        [
          "roadmap_adr",
          { action: "create", title: "Use local storage", sections: { context: "Persist data", options: ["Local"], outcome: "Use local" } },
        ],
        ["roadmap_overlap", { stage: "S01", intent: "Inspect payments" }],
        ["roadmap_check", { fix: true }],
      ] as Array<[string, Record<string, unknown>]>) {
        const controller = new AbortController();
        const locked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const holding = withRepoLock(repo, async () => {
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const queued = observeLockWaits()(() => call(h, toolName, input, controller.signal));
        try {
          await queued.waiting;
          controller.abort();
        } finally {
          release.resolve();
          await holding;
        }
        const receipt = await queued.pending;
        assert(!receipt.ok, `${toolName}: ${JSON.stringify(receipt)}`);
        assert.match(receipt.reason, /cancelled/i);
        assert.deepEqual((await loadAll(repo)).files, before, `${toolName} changed managed bytes after cancellation`);
        assert.equal(
          h.session.sessionManager
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "custom" && (entry.customType === `${ENTRY_PREFIX}binding` || entry.customType === `${ENTRY_PREFIX}overlap`),
            ).length,
          0,
          "cancelled mutations must not change session bindings or overlap answers",
        );
      }
      const checked = await call(h, "roadmap_check", {});
      assert(!checked.ok);
      assert(checked.diagnostics?.some((item) => item.rule === "generated"));
      assert.deepEqual((await loadAll(repo)).files, before, "read-only check must preserve stale managed bytes");
      const repaired = await call(h, "roadmap_check", { fix: true });
      assert(repaired.ok, JSON.stringify(repaired));
      assert.deepEqual(repaired.changedFiles, [indexPath]);
      assert.equal(await readFile(indexPath, "utf8"), expectedIndex);
      assert((await call(h, "roadmap_stage", { action: "start", id: "S01" })).ok);
      assert((await call(h, "roadmap_stage", closeInput)).ok);
      const closeModel = await loadAll(repo);
      const beforeClose = closeModel.files;
      const round = closeModel.rounds[0];
      assert(round);
      const expected = { id: round.id, sha256: roundSha256(roundFiles(closeModel, round)) };
      const controller = new AbortController();
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holding = withRepoLock(repo, async () => {
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const queued = observeLockWaits()(() => closeRound(repo, main, { expected, dispositions: [] }, { signal: controller.signal }));
      try {
        await queued.waiting;
        controller.abort();
      } finally {
        release.resolve();
        await holding;
      }
      const receipt = await queued.pending;
      assert(!receipt.ok, JSON.stringify(receipt));
      assert.match(receipt.reason, /cancelled/i);
      assert.deepEqual((await loadAll(repo)).files, beforeClose, "cancelled closeRound must preserve managed bytes");
      h.ui.dispositions = undefined;
      await command(h, "roadmap", "close-round");
      assert.deepEqual((await loadAll(repo)).files, beforeClose, "cancelled command dispositions must not authorize round close");
      h.ui.dispositions = [];
      await command(h, "roadmap", "close-round");
      assert.equal((await loadAll(repo)).rounds[0]?.status, "closed");
    } else if (name === "init-lock-authority" || name === "round-lock-authority") {
      const init = name === "init-lock-authority";
      const info = discoverRepo(root);
      assert(info);
      const repo: Repo = init
        ? { ...info, roadmapDir: join(root, "docs/roadmap"), adrDir: join(root, "docs/adr") }
        : await initialized(root);
      if (!init) {
        assert((await call(h, "roadmap_stage", { action: "drop", id: "S01", reason: "Defer" })).ok);
        await command(h, "roadmap", "close-round");
        assert.equal((await loadAll(repo)).rounds[0]?.status, "closed");
      }
      const before = init ? undefined : (await loadAll(repo)).files;
      const rootLeaf = h.session.sessionManager.appendCustomEntry("roadmap-regression-root", { name });
      const toolName = init ? "roadmap_init" : "roadmap_round_open";
      const input: Record<string, unknown> = init ? { ...draft } : { round: { ...draft.round, title: "Next" }, import_todos: [] };
      const arm = async () => command(h, init ? "init-project" : "roadmap", init ? "" : "new-round");
      const disarmedCount = () =>
        h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === `${ENTRY_PREFIX}disarmed`)
          .length;
      const initialDisarms = disarmedCount();
      const unchanged = async (preview: ScriptedUi["previewCalls"][number]) => {
        assert(preview.files.length >= (init ? 5 : 3));
        if (init) {
          assert.equal(await loadRepo(root), null);
          for (const file of preview.files)
            assert.equal(await Bun.file(file.path).exists(), false, `${file.path} was written after authority changed`);
        } else {
          assert.deepEqual((await loadAll(repo)).files, before, "all managed round bytes must remain unchanged");
        }
      };
      for (const event of ["session_tree", "session_branch"] as const) {
        await arm();
        const { receipt, preview } = await confirmedPreviewBehindLock(h, repo, toolName, input, async (shown) => {
          await unchanged(shown);
          const armedLeaf = h.session.sessionManager.getLeafId();
          assert(armedLeaf);
          h.session.sessionManager.branch(rootLeaf);
          if (event === "session_tree") await h.runner.emit({ type: event, oldLeafId: armedLeaf, newLeafId: rootLeaf });
          else await h.runner.emit({ type: event, previousSessionFile: undefined });
          const fresh = await h.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input });
          assert.equal(fresh?.block, true, "the rebuilt branch must be unarmed for new calls");
          assert.match(fresh.reason ?? "", /unarmed/);
          assert.equal(disarmedCount(), initialDisarms);
        });
        assert(!receipt.ok, `${event}: ${JSON.stringify(receipt)}`);
        assert.match(receipt.reason, /changed|stale|unarmed/i);
        await unchanged(preview);
        assert.equal(disarmedCount(), initialDisarms);
      }
      await arm();
      const generationOnly = await confirmedPreviewBehindLock(h, repo, toolName, input, async () => {
        await h.runner.emit({ type: "session_branch", previousSessionFile: undefined });
        assert.equal(
          await h.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input }),
          undefined,
          "this branch is still armed but its session generation changed",
        );
      });
      assert(!generationOnly.receipt.ok, JSON.stringify(generationOnly.receipt));
      assert.match(generationOnly.receipt.reason, /changed|stale/i);
      await unchanged(generationOnly.preview);
      assert.equal(disarmedCount(), initialDisarms, "refusals must not consume the current arming");
      const success = await confirmedPreviewBehindLock(h, repo, toolName, input, async (preview) => {
        await unchanged(preview);
        assert.equal(disarmedCount(), initialDisarms, "authorization must remain armed while the confirmed write waits for the lock");
      });
      assert(success.receipt.ok, JSON.stringify(success.receipt));
      assert.deepEqual([...success.receipt.changedFiles].sort(), success.preview.files.map((file) => relative(root, file.path)).sort());
      for (const file of success.preview.files) assert.equal(await readFile(file.path, "utf8"), file.content);
      assert.equal(disarmedCount(), initialDisarms + 1, "only the successful write consumes the arming");
      const consumed = await h.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input });
      assert.equal(consumed?.block, true);
      assert.match(consumed.reason ?? "", /unarmed/);
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
    } else if (name === "menu") {
      const repo = await initialized(root);
      assert((await stage(repo, main, { action: "start", id: "S01" })).ok);
      const before = (await loadAll(repo)).files;
      h.ui.menu = { action: "close", stage: "S01" };
      await command(h, "roadmap");
      const message = h.ui.notifications.at(-1)?.message ?? "";
      assert.match(message, /roadmap_stage/);
      assert.match(message, /S01/);
      assert.match(message, /evidence/);
      assert.equal(h.kickoffs.length, 0);
      assert.equal(h.messages.length, 0);
      assert.deepEqual((await loadAll(repo)).files, before);
      assert.equal((await loadAll(repo)).stages[0]?.status, "active");
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
      } else if (name.startsWith("overlap-flight-")) {
        const overlapEntries = () =>
          h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === `${ENTRY_PREFIX}overlap`);
        const currentStage = async () => {
          const current = (await loadAll(repo)).stages.find((candidate) => candidate.id === "S01");
          assert(current);
          return current;
        };
        if (name === "overlap-flight-rebuild") {
          for (const type of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
            const before = await readFile((await currentStage()).path, "utf8");
            const held = holdOverlap(h);
            const pending = call(h, "roadmap_overlap", { stage: "S01", intent: `Stale ${type}` });
            await held.shown;
            const leaf = h.session.sessionManager.appendCustomEntry("roadmap-regression", { type });
            if (type === "session_start") await h.runner.emit({ type });
            if (type === "session_switch") await h.runner.emit({ type, reason: "resume", previousSessionFile: undefined });
            if (type === "session_branch") await h.runner.emit({ type, previousSessionFile: undefined });
            if (type === "session_tree") await h.runner.emit({ type, oldLeafId: leaf, newLeafId: leaf });
            const fresh = holdOverlap(h);
            const next = call(h, "roadmap_overlap", { stage: "S01", intent: `Current ${type}` });
            await fresh.shown;
            held.resolve("free");
            const receipt = await pending;
            assert(!receipt.ok, JSON.stringify(receipt));
            assert.match(receipt.reason, /stale/i);
            assert.equal(receipt.answer, undefined);
            assert.equal((await currentStage()).free_work_log, "");
            assert.equal(overlapEntries().length, 0);
            assert.equal(await readFile((await currentStage()).path, "utf8"), before);
            fresh.resolve(undefined);
            assert(!(await next).ok);
          }
          h.ui.overlap = async (question) => {
            h.ui.overlapCalls.push(question);
            return "free";
          };
          assert((await call(h, "roadmap_overlap", { stage: "S01", intent: "Current branch work" })).ok);
          assert.equal(h.ui.overlapCalls.length, 9);
          assert.equal((await currentStage()).free_work_log.split("\n").length, 1);
          assert.equal(overlapEntries().length, 1);
        } else {
          if (name === "overlap-flight-join" || name === "overlap-flight-closed")
            assert((await stage(repo, main, { action: "start", id: "S01" })).ok);
          const held = holdOverlap(h);
          const pending = call(h, "roadmap_overlap", { stage: "S01", intent: "First free-work request" });
          await held.shown;
          if (name === "overlap-flight-concurrent" || name === "overlap-flight-cancel" || name === "overlap-flight-error") {
            const second = call(h, "roadmap_overlap", { stage: "S01", intent: "Second free-work request" });
            assert((await call(h, "roadmap_status", {})).ok);
            if (name === "overlap-flight-error") held.reject(new Error("Overlap dialog failed"));
            else held.resolve(name === "overlap-flight-cancel" ? undefined : "free");
            const receipts = await Promise.all([pending, second]);
            assert.equal(h.ui.overlapCalls.length, 1, "concurrent native calls must share the pending dialog");
            if (name === "overlap-flight-concurrent") {
              for (const receipt of receipts) {
                assert(receipt.ok, JSON.stringify(receipt));
                assert.equal(receipt.answer, "free");
              }
              assert.equal((await call(h, "roadmap_overlap", { stage: "S01", intent: "Stored answer" })).answer, "free");
              assert.equal(h.ui.overlapCalls.length, 1);
            } else {
              for (const receipt of receipts) {
                assert(!receipt.ok, JSON.stringify(receipt));
                assert.match(receipt.reason, name === "overlap-flight-error" ? /Overlap dialog failed/ : /no answer available/);
              }
              assert.equal((await currentStage()).free_work_log, "");
              assert.equal(overlapEntries().length, 0);
              h.ui.overlap = async (question) => {
                h.ui.overlapCalls.push(question);
                return "free";
              };
              assert((await call(h, "roadmap_overlap", { stage: "S01", intent: "Retried free work" })).ok);
              assert.equal(h.ui.overlapCalls.length, 2);
            }
            const log = (await currentStage()).free_work_log;
            assert.equal(log.split("\n").length, 1);
            assert(!log.includes("Second free-work request"));
            assert.equal(overlapEntries().length, 1);
          } else if (name === "overlap-flight-start" || name === "overlap-flight-join") {
            const started = await call(h, "roadmap_stage", { action: "start", id: "S01" });
            assert(started.ok, JSON.stringify(started));
            if (name === "overlap-flight-join") assert(started.warnings.includes("another session may be working on this stage"));
            const before = await readFile((await currentStage()).path, "utf8");
            held.resolve("free");
            const receipt = await pending;
            assert(receipt.ok, JSON.stringify(receipt));
            assert.equal(receipt.answer, "roadmap");
            assert.match(receipt.summary, /already working in-system/);
            assert.match(receipt.handoff ?? "", /DC1/);
            assert.deepEqual(receipt.changedFiles, []);
            assert.equal(overlapEntries().length, 0);
            assert.equal((await currentStage()).free_work_log, "");
            assert.equal(await readFile((await currentStage()).path, "utf8"), before);
            assert.match(await injection(h), /Bound stage: S01/);
          } else if (name === "overlap-flight-closed" || name === "overlap-flight-dropped") {
            assert(
              (
                await stage(
                  repo,
                  { sessionId: "external-process", kind: "main" },
                  name === "overlap-flight-closed" ? closeInput : { action: "drop", id: "S01", reason: "Deferred during dialog" },
                )
              ).ok,
            );
            const before = await readFile((await currentStage()).path, "utf8");
            held.resolve("free");
            const receipt = await pending;
            assert(!receipt.ok, JSON.stringify(receipt));
            assert.match(receipt.reason, /stale/i);
            assert.equal(receipt.answer, undefined);
            assert.equal(overlapEntries().length, 0);
            assert.equal((await currentStage()).free_work_log, "");
            assert.equal(await readFile((await currentStage()).path, "utf8"), before);
          } else if (name === "overlap-flight-isolated") {
            assert((await call(h, "roadmap_stage", { action: "add", ...draft.stages[0], title: "Second stage" })).ok);
            const other = await createHarness(root);
            const factory: UiFactory = (ctx) =>
              ctx.sessionManager.getSessionId() === h.session.sessionManager.getSessionId() ? h.ui : other.ui;
            h.setUi(factory);
            other.setUi(factory);
            try {
              assert.equal((await call(h, "roadmap_overlap", { stage: "S02", intent: "Different stage" })).answer, "free");
              assert.equal((await call(other, "roadmap_overlap", { stage: "S01", intent: "Different session" })).answer, "free");
              assert.equal(other.ui.overlapCalls.length, 1);
              held.resolve("free");
              assert.equal((await pending).answer, "free");
              assert.equal(h.ui.overlapCalls.length, 2);
              const log = (await currentStage()).free_work_log;
              assert.equal(log.split("\n").length, 2);
              assert.match(log, new RegExp(h.session.sessionManager.getSessionId()));
              assert.match(log, new RegExp(other.session.sessionManager.getSessionId()));
            } finally {
              other.setUi();
              await other.session.dispose();
            }
          } else throw new Error(`Unknown overlap case: ${name}`);
        }
      } else if (name.startsWith("overlap-lock-")) {
        const observe = observeLockWaits();
        const answers = () =>
          h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === `${ENTRY_PREFIX}overlap`);
        if (name === "overlap-lock-rebuild") {
          for (const answer of ["free", "roadmap"] as const) {
            for (const type of ["session_branch", "session_tree"] as const) {
              const before = (await loadAll(repo)).files;
              const held = holdOverlap(h);
              let settled = false;
              const queued = observe(() => call(h, "roadmap_overlap", { stage: "S01", intent: `Locked ${answer} ${type}` }));
              const pending = queued.pending.finally(() => {
                settled = true;
              });
              await held.shown;
              const locked = Promise.withResolvers<void>();
              const release = Promise.withResolvers<void>();
              const holding = withRepoLock(repo, async () => {
                locked.resolve();
                await release.promise;
              });
              await locked.promise;
              try {
                held.resolve(answer);
                await queued.waiting;
                assert.equal(settled, false, "the answered overlap must still be waiting for the repository lock");
                assert.deepEqual((await loadAll(repo)).files, before);
                const leaf = h.session.sessionManager.appendCustomEntry("roadmap-regression", { type, answer });
                if (type === "session_branch") await h.runner.emit({ type, previousSessionFile: undefined });
                else await h.runner.emit({ type, oldLeafId: leaf, newLeafId: leaf });
              } finally {
                release.resolve();
                await holding;
              }
              const receipt = await pending;
              assert(!receipt.ok, JSON.stringify(receipt));
              assert.match(receipt.reason, /stale/i);
              assert.equal(receipt.answer, undefined);
              assert.deepEqual((await loadAll(repo)).files, before, "a stale locked answer must leave every managed byte unchanged");
              assert.equal(answers().length, 0);
              assert.equal(
                h.session.sessionManager
                  .getBranch()
                  .filter((entry) => entry.type === "custom" && entry.customType === `${ENTRY_PREFIX}binding`).length,
                0,
              );
            }
          }
          assert.equal(h.ui.overlapCalls.length, 4);
        } else {
          const held = holdOverlap(h);
          const queued = observe(() => call(h, "roadmap_overlap", { stage: "S01", intent: "Late locked free work" }));
          const pending = queued.pending;
          await held.shown;
          const locked = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const holding = withRepoLock(repo, async () => {
            locked.resolve();
            await release.promise;
          });
          await locked.promise;
          let preceding: Promise<ToolReceipt>;
          try {
            const earlier = observe(() =>
              call(
                h,
                "roadmap_stage",
                name === "overlap-lock-start" ? { action: "start", id: "S01" } : { action: "drop", id: "S01", reason: "Deferred" },
              ),
            );
            preceding = earlier.pending;
            await earlier.waiting;
            held.resolve("free");
            await queued.waiting;
          } finally {
            release.resolve();
            await holding;
          }
          const started = await preceding;
          assert(started.ok, JSON.stringify(started));
          const receipt = await pending;
          if (name === "overlap-lock-start") {
            assert(receipt.ok, JSON.stringify(receipt));
            assert.equal(receipt.answer, "roadmap");
            assert.match(receipt.summary, /already working in-system/);
            assert.match(receipt.handoff ?? "", /DC1/);
            assert.deepEqual(receipt.changedFiles, []);
            assert.match(await injection(h), /Bound stage: S01/);
          } else {
            assert(!receipt.ok, JSON.stringify(receipt));
            assert.match(receipt.reason, /stale/i);
            assert.equal(receipt.answer, undefined);
          }
          const current = (await loadAll(repo)).stages[0];
          assert.equal(current?.free_work_log, "");
          assert.equal(current?.status, name === "overlap-lock-start" ? "active" : "dropped");
          assert.equal(answers().length, 0);
        }
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
      } else if (name.startsWith("round-menu-")) {
        assert((await call(h, "roadmap_stage", { action: "drop", id: "S01", reason: "Defer" })).ok);
        const other = await createHarness(root);
        const shown = Promise.withResolvers<void>();
        const picked = Promise.withResolvers<string>();
        const dialogs: Array<{ title: string; options: unknown[] }> = [];
        h.setUi((ctx) =>
          ctx.sessionManager.getSessionId() === h.session.sessionManager.getSessionId()
            ? createTuiUi({
                hasUI: true,
                ui: {
                  ...ctx.ui,
                  select: async (title, options) => {
                    dialogs.push({ title, options });
                    shown.resolve();
                    return picked.promise;
                  },
                },
              })
            : other.ui,
        );
        try {
          const closing = command(h, "roadmap");
          await shown.promise;
          assert.match(dialogs[0]?.title ?? "", /Roadmap R1 Launch \[active\]/);
          assert(dialogs[0]?.options.includes("Close round R1"));
          if (name === "round-menu-stale") {
            await command(other, "roadmap", "close-round");
            assert.equal((await loadAll(repo)).rounds[0]?.status, "closed");
            await command(other, "roadmap", "new-round");
            assert((await call(other, "roadmap_round_open", { round: { ...draft.round, title: "Replacement" }, import_todos: [] })).ok);
          } else if (name === "round-menu-changed") {
            const receipt = await call(other, "roadmap_todo", {
              action: "add",
              title: "Later",
              source: "User",
              severity: "normal",
              trigger: "Next round",
            });
            assert(receipt.ok, JSON.stringify(receipt));
          }
          const before = (await loadAll(repo)).files;
          picked.resolve("Close round R1");
          await closing;
          const model = await loadAll(repo);
          if (name === "round-menu-close") {
            assert.equal(model.rounds[0]?.status, "closed");
            assert(model.rounds[0]?.frozen_sha256);
            assert.match(h.messages.at(-1) ?? "", /Closed and froze R1/);
          } else {
            assert.equal(model.rounds.find((round) => round.status === "active")?.id, name === "round-menu-stale" ? "R2" : "R1");
            assert.deepEqual(model.files, before);
            assert.match(h.messages.at(-1) ?? "", /stale/);
            assert.match(h.messages.at(-1) ?? "", /Run \/roadmap close-round again/);
          }
          assert.equal(dialogs.length, 1);
        } finally {
          other.setUi();
          other.session.dispose();
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
