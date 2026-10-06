import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  buildAdrBody,
  HOW_THIS_DIRECTORY_WORKS,
  loadAll,
  loadRepo,
  MADR_BODY_TEMPLATE,
  MANAGED_COMMENT,
  markdownHeadings,
  parseAdr,
  parseAdrIndex,
  parseDoneCriteria,
  parseRoadmapIndex,
  parseRound,
  parseStage,
  parseTodo,
  renderAdr,
  renderAdrIndex,
  renderRoadmapIndex,
  renderRound,
  renderStage,
  renderTodo,
  roundSha256,
  stageSha256,
} from "../plugins/roadmap/src/documents.ts";
import { adrFixture, cleanupFixtures, diskFixture, modelFixture, roundFixture, stageFixture, todoFixture } from "./roadmap-fixtures.ts";
import { closedMarkdownBodies, htmlBlankLineBlocks, markdownContainers, markdownStructureEscapes } from "./roadmap-markdown-fixtures.ts";

afterEach(cleanupFixtures);

describe("roadmap managed documents", () => {
  const roundTrip = (name: string, raw: string, roundtrip: (text: string) => string): void => {
    test(`${name} round-trips byte-stably, preserving free bodies and normalizing CRLF`, () => {
      expect(roundtrip(raw)).toBe(raw);
      expect(roundtrip(raw.replaceAll("\n", "\r\n"))).toBe(raw);
      expect(raw).toContain(MANAGED_COMMENT);
    });
    test(`${name} refuses unknown formats`, () => {
      expect(() => roundtrip(raw.replace("format: 1", "format: 2"))).toThrow("Unsupported roadmap format 2");
      expect(() => roundtrip(raw.replace("format: 1", "format: 0"))).toThrow("Unsupported roadmap format 0");
    });
  };
  roundTrip(
    "stage",
    renderStage(
      stageFixture({
        outcome: "### Delivered\n\nA full increment.\n\n### Evidence\n\n- DC1 — pass — Verify: `bun test` → 1 pass — commit abc123",
      }),
    ),
    (text) => renderStage(parseStage(text)),
  );
  roundTrip("round", renderRound(roundFixture()), (text) => renderRound(parseRound(text)));
  const todos = todoFixture();
  todos.items.push(
    {
      id: "T002",
      title: "Waiting",
      status: "open",
      severity: "low",
      source: "S01",
      trigger: "when the host ships a new API",
      carried_from: "T010 (R0)",
      body: "- A free list\n\n```ts\nconst x = 1;\n```",
    },
    { id: "T003", title: "Resolved", status: "resolved", reference: "S01, commit abc123", body: "Historical evidence.  " },
    { id: "T004", title: "Moved", status: "moved", reference: "T002 (carried to R2)", body: "" },
    { id: "T005", title: "Limitation", status: "wontfix", reference: "Known limitations", body: "" },
    { id: "T006", title: "Carried", status: "carried", reference: "next round", body: "" },
  );
  roundTrip("todo", renderTodo(todos), (text) => renderTodo(parseTodo(text)));
  roundTrip("adr", renderAdr(adrFixture()), (text) => renderAdr(parseAdr(text)));
  const model = modelFixture();
  roundTrip("roadmap index", renderRoadmapIndex(model.index, model.rounds, model.stages), (text) =>
    renderRoadmapIndex(parseRoadmapIndex(text)),
  );
  roundTrip("adr index", renderAdrIndex(model.adrIndex as NonNullable<typeof model.adrIndex>, model.adrs), (text) =>
    renderAdrIndex(parseAdrIndex(text)),
  );

  test("rendering refuses unsupported persisted versions for every kind", () => {
    expect(() => renderStage({ ...stageFixture(), format: 2 as 1 })).toThrow("Unsupported");
    expect(() => renderRound({ ...roundFixture(), format: 2 as 1 })).toThrow("Unsupported");
    expect(() => renderTodo({ ...todoFixture(), format: 2 as 1 })).toThrow("Unsupported");
    expect(() => renderAdr({ ...adrFixture(), format: 2 as 1 })).toThrow("Unsupported");
    expect(() => renderRoadmapIndex({ ...model.index, format: 2 as 1 })).toThrow("Unsupported");
    expect(() => renderAdrIndex({ ...(model.adrIndex as NonNullable<typeof model.adrIndex>), format: 2 as 1 })).toThrow("Unsupported");
  });

  test("strict validation rejects YAML fallback, duplicate keys, invalid metadata and fixed headings", () => {
    const raw = renderStage(stageFixture());
    for (const broken of [
      raw.replace('title: "Launch: usable | increment"', 'title: "unterminated'),
      raw.replace("depends_on: []", "depends_on: [S01"),
      raw.replace("depends_on: []", "depends_on: [S01,,S02]"),
      raw.replace("created:", "unknown:"),
      raw.replace("format: 1", "format: 1\nformat: 1"),
      raw.replace('created: "2026-10-06"', 'created: "2026-02-30"'),
      raw.replace("## Objective", "## Wrong heading"),
      raw.replace("## Objective", "Misplaced authored text.\n\n## Objective"),
      raw.replace("### In", "### Not in"),
      raw.replace(MANAGED_COMMENT, "<!-- edited -->"),
      raw.replace("- Verify:", "- Test:"),
    ])
      expect(() => parseStage(broken)).toThrow();
    expect(parseDoneCriteria(stageFixture().done_criteria)).toEqual([
      { id: "DC1", statement: "Users can complete the workflow", verify: "`bun test` and a manual walkthrough" },
    ]);
    expect(() => parseStage(renderStage(stageFixture({ done_criteria: "" })))).toThrow("Done criteria");
    expect(() =>
      parseStage(renderStage(stageFixture({ done_criteria: `${stageFixture().done_criteria}\n${stageFixture().done_criteria}` }))),
    ).toThrow("unique DC");
  });

  test("fixed-looking headings inside fenced Markdown stay free body text", () => {
    const code = "````markdown\n## Not a fixed heading\n### T999 — Not a TODO\n## Closed in this round\n```\n### In\n````";
    const stage = renderStage(stageFixture({ objective: code }));
    expect(renderStage(parseStage(stage))).toBe(stage);
    const round = renderRound(roundFixture({ goal: code }));
    expect(renderRound(parseRound(round))).toBe(round);
    const todo = todoFixture();
    if (todo.items[0]) todo.items[0].body = code;
    const todoText = renderTodo(todo);
    expect(renderTodo(parseTodo(todoText))).toBe(todoText);
    const adr = adrFixture();
    adr.body = buildAdrBody(adr.title, { context: code, options: ["X"], outcome: "Choose X." });
    const adrText = renderAdr(adr);
    expect(renderAdr(parseAdr(adrText))).toBe(adrText);
  });

  test("fence masking follows CommonMark opener info, marker, length and zero-to-three-space indentation rules", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      for (const opener of ["````markdown", "~~~~lang`valid"]) {
        const marker = opener[0] as string;
        const source = `${indent}${opener}\n## Hidden\nEvidence\n--------\n${marker.repeat(3)}\n${marker.repeat(5)} \t\n## Visible`;
        expect(markdownHeadings(source, /^## .+$/gm, { requireClosedFences: true }).map((heading) => heading[0])).toEqual(["## Visible"]);
      }
    }
    for (const opener of ["```lang`invalid", "   ```lang`invalid", "    ```markdown"]) {
      expect(markdownHeadings(`${opener}\n## Visible`, /^## .+$/gm, { requireClosedFences: true }).map((heading) => heading[0])).toEqual([
        "## Visible",
      ]);
    }
    for (const closing of ["```", "~~~~", "```` comment", "    ````", "````\u00a0"]) {
      expect(() => markdownHeadings(`\`\`\`\`markdown\n## Hidden\n${closing}`, /^## .+$/gm, { requireClosedFences: true })).toThrow(
        "Unterminated Markdown fence",
      );
    }
  });

  test("list and quote fences close in their own containers without masking later fixed headings", () => {
    for (const example of closedMarkdownBodies) {
      const source = `${example}\n\n## After`;
      const headings = markdownHeadings(source, /^(#{1,6})[ \t]+(.+)$/gm, { requireClosedFences: true });
      expect(headings.map((heading) => [heading[1], heading[2]])).toEqual([["##", "After"]]);
      expect(headings[0]?.index).toBe(source.indexOf("## After"));
    }
    for (const { first, next } of markdownContainers) {
      const source = `${first}~~~md\n${next}example\n## Outside`;
      expect(markdownHeadings(source, /^## .+$/gm).map((heading) => heading[0])).toEqual(["## Outside"]);
      expect(() => markdownHeadings(source, /^## .+$/gm, { requireClosedFences: true })).toThrow("Unterminated Markdown fence");
    }
  });

  test("HTML types 6 and 7 terminate only at blank lines and type 7 cannot interrupt a paragraph", () => {
    for (const opener of htmlBlankLineBlocks) {
      const source = `${opener}\n~~~\n## Hidden\n</div>\n## Still hidden\n\n## After`;
      expect(markdownHeadings(source, /^## .+$/gm, { requireClosedFences: true }).map((heading) => heading[0])).toEqual(["## After"]);
    }
    for (const opener of ["<custom-element>", "<x attr='value' />", "</x>"]) {
      const source = `Paragraph\n${opener}\n~~~\n## Hidden in code\n~~~\n\n## After`;
      expect(markdownHeadings(source, /^## .+$/gm, { requireClosedFences: true }).map((heading) => heading[0])).toEqual(["## After"]);
    }
    for (const opener of ["<x> trailing text", "<x invalid@attr>", '<x attr="unfinished>', "<x / >", "<x:y>"]) {
      const source = `${opener}\n~~~\n## Hidden in code\n~~~\n\n## After`;
      expect(markdownHeadings(source, /^## .+$/gm, { requireClosedFences: true }).map((heading) => heading[0])).toEqual(["## After"]);
    }
  });

  test("scanner heading levels and text agree with Bun Markdown over the container, Setext, fence and HTML corpus", () => {
    const corpus = [
      ...closedMarkdownBodies,
      ...markdownStructureEscapes.map(({ body }) => body),
      ...markdownContainers.flatMap(({ first, next }) => [
        `${first}### Nested heading\n\n## Outside`,
        `${first}Nested Setext\n${next}--------\n\n## Outside`,
        `${first}paragraph\ncontinued lazily\n---\n## Outside`,
      ]),
      "## Before\n\n````md\n## Hidden\n```\n`````\n## After",
      "   ~~~~lang`valid\nEvidence\n--------\n~~~\n~~~~~\n## After",
      "```lang`invalid\n## Visible\n\nFinal paragraph\n---",
      "Paragraph line\nEvidence\n---\n\n## After",
      "Paragraph\n2. continuation\n---",
      "    Indented code\n    ## Hidden\n\n## After",
      "- paragraph\n    ~~~\n    ## Hidden\n    ~~~\n## After",
      "- \t    code\n  \t    ## Hidden\n  \t\n  \t## After\n\n## Final",
      "> \t<div>\n> \t~~~\n> \t## Hidden\n> \t</div>\n> \t\n> \t## After\n\n## Final",
      "> \t<custom-element>\n> \t~~~\n> \t## Hidden\n> \t</custom-element>\n> \t\n> \t## After\n\n## Final",
      "[ref]: https://example.com\n---\n\n## After",
      "Paragraph\n<custom-element>\n~~~\n## Hidden\n~~~\n\n## After",
      "Paragraph\n<div>\n~~~\n## Hidden\n\n## After",
      "<!--\n## Hidden\n~~~\n-->\n## After",
      "<script>\n## Hidden\n~~~\n</script>\n## After",
      "<?probe\n## Hidden\n?>\n## After",
      "<![CDATA[\n## Hidden\n]]>\n## After",
      "<!DOCTYPE example\n## Hidden\n>\n## After",
    ];
    for (const source of corpus) {
      const scanned = markdownHeadings(source, /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/gm).map((heading) => [
        (heading[1] as string).length,
        (heading[2] ?? "")
          .replace(/[ \t]+#+[ \t]*$/, "")
          .replace(/\s+/g, " ")
          .trim(),
      ]);
      const rendered = [...Bun.markdown.html(source).matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/g)].map((heading) => [
        Number(heading[1]),
        (heading[2] as string).replace(/\s+/g, " ").trim(),
      ]);
      expect({ source, headings: scanned }).toEqual({ source, headings: rendered });
    }
  });

  test("closed container and HTML bodies round-trip through every managed document", () => {
    for (const body of closedMarkdownBodies) {
      const stage = renderStage(stageFixture({ objective: body }));
      expect(renderStage(parseStage(stage))).toBe(stage);
      const round = renderRound(roundFixture({ goal: body }));
      expect(renderRound(parseRound(round))).toBe(round);
      const todos = todoFixture();
      if (todos.items[0]) todos.items[0].body = body;
      const todo = renderTodo(todos);
      expect(renderTodo(parseTodo(todo))).toBe(todo);
      const decision = adrFixture();
      decision.body = buildAdrBody(decision.title, { context: body, options: ["X"], outcome: body, more_info: body });
      const adr = renderAdr(decision);
      expect(renderAdr(parseAdr(adr))).toBe(adr);
    }
  });

  test("headings nested in lists and quotes remain free Markdown in every document and both indexes", () => {
    for (const body of ["- ## List heading", "> ## Quoted heading", "1. Nested Setext\n   --------"]) {
      const stage = renderStage(stageFixture({ objective: body }));
      expect(renderStage(parseStage(stage))).toBe(stage);
      const round = renderRound(roundFixture({ goal: body }));
      expect(renderRound(parseRound(round))).toBe(round);
      const todos = todoFixture();
      if (todos.items[0]) todos.items[0].body = body;
      const todo = renderTodo(todos);
      expect(renderTodo(parseTodo(todo))).toBe(todo);
      const decision = adrFixture();
      decision.body = buildAdrBody(decision.title, { context: body, options: ["X"], outcome: body });
      const adr = renderAdr(decision);
      expect(renderAdr(parseAdr(adr))).toBe(adr);
      const root = modelFixture();
      const index = renderRoadmapIndex(root.index, root.rounds, root.stages).replace(
        "## How this directory works",
        `${body}\n\n## How this directory works`,
      );
      expect(renderRoadmapIndex(parseRoadmapIndex(index))).toBe(index);
      const decisions = renderAdrIndex(root.adrIndex as NonNullable<typeof root.adrIndex>, root.adrs).replace(
        "## Decisions",
        `${body}\n\n## Decisions`,
      );
      expect(renderAdrIndex(parseAdrIndex(decisions))).toBe(decisions);
    }
  });

  const htmlBlocks = [
    ["<ScRiPt>", "</sCrIpT>"],
    ["<pre class=example>", "</PRE>"],
    ["<STYLE>", "</style>"],
    ["<TeXtArEa>", "</TEXTAREA>"],
    ["<!--", "-->"],
    ["<?probe", "?>"],
    ["<!DOCTYPE example", ">"],
    ["<![CDATA[", "]]>"],
  ] as const;

  test("HTML block types 1-5 mask ATX, Setext and fence examples while retaining visible source offsets", () => {
    for (const [opener, closer] of htmlBlocks) {
      for (const indent of ["", " ", "  ", "   "]) {
        const source = `## Before\n\n${indent}${opener}\n## Hidden\nEvidence\n--------\n\n~~~markdown\n${closer}\n## After`;
        const headings = markdownHeadings(source, /^## .+$/gm, { requireClosedFences: true });
        expect(headings.map((heading) => heading[0])).toEqual(["## Before", "## After"]);
        expect(headings[1]?.index).toBe(source.indexOf("## After"));
        expect(Bun.markdown.html(source)).toContain("<h2>After</h2>");
        expect(Bun.markdown.html(source)).not.toContain("<h2>Hidden</h2>");
        const sameLine = `${opener} example ${closer}\n## After`;
        expect(markdownHeadings(sameLine, /^## .+$/gm).map((heading) => heading[0])).toEqual(["## After"]);
      }
    }
    // CommonMark raw-text blocks end on any of the four closing tags, even a different tag.
    expect(markdownHeadings("<script\n## Hidden\n</textarea>\n## After", /^## .+$/gm).map((heading) => heading[0])).toEqual(["## After"]);
    expect(markdownHeadings("Paragraph\n<!--\nEvidence\n---\n-->\n---", /^## .+$/gm)).toEqual([]);
  });

  test("unterminated HTML blocks are structural escapes even after blank lines, Markdown fences or fixed headings", () => {
    for (const [opener] of htmlBlocks) {
      for (const indent of ["", "   "]) {
        const source = `Authored text.\n\n${indent}${opener}\n\n~~~\n## Hidden\n~~~\n\n## Later`;
        expect(() => markdownHeadings(source, /^## .+$/gm)).toThrow("Unterminated HTML block");
        expect(() => markdownHeadings(source, /^## .+$/gm, { requireClosedFences: true })).toThrow("Unterminated HTML block");
      }
    }
    expect(() => markdownHeadings("<script>\n</script >\n## Hidden", /^## .+$/gm)).toThrow("Unterminated HTML block");
    expect(() => markdownHeadings("<?probe\n>\n## Hidden", /^## .+$/gm)).toThrow("Unterminated HTML block");
  });

  test("inline HTML, escaped openers, non-block tag names and HTML examples in code do not swallow headings", () => {
    for (const source of [
      "Inline <span>text</span> and <script>example</script>.",
      "Inline <!-- incomplete comment is plain text.",
      "\\<!--",
      "<!doctype example",
      "<scripture>",
      "<script-example>",
      "    <!--",
      "\t<script>",
      ...htmlBlocks.map(([opener]) => `~~~markdown\n${opener}\n## Example\n~~~`),
    ]) {
      expect(markdownHeadings(`${source}\n\n## After`, /^## .+$/gm, { requireClosedFences: true }).map((heading) => heading[0])).toEqual([
        "## After",
      ]);
    }
  });

  test("closed HTML examples round-trip inside every managed body while preserving fixed headings and TODO identities", () => {
    for (const [opener, closer] of htmlBlocks) {
      const example = `${opener}\n## Example\n### In\n### T999 — Example\n## Closed in this round\n${closer}`;
      const stage = renderStage(stageFixture({ objective: example }));
      expect(renderStage(parseStage(stage))).toBe(stage);
      const round = renderRound(roundFixture({ goal: example }));
      expect(renderRound(parseRound(round))).toBe(round);
      const todos = todoFixture();
      if (todos.items[0]) todos.items[0].body = example;
      todos.items.push({ id: "T002", title: "Later item", status: "resolved", reference: "Verified", body: example });
      const todo = renderTodo(todos);
      expect(parseTodo(todo).items.map((item) => item.id)).toEqual(["T001", "T002"]);
      expect(renderTodo(parseTodo(todo))).toBe(todo);
      const adr = adrFixture();
      adr.body = buildAdrBody(adr.title, { context: example, options: ["X"], outcome: example, more_info: example });
      const decision = renderAdr(adr);
      expect(renderAdr(parseAdr(decision))).toBe(decision);
    }
  });

  test("parsing stored stage, round, TODO and ADR documents rejects headings hidden in unclosed HTML", () => {
    for (const [opener] of htmlBlocks) {
      const body = `Authored text.\n\n${opener}`;
      expect(() => parseStage(renderStage(stageFixture({ objective: body })))).toThrow();
      expect(() => parseStage(renderStage(stageFixture({ outcome: `### Delivered\n\n${body}\n\n### Evidence\nHidden.` })))).toThrow();
      expect(() => parseRound(renderRound(roundFixture({ goal: body })))).toThrow();
      const todos = todoFixture();
      if (todos.items[0]) todos.items[0].body = body;
      expect(() => parseTodo(renderTodo(todos))).toThrow();
      const adr = adrFixture();
      adr.body = buildAdrBody(adr.title, { context: body, options: ["X"], outcome: "Choose X." });
      expect(() => parseAdr(renderAdr(adr))).toThrow();
    }
  });

  test("Setext headings preserve source spans and include their preceding paragraph lines", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      for (const [underline, level] of [
        ["=", 1],
        ["--", 2],
      ] as const) {
        const title = `${indent}Paragraph line\n${indent}Evidence\n${indent}${underline} \t`;
        const source = `Before.\n\n${title}\n\nAfter.`;
        const headings = markdownHeadings(source, /^(#{1,6})(?:[ \t]+(.*))?$/gm, { requireClosedFences: true });
        expect(headings).toHaveLength(1);
        const heading = headings[0];
        expect(heading?.[0]).toBe(title);
        expect(heading?.[1]).toBe("#".repeat(level));
        expect(heading?.[2]).toBe("Paragraph line Evidence");
        expect(heading?.index).toBe(source.indexOf(title));
      }
    }
    expect(markdownHeadings("Paragraph\n2. continuation\n---", /^(#{1,6})(?:[ \t]+(.*))?$/gm)[0]?.[1]).toBe("##");
  });

  test("horizontal rules without paragraph context are not Setext headings", () => {
    for (const source of [
      "---\n\nText.",
      "Text.\n\n---",
      "#### Details\n---",
      "Text.\n- A list item\n---",
      "Text.\n1. A list item\n---",
      "Text.\n\n    Indented code\n---",
      "Text.\n- - -",
      "Text.\n* * *",
      "Text.\n___",
      "~~~markdown\nEvidence\n---\n~~~\n---",
    ]) {
      expect(markdownHeadings(source, /^(#{1,2})(?:[ \t]+(.*))?$/gm, { requireClosedFences: true })).toEqual([]);
    }
  });

  test("quoted metadata retains hashes, commas and apostrophes; plain canonical YAML scalars are accepted", () => {
    const doc = stageFixture({ title: "A title # with an apostrophe's text", depends_on: ["S02", "S03"] });
    const raw = renderStage(doc);
    expect(renderStage(parseStage(raw))).toBe(raw);
    const plain = raw
      .replace('id: "S01"', "id: S01")
      .replace('round: "R1"', "round: R1")
      .replace('status: "planned"', "status: planned # allowed comment")
      .replace('depends_on: ["S02", "S03"]', "depends_on: [S02, S03]")
      .replace('created: "2026-10-06"', "created: 2026-10-06");
    expect(parseStage(plain).depends_on).toEqual(["S02", "S03"]);
    expect(parseStage(plain).created).toBe("2026-10-06");
    const adr = renderAdr(adrFixture({ decision_makers: ["Person #1", "Person, #2", "Owner's delegate"] }));
    expect(renderAdr(parseAdr(adr))).toBe(adr);
  });

  test("indexes reject changed fixed headings and TODOs render arrow dispositions", () => {
    const index = renderRoadmapIndex(model.index, model.rounds, model.stages);
    expect(() => parseRoadmapIndex(index.replace("## Current status", "## Changed"))).toThrow("fixed");
    const adrIndex = renderAdrIndex(model.adrIndex as NonNullable<typeof model.adrIndex>, model.adrs);
    expect(() => parseAdrIndex(adrIndex.replace("## Decisions", "## Changed"))).toThrow("fixed");
    const todo = renderTodo(todos);
    expect(todo).toContain("- Moved → T002 (carried to R2)");
    expect(todo).toContain("- Won't fix → Known limitations");
    expect(() => parseTodo(todo.replace("## Closed in this round\n\n", "## Closed in this round\n"))).toThrow("separator");
  });

  test("MADR body and headings come from the vendored template, without its optional front matter", async () => {
    const template = await readFile(new URL("../plugins/roadmap/assets/madr/adr-template.md", import.meta.url), "utf8");
    expect(MADR_BODY_TEMPLATE).toBe(template.slice(template.indexOf("\n---\n") + 6));
    expect(parseAdr(renderAdr({ ...adrFixture(), body: MADR_BODY_TEMPLATE }))).toBeDefined();
    const body = buildAdrBody("Choose X", {
      context: "Problem.",
      options: ["X", "Y"],
      outcome: 'Chosen option: "X".',
      confirmation: "Test X.",
    });
    expect(body).toContain("## Context and Problem Statement");
    expect(body).toContain("### Confirmation\nTest X.");
    expect(body).not.toContain("Decision Drivers");
    expect(body).not.toContain("Implementation Plan");
    expect(body).not.toContain("{title");
    expect(parseAdr(renderAdr({ ...adrFixture(), body })).title).toBe("Choose X");
    expect(() => parseAdr(renderAdr({ ...adrFixture(), body: body.replace("## Decision Outcome", "## Decision") }))).toThrow("MADR");
  });

  test("directory explanation carries the format, freeze, managed write, recovery and semantic limits", () => {
    for (const phrase of [
      "format: 1",
      "roadmap_*",
      "check --fix",
      "closed_sha256",
      "frozen_sha256",
      "per-file atomic",
      "Restore other damage with git",
      "cannot determine whether code",
    ]) {
      expect(HOW_THIS_DIRECTORY_WORKS).toContain(phrase);
    }
    expect(renderRoadmapIndex(model.index)).toContain(HOW_THIS_DIRECTORY_WORKS);
  });
});

describe("hash definitions", () => {
  test("stage known digest removes only the hash line, normalizes LF and retains trailing whitespace", () => {
    const doc = stageFixture({ objective: "Hash fixture.  " });
    const raw = renderStage(doc);
    const expected = createHash("sha256")
      .update(raw.replace(/^closed_sha256:[^\n]*\n/m, ""))
      .digest("hex");
    expect(stageSha256(doc)).toBe(expected);
    expect(stageSha256(parseStage(raw.replaceAll("\n", "\r\n")))).toBe(expected);
    expect(stageSha256({ ...doc, closed_sha256: "a".repeat(64) })).toBe(expected);
    expect(stageSha256({ ...doc, objective: "Hash fixture." })).not.toBe(expected);
    // Independent fixed fixture: changes to rendering must consciously update this digest.
    expect(expected).toBe("69f031aab9bb1fa167285b66618019c4ad14a1863e953569bf2a5d55d75ca6e8");
  });

  test("hashes parsed stage source bytes rather than reordering a hand-edited header", () => {
    const raw = renderStage(stageFixture()).replace("started: null\nclosed: null", "closed: null\nstarted: null");
    expect(stageSha256(parseStage(raw))).toBe(
      createHash("sha256")
        .update(raw.replace(/^closed_sha256:[^\n]*\n/m, ""))
        .digest("hex"),
    );
  });

  test("round known digest sorts relative paths, hashes file bytes and ignores only README freeze field", () => {
    const files = { "stages/02-b.md": "B\r\n", "README.md": "---\nformat: 1\nfrozen_sha256: null\n---\nRound.  \n", "TODO.md": "A\n" };
    expect(roundSha256(files)).toBe("e63ba2925a7421b555726428f07401894dbbbdbd77eec54d3cdee51c851d6ab0");
    expect(roundSha256(new Map(Object.entries(files).reverse()))).toBe(roundSha256(files));
    expect(roundSha256({ ...files, "README.md": files["README.md"].replace("null", "a".repeat(64)) })).toBe(roundSha256(files));
    expect(roundSha256({ ...files, "stages/02-b.md": "B\n" })).not.toBe(roundSha256(files));
    expect(roundSha256({ ...files, "TODO.md": "A\nfrozen_sha256: null\n" })).not.toBe(roundSha256(files));
    expect(() => roundSha256({ "../outside": "bad" })).toThrow("relative");
  });
});

describe("repository loading", () => {
  test("marker is required, all kinds load from disk, and a nested cwd resolves the git root", async () => {
    const { repo } = await diskFixture();
    await mkdir(join(repo.repoRoot, "src"), { recursive: true });
    expect(await loadRepo(join(repo.repoRoot, "src"))).toEqual(repo);
    const model = await loadAll(repo);
    expect(model.parseErrors).toEqual([]);
    expect(model.rounds.map((doc) => doc.id)).toEqual(["R1"]);
    expect(model.stages.map((doc) => doc.id)).toEqual(["S01"]);
    expect(model.todos[0]?.items[0]?.id).toBe("T001");
    expect(model.adrs[0]?.id).toBe("ADR-0001");
    expect(model.adrIndex?.path).toBe(join(repo.adrDir, "README.md"));
    await writeFile(join(repo.roadmapDir, "README.md"), "# Unmanaged project\n");
    expect(await loadRepo(repo.repoRoot)).toBeNull();
    expect(await loadRepo(dirname(repo.repoRoot))).toBeNull();
  });

  test("a marker mentioned only in README prose does not initialize the repository", async () => {
    const { repo } = await diskFixture();
    const path = join(repo.roadmapDir, "README.md");
    const raw = (await readFile(path, "utf8")).replace("roadmap: { format: 1 }\n", "");
    expect(raw).toContain("roadmap: { format: 1 }");
    await writeFile(path, raw);
    expect(await loadRepo(repo.repoRoot)).toBeNull();
  });

  test("unknown initialization format pauses, and malformed children become checker diagnostics", async () => {
    const { repo } = await diskFixture();
    const index = join(repo.roadmapDir, "README.md");
    const raw = await readFile(index, "utf8");
    await writeFile(index, raw.replace("roadmap: { format: 1 }", "roadmap: { format: 2 }"));
    await expect(loadRepo(repo.repoRoot)).rejects.toThrow("Unsupported roadmap format 2");
    await writeFile(index, raw);
    const stage = join(repo.roadmapDir, "01-launch/stages/01-launch.md");
    await writeFile(stage, renderStage(stageFixture()).replace("format: 1", "format: 99"));
    const model = await loadAll(repo);
    expect(model.stages).toEqual([]);
    expect(model.parseErrors).toEqual([{ rule: "format", path: stage, message: "Unsupported roadmap format 99; supported format is 1." }]);
  });

  test("file numbers and round membership must agree with their document metadata", async () => {
    const { repo, model } = await diskFixture();
    const stage = model.stages[0] as (typeof model.stages)[number];
    await writeFile(stage.path, renderStage({ ...stage, id: "S02", round: "R2" }));
    const adr = model.adrs[0] as (typeof model.adrs)[number];
    await writeFile(adr.path, renderAdr({ ...adr, id: "ADR-0002" }));
    const todo = model.todos[0] as (typeof model.todos)[number];
    await writeFile(todo.path, renderTodo({ ...todo, round: "R2" }));
    const loaded = await loadAll(repo);
    expect(loaded.parseErrors?.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "Stage file requires NN-slug.md naming with its stage number.",
        "Stage round does not match its directory charter.",
        "TODO round does not match its directory charter.",
        "ADR file requires NNNN-slug.md naming with its ADR number.",
      ]),
    );
  });
});
