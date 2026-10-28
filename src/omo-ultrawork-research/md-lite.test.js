// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import * as gatesStatic from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";
import * as mdLite from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/md-lite.mjs";
import { parseMarkdown, sectionKindsMd } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/md-lite.mjs";

const FIXTURE = [
  "# \uBC18\uB3C4\uCCB4 \uC2DC\uC7A5 \uBCF4\uACE0\uC11C",
  "",
  "\uB9E4\uCD9C\uC740 {{F1}}\uB85C \uC9D1\uACC4\uB410\uB2E4. Revenue grew",
  "across two quarters.",
  "",
  "## Findings",
  "",
  "- \uCCAB \uBC88\uC9F8 \uD56D\uBAA9 120\uC5B5 \uC6D0",
  "* Second item 3.2 m",
  "1. Ordered item 45%",
  "",
  "| \uC9C0\uD45C | Value |",
  "| --- | ---: |",
  "| \uB9E4\uCD9C | 100\uC5B5 \uC6D0 |",
  "",
  "> \uC6D0\uBB38 \uC778\uC6A9 \uADF8\uB300\uB85C\uB2E4.",
  "",
  "```js",
  "const total = 9999",
  "```",
  "",
  "## Sources",
  "",
  "S1 example.org",
  "",
  "## \uCD9C\uCC98",
  "",
  "## Closing",
  "",
  "### Method",
  "",
  "## \uB9C8\uBB34\uB9AC",
  "",
].join(`
`);
function blocksOf(text) {
  return parseMarkdown(text).blocks;
}
function expectSlices(text, blocks) {
  for (const block of blocks) {
    expect(text.slice(block.start, block.end)).toBe(block.text);
    for (const cell of block.cells ?? []) expect(text.slice(cell.start, cell.end)).toBe(cell.text);
  }
}
describe("parseMarkdown", () => {
  test("#given a Korean+English fixture #when parsed #then block kinds come in document order", () => {
    const blocks = blocksOf(FIXTURE);
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list_item",
      "list_item",
      "list_item",
      "table_row",
      "table_row",
      "blockquote",
      "code",
      "heading",
      "paragraph",
      "heading",
      "heading",
      "heading",
      "heading",
    ]);
  });
  test("#given the fixture #when parsed #then every block and cell slices exactly from start to end", () => {
    const text = FIXTURE,
      blocks = blocksOf(text);
    expectSlices(text, blocks);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "\uBC18\uB3C4\uCCB4 \uC2DC\uC7A5 \uBCF4\uACE0\uC11C" });
    expect(blocks[1]?.text).toBe(`\uB9E4\uCD9C\uC740 {{F1}}\uB85C \uC9D1\uACC4\uB410\uB2E4. Revenue grew
across two quarters.`);
    expect(blocks.filter((b) => b.kind === "list_item").map((b) => b.text)).toEqual([
      "\uCCAB \uBC88\uC9F8 \uD56D\uBAA9 120\uC5B5 \uC6D0",
      "Second item 3.2 m",
      "Ordered item 45%",
    ]);
    expect(blocks.find((b) => b.kind === "blockquote")?.text).toBe("\uC6D0\uBB38 \uC778\uC6A9 \uADF8\uB300\uB85C\uB2E4.");
  });
  test("#given a table with a separator row #when parsed #then rows carry trimmed cells and the separator is skipped", () => {
    const text = FIXTURE,
      rows = blocksOf(text).filter((b) => b.kind === "table_row");
    expect(rows.map((r) => (r.cells ?? []).map((c) => c.text))).toEqual([
      ["\uC9C0\uD45C", "Value"],
      ["\uB9E4\uCD9C", "100\uC5B5 \uC6D0"],
    ]);
    expectSlices(text, rows);
  });
  test("#given a fenced code block with numerals #when parsed #then the numerals sit only in a block of kind code", () => {
    const holders = blocksOf(FIXTURE).filter((b) => b.text.includes("9999"));
    expect(holders.map((b) => b.kind)).toEqual(["code"]);
    expect(holders[0]?.text).toBe("const total = 9999");
  });
  test("#given an unterminated code fence #when parsed #then it is code to EOF and an unterminated_fence problem names its line", () => {
    const text = `Intro 12.

\`\`\`
let a = 1
## not a heading
`,
      { blocks, problems } = parseMarkdown(text);
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "code"]);
    expect(blocks[1]?.text).toBe(`let a = 1
## not a heading
`);
    expectSlices(text, blocks);
    expect(problems).toEqual([expect.objectContaining({ code: "unterminated_fence", line: 3 })]);
  });
  test("#given closed fences only #when parsed #then problems is empty", () => {
    const text = FIXTURE,
      { problems } = parseMarkdown(text);
    expect(problems).toEqual([]);
  });
  const NUMBER_LINES = [
    [
      "a year-led continuation line",
      `Revenue rose 12% in
2024. Costs fell 3%.`,
      [
        [
          "paragraph",
          `Revenue rose 12% in
2024. Costs fell 3%.`,
        ],
      ],
    ],
    [
      "a bare number at line start",
      `Sales grew in
2024 revenue rose 4%.`,
      [
        [
          "paragraph",
          `Sales grew in
2024 revenue rose 4%.`,
        ],
      ],
    ],
    [
      "a 1. marker after a paragraph",
      `Intro line
1. x`,
      [
        ["paragraph", "Intro line"],
        ["list_item", "x"],
      ],
    ],
    [
      "a 2) marker after a paragraph",
      `Intro line
2) y`,
      [
        [
          "paragraph",
          `Intro line
2) y`,
        ],
      ],
    ],
    [
      "a 2) marker after a blank line",
      `Intro line

2) y`,
      [
        ["paragraph", "Intro line"],
        ["list_item", "y"],
      ],
    ],
    [
      "a later ordered item in a list",
      `1. x
2. y`,
      [
        ["list_item", "x"],
        ["list_item", "y"],
      ],
    ],
  ];
  test.each(NUMBER_LINES)("#given %s #when parsed #then no number drops out of the block text", (_label, text, expected) => {
    const blocks = blocksOf(text);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual(expected);
    expectSlices(text, blocks);
  });
  test("#given a line that opens with an inline triple-backtick span #when parsed #then it stays a paragraph and later claims are not code", () => {
    const text = "```inline``` code at start\n\nLater 42% claim.",
      { blocks, problems } = parseMarkdown(text);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["paragraph", "```inline``` code at start"],
      ["paragraph", "Later 42% claim."],
    ]);
    expect(problems).toEqual([]);
  });
  test("#given a tilde fence with an info string containing backticks #when parsed #then it is still a fence", () => {
    const blocks = blocksOf(`~~~ js \`x\`
const n = 5
~~~
After 6.`);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["code", "const n = 5"],
      ["paragraph", "After 6."],
    ]);
  });
  test("#given a table cell ending in an escaped backslash #when parsed #then the following pipe still splits cells", () => {
    const text = `| a\\\\| b \\| c |
| --- | --- |
| 1 | 2 |`,
      rows = blocksOf(text).filter((b) => b.kind === "table_row");
    expect((rows[0]?.cells ?? []).map((c) => c.text)).toEqual(["a\\\\", "b \\| c"]);
    expectSlices(text, rows);
  });
});
describe("sectionKindsMd", () => {
  test("#given h2 headings in English and Korean #when classified #then sources and closing kinds match gates-static", () => {
    const blocks = blocksOf(FIXTURE),
      kinds = sectionKindsMd(blocks),
      byHeading = {};
    blocks.forEach((b, i) => {
      if (b.kind === "heading") byHeading[b.text] = kinds[i];
    });
    expect(byHeading.Findings).toBeNull();
    expect(byHeading.Sources).toBe("sources");
    expect(byHeading["\uCD9C\uCC98"]).toBe("sources");
    expect(byHeading.Closing).toBe("closing");
    expect(byHeading["\uB9C8\uBB34\uB9AC"]).toBe("closing");
    expect(kinds).toHaveLength(blocks.length);
  });
  test("#given md-lite #when its section classifier is read #then it is the gates-static export itself", () => {
    expect(typeof gatesStatic.sectionKind).toBe("function");
    expect(mdLite.sectionKind).toBe(gatesStatic.sectionKind);
    expect(typeof gatesStatic.closingTest).toBe("function");
    expect(mdLite.closingTest).toBe(gatesStatic.closingTest);
  });
  test("#given one heading set as Markdown h2s and HTML h2s #when classified #then both editions give the same kinds", () => {
    const headings = [
        "Findings",
        "Sources",
        "\uCD9C\uCC98",
        "Closing",
        "\uB9C8\uBB34\uB9AC",
        "Methodology",
        "Contents",
        "Appendix A",
        "Glossary",
        "Closing the gap: GPU prices",
      ],
      md = headings
        .map(
          (h) => `## ${h}

Body.`,
        )
        .join(`

`),
      html = `<html><body>${headings.map((h) => `<h2>${h}</h2><p>Body.</p>`).join("")}</body></html>`,
      blocks = blocksOf(md),
      kinds = sectionKindsMd(blocks),
      mdKinds = blocks.flatMap((b, i) => (b.kind === "heading" ? [kinds[i]] : [])),
      htmlKinds = gatesStatic.buildContext(parseHtml(html), {}).sections.map((s) => s.kind);
    expect(mdKinds).toEqual(htmlKinds);
    expect(mdKinds).toEqual([null, "sources", "sources", "closing", "closing", "closing", "toc", "appendix", "glossary", null]);
  });
  test("#given a findings heading that only starts with Closing #when classified #then it is not a closing section", () => {
    const blocks = blocksOf(`## Closing the gap: GPU prices

Prices fell 8%.

### Closing remarks on supply

Supply rose 2%.`),
      kinds = sectionKindsMd(blocks);
    expect(kinds).toEqual([null, null, null, null]);
  });
  test("#given a caller closing pattern given as a string #when classified #then it is applied as in gates-static", () => {
    const blocks = blocksOf(`## Wrap-up

Done.`),
      kinds = sectionKindsMd(blocks, { closingPattern: "wrap-up" });
    expect(kinds).toEqual(["closing", "closing"]);
  });
  test("#given body blocks under a section #when classified #then they inherit the enclosing h2 kind", () => {
    const blocks = blocksOf(FIXTURE),
      kinds = sectionKindsMd(blocks),
      codeIndex = blocks.findIndex((b) => b.kind === "code"),
      sourceLine = blocks.findIndex((b) => b.text === "S1 example.org");
    expect(kinds[codeIndex]).toBeNull();
    expect(kinds[sourceLine]).toBe("sources");
    expect(kinds[0]).toBeNull();
  });
});
