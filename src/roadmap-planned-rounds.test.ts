import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { check, checkClosureIntegrity } from "../plugins/roadmap/src/check.ts";
import {
  loadAll,
  type Model,
  managedComment,
  overdue,
  parseDoneCriteria,
  type Repo,
  type RoundDoc,
  renderRoadmapIndex,
  renderRound,
  renderStage,
  renderTodo,
  roundFiles,
  roundSha256,
  type StageDoc,
  stageSha256,
  type TodoDoc,
  type TodoItem,
  today,
} from "../plugins/roadmap/src/documents.ts";
import { discoverRepo } from "../plugins/roadmap/src/git.ts";
import {
  type Actor,
  applyPrepared,
  autoCarryTodos,
  closeRound,
  FORMAT_WARNING,
  type PreparationReceipt,
  prepareRetarget,
  prepareRoundDrop,
  prepareRoundOpen,
  prepareRoundPlan,
  prepareUpgrade,
  type Receipt,
  type RoundCloseInput,
  type RoundInput,
  type StageOperationInput,
  stage,
  todo,
} from "../plugins/roadmap/src/operations.ts";
import { adrApi } from "./roadmap-fixtures.ts";

const main: Actor = { sessionId: "main-session", kind: "main" };
const sub: Actor = { sessionId: "sub-session", kind: "sub" };
const temporary: string[] = [];

afterAll(async () => {
  for (const path of temporary) await rm(path, { recursive: true, force: true });
});

function plan(title: string): RoundInput {
  return {
    title,
    goal: `${title} goal`,
    constraints: ["Keep the host"],
    non_goals: [],
    principles: [{ text: "Use the documented host choice", adrs: ["ADR-0001"] }],
  };
}

function draft(title: string, extra: Partial<StageOperationInput> = {}): StageOperationInput {
  return {
    action: "add",
    title,
    objective: `${title} objective`,
    scope_in: [title],
    scope_out: [],
    done_criteria: [{ statement: `${title} works`, verify: "bun test" }],
    ...extra,
  };
}

function success(receipt: Receipt): Extract<Receipt, { ok: true }> {
  if (!receipt.ok) throw new Error(`${receipt.reason}\n${receipt.hints.join("\n")}`);
  return receipt;
}

function prepared(receipt: PreparationReceipt): Extract<PreparationReceipt, { ok: true }> {
  if (!receipt.ok) throw new Error(`${receipt.reason}\n${receipt.hints.join("\n")}`);
  return receipt;
}

function refused(receipt: Receipt | PreparationReceipt, message: string): void {
  expect(receipt.ok).toBe(false);
  if (receipt.ok) throw new Error("Expected a refused operation.");
  expect(`${receipt.reason}\n${receipt.hints.join("\n")}`).toContain(message);
}

async function confirm(repo: Repo, preparation: Promise<PreparationReceipt>): Promise<Extract<Receipt, { ok: true }>> {
  return success(await applyPrepared(repo, main, prepared(await preparation).prepared));
}

async function git(repoRoot: string, args: string[]): Promise<void> {
  const process = Bun.spawn(["git", "-C", repoRoot, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, exit] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (exit !== 0) throw new Error(`git ${args.join(" ")} failed (${exit}): ${stderr}`);
}

/** A repository exactly as roadmap 0.2.3 wrote it: closed R1, active format-1 R2, carried TODOs. */
async function v023Repo(): Promise<Repo> {
  const fixture = JSON.parse(await readFile(new URL("./roadmap-v023-fixture.json", import.meta.url), "utf8")) as Record<string, string>;
  const root = await mkdtemp(join(tmpdir(), "roadmap-planned-"));
  temporary.push(root);
  await git(root, ["init", "-q"]);
  const info = discoverRepo(root);
  if (!info) throw new Error("Temp git repository was not discovered.");
  for (const [path, content] of Object.entries(fixture)) {
    const target = join(info.repoRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { ...info, roadmapDir: join(info.repoRoot, "docs/roadmap"), adrDir: join(info.repoRoot, "docs/adr"), adr: adrApi() };
}

/** Every file under docs/roadmap and docs/adr, by repository-relative path. */
async function bytes(repo: Repo): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const directory of [repo.roadmapDir, repo.adrDir]) {
    for (const name of await readdir(directory, { recursive: true }).catch(() => [])) {
      const path = join(directory, name);
      if ((await stat(path)).isFile()) files[relative(repo.repoRoot, path)] = await readFile(path, "utf8");
    }
  }
  return files;
}

function under(files: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(prefix)));
}

/** No check errors, frozen hashes verify, and check --fix has nothing to write. */
async function expectClean(repo: Repo): Promise<void> {
  const before = await bytes(repo);
  const model = await loadAll(repo);
  expect(model.parseErrors).toEqual([]);
  expect(checkClosureIntegrity(model)).toEqual([]);
  const changed = new Set<string>();
  const diagnostics = await check(model, { fix: true, changedFiles: changed });
  expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect([...changed]).toEqual([]);
  expect(await bytes(repo)).toEqual(before);
}

function roundOf(model: Model, id: string): RoundDoc {
  const round = model.rounds.find((candidate) => candidate.id === id);
  if (!round) throw new Error(`Missing round ${id}`);
  return round;
}

function stageOf(model: Model, id: string): StageDoc {
  const found = model.stages.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing stage ${id}`);
  return found;
}

function todoDoc(model: Model, round: string): TodoDoc {
  const doc = model.todos.find((candidate) => candidate.round === round);
  if (!doc) throw new Error(`Missing TODO document for ${round}`);
  return doc;
}

function itemOf(model: Model, round: string, id: string): TodoItem {
  const item = todoDoc(model, round).items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Missing ${id} in ${round}`);
  return item;
}

function raw(model: Model, path: string): string {
  const content = model.files?.[path];
  if (content === undefined) throw new Error(`Missing file ${path}`);
  return Buffer.from(content).toString("utf8");
}

/** Starts the stage when needed and closes it with passing evidence, resolving open TODOs that target it. */
async function finish(repo: Repo, id: string): Promise<void> {
  let model = await loadAll(repo);
  if (stageOf(model, id).status === "planned") {
    success(await stage(repo, main, { action: "start", id }));
    model = await loadAll(repo);
  }
  const active = model.rounds.find((round) => round.status === "active");
  if (!active) throw new Error("No active round");
  const pending = todoDoc(model, active.id).items.filter((item) => item.status === "open" && item.target === id);
  success(
    await stage(repo, main, {
      action: "close",
      id,
      delivered: "Shipped.",
      evidence: parseDoneCriteria(stageOf(model, id).done_criteria).map((criterion) => ({
        criterion: criterion.id,
        result: "pass",
        method: "bun test",
        summary: "pass",
      })),
      todos: pending.map((item) => ({ id: item.id, disposition: "resolved", reference: "commit abc1234" })),
    }),
  );
}

/** Format-2 repositories record the round's goal outcome; format 1 closes without one. */
async function closeActive(repo: Repo, dispositions: RoundCloseInput["dispositions"]): Promise<Receipt> {
  const model = await loadAll(repo);
  const round = model.rounds.find((candidate) => candidate.status === "active");
  if (!round) throw new Error("No active round");
  return closeRound(repo, main, {
    expected: { id: round.id, sha256: roundSha256(roundFiles(model, round)) },
    dispositions,
    ...(model.index.format === 2 ? { outcome: { assessment: "achieved" as const, summary: "The round goal was met." } } : {}),
  });
}

const growthDispositions: RoundCloseInput["dispositions"] = [
  { id: "T005", disposition: "carried" },
  { id: "T007", disposition: "wontfix" },
];

/** Closes S03, S04 and R2 of the 0.2.3 fixture. */
async function closeGrowth(repo: Repo, extra: RoundCloseInput["dispositions"] = []): Promise<void> {
  await finish(repo, "S03");
  await finish(repo, "S04");
  success(await closeActive(repo, [...growthDispositions, ...extra]));
}

/** 0.2.3 fixture plus planned R3 (target 2026-12-01) and R4, with S06 in R3 and S07 in R4. */
async function plannedRepo(): Promise<Repo> {
  const repo = await v023Repo();
  await confirm(repo, prepareRoundPlan(repo, main, { round: plan("Payments"), target: "2026-12-01" }));
  await confirm(repo, prepareRoundPlan(repo, main, { round: plan("Scale") }));
  success(await stage(repo, main, draft("Refunds", { round: "R3" })));
  success(await stage(repo, main, draft("Sharding", { round: "R4" })));
  return repo;
}

describe("roadmap 0.2.3 repositories", () => {
  test("load, render byte-identically, check clean and fix writes nothing", async () => {
    const repo = await v023Repo();
    const model = await loadAll(repo);
    expect(model.parseErrors).toEqual([]);
    expect(model.index.format).toBe(1);
    for (const doc of [...model.rounds, ...model.stages, ...model.todos]) expect(doc.format).toBe(1);
    expect(
      model.rounds.map((round) => [round.id, round.status, round.target]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ["R1", "closed", null],
      ["R2", "active", null],
    ]);
    for (const doc of model.stages) expect(renderStage(doc)).toBe(raw(model, doc.path));
    for (const doc of model.rounds) expect(renderRound(doc)).toBe(raw(model, doc.path));
    for (const doc of model.todos) expect(renderTodo(doc)).toBe(raw(model, doc.path));
    expect(renderRoadmapIndex(model.index, model.rounds, model.stages)).toBe(raw(model, model.index.path));
    // The legacy roadmap-format ADRs stay readable through the adr plugin without being rewritten.
    expect(model.adrs).toMatchObject({ managed: true, parseErrors: [] });
    expect(model.adrs?.records.map((adr) => [adr.id, adr.legacy, adr.stage])).toEqual([
      ["ADR-0001", true, undefined],
      ["ADR-0002", true, "S01"],
    ]);
    const r1 = roundOf(model, "R1");
    expect(r1.frozen_sha256).toBe(roundSha256(roundFiles(model, r1)));
    for (const id of ["S01", "S05"]) expect(stageOf(model, id).closed_sha256).toBe(stageSha256(stageOf(model, id)));
    await expectClean(repo);
  });

  test("close the active stages and round and open the next round without a format bump", async () => {
    const repo = await v023Repo();
    const original = await bytes(repo);
    await closeGrowth(repo);
    await confirm(repo, prepareRoundOpen(repo, main, { round: plan("Payments"), import_todos: ["T005"] }));
    const after = await bytes(repo);
    const model = await loadAll(repo);
    expect(model.index.format).toBe(1);
    for (const doc of [...model.rounds, ...model.stages, ...model.todos]) expect(doc.format).toBe(1);
    for (const content of Object.values(after)) expect(content).not.toContain(managedComment(2));
    expect(under(after, "docs/roadmap/01-launch/")).toEqual(under(original, "docs/roadmap/01-launch/"));
    expect(after["docs/roadmap/02-growth/stages/05-docs.md"]).toBe(original["docs/roadmap/02-growth/stages/05-docs.md"]);
    for (const path of Object.keys(original).filter((path) => path.startsWith("docs/adr/"))) expect(after[path]).toBe(original[path]);
    const r2 = roundOf(model, "R2");
    expect(r2).toMatchObject({ status: "closed", closed: today() });
    expect(r2.frozen_sha256).toBe(roundSha256(roundFiles(model, r2)));
    const r3 = roundOf(model, "R3");
    expect(r3).toMatchObject({ format: 1, status: "active", opened: today(), target: null });
    expect(raw(model, r3.path)).toContain("| Stage | Title | Status | Dependencies | Created | Started | Closed |");
    expect(raw(model, model.index.path)).toContain("| Round | Title | Status | Opened | Closed |");
    expect(raw(model, model.index.path)).toContain("roadmap: { format: 1 }");
    expect(itemOf(model, "R3", "T008")).toMatchObject({ status: "open", carried_from: "T005 (R2)", trigger: "When carry receipts" });
    await expectClean(repo);
  });

  test("manual carried items with a round reference still import under a fresh ID", async () => {
    const repo = await v023Repo();
    await finish(repo, "S03");
    await finish(repo, "S04");
    success(
      await closeActive(repo, [
        { id: "T005", disposition: "carried", reference: "R3" },
        { id: "T007", disposition: "wontfix" },
      ]),
    );
    const frozen = under(await bytes(repo), "docs/roadmap/02-growth/");
    await confirm(repo, prepareRoundOpen(repo, main, { round: plan("Payments"), import_todos: ["T005"] }));
    const model = await loadAll(repo);
    expect(itemOf(model, "R3", "T008")).toMatchObject({ status: "open", carried_from: "T005 (R2)", trigger: "When carry receipts" });
    expect(itemOf(model, "R2", "T005")).toMatchObject({ status: "carried", reference: "R3" });
    expect(under(await bytes(repo), "docs/roadmap/02-growth/")).toEqual(frozen);
    expect(model.index.format).toBe(1);
    await expectClean(repo);
  });
});

describe("format upgrade", () => {
  test("previews without writing, applies only the root README and refuses stale, sub and repeated upgrades", async () => {
    const repo = await v023Repo();
    const before = await bytes(repo);
    refused(await prepareUpgrade(repo, sub), "main session");
    const stale = prepared(await prepareUpgrade(repo, main));
    const preview = prepared(await prepareUpgrade(repo, main));
    expect(preview.summary).toContain(FORMAT_WARNING);
    expect(preview.files.map((file) => relative(repo.repoRoot, file.path))).toEqual(["docs/roadmap/README.md"]);
    expect(await bytes(repo)).toEqual(before);
    refused(await applyPrepared(repo, sub, preview.prepared), "main session");
    expect(await bytes(repo)).toEqual(before);

    const receipt = success(await applyPrepared(repo, main, preview.prepared));
    expect(receipt.changedFiles).toEqual(["docs/roadmap/README.md"]);
    const after = await bytes(repo);
    for (const path of Object.keys(before).filter((path) => path !== "docs/roadmap/README.md")) expect(after[path]).toBe(before[path]);
    const readme = after["docs/roadmap/README.md"] as string;
    expect(readme).toContain("roadmap: { format: 2 }");
    expect(readme).toContain(managedComment(2));
    expect(readme).toContain("A small shop with real checkout.");
    expect(readme).toContain("| Round | Title | Status | Target | Opened | Closed |");
    const model = await loadAll(repo);
    expect(model.index.format).toBe(2);
    for (const doc of [...model.rounds, ...model.stages, ...model.todos]) expect(doc.format).toBe(1);
    await expectClean(repo);

    refused(await applyPrepared(repo, main, stale.prepared), "stale");
    refused(await applyPrepared(repo, main, preview.prepared), "Unknown preview");
    refused(await prepareUpgrade(repo, main), "already uses roadmap format 2");
    expect(await bytes(repo)).toEqual(after);
  });

  test("subagents cannot prepare user-command operations", async () => {
    const repo = await plannedRepo();
    const before = await bytes(repo);
    refused(await prepareRoundPlan(repo, sub, { round: plan("Later") }), "main session");
    refused(await prepareRoundDrop(repo, sub, { id: "R4", reason: "Not needed" }), "main session");
    refused(await prepareRetarget(repo, sub, { id: "R3", target: "2027-01-01" }), "main session");
    refused(await prepareRoundOpen(repo, sub, { import_todos: [] }), "main session");
    expect(await bytes(repo)).toEqual(before);
  });
});

describe("planned rounds", () => {
  test("plan creation in a format-1 repository bumps the format inside the same confirmed preview", async () => {
    const repo = await v023Repo();
    const before = await bytes(repo);
    const preview = prepared(await prepareRoundPlan(repo, main, { round: plan("Payments"), target: "2026-12-01" }));
    expect(preview.summary).toContain(FORMAT_WARNING);
    expect(preview.files.map((file) => relative(repo.repoRoot, file.path)).sort()).toEqual([
      "docs/roadmap/03-payments/README.md",
      "docs/roadmap/03-payments/TODO.md",
      "docs/roadmap/README.md",
    ]);
    expect(await bytes(repo)).toEqual(before);
    success(await applyPrepared(repo, main, preview.prepared));

    const after = await bytes(repo);
    for (const path of Object.keys(before).filter((path) => path !== "docs/roadmap/README.md")) expect(after[path]).toBe(before[path]);
    const model = await loadAll(repo);
    expect(model.index.format).toBe(2);
    expect(roundOf(model, "R3")).toMatchObject({ format: 2, status: "planned", opened: null, closed: null, target: "2026-12-01" });
    expect(todoDoc(model, "R3")).toMatchObject({ format: 2, items: [] });
    expect(roundOf(model, "R2")).toMatchObject({ format: 1, status: "active" });
    await expectClean(repo);
  });

  test("planned charters are revisable with optional targets while a round is active", async () => {
    const repo = await v023Repo();
    await confirm(repo, prepareRoundPlan(repo, main, { round: plan("Payments"), target: "2026-12-01" }));
    const upgraded = prepared(await prepareRoundPlan(repo, main, { round: plan("Scale") }));
    expect(upgraded.summary).not.toContain(FORMAT_WARNING);
    success(await applyPrepared(repo, main, upgraded.prepared));
    let model = await loadAll(repo);
    expect(roundOf(model, "R4")).toMatchObject({ status: "planned", target: null, opened: null });
    const r3Path = roundOf(model, "R3").path;

    await confirm(repo, prepareRoundPlan(repo, main, { id: "R3", round: plan("Payments and refunds"), target: "none" }));
    await confirm(repo, prepareRoundPlan(repo, main, { id: "R4", round: plan("Scale"), target: "2027-01-15" }));
    await confirm(repo, prepareRoundPlan(repo, main, { id: "R4", round: plan("Scale out") }));
    model = await loadAll(repo);
    expect(roundOf(model, "R3")).toMatchObject({
      path: r3Path,
      title: "Payments and refunds",
      goal: "Payments and refunds goal",
      status: "planned",
      target: null,
      opened: null,
    });
    expect(roundOf(model, "R4")).toMatchObject({ title: "Scale out", target: "2027-01-15" });
    expect(model.rounds).toHaveLength(4);

    const before = await bytes(repo);
    refused(await prepareRoundPlan(repo, main, { id: "R2", round: plan("Growth") }), "Only a planned round");
    refused(await prepareRoundPlan(repo, main, { id: "R1", round: plan("Launch") }), "Only a planned round");
    refused(await prepareRoundPlan(repo, main, { round: plan("Bad date"), target: "2026-02-30" }), "calendar date");
    refused(await prepareRoundPlan(repo, main, { id: "R3", round: plan("Bad date"), target: "next week" }), "calendar date");
    expect(await bytes(repo)).toEqual(before);
    await expectClean(repo);
  });

  test("planned-round stages can be added, edited, renumbered and dropped but never started", async () => {
    const repo = await v023Repo();
    await confirm(repo, prepareRoundPlan(repo, main, { round: plan("Payments") }));
    success(await stage(repo, main, draft("Refunds", { round: "R3", target: "2026-11-15", depends_on: ["S03"] })));
    success(await stage(repo, main, draft("Exports")));
    let model = await loadAll(repo);
    const refunds = stageOf(model, "S06");
    expect(refunds).toMatchObject({ round: "R3", status: "planned", format: 2, target: "2026-11-15", depends_on: ["S03"] });
    expect(relative(repo.repoRoot, refunds.path)).toBe("docs/roadmap/03-payments/stages/06-refunds.md");
    expect(raw(model, roundOf(model, "R3").path)).toContain(`| S06 | Refunds | planned | 2026-11-15 | S03 | ${today()} | — | — |`);
    expect(stageOf(model, "S07")).toMatchObject({ round: "R2", format: 2, target: null });
    expect(roundOf(model, "R2").format).toBe(1);
    expect(raw(model, roundOf(model, "R2").path)).toContain(`| S07 | Exports | planned | — | ${today()} | — | — |`);

    const before = await bytes(repo);
    refused(await stage(repo, main, { action: "start", id: "S06" }), "only stages of the active round");
    refused(await stage(repo, main, draft("Legacy", { round: "R1" })), "only to the active round or a planned round");
    refused(await stage(repo, main, { action: "edit", id: "S06", round: "R2", title: "Moved" }), "round applies only when adding");
    expect(await bytes(repo)).toEqual(before);

    success(await stage(repo, main, { action: "edit", id: "S06", title: "Refund flow", target: "none" }));
    model = await loadAll(repo);
    expect(stageOf(model, "S06")).toMatchObject({ title: "Refund flow", target: null, format: 2, status: "planned" });

    success(await stage(repo, main, { action: "renumber", id: "S06" }));
    model = await loadAll(repo);
    expect(model.stages.some((candidate) => candidate.id === "S06")).toBe(false);
    const renumbered = model.stages.find((candidate) => candidate.title === "Refund flow");
    expect(renumbered).toMatchObject({ id: "S08", round: "R3" });
    expect(relative(repo.repoRoot, renumbered?.path ?? "")).toBe("docs/roadmap/03-payments/stages/08-refunds.md");

    success(await stage(repo, main, { action: "drop", id: "S08", reason: "Refunds move to support tooling" }));
    model = await loadAll(repo);
    expect(stageOf(model, "S08")).toMatchObject({ status: "dropped", closed: today() });
    expect(roundOf(model, "R3").status).toBe("planned");
    await expectClean(repo);
  });

  test("stages depend only on stages in their own or earlier rounds", async () => {
    const repo = await plannedRepo();
    success(await stage(repo, main, draft("Partial refunds", { round: "R3", depends_on: ["S06"] })));
    success(await stage(repo, main, draft("Shard refunds", { round: "R4", depends_on: ["S06", "S03"] })));
    let model = await loadAll(repo);
    expect(stageOf(model, "S08").depends_on).toEqual(["S06"]);
    expect(stageOf(model, "S09").depends_on).toEqual(["S06", "S03"]);
    await expectClean(repo);

    const before = await bytes(repo);
    refused(await stage(repo, main, draft("Early refunds", { round: "R3", depends_on: ["S07"] })), "dependency-order");
    refused(await stage(repo, main, draft("Growth exports", { depends_on: ["S06"] })), "dependency-order");
    refused(await stage(repo, main, { action: "edit", id: "S04", depends_on: ["S03", "S07"] }), "dependency-order");
    expect(await bytes(repo)).toEqual(before);

    model = await loadAll(repo);
    stageOf(model, "S06").depends_on = ["S07"];
    const diagnostics = await check(model);
    expect(diagnostics.filter((item) => item.rule === "dependency-order").map((item) => relative(repo.repoRoot, item.path))).toEqual([
      "docs/roadmap/03-payments/stages/06-refunds.md",
    ]);
  });

  test("only the lowest planned round activates, replacing the charter but keeping target and TODOs", async () => {
    const repo = await plannedRepo();
    success(await todo(repo, main, { action: "add", title: "Refund audit", severity: "normal", source: "Review", target: "S06" }));
    refused(await prepareRoundOpen(repo, main, { import_todos: [] }), "Close the active round");
    await closeGrowth(repo);
    let model = await loadAll(repo);
    expect(itemOf(model, "R3", "T008")).toMatchObject({ status: "open", target: "S06", carried_from: "T008 (R2)" });
    const r3Path = roundOf(model, "R3").path;

    const before = await bytes(repo);
    refused(await prepareRoundOpen(repo, main, { activate: "R4", import_todos: [] }), "lowest-numbered planned round R3");
    refused(await prepareRoundPlan(repo, main, { id: "R2", round: plan("Growth") }), "Only a planned round");
    expect(await bytes(repo)).toEqual(before);

    const preview = prepared(await prepareRoundOpen(repo, main, { round: plan("Payments v2"), import_todos: [] }));
    expect(await bytes(repo)).toEqual(before);
    success(await applyPrepared(repo, main, preview.prepared));
    model = await loadAll(repo);
    expect(model.rounds).toHaveLength(4);
    expect(roundOf(model, "R3")).toMatchObject({
      path: r3Path,
      title: "Payments v2",
      goal: "Payments v2 goal",
      status: "active",
      opened: today(),
      target: "2026-12-01",
    });
    expect(roundOf(model, "R4").status).toBe("planned");
    expect(itemOf(model, "R3", "T008")).toMatchObject({ status: "open", target: "S06" });
    expect(under(await bytes(repo), "docs/roadmap/02-growth/")).toEqual(under(before, "docs/roadmap/02-growth/"));
    refused(await prepareRoundPlan(repo, main, { id: "R3", round: plan("Payments v3") }), "Only a planned round");
    success(await stage(repo, main, { action: "start", id: "S06" }));
    refused(await stage(repo, main, { action: "start", id: "S07" }), "only stages of the active round");
    await expectClean(repo);
  });

  test("an explicit activation needs a planned round", async () => {
    const repo = await v023Repo();
    await closeGrowth(repo);
    const before = await bytes(repo);
    refused(await prepareRoundOpen(repo, main, { activate: "R3", import_todos: [] }), "no planned round R3");
    refused(await prepareRoundOpen(repo, main, { import_todos: [] }), "charter is required");
    expect(await bytes(repo)).toEqual(before);
  });
});

describe("dropping planned rounds", () => {
  test("refuses open TODOs and dependents, then freezes the round and skips its ID", async () => {
    const repo = await v023Repo();
    await confirm(repo, prepareRoundPlan(repo, main, { round: plan("Payments") }));
    await confirm(repo, prepareRoundPlan(repo, main, { round: plan("Scale") }));
    success(await stage(repo, main, draft("Refunds", { round: "R3" })));
    success(await stage(repo, main, draft("Sharding", { round: "R4", depends_on: ["S06"] })));
    success(await todo(repo, main, { action: "add", title: "Refund audit", severity: "normal", source: "Review", target: "S06" }));

    const before = await bytes(repo);
    refused(await prepareRoundDrop(repo, main, { id: "R3", reason: "Payments are outsourced" }), "T008");
    refused(await prepareRoundDrop(repo, main, { id: "R2", reason: "No" }), "Only planned rounds");
    refused(await prepareRoundDrop(repo, main, { id: "R1", reason: "No" }), "Only planned rounds");
    expect(await bytes(repo)).toEqual(before);
    success(await todo(repo, main, { action: "move", id: "T008", trigger: "When refunds return" }));
    refused(await prepareRoundDrop(repo, main, { id: "R3", reason: "Payments are outsourced" }), "S07");
    success(await stage(repo, main, { action: "drop", id: "S07", reason: "Sharding waits for payments" }));

    const preview = prepared(await prepareRoundDrop(repo, main, { id: "R3", reason: "Payments are outsourced" }));
    const pending = await bytes(repo);
    success(await applyPrepared(repo, main, preview.prepared));
    let model = await loadAll(repo);
    const r3 = roundOf(model, "R3");
    expect(r3).toMatchObject({ format: 2, status: "dropped", opened: null, closed: today() });
    expect(r3.outcome).toContain("Payments are outsourced");
    expect(r3.frozen_sha256).toBe(roundSha256(roundFiles(model, r3)));
    expect(stageOf(model, "S06")).toMatchObject({ status: "dropped", closed: today() });
    expect(stageOf(model, "S06").outcome).toContain("Payments are outsourced");
    expect(under(await bytes(repo), "docs/roadmap/02-growth/")).toEqual(under(pending, "docs/roadmap/02-growth/"));
    await expectClean(repo);

    const dropped = under(await bytes(repo), "docs/roadmap/03-payments/");
    refused(await prepareRetarget(repo, main, { id: "R3", target: "2027-01-01" }), "Only unclosed");
    refused(await prepareRetarget(repo, main, { id: "S06", target: "2027-01-01" }), "frozen or inactive");
    refused(await prepareRoundPlan(repo, main, { id: "R3", round: plan("Payments again") }), "Only a planned round");
    refused(await prepareRoundDrop(repo, main, { id: "R3", reason: "Again" }), "Only planned rounds");
    refused(await stage(repo, main, draft("Late refunds", { round: "R3" })), "only to the active round or a planned round");
    refused(await stage(repo, main, { action: "edit", id: "S06", title: "Refunds again" }), "frozen or inactive");
    refused(await todo(repo, main, { action: "move", id: "T008", target: "S06" }), "frozen or inactive");

    await closeGrowth(repo, [{ id: "T008", disposition: "wontfix" }]);
    refused(await prepareRoundOpen(repo, main, { activate: "R3", import_todos: [] }), "lowest-numbered planned round R4");
    await confirm(repo, prepareRoundOpen(repo, main, { import_todos: [] }));
    model = await loadAll(repo);
    expect(roundOf(model, "R4")).toMatchObject({ status: "active", opened: today() });
    success(await closeActive(repo, []));
    await confirm(repo, prepareRoundOpen(repo, main, { round: plan("Launch again"), import_todos: [] }));
    model = await loadAll(repo);
    expect(roundOf(model, "R5")).toMatchObject({ status: "active", format: 2 });
    expect(relative(repo.repoRoot, roundOf(model, "R5").path)).toBe("docs/roadmap/05-launch-again/README.md");
    expect(roundOf(model, "R3").status).toBe("dropped");
    expect(under(await bytes(repo), "docs/roadmap/03-payments/")).toEqual(dropped);
    await expectClean(repo);
  });
});

describe("TODOs across rounds", () => {
  test("active TODOs target planned stages and auto-carry with the same ID through forward chains", async () => {
    const repo = await plannedRepo();
    success(await todo(repo, main, { action: "add", title: "Refund audit", severity: "normal", source: "Review", target: "S06" }));
    success(await todo(repo, main, { action: "add", title: "Shard keys", severity: "low", source: "Review", target: "S07" }));
    success(await todo(repo, main, { action: "move", id: "T006", target: "S06" }));
    let model = await loadAll(repo);
    expect(
      todoDoc(model, "R2")
        .items.filter((item) => item.status === "open")
        .map((item) => [item.id, item.target ?? null]),
    ).toEqual([
      ["T005", null],
      ["T006", "S06"],
      ["T007", null],
      ["T008", "S06"],
      ["T009", "S07"],
    ]);
    expect(todoDoc(model, "R3").items).toEqual([]);
    expect(autoCarryTodos(model, roundOf(model, "R2")).map((item) => item.id)).toEqual(["T006", "T008", "T009"]);

    await finish(repo, "S03");
    await finish(repo, "S04");
    const reviewed = await bytes(repo);
    refused(await closeActive(repo, [...growthDispositions, { id: "T008", disposition: "carried" }]), "Unknown or repeated open TODO T008");
    refused(await closeActive(repo, [{ id: "T005", disposition: "carried" }]), "Every open TODO");
    expect(await bytes(repo)).toEqual(reviewed);
    success(await closeActive(repo, growthDispositions));

    model = await loadAll(repo);
    for (const [id, destination] of [
      ["T006", "R3"],
      ["T008", "R3"],
      ["T009", "R4"],
    ] as const) {
      expect(itemOf(model, "R2", id)).toMatchObject({ status: "carried", reference: destination });
      expect(itemOf(model, destination, id)).toMatchObject({ status: "open", carried_from: `${id} (R2)` });
    }
    expect(itemOf(model, "R3", "T008").target).toBe("S06");
    expect(itemOf(model, "R4", "T009").target).toBe("S07");
    const frozenGrowth = under(await bytes(repo), "docs/roadmap/02-growth/");
    await expectClean(repo);

    const closed = await bytes(repo);
    refused(await prepareRoundOpen(repo, main, { import_todos: ["T008"] }), "automatically carried");
    refused(await prepareRoundOpen(repo, main, { import_todos: ["T009"] }), "automatically carried");
    refused(await prepareRoundOpen(repo, main, { activate: "R4", import_todos: [] }), "lowest-numbered planned round R3");
    expect(await bytes(repo)).toEqual(closed);
    await confirm(repo, prepareRoundOpen(repo, main, { import_todos: ["T005"] }));
    model = await loadAll(repo);
    expect(roundOf(model, "R3")).toMatchObject({ status: "active", title: "Payments", target: "2026-12-01", opened: today() });
    expect(itemOf(model, "R3", "T010")).toMatchObject({ status: "open", carried_from: "T005 (R2)", trigger: "When carry receipts" });

    // Within the active round's own document a move keeps the ID; out of a planned round's document it gets a fresh one.
    success(await todo(repo, main, { action: "move", id: "T006", target: "S07" }));
    success(await todo(repo, main, { action: "move", id: "T008", target: "S07" }));
    success(await todo(repo, main, { action: "move", id: "T009", target: "S06" }));
    model = await loadAll(repo);
    expect(itemOf(model, "R3", "T008")).toMatchObject({ status: "open", target: "S07", carried_from: "T008 (R2)" });
    expect(itemOf(model, "R4", "T009")).toMatchObject({ status: "moved", reference: "T011 (R3)", carried_from: "T009 (R2)" });
    expect(itemOf(model, "R3", "T011")).toMatchObject({
      status: "open",
      title: "Shard keys",
      target: "S06",
      carried_from: "T009 (R4)",
    });
    expect(under(await bytes(repo), "docs/roadmap/02-growth/")).toEqual(frozenGrowth);
    await expectClean(repo);

    await finish(repo, "S06");
    model = await loadAll(repo);
    expect(itemOf(model, "R3", "T011")).toMatchObject({ status: "resolved" });
    expect(autoCarryTodos(model, roundOf(model, "R3")).map((item) => item.id)).toEqual(["T006", "T008"]);
    success(await closeActive(repo, [{ id: "T010", disposition: "wontfix" }]));
    model = await loadAll(repo);
    for (const id of ["T006", "T008"]) {
      expect(itemOf(model, "R2", id)).toMatchObject({ status: "carried", reference: "R3" });
      expect(itemOf(model, "R3", id)).toMatchObject({ status: "carried", reference: "R4", carried_from: `${id} (R2)` });
      expect(itemOf(model, "R4", id)).toMatchObject({ status: "open", target: "S07", carried_from: `${id} (R3)` });
    }
    expect(under(await bytes(repo), "docs/roadmap/02-growth/")).toEqual(frozenGrowth);
    await expectClean(repo);

    const duplicates = async (tamper: (model: Model) => void): Promise<string[]> => {
      const tampered = await loadAll(repo);
      tamper(tampered);
      return (await check(tampered)).filter((item) => item.rule === "duplicate-id").map((item) => item.message);
    };
    expect(await duplicates(() => {})).toEqual([]);
    const wrongReference = await duplicates((tampered) => {
      itemOf(tampered, "R3", "T008").reference = "R5";
    });
    expect(wrongReference.length).toBeGreaterThan(0);
    expect(wrongReference.every((message) => message.includes("T008"))).toBe(true);
    const wrongOrigin = await duplicates((tampered) => {
      itemOf(tampered, "R4", "T008").carried_from = "T008 (R2)";
    });
    expect(wrongOrigin.length).toBeGreaterThan(0);
    expect(wrongOrigin.every((message) => message.includes("T008"))).toBe(true);
    const twoLive = await duplicates((tampered) => {
      const item = itemOf(tampered, "R3", "T008");
      item.status = "open";
      delete item.reference;
    });
    expect(twoLive.length).toBeGreaterThan(0);
    expect(twoLive.every((message) => message.includes("T008"))).toBe(true);
    const backwards = await duplicates((tampered) => {
      itemOf(tampered, "R2", "T009").reference = "R1";
    });
    expect(backwards.some((message) => message.includes("T009"))).toBe(true);
  });

  test("without an active round TODOs live in the target's planned round and cross-round moves get a fresh ID", async () => {
    const repo = await plannedRepo();
    await closeGrowth(repo);
    await confirm(repo, prepareRoundPlan(repo, main, { round: plan("Later") }));
    let model = await loadAll(repo);
    expect(model.rounds.some((round) => round.status === "active")).toBe(false);
    expect(roundOf(model, "R5").status).toBe("planned");

    success(await todo(repo, main, { action: "add", title: "Shard keys", severity: "low", source: "Review", target: "S07" }));
    success(await todo(repo, main, { action: "add", title: "Refund audit", severity: "normal", source: "Review", target: "S06" }));
    const before = await bytes(repo);
    refused(
      await todo(repo, main, { action: "add", title: "Floating", severity: "low", source: "Review", trigger: "Someday" }),
      "active round",
    );
    expect(await bytes(repo)).toEqual(before);
    model = await loadAll(repo);
    expect(itemOf(model, "R4", "T008")).toMatchObject({ status: "open", target: "S07" });
    expect(itemOf(model, "R3", "T009")).toMatchObject({ status: "open", target: "S06" });
    expect(todoDoc(model, "R2").items.some((item) => item.id === "T008" || item.id === "T009")).toBe(false);

    success(await todo(repo, main, { action: "move", id: "T008", trigger: "When load grows" }));
    model = await loadAll(repo);
    expect(itemOf(model, "R4", "T008")).toMatchObject({ status: "open", trigger: "When load grows" });
    expect(itemOf(model, "R4", "T008").target).toBeUndefined();

    const frozenGrowth = under(await bytes(repo), "docs/roadmap/02-growth/");
    success(await todo(repo, main, { action: "move", id: "T009", target: "S07" }));
    model = await loadAll(repo);
    expect(itemOf(model, "R3", "T009")).toMatchObject({ status: "moved", reference: "T010 (R4)" });
    expect(itemOf(model, "R4", "T010")).toMatchObject({
      status: "open",
      title: "Refund audit",
      target: "S07",
      carried_from: "T009 (R3)",
    });
    expect(under(await bytes(repo), "docs/roadmap/02-growth/")).toEqual(frozenGrowth);
    await expectClean(repo);

    refused(await prepareRoundDrop(repo, main, { id: "R4", reason: "Not needed" }), "T008");
    const misplaced = await loadAll(repo);
    const item = itemOf(misplaced, "R4", "T008");
    delete item.trigger;
    item.target = "S06";
    expect(
      (await check(misplaced)).filter((diagnostic) => diagnostic.rule === "todo-target").map((diagnostic) => diagnostic.message),
    ).toHaveLength(1);
  });
});

describe("target dates", () => {
  test("strict dates through add, edit, amend and retarget promote only the files that gain a target", async () => {
    const repo = await v023Repo();
    await confirm(repo, prepareUpgrade(repo, main));
    const original = await bytes(repo);
    for (const value of ["2026-02-29", "2026-13-01", "2026-1-05", "26-10-01", "soon"])
      refused(await stage(repo, main, draft("Bad", { target: value })), "calendar date");
    refused(await prepareRetarget(repo, main, { id: "S04", target: "2026-02-30" }), "calendar date");
    expect(await bytes(repo)).toEqual(original);
    success(await stage(repo, main, draft("Leap", { target: "2028-02-29" })));
    let model = await loadAll(repo);
    const leap = model.stages.find((candidate) => candidate.title === "Leap");
    expect(leap).toMatchObject({ format: 2, target: "2028-02-29", round: "R2" });

    success(await stage(repo, main, { action: "edit", id: "S04", title: "Sales reports" }));
    model = await loadAll(repo);
    expect(stageOf(model, "S04")).toMatchObject({ format: 1, title: "Sales reports" });
    expect(raw(model, stageOf(model, "S04").path)).toContain(managedComment(1));

    const unchanged = await bytes(repo);
    const r2Readme = unchanged["docs/roadmap/02-growth/README.md"];
    const retarget = prepared(await prepareRetarget(repo, main, { id: "S04", target: "2026-11-01" }));
    expect(await bytes(repo)).toEqual(unchanged);
    success(await applyPrepared(repo, main, retarget.prepared));
    model = await loadAll(repo);
    const s04 = stageOf(model, "S04");
    expect(s04).toMatchObject({ format: 2, target: "2026-11-01" });
    expect(raw(model, s04.path)).toContain(managedComment(2));
    expect(raw(model, s04.path)).toContain('target: "2026-11-01"');
    expect((await bytes(repo))["docs/roadmap/02-growth/README.md"]).toBe(r2Readme);
    refused(await prepareRetarget(repo, main, { id: "S04", target: "2026-11-01" }), "already has");
    await confirm(repo, prepareRetarget(repo, main, { id: "S04", target: "none" }));
    model = await loadAll(repo);
    expect(stageOf(model, "S04")).toMatchObject({ format: 2, target: null });

    success(await stage(repo, main, { action: "amend", id: "S03", reason: "Schedule receipts", target: "2026-11-20" }));
    model = await loadAll(repo);
    const s03 = stageOf(model, "S03");
    expect(s03).toMatchObject({ format: 2, target: "2026-11-20", status: "active" });
    expect(s03.amendments).toContain("TARGET 2026-11-20 (was: none)");
    expect(parseDoneCriteria(s03.done_criteria).map((criterion) => criterion.id)).toEqual(["DC1", "DC2"]);
    refused(await stage(repo, main, { action: "amend", id: "S03", reason: "Again", target: "2026-11-20" }), "already has");
    refused(await stage(repo, main, { action: "start", id: "S04", target: "2026-12-01" }), "target applies only");

    await confirm(repo, prepareRetarget(repo, main, { id: "R2", target: "2026-12-31" }));
    model = await loadAll(repo);
    const r2 = roundOf(model, "R2");
    expect(r2).toMatchObject({ format: 2, target: "2026-12-31", status: "active" });
    expect(raw(model, r2.path)).toContain("| Stage | Title | Status | Target | Dependencies | Created | Started | Closed |");
    expect(raw(model, r2.path)).toContain(`| S03 | Receipts again | active | 2026-11-20 |`);

    const settled = await bytes(repo);
    refused(await prepareRetarget(repo, main, { id: "S05", target: "2027-01-01" }), "Only unclosed");
    refused(await prepareRetarget(repo, main, { id: "R1", target: "2027-01-01" }), "Only unclosed");
    refused(await prepareRetarget(repo, main, { id: "S01", target: "2027-01-01" }), "frozen or inactive");
    refused(await prepareRetarget(repo, main, { id: "R9", target: "2027-01-01" }), "R9");
    expect(await bytes(repo)).toEqual(settled);

    const after = await bytes(repo);
    expect(under(after, "docs/roadmap/01-launch/")).toEqual(under(original, "docs/roadmap/01-launch/"));
    expect(after["docs/roadmap/02-growth/stages/05-docs.md"]).toBe(original["docs/roadmap/02-growth/stages/05-docs.md"]);
    await expectClean(repo);
  });

  test("format-1 repositories refuse every target without writing", async () => {
    const repo = await v023Repo();
    const before = await bytes(repo);
    refused(await stage(repo, main, draft("Dated", { target: "2026-11-01" })), "/roadmap upgrade");
    refused(await stage(repo, main, { action: "edit", id: "S04", target: "2026-11-01" }), "/roadmap upgrade");
    refused(await stage(repo, main, { action: "amend", id: "S03", reason: "Schedule", target: "2026-11-01" }), "/roadmap upgrade");
    refused(await prepareRetarget(repo, main, { id: "S04", target: "2026-11-01" }), "/roadmap upgrade");
    refused(await prepareRetarget(repo, main, { id: "R2", target: "2026-11-01" }), "/roadmap upgrade");
    refused(await stage(repo, main, draft("Future", { round: "R3" })), "R3");
    refused(await prepareRoundDrop(repo, main, { id: "R2", reason: "No" }), "Only planned rounds");
    expect(await bytes(repo)).toEqual(before);
    const model = await loadAll(repo);
    expect(() => renderStage({ ...stageOf(model, "S04"), target: "2026-11-01" })).toThrow("format 2");
    expect(() => renderRound({ ...roundOf(model, "R2"), status: "planned", opened: null })).toThrow("format 2");
    await expectClean(repo);
  });

  test("overdue flags only unfinished items whose target has passed", () => {
    expect(overdue({ status: "planned", target: "2026-10-01" }, "2026-10-02")).toBe(true);
    expect(overdue({ status: "active", target: "2026-10-01" }, "2026-10-02")).toBe(true);
    expect(overdue({ status: "active", target: "2026-10-02" }, "2026-10-02")).toBe(false);
    expect(overdue({ status: "closed", target: "2026-10-01" }, "2026-10-02")).toBe(false);
    expect(overdue({ status: "dropped", target: "2026-10-01" }, "2026-10-02")).toBe(false);
    expect(overdue({ status: "planned", target: null }, "2026-10-02")).toBe(false);
  });
});

describe("format markers", () => {
  const s04 = "docs/roadmap/02-growth/stages/04-reports.md";

  async function errorPathsAfter(edit: (content: string) => string, path = s04): Promise<string[]> {
    const repo = await v023Repo();
    const file = join(repo.repoRoot, path);
    await writeFile(file, edit(await readFile(file, "utf8")));
    return (await check(await loadAll(repo))).filter((item) => item.severity === "error").map((item) => relative(repo.repoRoot, item.path));
  }

  test("a format-2 file in a format-1 repository is a check error that blocks writes", async () => {
    const repo = await v023Repo();
    const model = await loadAll(repo);
    const file = stageOf(model, "S04");
    await writeFile(file.path, renderStage({ ...file, format: 2, target: "2026-11-01" }));
    const diagnostics = (await check(await loadAll(repo))).filter((item) => item.severity === "error");
    expect(diagnostics.map((item) => [item.rule, relative(repo.repoRoot, item.path)])).toEqual([["format", s04]]);
    const before = await bytes(repo);
    refused(await todo(repo, main, { action: "add", title: "Blocked", severity: "low", source: "Review", trigger: "Later" }), "format");
    const changed = new Set<string>();
    await check(await loadAll(repo), { fix: true, changedFiles: changed });
    expect([...changed]).toEqual([]);
    expect(await bytes(repo)).toEqual(before);
  });

  test("each file's managed comment, keys and statuses must match its own format", async () => {
    expect(await errorPathsAfter((content) => content.replace("(format v1)", "(format v2)"))).toContain(s04);
    expect(
      await errorPathsAfter((content) => content.replace("format: 1\n", "format: 2\n").replace("depends_on:", "target: null\ndepends_on:")),
    ).toContain(s04);
    expect(await errorPathsAfter((content) => content.replace("depends_on:", "target: null\ndepends_on:"))).toContain(s04);
    const r2 = "docs/roadmap/02-growth/README.md";
    expect(
      await errorPathsAfter((content) => content.replace('status: "active"\nopened: "2026-10-08"', 'status: "planned"\nopened: null'), r2),
    ).toContain(r2);
    const index = "docs/roadmap/README.md";
    expect(await errorPathsAfter((content) => content.replace("roadmap: { format: 1 }", "roadmap: { format: 2 }"), index)).toContain(index);
  });

  test("format-1 and format-2 files coexist in an upgraded repository", async () => {
    const repo = await plannedRepo();
    await confirm(repo, prepareRetarget(repo, main, { id: "S04", target: "2026-11-01" }));
    const model = await loadAll(repo);
    const formats = new Set([...model.rounds, ...model.stages, ...model.todos].map((doc) => doc.format));
    expect([...formats].sort()).toEqual([1, 2]);
    for (const doc of [...model.rounds, ...model.stages, ...model.todos])
      expect(raw(model, doc.path)).toContain(managedComment(doc.format));
    await expectClean(repo);
  });
});
