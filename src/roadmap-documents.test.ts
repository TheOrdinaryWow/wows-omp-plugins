import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseHtml, proseText } from "../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";
import {
  buildAdrBody,
  DocumentError,
  generatedBlock,
  generatedContent,
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
  replaceGenerated,
  roundSha256,
  stageSha256,
  validateBody,
} from "../plugins/roadmap/src/documents.ts";
import { stage } from "../plugins/roadmap/src/operations.ts";
import { adrFixture, cleanupFixtures, diskFixture, modelFixture, roundFixture, stageFixture, todoFixture } from "./roadmap-fixtures.ts";
import {
  allowedMarkdownBodies,
  ambiguousMarkdownBodies,
  closedContainerFences,
  literalMarkdownBodies,
  markdownStructureEscapes,
  randomizedMarkdownBodies,
  rejectedMarkdownBodies,
  reportedMarkdownBodies,
} from "./roadmap-markdown-fixtures.ts";

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

  test("generated delimiters inside closed fences remain literal in every round section", () => {
    for (const marker of ["`", "~"]) {
      for (const indent of ["", "   "]) {
        const example = `Example:\n\n${indent}${marker.repeat(4)}md\n## Stages\n${generatedBlock("stages", "Literal text")}\n${generatedBlock("status", "Literal status")}\n${marker.repeat(3)}\n${marker.repeat(5)} \t`;
        const real = generatedBlock("stages", "Real stages");
        const doc = roundFixture({
          goal: example,
          constraints: example,
          non_goals: example,
          principles: example,
          stages: `${example}\n\n${real}\n\n${example}`,
          known_limitations: example,
        });
        const text = renderRound(doc);
        for (const raw of [text, text.replaceAll("\n", "\r\n")]) {
          expect(renderRound(parseRound(raw))).toBe(text);
          expect(generatedContent(raw, "stages")).toBe("Real stages");
          const replacement = generatedBlock("stages", "Regenerated stages");
          const newline = raw.includes("\r\n") ? "\r\n" : "\n";
          expect(replaceGenerated(raw, "stages", "Regenerated stages")).toBe(
            raw.replace(real.replaceAll("\n", newline), replacement.replaceAll("\n", newline)),
          );
        }
        const stage = renderStage(stageFixture({ objective: example, design_constraints: example, risks: example }));
        expect(renderStage(parseStage(stage))).toBe(stage);
        const decision = adrFixture();
        decision.body = buildAdrBody(decision.title, {
          context: example,
          options: ["Keep literals"],
          outcome: example,
          consequences: example,
          confirmation: example,
          more_info: example,
        });
        const adr = renderAdr(decision);
        expect(renderAdr(parseAdr(adr))).toBe(adr);
      }
    }
  });

  test("index generation replaces only unfenced blocks in their owning sections", () => {
    for (const fence of ["```", "~~~"]) {
      const example = `${fence}md\n${["rounds", "status", "adrs"].map((name) => generatedBlock(name, "Literal text")).join("\n")}\n${fence}`;
      const index = renderRoadmapIndex(model.index, model.rounds, model.stages).replace(
        "## How this directory works\n",
        `## How this directory works\n\n${example}\n`,
      );
      expect(renderRoadmapIndex(parseRoadmapIndex(index))).toBe(index);
      for (const name of ["rounds", "status"]) {
        const real = generatedBlock(name, generatedContent(index, name));
        expect(replaceGenerated(index, name, "Updated")).toBe(index.replace(real, generatedBlock(name, "Updated")));
      }
      const decisions = renderAdrIndex(model.adrIndex as NonNullable<typeof model.adrIndex>, model.adrs).replace(
        "## Decisions\n",
        `## Decisions\n\n${example}\n`,
      );
      expect(renderAdrIndex(parseAdrIndex(decisions))).toBe(decisions);
      const real = generatedBlock("adrs", generatedContent(decisions, "adrs"));
      expect(replaceGenerated(decisions, "adrs", "Updated")).toBe(decisions.replace(real, generatedBlock("adrs", "Updated")));
    }
  });

  test("fenced examples cannot supply missing real blocks or hide duplicate and nested real blocks", () => {
    for (const name of ["stages", "rounds", "status", "adrs"]) {
      const literal = `~~~md\n${generatedBlock(name, "Literal")}\n~~~`;
      const real = generatedBlock(name, "Real");
      for (const broken of [literal, `${literal}\n\n${real}\n\n${real}`, `${literal}\n\n<!-- roadmap:generated:${name} -->\nUnclosed`]) {
        expect(() => generatedContent(broken, name)).toThrow("Missing or duplicate");
        expect(() => replaceGenerated(broken, name, "Updated")).toThrow("Missing or duplicate");
      }
      expect(() => generatedContent(`${literal}\n\n${generatedBlock(name, generatedBlock("nested", "Inner"))}`, name)).toThrow("Nested");
      expect(generatedContent(generatedBlock(name, literal), name)).toBe(literal);
    }
    expect(() =>
      parseRound(
        renderRound(roundFixture({ stages: "~~~md\n<!-- roadmap:generated:stages -->\nLiteral\n<!-- /roadmap:generated -->\n~~~" })),
      ),
    ).toThrow("Missing or duplicate");
  });

  test("generated blocks cannot move outside their owning sections or cross section boundaries", () => {
    const index = renderRoadmapIndex(model.index, model.rounds, model.stages);
    for (const [name, heading] of [
      ["rounds", "## Current status"],
      ["status", "## Rounds"],
    ]) {
      const real = generatedBlock(name as string, generatedContent(index, name as string));
      const moved = index.replace(real, "").replace(`${heading}\n`, `${heading}\n\n${real}\n`);
      expect(() => parseRoadmapIndex(moved)).toThrow("section");
      expect(() => generatedContent(moved, name as string)).toThrow("section");
      expect(() => replaceGenerated(moved, name as string, "Updated")).toThrow("section");
    }
    const decisions = renderAdrIndex(model.adrIndex as NonNullable<typeof model.adrIndex>, model.adrs);
    const real = generatedBlock("adrs", generatedContent(decisions, "adrs"));
    expect(() => parseAdrIndex(decisions.replace(real, "").replace("## Decisions", `${real}\n\n## Decisions`))).toThrow("section");
    const crossing = "## Stages\n\n<!-- roadmap:generated:stages -->\nTable\n\n## Known limitations\n<!-- /roadmap:generated -->";
    expect(() => generatedContent(crossing, "stages")).toThrow("section");
  });

  test("stored-document scan masks only closed top-level fences and retains source offsets", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      for (const opener of ["````markdown", "~~~~markdown"]) {
        const marker = opener[0] as string;
        const source = `${indent}${opener}\n## Hidden\n<script>\nEvidence\n--------\n${marker.repeat(3)}\n${marker.repeat(5)} \t\n## Visible`;
        const headings = markdownHeadings(source, /^## .+$/gm);
        expect(headings.map((heading) => heading[0])).toEqual(["## Visible"]);
        expect(headings[0]?.index).toBe(source.indexOf("## Visible"));
        expect(headings[0]?.input).toBe(source);
      }
    }
    for (const opener of ["```lang`invalid", "   ```lang`invalid", "    ```markdown", "\t~~~markdown"]) {
      expect(() => markdownHeadings(`${opener}\n## Visible`, /^## .+$/gm)).toThrow();
    }
    for (const closing of ["```", "~~~~", "```` comment", "    ````", "````\u00a0"]) {
      expect(() => markdownHeadings(`\`\`\`\`markdown\n## Hidden\n${closing}`, /^## .+$/gm)).toThrow();
    }
  });

  test("unsupported stored HTML, references, Setext and container fences are structural errors, not emulated blocks", () => {
    for (const body of [
      ...reportedMarkdownBodies,
      ...markdownStructureEscapes.map(({ body }) => body),
      ...ambiguousMarkdownBodies.map(({ body }) => body),
      ...closedContainerFences.map(({ body }) => body),
      "<!-- closed comment -->",
      "Inline <span>HTML</span>.",
      "Paragraph\n---",
      "===",
      "- - -",
      "* * *",
      "___",
      "- ## Nested heading",
      "> ## Quoted heading",
      "1. Nested Setext\n   --------",
      "- Item\nlazy paragraph\n  ```md\n## Hidden\n  ```",
      "- Item\nlazy paragraph\n  ~~~md\n## Hidden\n  ~~~",
      "\\`<script>`",
    ]) {
      expect(() => markdownHeadings(body, /^## .+$/gm), body).toThrow();
      expect(() => parseStage(renderStage(stageFixture({ objective: body }))), body).toThrow();
      expect(() => parseRound(renderRound(roundFixture({ goal: body }))), body).toThrow();
      const todos = todoFixture();
      if (todos.items[0]) todos.items[0].body = body;
      expect(() => parseTodo(renderTodo(todos)), body).toThrow();
      const decision = adrFixture();
      decision.body = buildAdrBody(decision.title, { context: body, options: ["Host"], outcome: "Choose Host." });
      expect(() => parseAdr(renderAdr(decision)), body).toThrow();
    }
  });

  test("tool-owned bodies accept only plain text, flat lists and closed top-level fences", () => {
    for (const body of allowedMarkdownBodies) expect(() => validateBody(body), body).not.toThrow();
    for (const body of rejectedMarkdownBodies) expect(() => validateBody(body), body).toThrow();
    for (const body of ["<script>", "## Heading", "[x]: /url", "~~~"]) {
      expect(() => validateBody(`Literal \`${body}\` text.`)).not.toThrow();
      expect(() => validateBody(`\`open\n${body}\n\``)).toThrow();
    }
    expect(() => validateBody("- List item", { inlineOnly: true })).toThrow();
    expect(() => validateBody("Plain `inline` text", { inlineOnly: true })).not.toThrow();
    expect(() => validateBody("   ~~~md\nLiteral\n~~~", { afterList: true })).toThrow();
    expect(() => validateBody("Example:\n\n   ~~~md\nLiteral\n~~~", { afterList: true })).not.toThrow();
  });

  test("literal punctuation remains plain text in block and single-line bodies", () => {
    for (const body of literalMarkdownBodies) {
      for (const options of [{}, { inlineOnly: true }, { afterList: true }]) {
        expect(() => validateBody(body, options), body).not.toThrow();
      }
      const stage = renderStage(stageFixture({ objective: body, design_constraints: body, risks: body }));
      expect(renderStage(parseStage(stage)), body).toBe(stage);
      const round = renderRound(roundFixture({ goal: body }));
      expect(renderRound(parseRound(round)), body).toBe(round);
      const todo = renderTodo({
        ...todoFixture(),
        items: [{ id: "T001", title: "Punctuation", status: "open", severity: "normal", source: "Review", trigger: "Later", body }],
      });
      expect(renderTodo(parseTodo(todo)), body).toBe(todo);
      const decision = adrFixture();
      decision.body = buildAdrBody(decision.title, { context: body, options: [body], outcome: body });
      const adr = renderAdr(decision);
      expect(renderAdr(parseAdr(adr)), body).toBe(adr);
    }
  });

  test("seeded body grammar never accepts text that changes any rendered fixed heading", () => {
    const seed = 0x6e7d9411;
    const profiles = [
      {
        name: "stage",
        afterList: false,
        render: (body: string) =>
          renderStage(stageFixture({ title: "Body fixture", objective: body, risks: "Plain risk.", amendments: "" })),
        headings: [
          "# S01 — Body fixture",
          "## Objective",
          "## Scope",
          "### In",
          "### Out",
          "## Done criteria",
          "## Design constraints",
          "## Risks",
          "## Amendments",
          "## Free-work log",
        ],
      },
      {
        name: "round",
        afterList: false,
        render: (body: string) => renderRound(roundFixture({ title: "Body fixture", goal: body })),
        headings: [
          "# R1 — Body fixture",
          "## Goal",
          "## Constraints",
          "## Non-goals",
          "## Principles",
          "## Stages",
          "## Known limitations",
        ],
      },
      {
        name: "todo",
        afterList: true,
        render: (body: string) =>
          renderTodo({
            ...todoFixture(),
            items: [
              { id: "T001", title: "First", status: "open", severity: "normal", source: "Review", trigger: "Later", body },
              { id: "T002", title: "Second", status: "open", severity: "normal", source: "Review", trigger: "Later", body: "Plain text." },
            ],
          }),
        headings: ["# R1 — TODO", "## Open", "### T001 — First", "### T002 — Second", "## Closed in this round"],
      },
      {
        name: "adr",
        afterList: false,
        render: (body: string) =>
          renderAdr({
            ...adrFixture(),
            title: "Body fixture",
            body: buildAdrBody("Body fixture", {
              context: body,
              drivers: "Plain drivers.",
              options: ["Host"],
              outcome: "Plain outcome.",
              consequences: "Plain effects.",
              confirmation: "Plain verification.",
              pros_cons: "Plain tradeoffs.",
              more_info: "Plain information.",
            }),
          }),
        headings: [
          "# Body fixture",
          "## Context and Problem Statement",
          "## Decision Drivers",
          "## Considered Options",
          "## Decision Outcome",
          "### Consequences",
          "### Confirmation",
          "## Pros and Cons of the Options",
          "## More Information",
        ],
      },
    ];
    let accepted = 0;
    let rejected = 0;
    const bodies = new Set([...allowedMarkdownBodies, ...rejectedMarkdownBodies, ...randomizedMarkdownBodies(seed, 12_000)]);
    for (const body of bodies) {
      for (const profile of profiles) {
        try {
          validateBody(body, { afterList: profile.afterList });
        } catch (error) {
          if (!(error instanceof DocumentError)) throw error;
          rejected++;
          continue;
        }
        accepted++;
        const source = profile.render(body).replace(/^---\n[\s\S]*?\n---\n/, "");
        const html = Bun.markdown.html(source);
        const rendered: string[] = [];
        type HtmlNode = { tag: string; children: HtmlNode[] };
        function visit(node: HtmlNode): void {
          if (["pre", "code", "script", "style", "textarea", "svg"].includes(node.tag)) return;
          if (/^h[1-6]$/.test(node.tag)) rendered.push(`${"#".repeat(Number(node.tag[1]))} ${proseText(node)}`);
          for (const child of node.children) visit(child);
        }
        visit(parseHtml(html));
        if (rendered.join("\n") !== profile.headings.join("\n"))
          throw new Error(
            `Markdown differential mismatch ${JSON.stringify({
              seed: `0x${seed.toString(16)}`,
              profile: profile.name,
              body,
              source,
              html,
              rendered,
              expected: profile.headings,
            })}`,
          );
        expect(rendered).toEqual(profile.headings);
      }
    }
    expect(bodies.size).toBeGreaterThan(8_000);
    expect(accepted).toBeGreaterThan(4_000);
    expect(rejected).toBeGreaterThan(4_000);
    console.log(`Markdown differential seed=0x${seed.toString(16)} cases=${bodies.size} accepted=${accepted} rejected=${rejected}`);
  });

  test("allowed prose, lists, inline code and top-level fences round-trip through every managed document", () => {
    for (const body of allowedMarkdownBodies) {
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

  test("indexes refuse stored quote, HTML and reference syntax without modifying their input", () => {
    for (const body of ["> ## Quoted heading", "<div>\n## Hidden\n</div>", "[reference]: /url"]) {
      const root = modelFixture();
      const index = renderRoadmapIndex(root.index, root.rounds, root.stages).replace(
        "## How this directory works",
        `${body}\n\n## How this directory works`,
      );
      const decisions = renderAdrIndex(root.adrIndex as NonNullable<typeof root.adrIndex>, root.adrs).replace(
        "## Decisions",
        `${body}\n\n## Decisions`,
      );
      expect(() => parseRoadmapIndex(index)).toThrow();
      expect(() => parseAdrIndex(decisions)).toThrow();
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
    expect(() => parseAdr(renderAdr({ ...adrFixture(), body: MADR_BODY_TEMPLATE }))).toThrow();
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

  test("refused authored syntax leaves stage and generated index bytes unchanged", async () => {
    const { repo } = await diskFixture();
    const before = (await loadAll(repo)).files;
    for (const body of reportedMarkdownBodies) {
      const receipt = await stage(repo, { kind: "main", sessionId: "body-boundary" }, { action: "edit", id: "S01", objective: body });
      expect(receipt.ok).toBe(false);
      if (!receipt.ok) expect(receipt.hints.length).toBeGreaterThan(0);
      expect((await loadAll(repo)).files).toEqual(before);
    }
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
