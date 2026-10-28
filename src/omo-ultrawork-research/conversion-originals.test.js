// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { markdownAsHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-commands-verify.mjs";
import { derive } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-derive.mjs";
import { fill } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-fill.mjs";
import { addRow, emptyLedger } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-ledger.mjs";
import { valueChecks } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-values.mjs";
import { checkFidelity } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-fidelity.mjs";
import { buildContext } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

const FIX = join(import.meta.dir, "tests", "fixtures", "fidelity"),
  BASE = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8")),
  BRIEF = readFileSync(join(FIX, "..", "fidelity-brief-locked.md"), "utf8"),
  DERIVED = { ...BASE, rows: BASE.rows.map((r) => (r.fact_id === "F8" ? { ...r, raw: r.render } : r)) },
  check = (html, ledger = DERIVED, sources = join(FIX, "sources")) =>
    valueChecks(buildContext(parseHtml(`<h2>Findings</h2>${html}`), { baseDir: FIX }), ledger, null, sources),
  data = (id, shown) => `<p><data data-fact="${id}">${shown}</data></p>`,
  rowOf = (ledger, id) => ledger.rows.find((r) => r.fact_id === id);
function measured(id, value, unit, extra = {}) {
  return {
    fact_id: id,
    kind: "measured",
    value,
    unit,
    raw: `${value} ${unit}`,
    quote: `The figure is ${value} ${unit}.`,
    source_id: "S1",
    locator: { artifact: "sources/S1/text.txt", char_start: 0, char_end: 5 },
    snapshot_sha256: "a".repeat(64),
    extracted_by: "fact add --find",
    observed_at: "2026-10-23T08:00:00Z",
    label: id.toLowerCase(),
    ...extra,
  };
}
function derivedReport(rows, spec) {
  const ledger = emptyLedger();
  for (const row of rows) addRow(ledger, row);
  const result = derive(ledger, spec);
  if (!result.row) throw Error(`derive refused: ${result.error}`);
  const filled = fill(`<h2>Findings</h2><p>The total is {{${result.row.fact_id}:${result.row.label}}}.</p>`, ledger);
  if (filled.out === null) throw Error("fill failed");
  return { ledger, row: result.row, html: filled.out };
}
describe("the converted half of a derived or converted row is display(value, unit)", () => {
  const dated = { valid_at: "2026-10-01" },
    cases = [
      [
        "a grouped KRW-e8 sum",
        [measured("F1", "1617", "KRW-e8"), measured("F2", "1617", "KRW-e8")],
        { op: "sum", operands: ["F1", "F2"], unit: "KRW-e8" },
      ],
      [
        "a grouped KRW-e3 sum",
        [measured("F1", "1617", "KRW-e3"), measured("F2", "1617", "KRW-e3")],
        { op: "sum", operands: ["F1", "F2"], unit: "KRW-e3" },
      ],
      [
        "a grouped KRW-e4 sum",
        [measured("F1", "1617", "KRW-e4"), measured("F2", "1617", "KRW-e4")],
        { op: "sum", operands: ["F1", "F2"], unit: "KRW-e4" },
      ],
      [
        "a grouped KRW-e12 sum",
        [measured("F1", "1617", "KRW-e12"), measured("F2", "1617", "KRW-e12")],
        { op: "sum", operands: ["F1", "F2"], unit: "KRW-e12" },
      ],
      [
        "a km/h sum",
        [measured("F1", "30000", "km/h"), measured("F2", "30000", "km/h")],
        { op: "sum", operands: ["F1", "F2"], unit: "km/h" },
      ],
      [
        "a KRW/person sum",
        [measured("F1", "30000", "KRW/person"), measured("F2", "30000", "KRW/person")],
        { op: "sum", operands: ["F1", "F2"], unit: "KRW/person" },
      ],
      [
        "an FX expr in KRW-e8",
        [measured("F1", "12", "USD", dated), measured("F2", "1420", "KRW-e8/USD", dated)],
        { op: "expr", formula: "F1 * F2", unit: "KRW-e8" },
      ],
    ];
  for (const [name, rows, spec] of cases)
    test(`#given ${name} exactly as fill wrote it #when verified #then no defect`, () => {
      const { ledger, html } = derivedReport(rows, spec);
      expect(valueChecks(buildContext(parseHtml(html), {}), ledger, null, null)).toEqual([]);
    });
  test("#given a grouped KRW-e8 sum whose converted half was edited #when verified #then it still blocks", () => {
    const { ledger, row, html } = derivedReport(cases[0][1], cases[0][2]),
      edited = html.replace(`>${String(row.raw)}<`, ">3,243 KRW-e8<");
    expect(edited).not.toBe(html);
    expect(valueChecks(buildContext(parseHtml(edited), {}), ledger, null, null).map((d) => d.code)).toContain("value_mismatch");
  });
});
describe("conversion originals bind both halves", () => {
  for (const [shown, code] of [
    ["320,000 mm (320 mm)", "unit_mismatch"],
    ["320,000 mm (999 m)", "value_mismatch"],
    ["320,000 mm (three m)", "value_mismatch"],
    ["320,000 mm (\uFF19\uFF19\uFF19 m)", "value_mismatch"],
    ["320,000 mm (m)", "value_mismatch"],
  ])
    test(`#given an edited original ${shown} #when verified #then ${code} on part original`, () => {
      expect(check(data("F8", shown))).toContainEqual(expect.objectContaining({ code, part: "original" }));
      expect(checkFidelity(data("F8", shown), { ledger: DERIVED, brief: BRIEF }).defects).toContainEqual(
        expect.objectContaining({ code, part: "original" }),
      );
    });
  test("#given a ledger render edited to match a tampered report #when verified #then the original stays bound to its operand", () => {
    const ledger = structuredClone(DERIVED);
    rowOf(ledger, "F8").render = "320,000 mm (999 m)";
    expect(check(data("F8", "320,000 mm (999 m)"), ledger)).toContainEqual(
      expect.objectContaining({ code: "value_mismatch", part: "original" }),
    );
  });
  test("#given an edited converted half or a number beside the original #when verified #then value_mismatch", () => {
    expect(check(data("F8", "320,000 mm (320 m)"))).toEqual([]);
    expect(check(data("F8", "319,000 mm (320 m)"))).toContainEqual(expect.objectContaining({ code: "value_mismatch" }));
    expect(check(data("F8", "320,000 mm (320 m) 999"))).toContainEqual(
      expect.objectContaining({ code: "value_mismatch", part: "original" }),
    );
  });
  test("#given the fixture F8 whose raw is not its render #when filled and verified #then the shape fact derive never writes is rejected", () => {
    expect(rowOf(BASE, "F8").raw).not.toBe(rowOf(BASE, "F8").render);
    const filled = fill("<h2>Findings</h2><p>The span is {{F8:span_mm}}.</p>", structuredClone(BASE));
    expect(valueChecks(buildContext(parseHtml(String(filled.out)), {}), BASE, null, null)).toContainEqual(
      expect.objectContaining({ code: "value_mismatch" }),
    );
  });
  test("#given grouped and percent originals #when verified #then the operation display contract holds", () => {
    const ledger = structuredClone(DERIVED);
    rowOf(ledger, "F1").value = "1237";
    const converted = rowOf(ledger, "F8");
    converted.value = "1237000";
    expect(check(data("F8", "1,237,000 mm (1,237 m)"), ledger)).toEqual([]);
    Object.assign(converted, { kind: "derived", value: "0.12", unit: null, derived_from: ["F3"] });
    expect(check(data("F8", "0.12 (12%)"), ledger)).toEqual([]);
  });
  test("#given a converted row filled in value and unit mode #when verified #then no original is due", () => {
    for (const pointer of [(id) => `{{${id}:span_mm:value}} mm`, (id) => `{{${id}:span_mm:value}}{{${id}:span_mm:unit}}`]) {
      const ledger = emptyLedger();
      addRow(ledger, measured("F1", "320", "m"));
      const { row } = derive(ledger, { op: "convert", operands: ["F1"], to: "mm", label: "span_mm" }),
        filled = fill(`<h2>Findings</h2><p>The span is ${pointer(row.fact_id)}.</p>`, ledger);
      expect(valueChecks(buildContext(parseHtml(String(filled.out)), {}), ledger, null, null)).toEqual([]);
    }
  });
});
describe("conversion originals: the bracket grammar class", () => {
  const PASS = "pass",
    ORIGINAL = "value_mismatch/original",
    KO = {
      prefix: "\uD658\uC0B0 ",
      tbd: "\uBBF8\uC815",
      na: "\uD574\uB2F9 \uC5C6\uC74C",
      about: "\uC57D",
      words: "\uC0BC\uBC31\uC774\uC2ED",
    },
    ROWS = [
      { form: "ASCII parentheses", input: "320,000 mm (320 m)", expected: PASS },
      { form: "fullwidth parentheses", input: "320,000 mm\uFF08320 m\uFF09", expected: PASS },
      { form: "fullwidth parentheses after a space", input: "320,000 mm \uFF08320 m\uFF09", expected: PASS },
      { form: "square brackets", input: "320,000 mm [320 m]", expected: PASS },
      { form: "fullwidth square brackets", input: "320,000 mm\uFF3B320 m\uFF3D", expected: PASS },
      { form: "lenticular brackets", input: "320,000 mm\u3010320 m\u3011", expected: PASS },
      { form: "corner brackets", input: "320,000 mm\u300C320 m\u300D", expected: PASS },
      { form: "tortoise-shell brackets", input: "320,000 mm\u3014320 m\u3015", expected: PASS },
      {
        form: "NFKC fullwidth digits and letters throughout",
        input: "\uFF13\uFF12\uFF10\uFF0C\uFF10\uFF10\uFF10 \uFF4D\uFF4D\uFF08\uFF13\uFF12\uFF10 \uFF4D\uFF09",
        expected: PASS,
      },
      { form: "NFKC fullwidth digits inside the original", input: "320,000 mm (\uFF13\uFF12\uFF10 m)", expected: PASS },
      { form: "spaces inside the brackets", input: "320,000 mm ( 320 m )", expected: PASS },
      { form: "no space before the bracket", input: "320,000 mm(320 m)", expected: PASS },
      { form: "EN digit-free prefix", input: "Converted: 320,000 mm (320 m)", expected: PASS },
      { form: "KO digit-free prefix, fullwidth", input: `${KO.prefix}320,000 mm\uFF08320 m\uFF09`, expected: PASS },
      { form: "ASCII parentheses, wrong original", input: "320,000 mm (999 m)", expected: ORIGINAL },
      { form: "fullwidth parentheses, wrong original", input: "320,000 mm\uFF08999 m\uFF09", expected: ORIGINAL },
      { form: "square brackets, wrong original", input: "320,000 mm [999 m]", expected: ORIGINAL },
      { form: "fullwidth square brackets, wrong original", input: "320,000 mm\uFF3B999 m\uFF3D", expected: ORIGINAL },
      { form: "lenticular brackets, wrong original", input: "320,000 mm\u3010999 m\u3011", expected: ORIGINAL },
      { form: "corner brackets, wrong original", input: "320,000 mm\u300C999 m\u300D", expected: ORIGINAL },
      { form: "tortoise-shell brackets, wrong original", input: "320,000 mm\u3014999 m\u3015", expected: ORIGINAL },
      { form: "NFKC fullwidth digits, wrong original", input: "320,000 mm (\uFF19\uFF19\uFF19 m)", expected: ORIGINAL },
      { form: "spaces inside, wrong original", input: "320,000 mm ( 999 m )", expected: ORIGINAL },
      { form: "hyphen separator, right number", input: "320,000 mm - 320 m", expected: ORIGINAL },
      { form: "en-dash separator, right number", input: "320,000 mm \u2013 320 m", expected: ORIGINAL },
      { form: "em-dash separator, right number", input: "320,000 mm \u2014 320 m", expected: ORIGINAL },
      { form: "hyphen separator, wrong number", input: "320,000 mm - 999 m", expected: ORIGINAL },
      { form: "en-dash separator, wrong number", input: "320,000 mm \u2013 999 m", expected: ORIGINAL },
      { form: "separator after the original", input: "320,000 mm (320 m) - 999 m", expected: ORIGINAL },
      { form: "nested parentheses", input: "320,000 mm ((320 m))", expected: ORIGINAL },
      { form: "square inside parentheses", input: "320,000 mm ([320 m])", expected: ORIGINAL },
      { form: "ASCII inside fullwidth parentheses", input: "320,000 mm\uFF08(320 m)\uFF09", expected: ORIGINAL },
      { form: "mismatched bracket pair", input: "320,000 mm (320 m]", expected: ORIGINAL },
      { form: "unclosed bracket", input: "320,000 mm (320 m", expected: ORIGINAL },
      { form: "EN number word", input: "320,000 mm (twenty m)", expected: ORIGINAL },
      { form: "EN n/a", input: "320,000 mm (n/a)", expected: ORIGINAL },
      { form: "EN TBD", input: "320,000 mm (TBD)", expected: ORIGINAL },
      { form: "EN approx. alone", input: "320,000 mm (approx.)", expected: ORIGINAL },
      { form: "EN approx. beside the original", input: "320,000 mm (approx.) (320 m)", expected: ORIGINAL },
      { form: "bare unit", input: "320,000 mm (m)", expected: ORIGINAL },
      { form: "KO TBD", input: `320,000 mm (${KO.tbd})`, expected: ORIGINAL },
      { form: "KO n/a, fullwidth", input: `320,000 mm\uFF08${KO.na}\uFF09`, expected: ORIGINAL },
      { form: "KO hedge inside the original", input: `320,000 mm (${KO.about} 320 m)`, expected: ORIGINAL },
      { form: "KO number word", input: `320,000 mm (${KO.words} m)`, expected: ORIGINAL },
      { form: "missing original", input: "320,000 mm", expected: ORIGINAL },
      { form: "EN prefix, missing original", input: "Converted: 320,000 mm", expected: ORIGINAL },
      { form: "KO prefix, missing original", input: `${KO.prefix}320,000 mm`, expected: ORIGINAL },
      { form: "original before the value", input: "(320 m) 320,000 mm", expected: ORIGINAL },
      { form: "fullwidth original before the value", input: "\uFF08320 m\uFF09320,000 mm", expected: ORIGINAL },
      { form: "two originals, both right", input: "320,000 mm (320 m) (320 m)", expected: ORIGINAL },
      { form: "two originals, second wrong", input: "320,000 mm (320 m)\uFF08999 m\uFF09", expected: ORIGINAL },
      { form: "two originals, mixed brackets", input: "320,000 mm (320 m) [320 m]", expected: ORIGINAL },
      { form: "second original typed after the fill site", input: " (999 m)", expected: ORIGINAL, after: true },
      { form: "fullwidth original typed after the fill site", input: "\uFF08320 m\uFF09", expected: ORIGINAL, after: true },
      { form: "square original typed after the fill site", input: " [999 m]", expected: ORIGINAL, after: true },
      { form: "separator original typed after the fill site", input: " - 999 m", expected: ORIGINAL, after: true },
      { form: "prose bracket typed after the fill site", input: " (approx.)", expected: PASS, after: true },
    ],
    SENTENCE = { en: ["The span is ", "."], ko: ["\uAD50\uB7C9 \uAE38\uC774\uB294 ", "\uC774\uB2E4."] },
    RENDERS = {
      "html paragraph": { format: "html", doc: (p, [a, b]) => `<h2>Findings</h2><p>${a}${p}${b}</p>` },
      "html table cell": { format: "html", doc: (p) => `<h2>Findings</h2><table><tr><th>span</th><td>${p}</td></tr></table>` },
      "md paragraph": {
        format: "md",
        doc: (p, [a, b]) => `## Findings

${a}${p}${b}
`,
      },
      "md table cell": {
        format: "md",
        doc: (p) => `## Findings

| item | value |
| --- | --- |
| span | ${p} |
`,
      },
    };
  function verdict(input, render, lang, after = false) {
    const ledger = emptyLedger();
    addRow(ledger, measured("F1", "320", "m"));
    const row = derive(ledger, { op: "convert", operands: ["F1"], to: "mm", label: "span_mm" }).row,
      filled = fill(render.doc(`{{${row.fact_id}:span_mm}}`, SENTENCE[lang]), ledger, { format: render.format }),
      site = render.format === "html" ? `>${row.render}</data>` : String(row.render),
      edited = filled.out.replace(site, after ? `${site}${input}` : render.format === "html" ? `>${input}</data>` : input);
    if (!filled.out.includes(site) || (input !== row.render && edited === filled.out)) return "fill site not found";
    const projected = render.format === "md" ? markdownAsHtml(edited, filled.fillMap, ledger) : null,
      defects = valueChecks(buildContext(parseHtml(projected?.html ?? edited), {}), ledger, projected?.stale ?? null, null),
      value = defects.find((d) => d.code === "value_mismatch" || d.code === "unit_mismatch");
    if (value) return `${value.code}/${value.part ?? "-"}`;
    return defects.length === 0 ? PASS : defects.map((d) => d.code).join(",");
  }
  test(`#given ${ROWS.length} written forms x ${Object.keys(RENDERS).length} renders x EN and KO #when verified #then each verdict is the row's expected`, () => {
    const got = [],
      want = [];
    for (const { form, input, expected, after } of ROWS)
      for (const [name, render] of Object.entries(RENDERS))
        for (const lang of ["en", "ko"]) {
          got.push(`${form} | ${name} | ${lang} | ${verdict(input, render, lang, after)}`);
          want.push(`${form} | ${name} | ${lang} | ${expected}`);
        }
    expect(got).toEqual(want);
  });
});
describe("conversion originals: what can follow a converted element", () => {
  const [CLEAN, ORIGINAL, UNTRACED] = ["clean", "original", "untraceable_number"],
    BRACKETS = [
      ["(", ")"],
      ["\uFF08", "\uFF09"],
      ["[", "]"],
      ["\uFF3B", "\uFF3D"],
      ["\u3010", "\u3011"],
      ["\u300C", "\u300D"],
      ["\u3014", "\u3015"],
      ["\u300E", "\u300F"],
      ["\u300A", "\u300B"],
    ],
    SEPARATORS = ["-", "\u2013", "\u2014", "/"],
    ROWS = [
      { shape: "nothing (element at the end of the cell or line)", after: "", expected: CLEAN },
      ...BRACKETS.flatMap(([o, c]) => [
        { shape: `${o}${c} second placeholder in prose`, after: ` ${o}{{F3:rate_yoy}} longer${c}`, expected: CLEAN },
        { shape: `${o}${c} second placeholder alone`, after: ` ${o}{{F1:span_len}}${c}`, expected: CLEAN },
        { shape: `${o}${c} bare numeral, wrong`, after: ` ${o}999 m${c}`, expected: ORIGINAL },
        { shape: `${o}${c} bare numeral, right, other unit of the dimension`, after: ` ${o}0.32 km${c}`, expected: ORIGINAL },
      ]),
      ...SEPARATORS.flatMap((s) => [
        { shape: `${s} then a filled element`, after: ` ${s} {{F1:span_len}}`, expected: CLEAN },
        { shape: `${s} then a bare numeral`, after: ` ${s} 999 m`, expected: ORIGINAL },
        { shape: `${s} then prose with a count`, after: ` ${s} 12 sites`, expected: UNTRACED },
      ]),
      { shape: "prose with a filled percent", after: " ({{F3:rate_yoy}} longer)", expected: CLEAN },
      { shape: "prose with a literal percent", after: " (12 % longer)", expected: UNTRACED },
      { shape: "a bare unitless number (footnote)", after: " (7)", expected: UNTRACED },
      { shape: "a year", after: " (2024)", expected: UNTRACED },
      { shape: "two consecutive elements", after: " {{F1:span_len}}", expected: CLEAN },
      { shape: "two consecutive elements, glued", after: "{{F3:rate_yoy}}", expected: CLEAN },
      { shape: "prose without digits", after: " (approx.)", expected: CLEAN },
    ],
    SENTENCE = { en: ["The span is ", "."], ko: ["\uAD50\uB7C9 \uAE38\uC774\uB294 ", "\uC774\uB2E4."] },
    RENDERS = {
      "html paragraph": { format: "html", doc: (b, [x, y]) => `<h2>Findings</h2><p>${x}${b}${y}</p>` },
      "html table cell": { format: "html", doc: (b) => `<h2>Findings</h2><table><tr><th>span</th><td>${b}</td></tr></table>` },
      "md paragraph": {
        format: "md",
        doc: (b, [x, y]) => `## Findings

${x}${b}${y}
`,
      },
      "md table cell": {
        format: "md",
        doc: (b) => `## Findings

| item | value |
| --- | --- |
| span | ${b} |
`,
      },
      "md paragraph, edited before the site (stale fill map)": {
        format: "md",
        doc: (b, [x, y]) => `## Findings

${x}${b}${y}
`,
        stale: true,
      },
    };
  function verdict(after, render, lang) {
    const ledger = emptyLedger();
    for (const id of ["F1", "F3"]) addRow(ledger, structuredClone(rowOf(BASE, id)));
    const row = derive(ledger, { op: "convert", operands: ["F1"], to: "mm", label: "span_mm" }).row,
      filled = fill(render.doc(`{{${row.fact_id}:span_mm}}${after}`, SENTENCE[lang]), ledger, { format: render.format });
    if (filled.out === null) return "fill failed";
    const report = render.stale ? filled.out.replace("## Findings", "## Findings, revised after the review") : filled.out,
      projected = render.format === "md" ? markdownAsHtml(report, filled.fillMap, ledger) : null;
    if (render.stale && projected?.stale.length === 0) return "fill map not stale";
    const defects = valueChecks(
      buildContext(parseHtml(projected?.html ?? report), {}),
      ledger,
      projected?.stale ?? null,
      join(FIX, "sources"),
    );
    if (defects.some((d) => d.part === "original")) return ORIGINAL;
    return defects.length === 0 ? CLEAN : [...new Set(defects.map((d) => d.code))].sort().join(",");
  }
  test(`#given ${ROWS.length} shapes x ${Object.keys(RENDERS).length} renders x EN and KO after a filled convert row #when verified #then each verdict is the row's expected`, () => {
    const got = [],
      want = [];
    for (const { shape, after, expected } of ROWS)
      for (const [name, render] of Object.entries(RENDERS))
        for (const lang of ["en", "ko"]) {
          got.push(`${shape} | ${name} | ${lang} | ${verdict(after, render, lang)}`);
          want.push(`${shape} | ${name} | ${lang} | ${expected}`);
        }
    expect(got).toEqual(want);
  });
});
