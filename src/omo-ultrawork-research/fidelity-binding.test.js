// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { indexClaims } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/claims-index.mjs";
import { bindingChecks } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-binding.mjs";
import { buildContext } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

const FIX = join(import.meta.dir, "tests", "fixtures", "fidelity"),
  LEDGER = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8")),
  CLAIMS = indexClaims(readFileSync(join(FIX, "claim-graph.md"), "utf8"));
function run(body, claims = CLAIMS) {
  const html = /<h2/.test(body)
    ? body
    : `<h2>Findings</h2>
${body}`;
  return bindingChecks(buildContext(parseHtml(html), {}), claims, LEDGER);
}
const codes = (defects) => defects.map((defect) => defect.code),
  fact = (id, text) => `<data class="fact" data-fact="${id}">${text}</data>`;
describe("sentence binding", () => {
  test("#given a findings paragraph with no marker #when checked #then unbound_sentence", () => {
    expect(codes(run("<p>The bridge is popular with tourists.</p>"))).toEqual(["unbound_sentence"]);
  });
  test("#given the same paragraph marked as opinion #when checked #then clean", () => {
    expect(run('<p data-kind="opinion">The bridge is popular with tourists.</p>')).toEqual([]);
  });
  test("#given a citation, a fact, or a claim on each sentence #when checked #then clean", () => {
    const body = `<p>Tourism grew [S4]. Units reached ${fact("F2", "1,237")}.</p><p data-claim="C1">The design follows the standard.</p>`;
    expect(run(body)).toEqual([]);
  });
  test("#given one unbound sentence after a cited one #when checked #then only that sentence is flagged", () => {
    expect(codes(run("<p>Tourism grew [S4]. Everyone loves it.</p>"))).toEqual(["unbound_sentence"]);
  });
  test("#given an unbound paragraph outside findings (appendix, closing, sources) #when checked #then out of scope", () => {
    expect(
      run("<h2>Appendix</h2><p>Plain words.</p><h2>How this report was made</h2><p>Plain words.</p><h2>Sources</h2><p>Plain words.</p>"),
    ).toEqual([]);
  });
});
describe("claim status", () => {
  test("#given a data-claim id that is not in the claim index #when checked #then claim_status_invalid", () => {
    expect(codes(run('<p data-claim="C99">The design is the safest.</p>'))).toEqual(["claim_status_invalid"]);
  });
  test("#given a refuted claim cited in findings #when checked #then claim_status_invalid", () => {
    expect(codes(run('<p data-claim="C3">The project finished early.</p>'))).toEqual(["claim_status_invalid"]);
  });
  test("#given the refuted claim in a Contradictions section #when checked #then clean", () => {
    expect(run('<h2>Contradictions</h2><p data-claim="C3">The project finished early.</p>')).toEqual([]);
  });
  test("#given a normal-risk partial claim not in verified-claims #when checked #then clean", () => {
    expect(run('<p data-claim="C2">Revenue grew about ten percent.</p>')).toEqual([]);
  });
  test("#given a high-risk claim missing from verified-claims #when checked #then claim_status_invalid", () => {
    expect(
      codes(
        run('<p data-claim="C7">A strong statement.</p>', {
          claims: [{ claim_id: "C7", statement: "x", risk: "high", status: "supported", in_verified: false }],
          errors: [],
        }),
      ),
    ).toEqual(["claim_status_invalid"]);
  });
});
describe("conflicting readings", () => {
  test("#given two 12 % rows with YoY and QoQ periods in one sentence #when checked #then conflicting_readings", () => {
    const body = `<p>Revenue grew ${fact("F3", "12%")} and ${fact("F4", "12%")} [S4].</p>`;
    expect(codes(run(body))).toEqual(["conflicting_readings"]);
  });
  test("#given the two readings in separate sentences #when checked #then clean", () => {
    const body = `<p>Revenue grew ${fact("F3", "12%")} [S4]. Quarterly growth was ${fact("F4", "12%")} [S4].</p>`;
    expect(run(body)).toEqual([]);
  });
});
