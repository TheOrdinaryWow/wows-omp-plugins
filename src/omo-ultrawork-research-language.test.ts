import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFact } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-commands.mjs";
import { readLedger } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-ledger.mjs";
import { runSource } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/source-commands.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Chinese fact and quote prose survives snapshot, locator, fill, and exact-value verification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-chinese-"));
  roots.push(dir);
  const source = join(dir, "source.txt");
  writeFileSync(source, "桥梁长度为 320 m。项目仍在研究阶段。\n");
  writeFileSync(
    join(dir, "brief.md"),
    [
      "## Fidelity",
      "as of: latest at run start, 2026-10-28 (answered_by: request)",
      "meaning check: off (answered_by: request)",
      "source floor: standard (answered_by: default)",
      "derived numbers: allowed (answered_by: default)",
      "languages: report zh; sources zh; quotes original (answered_by: request)",
      "identifier classes: none (answered_by: default)",
      "fallback: block-quote (answered_by: default)",
      "asked:",
      "",
    ].join("\n"),
  );
  const session = ["--session-dir", dir];
  expect((await runSource(["snapshot", "--id", "S1", "--text", source, "--provenance", "primary", ...session])).exitCode).toBe(0);
  expect((await runFact(["add", "--source", "S1", "--find", "桥梁长度为", "--label", "span_len", ...session])).exitCode).toBe(0);
  expect((await runFact(["quote", "--source", "S1", "--match", "项目仍在研究阶段", "--label", "caveat", ...session])).exitCode).toBe(0);
  const ledger = readLedger(dir);
  const fact = ledger.rows.find((row: { kind: string }) => row.kind === "measured");
  const quote = ledger.rows.find((row: { kind: string }) => row.kind === "quote");
  expect(fact.value).toBe("320");
  expect(quote.quote).toContain("项目仍在研究阶段");
  const template = join(dir, "report.src.html");
  const report = join(dir, "report.html");
  writeFileSync(
    template,
    `<html lang="zh"><head><title>调查结果</title></head><body><main><p>桥梁长度为 {{${fact.fact_id}:span_len}} [S1]。</p><p>{{${quote.fact_id}:caveat}}</p></main></body></html>`,
  );
  expect((await runFact(["fill", template, "--out", report, ...session])).exitCode).toBe(0);
  expect(await runFact(["verify", report, ...session])).toMatchObject({ exitCode: 0 });
  writeFileSync(report, readFileSync(report, "utf8").replace("320", "321"));
  expect((await runFact(["verify", report, ...session])).exitCode).toBe(1);
  const rejected = JSON.parse(readFileSync(join(dir, "fidelity-defects.json"), "utf8"));
  expect(rejected.defects).toContainEqual(expect.objectContaining({ code: "value_mismatch" }));
});
