// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  codesOf,
  FIXTURES,
  fidelitySession,
  fillTemplate,
  ledgerRow,
  NOW,
  nodeJson,
  pairedSession,
  setField,
  textSource,
  verdicts,
  verify,
} from "./tests/report-tools-support.js";

describe("fidelity brief lock and policy under node", () => {
  test("#given a filled session whose brief turns pending #when each reader-facing command runs #then all six exit 1 with only fidelity_interview_incomplete and write nothing", () => {
    const { dir, s } = pairedSession();
    copyFileSync(join(FIXTURES, "fidelity-brief-pending.md"), join(dir, "brief.md"));
    for (const name of ["fidelity-defects.json", "pairs.json"]) rmSync(join(dir, name), { force: !0 });
    const drift = verdicts(dir, "cheap.json", "cheap", []);
    writeFileSync(join(dir, "edits.json"), "[]");
    const runs = {
      fill: nodeJson(["fact", "fill", join(dir, "report.src.html"), "--out", join(dir, "again.html"), ...s]),
      verify: verify(dir, "report.html"),
      pairs: nodeJson(["fact", "pairs", join(dir, "report.html"), "--out", join(dir, "pairs.json"), ...s]),
      meaning: nodeJson(["fact", "meaning-check", "--pairs", join(dir, "absent-pairs.json"), "--verdicts", drift, ...s]),
      polishApply: nodeJson([
        "fact",
        "polish-apply",
        join(dir, "report.html"),
        "--edits",
        join(dir, "edits.json"),
        "--out",
        join(dir, "polished.html"),
        ...s,
      ]),
      polishDiff: nodeJson([
        "fact",
        "polish-diff",
        "--before",
        join(dir, "report.html"),
        "--after",
        join(dir, "report.html"),
        "--out",
        join(dir, "polish.json"),
        ...s,
      ]),
    };
    for (const [name, result] of Object.entries(runs))
      expect({ name, code: result.code, codes: codesOf(result.json) }).toEqual({ name, code: 1, codes: ["fidelity_interview_incomplete"] });
    for (const name of [
      "again.html",
      "fidelity-defects.json",
      "pairs.json",
      "polished.html",
      "polish.json",
      "fidelity-meaning-defects.json",
    ])
      expect({ name, exists: existsSync(join(dir, name)) }).toEqual({ name, exists: !1 });
  });
  test("#given derived numbers none #when a derived or a converted placeholder is filled #then derived_not_allowed, and allowed renders both", () => {
    const { dir, s, mm } = fidelitySession(),
      expr = nodeJson([
        "fact",
        "derive",
        "--op",
        "expr",
        "F1 * 2",
        "--unit",
        "m",
        "--rationale",
        "two spans",
        "--label",
        "two_spans",
        "--now",
        NOW,
        "--json",
        ...s,
      ]),
      twice = expr.json.data.row.fact_id;
    setField(dir, "derived numbers", "none");
    const derived = fillTemplate(dir, `<p>Two spans are {{${twice}:two_spans}} [S4].</p>`),
      converted = fillTemplate(dir, `<p>The span is {{${mm}:span_mm}} [S4].</p>`);
    setField(dir, "derived numbers", "allowed");
    const allowed = fillTemplate(dir, `<p>Two spans are {{${twice}:two_spans}} [S4]. The span is {{${mm}:span_mm}} [S4].</p>`);
    expect(expr.code).toBe(0);
    expect([derived.code, codesOf(derived.json)]).toEqual([1, ["derived_not_allowed"]]);
    expect([converted.code, codesOf(converted.json)]).toEqual([1, ["derived_not_allowed"]]);
    expect(allowed.code).toBe(0);
    expect(readFileSync(join(dir, "t.html"), "utf8")).toContain("320,000 mm");
  });
  test("#given source floor primary only #when rows from secondary, unknown, and primary sources are filled #then only the primary row renders", () => {
    const { dir } = fidelitySession(),
      secondary = textSource(dir, "S7", "secondary"),
      unknown = textSource(dir, "S8"),
      primary = textSource(dir, "S6", "primary");
    setField(dir, "source floor", "primary only");
    const fills = [secondary, unknown, primary].map(({ row }) =>
      fillTemplate(dir, `<p>The span is {{${row.fact_id}:${row.label}}} [S4].</p>`),
    );
    expect([secondary.snap.json, unknown.snap.json, primary.snap.json].map((json) => json.data.provenance)).toEqual([
      "secondary",
      "unknown",
      "primary",
    ]);
    expect(fills.map((f) => [f.code, codesOf(f.json)])).toEqual([
      [1, ["source_outside_floor"]],
      [1, ["source_outside_floor"]],
      [0, []],
    ]);
  });
  test("#given a row registered while source floor is pending #when the floor locks to pointed only S4, then standard #then fill refuses, then renders, and outside_floor caches each result", () => {
    const { dir } = fidelitySession();
    setField(dir, "source floor", "pending", "pending");
    const { snap, row } = textSource(dir, "S9"),
      body = `<p>The span is {{${row.fact_id}:${row.label}}} [S9].</p>`;
    setField(dir, "source floor", "pointed only: S4");
    const refused = fillTemplate(dir, body),
      cachedRefused = ledgerRow(dir, row.fact_id).outside_floor;
    setField(dir, "source floor", "standard");
    const rendered = fillTemplate(dir, body);
    expect(snap.code).toBe(0);
    expect(row.outside_floor).toBe(!1);
    expect([refused.code, codesOf(refused.json)]).toEqual([1, ["source_outside_floor"]]);
    expect(cachedRefused).toBe(!0);
    expect(rendered.code).toBe(0);
    expect(ledgerRow(dir, row.fact_id).outside_floor).toBe(!1);
  });
  test("#given a markdown translation comment after a quote #when languages is translation beside, then quotes original #then fact pairs emits a translation pair only for the first", () => {
    const { dir, s } = fidelitySession(),
      md = [
        "# T",
        "",
        "## Findings",
        "",
        "The operator wrote {{Q1:completion}} <!-- translates: Q1 --> completion comes in 2027 at the earliest [S4].",
        "",
      ].join(`
`);
    writeFileSync(join(dir, "t.src.md"), md);
    const kinds = () => {
        const filled = nodeJson(["fact", "fill", join(dir, "t.src.md"), "--format", "md", "--out", join(dir, "t.md"), ...s]),
          pairs = nodeJson(["fact", "pairs", join(dir, "t.md"), "--out", join(dir, "pairs.json"), ...s]);
        return {
          fill: filled.code,
          pairs: pairs.code,
          kinds: JSON.parse(readFileSync(join(dir, "pairs.json"), "utf8")).pairs.map((p) => p.kind),
        };
      },
      beside = kinds();
    setField(dir, "languages", "report en; sources en; quotes original");
    const original = kinds();
    expect(beside).toEqual({ fill: 0, pairs: 0, kinds: ["quote", "translation"] });
    expect(original).toEqual({ fill: 0, pairs: 0, kinds: ["quote"] });
  });
  test("#given a sentence that failed twice #when filled with --replace-failed #then block-quote replaces it and fallback omit removes it", () => {
    const { dir } = fidelitySession(),
      state = { schemaVersion: 1, failures: { "findings#F1": 2 }, replaced: [] },
      body = "<p>The span length is {{F1:span_len}} [S4]. The operator wrote {{Q1:completion}} [S4].</p>";
    writeFileSync(join(dir, "fidelity-state.json"), JSON.stringify(state));
    const quoted = fillTemplate(dir, body, ["--replace-failed"]),
      quotedHtml = readFileSync(join(dir, "t.html"), "utf8");
    setField(dir, "fallback", "omit");
    writeFileSync(join(dir, "fidelity-state.json"), JSON.stringify(state));
    const omitted = fillTemplate(dir, body, ["--replace-failed"]),
      omittedHtml = readFileSync(join(dir, "t.html"), "utf8");
    expect(quoted.code).toBe(0);
    expect(quotedHtml).toContain("<blockquote");
    expect(omitted.code).toBe(0);
    expect(omittedHtml).not.toContain("<blockquote");
    expect(omittedHtml).not.toContain("The span length is");
    expect(omittedHtml).toContain("The operator wrote");
  });
  test("#given --calibration #when meaning-check flags a pair #then the calibration line goes to that path, not the session default", () => {
    const { dir, s } = pairedSession(),
      drift = {
        pair_id: "P2",
        verdict: "drift",
        drift_kind: "hedge_dropped",
        fragment: "no earlier than 2027",
        source_fragment: "we estimate",
      },
      log = join(dir, "custom-calibration.jsonl"),
      checked = nodeJson([
        "fact",
        "meaning-check",
        "--pairs",
        join(dir, "pairs.json"),
        "--verdicts",
        verdicts(dir, "cheap.json", "cheap", [drift, { pair_id: "P1", verdict: "ok" }]),
        "--calibration",
        log,
        ...s,
      ]),
      rows = readFileSync(log, "utf8")
        .trim()
        .split(`
`)
        .map((line) => JSON.parse(line))
        .filter((row) => row.header !== !0 && row.run !== !0);
    expect(checked.code).toBe(0);
    expect(rows).toHaveLength(1);
    expect(existsSync(join(dir, "fidelity-calibration.jsonl"))).toBe(!1);
  });
});
describe("fidelity brief values, sourceless rows, and the brief binding under node", () => {
  test("#given derived numbers or fallback off its table #when fact fill runs #then a usage error names the field and value and nothing is written", () => {
    const { dir, s } = fidelitySession(),
      twice = nodeJson([
        "fact",
        "derive",
        "--op",
        "expr",
        "F1 * 2",
        "--unit",
        "m",
        "--rationale",
        "two spans",
        "--label",
        "two_spans",
        "--now",
        NOW,
        "--json",
        ...s,
      ]).json.data.row.fact_id;
    setField(dir, "derived numbers", "nope");
    const derived = fillTemplate(dir, `<p>Two spans are {{${twice}:two_spans}} [S4].</p>`);
    setField(dir, "derived numbers", "allowed");
    setField(dir, "fallback", "drop");
    const fallback = fillTemplate(dir, "<p>The span length is {{F1:span_len}} [S4].</p>");
    expect({ code: derived.code, named: derived.stderr.includes('derived numbers "nope"') }).toEqual({ code: 2, named: !0 });
    expect({ code: fallback.code, named: fallback.stderr.includes('fallback "drop"') }).toEqual({ code: 2, named: !0 });
    expect(existsSync(join(dir, "t.html"))).toBe(!1);
  });
  test("#given an assumed row #when filled under primary only, then standard #then the sourceless row is source_outside_floor, then renders", () => {
    const { dir, s } = fidelitySession(),
      body = `<p>The planning share is {{${nodeJson(["fact", "add", "--assumed", "12", "--unit", "%", "--rationale", "planning share chosen by the requester", "--label", "share_assumed", "--json", ...s]).json.data.row.fact_id}:share_assumed}}.</p>`;
    setField(dir, "source floor", "primary only");
    const refused = fillTemplate(dir, body);
    setField(dir, "source floor", "standard");
    const rendered = fillTemplate(dir, body);
    expect([refused.code, codesOf(refused.json)]).toEqual([1, ["source_outside_floor"]]);
    expect(JSON.stringify(refused.json)).toContain("no source");
    expect(rendered.code).toBe(0);
  });
  test("#given a derived row whose operand rests on a secondary source #when filled under primary only #then source_outside_floor names that source", () => {
    const { dir, s } = fidelitySession(),
      { row } = textSource(dir, "S7", "secondary"),
      twice = nodeJson([
        "fact",
        "derive",
        "--op",
        "expr",
        `${row.fact_id} * 2`,
        "--unit",
        "m",
        "--rationale",
        "two spans",
        "--label",
        "two_spans",
        "--now",
        NOW,
        "--json",
        ...s,
      ]).json.data.row.fact_id;
    setField(dir, "source floor", "primary only");
    const refused = fillTemplate(dir, `<p>Two spans are {{${twice}:two_spans}} [S7].</p>`);
    expect([refused.code, codesOf(refused.json)]).toEqual([1, ["source_outside_floor"]]);
    expect(JSON.stringify(refused.json)).toContain("rests on S7");
  });
  test("#given an edition filled under standard from a secondary source #when the brief tightens to primary only #then fact verify refuses with and without its fill map", () => {
    const { dir, s } = fidelitySession(),
      { row } = textSource(dir, "S7", "secondary"),
      src = readFileSync(join(dir, "report.src.html"), "utf8")
        .replace(
          "<h2>How",
          `<p>A review gives the span as {{${row.fact_id}:${row.label}}} [S7].</p>
<h2>How`,
        )
        .replace("</ol>", '<li id="s7">[S7] Bridge review, retrieved 2026-10-01.</li></ol>');
    writeFileSync(join(dir, "report.src.html"), src);
    const filled = nodeJson(["fact", "fill", join(dir, "report.src.html"), "--out", join(dir, "report.html"), ...s]),
      map = join(dir, "report.html.fill-map.json"),
      before = verify(dir, "report.html");
    setField(dir, "source floor", "primary only");
    const bound = verify(dir, "report.html"),
      record = JSON.parse(readFileSync(join(dir, "fidelity-defects.json"), "utf8")),
      kept = readFileSync(map, "utf8");
    rmSync(map);
    const unbound = verify(dir, "report.html");
    setField(dir, "source floor", "standard");
    const { brief_sha256: _dropped, ...legacy } = JSON.parse(kept);
    writeFileSync(map, JSON.stringify(legacy));
    const unstamped = verify(dir, "report.html");
    expect([filled.code, before.code, codesOf(before.json)]).toEqual([0, 0, []]);
    expect(typeof JSON.parse(kept).brief_sha256).toBe("string");
    expect(bound.code).toBe(1);
    expect(codesOf(bound.json)).toContain("brief_changed");
    expect(codesOf(bound.json)).toContain("source_outside_floor");
    expect(record.status).toBe("fail");
    expect(unbound.code).toBe(1);
    expect(codesOf(unbound.json)).toContain("source_outside_floor");
    expect(codesOf(unbound.json)).toContain("brief_changed");
    expect([unstamped.code, codesOf(unstamped.json)]).toEqual([1, ["brief_changed"]]);
  });
});
