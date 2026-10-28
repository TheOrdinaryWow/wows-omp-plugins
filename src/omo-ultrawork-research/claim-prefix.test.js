// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { markdownAsHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-commands-verify.mjs";
import { fill } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-fill.mjs";
import { valueChecks } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-values.mjs";
import { buildContext } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";
import { parsePlaceholder, renderValueHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/placeholder.mjs";

const FIX = join(import.meta.dir, "tests", "fixtures", "fidelity"),
  BASE = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8")),
  row = (id) => BASE.rows.find((r) => r.fact_id === id),
  converted = { ...row("F8"), raw: "320,000 mm (320 m)", render: "320,000 mm (320 m)", derived_from: ["F1"] },
  assumed = {
    ...row("F8"),
    fact_id: "F9",
    kind: "assumed",
    label: "plan",
    raw: "15%",
    render: null,
    value: "15",
    unit: "%",
    derived_from: [],
    operands: [],
    operation: null,
  },
  ledger = { ...BASE, rows: [...BASE.rows.filter((r) => r.fact_id !== "F8"), converted, assumed] },
  check = (html) => valueChecks(buildContext(parseHtml(`<h2>Findings</h2>${html}`), { baseDir: FIX }), ledger, null, join(FIX, "sources"));
describe("claim prefixes come from the CLAIM_KINDS registry and combine with the pointer grammar", () => {
  test("#given a prefix before a value mode or a quote selector #when parsed #then the pointer keeps its mode and gains the claim kind", () => {
    expect(parsePlaceholder("{{D:F12:label}}")).toEqual({ id: "F12", kind: "F", label: "label", mode: "full", claimKind: "derived" });
    expect(parsePlaceholder("{{D:F12:label:value}}")).toEqual({
      id: "F12",
      kind: "F",
      label: "label",
      mode: "value",
      claimKind: "derived",
    });
    expect(parsePlaceholder("{{V:Q7:label:lead=3}}")).toMatchObject({ id: "Q7", mode: "lead", lead: 3, claimKind: "verified" });
    expect(parsePlaceholder("{{A:F9:plan}}")).toMatchObject({ id: "F9", claimKind: "assumed" });
  });
  for (const token of [
    "{{D:F12}}",
    "{{D:F12:}}",
    "{{D:F12:a:b}}",
    "{{V:F7}}",
    "{{A:}}",
    "{{X:F8:span_mm}}",
    "{{V:V:F7:test_pass}}",
    "{{D:F0:label}}",
  ])
    test(`#given the malformed ${token} #when filled #then unresolved_placeholder`, () => {
      const result = fill(token, ledger);
      expect(result.out).toBeNull();
      expect(result.errors.map((e) => e.code)).toEqual(["unresolved_placeholder"]);
    });
  for (const [token, code] of [
    ["{{A:F8:span_mm}}", "claim_kind_mismatch"],
    ["{{V:F8:span_mm}}", "unsupported_verification"],
  ])
    test(`#given ${token} on a row its kind refuses #when filled #then the kind's documented defect ${code}`, () => {
      const result = fill(token, ledger);
      expect(result.out).toBeNull();
      expect(result.errors.map((e) => e.code)).toEqual([code]);
    });
});
describe("renderValueHtml takes { mode, claimKind }", () => {
  test("#given a value-mode fact with a D claim #when rendered #then both the mode marker and the claim attribute are emitted", () => {
    const html = renderValueHtml(converted, "320,000", { mode: "value", claimKind: "derived" });
    expect(html).toContain('data-fact-mode="value"');
    expect(html).toContain('data-claim-kind="derived"');
    expect(renderValueHtml(converted, "320,000 mm")).not.toMatch(/data-fact-mode|data-claim-kind/);
  });
  test("#given {{D:F8:span_mm:value}} #when filled to HTML #then the element carries both attributes and the fill map records the mode", () => {
    const result = fill("<p>{{D:F8:span_mm:value}} mm</p>", ledger);
    expect(result.errors).toEqual([]);
    expect(result.out).toContain('data-fact-mode="value"');
    expect(result.out).toContain('data-claim-kind="derived"');
    expect(result.fillMap[0]).toMatchObject({ mode: "value", claimKind: "derived" });
  });
});
describe("prefixed fills verify clean in HTML and Markdown", () => {
  for (const [token, kind] of [
    ["{{V:F7:test_pass}}", "verified"],
    ["{{A:F9:plan}}", "assumed"],
    ["{{D:F8:span_mm}}", "derived"],
  ])
    for (const format of ["html", "md"])
      test(`#given ${token} filled as ${format} #when verified #then it carries ${kind} and raises nothing`, () => {
        const result = fill(format === "html" ? `<p>${token} [S4].</p>` : `${token} [S4].`, ledger, { format });
        expect(result.errors).toEqual([]);
        if (result.out === null) throw Error("fill failed");
        const html = format === "html" ? result.out : markdownAsHtml(result.out, result.fillMap, ledger).html;
        expect(html).toContain(`data-claim-kind="${kind}"`);
        expect(check(html)).toEqual([]);
      });
});
