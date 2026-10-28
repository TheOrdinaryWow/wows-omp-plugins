// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFECT_CODES, STATIC_CODES } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/contracts.mjs";
import { parseLineageMode, parsePalette } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/design-spec.mjs";
import { checkStatic } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

const FIXTURES = join(import.meta.dir, "tests", "fixtures"),
  GOOD = readFileSync(join(FIXTURES, "good-report.html"), "utf8"),
  BAD = readFileSync(join(FIXTURES, "bad-report.html"), "utf8"),
  SPEC = readFileSync(join(FIXTURES, "design-spec.md"), "utf8"),
  PALETTE = parsePalette(SPEC);
function run(html, options = {}) {
  return checkStatic(parseHtml(html), {
    palette: PALETTE,
    lineageMode: parseLineageMode(SPEC),
    requireSections: [],
    baseDir: FIXTURES,
    ...options,
  });
}
const codes = (result) => result.defects.map((defect) => defect.code),
  has = (html, code, options = {}) => codes(run(html, options)).includes(code);
describe("checkStatic fixtures", () => {
  test("#given the passing fixture report #when every gate runs #then no defect is raised", () => {
    const result = run(GOOD, { requireSections: [/sources/i, /review/i] });
    expect(codes(result)).toEqual([]);
    expect(result.gatesSkipped).toEqual([]);
    expect([...result.gatesRun].sort()).toEqual([...STATIC_CODES].sort());
  });
  test("#given the failing fixture report #when every gate runs #then each static code except the no-visual one is raised exactly once", () => {
    const result = run(BAD, { requireSections: [/risks/i] });
    expect([...codes(result)].sort()).toEqual(STATIC_CODES.filter((code) => code !== "report_without_visual").sort());
    expect(STATIC_CODES).toHaveLength(19);
    expect(codes(result)).not.toContain("missing_promised_deliverable");
  });
  test("#given the failing fixture report #when defects are read #then each carries contract severity, selector, line, token message and hint", () => {
    const result = run(BAD, { requireSections: [/risks/i] }),
      byCode = new Map(result.defects.map((defect) => [defect.code, defect]));
    for (const defect of result.defects) {
      const contract = DEFECT_CODES[defect.code];
      expect(defect.severity).toBe(contract.severity);
      expect(defect.hint).toBe(contract.hint);
      expect(typeof defect.selector).toBe("string");
      expect(defect.selector.length).toBeGreaterThan(0);
      expect(Number.isInteger(defect.line)).toBe(true);
    }
    expect(byCode.get("palette_off_token")?.message).toContain("#123456");
    expect(byCode.get("unsourced_number")?.message).toContain("12.5%");
    expect(byCode.get("broken_asset_reference")?.message).toContain("missing-figure.png");
    expect(byCode.get("korean_serif_font")?.message).toContain("Nanum Myeongjo");
    expect(byCode.get("emoji_in_prose")?.message).toContain("\uD83D\uDE80");
  });
});
describe("mutation proofs on the passing fixture", () => {
  test("#given keep-all removed #when checked #then only korean_no_keep_all is raised", () => {
    const mutated = GOOD.replace("word-break: keep-all;", ""),
      result = run(mutated, { requireSections: [/sources/i] });
    expect(codes(result)).toEqual(["korean_no_keep_all"]);
  });
  test("#given the closing heading renamed #when checked #then the missing_closing_section blocker is raised", () => {
    const mutated = GOOD.replace("<h2>How this report was made</h2>", "<h2>Notes on the data</h2>"),
      defect = run(mutated).defects.find((entry) => entry.code === "missing_closing_section");
    expect(defect?.severity).toBe("blocker");
  });
  test("#given the sources heading renamed #when checked #then the missing_citation_section blocker is raised", () => {
    const mutated = GOOD.replace("<h2>Sources</h2>", "<h2>Further reading</h2>"),
      defect = run(mutated).defects.find((entry) => entry.code === "missing_citation_section");
    expect(defect?.severity).toBe("blocker");
  });
  test("#given no sources heading but three [S<n>] definition lines #when checked #then no citation-section blocker", () => {
    const found = has(
      "<h2>Notes</h2><p>[S1] First source title</p><p>[S2] Second source title</p><p>[Source 3] Third source title</p>",
      "missing_citation_section",
    );
    expect(found).toBe(false);
  });
});
describe("unsourced_number", () => {
  const claim = "\uB9E4\uCD9C\uC774 12.5% \uC99D\uAC00\uD588\uB2E4";
  test("#given a bare revenue claim #when checked #then unsourced_number is raised", () => {
    const html = `<p>${claim}</p>`,
      found = has(html, "unsourced_number");
    expect(found).toBe(true);
  });
  test.each([
    ["a [S3] marker", `<p>${claim} [S3]</p>`],
    ["a MEASURED token", `<p>${claim} MEASURED</p>`],
    ["a data-lineage attribute", `<p data-lineage="DERIVED">${claim}</p>`],
    ["a #s3 anchor", `<p>${claim} <a href="#s3">3</a></p>`],
  ])("#given the claim with %s #when checked #then it is not flagged", (_label, html) => {
    const found = has(html, "unsourced_number");
    expect(found).toBe(false);
  });
  test("#given dates, versions, figure refs and bare years only #when checked #then no claim is found", () => {
    const found = has("<p>Released 2024-03-01 as v2.3.1 in 2019, see Figure 3 and Table 2.</p>", "unsourced_number");
    expect(found).toBe(false);
  });
  test("#given inline and section lineage modes #when the same claim is checked #then severity is major then minor", () => {
    const html = `<p>${claim}</p>`,
      inline = run(html, { lineageMode: "inline" }).defects.find((d) => d.code === "unsourced_number"),
      section = run(html, { lineageMode: "section" }).defects.find((d) => d.code === "unsourced_number");
    expect(inline?.severity).toBe(DEFECT_CODES.unsourced_number.severity);
    expect(section?.severity).toBe("minor");
  });
  test("#given a claim inside a figure, a table and the closing section #when checked #then none is flagged", () => {
    const html = `<figure><p>${claim}</p><figcaption>x</figcaption></figure><table><tr><td><p>${claim}</p></td></tr></table><h2>How it was made</h2><p>${claim}</p>`,
      found = has(html, "unsourced_number");
    expect(found).toBe(false);
  });
});
describe("dashes and emoji", () => {
  test("#given an en dash between years #when checked #then it is allowed", () => {
    const found = has("<p>2019\u20132024</p>", "en_dash_in_prose");
    expect(found).toBe(false);
  });
  test("#given an en dash between letters #when checked #then en_dash_in_prose is raised", () => {
    const found = has("<p>a\u2013b</p>", "en_dash_in_prose");
    expect(found).toBe(true);
  });
  test("#given em dashes in a td and in the sources section #when checked #then they are out of prose scope", () => {
    const found = has("<table><tr><td>\u2014</td></tr></table><h2>Sources</h2><ol><li>Title \u2014 subtitle</li></ol>", "em_dash_in_prose");
    expect(found).toBe(false);
  });
  test("#given a check-mark emoji in prose #when checked #then emoji_in_prose is raised", () => {
    const found = has("<p>\u2705 done</p>", "emoji_in_prose");
    expect(found).toBe(true);
  });
  test("#given a plain check mark in a td #when checked #then no emoji is raised", () => {
    const found = has("<table><tr><td>\u2713</td></tr></table>", "emoji_in_prose");
    expect(found).toBe(false);
  });
});
describe("figures and charts", () => {
  test("#given a 16px svg inside an h2 #when checked #then it is not treated as a chart", () => {
    const found = codes(run('<h2>Title <svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0h16"/></svg></h2>')).filter((code) =>
      code.startsWith("chart_"),
    );
    expect(found).toEqual([]);
  });
  test("#given a figure svg with title, three ticks and a label #when checked #then no chart defect", () => {
    const found = codes(
      run(
        `<figure>${'<svg width="400" height="200"><title>Deploys</title><text>0</text><text>5</text><text>10</text><text>Weeks</text></svg>'}<figcaption>Deploys per week</figcaption></figure>`,
      ),
    ).filter((code) => code.startsWith("chart_"));
    expect(found).toEqual([]);
  });
});
describe("report-level visuals", () => {
  const figures = /<figure\b[\s\S]*?<\/figure>/g;
  test("#given the passing fixture with every figure removed #when checked #then only report_without_visual is raised", () => {
    const html = GOOD.replace(figures, ""),
      result = run(html, { requireSections: [/sources/i, /review/i] });
    expect(codes(result)).toEqual(["report_without_visual"]);
    expect(result.defects[0]?.severity).toBe("major");
  });
  test("#given a header logo, an unrendered Mermaid source block, a zero-size svg, then a rendered diagram #when checked #then only the rendered diagram counts as a visual", () => {
    const logo = '<header><img src="data:image/png;base64,iVBORw0KGgo=" alt="logo" width="120" height="40"></header><p>x</p>',
      unrendered = `${logo}<pre class="mermaid">flowchart LR
  A --> B</pre><figure><svg width="0" height="0"><text>A</text></svg><figcaption>c</figcaption></figure>`,
      rendered = `${logo}<figure><svg width="600" height="300" aria-roledescription="flowchart-v2"><text>A</text><text>B</text></svg><figcaption>c</figcaption></figure>`;
    expect(has(unrendered, "report_without_visual")).toBe(true);
    expect(has(rendered, "report_without_visual")).toBe(false);
  });
  test("#given rendered Mermaid diagrams with SVG text labels and with HTML-only labels #when checked #then only the HTML-only one is flagged and neither needs chart ticks", () => {
    const diagram = (labels) =>
        `<figure><svg width="600" height="300" aria-roledescription="flowchart-v2">${labels}</svg><figcaption>Gate order</figcaption></figure>`,
      textLabels = diagram("<text>static check</text><text>repair decide</text>"),
      htmlLabels = diagram("<foreignObject><div>static check</div></foreignObject>"),
      chartCodes = (html) => codes(run(html)).filter((code) => code.startsWith("chart_"));
    expect(chartCodes(textLabels)).toEqual([]);
    expect(chartCodes(htmlLabels)).toEqual(["chart_svg_no_text"]);
  });
  test("#given a single visual with one zero dimension #when checked #then report_without_visual is raised; viewBox-only and unsized visuals still count", () => {
    const only = (el) => `<figure>${el}<figcaption>c</figcaption></figure>`,
      flat = only('<img src="data:image/png;base64,iVBORw0KGgo=" alt="chart" width="600" height="0">'),
      narrow = only('<svg width="0" height="300"><text>A</text></svg>'),
      styled = only('<img src="data:image/png;base64,iVBORw0KGgo=" alt="chart" width="600" height="300" style="height: 0">'),
      viewBoxOnly = only('<svg viewBox="0 0 600 300" aria-roledescription="flowchart-v2"><text>A</text></svg>'),
      unsized = only('<img src="data:image/png;base64,iVBORw0KGgo=" alt="Deploys per week">');
    for (const html of [flat, narrow, styled]) expect(has(html, "report_without_visual")).toBe(true);
    for (const html of [viewBoxOnly, unsized]) expect(has(html, "report_without_visual")).toBe(false);
  });
  test("#given figure images with no alt, a bare empty alt, role- and aria-marked decorative alts and a descriptive alt #when checked #then only the unmarked two raise image_missing_alt", () => {
    const img = (alt) =>
        `<figure><img src="data:image/png;base64,iVBORw0KGgo=" ${alt} width="480" height="240"><figcaption>c</figcaption></figure>`,
      html = ["", 'alt=""', 'alt="" role="presentation"', 'alt="" aria-hidden="true"', 'alt="Deploys per week, 2025"'].map(img).join(""),
      found = run(html).defects.filter((d) => d.code === "image_missing_alt");
    expect(found).toHaveLength(2);
  });
  test("#given a report whose only image is marked decorative #when checked #then report_without_visual is raised", () => {
    expect(
      has(
        '<figure><img src="data:image/png;base64,iVBORw0KGgo=" alt="" role="presentation" width="480" height="240"><figcaption>c</figcaption></figure>',
        "report_without_visual",
      ),
    ).toBe(true);
  });
});
describe("gate bookkeeping", () => {
  test("#given a spec with an empty palette #when checked #then palette_off_token is skipped, not run", () => {
    const palette = parsePalette(`# Design spec

## Citations
- Lineage: inline
`),
      result = run('<p style="color: #123456">x</p>', { palette });
    expect(palette.size).toBe(0);
    expect(result.gatesSkipped).toContain("palette_off_token");
    expect(result.gatesRun).not.toContain("palette_off_token");
    expect(codes(result)).not.toContain("palette_off_token");
  });
  test("#given an injected fs with a zero-byte and a missing asset #when checked #then both are broken and remote ones are ignored", () => {
    const sizes = new Map([
        [join("base", "empty.png"), 0],
        [join("base", "ok.css"), 10],
      ]),
      broken = run(
        '<link rel="stylesheet" href="ok.css"><img src="empty.png"><script src="gone.js"></script><img src="https://example.org/a.png">',
        {
          baseDir: "base",
          fs: {
            statSync(file) {
              const size = sizes.get(file);
              if (size === void 0) throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
              return { size };
            },
          },
        },
      ).defects.filter((d) => d.code === "broken_asset_reference");
    expect(broken.map((d) => d.message.includes("empty.png") || d.message.includes("gone.js"))).toEqual([true, true]);
  });
  test("#given an unknown lineage mode #when checked #then it throws instead of guessing a severity", () => {
    expect(() => run("<p>x</p>", { lineageMode: "loose" })).toThrow(TypeError);
  });
});
