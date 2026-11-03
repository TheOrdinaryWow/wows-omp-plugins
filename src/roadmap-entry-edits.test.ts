import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAll, type Repo, renderStage, type StageDoc } from "../plugins/roadmap/src/documents.ts";
import { discoverRepo } from "../plugins/roadmap/src/git.ts";
import {
  type Actor,
  initProject,
  type Receipt,
  recordFreeWork,
  type StageOperationInput,
  stage,
} from "../plugins/roadmap/src/operations.ts";
import { checkReceipt, toolResult } from "../plugins/roadmap/src/tools.ts";
import { adrApi } from "./roadmap-fixtures.ts";

const actor: Actor = { sessionId: "entry-editor", kind: "main" };
const directories: string[] = [];

async function git(repo: Repo, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-c", "user.name=Entry tests", "-c", "user.email=entries@example.invalid", ...args], {
    cwd: repo.repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(error);
}

function success(receipt: Receipt): Extract<Receipt, { ok: true }> {
  if (!receipt.ok) throw new Error(`${receipt.reason}\n${receipt.hints.join("\n")}`);
  return receipt;
}

async function clean(repo: Repo): Promise<void> {
  const receipt = success(await checkReceipt(repo));
  expect(receipt.summary).toContain("Roadmap check passed.");
}

async function current(repo: Repo): Promise<StageDoc> {
  const found = (await loadAll(repo)).stages.find((item) => item.id === "S01");
  if (!found) throw new Error("Missing test stage");
  return found;
}

async function fixture(mode: "unborn" | "untracked" | "tracked" = "unborn"): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "roadmap-entry-edit-"));
  directories.push(root);
  const child = Bun.spawn(["git", "init", "-q", root], { stdout: "pipe", stderr: "pipe" });
  if (await child.exited) throw new Error(await new Response(child.stderr).text());
  const info = discoverRepo(root);
  if (!info) throw new Error("Missing test git repository");
  const repo: Repo = { ...info, roadmapDir: join(root, "docs/roadmap"), adrDir: join(root, "docs/adr"), adr: adrApi() };
  if (mode === "untracked") await git(repo, "commit", "--allow-empty", "-qm", "Initial repository");
  success(
    await initProject(repo, actor, {
      project: { name: "Entry editing", description: "Exercise roadmap entry corrections." },
      round: { title: "Delivery", goal: "Deliver the agreed scope", constraints: [], non_goals: [], principles: [] },
      adrs: [],
      stages: [
        {
          title: "Deliver",
          objective: "Deliver the agreed behavior",
          scope_in: ["First", "Second", "Third"],
          scope_out: ["Later", "Never"],
          done_criteria: [
            { id: "DC1", statement: "First criterion", verify: "Original first verification" },
            { id: "DC2", statement: "Second criterion", verify: "Original second verification" },
            { id: "DC3", statement: "Third criterion", verify: "Original third verification" },
          ],
        },
      ],
    }),
  );
  success(await stage(repo, actor, { action: "start", id: "S01" }));
  if (mode === "tracked") {
    await git(repo, "add", "docs");
    await git(repo, "commit", "-qm", "Baseline stage");
  }
  await clean(repo);
  return repo;
}

async function edit(repo: Repo, input: StageOperationInput): Promise<Extract<Receipt, { ok: true }>> {
  const receipt = success(await stage(repo, actor, { id: "S01", ...input }));
  await clean(repo);
  return receipt;
}

async function refuseUnchanged(repo: Repo, input: StageOperationInput, message: string): Promise<void> {
  const path = (await current(repo)).path;
  const before = await readFile(path);
  const receipt = await stage(repo, actor, { id: "S01", ...input });
  expect(receipt.ok).toBe(false);
  if (receipt.ok) throw new Error("Expected refusal");
  expect(receipt.reason.toLowerCase()).toContain(message.toLowerCase());
  expect(await readFile(path)).toEqual(before);
  await clean(repo);
}

const amendment: StageOperationInput = {
  action: "amend",
  reason: "Original adjustment",
  target: "2026-12-12",
  amendments: {
    modify: [{ id: "DC1", statement: 'First revised "criterion"', verify: "Revised first verification" }],
    remove: ["DC2", "DC3"],
    add: [{ statement: "Added criterion", verify: "Added verification" }],
    scope: [
      { op: "remove", side: "in", item: "Second" },
      { op: "add", side: "in", item: "Fourth" },
      { op: "remove", side: "out", item: "Later" },
    ],
  },
};

afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

describe("roadmap uncommitted entries", () => {
  for (const mode of ["unborn", "untracked", "tracked"] as const) {
    test(`${mode}: revise and delete amendments undo every effect and restore canonical bytes`, async () => {
      const repo = await fixture(mode);
      const path = (await current(repo)).path;
      const before = await readFile(path);
      expect((await edit(repo, amendment)).summary).toContain("Amendment index: 0");
      await edit(repo, {
        action: "revise_amendment",
        index: 0,
        reason: "Replacement adjustment",
        target: "2026-12-20",
        amendments: { modify: [{ id: "DC2", statement: "Replacement criterion", verify: "Replacement verification" }] },
      });
      const revised = await current(repo);
      expect(revised.target).toBe("2026-12-20");
      expect(revised.scope_in).toBe("- First\n- Second\n- Third");
      expect(revised.done_criteria).toContain("DC3 — Third criterion");
      expect(revised.done_criteria).toContain("DC1 — First criterion");
      expect(revised.done_criteria).toContain("DC2 — Replacement criterion");
      expect(revised.amendments).toContain("Replacement adjustment");
      expect(revised.amendments).not.toContain("Original adjustment");
      expect(revised.amendments).not.toContain("Added criterion");
      const receipt = await edit(repo, { action: "delete_amendment", index: 0 });
      expect(await readFile(path)).toEqual(before);
      expect(toolResult(receipt).content[0]?.text).toContain("Commit these files per the project's rules.");
    });

    test(`${mode}: revise and delete free work restore bytes and preserve attribution`, async () => {
      const repo = await fixture(mode);
      const path = (await current(repo)).path;
      const before = await readFile(path);
      const receipt = success(await recordFreeWork(repo, actor, { stage: "S01", intent: "Original intent" }));
      expect(receipt.summary).toContain("Free-work index: 0");
      await clean(repo);
      await edit(repo, { action: "revise_free_work", index: 0, intent: "Replacement   intent" });
      const log = (await current(repo)).free_work_log;
      expect(log).toContain('session entry-editor · "Replacement intent"');
      expect(log).not.toContain("Original intent");
      await edit(repo, { action: "delete_free_work", index: 0 });
      expect(await readFile(path)).toEqual(before);
    });
  }

  test("committed entries stay immutable despite unrelated changes and new editable entries", async () => {
    const repo = await fixture("tracked");
    await edit(repo, {
      action: "amend",
      reason: "Committed adjustment",
      amendments: { add: [{ statement: "Committed criterion", verify: "Committed verification" }] },
    });
    success(await recordFreeWork(repo, actor, { stage: "S01", intent: "Committed intent" }));
    await clean(repo);
    await git(repo, "add", "docs");
    await git(repo, "commit", "-qm", "Record baseline entries");
    for (const action of ["revise_amendment", "delete_amendment", "revise_free_work", "delete_free_work"] as const)
      await refuseUnchanged(repo, { action, index: 0, reason: "No", intent: "No" }, "committed");
    const doc = await current(repo);
    doc.risks = "Unrelated uncommitted edit";
    await writeFile(doc.path, renderStage(doc));
    const baseline = await readFile(doc.path);
    await edit(repo, amendment);
    success(await recordFreeWork(repo, actor, { stage: "S01", intent: "New intent" }));
    await clean(repo);
    await refuseUnchanged(repo, { action: "delete_amendment", index: 0 }, "committed");
    await refuseUnchanged(repo, { action: "revise_free_work", index: 0, intent: "No" }, "committed");
    await edit(repo, { action: "revise_amendment", index: 1, reason: "New replacement", target: "2026-12-26" });
    await edit(repo, { action: "revise_free_work", index: 1, intent: "New replacement intent" });
    await edit(repo, { action: "delete_free_work", index: 1 });
    await edit(repo, { action: "delete_amendment", index: 1 });
    expect(await readFile(doc.path)).toEqual(baseline);
  });

  test("free-work duplicate matching counts committed occurrences, not just identical text", async () => {
    const repo = await fixture("tracked");
    success(await recordFreeWork(repo, actor, { stage: "S01", intent: "Duplicate intent" }));
    await git(repo, "add", "docs");
    await git(repo, "commit", "-qm", "Record first occurrence");
    const before = await readFile((await current(repo)).path);
    expect(success(await recordFreeWork(repo, actor, { stage: "S01", intent: "Duplicate intent" })).summary).toContain(
      "Free-work index: 1",
    );
    await clean(repo);
    await refuseUnchanged(repo, { action: "delete_free_work", index: 0 }, "committed");
    await edit(repo, { action: "revise_free_work", index: 1, intent: "Distinct replacement" });
    await edit(repo, { action: "delete_free_work", index: 1 });
    expect(await readFile((await current(repo)).path)).toEqual(before);
  });

  test("duplicate amendments consume committed occurrences in file order", async () => {
    const repo = await fixture("tracked");
    const repeated: StageOperationInput = {
      action: "amend",
      reason: "Repeated scope change",
      amendments: { scope: [{ op: "add", side: "in", item: "Repeated item" }] },
    };
    await edit(repo, repeated);
    await git(repo, "add", "docs");
    await git(repo, "commit", "-qm", "Record first amendment occurrence");
    await edit(repo, {
      action: "amend",
      reason: "Remove repeated scope",
      amendments: { scope: [{ op: "remove", side: "in", item: "Repeated item" }] },
    });
    const beforeRepeat = await readFile((await current(repo)).path);
    expect((await edit(repo, repeated)).summary).toContain("Amendment index: 2");
    await refuseUnchanged(repo, { action: "delete_amendment", index: 0 }, "committed");
    await edit(repo, { action: "delete_amendment", index: 2 });
    expect(await readFile((await current(repo)).path)).toEqual(beforeRepeat);
  });

  test("free-work first and middle entries can change without disturbing neighbors", async () => {
    const repo = await fixture();
    for (const intent of ["First intent", "Middle intent", "Last intent"]) {
      success(await recordFreeWork(repo, actor, { stage: "S01", intent }));
      await clean(repo);
    }
    await edit(repo, { action: "revise_free_work", index: 1, intent: "New middle intent" });
    await edit(repo, { action: "delete_free_work", index: 0 });
    const log = (await current(repo)).free_work_log;
    expect(log).not.toContain("First intent");
    expect(log).toContain("New middle intent");
    expect(log).toContain("Last intent");
    await edit(repo, { action: "delete_free_work", index: 1 });
    expect((await current(repo)).free_work_log.split("\n")).toHaveLength(1);
  });

  test("failed replacement input writes neither an undo nor partial replacement", async () => {
    const repo = await fixture();
    await edit(repo, amendment);
    await refuseUnchanged(repo, { action: "revise_amendment", index: 0, reason: "Empty replacement" }, "at least one");
    success(await recordFreeWork(repo, actor, { stage: "S01", intent: "Kept intent" }));
    await clean(repo);
    await refuseUnchanged(repo, { action: "revise_free_work", index: 0, intent: "" }, "non-empty");
  });

  test("invalid indices and older amendments refuse; deleting latest restores previous entries", async () => {
    const repo = await fixture();
    await edit(repo, amendment);
    const afterFirst = await readFile((await current(repo)).path);
    await edit(repo, { action: "amend", reason: "Second adjustment", target: "2026-12-28" });
    for (const action of ["delete_amendment", "revise_amendment"] as const)
      await refuseUnchanged(repo, { action, index: 0, reason: "No" }, "latest amendment");
    for (const action of ["delete_amendment", "revise_amendment", "delete_free_work", "revise_free_work"] as const)
      for (const index of [undefined, -1, 0.5, 99]) await refuseUnchanged(repo, { action, index }, "out of range");
    await edit(repo, { action: "delete_amendment", index: 1 });
    expect(await readFile((await current(repo)).path)).toEqual(afterFirst);
  });

  test("legacy and conflicting amendments refuse instead of guessing undo data", async () => {
    const repo = await fixture();
    const doc = await current(repo);
    doc.amendments =
      "### 2026-11-01 — Legacy\n\n- MODIFIED DC1 — First criterion (was: Older criterion) · Verify: Original first verification\n- Reason: Legacy";
    await writeFile(doc.path, renderStage(doc));
    await refuseUnchanged(repo, { action: "delete_amendment", index: 0 }, "lacks reversible history");
    await edit(repo, amendment);
    const changed = await current(repo);
    changed.done_criteria = changed.done_criteria.replace("Revised first verification", "Conflicting verification");
    await writeFile(changed.path, renderStage(changed));
    await refuseUnchanged(repo, { action: "delete_amendment", index: 1 }, "no longer match");
  });

  test("target promotion undo restores a format-1 stage in a format-2 repository", async () => {
    const repo = await fixture();
    const doc = await current(repo);
    doc.format = 1;
    await writeFile(doc.path, renderStage(doc));
    const before = await readFile(doc.path);
    await edit(repo, { action: "amend", reason: "Set target", target: "2026-12-12" });
    expect((await current(repo)).format).toBe(2);
    await edit(repo, { action: "delete_amendment", index: 0 });
    expect(await readFile(doc.path)).toEqual(before);
  });
});
