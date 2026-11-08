// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Of } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/cli-support.mjs";
import { runFactPolish } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-commands-polish.mjs";
import { runFactVerify } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-commands-verify.mjs";
import { parseFidelityBlock } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-brief.mjs";
import { briefHashOf } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-policy.mjs";
import { valueChecks } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-values.mjs";
import { buildContext } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

const FIX = join(import.meta.dir, "tests", "fixtures"),
  ledger = () => JSON.parse(readFileSync(join(FIX, "fidelity", "ledger-verify.json"), "utf8")),
  check = (html, book, options = {}) =>
    valueChecks(buildContext(parseHtml(html), {}), book, null, join(FIX, "fidelity", "sources"), options),
  codes = (defects) => defects.map((d) => d.code);
test("revision v1 does not match the brief's v12", () => {
  const book = ledger();
  book.rows.find((r) => r.fact_id === "Q1").revision = "v1";
  const html = '<p><q data-fact="Q1">we estimate completion no earlier than 2027</q></p>';
  expect(check(html, book, { asOf: "v12 release" }).map((d) => d.code)).toContain("quote_stale_version");
  expect(check(html, book, { asOf: "v1 release" })).toEqual([]);
});
test("a sentence-final period after the brief's revision still matches it", () => {
  const book = ledger();
  book.rows.find((r) => r.fact_id === "Q1").revision = "v1.2";
  const html = '<p><q data-fact="Q1">we estimate completion no earlier than 2027</q></p>';
  expect(check(html, book, { asOf: "release v1.2." })).toEqual([]);
  expect(codes(check(html, book, { asOf: "release v1.2.3." }))).toContain("quote_stale_version");
  expect(codes(check(html, book, { asOf: "release v1.20." }))).toContain("quote_stale_version");
});
test("an operand id absent from the ledger is operand_missing, not a missing timestamp", () => {
  const book = ledger(),
    row = book.rows.find((r) => r.fact_id === "F8");
  row.snapshot_window = { dataset_id: "d1", start: "2026-09-01T00:00:00Z", end: "2026-11-01T00:00:00Z" };
  row.operands = ["F99"];
  const found = codes(check('<p><data data-fact="F8">320,000 mm (320 m)</data></p>', book));
  expect(found).toContain("operand_missing");
  expect(found).not.toContain("operand_timestamp_missing");
  expect(found).not.toContain("snapshot_mismatch");
});
test("missing operand observed_at is not a snapshot window mismatch", () => {
  const book = ledger(),
    row = book.rows.find((r) => r.fact_id === "F8");
  row.snapshot_window = { dataset_id: "d1", start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" };
  delete book.rows.find((r) => r.fact_id === row.operands[0]).observed_at;
  const defects = check('<p><data data-fact="F8">320,000 mm (320 m)</data></p>', book);
  expect(defects.map((d) => d.code)).toContain("operand_timestamp_missing");
  expect(defects.map((d) => d.code)).not.toContain("snapshot_mismatch");
  expect(defects.find((d) => d.code === "operand_timestamp_missing").message).toContain("observed_at");
});
test("polished edition retains original brief binding after brief changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "polish-binding-"));
  onTestFinished(() => rmSync(dir, { recursive: !0, force: !0 }));
  const brief = readFileSync(join(FIX, "fidelity-brief-locked.md"), "utf8"),
    report = join(dir, "report.html"),
    output = join(dir, "polished.html"),
    html = "<html><body><p>The overview remains clear.</p></body></html>";
  writeFileSync(join(dir, "brief.md"), brief);
  writeFileSync(join(dir, "fact-ledger.json"), JSON.stringify({ schemaVersion: 1, rows: [], events: [] }));
  writeFileSync(report, html);
  writeFileSync(
    `${report}.fill-map.json`,
    JSON.stringify({
      format: "html",
      artifact: report,
      artifact_sha256: sha256Of(html),
      entries: [],
      brief_sha256: briefHashOf(parseFidelityBlock(brief)),
    }),
  );
  writeFileSync(join(dir, "edits.json"), "[]");
  expect(runFactPolish("polish-apply", [report, "--session-dir", dir, "--edits", join(dir, "edits.json"), "--out", output]).exitCode).toBe(
    0,
  );
  const verified = () => codes(runFactVerify({ positionals: [output], flags: { "session-dir": dir } }).json.defects);
  expect(verified()).not.toContain("brief_changed");
  writeFileSync(join(dir, "brief.md"), brief.replace("derived numbers: allowed", "derived numbers: none"));
  expect(verified()).toContain("brief_changed");
  expect(existsSync(`${output}.fill-map.json`)).toBe(!1);
  const map = JSON.parse(readFileSync(`${output}.polished.fill-map.json`, "utf8"));
  expect(map.brief_sha256).toBe(briefHashOf(parseFidelityBlock(brief)));
});
