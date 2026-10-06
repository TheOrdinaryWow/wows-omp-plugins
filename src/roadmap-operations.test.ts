import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { check } from "../plugins/roadmap/src/check.ts";
import {
  loadAll,
  loadRepo,
  type Model,
  markdownHeadings,
  parseAdr,
  parseStage,
  type Repo,
  renderRound,
  renderStage,
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
  project: { name: "Shop", description: "A small shop with **real checkout**." },
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
            title: `Fenced example ${fence} ${Boolean(more_info)}`,
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
