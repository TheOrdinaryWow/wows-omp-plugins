import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { check } from "../plugins/roadmap/src/check.ts";
import {
  generatedContent,
  loadAll,
  type Model,
  renderAdr,
  renderRound,
  renderStage,
  replaceGenerated,
  roundFiles,
  roundSha256,
  stageSha256,
} from "../plugins/roadmap/src/documents.ts";
import { atomicWrite, stage } from "../plugins/roadmap/src/operations.ts";
import { checkReceipt } from "../plugins/roadmap/src/tools.ts";
import { adrFixture, cleanupFixtures, diskFixture, modelFixture, stageFixture } from "./roadmap-fixtures.ts";

afterEach(cleanupFixtures);

async function rules(model: Model): Promise<string[]> {
  return (await check(model)).map((diagnostic) => diagnostic.rule);
}

test("a consistent disk fixture passes all design-section-10 rules", async () => {
  const { repo } = await diskFixture();
  expect(await check(await loadAll(repo))).toEqual([]);
});

describe("structure and supported format", () => {
  for (const [name, change, rule] of [
    ["malformed front matter", (text: string) => text.replace("depends_on: []", "depends_on: ["), "structure"],
    ["altered fixed heading", (text: string) => text.replace("## Objective", "## Wrong"), "structure"],
    ["unknown format", (text: string) => text.replace("format: 1", "format: 999"), "format"],
  ] as const) {
    test(`${name} fails and the repaired fixture passes`, async () => {
      const { repo, model } = await diskFixture();
      const stage = model.stages[0]?.path as string;
      const original = await readFile(stage, "utf8");
      await writeFile(stage, change(original));
      expect(await rules(await loadAll(repo))).toContain(rule);
      await writeFile(stage, original);
      expect(await check(await loadAll(repo))).toEqual([]);
    });
  }
});

describe("ids and references", () => {
  test("duplicate ids fail in rounds, stages, TODOs and ADRs; unique ids pass", async () => {
    for (const kind of ["rounds", "stages", "todos", "adrs"] as const) {
      const model = modelFixture();
      if (kind === "rounds") model.rounds.push({ ...(model.rounds[0] as (typeof model.rounds)[number]), path: "other-round.md" });
      else if (kind === "stages") model.stages.push({ ...(model.stages[0] as (typeof model.stages)[number]), path: "other-stage.md" });
      else if (kind === "adrs") model.adrs.push({ ...(model.adrs[0] as (typeof model.adrs)[number]), path: "other-adr.md" });
      else model.todos[0]?.items.push({ ...(model.todos[0].items[0] as (typeof model.todos)[number]["items"][number]) });
      const diagnostics = await check(model);
      expect(diagnostics.find((item) => item.rule === "duplicate-id")?.message).toContain("Duplicate");
      expect(await rules(modelFixture())).not.toContain("duplicate-id");
    }
  });

  for (const reference of ["depends_on", "follows", "todo-target", "supersedes", "superseded_by"] as const) {
    test(`dangling ${reference} fails and an existing reference passes`, async () => {
      const model = modelFixture();
      const stage = model.stages[0] as (typeof model.stages)[number];
      const adr = model.adrs[0] as (typeof model.adrs)[number];
      if (reference === "depends_on") stage.depends_on = ["S99"];
      else if (reference === "follows") stage.follows = "S99";
      else if (reference === "todo-target")
        (model.todos[0]?.items[0] as NonNullable<(typeof model.todos)[0]>["items"][number]).target = "S99";
      else if (reference === "supersedes") adr.supersedes = ["ADR-0099"];
      else adr.superseded_by = "ADR-0099";
      expect(await rules(model)).toContain("dangling-reference");
      model.stages.push(stageFixture({ id: "S99", title: "Successor stage", path: "stage99.md" }));
      model.adrs.push(adrFixture({ id: "ADR-0099", path: "adr99.md" }));
      expect(await rules(model)).not.toContain("dangling-reference");
    });
  }

  test("dependency cycles, including a self-cycle, fail; a DAG passes", async () => {
    const model = modelFixture();
    const first = model.stages[0] as (typeof model.stages)[number];
    first.depends_on = ["S01"];
    expect(await rules(model)).toContain("dependency-cycle");
    first.depends_on = ["S02"];
    model.stages.push(stageFixture({ id: "S02", depends_on: ["S01"], path: "s02.md" }));
    expect((await check(model)).find((item) => item.rule === "dependency-cycle")?.message).toContain("S01 → S02 → S01");
    (model.stages[1] as (typeof model.stages)[number]).depends_on = [];
    expect(await rules(model)).not.toContain("dependency-cycle");
  });
});

describe("closed document hashes", () => {
  test("closed stage hash detects authored and metadata edits; the unchanged closed fixture passes", async () => {
    const { repo, model } = await diskFixture();
    const stage = model.stages[0] as (typeof model.stages)[number];
    stage.status = "closed";
    stage.closed = "2026-10-06";
    stage.closed_sha256 = stageSha256(stage);
    await writeFile(stage.path, renderStage(stage));
    expect(await rules(await loadAll(repo))).not.toContain("closed-stage-hash");
    await writeFile(stage.path, renderStage({ ...stage, objective: `${stage.objective}\nChanged.` }));
    expect(await rules(await loadAll(repo))).toContain("closed-stage-hash");
    await writeFile(stage.path, renderStage({ ...stage, started: "2026-10-06" }));
    expect(await rules(await loadAll(repo))).toContain("closed-stage-hash");
  });

  test("frozen round hash detects every regular file including unparsed files; unchanged freeze passes", async () => {
    const { repo, model } = await diskFixture();
    const round = model.rounds[0] as (typeof model.rounds)[number];
    round.status = "closed";
    round.closed = "2026-10-06";
    await writeFile(round.path, renderRound(round, model.stages));
    const loaded = await loadAll(repo);
    round.frozen_sha256 = roundSha256(roundFiles(loaded, round));
    await writeFile(round.path, renderRound(round, model.stages));
    expect(await rules(await loadAll(repo))).not.toContain("frozen-round-hash");
    const extra = join(dirname(round.path), "extra.txt");
    await writeFile(extra, "added file\n");
    expect(await rules(await loadAll(repo))).toContain("frozen-round-hash");
    const files = roundFiles(await loadAll(repo), round);
    round.frozen_sha256 = roundSha256(files);
    await writeFile(round.path, renderRound(round, model.stages));
    expect(await rules(await loadAll(repo))).not.toContain("frozen-round-hash");
    await writeFile(extra, "edited file\n");
    expect(await rules(await loadAll(repo))).toContain("frozen-round-hash");
  });

  test.each(["planned", "active", "dropped"] as const)("a %s stage cannot retain a closure hash even when it matches", async (status) => {
    const { repo, model } = await diskFixture();
    const current = model.stages[0] as (typeof model.stages)[number];
    current.status = status;
    current.closed = "2026-10-06";
    current.closed_sha256 = stageSha256(current);
    await writeFile(current.path, renderStage(current));
    const loaded = await loadAll(repo);
    const before = loaded.files;
    expect(await rules(loaded)).not.toContain("closed-stage-hash");
    for (const fix of [false, true]) {
      const result = await check(loaded, { fix });
      expect(result).toContainEqual(expect.objectContaining({ rule: "closed-stage-status", severity: "error", fixable: false }));
      expect((await loadAll(repo)).files).toEqual(before);
    }
  });

  test.each(["planned", "active"] as const)("a %s stage cannot retain only a closure date", async (status) => {
    const { repo, model } = await diskFixture();
    const current = model.stages[0] as (typeof model.stages)[number];
    current.status = status;
    current.closed = "2026-10-06";
    await writeFile(current.path, renderStage(current));
    const before = (await loadAll(repo)).files;
    const result = await check(await loadAll(repo), { fix: true });
    expect(result).toContainEqual(expect.objectContaining({ rule: "closed-stage-status", severity: "error", fixable: false }));
    expect((await loadAll(repo)).files).toEqual(before);
  });

  test.each(["hash", "date"] as const)("an active round cannot retain a closure %s", async (metadata) => {
    const { repo, model } = await diskFixture();
    const current = model.rounds[0] as (typeof model.rounds)[number];
    current.closed = "2026-10-06";
    await writeFile(current.path, renderRound(current, model.stages));
    if (metadata === "hash") {
      current.frozen_sha256 = roundSha256(roundFiles(await loadAll(repo), current));
      await writeFile(current.path, renderRound(current, model.stages));
    }
    const loaded = await loadAll(repo);
    const before = loaded.files;
    expect(await rules(loaded)).not.toContain("frozen-round-hash");
    for (const fix of [false, true]) {
      const result = await check(loaded, { fix });
      expect(result).toContainEqual(expect.objectContaining({ rule: "frozen-round-status", severity: "error", fixable: false }));
      expect((await loadAll(repo)).files).toEqual(before);
    }
  });

  test.each(["stage", "round"] as const)("changing only a closed %s status does not bypass its retained hash", async (kind) => {
    const { repo, model } = await diskFixture();
    const current = kind === "stage" ? model.stages[0] : model.rounds[0];
    if (!current) throw new Error("Missing closure fixture");
    current.status = "closed";
    current.closed = "2026-10-06";
    if (kind === "stage") {
      const closed = model.stages[0] as (typeof model.stages)[number];
      closed.closed_sha256 = stageSha256(closed);
      await writeFile(closed.path, renderStage(closed));
    } else {
      const closed = model.rounds[0] as (typeof model.rounds)[number];
      await writeFile(closed.path, renderRound(closed, model.stages));
      closed.frozen_sha256 = roundSha256(roundFiles(await loadAll(repo), closed));
      await writeFile(closed.path, renderRound(closed, model.stages));
    }
    const raw = await readFile(current.path, "utf8");
    await writeFile(current.path, raw.replace(/^status: "closed"$/m, `status: "${kind === "stage" ? "planned" : "active"}"`));
    const before = (await loadAll(repo)).files;
    const prefix = kind === "stage" ? "closed-stage" : "frozen-round";
    for (const fix of [false, true]) {
      const result = await check(await loadAll(repo), { fix });
      for (const suffix of ["status", "hash"]) {
        expect(result).toContainEqual(expect.objectContaining({ rule: `${prefix}-${suffix}`, severity: "error", fixable: false }));
      }
      expect((await loadAll(repo)).files).toEqual(before);
    }
  });
});

describe("TODO completeness and targets", () => {
  for (const field of ["severity", "source", "target"] as const) {
    test(`an open TODO missing ${field} fails; filled metadata passes`, async () => {
      const model = modelFixture();
      const item = model.todos[0]?.items[0];
      if (!item) throw new Error("missing fixture item");
      delete item[field];
      expect(await rules(model)).toContain("todo-fields");
      expect(await rules(modelFixture())).not.toContain("todo-fields");
    });
  }

  test("trigger substitutes for a target; simultaneous or blank target/trigger fails; closed TODOs need no open metadata", async () => {
    const model = modelFixture();
    const item = model.todos[0]?.items[0];
    if (!item) throw new Error("missing fixture item");
    delete item.target;
    item.trigger = "when the host has a new API";
    expect(await rules(model)).not.toContain("todo-fields");
    item.target = "S01";
    expect(await rules(model)).toContain("todo-fields");
    delete item.target;
    item.trigger = "  ";
    expect(await rules(model)).toContain("todo-fields");
    item.status = "resolved";
    item.reference = "commit abc123";
    delete item.severity;
    delete item.source;
    expect(await rules(model)).not.toContain("todo-fields");
  });

  for (const status of ["closed", "dropped"] as const) {
    test(`a TODO targeting a ${status} stage fails; planned and active targets pass`, async () => {
      const model = modelFixture();
      const stage = model.stages[0] as (typeof model.stages)[number];
      stage.status = status;
      expect(await rules(model)).toContain("todo-target");
      stage.status = "active";
      expect(await rules(model)).not.toContain("todo-target");
      stage.status = "planned";
      expect(await rules(model)).not.toContain("todo-target");
    });
  }
});

describe("ADR warnings", () => {
  for (const surface of ["principles", "todo", "stage", "trigger"] as const) {
    test(`${surface} citing a superseded ADR warns with its successor; current citations pass`, async () => {
      const model = modelFixture();
      (model.rounds[0] as (typeof model.rounds)[number]).principles = "";
      (model.stages[0] as (typeof model.stages)[number]).design_constraints = "";
      (model.todos[0]?.items[0] as NonNullable<(typeof model.todos)[0]>["items"][number]).body = "";
      (model.adrs[0] as (typeof model.adrs)[number]).superseded_by = "ADR-0002";
      model.adrs.push(adrFixture({ id: "ADR-0002", supersedes: ["ADR-0001"], path: "adr2.md" }));
      if (surface === "principles") (model.rounds[0] as (typeof model.rounds)[number]).principles = "See ADR-0001.";
      else if (surface === "stage") (model.stages[0] as (typeof model.stages)[number]).design_constraints = "See ADR-0001.";
      else if (surface === "trigger") {
        const item = model.todos[0]?.items[0];
        if (!item) throw new Error("missing fixture item");
        delete item.target;
        item.trigger = "when ADR-0001 is implemented";
      } else (model.todos[0]?.items[0] as NonNullable<(typeof model.todos)[0]>["items"][number]).body = "See ADR-0001.";
      const warning = (await check(model)).find((item) => item.rule === "superseded-adr");
      expect(warning?.severity).toBe("warning");
      expect(warning?.message).toContain("successor ADR-0002");
      (model.adrs[0] as (typeof model.adrs)[number]).superseded_by = null;
      expect(await rules(model)).not.toContain("superseded-adr");
    });
  }

  test("closed and dropped stages and closed TODOs do not warn about historical ADR citations", async () => {
    const model = modelFixture();
    (model.adrs[0] as (typeof model.adrs)[number]).superseded_by = "ADR-0002";
    (model.rounds[0] as (typeof model.rounds)[number]).principles = "";
    (model.stages[0] as (typeof model.stages)[number]).status = "dropped";
    const item = model.todos[0]?.items[0];
    if (item) {
      item.status = "resolved";
      item.reference = "commit abc123";
    }
    expect(await rules(model)).not.toContain("superseded-adr");
  });

  test("proposed ADRs without an active origin stage warn; active origins and non-proposed records pass", async () => {
    const model = modelFixture();
    const adr = model.adrs[0] as (typeof model.adrs)[number];
    adr.status = "proposed";
    expect(await rules(model)).toContain("proposed-adr");
    adr.stage = null;
    expect(await rules(model)).toContain("proposed-adr");
    adr.stage = "S01";
    (model.stages[0] as (typeof model.stages)[number]).status = "active";
    expect(await rules(model)).not.toContain("proposed-adr");
    adr.status = "accepted";
    adr.stage = null;
    expect(await rules(model)).not.toContain("proposed-adr");
  });
});

describe("generated blocks and fix scope", () => {
  test("a cancelled fix leaves stale generated blocks unchanged while read-only check still reports them", async () => {
    const { repo, model } = await diskFixture();
    const stale = replaceGenerated(await readFile(model.index.path, "utf8"), "status", "Stale status");
    await writeFile(model.index.path, stale);
    const loaded = await loadAll(repo);
    const before = loaded.files;
    const controller = new AbortController();
    controller.abort();
    expect(await check(loaded, { fix: true, signal: controller.signal })).toEqual([
      { severity: "error", rule: "cancelled", path: model.index.path, message: "Roadmap operation cancelled.", fixable: false },
    ]);
    expect((await loadAll(repo)).files).toEqual(before);
    expect((await check(loaded, { signal: controller.signal })).map((item) => item.rule)).toContain("generated");
    expect((await loadAll(repo)).files).toEqual(before);
    expect(await check(loaded, { fix: true })).toEqual([]);
  });

  test.each(["temporary", "committed", "penultimate", "final"] as const)(
    "fix cancellation after a %s write retains committed paths",
    async (boundary) => {
      const { repo, model } = await diskFixture();
      const paths = [model.index.path, model.rounds[0]?.path as string, model.adrIndex?.path as string];
      const names = ["status", "stages", "adrs"];
      const committedCount = ["temporary", "committed", "penultimate", "final"].indexOf(boundary);
      const triggerPath = paths[Math.max(0, committedCount - 1)] as string;
      const original = new Map<string, string>();
      for (const [index, path] of paths.entries()) {
        const stale = replaceGenerated(await readFile(path, "utf8"), names[index] as string, "Stale table");
        await writeFile(path, stale);
        original.set(path, stale);
      }
      const loaded = await loadAll(repo);
      const controller = new AbortController();
      Object.defineProperty(controller.signal, "aborted", {
        get() {
          const reached =
            boundary === "temporary"
              ? readdirSync(repo.roadmapDir).some((name) => name.endsWith(".tmp"))
              : readFileSync(triggerPath, "utf8") !== original.get(triggerPath);
          if (reached && !controller.signal.reason) controller.abort();
          return controller.signal.reason !== undefined;
        },
      });
      const result = await check(loaded, { fix: true, signal: controller.signal });
      expect(controller.signal.aborted).toBe(true);
      expect(result.map((item) => item.rule)).toEqual(["cancelled"]);
      for (const [index, path] of paths.entries()) {
        if (index < committedCount) expect(await readFile(path, "utf8")).not.toBe(original.get(path) as string);
        else expect(await readFile(path, "utf8")).toBe(original.get(path) as string);
      }
      expect(loaded.files).toEqual((await loadAll(repo)).files);
      expect(readdirSync(repo.roadmapDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  test.each([0, 1, 2, 3])("cancelled check fixes report all %i committed files and a retry path", async (committedCount) => {
    const { repo, model } = await diskFixture();
    const paths = [model.index.path, model.rounds[0]?.path as string, model.adrIndex?.path as string];
    const names = ["status", "stages", "adrs"];
    const original = new Map<string, string>();
    for (const [index, path] of paths.entries()) {
      const stale = replaceGenerated(await readFile(path, "utf8"), names[index] as string, "Stale table");
      await writeFile(path, stale);
      original.set(path, stale);
    }
    const controller = new AbortController();
    if (committedCount === 0) controller.abort();
    else {
      const triggerPath = paths[committedCount - 1] as string;
      Object.defineProperty(controller.signal, "aborted", {
        get() {
          if (!controller.signal.reason && readFileSync(triggerPath, "utf8") !== original.get(triggerPath)) controller.abort();
          return controller.signal.reason !== undefined;
        },
      });
    }
    const receipt = await checkReceipt(repo, true, controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) throw new Error("Expected cancelled check receipt");
    expect(receipt.diagnostics?.map((item) => item.rule)).toEqual(["cancelled"]);
    expect(receipt.changedFiles?.toSorted()).toEqual(paths.slice(0, committedCount).toSorted());
    const hints = receipt.hints.join("\n");
    expect(hints).toMatch(/roadmap_check.*fix: true/);
    for (const [index, path] of paths.entries()) {
      if (index < committedCount) {
        expect(hints).toContain(path);
        expect(await readFile(path, "utf8")).not.toBe(original.get(path) as string);
      } else {
        expect(hints).not.toContain(path);
        expect(await readFile(path, "utf8")).toBe(original.get(path) as string);
      }
    }
    expect(await check(await loadAll(repo), { fix: true })).toEqual([]);
  });

  test("fix repairs only generated blocks after cancellation commits a stage but leaves both indexes stale", async () => {
    const { repo } = await diskFixture();
    const before = await loadAll(repo);
    const current = before.stages[0];
    if (!current) throw new Error("Missing planned stage");
    const controller = new AbortController();
    const written: string[] = [];
    const receipt = await stage(
      repo,
      { sessionId: "cancelled-start", kind: "main" },
      { action: "start", id: current.id },
      {
        signal: controller.signal,
        async writeFile(path, content, options) {
          await atomicWrite(path, content, options);
          written.push(path);
          controller.abort();
        },
      },
    );
    expect(receipt.ok).toBe(false);
    expect(written).toEqual([current.path]);
    const partial = await loadAll(repo);
    expect(partial.stages[0]?.status).toBe("active");
    expect(partial.files?.[partial.index.path]).toEqual(before.files?.[before.index.path]);
    const roundPath = before.rounds[0]?.path as string;
    expect(partial.files?.[roundPath]).toEqual(before.files?.[roundPath]);
    const diagnostics = await check(partial);
    expect(
      diagnostics
        .filter((item) => item.rule === "generated")
        .map((item) => item.path)
        .sort(),
    ).toEqual([before.index.path, roundPath].sort());
    const filesBeforeFix = partial.files;
    expect(await check(partial, { fix: true })).toEqual([]);
    const repaired = await loadAll(repo);
    expect(await check(repaired)).toEqual([]);
    for (const [path, content] of Object.entries(filesBeforeFix ?? {})) {
      if (path !== partial.index.path && path !== roundPath) expect(repaired.files?.[path]).toEqual(content);
    }
    expect(readdirSync(dirname(current.path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("every generated block detects stale content; fix repairs only block spans and preserves authored CRLF bytes", async () => {
    const { repo, model } = await diskFixture();
    const index = model.index.path;
    const round = model.rounds[0]?.path as string;
    const adr = model.adrIndex?.path as string;
    const blockNames: Record<string, string[]> = { [index]: ["rounds", "status"], [round]: ["stages"], [adr]: ["adrs"] };
    const before = new Map<string, string>();
    for (const [path, names] of Object.entries(blockNames)) {
      let raw = (await readFile(path, "utf8")).replaceAll("\n", "\r\n");
      for (const name of names) raw = replaceGenerated(raw, name, `STALE ${name}`);
      await writeFile(path, raw);
      before.set(path, raw);
    }
    const stage = model.stages[0]?.path as string;
    const todo = model.todos[0]?.path as string;
    const stageBefore = await readFile(stage, "utf8");
    const todoBefore = await readFile(todo, "utf8");
    const loaded = await loadAll(repo);
    expect((await check(loaded)).filter((item) => item.rule === "generated")).toHaveLength(4);
    expect(await check(loaded, { fix: true })).toEqual([]);
    expect(loaded.index.body).not.toContain("STALE");
    expect(loaded.rounds[0]?.stages).not.toContain("STALE");
    expect(loaded.adrIndex?.body).not.toContain("STALE");
    for (const [path, names] of Object.entries(blockNames)) {
      const after = await readFile(path, "utf8");
      let authoredBefore = before.get(path) as string;
      let authoredAfter = after;
      for (const name of names) {
        authoredBefore = replaceGenerated(authoredBefore, name, "placeholder");
        authoredAfter = replaceGenerated(authoredAfter, name, "placeholder");
      }
      expect(authoredAfter).toBe(authoredBefore);
      expect(after).not.toContain("STALE");
      expect(after).toContain("\r\n");
    }
    expect(await readFile(stage, "utf8")).toBe(stageBefore);
    expect(await readFile(todo, "utf8")).toBe(todoBefore);
    expect(await check(await loadAll(repo), { fix: true })).toEqual([]);
  });

  test("fix refuses a closed round even when its generated table is stale", async () => {
    const { repo, model } = await diskFixture();
    const round = model.rounds[0] as (typeof model.rounds)[number];
    round.status = "closed";
    round.closed = "2026-10-06";
    const raw = replaceGenerated(renderRound(round, model.stages), "stages", "frozen stale table");
    await writeFile(round.path, raw);
    round.frozen_sha256 = roundSha256(roundFiles(await loadAll(repo), round));
    const frozen = raw.replace("frozen_sha256: null", `frozen_sha256: "${round.frozen_sha256}"`);
    await writeFile(round.path, frozen);
    const result = await check(await loadAll(repo), { fix: true });
    const stale = result.find((item) => item.path === round.path && item.rule === "generated");
    expect(stale?.message).toContain("Fix refused: this round is closed");
    expect(stale?.fixable).toBe(false);
    expect(result.map((item) => item.rule)).not.toContain("frozen-round-hash");
    expect(await readFile(round.path, "utf8")).toBe(frozen);
  });

  test("fix does not repair authored content, metadata, ids, TODO fields or hashes", async () => {
    const { repo, model } = await diskFixture();
    const stage = model.stages[0] as (typeof model.stages)[number];
    stage.status = "closed";
    stage.closed_sha256 = "a".repeat(64);
    const stageText = renderStage(stage);
    await writeFile(stage.path, stageText);
    const todoPath = model.todos[0]?.path as string;
    const todo = (await readFile(todoPath, "utf8")).replace("- Source: S01 (2026-10-06)\n", "");
    await writeFile(todoPath, todo);
    const results = await check(await loadAll(repo), { fix: true });
    expect(results.map((item) => item.rule)).toContain("closed-stage-hash");
    expect(results.map((item) => item.rule)).toContain("todo-fields");
    expect(await readFile(stage.path, "utf8")).toBe(stageText);
    expect(await readFile(todoPath, "utf8")).toBe(todo);
  });

  test("unparsable or unsupported files pause all repair instead of regenerating an incomplete model", async () => {
    const { repo, model } = await diskFixture();
    const index = model.index.path;
    const stale = replaceGenerated(await readFile(index, "utf8"), "rounds", "stale");
    await writeFile(index, stale);
    const adr = model.adrs[0] as (typeof model.adrs)[number];
    await writeFile(adr.path, renderAdr(adr).replace("format: 1", "format: 2"));
    const result = await check(await loadAll(repo), { fix: true });
    expect(result.map((item) => item.rule)).toContain("format");
    expect(await readFile(index, "utf8")).toBe(stale);
  });

  test("fix re-reads disk under the repository lock rather than applying a stale model", async () => {
    const { repo, model } = await diskFixture();
    const loaded = await loadAll(repo);
    const stage = model.stages[0] as (typeof model.stages)[number];
    await writeFile(stage.path, renderStage({ ...stage, title: "Changed by another session" }));
    expect(await check(loaded, { fix: true })).toEqual([]);
    expect(generatedContent(await readFile(model.rounds[0]?.path as string, "utf8"), "stages")).toContain("Changed by another session");
    expect(relative(repo.repoRoot, loaded.stages[0]?.path as string)).toBe("docs/roadmap/01-launch/stages/01-launch.md");
  });
});
