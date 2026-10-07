import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseHtml, proseText } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";
import { check } from "../plugins/roadmap/src/check.ts";
import {
  generatedBlock,
  generatedContent,
  loadAll,
  loadRepo,
  type Model,
  markdownHeadings,
  parseAdr,
  parseStage,
  type Repo,
  renderAdr,
  renderRound,
  renderStage,
  renderStageTable,
  renderTodo,
  replaceGenerated,
  roundFiles,
  roundSha256,
  stageSha256,
} from "../plugins/roadmap/src/documents.ts";
import { discoverRepo } from "../plugins/roadmap/src/git.ts";
import { renderHandoff, renderInjection } from "../plugins/roadmap/src/handoff.ts";
import {
  type Actor,
  adr,
  applyPrepared,
  atomicWrite,
  closeRound,
  type InitInput,
  initProject,
  openRound,
  type PreparationReceipt,
  prepareInit,
  prepareRoundOpen,
  type Receipt,
  type RoundInput,
  recordFreeWork,
  type StageInput,
  type StageOperationInput,
  stage,
  todo,
} from "../plugins/roadmap/src/operations.ts";
import { cleanupFixtures, diskFixture, modelFixture, stageFixture } from "./roadmap-fixtures.ts";
import {
  allowedMarkdownBodies,
  ambiguousMarkdownBodies,
  literalMarkdownBodies,
  markdownStructureEscapes,
  rejectedMarkdownBodies,
} from "./roadmap-markdown-fixtures.ts";

const main: Actor = { sessionId: "main-session", kind: "main" };
const sub: Actor = { sessionId: "sub-session", kind: "sub" };
const temporary: string[] = [];
const charter: RoundInput = {
  title: "Launch",
  goal: "A usable, verified checkout",
  constraints: ["Use the host"],
  non_goals: ["A new runtime"],
  principles: [{ text: "Use the documented host choice", adrs: ["ADR-0001"] }],
};
const stageInput: StageInput = {
  title: "Checkout",
  objective: "Customers complete checkout",
  scope_in: ["Payment"],
  scope_out: ["Refunds"],
  done_criteria: [
    { id: "DC1", statement: "Checkout works", verify: "bun test checkout" },
    { id: "DC2", statement: "Receipts arrive", verify: "Manual receipt check" },
  ],
  design_constraints: "Use ADR-0001.",
};
const sections = {
  context: "We need a supported host.",
  options: ["Use the host", "Build a replacement"],
  outcome: "Use the host.",
  confirmation: "Exercise the real loader.",
};
const initInput: InitInput = {
  project: { name: "Shop", description: "A small shop with real checkout." },
  round: charter,
  adrs: [{ title: "Host choice", status: "accepted", sections }],
  stages: [stageInput],
};

function success(receipt: Receipt): Extract<Receipt, { ok: true }> {
  if (!receipt.ok) throw new Error(`${receipt.reason}\n${receipt.hints.join("\n")}`);
  return receipt;
}

function refused(receipt: Receipt | PreparationReceipt, message: string): Extract<Receipt, { ok: false }> {
  expect(receipt.ok).toBe(false);
  if (receipt.ok) throw new Error("Expected a refused operation.");
  expect(`${receipt.reason}\n${receipt.hints.join("\n")}`).toContain(message);
  return receipt;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", repoRoot, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exit !== 0) throw new Error(`git ${args.join(" ")} failed (${exit}): ${stderr}`);
  return stdout.trim();
}

async function emptyRepo(): Promise<Repo> {
  const repoRoot = await mkdtemp(join(tmpdir(), "roadmap-operations-"));
  temporary.push(repoRoot);
  await git(repoRoot, ["init", "-q"]);
  const info = discoverRepo(repoRoot);
  if (!info) throw new Error("Temp git repository was not discovered.");
  return { ...info, roadmapDir: join(repoRoot, "docs/roadmap"), adrDir: join(repoRoot, "docs/adr") };
}

async function initialized(): Promise<Repo> {
  const repo = await emptyRepo();
  success(await initProject(repo, main, initInput));
  expect((await check(await loadAll(repo))).filter((item) => item.severity === "error")).toEqual([]);
  return repo;
}

async function reviewedRound(repo: Repo): Promise<{ id: string; sha256: string }> {
  const model = await loadAll(repo);
  const round = model.rounds.find((candidate) => candidate.status === "active");
  if (!round) throw new Error("Missing active round");
  return { id: round.id, sha256: roundSha256(roundFiles(model, round)) };
}

function evidence(id = "S01", criteria = ["DC1", "DC2"]): StageOperationInput {
  return {
    action: "close",
    id,
    delivered: "- Checkout shipped.",
    deviations: "None.",
    evidence: criteria.map((criterion) => ({
      criterion,
      result: "pass",
      method: "bun test checkout",
      summary: "42 pass",
      commit: "abc1234",
    })),
  };
}

async function managedBytes(repo: Repo): Promise<Record<string, string>> {
  const model = await loadAll(repo);
  return Object.fromEntries(Object.entries(model.files ?? {}).map(([path, content]) => [path, Buffer.from(content).toString("utf8")]));
}

afterAll(async () => {
  await cleanupFixtures();
  for (const path of temporary) await rm(path, { recursive: true, force: true });
});

describe("roadmap stage lifecycle and close gate", () => {
  test("add, edit, start, join, amend and close write the specified Outcome and preserve evidence", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "add", ...stageInput, title: "Payments" }));
    success(await stage(repo, main, { action: "edit", id: "S02", title: "Orders and payments", risks: "Do not duplicate free work." }));
    const start = success(await stage(repo, main, { action: "start", id: "S02" }));
    expect(start.handoff).toContain("S02 — Orders and payments");
    expect(start.handoff).toContain("DC2 — Receipts arrive");
    const beforeJoin = await managedBytes(repo);
    const join = success(await stage(repo, { ...main, sessionId: "other-session" }, { action: "start", id: "S02" }));
    expect(join.warnings).toContain("another session may be working on this stage");
    expect(join.changedFiles).toEqual([]);
    expect(await managedBytes(repo)).toEqual(beforeJoin);
    refused(await stage(repo, main, { action: "edit", id: "S02", objective: "A shortcut" }), "Only planned");
    success(
      await stage(repo, sub, {
        action: "amend",
        id: "S02",
        reason: "Receipt delivery becomes a later increment",
        amendments: {
          modify: [{ id: "DC1", statement: "Orders can be paid", verify: "bun test orders" }],
          remove: ["DC2"],
          add: [{ statement: "Payment is idempotent", verify: "bun test idempotency" }],
          scope: [
            { op: "remove", side: "in", item: "Payment" },
            { op: "add", side: "in", item: "Orders and payment" },
          ],
        },
      }),
    );
    success(await todo(repo, main, { action: "add", title: "Receipt cleanup", severity: "normal", source: "S02", target: "S02" }));
    success(await adr(repo, main, { action: "create", title: "Order identity", stage: "S02", sections }));
    const receipt = success(
      await stage(repo, main, {
        ...evidence("S02", ["DC1", "DC3"]),
        todos: [{ id: "T001", disposition: "resolved", reference: "S02, commit abc1234" }],
        adrs: [{ id: "ADR-0002", status: "accepted" }],
      }),
    );
    expect(receipt.summary).toContain("Closed S02");
    const model = await loadAll(repo);
    const closed = model.stages.find((item) => item.id === "S02");
    expect(closed?.status).toBe("closed");
    expect(closed?.closed_sha256).toBe(stageSha256(closed as NonNullable<typeof closed>));
    expect(closed?.scope_in).toBe("- Orders and payment");
    expect(closed?.amendments).toContain("- MODIFIED DC1 — Orders can be paid (was: Checkout works)");
    expect(closed?.amendments).toContain("- REMOVED Scope/In: Payment");
    expect(closed?.outcome).toBe(
      [
        "### Delivered\n\n- Checkout shipped.",
        "### Deviations\n\nNone.",
        `### Evidence\n\n- DC1 — pass — Verify: bun test checkout → 42 pass — commit abc1234\n- DC3 — pass — Verify: bun test checkout → 42 pass — commit abc1234\n- DC2 — removed by amendment ${new Date().toISOString().slice(0, 10)}`,
        "### TODO\n\n- T001 resolved · S02, commit abc1234",
        "### ADRs\n\n- ADR-0002 accepted",
      ].join("\n\n"),
    );
    const closedText = await readFile(closed?.path as string, "utf8");
    expect(closedText.slice(closedText.indexOf("## Outcome"))).toBe(`## Outcome\n${closed?.outcome}\n\n`);
    expect((await check(model)).filter((item) => item.severity === "error")).toEqual([]);
    refused(await stage(repo, main, { action: "start", id: "S02" }), "cannot start");
    refused(await stage(repo, main, evidence("S02", ["DC1", "DC3"])), "Only an active");
    refused(await stage(repo, main, { action: "renumber", id: "S02" }), "Only a planned");
  });

  test("start requires closed dependencies and clean documents; close also checks documents", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "add", ...stageInput, depends_on: ["S01"], title: "Dependent" }));
    refused(await stage(repo, main, { action: "start", id: "S02" }), "Dependency S01");
    const index = join(repo.roadmapDir, "README.md");
    const raw = await readFile(index, "utf8");
    await writeFile(index, replaceGenerated(raw, "status", "stale"));
    refused(await stage(repo, main, { action: "start", id: "S01" }), "generated");
    await writeFile(index, raw);
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const activeRaw = await readFile(index, "utf8");
    await writeFile(index, replaceGenerated(activeRaw, "status", "stale"));
    refused(await stage(repo, main, evidence()), "generated");
    await writeFile(index, activeRaw);
    success(await stage(repo, main, evidence()));
    success(await stage(repo, main, { action: "start", id: "S02" }));
    expect((await loadAll(repo)).stages.find((item) => item.id === "S02")?.status).toBe("active");
  });

  test.each(["stage hash", "stage date", "round hash", "round date"] as const)(
    "retained closure metadata (%s) refuses every mutation before it can change history",
    async (scenario) => {
      const repo = await initialized();
      success(await stage(repo, main, { action: "start", id: "S01" }));
      success(await stage(repo, main, evidence()));
      const isRound = scenario.startsWith("round");
      if (isRound) success(await closeRound(repo, main, { expected: await reviewedRound(repo), dispositions: [] }));
      const model = await loadAll(repo);
      const current = isRound ? model.rounds[0] : model.stages[0];
      if (!current) throw new Error("Missing closed document");
      let raw = (await readFile(current.path, "utf8")).replace(/^status: "closed"$/m, `status: "${isRound ? "active" : "planned"}"`);
      if (scenario.endsWith("date")) raw = raw.replace(/^(closed_sha256|frozen_sha256):.*$/m, "$1: null");
      await writeFile(current.path, raw);
      const before = await managedBytes(repo);
      const rule = isRound ? "frozen-round-status" : "closed-stage-status";
      const attempts: Array<() => Promise<Receipt>> = [
        () => stage(repo, main, { action: "add", ...stageInput, title: "Forbidden addition" }),
        () => stage(repo, main, { action: "edit", id: "S01", objective: "Forbidden rewrite" }),
        () => stage(repo, main, { action: "start", id: "S01" }),
        () => stage(repo, main, { action: "drop", id: "S01", reason: "Hide the retained date" }),
        () => stage(repo, main, { action: "renumber", id: "S01", new_id: "S10" }),
        () => todo(repo, main, { action: "add", title: "Forbidden TODO", severity: "normal", source: "Review", trigger: "Later" }),
        () => adr(repo, main, { action: "create", title: "Forbidden ADR", status: "accepted", sections }),
        () => adr(repo, main, { action: "note", id: "ADR-0001", text: "Forbidden note" }),
      ];
      for (const attempt of attempts) {
        refused(await attempt(), rule);
        expect(await managedBytes(repo)).toEqual(before);
      }
      const active = raw.replace(/^status: "planned"$/m, 'status: "active"');
      await writeFile(current.path, active);
      const activeBefore = await managedBytes(repo);
      refused(await stage(repo, main, evidence()), rule);
      expect(await managedBytes(repo)).toEqual(activeBefore);
    },
  );

  test("criterion, TODO and ADR gate refusals write nothing; subagents cannot dispose proposed ADRs", async () => {
    const { repo } = await diskFixture();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const before = await managedBytes(repo);
    refused(await stage(repo, main, { ...evidence("S01", ["DC1"]), evidence: [] }), "DC1 requires passing evidence");
    refused(
      await stage(repo, main, {
        ...evidence("S01", ["DC1"]),
        evidence: [{ criterion: "DC1", result: "fail", method: "bun test", summary: "1 fail" }],
      }),
      "passing evidence",
    );
    refused(await stage(repo, main, evidence("S01", ["DC1"])), "Every open TODO");
    expect(await managedBytes(repo)).toEqual(before);
    success(await adr(repo, main, { action: "create", title: "Pending choice", stage: "S01", sections }));
    const proposed = await managedBytes(repo);
    const close: StageOperationInput = {
      ...evidence("S01", ["DC1"]),
      todos: [{ id: "T001", disposition: "resolved", reference: "commit abc1234" }],
    };
    refused(await stage(repo, main, close), "Every proposed ADR");
    refused(await stage(repo, sub, { ...close, adrs: [{ id: "ADR-0002", status: "accepted" }] }), "main agent");
    const pending = { id: "ADR-0002", status: "accepted" } as const;
    refused(await stage(repo, main, { ...close, adrs: [pending, { id: "ADR-0001", status: "accepted" }] }), "ADR-0001 is accepted");
    refused(await stage(repo, main, { ...close, adrs: [pending, pending] }), "listed more than once");
    refused(await stage(repo, main, { ...close, adrs: [pending, { id: "ADR-0099", status: "accepted" }] }), "Unknown ADR ADR-0099");
    expect(await managedBytes(repo)).toEqual(proposed);
    success(await stage(repo, main, { ...close, adrs: [{ id: "ADR-0002", status: "rejected" }] }));
    expect((await loadAll(repo)).adrs.find((item) => item.id === "ADR-0002")?.status).toBe("rejected");
  });

  test("close moves TODOs to another stage or a trigger, never to itself", async () => {
    const { repo } = await diskFixture();
    success(await stage(repo, main, { action: "add", ...stageInput, title: "Follow-up" }));
    success(await todo(repo, main, { action: "add", title: "Wait for host", source: "S01", severity: "low", target: "S01" }));
    success(await stage(repo, main, { action: "start", id: "S01" }));
    refused(
      await stage(repo, main, { ...evidence("S01", ["DC1"]), todos: [{ id: "T001", disposition: "moved", target: "S01" }] }),
      "still targets",
    );
    success(
      await stage(repo, main, {
        ...evidence("S01", ["DC1"]),
        todos: [
          { id: "T001", disposition: "moved", target: "S02" },
          { id: "T002", disposition: "moved", target: "trigger: When the host adds the API" },
        ],
      }),
    );
    const model = await loadAll(repo);
    expect(model.todos[0]?.items.find((item) => item.id === "T001")).toMatchObject({ status: "open", target: "S02" });
    expect(model.todos[0]?.items.find((item) => item.id === "T002")).toMatchObject({
      status: "open",
      trigger: "When the host adds the API",
    });
    expect(model.todos[0]?.items.find((item) => item.id === "T002")?.target).toBeUndefined();
    expect((await check(model)).filter((item) => item.severity === "error")).toEqual([]);
  });

  test("drop requires a reason and no targeted TODO; TODO add/update/move/resolve enforce active targets", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "add", ...stageInput, title: "Later" }));
    refused(await stage(repo, main, { action: "drop", id: "S02" }), "drop reason");
    refused(await todo(repo, main, { action: "add", title: "Missing source", severity: "normal", target: "S02" }), "source");
    success(await todo(repo, sub, { action: "add", title: "Cleanup", severity: "normal", source: "S01", target: "S02", body: "Old body" }));
    refused(await stage(repo, main, { action: "drop", id: "S02", reason: "Out of scope" }), "open TODO");
    success(await todo(repo, main, { action: "update", id: "T001", title: "Important cleanup", severity: "high", body: "Updated body" }));
    success(await stage(repo, main, { action: "start", id: "S01" }));
    success(await stage(repo, main, evidence()));
    refused(await todo(repo, main, { action: "move", id: "T001", target: "S01" }), "closed");
    refused(await todo(repo, main, { action: "move", id: "T001", target: "S02", trigger: "Later" }), "exactly one");
    success(await todo(repo, main, { action: "move", id: "T001", trigger: "When the host is ready" }));
    success(await stage(repo, sub, { action: "drop", id: "S02", reason: "No longer in this round" }));
    refused(await todo(repo, main, { action: "move", id: "T001", target: "S02" }), "dropped");
    success(await todo(repo, sub, { action: "resolve", id: "T001", reference: "commit abc1234" }));
    refused(await todo(repo, main, { action: "update", id: "T001", body: "Overwrite" }), "not open");
    const item = (await loadAll(repo)).todos[0]?.items[0];
    expect(item).toMatchObject({ title: "Important cleanup", severity: "high", body: "Updated body", status: "resolved" });
  });

  test("renumber rewrites mutable references, removes the old filename and preserves origin metadata", async () => {
    const { repo } = await diskFixture();
    success(
      await stage(repo, main, {
        action: "add",
        ...stageInput,
        title: "Follow S01",
        objective: "Build on S01, not S010.",
        depends_on: ["S01"],
        follows: "S01",
      }),
    );
    success(await todo(repo, main, { action: "update", id: "T001", body: "S01 needs follow-up; S010 is a different id." }));
    const old = (await loadAll(repo)).stages.find((item) => item.id === "S01")?.path as string;
    success(await stage(repo, main, { action: "renumber", id: "S01", new_id: "S10" }));
    const model = await loadAll(repo);
    expect(model.stages.find((item) => item.id === "S10")?.path).toContain("/10-launch.md");
    expect(model.stages.find((item) => item.id === "S02")).toMatchObject({
      depends_on: ["S10"],
      follows: "S10",
      title: "Follow S10",
      objective: "Build on S10, not S010.",
    });
    expect(model.todos[0]?.items[0]).toMatchObject({
      target: "S10",
      source: "S10 (2026-10-06)",
      body: "S10 needs follow-up; S010 is a different id.",
    });
    expect(model.adrs[0]?.stage).toBe("S10");
    expect(await Bun.file(old).exists()).toBe(false);
    expect((await check(model)).filter((item) => item.severity === "error")).toEqual([]);
    refused(await stage(repo, main, { action: "renumber", id: "S10", new_id: "S02" }), "fresh stage id");
  });

  test("renumber refuses references in closed stages and frozen round files", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "add", ...stageInput, title: "Correction" }));
    success(await stage(repo, main, { action: "edit", id: "S01", design_constraints: "Also inspect S02." }));
    success(await stage(repo, main, { action: "start", id: "S01" }));
    success(await stage(repo, main, evidence()));
    const before = await managedBytes(repo);
    refused(await stage(repo, main, { action: "renumber", id: "S02" }), "terminal stage S01");
    expect(await managedBytes(repo)).toEqual(before);

    const frozenRepo = await initialized();
    const first = await loadAll(frozenRepo);
    const round = first.rounds[0];
    if (!round) throw new Error("Missing round");
    round.goal += "\n\nS03 is reserved for a later round.";
    await writeFile(round.path, renderRound(round, first.stages));
    success(await stage(frozenRepo, main, { action: "drop", id: "S01", reason: "Deferred" }));
    success(await closeRound(frozenRepo, main, { expected: await reviewedRound(frozenRepo), dispositions: [] }));
    success(await openRound(frozenRepo, main, { round: { ...charter, title: "Next" }, import_todos: [] }));
    success(await stage(frozenRepo, main, { action: "add", ...stageInput, title: "Second" }));
    success(await stage(frozenRepo, main, { action: "add", ...stageInput, title: "Third" }));
    const frozenBytes = await readFile(round.path, "utf8");
    refused(await stage(frozenRepo, main, { action: "renumber", id: "S03" }), "frozen round R1");
    expect(await readFile(round.path, "utf8")).toBe(frozenBytes);
  });

  test("invalid amendments and newer formats are refused without changing managed files", async () => {
    const repo = await initialized();
    refused(
      await stage(repo, main, { action: "amend", id: "S01", reason: "Too early", amendments: { remove: ["DC1"] } }),
      "Only an active",
    );
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const before = await managedBytes(repo);
    refused(
      await stage(repo, main, { action: "amend", id: "S01", reason: "Remove all", amendments: { remove: ["DC1", "DC2"] } }),
      "retain at least one",
    );
    refused(
      await stage(repo, main, {
        action: "amend",
        id: "S01",
        reason: "Reuse",
        amendments: { add: [{ id: "DC1", statement: "New", verify: "test" }] },
      }),
      "reused",
    );
    expect(await managedBytes(repo)).toEqual(before);
    const path = (await loadAll(repo)).stages[0]?.path as string;
    await writeFile(path, (await readFile(path, "utf8")).replace(/^format: 1$/m, "format: 2"));
    const newer = await managedBytes(repo);
    refused(
      await todo(repo, main, { action: "add", title: "Ignored", severity: "low", source: "S01", trigger: "Later" }),
      "Unsupported roadmap format 2",
    );
    expect(await managedBytes(repo)).toEqual(newer);
  });
});

describe("roadmap TODO body structure", () => {
  test("add and update refuse injected item headings without writes, but preserve fenced examples", async () => {
    const repo = await initialized();
    const duplicate = "### T001 — Injected item\n- Severity: normal\n- Source: injected\n- Target: S01\n\nInjected body.";
    const initial = await managedBytes(repo);
    const addition = await todo(repo, main, {
      action: "add",
      title: "Legitimate item",
      source: "S01 review",
      severity: "normal",
      target: "S01",
      body: duplicate,
    });
    expect(addition.ok).toBe(false);
    if (addition.ok) throw new Error("Injected TODO heading was written.");
    expect(addition.hints.length).toBeGreaterThan(0);
    expect(await managedBytes(repo)).toEqual(initial);

    const fenced = `Example:\n\n\`\`\`markdown\n${duplicate}\n\`\`\``;
    success(await todo(repo, main, { action: "add", title: "Example", source: "Review", severity: "normal", target: "S01", body: fenced }));
    let model = await loadAll(repo);
    const item = model.todos[0]?.items[0];
    expect(item?.body).toBe(fenced);
    const beforeUpdate = await managedBytes(repo);
    const update = await todo(repo, main, { action: "update", id: item?.id, body: duplicate.replace("T001", item?.id as string) });
    expect(update.ok).toBe(false);
    if (update.ok) throw new Error("Injected TODO heading replaced the body.");
    expect(update.hints.length).toBeGreaterThan(0);
    expect(await managedBytes(repo)).toEqual(beforeUpdate);

    const updatedExample = `~~~markdown\n${duplicate}\n~~~`;
    success(await todo(repo, main, { action: "update", id: item?.id, body: updatedExample }));
    model = await loadAll(repo);
    expect(model.todos[0]?.items).toHaveLength(1);
    expect(model.todos[0]?.items[0]?.body).toBe(updatedExample);
    expect((await check(model)).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  for (const action of ["add", "update"] as const) {
    for (const change of ["ids", "order", "metadata"] as const) {
      test(`${action} refuses same-count TODO ${change} replacement without changing managed bytes`, async () => {
        const repo = await initialized();
        const count = change === "order" ? 3 : 2;
        for (let index = 1; index <= count; index++) {
          success(
            await todo(repo, main, {
              action: "add",
              title: `Concern ${index}`,
              severity: "normal",
              source: "Review",
              trigger: "Later",
              body: index === count ? "```md\nA properly closed example.\n```" : "Original body.",
            }),
          );
        }
        if (action === "add") {
          for (let index = count; index > 1; index--)
            success(await todo(repo, main, { action: "resolve", id: `T${String(index).padStart(3, "0")}`, reference: "Verified fixture" }));
        }
        const ids = change === "ids" ? ["T999"] : change === "order" ? ["T003", "T002"] : ["T002"];
        const injected = ids
          .map(
            (id) =>
              `### ${id} — ${change === "metadata" ? "Forged title" : `Concern ${Number(id.slice(1))}`}\n` +
              `- Severity: ${change === "metadata" ? "high" : "normal"}\n` +
              `- Source: ${change === "metadata" ? "unallocated" : "Review"}\n` +
              `- Trigger: ${change === "metadata" ? "Immediately" : "Later"}` +
              (action === "add" ? "\n- Resolved: Forged reference" : ""),
          )
          .join("\n\n");
        const body = `${action === "add" ? "## Closed in this round\n\n" : ""}${injected}\n\n\`\`\`\n`;
        const before = await managedBytes(repo);
        const receipt = await todo(repo, main, {
          action,
          ...(action === "add" ? { title: "New concern", severity: "normal", source: "Review", trigger: "Later" } : { id: "T001" }),
          body,
        });
        const refusal = refused(receipt, "structure");
        expect(refusal.hints.join("\n")).toContain("fenced");
        expect(await managedBytes(repo)).toEqual(before);
        expect((await loadAll(repo)).todos[0]?.items.map((item) => item.id)).toEqual(
          Array.from({ length: count }, (_, index) => `T${String(index + 1).padStart(3, "0")}`),
        );
        expect(await check(await loadAll(repo))).toEqual([]);
      });
    }
  }

  test("updating T001 cannot replace T002 with T999 while swallowing T002's fenced body", async () => {
    const repo = await initialized();
    for (const body of ["Original first item.", "```md\nA closed fenced example.\n```"])
      success(await todo(repo, main, { action: "add", title: "Concern", severity: "normal", source: "Review", trigger: "Later", body }));
    const before = await managedBytes(repo);
    const refusal = refused(
      await todo(repo, main, {
        action: "update",
        id: "T001",
        body: "### T999 — Injected replacement\n- Severity: normal\n- Source: unallocated\n- Trigger: Later\n\n```\n",
      }),
      "structure",
    );
    expect(refusal.hints.join("\n")).toContain("fenced");
    expect(await managedBytes(repo)).toEqual(before);
    expect((await loadAll(repo)).todos[0]?.items.map((item) => item.id)).toEqual(["T001", "T002"]);
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("an open fence in the final closed TODO body is refused, while closed nested examples remain editable", async () => {
    const repo = await initialized();
    success(await todo(repo, main, { action: "add", title: "Completed", severity: "normal", source: "Review", trigger: "Later" }));
    success(await todo(repo, main, { action: "resolve", id: "T001", reference: "Verified" }));
    const doc = (await loadAll(repo)).todos[0];
    const completed = doc?.items[0];
    if (!doc || !completed) throw new Error("Missing completed TODO");
    completed.body = "```md\nUnfinished example.";
    await writeFile(doc.path, renderTodo(doc));
    const before = await managedBytes(repo);
    refused(
      await todo(repo, main, { action: "add", title: "Next concern", severity: "normal", source: "Review", trigger: "Later" }),
      "fence",
    );
    expect(await managedBytes(repo)).toEqual(before);
    completed.body = "";
    await writeFile(doc.path, renderTodo(doc));
    const example = "````md\n### T999 — Example\n```\n````";
    success(
      await todo(repo, main, { action: "add", title: "Example", severity: "normal", source: "Review", trigger: "Later", body: example }),
    );
    const added = (await loadAll(repo)).todos[0]?.items.find((item) => item.status === "open");
    expect(added?.body).toBe(example);
    const beforeIndented = await managedBytes(repo);
    refused(await todo(repo, main, { action: "update", id: added?.id, body: "   ~~~~md\n### T999 — Example\n   ~~~~~" }), "structure");
    expect(await managedBytes(repo)).toEqual(beforeIndented);
    // Without the unindented paragraph, the opener continues the metadata list
    // and the unindented example heading ends that container before the closer.
    success(await todo(repo, main, { action: "update", id: added?.id, body: "Example:\n\n   ~~~~md\n### T999 — Example\n   ~~~~~" }));
    expect((await loadAll(repo)).todos[0]?.items.find((item) => item.id === "T001")?.body).toBe("");
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("CRLF fenced examples retain bodies and item order when updates follow a resolution", async () => {
    const repo = await initialized();
    const body = "Example:\r\n\r\n```md\r\n### T999 — Example\r\n```\r\n";
    success(await todo(repo, main, { action: "add", title: "First", severity: "normal", source: "Review", trigger: "Later", body }));
    success(await todo(repo, main, { action: "add", title: "Second", severity: "low", source: "Review", trigger: "Later" }));
    success(await todo(repo, main, { action: "resolve", id: "T001", reference: "Verified" }));
    success(await todo(repo, main, { action: "update", id: "T002", body }));
    const model = await loadAll(repo);
    expect(model.todos[0]?.items.map((item) => item.id)).toEqual(["T002", "T001"]);
    expect(model.todos[0]?.items.map((item) => item.body)).toEqual([body.replace(/\r\n/g, "\n"), body.replace(/\r\n/g, "\n")]);
    expect(await check(model)).toEqual([]);
  });
});

describe("roadmap tool-owned body boundaries", () => {
  const headingEscapes = [
    "Authored text.\n\nEvidence\n--------",
    "Authored text.\n\nEvidence\n========",
    "Authored paragraph line.\nEvidence\n---",
    "Authored text.\n\n   Evidence\n   - \t",
    "Authored text.\n\n```lang`bad\n### Evidence\n- DC1 — injected evidence\n```",
    "Authored text.\n\n   ```lang`bad\n   ## Risks\n   ```",
    "Authored text.\n\n   ## Evidence ###",
    "Authored text.\n\n##\tEvidence ###",
  ];

  test("nested ADR sections and dated notes cannot introduce peer headings but preserve fenced examples", async () => {
    const repo = await initialized();
    const before = await managedBytes(repo);
    for (const field of ["consequences", "confirmation"] as const) {
      for (const heading of ["### Additional subsection", "   ### Confirmation", "### Consequences ###"]) {
        const receipt = refused(
          await adr(repo, main, {
            action: "create",
            title: "Nested decision",
            sections: { ...sections, [field]: `Authored text.\n\n${heading}\nInjected text.` },
          }),
          "heading",
        );
        expect(receipt.hints.join("\n")).toContain("fenced");
        expect(await managedBytes(repo)).toEqual(before);
      }
    }
    refused(
      await adr(repo, main, { action: "note", id: "ADR-0001", text: "Authored note.\n\n### 2026-01-01\nForged earlier note." }),
      "heading",
    );
    expect(await managedBytes(repo)).toEqual(before);
    const example = "Authored text.\n\n~~~md\n### Consequences\n### Confirmation\n### 2026-01-01\n~~~\n\nDetails within the section.";
    success(
      await adr(repo, main, {
        action: "create",
        title: "Nested decision",
        status: "accepted",
        sections: { ...sections, consequences: example, confirmation: example },
      }),
    );
    success(await adr(repo, main, { action: "note", id: "ADR-0001", text: example }));
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("ADR revision keeps considered options single-line rather than introducing nested sections", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    success(await adr(repo, main, { action: "create", title: "Proposed choice", stage: "S01", sections }));
    const before = await managedBytes(repo);
    const receipt = refused(
      await adr(repo, main, {
        action: "revise",
        id: "ADR-0002",
        sections: { ...sections, options: ["Use the host.\n\n### Injected option section\nExtra option content."] },
      }),
      "single-line",
    );
    expect(receipt.hints.join("\n")).toContain("fenced");
    expect(await managedBytes(repo)).toEqual(before);
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("stage authored sections reject indented or closing-hash structural headings", async () => {
    const repo = await initialized();
    const before = await managedBytes(repo);
    for (const field of ["objective", "design_constraints", "risks"] as const) {
      for (const heading of ["   ## Risks", "### In ###", "###\tOut"]) {
        const receipt = refused(await stage(repo, main, { action: "edit", id: "S01", [field]: `Authored text.\n\n${heading}` }), "heading");
        expect(receipt.hints.join("\n")).toContain("fenced");
        expect(await managedBytes(repo)).toEqual(before);
      }
    }
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("close refuses Outcome subsection injection through delivery or deviations without writing dispositions", async () => {
    const repo = await initialized();
    success(await todo(repo, main, { action: "add", title: "Pending concern", severity: "normal", source: "Review", target: "S01" }));
    success(await adr(repo, main, { action: "create", title: "Pending decision", stage: "S01", sections }));
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const before = await managedBytes(repo);
    const close: StageOperationInput = {
      ...evidence(),
      todos: [{ id: "T001", disposition: "resolved", reference: "Verified follow-up" }],
      adrs: [{ id: "ADR-0002", status: "accepted" }],
    };
    for (const field of ["delivered", "deviations"] as const) {
      for (const heading of [
        "### Delivered",
        "### Deviations",
        "### Evidence",
        "### TODO",
        "### ADRs",
        "### Open TODOs",
        "### Additional subsection",
        "## Risks",
        "# S99 — Replacement stage",
        "   ### Evidence",
        "###\tEvidence",
        "### Evidence ###",
        "###",
      ]) {
        const receipt = refused(await stage(repo, main, { ...close, [field]: `Authored text.\n\n${heading}\nInjected text.` }), "heading");
        expect(receipt.hints.join("\n")).toContain("fenced");
        expect(await managedBytes(repo)).toEqual(before);
      }
      const receipt = refused(await stage(repo, main, { ...close, [field]: "Authored text.\n\n```md\nUnfinished example." }), "fence");
      expect(receipt.hints.join("\n")).toContain("close");
      expect(await managedBytes(repo)).toEqual(before);
    }
    expect((await loadAll(repo)).stages[0]?.status).toBe("active");
    expect((await loadAll(repo)).adrs.find((item) => item.id === "ADR-0002")?.status).toBe("proposed");
    expect((await loadAll(repo)).todos[0]?.items[0]?.status).toBe("open");
  });

  test("Setext and malformed backtick-info escapes cannot close or freeze a stage or apply its dispositions", async () => {
    const repo = await initialized();
    success(await todo(repo, main, { action: "add", title: "Pending concern", severity: "normal", source: "Review", target: "S01" }));
    success(await adr(repo, main, { action: "create", title: "Pending decision", stage: "S01", sections }));
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const before = await managedBytes(repo);
    const close: StageOperationInput = {
      ...evidence(),
      todos: [{ id: "T001", disposition: "resolved", reference: "Verified follow-up" }],
      adrs: [{ id: "ADR-0002", status: "accepted" }],
    };
    for (const field of ["delivered", "deviations"] as const) {
      for (const body of headingEscapes) {
        const receipt = refused(await stage(repo, main, { ...close, [field]: body }), "structure");
        expect(receipt.hints.join("\n")).toContain("fenced");
        expect(await managedBytes(repo)).toEqual(before);
      }
    }
    const model = await loadAll(repo);
    expect(model.stages[0]?.status).toBe("active");
    expect(model.stages[0]?.closed_sha256).toBeNull();
    expect(model.todos[0]?.items[0]?.status).toBe("open");
    expect(model.adrs.find((item) => item.id === "ADR-0002")?.status).toBe("proposed");
    expect(await check(model)).toEqual([]);
  });

  test("all ADR sections reject Setext and malformed-fence heading escapes before create, revise or supersede writes", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    success(await adr(repo, main, { action: "create", title: "Proposed choice", stage: "S01", sections }));
    const before = await managedBytes(repo);
    for (const field of ["context", "drivers", "outcome", "consequences", "confirmation", "pros_cons", "more_info"] as const) {
      for (const body of headingEscapes) {
        for (const input of [
          { action: "create", title: "Injected choice", status: "accepted" },
          { action: "revise", id: "ADR-0002" },
          { action: "supersede", id: "ADR-0001", title: "Injected successor" },
        ] as const) {
          const receipt = await adr(repo, main, { ...input, sections: { ...sections, [field]: body } });
          const rejection = refused(receipt, "structure");
          expect(rejection.hints.join("\n")).toContain("fenced");
          expect(await managedBytes(repo)).toEqual(before);
        }
      }
    }
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("round goals and constraints and TODO bodies reject heading escapes without changing managed bytes", async () => {
    const repo = await initialized();
    success(await todo(repo, main, { action: "add", title: "Concern", severity: "normal", source: "Review", target: "S01" }));
    const before = await managedBytes(repo);
    for (const body of headingEscapes) {
      const receipt = refused(await todo(repo, main, { action: "update", id: "T001", body }), "structure");
      expect(receipt.hints.join("\n")).toContain("fenced");
      expect(await managedBytes(repo)).toEqual(before);
    }
    success(await todo(repo, main, { action: "resolve", id: "T001", reference: "Verified" }));
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
    success(await closeRound(repo, main, { expected: await reviewedRound(repo), dispositions: [] }));
    const closed = await managedBytes(repo);
    for (const field of ["goal", "constraints"] as const) {
      for (const body of headingEscapes) {
        const receipt = await openRound(repo, main, {
          round: { ...charter, [field]: field === "goal" ? body : [body] },
          import_todos: [],
        });
        const rejection = refused(receipt, field === "goal" ? "structure" : "single-line");
        expect(rejection.hints.join("\n")).toContain("fenced");
        expect(await managedBytes(repo)).toEqual(closed);
      }
    }
    const example = "A documented example.\n\n~~~~markdown\nEvidence\n--------\n```lang`invalid\n## Example\n~~~~";
    success(await openRound(repo, main, { round: { ...charter, goal: example }, import_todos: [] }));
    success(
      await todo(repo, main, { action: "add", title: "Example", severity: "normal", source: "Review", trigger: "Later", body: example }),
    );
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("close rejects multiline evidence and disposition fields with repair hints before changing files", async () => {
    const repo = await initialized();
    success(await todo(repo, main, { action: "add", title: "Pending concern", severity: "normal", source: "Review", target: "S01" }));
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const before = await managedBytes(repo);
    const injected = "Verified.\n\n### Evidence\nFalse extra evidence.";
    const close: StageOperationInput = {
      ...evidence(),
      todos: [{ id: "T001", disposition: "resolved", reference: "Verified follow-up" }],
    };
    const candidates: StageOperationInput[] = [
      ...(["method", "summary", "commit"] as const).map((field) => ({
        ...close,
        evidence: close.evidence?.map((item) => ({ ...item, [field]: injected })),
      })),
      { ...close, todos: [{ id: "T001", disposition: "resolved", reference: injected }] },
      { ...close, todos: [{ id: "T001", disposition: "moved", target: `trigger: ${injected}` }] },
    ];
    for (const input of candidates) {
      const receipt = refused(await stage(repo, main, input), "single-line");
      expect(receipt.hints.join("\n")).toContain("fenced");
      expect(await managedBytes(repo)).toEqual(before);
    }
  });

  test("close preserves fully fenced Outcome examples and exactly one of each fixed subsection", async () => {
    const headings = "### Delivered\n### Deviations\n### Evidence\n### TODO\n### ADRs\n### Open TODOs\n## Risks\n# Example stage";
    for (const example of [
      `\`\`\`md\n${headings}\n\`\`\``,
      `~~~~md\n${headings}\n~~~~`,
      `\`\`\`\`md\n${headings}\n\`\`\`\n\`\`\`\``,
      `   ~~~~md\r\n${headings.replaceAll("\n", "\r\n")}\r\n   ~~~~~`,
      `~~~~markdown\n${headings}\nEvidence\n--------\n\`\`\`lang\`invalid\n~~~\n~~~~`,
      "~~~markdown\nEvidence\n========\n## Example\n~~~",
      "Implementation.\n\n- List item\n- Another item",
    ]) {
      const repo = await initialized();
      success(await stage(repo, main, { action: "start", id: "S01" }));
      success(
        await stage(repo, main, {
          ...evidence(),
          delivered: `Delivered implementation.\n\n${example}\n\nDelivery details stay within Delivered.`,
          deviations: `Documented example:\n\n${example}`,
        }),
      );
      const model = await loadAll(repo);
      const closed = model.stages[0];
      if (!closed) throw new Error("Missing closed stage");
      const parsed = parseStage(await readFile(closed.path, "utf8"), closed.path);
      expect(parsed.status).toBe("closed");
      expect(parsed.outcome).toContain(example.replaceAll("\r\n", "\n"));
      expect(markdownHeadings(parsed.outcome as string, /^### .+$/gm).map((match) => match[0])).toEqual([
        "### Delivered",
        "### Deviations",
        "### Evidence",
        "### TODO",
        "### ADRs",
      ]);
      expect(await check(model)).toEqual([]);
    }
  });

  test("drop reasons cannot inject another Outcome subsection", async () => {
    const repo = await initialized();
    const before = await managedBytes(repo);
    const receipt = refused(
      await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred.\n\n### Evidence\nFalse completion claim." }),
      "heading",
    );
    expect(receipt.hints.join("\n")).toContain("fenced");
    expect(await managedBytes(repo)).toEqual(before);
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred.\n\n```md\n### Evidence\nExample only.\n```" }));
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("project descriptions and round goals obey the shared fixed-section boundary validation", async () => {
    for (const field of ["description", "goal"] as const) {
      const repo = await emptyRepo();
      const before = await readdir(repo.repoRoot);
      for (const body of ["Authored text.\n\n# Injected title", "Authored text.\n\n   ## Injected section", "```md\nUnfinished example."]) {
        const input: InitInput = {
          ...initInput,
          project: { ...initInput.project, ...(field === "description" ? { description: body } : {}) },
          round: { ...initInput.round, ...(field === "goal" ? { goal: body } : {}) },
        };
        const receipt = refused(await prepareInit(repo, main, input), body.startsWith("```") ? "fence" : "heading");
        expect(receipt.hints.join("\n")).toContain("fenced");
        expect(await readdir(repo.repoRoot)).toEqual(before);
      }
      const example = "Authored text.\n\n~~~md\n# Example title\n## Example section\n~~~";
      success(
        await initProject(repo, main, {
          ...initInput,
          project: { ...initInput.project, description: example },
          round: { ...initInput.round, goal: example },
        }),
      );
      expect(await check(await loadAll(repo))).toEqual([]);
    }
  });

  test("round disposition notes cannot split generated limitation entries", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
    success(await todo(repo, main, { action: "add", title: "Known limitation", severity: "low", source: "Review", trigger: "Later" }));
    const expected = await reviewedRound(repo);
    const before = await managedBytes(repo);
    for (const reference of ["Documented.\n\n### T999 — False limitation", "```md\nUnfinished example."]) {
      const receipt = refused(
        await closeRound(repo, main, { expected, dispositions: [{ id: "T001", disposition: "wontfix", reference }] }),
        reference.startsWith("```") ? "fence" : "heading",
      );
      expect(receipt.hints.join("\n")).toContain("fenced");
      expect(await managedBytes(repo)).toEqual(before);
    }
  });

  test("stage body edits cannot replace an optional section while preserving the fixed heading sequence", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "edit", id: "S01", risks: "```md\nOriginal risk example.\n```" }));
    const before = await managedBytes(repo);
    const refusal = refused(
      await stage(repo, main, {
        action: "edit",
        id: "S01",
        design_constraints: "Use ADR-0001.\n\n## Risks\n\nInjected risk section.\n\n```\n",
      }),
      "structure",
    );
    expect(refusal.hints.length).toBeGreaterThan(0);
    expect(await managedBytes(repo)).toEqual(before);
    refused(await stage(repo, main, { action: "edit", id: "S01", objective: "Objective.\n\n# S99 — Injected stage" }), "heading");
    refused(
      await stage(repo, main, {
        action: "edit",
        id: "S01",
        done_criteria: [{ statement: "Original\n- DC9 — Injected criterion", verify: "Check" }],
      }),
      "single-line",
    );
    expect(await managedBytes(repo)).toEqual(before);
    success(await stage(repo, main, { action: "edit", id: "S01", objective: "Objective.\n\n```md\n# S99 — Example\n## Risks\n```" }));
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("ADR create, revise and supersede cannot inject a different MADR section through body text", async () => {
    const repo = await initialized();
    const injected = {
      context: sections.context,
      options: sections.options,
      outcome: "Use the host.\n\n## More Information\n\nInjected history.",
    };
    const before = await managedBytes(repo);
    refused(await adr(repo, main, { action: "create", title: "Injected sections", status: "accepted", sections: injected }), "heading");
    refused(await adr(repo, main, { action: "supersede", id: "ADR-0001", title: "Injected successor", sections: injected }), "heading");
    const openFence = refused(
      await adr(repo, main, {
        action: "create",
        title: "Unfinished ADR example",
        status: "accepted",
        sections: { context: sections.context, options: sections.options, outcome: "Use the host.\n\n```md\nUnfinished example." },
      }),
      "fence",
    );
    expect(openFence.hints.join("\n")).toContain("close");
    expect(await managedBytes(repo)).toEqual(before);
    success(await adr(repo, main, { action: "create", title: "Proposed sections", stage: "S01", sections }));
    const proposed = (await loadAll(repo)).adrs.find((item) => item.status === "proposed");
    const beforeRevision = await managedBytes(repo);
    refused(await adr(repo, main, { action: "revise", id: proposed?.id, sections: injected }), "heading");
    expect(await managedBytes(repo)).toEqual(beforeRevision);
    success(
      await adr(repo, main, {
        action: "revise",
        id: proposed?.id,
        sections: { ...sections, outcome: "Use the host.\n\n~~~md\n## More Information\n# S99 — Example\n~~~" },
      }),
    );
    expect((await loadAll(repo)).adrs.find((item) => item.id === proposed?.id)?.body).toContain("~~~md\n## More Information");
    expect((await check(await loadAll(repo))).filter((item) => item.severity === "error")).toEqual([]);
  });
});

describe("roadmap body allowlist boundaries", () => {
  test.each(literalMarkdownBodies)(
    "ordinary punctuation survives every authored field and lifecycle write: %s",
    async (body) => {
      const repo = await emptyRepo();
      const charterText: RoundInput = {
        ...charter,
        goal: body,
        constraints: [body],
        non_goals: [body],
        principles: [{ text: body, adrs: ["ADR-0001"] }],
      };
      const stageText: StageInput = {
        ...stageInput,
        objective: body,
        scope_in: [body],
        scope_out: [body],
        done_criteria: [{ id: "DC1", statement: body, verify: body }],
        design_constraints: body,
        risks: body,
      };
      const adrText = {
        context: body,
        drivers: body,
        options: [body],
        outcome: body,
        consequences: body,
        confirmation: body,
        pros_cons: body,
        more_info: body,
      };
      const date = new Date().toISOString().slice(0, 10);
      const amended = new Set<string>();
      const noted = new Set<string>();
      function headings(content: string): string[] {
        const result: string[] = [];
        type HtmlNode = { tag: string; children: HtmlNode[] };
        function visit(node: HtmlNode): void {
          if (["pre", "code", "script", "style", "textarea", "svg"].includes(node.tag)) return;
          if (/^h[1-6]$/.test(node.tag)) result.push(`${"#".repeat(Number(node.tag[1]))} ${proseText(node)}`);
          for (const child of node.children) visit(child);
        }
        visit(parseHtml(Bun.markdown.html(content.replace(/^---\n[\s\S]*?\n---\n/, ""))));
        return result;
      }
      async function wrote(receipt: Promise<Receipt>): Promise<Model> {
        success(await receipt);
        const model = await loadAll(repo);
        expect(model.parseErrors ?? []).toEqual([]);
        expect((await check(model)).filter((item) => item.severity === "error")).toEqual([]);
        const content = (path: string): string => {
          const bytes = model.files?.[path];
          if (bytes === undefined) throw new Error(`Missing managed file ${path}`);
          return Buffer.from(bytes).toString("utf8");
        };
        expect(headings(content(model.index.path))).toEqual(["# Shop", "## How this directory works", "## Rounds", "## Current status"]);
        if (!model.adrIndex) throw new Error("Missing ADR index");
        expect(headings(content(model.adrIndex.path))).toEqual(["# Architecture Decision Records", "## Decisions"]);
        for (const doc of model.rounds) {
          expect(headings(content(doc.path))).toEqual([
            `# ${doc.id} — ${doc.title}`,
            "## Goal",
            "## Constraints",
            "## Non-goals",
            "## Principles",
            "## Stages",
            "## Known limitations",
            ...(doc.known_limitations ? ["### T003 — Known limitation"] : []),
          ]);
        }
        for (const doc of model.stages) {
          expect(headings(content(doc.path))).toEqual([
            `# ${doc.id} — ${doc.title}`,
            "## Objective",
            "## Scope",
            "### In",
            "### Out",
            "## Done criteria",
            "## Design constraints",
            "## Risks",
            "## Amendments",
            ...(amended.has(doc.id) ? [`### ${date} — ${body}`] : []),
            "## Free-work log",
            ...(doc.outcome ? ["## Outcome", "### Delivered", "### Deviations"] : []),
            ...(doc.status === "closed" ? ["### Evidence", "### TODO", "### ADRs"] : []),
          ]);
        }
        for (const doc of model.todos) {
          expect(headings(content(doc.path))).toEqual([
            `# ${doc.round} — TODO`,
            "## Open",
            ...doc.items.filter((item) => item.status === "open").map((item) => `### ${item.id} — ${item.title}`),
            "## Closed in this round",
            ...doc.items.filter((item) => item.status !== "open").map((item) => `### ${item.id} — ${item.title}`),
          ]);
        }
        for (const doc of model.adrs) {
          expect(headings(content(doc.path))).toEqual([
            `# ${doc.title}`,
            "## Context and Problem Statement",
            "## Decision Drivers",
            "## Considered Options",
            "## Decision Outcome",
            "### Consequences",
            "### Confirmation",
            "## Pros and Cons of the Options",
            "## More Information",
            ...(noted.has(doc.id) ? [`### ${date}`] : []),
          ]);
        }
        return model;
      }
      await wrote(
        initProject(repo, main, {
          project: { ...initInput.project, description: body },
          round: charterText,
          adrs: [
            { title: "Host choice", status: "accepted", sections: adrText, decision_makers: [body], consulted: [body], informed: [body] },
          ],
          stages: [stageText],
        }),
      );
      const edited = await wrote(stage(repo, main, { action: "edit", ...stageText, id: "S01" }));
      expect(edited.stages[0]).toMatchObject({
        objective: body,
        scope_in: `- ${body}`,
        scope_out: `- ${body}`,
        design_constraints: body,
        risks: body,
      });
      await wrote(stage(repo, main, { action: "add", ...stageText, title: "Deferred" }));
      await wrote(stage(repo, main, { action: "drop", id: "S02", reason: body }));
      await wrote(recordFreeWork(repo, main, { stage: "S01", intent: body }));
      await wrote(todo(repo, main, { action: "add", title: "Resolved", severity: "normal", source: body, trigger: body, body }));
      await wrote(todo(repo, main, { action: "update", id: "T001", source: body, trigger: body, body }));
      await wrote(todo(repo, main, { action: "move", id: "T001", trigger: body }));
      const resolved = await wrote(todo(repo, main, { action: "resolve", id: "T001", reference: body }));
      expect(resolved.todos[0]?.items[0]).toMatchObject({ source: body, trigger: body, body, reference: body });
      await wrote(todo(repo, main, { action: "add", title: "Close disposition", severity: "normal", source: body, target: "S01", body }));
      await wrote(todo(repo, main, { action: "add", title: "Known limitation", severity: "low", source: body, trigger: body, body }));
      await wrote(adr(repo, main, { action: "create", title: "Pending choice", stage: "S01", sections: adrText }));
      await wrote(adr(repo, main, { action: "revise", id: "ADR-0002", sections: adrText }));
      noted.add("ADR-0001");
      await wrote(adr(repo, main, { action: "note", id: "ADR-0001", text: body }));
      await wrote(adr(repo, main, { action: "supersede", id: "ADR-0001", title: "Successor choice", sections: adrText }));
      await wrote(stage(repo, main, { action: "start", id: "S01" }));
      amended.add("S01");
      await wrote(
        stage(repo, main, {
          action: "amend",
          id: "S01",
          reason: body,
          amendments: {
            modify: [{ id: "DC1", statement: body, verify: body }],
            add: [{ statement: body, verify: body }],
            scope: [{ op: "add", side: "in", item: `Additional ${body}` }],
          },
        }),
      );
      const closed = await wrote(
        stage(repo, main, {
          action: "close",
          id: "S01",
          delivered: body,
          deviations: body,
          evidence: ["DC1", "DC2"].map((criterion) => ({ criterion, result: "pass", method: body, summary: body, commit: body })),
          todos: [{ id: "T002", disposition: "resolved", reference: body }],
          adrs: [{ id: "ADR-0002", status: "accepted" }],
        }),
      );
      expect(closed.stages[0]?.outcome).toContain(`### Delivered\n\n${body}\n\n### Deviations\n\n${body}`);
      expect(closed.todos[0]?.items.find((item) => item.id === "T002")?.reference).toBe(body);
      await wrote(
        closeRound(repo, main, {
          expected: await reviewedRound(repo),
          dispositions: [{ id: "T003", disposition: "wontfix", reference: body }],
        }),
      );
      const opened = await wrote(openRound(repo, main, { round: charterText, import_todos: [] }));
      expect(opened.rounds.find((doc) => doc.id === "R2")).toMatchObject({ goal: body, constraints: `- ${body}`, non_goals: `- ${body}` });
    },
    120_000,
  );

  test("unsupported bodies refuse delivery, deviations, objective, TODO and every ADR section without changing managed bytes", async () => {
    const repo = await initialized();
    success(await todo(repo, main, { action: "add", title: "Pending", severity: "normal", source: "Review", target: "S01" }));
    success(await adr(repo, main, { action: "create", title: "Pending choice", stage: "S01", sections }));
    const planned = await managedBytes(repo);
    for (const body of rejectedMarkdownBodies) {
      const peer = body.replace("### Evidence", "## Evidence");
      refused(await stage(repo, main, { action: "edit", id: "S01", objective: peer }), "structure");
      expect(await managedBytes(repo)).toEqual(planned);
      for (const action of ["add", "update"] as const) {
        refused(
          await todo(repo, main, {
            action,
            id: "T001",
            title: "Injected",
            severity: "normal",
            source: "Review",
            trigger: "Later",
            body,
          }),
          "structure",
        );
        expect(await managedBytes(repo)).toEqual(planned);
      }
      for (const field of ["context", "drivers", "outcome", "consequences", "confirmation", "pros_cons", "more_info"] as const) {
        for (const input of [
          { action: "create", title: "Injected", status: "accepted" },
          { action: "revise", id: "ADR-0002" },
          { action: "supersede", id: "ADR-0001", title: "Injected" },
        ] as const) {
          refused(await adr(repo, main, { ...input, sections: { ...sections, [field]: peer } }), "structure");
          expect(await managedBytes(repo)).toEqual(planned);
        }
      }
      refused(await adr(repo, main, { action: "note", id: "ADR-0001", text: body }), "structure");
      expect(await managedBytes(repo)).toEqual(planned);
    }
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const active = await managedBytes(repo);
    const close: StageOperationInput = {
      ...evidence(),
      todos: [{ id: "T001", disposition: "resolved", reference: "Verified" }],
      adrs: [{ id: "ADR-0002", status: "accepted" }],
    };
    for (const body of rejectedMarkdownBodies) {
      for (const field of ["delivered", "deviations"] as const) {
        refused(await stage(repo, main, { ...close, [field]: body }), "structure");
        expect(await managedBytes(repo)).toEqual(active);
      }
    }
    const model = await loadAll(repo);
    expect(model.stages[0]?.status).toBe("active");
    expect(model.stages[0]?.closed_sha256).toBeNull();
    expect(model.todos[0]?.items[0]?.status).toBe("open");
    expect(model.adrs.find((doc) => doc.id === "ADR-0002")?.status).toBe("proposed");
    expect(await check(model)).toEqual([]);
  }, 120_000);

  test("round-open refuses list and HTML goal escapes without changing closed history", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
    success(await closeRound(repo, main, { expected: await reviewedRound(repo), dispositions: [] }));
    const before = await managedBytes(repo);
    for (const body of rejectedMarkdownBodies) {
      refused(
        await openRound(repo, main, { round: { ...charter, goal: body.replace("### Evidence", "## Evidence") }, import_todos: [] }),
        "structure",
      );
      expect(await managedBytes(repo)).toEqual(before);
    }
  });

  test("plain lists and top-level fences retain the same rendered and scanned headings after every write", async () => {
    const repo = await initialized();
    const examples = allowedMarkdownBodies.join("\n\n");
    async function intact(): Promise<void> {
      const model = await loadAll(repo);
      expect(await check(model)).toEqual([]);
      for (const content of Object.values(model.files ?? {})) {
        const body = Buffer.from(content)
          .toString("utf8")
          .replace(/^---\n[\s\S]*?\n---\n/, "");
        const scanned = markdownHeadings(body, /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/gm).map((heading) => [
          (heading[1] as string).length,
          (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim(),
        ]);
        const rendered = [...Bun.markdown.html(body).matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/g)].map((heading) => [
          Number(heading[1]),
          heading[2] ?? "",
        ]);
        expect(scanned).toEqual(rendered);
      }
    }
    success(await stage(repo, main, { action: "edit", id: "S01", objective: examples, design_constraints: examples, risks: examples }));
    await intact();
    success(
      await todo(repo, main, { action: "add", title: "Examples", severity: "normal", source: "Review", trigger: "Later", body: examples }),
    );
    await intact();
    success(await todo(repo, main, { action: "update", id: "T001", body: examples }));
    await intact();
    success(
      await adr(repo, main, {
        action: "create",
        title: "Examples",
        status: "accepted",
        sections: {
          ...sections,
          context: examples,
          drivers: examples,
          outcome: examples,
          consequences: examples,
          confirmation: examples,
          pros_cons: examples,
          more_info: examples,
        },
      }),
    );
    await intact();
    success(await adr(repo, main, { action: "note", id: "ADR-0001", text: examples }));
    await intact();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    success(await stage(repo, main, { ...evidence(), delivered: examples, deviations: examples }));
    await intact();
    success(
      await closeRound(repo, main, {
        expected: await reviewedRound(repo),
        dispositions: [{ id: "T001", disposition: "carried", reference: "Next round" }],
      }),
    );
    success(await openRound(repo, main, { round: { ...charter, goal: examples }, import_todos: [] }));
    await intact();
  });

  test("stored-file check reports sections swallowed by list fences and HTML types 6 and 7", async () => {
    const { repo, model } = await diskFixture();
    const current = model.stages[0];
    const round = model.rounds[0];
    const todos = model.todos[0];
    const decision = model.adrs[0];
    if (!current || !round || !todos || !decision) throw new Error("Missing fixtures");
    for (const { body } of [...markdownStructureEscapes, ...ambiguousMarkdownBodies]) {
      const peer = body.replace("### Evidence", "## Evidence");
      for (const [path, content] of [
        [current.path, renderStage({ ...current, objective: peer })],
        [
          current.path,
          renderStage({ ...current, outcome: `### Delivered\n\n${body}\n\n### Deviations\n\nNone.\n\n### Evidence\n\nReal evidence.` }),
        ],
        [round.path, renderRound({ ...round, goal: peer })],
        [todos.path, renderTodo({ ...todos, items: todos.items.map((item) => ({ ...item, body })) })],
        [
          decision.path,
          renderAdr({
            ...decision,
            body: decision.body.replace("## Context and Problem Statement\n", `## Context and Problem Statement\n\n${peer}\n\n`),
          }),
        ],
      ] as const) {
        const original = await readFile(path, "utf8");
        await writeFile(path, content);
        const diagnostics = await check(await loadAll(repo));
        expect(diagnostics.some((item) => item.rule === "structure" && item.severity === "error" && item.path === path)).toBe(true);
        await writeFile(path, original);
      }
    }
  }, 120_000);
});

describe("roadmap HTML body boundaries", () => {
  const htmlBlocks = [
    ["<!--", "-->"],
    ["<ScRiPt>", "</sCrIpT>"],
    ["<style>", "</style>"],
    ["<pre>", "</pre>"],
    ["<![CDATA[", "]]>"],
    ["<?probe", "?>"],
    ["<TeXtArEa>", "</TEXTAREA>"],
    ["<!DOCTYPE example", ">"],
  ] as const;

  async function rejectsHtml(repo: Repo, receipt: Receipt | PreparationReceipt, before: Record<string, string>): Promise<void> {
    const rejection = refused(receipt, "HTML");
    expect(rejection.hints.join("\n")).toContain("close");
    expect(await managedBytes(repo)).toEqual(before);
  }

  async function intact(repo: Repo): Promise<Model> {
    const model = await loadAll(repo);
    expect(model.parseErrors ?? []).toEqual([]);
    expect(await check(model)).toEqual([]);
    for (const round of model.rounds) {
      const body = (await readFile(round.path, "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
      expect(markdownHeadings(body, /^## .+$/gm).map((heading) => heading[0])).toEqual([
        "## Goal",
        "## Constraints",
        "## Non-goals",
        "## Principles",
        "## Stages",
        "## Known limitations",
      ]);
    }
    for (const doc of model.stages) {
      const body = (await readFile(doc.path, "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
      expect(markdownHeadings(body, /^## .+$|^### (?:In|Out)$/gm).map((heading) => heading[0])).toEqual([
        "## Objective",
        "## Scope",
        "### In",
        "### Out",
        "## Done criteria",
        ...(doc.design_constraints === undefined ? [] : ["## Design constraints"]),
        ...(doc.risks === undefined ? [] : ["## Risks"]),
        "## Amendments",
        "## Free-work log",
        ...(doc.outcome === undefined ? [] : ["## Outcome"]),
      ]);
    }
    for (const doc of model.todos) {
      const body = (await readFile(doc.path, "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
      expect(markdownHeadings(body, /^## .+$/gm).map((heading) => heading[0])).toEqual(["## Open", "## Closed in this round"]);
    }
    for (const doc of model.adrs) {
      const headings = markdownHeadings(doc.body, /^## .+$/gm).map((heading) => heading[0]);
      for (const heading of ["## Context and Problem Statement", "## Considered Options", "## Decision Outcome"])
        expect(headings.filter((value) => value === heading)).toHaveLength(1);
    }
    return model;
  }

  test("stage objective, optional bodies, scope and criterion text refuse unclosed HTML without changing managed bytes", async () => {
    const repo = await initialized();
    const before = await managedBytes(repo);
    for (const [opener] of htmlBlocks) {
      const body = `Authored text.\n\n${opener}`;
      const candidates: StageOperationInput[] = [
        ...(["objective", "design_constraints", "risks"] as const).map((field) => ({ action: "edit" as const, id: "S01", [field]: body })),
        ...(["scope_in", "scope_out"] as const).map((field) => ({ action: "edit" as const, id: "S01", [field]: [opener] })),
        ...(["statement", "verify"] as const).map((field) => ({
          action: "edit" as const,
          id: "S01",
          done_criteria: [{ statement: "Works", verify: "Check", [field]: opener }],
        })),
        { action: "add", ...stageInput, objective: body },
      ];
      for (const input of candidates) await rejectsHtml(repo, await stage(repo, main, input), before);
    }
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("delivery and deviations refuse all six reported HTML escapes before freezing or writing dispositions", async () => {
    const repo = await initialized();
    success(await todo(repo, main, { action: "add", title: "Pending", severity: "normal", source: "Review", target: "S01" }));
    success(await adr(repo, main, { action: "create", title: "Pending choice", stage: "S01", sections }));
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const before = await managedBytes(repo);
    const close: StageOperationInput = {
      ...evidence(),
      todos: [{ id: "T001", disposition: "resolved", reference: "Verified" }],
      adrs: [{ id: "ADR-0002", status: "accepted" }],
    };
    for (const [opener] of htmlBlocks) {
      for (const field of ["delivered", "deviations"] as const)
        await rejectsHtml(repo, await stage(repo, main, { ...close, [field]: `Delivered.\n\n${opener}` }), before);
    }
    const model = await intact(repo);
    expect(model.stages[0]?.status).toBe("active");
    expect(model.stages[0]?.closed_sha256).toBeNull();
    expect(model.todos[0]?.items[0]?.status).toBe("open");
    expect(model.adrs.find((doc) => doc.id === "ADR-0002")?.status).toBe("proposed");
  });

  test("TODO add and update cannot hide the next item or the closed section inside open HTML", async () => {
    const repo = await initialized();
    for (const title of ["First concern", "Second concern"])
      success(await todo(repo, main, { action: "add", title, severity: "normal", source: "Review", trigger: "Later" }));
    const before = await managedBytes(repo);
    for (const [opener] of htmlBlocks) {
      const body = `Body.\n\n${opener}`;
      await rejectsHtml(repo, await todo(repo, main, { action: "update", id: "T001", body }), before);
      await rejectsHtml(
        repo,
        await todo(repo, main, {
          action: "add",
          title: "Unfinished example",
          severity: "normal",
          source: "Review",
          trigger: "Later",
          body,
        }),
        before,
      );
    }
    expect((await intact(repo)).todos[0]?.items.map((item) => item.id)).toEqual(["T001", "T002"]);
  });

  test("all ADR sections and options reject open HTML before create, revise or supersede writes", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    success(await adr(repo, main, { action: "create", title: "Proposed choice", stage: "S01", sections }));
    const before = await managedBytes(repo);
    for (const [opener] of htmlBlocks) {
      for (const field of ["context", "drivers", "options", "outcome", "consequences", "confirmation", "pros_cons", "more_info"] as const) {
        const candidate = { ...sections, [field]: field === "options" ? [opener] : `Authored text.\n\n${opener}` };
        for (const input of [
          { action: "create", title: "Unfinished choice", status: "accepted" },
          { action: "revise", id: "ADR-0002" },
          { action: "supersede", id: "ADR-0001", title: "Unfinished successor" },
        ] as const)
          await rejectsHtml(repo, await adr(repo, main, { ...input, sections: candidate }), before);
      }
    }
    expect((await intact(repo)).adrs.map((doc) => [doc.id, doc.status])).toEqual([
      ["ADR-0001", "accepted"],
      ["ADR-0002", "proposed"],
    ]);
  });

  test("ADR notes refuse new unclosed HTML and report an existing unclosed accepted body without rewriting it", async () => {
    const repo = await initialized();
    const before = await managedBytes(repo);
    const current = (await loadAll(repo)).adrs[0];
    if (!current) throw new Error("Missing ADR");
    const original = await readFile(current.path, "utf8");
    for (const [opener] of htmlBlocks) {
      await rejectsHtml(repo, await adr(repo, main, { action: "note", id: current.id, text: `Note.\n\n${opener}` }), before);
      const broken = `${original}\n${opener}\n`;
      await writeFile(current.path, broken);
      const receipt = refused(await adr(repo, main, { action: "note", id: current.id, text: "A visible dated note." }), "HTML");
      expect(receipt.hints.join("\n")).toContain("close");
      expect(await readFile(current.path, "utf8")).toBe(broken);
      expect((await check(await loadAll(repo))).some((issue) => issue.path === current.path && issue.rule === "structure")).toBe(true);
      await writeFile(current.path, original);
    }
    await intact(repo);
  });

  test("initialization and round reopening refuse unclosed goal, constraint, non-goal and principle inputs", async () => {
    const empty = await emptyRepo();
    const entries = await readdir(empty.repoRoot);
    const repo = await initialized();
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
    success(await closeRound(repo, main, { expected: await reviewedRound(repo), dispositions: [] }));
    const before = await managedBytes(repo);
    for (const [opener] of htmlBlocks) {
      for (const field of ["goal", "constraints", "non_goals", "principles"] as const) {
        const round: RoundInput = {
          ...charter,
          [field]: field === "goal" ? `Goal.\n\n${opener}` : field === "principles" ? [{ text: opener, adrs: ["ADR-0001"] }] : [opener],
        };
        const receipt = refused(await prepareInit(empty, main, { ...initInput, round }), "HTML");
        expect(receipt.hints.join("\n")).toContain("close");
        expect(await readdir(empty.repoRoot)).toEqual(entries);
        await rejectsHtml(repo, await prepareRoundOpen(repo, main, { round, import_todos: [] }), before);
      }
      const receipt = refused(
        await prepareInit(empty, main, {
          ...initInput,
          project: { ...initInput.project, description: `Description.\n\n${opener}` },
        }),
        "HTML",
      );
      expect(receipt.hints.join("\n")).toContain("close");
      expect(await readdir(empty.repoRoot)).toEqual(entries);
    }
    await intact(repo);
  });

  test("drop and amendment bodies refuse unclosed HTML through reasons, scope and criterion changes", async () => {
    const repo = await initialized();
    let before = await managedBytes(repo);
    for (const [opener] of htmlBlocks)
      await rejectsHtml(repo, await stage(repo, main, { action: "drop", id: "S01", reason: `Deferred.\n\n${opener}` }), before);
    success(await stage(repo, main, { action: "start", id: "S01" }));
    before = await managedBytes(repo);
    for (const [opener] of htmlBlocks) {
      const inputs: StageOperationInput[] = [
        { action: "amend", id: "S01", reason: opener, amendments: { remove: ["DC2"] } },
        { action: "amend", id: "S01", reason: "Reviewed", amendments: { scope: [{ op: "add", side: "in", item: opener }] } },
        ...(["statement", "verify"] as const).flatMap((field): StageOperationInput[] => [
          {
            action: "amend",
            id: "S01",
            reason: "Reviewed",
            amendments: { add: [{ statement: "Works", verify: "Check", [field]: opener }] },
          },
          {
            action: "amend",
            id: "S01",
            reason: "Reviewed",
            amendments: { modify: [{ id: "DC1", statement: "Works", verify: "Check", [field]: opener }] },
          },
        ]),
      ];
      for (const input of inputs) await rejectsHtml(repo, await stage(repo, main, input), before);
    }
    await intact(repo);
  });

  test("limitation references cannot hide subsequent limitations or freeze the round with open HTML", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
    for (const title of ["First limitation", "Second limitation"])
      success(await todo(repo, main, { action: "add", title, severity: "low", source: "Review", trigger: "Later" }));
    const expected = await reviewedRound(repo);
    const before = await managedBytes(repo);
    for (const [opener] of htmlBlocks) {
      await rejectsHtml(
        repo,
        await closeRound(repo, main, {
          expected,
          dispositions: [
            { id: "T001", disposition: "wontfix", reference: `Documented.\n\n${opener}` },
            { id: "T002", disposition: "wontfix", reference: "Later work" },
          ],
        }),
        before,
      );
    }
    expect((await intact(repo)).rounds[0]?.status).toBe("active");
  });

  test("stored-file check reports HTML-hidden headings and refuses automatic repair of authored bytes", async () => {
    const repo = await initialized();
    success(await todo(repo, main, { action: "add", title: "First", severity: "normal", source: "Review", trigger: "Later" }));
    success(await todo(repo, main, { action: "add", title: "Second", severity: "normal", source: "Review", trigger: "Later" }));
    const model = await loadAll(repo);
    const documents = [
      [model.stages[0]?.path, "## Objective"],
      [model.rounds[0]?.path, "## Goal"],
      [model.todos[0]?.path, "### T001 — First"],
      [model.adrs[0]?.path, "## Context and Problem Statement"],
    ];
    for (const [path, heading] of documents) {
      if (!path || !heading) throw new Error("Missing document");
      const original = await readFile(path, "utf8");
      for (const [opener] of htmlBlocks) {
        const broken = original.replace(`${heading}\n`, `${heading}\nAuthored text.\n\n${opener}\n`);
        await writeFile(path, broken);
        for (const fix of [false, true]) {
          const diagnostics = await check(await loadAll(repo), { fix });
          expect(diagnostics.some((issue) => issue.path === path && issue.rule === "structure" && !issue.fixable)).toBe(true);
          expect(await readFile(path, "utf8")).toBe(broken);
        }
        await writeFile(path, original);
      }
    }
    await intact(repo);
  });

  test("HTML literals inside top-level fences and same-line spans preserve headings, later items and dated notes", async () => {
    for (const [opener, closer] of htmlBlocks) {
      const repo = await initialized();
      const example = `~~~markdown\n${opener}\n## Example section\n### Evidence\n### T999 — Example\n${closer}\n~~~`;
      const inline = `Literal \`${opener} example ${closer}\``;
      const prose = "Inline `<span>example</span>` and `<!-- closed comment -->`.";
      success(
        await stage(repo, main, {
          action: "edit",
          id: "S01",
          objective: example,
          design_constraints: example,
          risks: example,
          scope_in: [inline],
          scope_out: [prose],
          done_criteria: stageInput.done_criteria.map((criterion) => ({ ...criterion, statement: inline, verify: prose })),
        }),
      );
      await intact(repo);
      for (const title of ["First", "Second"]) {
        success(await todo(repo, main, { action: "add", title, severity: "normal", source: "Review", trigger: "Later", body: example }));
        await intact(repo);
      }
      success(await todo(repo, main, { action: "update", id: "T001", body: `${example}\n\n${prose}` }));
      expect((await intact(repo)).todos[0]?.items.map((item) => item.id)).toEqual(["T001", "T002"]);
      success(
        await adr(repo, main, {
          action: "create",
          title: "HTML examples",
          status: "accepted",
          sections: {
            context: example,
            drivers: example,
            options: [inline, prose],
            outcome: example,
            consequences: example,
            confirmation: example,
            pros_cons: example,
            more_info: example,
          },
        }),
      );
      await intact(repo);
      for (const text of [example, prose]) {
        success(await adr(repo, main, { action: "note", id: "ADR-0002", text }));
        await intact(repo);
      }
      const decision = (await loadAll(repo)).adrs.find((doc) => doc.id === "ADR-0002");
      expect(markdownHeadings(decision?.body as string, /^### \d{4}-\d{2}-\d{2}$/gm)).toHaveLength(2);
      success(await stage(repo, main, { action: "start", id: "S01" }));
      await intact(repo);
      success(await stage(repo, main, { ...evidence(), delivered: example, deviations: `${example}\n\n${prose}` }));
      const closed = (await intact(repo)).stages[0];
      expect(closed?.outcome).toContain(example);
      expect(markdownHeadings(closed?.outcome as string, /^### .+$/gm).map((heading) => heading[0])).toEqual([
        "### Delivered",
        "### Deviations",
        "### Evidence",
        "### TODO",
        "### ADRs",
      ]);
      expect(Bun.markdown.html(closed?.outcome as string).match(/<h3>[^<]+<\/h3>/g)).toEqual([
        "<h3>Delivered</h3>",
        "<h3>Deviations</h3>",
        "<h3>Evidence</h3>",
        "<h3>TODO</h3>",
        "<h3>ADRs</h3>",
      ]);
      success(
        await closeRound(repo, main, {
          expected: await reviewedRound(repo),
          dispositions: [
            { id: "T001", disposition: "wontfix", reference: inline },
            { id: "T002", disposition: "wontfix", reference: prose },
          ],
        }),
      );
      const frozen = await intact(repo);
      expect(markdownHeadings(frozen.rounds[0]?.known_limitations as string, /^### T\d+ .+$/gm)).toHaveLength(2);
      success(
        await openRound(repo, main, {
          round: {
            ...charter,
            goal: example,
            constraints: [inline],
            non_goals: [prose],
            principles: [{ text: inline, adrs: ["ADR-0001"] }],
          },
          import_todos: [],
        }),
      );
      expect((await intact(repo)).rounds.find((round) => round.id === "R2")?.goal).toBe(example);
    }
  });
});

describe("roadmap ADR operations", () => {
  test("dated notes ignore fenced More Information examples and stay in the real section", async () => {
    const repo = await initialized();
    for (const fence of ["~~~", "```"]) {
      for (const more_info of [undefined, "Existing decision history."]) {
        const context = `A documented example:\n\n${fence}md\n## More Information\n${fence}`;
        success(
          await adr(repo, main, {
            action: "create",
            title: `Fenced ${fence === "~~~" ? "tilde" : "backtick"} example ${Boolean(more_info)}`,
            status: "accepted",
            sections: { ...sections, context, more_info },
          }),
        );
        const created = (await loadAll(repo)).adrs.at(-1);
        if (!created) throw new Error("Missing created ADR");
        const note = "The accepted decision was exercised in production.";
        success(await adr(repo, main, { action: "note", id: created.id, text: note }));
        const parsed = parseAdr(await readFile(created.path, "utf8"), created.path);
        const headings = markdownHeadings(parsed.body, /^## .+$/gm);
        const information = headings.filter((heading) => heading[0] === "## More Information");
        expect(information).toHaveLength(1);
        const start = information[0]?.index as number;
        expect(headings.at(-1)?.[0]).toBe("## More Information");
        expect(parsed.body.slice(0, start)).toContain(context);
        expect(parsed.body.slice(0, start)).not.toContain(note);
        expect(parsed.body.slice(start)).toContain(`### ${new Date().toISOString().slice(0, 10)}\n\n${note}`);
        if (more_info) expect(parsed.body.slice(start)).toContain(more_info);
        expect(parsed.status).toBe("accepted");
        expect(await check(await loadAll(repo))).toEqual([]);
      }
    }
  });

  test("dated notes refuse existing ADRs ending inside an open fence without rewriting accepted bodies", async () => {
    const repo = await initialized();
    for (const fence of ["```", "````", "   ~~~~"]) {
      for (const moreInfo of [false, true]) {
        const document = (await loadAll(repo)).adrs[0];
        if (!document) throw new Error("Missing accepted ADR");
        document.body =
          "# Host choice\n\n## Context and Problem Statement\nProblem.\n\n## Considered Options\n* Use the host\n\n" +
          `## Decision Outcome\nKeep the accepted decision.\n\n${moreInfo ? "## More Information\nExisting history.\n\n" : ""}` +
          `${fence}md\nAn unfinished example.\n`;
        await writeFile(document.path, renderAdr(document));
        const before = await managedBytes(repo);
        const refusal = refused(await adr(repo, main, { action: "note", id: document.id, text: "A dated observation." }), "fence");
        expect(refusal.hints.join("\n")).toContain("close");
        expect(await managedBytes(repo)).toEqual(before);
        const closing = fence.trim();
        document.body += `${closing}\n\n`;
        await writeFile(document.path, renderAdr(document));
        success(await adr(repo, main, { action: "note", id: document.id, text: "A dated observation." }));
        const parsed = parseAdr(await readFile(document.path, "utf8"), document.path);
        const information = markdownHeadings(parsed.body, /^## More Information$/gm);
        expect(information).toHaveLength(1);
        expect(parsed.body.slice(information[0]?.index)).toContain(`### ${new Date().toISOString().slice(0, 10)}\n\nA dated observation.`);
        expect(markdownHeadings(parsed.body, /^### \d{4}-\d{2}-\d{2}$/gm)).toHaveLength(1);
        expect(parsed.status).toBe("accepted");
        expect(await check(await loadAll(repo))).toEqual([]);
      }
    }
  });

  test("dated note text must keep fences balanced and cannot inject MADR headings outside fenced examples", async () => {
    const repo = await initialized();
    const before = await managedBytes(repo);
    refused(await adr(repo, main, { action: "note", id: "ADR-0001", text: "Observation.\n\n```md\nUnfinished example." }), "fence");
    refused(
      await adr(repo, main, { action: "note", id: "ADR-0001", text: "Observation.\n\n### Consequences\nInjected section." }),
      "heading",
    );
    expect(await managedBytes(repo)).toEqual(before);
    const note = "Observed the host.\n\n```md\n## More Information\n### Consequences\n```";
    success(await adr(repo, main, { action: "note", id: "ADR-0001", text: note }));
    const model = await loadAll(repo);
    const body = model.adrs[0]?.body as string;
    const information = markdownHeadings(body, /^## More Information$/gm);
    expect(information).toHaveLength(1);
    expect(body.slice(information[0]?.index)).toContain(`### ${new Date().toISOString().slice(0, 10)}\n\n${note}`);
    expect(await check(model)).toEqual([]);
  });

  test("dated notes append real headings when an accepted ADR has no final newline", async () => {
    const repo = await initialized();
    const document = (await loadAll(repo)).adrs[0];
    if (!document) throw new Error("Missing accepted ADR");
    const original = document.body;
    for (const existingInformation of [false, true]) {
      document.body = `${original}${existingInformation ? "## More Information\n\nExisting history.\n\n" : ""}`.replace(/\n+$/, "");
      const prefix = document.body;
      await writeFile(document.path, renderAdr(document));
      success(await adr(repo, main, { action: "note", id: document.id, text: "Observed without a final newline." }));
      const parsed = parseAdr(await readFile(document.path, "utf8"), document.path);
      expect(parsed.body.startsWith(prefix)).toBe(true);
      const information = markdownHeadings(parsed.body, /^## More Information$/gm);
      expect(information).toHaveLength(1);
      expect(parsed.body.slice(information[0]?.index)).toContain(
        `### ${new Date().toISOString().slice(0, 10)}\n\nObserved without a final newline.`,
      );
      expect(markdownHeadings(parsed.body, /^### \d{4}-\d{2}-\d{2}$/gm)).toHaveLength(1);
      expect(await check(await loadAll(repo))).toEqual([]);
    }
  });

  test("subagent creates proposed, proposed revisions retain metadata, and main-only transitions preserve accepted bodies", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    const creation = success(
      await adr(repo, sub, {
        action: "create",
        title: "Proposed API",
        stage: "S01",
        status: "accepted",
        sections,
        decision_makers: ["Owner"],
      }),
    );
    expect(creation.warnings).toContain("Subagent ADRs are created as proposed.");
    const original = (await loadAll(repo)).adrs.find((item) => item.id === "ADR-0002");
    expect(original?.status).toBe("proposed");
    success(await adr(repo, sub, { action: "revise", id: "ADR-0002", sections: { ...sections, outcome: "Use the native API instead." } }));
    const revised = (await loadAll(repo)).adrs.find((item) => item.id === "ADR-0002");
    expect(revised?.date).toBe(original?.date);
    expect(revised?.stage).toBe("S01");
    expect(revised?.decision_makers).toEqual(["Owner"]);
    expect(revised?.body).toContain("Use the native API instead.");
    refused(await adr(repo, sub, { action: "set_status", id: "ADR-0002", status: "accepted" }), "main agent");
    refused(await adr(repo, sub, { action: "supersede", id: "ADR-0001", title: "Replacement", sections }), "main agent");
    success(await adr(repo, main, { action: "set_status", id: "ADR-0002", status: "accepted" }));
    refused(await adr(repo, main, { action: "revise", id: "ADR-0002", sections }), "Only proposed");
    const before = (await loadAll(repo)).adrs.find((item) => item.id === "ADR-0002")?.body as string;
    success(await adr(repo, sub, { action: "note", id: "ADR-0002", text: "Observed the API working in the host smoke." }));
    const noted = (await loadAll(repo)).adrs.find((item) => item.id === "ADR-0002")?.body as string;
    expect(noted.startsWith(before)).toBe(true);
    expect(noted).toContain(`## More Information\n\n### ${new Date().toISOString().slice(0, 10)}\n\nObserved`);
    success(await adr(repo, main, { action: "set_status", id: "ADR-0002", status: "deprecated" }));
    expect((await loadAll(repo)).adrs.find((item) => item.id === "ADR-0002")?.body).toBe(noted);
    success(
      await adr(repo, main, {
        action: "supersede",
        id: "ADR-0001",
        title: "Native host choice",
        sections: { ...sections, outcome: "Use the newer host API." },
      }),
    );
    const model = await loadAll(repo);
    const successor = model.adrs.find((item) => item.id === "ADR-0003");
    expect(model.adrs.find((item) => item.id === "ADR-0001")).toMatchObject({ status: "superseded", superseded_by: "ADR-0003" });
    expect(successor).toMatchObject({ status: "accepted", supersedes: ["ADR-0001"] });
    expect(await readFile(join(repo.adrDir, "README.md"), "utf8")).toContain("superseded by ADR-0003");
    const handoff = renderHandoff(model, model.stages[0] as NonNullable<Model["stages"][0]>);
    expect(handoff).toContain("ADR-0003 — Native host choice (accepted)");
    expect(handoff).toContain("Resolved from superseded ADR-0001");
    expect(handoff).toContain("Use the newer host API.");
    expect(handoff).not.toContain("### ADR-0001 —");
  });
});

describe("round freeze, import and recovery", () => {
  test("round close refuses changed contents, a closed reviewed round and a replacement round without writes", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
    const expected = await reviewedRound(repo);
    success(await todo(repo, main, { action: "add", title: "New concern", severity: "normal", source: "Review", trigger: "Later" }));
    const changed = await managedBytes(repo);
    const stale = refused(await closeRound(repo, main, { expected, dispositions: [] }), "stale");
    expect(stale.hints).toContain("Run /roadmap close-round again to review the current round and TODOs.");
    expect(await managedBytes(repo)).toEqual(changed);
    expect((await loadAll(repo)).rounds[0]?.status).toBe("active");
    const reviewed = await reviewedRound(repo);
    const other: Actor = { sessionId: "other-main", kind: "main" };
    success(await closeRound(repo, other, { expected: reviewed, dispositions: [{ id: "T001", disposition: "carried" }] }));
    const closed = await managedBytes(repo);
    refused(await closeRound(repo, main, { expected: reviewed, dispositions: [] }), "stale");
    expect(await managedBytes(repo)).toEqual(closed);
    success(await openRound(repo, other, { round: { ...charter, title: "Replacement" }, import_todos: [] }));
    const replacement = await managedBytes(repo);
    refused(await closeRound(repo, main, { expected: reviewed, dispositions: [] }), "stale");
    expect((await loadAll(repo)).rounds.map((round) => [round.id, round.status]).sort()).toEqual([
      ["R1", "closed"],
      ["R2", "active"],
    ]);
    expect(await managedBytes(repo)).toEqual(replacement);
    expect(await check(await loadAll(repo))).toEqual([]);
  });

  test("round close collects all disposition kinds, freezes all files, and the next round imports carried TODOs without modifying history", async () => {
    const repo = await initialized();
    refused(await closeRound(repo, main, { expected: await reviewedRound(repo), dispositions: [] }), "Every stage");
    refused(await openRound(repo, main, { round: charter, import_todos: [] }), "active round");
    for (const [index, title] of ["Resolved limitation", "Known limitation", "Carry forward"].entries()) {
      success(
        await todo(repo, main, {
          action: "add",
          title,
          source: "R1 interview",
          severity: "normal",
          trigger: `When condition ${index} holds`,
          body: `${title} detail.`,
        }),
      );
    }
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Launch deferred" }));
    refused(await closeRound(repo, sub, { expected: await reviewedRound(repo), dispositions: [] }), "main session");
    const before = await managedBytes(repo);
    refused(
      await closeRound(repo, main, {
        expected: await reviewedRound(repo),
        dispositions: [{ id: "T001", disposition: "resolved", reference: "commit abc1234" }],
      }),
      "Every open TODO",
    );
    expect(await managedBytes(repo)).toEqual(before);
    success(
      await closeRound(repo, main, {
        expected: await reviewedRound(repo),
        dispositions: [
          { id: "T001", disposition: "resolved", reference: "commit abc1234" },
          { id: "T002", disposition: "wontfix", reference: "Outside the product boundary" },
          { id: "T003", disposition: "carried" },
        ],
      }),
    );
    const closed = await loadAll(repo);
    const round = closed.rounds[0];
    if (!round) throw new Error("Missing round");
    expect(round.status).toBe("closed");
    expect(round.closed).toBe(new Date().toISOString().slice(0, 10));
    expect(round.frozen_sha256).toBe(roundSha256(roundFiles(closed, round)));
    expect(round.known_limitations).toContain("T002 — Known limitation");
    expect(round.known_limitations).toContain("Outside the product boundary");
    expect(round.known_limitations).toContain("Known limitation detail.");
    expect(closed.todos[0]?.items.map((item) => item.status)).toEqual(["resolved", "wontfix", "carried"]);
    expect(renderInjection(closed)).toBe("");
    expect((await check(closed)).filter((item) => item.severity === "error")).toEqual([]);
    const frozen = roundFiles(closed, round);
    const frozenText = Object.fromEntries(Object.entries(frozen).map(([path, content]) => [path, Buffer.from(content).toString("utf8")]));
    success(await adr(repo, main, { action: "create", title: "Between rounds", sections, status: "accepted" }));
    refused(await stage(repo, main, { action: "add", ...stageInput }), "active round");
    refused(
      await todo(repo, main, { action: "add", title: "No round", source: "free work", severity: "low", trigger: "Later" }),
      "active round",
    );
    refused(await openRound(repo, main, { round: charter, import_todos: ["T001"] }), "not a carried TODO");
    success(await openRound(repo, main, { round: { ...charter, title: "Follow-up" }, import_todos: ["T003"] }));
    const next = await loadAll(repo);
    expect(next.rounds.find((item) => item.status === "active")?.id).toBe("R2");
    const imported = next.todos.find((doc) => doc.round === "R2")?.items[0];
    expect(imported).toMatchObject({ id: "T004", status: "open", carried_from: "T003 (R1)", trigger: "When condition 2 holds" });
    expect(imported?.reference).toBeUndefined();
    const nextTodo = next.todos.find((doc) => doc.round === "R2");
    expect(await readFile(nextTodo?.path as string, "utf8")).toContain("- Carried from: T003 (R1)");
    for (const [path, content] of Object.entries(frozenText)) expect(await readFile(join(dirname(round.path), path), "utf8")).toBe(content);
    expect((await check(next)).filter((item) => item.severity === "error")).toEqual([]);
    await writeFile(round.path, (await readFile(round.path, "utf8")).replace("Launch deferred", "Hand edit"));
    const frozenStage = closed.stages[0];
    if (!frozenStage) throw new Error("Missing frozen stage");
    await writeFile(
      frozenStage.path,
      (await readFile(frozenStage.path, "utf8")).replace("Customers complete checkout", "Hand-edited objective"),
    );
    const diagnostics = await check(await loadAll(repo));
    expect(diagnostics.some((item) => item.rule === "frozen-round-hash")).toBe(true);
  });

  test("an interrupted multi-file stage close leaves stale indexes and check --fix repairs them", async () => {
    const repo = await initialized();
    success(await stage(repo, main, { action: "start", id: "S01" }));
    let completedWrites = 0;
    const receipt = await stage(repo, main, evidence(), {
      async writeFile(path, content) {
        if (completedWrites === 1) throw new Error("Injected second-file failure");
        await atomicWrite(path, content);
        completedWrites++;
      },
    });
    refused(receipt, "Injected second-file failure");
    expect(completedWrites).toBe(1);
    const partial = await loadAll(repo);
    expect(partial.stages[0]?.status).toBe("closed");
    const diagnostics = await check(partial);
    expect(diagnostics.some((item) => item.rule === "generated" && item.fixable)).toBe(true);
    expect(diagnostics.filter((item) => item.severity === "error").every((item) => item.rule === "generated")).toBe(true);
    expect((await check(partial, { fix: true })).filter((item) => item.severity === "error")).toEqual([]);
    expect((await readdir(dirname(partial.stages[0]?.path as string))).some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  test("confirmed previews write exact files and reject stale on-disk state without holding a lock across the dialog", async () => {
    const repo = await emptyRepo();
    const preview = await prepareInit(repo, main, initInput);
    if (!preview.ok) throw new Error(preview.reason);
    expect(await Bun.file(join(repo.roadmapDir, "README.md")).exists()).toBe(false);
    expect(preview.files.some((file) => file.content.includes(initInput.project.description))).toBe(true);
    success(await applyPrepared(repo, main, preview.prepared));
    for (const file of preview.files) expect(await readFile(file.path, "utf8")).toBe(file.content);
    expect(await loadRepo(repo.repoRoot)).not.toBeNull();
    refused(await applyPrepared(repo, main, preview.prepared), "Unknown preview");
    refused(await prepareInit(repo, main, initInput), "already exists");
    success(await stage(repo, main, { action: "drop", id: "S01", reason: "Prepare a later round" }));
    success(await closeRound(repo, main, { expected: await reviewedRound(repo), dispositions: [] }));
    const next = await prepareRoundOpen(repo, main, { round: { ...charter, title: "Next" }, import_todos: [] });
    if (!next.ok) throw new Error(next.reason);
    success(await adr(repo, main, { action: "note", id: "ADR-0001", text: "Changed while the preview was visible." }));
    refused(await applyPrepared(repo, main, next.prepared), "stale");
    expect((await loadAll(repo)).rounds).toHaveLength(1);

    const staleRepo = await emptyRepo();
    const stale = await prepareInit(staleRepo, main, initInput);
    if (!stale.ok) throw new Error(stale.reason);
    await mkdir(staleRepo.adrDir, { recursive: true });
    await writeFile(join(staleRepo.adrDir, "existing.md"), "User document");
    refused(await applyPrepared(staleRepo, main, stale.prepared), "stale");
    expect(await Bun.file(join(staleRepo.roadmapDir, "README.md")).exists()).toBe(false);
    refused(await prepareInit(staleRepo, main, initInput), "absent or empty");
  });

  test("git worktrees share global counters while their roadmap documents remain branch-local", async () => {
    const repo = await initialized();
    await git(repo.repoRoot, ["add", "docs/roadmap", "docs/adr"]);
    await git(repo.repoRoot, [
      "-c",
      "user.name=Roadmap test",
      "-c",
      "user.email=roadmap@example.invalid",
      "commit",
      "-qm",
      "Initial documents",
    ]);
    const worktreePath = join(repo.repoRoot, "worktree");
    await git(repo.repoRoot, ["worktree", "add", "-q", "-b", "isolated", worktreePath]);
    const worktree = await loadRepo(worktreePath);
    if (!worktree) throw new Error("Worktree marker was not discovered.");
    expect(worktree.commonDir).toBe(repo.commonDir);
    expect(worktree.repoRoot).not.toBe(repo.repoRoot);
    const receipts = await Promise.all([
      stage(repo, main, { action: "add", ...stageInput, title: "Main branch slice" }),
      stage(worktree, sub, { action: "add", ...stageInput, title: "Worktree branch slice" }),
    ]);
    for (const receipt of receipts) success(receipt);
    const mainModel = await loadAll(repo);
    const worktreeModel = await loadAll(worktree);
    const mainStage = mainModel.stages.find((item) => item.title === "Main branch slice");
    const worktreeStage = worktreeModel.stages.find((item) => item.title === "Worktree branch slice");
    expect(mainStage?.id).not.toBe(worktreeStage?.id);
    expect([mainStage?.id, worktreeStage?.id].sort()).toEqual(["S02", "S03"]);
    expect(mainModel.stages.some((item) => item.title === "Worktree branch slice")).toBe(false);
    expect(worktreeModel.stages.some((item) => item.title === "Main branch slice")).toBe(false);
  });
});

describe("handoff and bounded injection", () => {
  test("handoff includes Free-work log lines and the code-verification warning", async () => {
    const { repo } = await diskFixture();
    success(await recordFreeWork(repo, main, { stage: "S01", intent: "Investigate\nexisting implementation" }));
    const model = await loadAll(repo);
    const handoff = renderHandoff(model, model.stages[0] as NonNullable<Model["stages"][0]>);
    expect(handoff).toContain("verify code and record real evidence");
    expect(handoff).toContain("Verify in code what already exists");
    expect(handoff).toContain('session abc123 · "inspect code"');
    expect(handoff).toContain('session main-session · "Investigate existing implementation"');
    expect(handoff).toContain("T001 — Carry-over");
    expect(handoff).toContain("ADR-0001 — Choose the shared host (accepted)");
  });

  test("injection is at most forty lines, caps thirty stages at twelve and omits inactive rounds", () => {
    const model = modelFixture();
    model.stages = Array.from({ length: 30 }, (_, index) =>
      stageFixture({
        id: `S${String(index + 1).padStart(2, "0")}`,
        objective: `Objective ${index + 1}\n\n${"Long objective ".repeat(100)}`,
      }),
    );
    const text = renderInjection(model);
    expect(text.split("\n").length).toBeLessThanOrEqual(40);
    expect(text.match(/^- S\d+ /gm)).toHaveLength(12);
    expect(text).toContain("18 more, see roadmap_status");
    expect(text).toContain("call roadmap_overlap before starting");
    expect(text).toContain("Managed files change only through roadmap_* tools");
    expect(text.length).toBeLessThan(4_000);
    model.stages[0] = stageFixture({ status: "active" });
    expect(renderInjection(model, { stage: "S01" })).toContain("Bound stage: S01");
    model.stages[0] = stageFixture({ status: "closed" });
    expect(renderInjection(model, { stage: "S01" })).toContain("no longer active");
    const round = model.rounds[0];
    if (round) round.status = "closed";
    expect(renderInjection(model, { stage: "S01" })).toBe("");
  });

  test("a malformed dependency is rejected before any authored write", async () => {
    const repo = await initialized();
    const before = await managedBytes(repo);
    const receipt = await stage(repo, main, { action: "add", ...stageInput, depends_on: ["S99"] });
    refused(receipt, "dangling-reference");
    expect(await managedBytes(repo)).toEqual(before);
    const path = (await loadAll(repo)).stages[0]?.path as string;
    const parsed = parseStage(await readFile(path, "utf8"), path);
    await writeFile(path, renderStage({ ...parsed, depends_on: ["S01"] }));
    refused(await stage(repo, main, { action: "start", id: "S01" }), "dependency-cycle");
  });
});

async function rawManagedBytes(repo: Repo): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    try {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await walk(child);
        else files[child] = await readFile(child, "utf8");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  await walk(repo.roadmapDir);
  await walk(repo.adrDir);
  return files;
}

describe("cancellation after managed writing starts", () => {
  for (const boundary of ["committed", "temporary"] as const) {
    test.each(["stage start", "stage close", "round close", "init", "round open"] as const)(
      boundary === "committed"
        ? "%s stops after the first committed file and does not run its success callback"
        : "%s cancellation after a temporary write prevents every rename and success callback",
      async (operation) => {
        const repo = operation === "init" ? await emptyRepo() : await initialized();
        const controller = new AbortController();
        const attempted: string[] = [];
        const written: string[] = [];
        let callbacks = 0;
        const options = {
          signal: controller.signal,
          async writeFile(path: string, content: string, writeOptions?: { signal?: AbortSignal }) {
            attempted.push(path);
            if (boundary === "temporary") {
              Object.defineProperty(controller.signal, "aborted", {
                get() {
                  if (
                    !controller.signal.reason &&
                    existsSync(dirname(path)) &&
                    readdirSync(dirname(path)).some((name) => name.endsWith(".tmp"))
                  )
                    controller.abort();
                  return controller.signal.reason !== undefined;
                },
              });
            }
            await atomicWrite(path, content, writeOptions);
            written.push(path);
            if (written.length === 1) controller.abort();
          },
          onSuccess() {
            callbacks++;
          },
        };
        let run: () => Promise<Receipt>;
        if (operation === "stage start") run = () => stage(repo, main, { action: "start", id: "S01" }, options);
        else if (operation === "stage close") {
          success(await stage(repo, main, { action: "start", id: "S01" }));
          run = () => stage(repo, main, evidence(), options);
        } else if (operation === "round close") {
          success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
          const expected = await reviewedRound(repo);
          run = () => closeRound(repo, main, { expected, dispositions: [] }, options);
        } else {
          if (operation === "round open") {
            success(await stage(repo, main, { action: "drop", id: "S01", reason: "Deferred" }));
            success(await closeRound(repo, main, { expected: await reviewedRound(repo), dispositions: [] }));
          }
          const preview =
            operation === "init"
              ? await prepareInit(repo, main, initInput)
              : await prepareRoundOpen(repo, main, { round: { ...charter, title: "Next" }, import_todos: [] });
          if (!preview.ok) throw new Error(preview.reason);
          run = () => applyPrepared(repo, main, preview.prepared, options);
        }
        const before = await rawManagedBytes(repo);
        const receipt = refused(await run(), "cancelled");
        expect(controller.signal.aborted).toBe(true);
        expect(attempted).toHaveLength(1);
        expect(written).toHaveLength(boundary === "committed" ? 1 : 0);
        expect(callbacks).toBe(0);
        const after = await rawManagedBytes(repo);
        if (boundary === "committed") {
          const first = written[0] as string;
          expect(receipt.hints.join("\n")).toContain(first.slice(repo.repoRoot.length + 1));
          expect(receipt.hints.join("\n")).toContain("roadmap_check");
          expect(receipt.hints.join("\n")).toContain("fix: true");
          expect(after[first]).not.toBe(before[first]);
          for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (path !== first) expect(after[path]).toBe(before[path]);
          }
          if (operation === "stage start" || operation === "stage close") {
            const partial = await loadAll(repo);
            expect((await check(partial)).some((item) => item.rule === "generated" && item.fixable)).toBe(true);
            expect((await check(partial, { fix: true })).filter((item) => item.severity === "error")).toEqual([]);
          }
        } else expect(after).toEqual(before);
        expect(Object.keys(after).filter((path) => path.endsWith(".tmp"))).toEqual([]);
      },
    );
  }

  test("cancellation while creating the parent directory prevents the temporary write", async () => {
    const repo = await emptyRepo();
    const path = join(repo.roadmapDir, "first.md");
    const controller = new AbortController();
    Object.defineProperty(controller.signal, "aborted", {
      get() {
        if (!controller.signal.reason && existsSync(dirname(path))) controller.abort();
        return controller.signal.reason !== undefined;
      },
    });
    await expect(atomicWrite(path, "Must not be written", { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(controller.signal.aborted).toBe(true);
    expect(await readdir(dirname(path))).toEqual([]);
  });

  test("cancellation after the only file commit skips the free-work success callback", async () => {
    const repo = await initialized();
    const before = await rawManagedBytes(repo);
    const controller = new AbortController();
    const written: string[] = [];
    let callbacks = 0;
    const receipt = await recordFreeWork(
      repo,
      main,
      { stage: "S01", intent: "Inspect existing payments" },
      {
        signal: controller.signal,
        async writeFile(path, content, options) {
          await atomicWrite(path, content, options);
          written.push(path);
          controller.abort();
        },
        onSuccess() {
          callbacks++;
        },
      },
    );
    const failure = refused(receipt, "cancelled");
    expect(written).toHaveLength(1);
    expect(callbacks).toBe(0);
    const first = written[0] as string;
    expect(failure.hints.join("\n")).toContain(first.slice(repo.repoRoot.length + 1));
    const after = await rawManagedBytes(repo);
    expect(after[first]).toContain("Inspect existing payments");
    for (const path of Object.keys(before).filter((path) => path !== first)) expect(after[path]).toBe(before[path]);
  });
});

describe("literal generated delimiters in authored bodies", () => {
  const example = `Example:\n\n~~~md\n${["stages", "rounds", "status", "adrs"].map((name) => generatedBlock(name, "Literal text")).join("\n")}\n~~~`;
  const inline = "Literal `<!-- roadmap:generated:stages --> <!-- /roadmap:generated -->` text.";
  const literalSections = {
    context: example,
    drivers: example,
    options: [inline],
    outcome: example,
    consequences: example,
    confirmation: example,
    pros_cons: example,
    more_info: example,
  };
  const literalStage = { ...stageInput, objective: example, design_constraints: example, risks: example };
  const literalRound = {
    ...charter,
    goal: example,
    constraints: [inline],
    non_goals: [inline],
    principles: [{ text: inline, adrs: ["ADR-0001"] }],
  };

  async function intact(repo: Repo): Promise<Model> {
    const model = await loadAll(repo);
    expect(model.parseErrors ?? []).toEqual([]);
    expect((await check(model)).filter((issue) => issue.severity === "error")).toEqual([]);
    return model;
  }

  test("initialization, all authored-body operations and round opening accept literal delimiter fences", async () => {
    const repo = await emptyRepo();
    success(
      await initProject(repo, main, {
        ...initInput,
        project: { ...initInput.project, description: example },
        round: literalRound,
        stages: [literalStage],
        adrs: [{ ...initInput.adrs[0], title: "Literal host choice", sections: literalSections }],
      }),
    );
    let model = await intact(repo);
    expect(model.index.body).toContain(example);
    expect(model.rounds[0]?.goal).toBe(example);
    expect(model.rounds[0]?.constraints).toBe(`- ${inline}`);
    success(await stage(repo, main, { action: "add", ...literalStage, title: "Literal follow-up" }));
    success(await stage(repo, main, { action: "renumber", id: "S02", new_id: "S08" }));
    success(await stage(repo, main, { action: "drop", id: "S08", reason: inline }));
    success(await stage(repo, main, { action: "edit", id: "S01", ...literalStage, objective: `${example}\n\nEdited.` }));
    model = await intact(repo);
    expect(model.stages.find((doc) => doc.id === "S01")?.objective).toBe(`${example}\n\nEdited.`);
    expect(model.stages.find((doc) => doc.id === "S08")?.objective).toBe(example);
    success(
      await todo(repo, main, { action: "add", title: "Literal concern", severity: "normal", source: inline, target: "S01", body: example }),
    );
    success(await todo(repo, main, { action: "update", id: "T001", body: `${example}\n\nUpdated.` }));
    success(await todo(repo, main, { action: "move", id: "T001", trigger: inline }));
    success(await todo(repo, main, { action: "resolve", id: "T001", reference: inline }));
    expect((await intact(repo)).todos[0]?.items[0]?.body).toBe(`${example}\n\nUpdated.`);
    success(await adr(repo, main, { action: "create", title: "Literal proposed decision", sections: literalSections }));
    success(
      await adr(repo, main, { action: "revise", id: "ADR-0002", sections: { ...literalSections, context: `${example}\n\nRevised.` } }),
    );
    success(await adr(repo, main, { action: "set_status", id: "ADR-0002", status: "accepted" }));
    success(await adr(repo, main, { action: "note", id: "ADR-0002", text: example }));
    success(await adr(repo, main, { action: "supersede", id: "ADR-0001", title: "Literal successor", sections: literalSections }));
    model = await intact(repo);
    expect(model.adrs.find((doc) => doc.id === "ADR-0002")?.body).toContain(`${example}\n\nRevised.`);
    expect(model.adrs.find((doc) => doc.id === "ADR-0003")?.body).toContain(example);
    success(await recordFreeWork(repo, main, { stage: "S01", intent: inline }));
    success(await stage(repo, main, { action: "start", id: "S01" }));
    success(await stage(repo, main, { action: "amend", id: "S01", reason: inline, amendments: { remove: ["DC2"] } }));
    success(await stage(repo, main, { ...evidence("S01", ["DC1"]), delivered: example, deviations: example }));
    model = await intact(repo);
    expect(model.stages.find((doc) => doc.id === "S01")?.outcome?.split(example)).toHaveLength(3);
    success(await closeRound(repo, main, { expected: await reviewedRound(repo), dispositions: [] }));
    const frozen = await managedBytes(repo);
    for (const round of [
      { ...literalRound, constraints: [example] },
      { ...literalRound, non_goals: [example] },
      { ...literalRound, principles: [{ text: example, adrs: ["ADR-0001"] }] },
    ]) {
      refused(await openRound(repo, main, { round, import_todos: [] }), "single-line");
      expect(await managedBytes(repo)).toEqual(frozen);
    }
    success(await openRound(repo, main, { round: { ...literalRound, title: "Next literal round" }, import_todos: [] }));
    model = await intact(repo);
    expect(model.rounds.find((doc) => doc.status === "active")?.goal).toBe(example);
    for (const [path, content] of Object.entries(frozen).filter(([path]) => path.includes("/01-launch/")))
      expect(await readFile(path, "utf8")).toBe(content);
  }, 120_000);

  test("check --fix regenerates only real blocks and leaves fenced authored bytes untouched", async () => {
    const repo = await initialized();
    const model = await loadAll(repo);
    const round = model.rounds[0];
    if (!round) throw new Error("Missing round");
    round.goal = example;
    round.constraints += `\n\n${example}`;
    round.non_goals += `\n\n${example}`;
    round.principles += `\n\n${example}`;
    round.stages = `${example}\n\n${generatedBlock("stages", renderStageTable(model.stages))}\n\n${example}`;
    round.known_limitations = example;
    const roundText = renderRound(round);
    const rootText = (await readFile(model.index.path, "utf8")).replace(
      "## How this directory works\n",
      `## How this directory works\n\n${example}\n`,
    );
    const adrPath = model.adrIndex?.path;
    if (!adrPath) throw new Error("Missing ADR index");
    const adrText = (await readFile(adrPath, "utf8")).replace("## Decisions\n", `## Decisions\n\n${example}\n`);
    const expected: Record<string, string> = { [round.path]: roundText, [model.index.path]: rootText, [adrPath]: adrText };
    for (const [path, content] of Object.entries(expected)) {
      let stale = content;
      for (const name of path === round.path ? ["stages"] : path === adrPath ? ["adrs"] : ["rounds", "status"])
        stale = replaceGenerated(stale, name, "Stale real block");
      await writeFile(path, stale);
    }
    const before = await managedBytes(repo);
    const diagnostics = await check(await loadAll(repo));
    expect(diagnostics.filter((issue) => issue.severity === "error").map((issue) => issue.rule)).toEqual([
      "generated",
      "generated",
      "generated",
      "generated",
    ]);
    expect(await check(await loadAll(repo), { fix: true })).toEqual([]);
    for (const [path, content] of Object.entries(expected)) expect(await readFile(path, "utf8")).toBe(content);
    for (const [path, content] of Object.entries(before)) if (!(path in expected)) expect(await readFile(path, "utf8")).toBe(content);
  });

  test("check still reports missing, duplicate and misplaced real blocks without repairing literal examples", async () => {
    const repo = await initialized();
    const round = (await loadAll(repo)).rounds[0];
    if (!round) throw new Error("Missing round");
    round.goal = example;
    const original = renderRound(round);
    const real = generatedBlock("stages", generatedContent(original, "stages"));
    const broken = [
      original.replace(real, ""),
      original.replace(real, `${real}\n\n${real}`),
      original.replace(real, "").replace("## Constraints\n", `## Constraints\n${real}\n`),
    ];
    for (const content of broken) {
      await writeFile(round.path, content);
      for (const fix of [false, true]) {
        expect((await check(await loadAll(repo), { fix })).some((issue) => issue.rule === "structure" && issue.path === round.path)).toBe(
          true,
        );
        expect(await readFile(round.path, "utf8")).toBe(content);
      }
    }
    await writeFile(round.path, original);
    await intact(repo);
  });
});
