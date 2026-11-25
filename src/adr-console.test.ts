import { expect, test } from "bun:test";

// Registers the terminal look of the host's bare sheet, which frames nothing itself.
import "@oh-my-pi/pi-coding-agent/ui/styles/overlays/bare-sheet";
import { signal, type UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";

import {
  AdrConsole,
  AdrPreview,
  type ConsoleEntry,
  type ConsoleResult,
  type ConsoleState,
  type DecisionAction,
} from "../plugins/adr/src/console.ts";
import type { AdrRecord } from "../plugins/adr/src/documents.ts";
import { h } from "../plugins/adr/src/tsp.ts";

function entry(id: string, status: AdrRecord["status"], offered: DecisionAction[], extra: Partial<AdrRecord> = {}): ConsoleEntry {
  const title = extra.title ?? `Decision ${id}`;
  return {
    record: {
      id,
      title,
      status,
      date: "2026-10-01",
      supersedes: [],
      decision_makers: [],
      consulted: [],
      informed: [],
      path: `docs/adr/${id.slice(4)}-decision.md`,
      body: "",
      legacy: false,
      ...extra,
    },
    detail: [
      `${id} — ${title}`,
      `Status: ${status}; date 2026-10-01`,
      `File: docs/adr/${id.slice(4)}-decision.md`,
      "",
      "## Context and Problem Statement",
      "",
      Array.from({ length: 40 }, (_, index) => `Paragraph line ${index + 1} explains the context in some detail.`).join("\n\n"),
    ].join("\n"),
    offered,
  };
}

const entries = [
  entry("ADR-0001", "accepted", ["reject", "deprecate", "note", "supersede"]),
  entry("ADR-0002", "proposed", ["accept", "reject", "deprecate", "note"], {
    title: "A very long decision title that keeps going well past the width of any reasonable sidebar column",
  }),
  entry("ADR-0003", "superseded", ["note"], { superseded_by: "ADR-0004" }),
  entry("ADR-0004", "accepted", ["reject", "deprecate", "note", "supersede"], { title: "Cache reads" }),
];

/** Mounts a view the way the host does for a fullscreen `custom` overlay in a plain terminal (`extensionOverlay`). */
function terminal(make: (host: { size: () => { columns: number; rows: number } }) => { root: UiNode }, columns = 100, rows = 24) {
  const size = signal({ columns, rows });
  const view = make({ size: () => size() });
  const term = createTestTerminal(() => ({ layer: h("overlay", { key: "extension", size: "full", role: "omp.sheet.bare" }, view.root) }), {
    columns,
    rows,
  });
  term.focus(view.root);
  return {
    term,
    text: () => term.screen().join("\n"),
    resize(nextColumns: number, nextRows: number) {
      size.set({ columns: nextColumns, rows: nextRows });
      term.resize(nextColumns, nextRows);
    },
  };
}

function mount(list = entries, state: ConsoleState = { query: "" }, columns = 100, rows = 24) {
  const results: Array<{ result: ConsoleResult; state: ConsoleState }> = [];
  const mounted = terminal(
    (host) => new AdrConsole(list, state, host, (result, next) => results.push({ result, state: next })),
    columns,
    rows,
  );
  return { ...mounted, results };
}

/** The body pane: the screen rows right of the sidebar. */
function bodyRows(text: string): string[] {
  return text
    .split("\n")
    .slice(3, 12)
    .map((row) => row.slice(40).trim());
}

test("a framed sheet fills the terminal exactly and never exceeds its width, including empty and narrow consoles", () => {
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
    [40, 12],
  ] as const) {
    const views = [
      mount(entries, { query: "" }, columns, rows),
      mount([], { query: "" }, columns, rows),
      terminal(
        (host) =>
          new AdrPreview(
            "Initialize ADR management: docs/adr/README.md becomes the marker and generated index.",
            [{ path: "docs/adr/README.md", content: entries[0]?.detail ?? "" }],
            host,
            () => {},
          ),
        columns,
        rows,
      ),
    ];
    for (const { term } of views) {
      const screen = term.screen();
      expect(screen).toHaveLength(rows);
      expect(screen[0]).toContain("ADR · ");
      for (const row of term.rows()) expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
      term.dispose();
    }
  }
  const empty = mount([]);
  expect(empty.text()).toMatch(/No ADRs yet; press Shift\+O to start one/);
  expect(empty.text()).toContain("ADR · no ADRs yet");
});

test("the sheet keeps its title and key hints when the terminal is resized", () => {
  const { term, resize } = mount();
  resize(120, 40);
  expect(term.screen()).toHaveLength(40);
  expect(term.screen()[0]).toContain("ADR · 1 proposed, 2 accepted, 1 superseded");
  expect(term.screen().at(-2)).toMatch(/↑↓ select .*PgUp PgDn scroll .*Tab filter .*Esc close/);
});

test("arrows move the selection and the detail pane shows the selected decision", () => {
  const { term, text } = mount();
  expect(text()).toMatch(/ADR-0001 {2}Decision ADR-0001/);
  expect(text()).toMatch(/❯ ADR-0001 Decision ADR-0001/);
  term.press("down");
  expect(text()).toMatch(/ADR-0002 {2}A very long decision title/);
  expect(text()).toMatch(/❯ ADR-0002 A very long/);
  term.press("end");
  expect(text()).toMatch(/ADR-0004 {2}Cache reads/);
  term.press("home");
  expect(text()).toMatch(/ADR-0001 {2}Decision ADR-0001/);
});

test("Tab cycles status filters with counts, and typing searches until Esc clears it", () => {
  const { term, text, results } = mount(entries, { query: "" }, 120);
  expect(text()).toMatch(/All 4 +Proposed 1 +Accepted 2 +Superseded 1/);
  expect(text()).toContain("ADR · 1 proposed, 2 accepted, 1 superseded");
  term.press("tab");
  expect(text()).toMatch(/ADR-0002 {2}A very long/);
  expect(text()).not.toMatch(/ADR-0001 Decision/);
  term.press("shift+tab");
  term.type("cache");
  expect(text()).toContain("Search: cache");
  expect(text()).toMatch(/ADR-0004 {2}Cache reads/);
  expect(text()).not.toMatch(/ADR-0001 Decision/);
  expect(text()).toMatch(/Esc clear search/);
  term.press("escape");
  expect(results).toEqual([]);
  expect(text()).toContain("Type to search");
  term.press("escape");
  expect(results).toEqual([{ result: { kind: "close" }, state: { filter: undefined, query: "", selectedId: "ADR-0004" } }]);
});

test("Enter asks to decide, offered shortcuts act, and refused ones explain why", () => {
  const { term, text, results } = mount();
  expect(text()).toMatch(/\[ Decide… ⏎ \] \[ Reject ⇧R \] \[ Deprecate ⇧D \] \[ Note ⇧N \] \[ Supersede ⇧S \]/);
  expect(text()).toMatch(/\[ New decision ⇧O \] \[ Check ⇧C \] \[ Check \+ index ⇧F \] \[ Close ⎋ \]/);
  expect(text()).not.toContain("Accept ⇧A");
  term.press("shift+a");
  expect(results).toEqual([]);
  expect(text()).toMatch(/Accept is not available for ADR-0001 \(accepted\)/);
  term.press("enter");
  term.press("shift+s");
  term.press("shift+o");
  term.press("shift+c");
  expect(results.map(({ result }) => result)).toEqual([
    { kind: "decide", id: "ADR-0001" },
    { kind: "action", action: "supersede", id: "ADR-0001" },
    { kind: "action", action: "new" },
    { kind: "action", action: "check" },
  ]);
  const empty = mount([]);
  empty.term.press("enter");
  expect(empty.results.map(({ result }) => result)).toEqual([{ kind: "action", action: "new" }]);
});

test("a re-opened console restores filter, search and selection and shows the result line", () => {
  const { text } = terminal(
    (host) =>
      new AdrConsole(entries, { filter: "accepted", query: "", selectedId: "ADR-0004" }, host, () => {}, {
        text: "ADR-0004 deprecated.",
        level: "info",
      }),
  );
  expect(text()).toMatch(/ADR-0004 {2}Cache reads/);
  expect(text()).toContain("ADR-0004 deprecated.");
  expect(text()).not.toMatch(/ADR-0002/);
});

test("PgDn and PgUp scroll the detail and mark the lines above", () => {
  const { term, text } = mount();
  const top = bodyRows(text());
  expect(text()).toMatch(/… \d+ more lines: PgDn/);
  term.press("pageDown");
  expect(bodyRows(text())).not.toEqual(top);
  expect(text()).toMatch(/↑ \d+ earlier lines: PgUp/);
  term.press("pageUp");
  expect(bodyRows(text())).toEqual(top);
  for (let page = 0; page < 30; page++) term.press("pageDown");
  expect(text()).toContain("Paragraph line 40 explains");
  expect(text()).not.toMatch(/more lines/);
  term.press("down");
  expect(text()).not.toMatch(/earlier lines/);
});

test("paging reaches every row of a decision many screens long, through one huge paragraph and a long list", () => {
  const words = Array.from({ length: 600 }, (_, index) => `w${index + 1}`);
  const items = Array.from(
    { length: 60 },
    (_, index) => `- item ${index + 1} ${"keeps the list entry long enough to wrap in the pane ".repeat(2)}`,
  );
  const long = entry("ADR-0001", "proposed", ["accept"]);
  long.detail = [
    long.detail.split("\n\n")[0],
    "## Context",
    words.join(" "),
    "## Options",
    ...items,
    "",
    "Final line of the decision.",
  ].join("\n\n");
  const { term, text } = mount([long]);
  const seen = new Set<string>();
  const listed = new Set<number>();
  let previous = "";
  for (let page = 0; page < 200 && text() !== previous; page++) {
    previous = text();
    for (const token of previous.split(/\s+/)) seen.add(token);
    for (const match of previous.matchAll(/item (\d+)/g)) listed.add(Number(match[1]));
    term.press("pageDown");
  }
  expect(text()).toContain("Final line of the decision.");
  expect(text()).not.toMatch(/more lines/);
  expect(words.filter((word) => !seen.has(word))).toEqual([]);
  expect(Array.from({ length: 60 }, (_, index) => index + 1).filter((number) => !listed.has(number))).toEqual([]);
});

test("paging the write preview reaches every row of a long front matter block and the document after it", () => {
  const yaml = Array.from({ length: 80 }, (_, index) => `key${index + 1}: value`).join("\n");
  const files = [{ path: "docs/adr/0001-long.md", content: `---\n${yaml}\n---\n# Long\n\nLast paragraph of the file.\n` }];
  const { term, text } = terminal((host) => new AdrPreview("Write these", files, host, () => {}));
  const keys = new Set<string>();
  let previous = "";
  for (let page = 0; page < 100 && text() !== previous; page++) {
    previous = text();
    for (const match of previous.matchAll(/key(\d+):/g)) keys.add(match[1] ?? "");
    term.press("pageDown");
  }
  expect(text()).toContain("Last paragraph of the file.");
  expect(Array.from({ length: 80 }, (_, index) => String(index + 1)).filter((key) => !keys.has(key))).toEqual([]);
});

test("a long list keeps the selection in view and says where it is", () => {
  const many = Array.from({ length: 50 }, (_, index) => entry(`ADR-${String(index + 1).padStart(4, "0")}`, "proposed", ["accept"]));
  const { term, text } = mount(many);
  expect(text()).toMatch(/1–\d+ of 50/);
  term.press("end");
  expect(text()).toMatch(/❯ ADR-0050 Decision ADR-0050/);
  expect(text()).toMatch(/\d+–50 of 50/);
  expect(text()).not.toMatch(/ADR-0001 Decision/);
});

test("the preview starts on the first file, Enter writes or cancels only on those rows", () => {
  const results: boolean[] = [];
  const files = [
    { path: "docs/adr/README.md", content: "# Decisions\n\nThe index." },
    { path: "docs/adr/template.txt", content: "plain text body" },
  ];
  const { term, text } = terminal((host) => new AdrPreview("Write these", files, host, (write) => results.push(write)));
  expect(text()).toContain("Decisions");
  expect(text()).toMatch(/\[ Write 2 files ⇧W \] \[ Cancel ⎋ \]/);
  term.press("enter");
  expect(results).toEqual([]);
  expect(text()).toContain("Press Shift+W to write every file");
  term.press("down");
  expect(text()).toContain("plain text body");
  term.press("down");
  term.press("enter");
  term.press("home");
  expect(text()).toContain("Files to write:");
  term.press("enter");
  term.press("shift+w");
  expect(results).toEqual([false, true, true]);
});
