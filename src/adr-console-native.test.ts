import { afterEach, beforeEach, expect, test } from "bun:test";

import { setNativeRenderingForTest, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";

import { AdrConsole, AdrPreview, type ConsoleEntry, type ConsoleResult, type ConsoleState } from "../plugins/adr/src/console.ts";
import type { AdrRecord } from "../plugins/adr/src/documents.ts";
import { createMany } from "../plugins/adr/src/operations.ts";
import { cleanupFixtures, decision, repoFixture } from "./adr-fixtures.ts";

// The views pick Tern's layout when they are built while the surface renders natively.
beforeEach(() => setNativeRenderingForTest(true));
afterEach(async () => {
  setNativeRenderingForTest(false);
  await cleanupFixtures();
});

const host = { size: () => ({ columns: 100, rows: 24 }) };

function entry(id: string, status: AdrRecord["status"], offered: ConsoleEntry["offered"], title = `Decision ${id}`): ConsoleEntry {
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
    },
    detail: [
      `${id} — ${title}`,
      `Status: ${status}; date 2026-10-01`,
      `File: docs/adr/${id.slice(4)}.md`,
      "",
      "## Context",
      "",
      `Why ${id}.`,
    ].join("\n"),
    offered,
  };
}

const entries = [
  entry("ADR-0001", "accepted", ["reject", "deprecate", "note", "supersede"]),
  entry("ADR-0002", "proposed", ["accept", "reject", "deprecate", "note"]),
  entry("ADR-0003", "superseded", ["note"], "Cache reads"),
];

function mount(state: ConsoleState = { query: "" }, list = entries) {
  const results: Array<{ result: ConsoleResult; state: ConsoleState }> = [];
  const view = new AdrConsole(list, state, host, (result, next) => results.push({ result, state: next }));
  return { view, results };
}

/** Every node of the current tree, depth first. */
function nodes(root: UiNode): UiNode[] {
  return [root, ...root.children().flatMap(nodes)];
}

const byKey = (root: UiNode, key: string) => nodes(root).find((node) => node.key() === key);
const props = (node: UiNode | undefined) => (node?.props() ?? {}) as Record<string, unknown>;
const items = (root: UiNode, key: string) => byKey(root, key)?.children() ?? [];
const acts = (root: UiNode) =>
  nodes(root)
    .filter((node) => node.kind === "button")
    .map((node) => (props(node).actions as { click?: string } | undefined)?.click);
const texts = (root: UiNode) =>
  nodes(root)
    .filter((node) => node.kind === "md" || node.kind === "code")
    .map((node) => String(props(node).text));
const key = (id: string, text?: string) => ({ id, kind: "press" as const, raw: text ?? "", ...(text ? { text } : {}) });

function press(view: { root: UiNode }, id: string, text?: string): boolean {
  return view.root.handlers.onKey?.(key(id, text)) ?? false;
}

function act(view: { root: UiNode }, act: string): void {
  view.root.handlers.onAction?.(act, { type: "action", key: act, act, mods: [] });
}

function select(view: { root: UiNode }, list: string, item: string, kind: "select" | "activate" = "select"): void {
  const node = byKey(view.root, list);
  if (kind === "select") node?.handlers.onSelect?.(item, { type: "select", key: list, item });
  else node?.handlers.onActivate?.(item, { type: "activate", key: list, item });
}

test("the console is a large modal sheet listing ADRs with status tones and the selected decision", () => {
  const { view } = mount();
  expect(view.root.kind).toBe("overlay");
  expect(props(view.root)).toMatchObject({
    role: "omp.overlay.adr.console",
    size: "lg",
    modal: true,
    head: "ADR · 1 proposed, 1 accepted, 1 superseded",
  });
  const list = items(view.root, "adrs");
  expect(list.map((row) => row.key())).toEqual(["ADR-0001", "ADR-0002", "ADR-0003"]);
  expect(props(byKey(view.root, "adrs")).selected).toBe("ADR-0001");
  expect(list.map((row) => props(row).tone)).toEqual(["success", "warning", "muted"]);
  expect(list.map((row) => props(row).icon)).toEqual(["check", "clock", "forward"]);
  expect(props(byKey(view.root, "filter")).active).toBe("all");
  expect(texts(view.root).join("\n")).toMatch(/Why ADR-0001/);
  // Offered decisions only, plus the global tools and close.
  expect(acts(view.root)).toEqual(expect.arrayContaining(["new", "check", "check-fix", "close", "decide", "reject", "supersede"]));
  expect(acts(view.root)).not.toContain("accept");
});

test("the sheet's line extent is fixed from the terminal height and follows a resize", () => {
  const size = signal({ columns: 100, rows: 24 });
  const resizing = { size: () => size() };
  for (const view of [new AdrConsole(entries, { query: "" }, resizing, () => {}), new AdrPreview("Write these", [], resizing, () => {})]) {
    size.set({ columns: 100, rows: 24 });
    const screen = view.root.children()[0];
    expect(props(screen).min).toEqual({ h: "16lines" });
    expect(props(screen).max).toEqual({ h: "16lines" });
    size.set({ columns: 100, rows: 70 });
    expect(props(screen).min).toEqual({ h: "62lines" });
    expect(props(screen).max).toEqual({ h: "62lines" });
  }
});

test("PgDn forwards a scroll request on the body scroller's content", () => {
  const { view } = mount();
  expect(press(view, "down")).toBe(true);
  expect(props(byKey(view.root, "adrs")).selected).toBe("ADR-0002");
  press(view, "pageDown");
  const scroller = byKey(view.root, "body-scroll");
  expect(scroller?.kind).toBe("list");
  const content = scroller?.children()[0];
  expect(content?.scroll()).toMatchObject({ by: "page-down", n: 1 });
  expect(nodes(view.root).filter((node) => node.scroll())).toHaveLength(1);
  press(view, "pageDown");
  expect(byKey(view.root, "body-scroll")?.children()[0]?.scroll()).toMatchObject({ by: "page-down", n: 2 });
});

test("clicks produce the same results as the keys", () => {
  const keyed = mount();
  press(keyed.view, "down");
  press(keyed.view, "enter");
  press(keyed.view, "shift+a", "A");
  press(keyed.view, "shift+o", "O");
  const clicked = mount();
  select(clicked.view, "adrs", "ADR-0002");
  act(clicked.view, "decide");
  act(clicked.view, "accept");
  act(clicked.view, "new");
  expect(clicked.results).toEqual(keyed.results);
  expect(clicked.results.map(({ result }) => result)).toEqual([
    { kind: "decide", id: "ADR-0002" },
    { kind: "action", action: "accept", id: "ADR-0002" },
    { kind: "action", action: "new" },
  ]);

  const activated = mount();
  select(activated.view, "adrs", "ADR-0003", "activate");
  expect(activated.results.map(({ result }) => result)).toEqual([{ kind: "decide", id: "ADR-0003" }]);
});

test("filter tabs narrow the list, refused decisions explain why, and close follows Esc", () => {
  const { view, results } = mount({ query: "cache" });
  act(view, "accept");
  const message = byKey(view.root, "message");
  expect((props(message).spans as TspSpan[])[0]).toMatchObject({ t: "Accept is not available for ADR-0003 (superseded)", s: "error" });
  expect(results).toEqual([]);

  select(view, "filter", "superseded");
  expect(byKey(view.root, "message")).toBeUndefined();
  expect(props(byKey(view.root, "filter")).active).toBe("superseded");
  expect(items(view.root, "adrs").map((row) => row.key())).toEqual(["ADR-0003"]);

  // The first close clears the search, as Esc does; the second closes with the filter kept.
  act(view, "close");
  expect(results).toEqual([]);
  act(view, "close");
  expect(results).toEqual([{ result: { kind: "close" }, state: { filter: "superseded", query: "", selectedId: "ADR-0003" } }]);
});

test("the preview lists Write, the files and Cancel, shows the selected file, and resolves like the keys", () => {
  const files = [
    { path: "docs/adr/0005-cache.md", content: "---\nstatus: proposed\n---\n# Cache\n\nBody." },
    { path: "docs/adr/index.json", content: '{"a":1}\n' },
  ];
  const results: boolean[] = [];
  const view = new AdrPreview("Write these", files, host, (write) => results.push(write));
  expect(props(view.root)).toMatchObject({ role: "omp.overlay.adr.preview", size: "lg", head: "ADR · write preview" });
  expect(items(view.root, "rows").map((row) => row.key())).toEqual(["r0", "r1", "r2", "r3"]);
  expect(props(byKey(view.root, "rows")).selected).toBe("r1");
  expect(texts(view.root)).toEqual(["status: proposed", "# Cache\n\nBody."]);

  select(view, "rows", "r2");
  expect(texts(view.root)).toEqual(['{"a":1}']);
  press(view, "pageDown");
  expect(byKey(view.root, "body-scroll")?.children()[0]?.scroll()).toMatchObject({ by: "page-down" });

  // Activating a file only explains, as Enter does; Cancel and Write resolve.
  select(view, "rows", "r1", "activate");
  expect(results).toEqual([]);
  expect(byKey(view.root, "message")).toBeDefined();
  select(view, "rows", "r3", "activate");
  act(view, "write");
  act(view, "cancel");
  expect(results).toEqual([false, true, false]);
});

test("the preview shows written files without the managed-by comment or generated-block markers", async () => {
  const root = await repoFixture();
  const { files } = await createMany(root, "main", [decision], { initialize: true, dryRun: true });
  expect(files.some((file) => file.content.includes("<!--"))).toBe(true);
  const view = new AdrPreview("Write these", files, host, () => {});
  for (const item of files.map((_, index) => `r${index + 1}`)) {
    select(view, "rows", item);
    const shown = texts(view.root).join("\n");
    expect(shown).not.toContain("<!--");
    expect(shown).toMatch(/^# /m);
  }
});
