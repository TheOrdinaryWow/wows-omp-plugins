// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { indexClaims } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/claims-index.mjs";
import { DEFECT_CODES, FIDELITY_CODES } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/contracts.mjs";
import { checkFidelity } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-fidelity.mjs";

const FIXTURES = join(import.meta.dir, "tests", "fixtures"),
  FIX = join(FIXTURES, "fidelity"),
  read = (path) => readFileSync(path, "utf8"),
  OPTIONS = {
    ledger: JSON.parse(read(join(FIX, "ledger-verify.json"))),
    sourcesDir: join(FIX, "sources"),
    claims: indexClaims(read(join(FIX, "claim-graph.md"))),
    fillMap: null,
    brief: read(join(FIXTURES, "fidelity-brief-locked.md")),
    baseDir: FIX,
  };
function run(html, extra = {}) {
  return checkFidelity(html, { ...OPTIONS, ...extra });
}
const codes = (result) => result.defects.map((defect) => defect.code);
describe("checkFidelity", () => {
  test("#given the filled good report with a locked brief #when checked #then zero defects", () => {
    expect(run(read(join(FIX, "report-good.html"))).defects).toEqual([]);
  });
  test("#given the bad report #when checked #then the exact defect multiset, blockers first", () => {
    const result = run(read(join(FIX, "report-bad.html")));
    expect(codes(result)).toEqual([
      "unit_mismatch",
      "value_mismatch",
      "quote_not_verbatim",
      "unresolved_placeholder",
      "claim_status_invalid",
      "untraceable_number",
      "unbound_sentence",
    ]);
  });
  test("#given any defect #when emitted #then it has the check shape with severity and integrity from the contract", () => {
    for (const defect of run(read(join(FIX, "report-bad.html"))).defects) {
      expect(Object.keys(defect).sort()).toEqual(["code", "hint", "integrity", "line", "message", "selector", "severity"]);
      expect(defect.severity).toBe(DEFECT_CODES[defect.code].severity);
      expect(defect.integrity).toBe(DEFECT_CODES[defect.code].integrity);
    }
  });
  test("#given an unlocked brief #when checked #then only fidelity_interview_incomplete", () => {
    const result = run(read(join(FIX, "report-bad.html")), { brief: read(join(FIXTURES, "fidelity-brief-pending.md")) });
    expect(codes(result)).toEqual(["fidelity_interview_incomplete"]);
    expect(result.defects[0]?.integrity).toBe(true);
  });
  test("#given a row qualifier dropped in the report #when checked #then qualifier_dropped, and the :q rendering is clean", () => {
    const dropped = '<h2>Findings</h2><p>The span is <data class="fact" data-fact="F1" data-unit="m">320 m</data> long [S4].</p>';
    expect(codes(run(dropped))).toEqual(["qualifier_dropped"]);
    expect(run(dropped.replace(">320 m<", ">up to 320 m<")).defects).toEqual([]);
  });
  test("#given the gate #when it runs #then every code it reports is a fidelity code", () => {
    const { gatesRun } = run(read(join(FIX, "report-good.html")));
    expect(gatesRun.length).toBeGreaterThan(0);
    expect(gatesRun.every((code) => FIDELITY_CODES.includes(code))).toBe(true);
  });
});
