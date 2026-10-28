// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CLAIM_ATTRIBUTE, CLAIM_KINDS, unmarkedKinds } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/claim-kinds.mjs";
import { DEFECT_CODES } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/contracts.mjs";
import { valueChecks } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-values.mjs";
import { buildContext } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

const FIX = join(import.meta.dir, "tests", "fixtures", "fidelity"),
  BASE = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8")),
  byId = (id) => BASE.rows.find((row) => row.fact_id === id),
  [F1, F7, F8, Q1] = ["F1", "F7", "F8", "Q1"].map(byId),
  plain = { render: null, operation: null, operands: [], derived_from: [], formula: null, factor: null },
  F9 = {
    ...F8,
    ...plain,
    fact_id: "F9",
    kind: "assumed",
    label: "growth_rate",
    raw: "15%",
    value: "15",
    unit: "%",
    exact: { num: "15", den: "1" },
    rationale: "planning assumption",
  },
  F10 = {
    ...F8,
    ...plain,
    fact_id: "F10",
    kind: "derived",
    label: "share_sum",
    raw: "39%",
    value: "39",
    unit: "%",
    exact: { num: "39", den: "1" },
    operation: "sum",
    operands: ["F5", "F6"],
  },
  F11 = { ...F7, fact_id: "F11", locator: null },
  F12 = { ...F7, fact_id: "F12", locator: { artifact: "missing.txt", char_start: 0, char_end: 9 } },
  F13 = { ...F7, fact_id: "F13", locator: { artifact: "../S4/text.txt", char_start: 0, char_end: 9 } },
  LEDGER = { ...BASE, rows: [...BASE.rows, F9, F10, F11, F12, F13] },
  SUBJECTS = [F1, F7, F8, F9, F10, F11, F12, F13, Q1],
  ORACLE = {
    fact: { rows: ["measured", "converted", "derived"], command: false },
    quote: { rows: ["quote"], command: false },
    verified: { rows: ["measured", "quote"], command: true },
    derived: { rows: ["derived", "converted"], command: false },
    assumed: { rows: ["assumed"], command: false },
  },
  UNMARKED_REFUSED = new Set(["F9"]),
  COMMAND_BACKED = new Set(["F7"]),
  MAJOR_FOR = {
    fact: "claim_kind_mismatch",
    quote: "claim_kind_mismatch",
    verified: "unsupported_verification",
    derived: "claim_kind_mismatch",
    assumed: "claim_kind_mismatch",
  },
  expected = (kind, row) => {
    const rule = ORACLE[kind];
    return rule.rows.includes(row.kind) && (!rule.command || COMMAND_BACKED.has(row.fact_id)) ? [] : [MAJOR_FOR[kind]];
  },
  CLAIM_CODES = new Set(["claim_kind_mismatch", "unsupported_verification", "verification_claim_unmarked"]),
  run = (body) =>
    valueChecks(
      buildContext(
        parseHtml(`<h2>Findings</h2>
${body}`),
        { baseDir: FIX },
      ),
      LEDGER,
      null,
      join(FIX, "sources"),
      {},
    ),
  claims = (body) => run(body).filter((d) => CLAIM_CODES.has(d.code)),
  codes = (body) =>
    claims(body)
      .map((d) => d.code)
      .sort(),
  value = (row, kind) => {
    const mark = kind ? ` ${CLAIM_ATTRIBUTE}="${kind}"` : "";
    return row.kind === "quote"
      ? `<q data-fact="${row.fact_id}"${mark} data-quote-sel="full">${row.quote}</q>`
      : `<data class="fact"${mark} data-fact="${row.fact_id}">${row.raw}</data>`;
  },
  prose = (inner, lead = "The figure is") => `<p>${lead} ${inner} [S4].</p>`,
  cell = (inner) => `<table><tr><th>Item</th><td>${inner}</td></tr></table>`;
describe("every claim kind against the hand-written oracle", () => {
  for (const kind of Object.keys(ORACLE))
    for (const row of SUBJECTS) {
      const want = expected(kind, row),
        label = want.length === 0 ? "no claim defect" : `${want[0]} major`;
      test(`#given ${kind} marked on ${row.fact_id} (${row.kind}) in prose and in a table cell #then ${label}`, () => {
        for (const body of [prose(value(row, kind)), cell(value(row, kind))]) {
          expect(codes(body)).toEqual(want);
          for (const defect of claims(body)) expect(defect.severity).toBe("major");
        }
      });
      test(`#given ${kind} marked on an enclosing element over ${row.fact_id} #then the parent's mark binds it: ${label}`, () => {
        expect(codes(`<p><span ${CLAIM_ATTRIBUTE}="${kind}">The figure is ${value(row)}</span> [S4].</p>`)).toEqual(want);
      });
      test(`#given ${kind} marked on ${row.fact_id} beside an unmarked command row #then the neighbour never satisfies it: ${label}`, () => {
        expect(codes(prose(`${value(row, kind)}, and the suite reported ${value(F7)}`))).toEqual(want);
      });
      for (const inner of Object.keys(ORACLE).filter((other) => other !== kind))
        test(`#given ${inner} nested inside ${kind} over ${row.fact_id} #then mismatch, the parent owns nothing, and the inner kind is still checked`, () => {
          const body = `<p><span ${CLAIM_ATTRIBUTE}="${kind}">The figure is ${value(row, inner)}</span> [S4].</p>`;
          expect(codes(body)).toEqual(["claim_kind_mismatch", MAJOR_FOR[kind], ...expected(inner, row)].sort());
        });
    }
  for (const row of SUBJECTS) {
    const refused = UNMARKED_REFUSED.has(row.fact_id) ? ["claim_kind_mismatch:major"] : [],
      refusedLabel = refused.length ? "claim_kind_mismatch major" : "no claim code";
    test(`#given ${row.fact_id} unmarked in a first-person run sentence #then the minor verification_claim_unmarked, plus ${refusedLabel}`, () => {
      const found = claims(prose(value(row), "We ran the check and it reported"));
      expect(found.map((d) => `${d.code}:${d.severity}`).sort()).toEqual([...refused, "verification_claim_unmarked:minor"].sort());
    });
    test(`#given ${row.fact_id} unmarked in a plain sentence in prose and in a table cell #then ${refusedLabel}`, () => {
      for (const body of [prose(value(row)), cell(value(row))]) expect(claims(body).map((d) => `${d.code}:${d.severity}`)).toEqual(refused);
    });
  }
  test("#given an unknown claim kind #then claim_kind_mismatch", () => {
    expect(codes(prose(value(F1, "rumoured")))).toEqual(["claim_kind_mismatch"]);
  });
  test("#given every defect and warning code the table names #then contracts defines it, and warnings are never major", () => {
    for (const entry of Object.values(CLAIM_KINDS)) {
      expect(DEFECT_CODES[entry.defect]).toBeDefined();
      if (entry.unmarked) expect(DEFECT_CODES[entry.unmarked.code].severity).toBe("minor");
    }
  });
});
describe("design-check regressions", () => {
  test("#given verified wrapping a fact-marked page row (F1 shadowing) #then the parent is unsupported and the nesting is a mismatch", () => {
    expect(codes(`<p><span ${CLAIM_ATTRIBUTE}="verified">The inspection put the span at ${value(F1, "fact")}</span> [S4].</p>`)).toEqual([
      "claim_kind_mismatch",
      "unsupported_verification",
    ]);
  });
  test("#given one verified value and an unmarked value in the same run sentence (F2) #then the unmarked one still warns", () => {
    expect(codes(prose(`${value(F7, "verified")}, and the span is ${value(F1)}`, "We ran the suite and it reported"))).toEqual([
      "verification_claim_unmarked",
    ]);
  });
  test("#given a truthful converted and derived value marked fact (F3) #then no stricter than unmarked", () => {
    for (const row of [F8, F9, F10]) expect(codes(prose(value(row, "fact")))).toEqual(codes(prose(value(row))));
    expect(codes(prose(value(F8, "fact")))).toEqual([]);
  });
  test("#given the assumed row F9 unmarked or marked fact #then both refuse it, and the unmarked message names the A mark", () => {
    expect(codes(prose(value(F9)))).toEqual(["claim_kind_mismatch"]);
    expect(codes(prose(value(F9, "fact")))).toEqual(["claim_kind_mismatch"]);
    expect(JSON.stringify(claims(prose(value(F9))))).toContain("{{A:F9:growth_rate}}");
  });
  test("#given the assumed row F9 marked {{A:F9}} (data-claim-kind=assumed) #then no claim defect", () => {
    expect(codes(prose(value(F9, "assumed")))).toEqual([]);
    expect(codes(cell(value(F9, "assumed")))).toEqual([]);
  });
  test("#given verified citing a command-sourced row with no, a missing, or an escaping locator artifact (F4) #then unsupported_verification", () => {
    for (const row of [F11, F12, F13]) expect(codes(prose(value(row, "verified")))).toEqual(["unsupported_verification"]);
  });
});
describe("unmarked phrases", () => {
  const fires = [
      "We verified the span by running the measurement script.",
      "We ran the suite twice.",
      "We executed the export.",
      "We verified by hand-counting the rows.",
      "We have run the tests.",
      "I ran the suite.",
      "Our numbers were obtained by running the script.",
      "\uC6B0\uB9AC\uAC00 \uC2E4\uD589\uD574 \uD655\uC778\uD55C \uAE38\uC774",
      "\uC800\uD76C\uAC00 \uC2A4\uD06C\uB9BD\uD2B8\uB97C \uC2E4\uD589\uD558\uC5EC \uAC80\uC99D\uD55C \uAC12",
      "\uC800\uD76C\uAC00 \uD14C\uC2A4\uD2B8\uB97C \uB3CC\uB838\uB2E4",
      "\uC6B0\uB9AC \uD300\uC774 \uBCA4\uCE58\uB9C8\uD06C\uB97C \uB3CC\uB824 \uC5BB\uC740 \uAC12",
      "\uADF8\uB798\uC11C \uC6B0\uB9AC\uB294 \uC2A4\uD06C\uB9BD\uD2B8\uB97C \uC2E4\uD589\uD588\uB2E4",
      "\uC9C1\uC811 \uC2E4\uD589\uD55C \uACB0\uACFC",
      "\uC6B0\uB9AC\uB294 \uACB0\uACFC\uB97C \uD655\uC778\uD588\uB2E4",
      "We confirmed the result.",
      "We verified the span against the field log.",
      "We double-checked the totals.",
      "We cross-checked the values.",
      "We\u2019ve confirmed the result.",
      "We confirmed that the recorded span is up to 320 m.",
      "We measured 42 ms.",
      "\uC800\uD76C\uB294 \uCE21\uC815\uAC12 320 m\uB97C \uAC80\uC99D\uD588\uB2E4",
      "We measured a latency of 40 ms, as this report shows.",
      "We verified the value on page 3.",
      "We checked the totals, which the filing also lists.",
      "\uC6B0\uB9AC\uB294 \uACB0\uACFC\uB97C \uD655\uC778\uD558\uC600\uB2E4",
      "\uC6B0\uB9AC\uB294 \uC2E4\uD589 \uACB0\uACFC\uB97C \uAC80\uC99D\uD558\uC600\uB2E4",
      "\uC6B0\uB9AC\uB294 \uC9C0\uC5F0 \uC2DC\uAC04 40 ms\uB97C \uCE21\uC815\uD588\uACE0, \uBCF4\uACE0\uC11C\uB3C4 \uAC19\uC740 \uAC12\uC744 \uC801\uC5C8\uB2E4",
    ],
    quiet = [
      "The tests showed a 12 % drop.",
      "The bridge, which ran across the river, spans 320 m.",
      "The span, as confirmed with the annual inspection report, is 320 m.",
      "Clinical tests confirmed the diagnosis.",
      "The authors obtained estimates by running simulations.",
      "We ran out of time.",
      "\uD655\uC778\uB41C \uAE38\uC774\uB294 \uCD5C\uB300 320 m",
      "\uAC1C\uBC1C\uC790\uAC00 \uC9C1\uC811 \uC2E4\uD589\uD55C \uACB0\uACFC\uB97C \uBCF4\uACE0\uD588\uB2E4",
      "\uC2E4\uD589\uD574 \uD655\uC778\uD55C \uAE38\uC774",
      "\uC6B0\uB9AC\uB098\uB77C\uC5D0\uC11C \uC2E4\uD589\uB41C \uC815\uCC45\uC740 320\uAC1C\uB2E4",
      "\uC6B0\uB9AC \uC815\uBD80\uAC00 \uC2E4\uD589\uD55C \uC608\uC0B0",
      "\uC6B0\uB9AC\uAC00 \uC758\uB8B0\uD55C \uC5C5\uCCB4\uAC00 \uD14C\uC2A4\uD2B8\uB97C \uB3CC\uB838\uB2E4",
      "We checked the box to opt in.",
      "As we observed in Section 2, demand is seasonal.",
      "The values we observed were higher than the 2023 baseline.",
      "We checked into the hotel.",
      "We checked in at the hotel.",
      "In Phase I observed values rose.",
      "We confirmed the figure against the 2024 annual report.",
      "We use confirmed values, validated inputs, checked references, observed events, and measured responses.",
      "The authors confirmed that the value was measured.",
      "\uC6B0\uB9AC\uB294 \uBCF4\uACE0\uC11C\uC758 \uC218\uCE58\uB97C \uD655\uC778\uD588\uB2E4",
      "\uC6B0\uB9AC\uB294 \uC77C\uC815\uC744 \uD655\uC778\uD588\uB2E4",
      "\uC6B0\uB9AC\uB294 \uACF5\uC2DC \uC790\uB8CC\uC758 \uC218\uCE58\uB97C \uD655\uC778\uD558\uC600\uB2E4",
      "We measured the latency in the published report.",
    ];
  for (const text of fires) test(`#given "${text}" #then verified`, () => expect(unmarkedKinds(text)).toEqual(["verified"]));
  for (const text of quiet) test(`#given "${text}" #then nothing`, () => expect(unmarkedKinds(text)).toEqual([]));
});
