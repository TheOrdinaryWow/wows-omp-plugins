import { afterEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { check } from "../plugins/adr/src/check.ts";
import { adrRepo, dirState, loadInitialized, snapshot, today } from "../plugins/adr/src/documents.ts";
import {
  createMany,
  initialize,
  link,
  manage,
  note,
  Refusal,
  relinkStage,
  revise,
  type StageResolver,
  setStatus,
  supersede,
} from "../plugins/adr/src/operations.ts";
import { cleanupFixtures, decision, LEGACY_ADR_1, LEGACY_ADR_2, LEGACY_INDEX, repoFixture } from "./adr-fixtures.ts";

afterEach(cleanupFixtures);

async function bytes(root: string): Promise<Record<string, string>> {
  const directory = join(root, "docs/adr");
  const result: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) result[name] = await readFile(join(directory, name), "utf8");
  return result;
}

const resolver: StageResolver = async (_root, stage) => (stage === "S01" || stage === "S02" ? undefined : `${stage} does not exist.`);

test("a legacy roadmap ADR directory is managed and listed transparently", async () => {
  const root = await repoFixture({ legacy: true });
  expect(await dirState(join(root, "docs/adr"))).toBe("managed");
  const model = await loadInitialized(root);
  expect(model).not.toBeNull();
  const view = snapshot(model as NonNullable<typeof model>);
  expect(view.parseErrors).toEqual([]);
  expect(view.records.map(({ id, title, status, stage, legacy, path }) => ({ id, title, status, stage, legacy, path }))).toEqual([
    { id: "ADR-0001", title: "Use Postgres", status: "accepted", stage: undefined, legacy: true, path: "docs/adr/0001-use-postgres.md" },
    { id: "ADR-0002", title: "Cache reads", status: "proposed", stage: "S01", legacy: true, path: "docs/adr/0002-cache-reads.md" },
  ]);
  expect(view.records[0]?.decision_makers).toEqual(["Project owner"]);
  expect(view.records[0]?.body.startsWith("## Context and Problem Statement\nWe need a relational store.")).toBe(true);
  expect("stage" in (view.records[0] ?? {})).toBe(false);
  expect(await check(adrRepo(root))).toEqual([]);
});

test("a write converts only the touched files and the index, keeping untouched legacy bytes", async () => {
  const root = await repoFixture({ legacy: true });
  const result = await createMany(root, "main", [{ ...decision, status: "accepted" }]);
  expect(result.ids).toEqual(["ADR-0003"]);
  expect(result.files.map((file) => file.path)).toEqual(["docs/adr/0003-adopt-event-sourcing.md", "docs/adr/README.md"]);
  let disk = await bytes(root);
  expect(disk["0001-use-postgres.md"]).toBe(LEGACY_ADR_1);
  expect(disk["0002-cache-reads.md"]).toBe(LEGACY_ADR_2);
  expect(disk["0003-adopt-event-sourcing.md"]).toBe(
    `---\nformat: 1\nid: "ADR-0003"\nstatus: "accepted"\ndate: "${today()}"\n---\n<!-- Managed by the adr OMP plugin (format v1). Change it through adr_* tools. Format: docs/adr/README.md -->\n\n# Adopt event sourcing\n\n## Context and Problem Statement\nAudits need the full history.\n\n## Considered Options\n* Event sourcing\n* Snapshots only\n\n## Decision Outcome\nChosen option: "Event sourcing", because audits replay history.\n\n`,
  );
  const index = disk["README.md"] as string;
  expect(index).not.toBe(LEGACY_INDEX);
  expect(index.startsWith("---\nformat: 1\nadr: { format: 1 }\n---\n<!-- Managed by the adr OMP plugin (format v1).")).toBe(true);
  expect(index).toContain(
    "## Decisions\n\n<!-- adr:generated:index -->\n| ADR | Title | Status | Date |\n| --- | --- | --- | --- |\n| ADR-0001 | Use Postgres | accepted | 2026-10-01 |\n| ADR-0002 | Cache reads | proposed | 2026-10-02 |\n",
  );
  for (const legacyText of ["roadmap:generated", "roadmap_adr", "Managed by the roadmap"]) expect(index).not.toContain(legacyText);

  await note(root, "sub", "ADR-0001", "Replicas arrived in the second quarter.");
  disk = await bytes(root);
  expect(disk["0002-cache-reads.md"]).toBe(LEGACY_ADR_2);
  const converted = disk["0001-use-postgres.md"] as string;
  expect(converted.split("<!--")[0]).toBe(
    '---\nformat: 1\nid: "ADR-0001"\nstatus: "accepted"\ndate: "2026-10-01"\ndecision-makers: ["Project owner"]\n---\n',
  );
  for (const absent of ["stage:", "superseded_by:", "supersedes:", "consulted:", "informed:", "null"])
    expect(converted).not.toContain(absent);
  expect(converted.endsWith(`## More Information\n\n### ${today()}\n\nReplicas arrived in the second quarter.\n\n`)).toBe(true);

  const model = await loadInitialized(root);
  expect(model?.adrs.map((doc) => [doc.id, doc.legacy])).toEqual([
    ["ADR-0001", false],
    ["ADR-0002", true],
    ["ADR-0003", false],
  ]);
  expect(await check(adrRepo(root))).toEqual([]);
});

test("converting a legacy index keeps authored preamble text and replaces only the roadmap conventions paragraph", async () => {
  const legacyParagraph = LEGACY_INDEX.split("\n\n")[2] as string;
  expect(legacyParagraph.startsWith("ADRs use the vendored MADR 4.0 body")).toBe(true);
  const intro = "Our team records storage decisions here.";
  const outro = "Ask the platform group before superseding an accepted record.";
  const root = await repoFixture({ legacy: true });
  await writeFile(join(root, "docs/adr/README.md"), LEGACY_INDEX.replace(legacyParagraph, `${intro}\n\n${legacyParagraph}\n\n${outro}`));
  await createMany(root, "main", [decision]);
  const index = (await bytes(root))["README.md"] as string;
  expect(index).toContain(`# Architecture Decision Records\n\n${intro}\n\nADRs record significant, hard-to-reverse decisions`);
  expect(index).toContain(`\n\n${outro}\n\n## Decisions\n\n<!-- adr:generated:index -->\n`);
  expect(index).not.toContain(legacyParagraph);
  expect(index).not.toContain("roadmap_adr");
  expect(await check(adrRepo(root))).toEqual([]);

  const edited = "ADRs live here; see the team wiki for our review process.";
  const other = await repoFixture({ legacy: true });
  await writeFile(join(other, "docs/adr/README.md"), LEGACY_INDEX.replace(legacyParagraph, edited));
  await createMany(other, "main", [decision]);
  const kept = (await bytes(other))["README.md"] as string;
  expect(kept).toContain(`# Architecture Decision Records\n\n${edited}\n\n## Decisions\n\n<!-- adr:generated:index -->\n`);
  expect(kept).not.toContain("ADRs record significant, hard-to-reverse decisions");
  expect(await check(adrRepo(other))).toEqual([]);
});

test("subagents create only proposed ADRs and cannot decide or supersede", async () => {
  const root = await repoFixture({ legacy: true });
  const created = await createMany(root, "sub", [{ ...decision, status: "accepted" }]);
  expect(created.warnings).toContain("Subagent ADRs are created as proposed.");
  expect((await loadInitialized(root))?.adrs.find((doc) => doc.id === "ADR-0003")?.status).toBe("proposed");
  const before = await bytes(root);
  await expect(setStatus(root, "sub", "ADR-0002", "accepted")).rejects.toThrow("Only the main agent can accept, reject or deprecate");
  await expect(supersede(root, "sub", "ADR-0001", decision)).rejects.toThrow("Only the main agent can supersede");
  await expect(initialize(root, "sub")).rejects.toThrow("Only the main session can initialize");
  expect(await bytes(root)).toEqual(before);
  await revise(root, "sub", { id: "ADR-0003", title: "Adopt event sourcing everywhere", sections: decision.sections });
  expect((await loadInitialized(root))?.adrs.find((doc) => doc.id === "ADR-0003")?.title).toBe("Adopt event sourcing everywhere");
  await setStatus(root, "main", "ADR-0003", "accepted");
  await expect(revise(root, "main", { id: "ADR-0003", sections: decision.sections })).rejects.toThrow("Only proposed ADRs can be revised");
});

test("supersede creates an accepted successor with reciprocal links", async () => {
  const root = await repoFixture({ legacy: true });
  await expect(supersede(root, "main", "ADR-0002", decision)).rejects.toThrow("Only an accepted or deprecated ADR can be superseded");
  const result = await supersede(root, "main", "ADR-0001", { ...decision, status: "proposed" });
  expect(result.ids).toEqual(["ADR-0003", "ADR-0001"]);
  expect(result.warnings).toContain("A successor ADR is created as accepted.");
  const model = await loadInitialized(root);
  const byId = Object.fromEntries((model?.adrs ?? []).map((doc) => [doc.id, doc]));
  expect(byId["ADR-0003"]).toMatchObject({ status: "accepted", supersedes: ["ADR-0001"], superseded_by: undefined });
  expect(byId["ADR-0001"]).toMatchObject({ status: "superseded", superseded_by: "ADR-0003", legacy: false });
  expect((await bytes(root))["README.md"]).toContain("| ADR-0001 | Use Postgres | superseded by ADR-0003 | 2026-10-01 |");
  await expect(setStatus(root, "main", "ADR-0001", "accepted")).rejects.toThrow("A superseded ADR keeps its successor link");
  expect(await check(adrRepo(root))).toEqual([]);
});

test("stage links are refused without a resolver and validated with one", async () => {
  const root = await repoFixture({ legacy: true });
  const before = await bytes(root);
  await expect(createMany(root, "main", [{ ...decision, stage: "S01" }])).rejects.toThrow("Stage links need the roadmap plugin");
  await expect(link(root, "main", "ADR-0001", "S01")).rejects.toThrow("Stage links need the roadmap plugin");
  await expect(relinkStage(root, "main", "S01", "S02")).rejects.toThrow("Stage links need the roadmap plugin");
  await expect(createMany(root, "main", [{ ...decision, stage: "S09" }], { resolver })).rejects.toThrow(
    "Stage S09 cannot be linked: S09 does not exist.",
  );
  await expect(createMany(root, "main", [{ ...decision, stage: "stage one" }], { resolver })).rejects.toThrow("stage must be a stage id");
  expect(await bytes(root)).toEqual(before);

  await createMany(root, "main", [{ ...decision, stage: "S01" }], { resolver });
  expect((await bytes(root))["0003-adopt-event-sourcing.md"]).toContain('\nstage: "S01"\n');
  await link(root, "main", "ADR-0001", "S02", { resolver });
  await relinkStage(root, "main", "S01", "S03", { resolver });
  let adrs = (await loadInitialized(root))?.adrs ?? [];
  expect(adrs.map((doc) => [doc.id, doc.stage])).toEqual([
    ["ADR-0001", "S02"],
    ["ADR-0002", "S03"],
    ["ADR-0003", "S03"],
  ]);
  await link(root, "main", "ADR-0003", undefined);
  adrs = (await loadInitialized(root))?.adrs ?? [];
  expect(adrs.find((doc) => doc.id === "ADR-0003")?.stage).toBeUndefined();
  expect((await bytes(root))["0003-adopt-event-sourcing.md"]).not.toContain("stage:");
});

test("adr_manage links at every status without changing decision content and refuses unauthorized or invalid links", async () => {
  const root = await repoFixture();
  await initialize(root, "main");
  await createMany(
    root,
    "main",
    (["proposed", "accepted", "rejected", "deprecated"] as const).map((status) => ({ ...decision, title: status, status })),
  );
  await supersede(root, "main", "ADR-0002", decision);
  const original = (await loadInitialized(root))?.adrs ?? [];
  expect(new Set(original.map((doc) => doc.status)).size).toBe(5);
  const before = await bytes(root);
  await expect(manage(root, "main", { action: "link" })).rejects.toThrow("ADR id must be non-empty");
  await expect(manage(root, "main", { action: "link", id: "ADR-0001", stage: "S01" })).rejects.toThrow(
    "Stage links need the roadmap plugin",
  );
  await expect(manage(root, "main", { action: "link", id: "ADR-0001", stage: "S09" }, { resolver })).rejects.toThrow(
    "Stage S09 cannot be linked: S09 does not exist.",
  );
  for (const stage of ["S01", undefined]) {
    await expect(manage(root, "sub", { action: "link", id: "ADR-0001", stage }, { resolver })).rejects.toThrow("Only the main agent");
    await expect(link(root, "sub", "ADR-0001", stage, { resolver })).rejects.toThrow("Only the main agent");
  }
  expect(await bytes(root)).toEqual(before);

  for (const doc of original) {
    await manage(root, "main", { action: "link", id: doc.id, stage: "S01" }, { resolver });
    expect((await loadInitialized(root))?.adrs.find((record) => record.id === doc.id)).toEqual({ ...doc, stage: "S01" });
    await manage(root, "main", { action: "link", id: doc.id, stage: "S02" }, { resolver });
    expect((await loadInitialized(root))?.adrs.find((record) => record.id === doc.id)).toEqual({ ...doc, stage: "S02" });
    await manage(root, "main", { action: "link", id: doc.id });
    expect((await loadInitialized(root))?.adrs.find((record) => record.id === doc.id)).toEqual(doc);
  }
});

test("allocation starts above the legacy roadmap counter, its own counter and the disk, and never writes the roadmap file", async () => {
  const root = await repoFixture({ legacy: true });
  const roadmapCounters = `${JSON.stringify({ v: 1, round: 2, stage: 4, todo: 9, adr: 7 })}\n`;
  await mkdir(join(root, ".git/roadmap"), { recursive: true });
  await writeFile(join(root, ".git/roadmap/counters.json"), roadmapCounters);
  expect((await createMany(root, "main", [decision])).ids).toEqual(["ADR-0008"]);
  expect(JSON.parse(await readFile(join(root, ".git/adr/counters.json"), "utf8"))).toEqual({ v: 1, adr: 8 });
  expect(await readFile(join(root, ".git/roadmap/counters.json"), "utf8")).toBe(roadmapCounters);
  await writeFile(join(root, ".git/adr/counters.json"), `${JSON.stringify({ v: 1, adr: 20 })}\n`);
  expect((await createMany(root, "main", [decision, { ...decision, title: "Second" }])).ids).toEqual(["ADR-0021", "ADR-0022"]);
  await writeFile(join(root, ".git/roadmap/counters.json"), "not json");
  await expect(createMany(root, "main", [decision])).rejects.toThrow("ADR allocation paused");
});

test("dry runs return provisional files and ids without writing files or counters", async () => {
  const legacy = await repoFixture({ legacy: true });
  const before = await bytes(legacy);
  const preview = await createMany(legacy, "main", [decision, { ...decision, title: "Second decision" }], { dryRun: true });
  expect(preview.ids).toEqual(["ADR-0003", "ADR-0004"]);
  expect(preview.files.map((file) => file.path)).toEqual([
    "docs/adr/0003-adopt-event-sourcing.md",
    "docs/adr/0004-second-decision.md",
    "docs/adr/README.md",
  ]);
  expect(await bytes(legacy)).toEqual(before);
  expect(await Bun.file(join(legacy, ".git/adr/counters.json")).exists()).toBe(false);

  const fresh = await repoFixture();
  const adrDir = join(fresh, "docs/adr");
  await expect(createMany(fresh, "main", [decision])).rejects.toThrow("ADR management is not initialized");
  await expect(createMany(fresh, "sub", [decision], { initialize: true })).rejects.toThrow("Only the main session can initialize");
  const batch = await createMany(fresh, "main", [decision], { dryRun: true, initialize: true });
  expect(batch.files.map((file) => file.path)).toEqual(["docs/adr/0001-adopt-event-sourcing.md", "docs/adr/README.md"]);
  expect((await initialize(fresh, "main", { dryRun: true })).files.map((file) => file.path)).toEqual(["docs/adr/README.md"]);
  expect(await dirState(adrDir)).toBe("absent");
  const written = await createMany(fresh, "main", [decision], { initialize: true });
  expect(written.files).toEqual(batch.files);
  expect(await dirState(adrDir)).toBe("managed");
  expect(await initialize(fresh, "main")).toEqual({
    files: [],
    ids: [],
    warnings: ["ADR management is already initialized in this repository."],
  });
});

test("initialization refuses a non-empty unmanaged directory and accepts an empty one", async () => {
  const root = await repoFixture();
  await mkdir(join(root, "docs/adr"), { recursive: true });
  expect(await dirState(join(root, "docs/adr"))).toBe("empty");
  await writeFile(join(root, "docs/adr/notes.md"), "# Notes\n");
  expect(await dirState(join(root, "docs/adr"))).toBe("unmanaged");
  await expect(initialize(root, "main")).rejects.toThrow("not managed by the adr plugin");
  await expect(createMany(root, "main", [decision], { initialize: true })).rejects.toThrow("not managed by the adr plugin");
  expect(await readdir(join(root, "docs/adr"))).toEqual(["notes.md"]);
  const empty = await repoFixture();
  await mkdir(join(empty, "docs/adr"), { recursive: true });
  await initialize(empty, "main");
  expect(await check(adrRepo(empty))).toEqual([]);
});

test("check reports broken supersession and a stale index, and fix regenerates only the index", async () => {
  const root = await repoFixture({ legacy: true });
  const stale = LEGACY_INDEX.replace("| ADR-0002 | Cache reads | proposed | 2026-10-02 |\n", "");
  await writeFile(join(root, "docs/adr/README.md"), stale);
  await writeFile(join(root, "docs/adr/0002-cache-reads.md"), LEGACY_ADR_2.replace("superseded_by: null", 'superseded_by: "ADR-0001"'));
  const found = await check(adrRepo(root));
  expect(found.map((item) => [item.rule, item.path, item.fixable])).toEqual([
    ["supersession", "docs/adr/0002-cache-reads.md", false],
    ["supersession", "docs/adr/0002-cache-reads.md", false],
    ["generated", "docs/adr/README.md", true],
  ]);
  const changedFiles: string[] = [];
  const fixed = await check(adrRepo(root), { fix: true, changedFiles });
  expect(changedFiles).toEqual(["docs/adr/README.md"]);
  expect(fixed.map((item) => item.rule)).toEqual(["supersession", "supersession"]);
  const disk = await bytes(root);
  expect(disk["README.md"]).toContain("<!-- adr:generated:index -->");
  expect(disk["0001-use-postgres.md"]).toBe(LEGACY_ADR_1);
});

test("a malformed marker fails reads instead of looking unmanaged", async () => {
  const root = await repoFixture({ legacy: true });
  await writeFile(join(root, "docs/adr/README.md"), "---\nformat: 99\nadr: { format: 99 }\n---\n");
  await expect(dirState(join(root, "docs/adr"))).rejects.toThrow();
  await expect(createMany(root, "main", [decision])).rejects.toThrow();
});

test("cancellation writes nothing before the first file and reports files committed before it", async () => {
  const root = await repoFixture({ legacy: true });
  const before = await bytes(root);
  const aborted = new AbortController();
  aborted.abort();
  await expect(createMany(root, "main", [decision], { signal: aborted.signal })).rejects.toThrow("ADR operation cancelled.");
  expect(await bytes(root)).toEqual(before);
  expect(await Bun.file(join(root, ".git/adr/counters.json")).exists()).toBe(false);
  // Abort as soon as the new ADR file exists, so the index write is the one cancelled.
  const target = join(root, "docs/adr/0003-adopt-event-sourcing.md");
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "aborted", { get: () => Bun.file(target).size > 0 });
  const refusal = await createMany(root, "main", [decision], { signal: controller.signal }).catch((error: unknown) => error);
  if (!(refusal instanceof Refusal)) throw new Error(`Expected a cancellation refusal, got ${String(refusal)}`);
  expect(refusal.message).toBe("ADR operation cancelled.");
  expect(refusal.hints[0]).toBe("Files committed by the interrupted operation: docs/adr/0003-adopt-event-sourcing.md.");
  const disk = await bytes(root);
  expect(disk["README.md"]).toBe(LEGACY_INDEX);
  expect((await check(adrRepo(root))).map((item) => item.rule)).toEqual(["generated"]);
  await check(adrRepo(root), { fix: true });
  expect(await check(adrRepo(root))).toEqual([]);
});
