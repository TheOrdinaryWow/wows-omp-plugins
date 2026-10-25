import { beforeAll, expect, test } from "bun:test";

import { initTheme, type NativeChild, type NativeNode, type TUI, theme } from "@oh-my-pi/pi-tui";

import { AdrConsole, AdrPreview, type ConsoleEntry, type ConsoleResult, type ConsoleState } from "../plugins/adr/src/console.ts";
import type { AdrRecord } from "../plugins/adr/src/documents.ts";

beforeAll(async () => {
  await initTheme();
});

const tui = { requestRender() {}, terminal: { rows: 24 } } as unknown as TUI;

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
  const component = new AdrConsole(list, state, theme, tui, (result, next) => results.push({ result, state: next }));
  return { component, results };
}

function isNode(child: NativeChild): child is NativeNode {
  return "k" in child;
}

/** Every described node, depth first. */
function nodes(root: NativeNode): NativeNode[] {
  return [root, ...(root.c ?? []).filter(isNode).flatMap(nodes)];
}

const byKey = (root: NativeNode, key: string) => nodes(root).find((candidate) => candidate.key === key);
const props = (found: NativeNode | undefined) => (found?.p ?? {}) as Record<string, unknown>;
const listItems = (root: NativeNode, key: string) => (byKey(root, key)?.c ?? []).filter(isNode);
const acts = (root: NativeNode) =>
  nodes(root)
    .map((candidate) => (props(candidate).actions as { click?: string } | undefined)?.click)
    .filter((act) => act && act !== "select");
const markdown = (root: NativeNode) =>
  nodes(root)
    .filter((candidate) => candidate.k === "md" || candidate.k === "code")
    .map((candidate) => String(props(candidate).text));

test("the console is a large glass sheet listing ADRs with status tones and the selected decision", () => {
  const { component } = mount();
  expect(component.nativeOverlay).toMatchObject({ role: "omp.overlay.adr.console", size: "lg" });
  expect(component.nativeOverlay).toBe(component.nativeOverlay);
  const root = component.describe();
  expect(listItems(root, "adrs").map((row) => row.key)).toEqual(["ADR-0001", "ADR-0002", "ADR-0003"]);
  expect(props(byKey(root, "adrs")).selected).toBe("ADR-0001");
  const tones = listItems(root, "adrs").map((row) => (props(row).detail as Array<{ s?: string }>).at(-1)?.s);
  expect(tones).toEqual(["success", "warning", "muted"]);
  expect(props(byKey(root, "filter")).active).toBe("all");
  expect(markdown(root).join("\n")).toMatch(/Why ADR-0001/);
  // Offered decisions only, plus the global tools and close.
  expect(acts(root)).toEqual(expect.arrayContaining(["new", "check", "check-fix", "close", "decide", "reject", "supersede"]));
  expect(acts(root)).not.toContain("accept");
});

test("describe keeps the same tree while nothing changes and rebuilds after a change", () => {
  const { component } = mount();
  const first = component.describe();
  expect(component.describe()).toBe(first);
  component.handleInput("\x1b[B");
  const second = component.describe();
  expect(second).not.toBe(first);
  expect(props(byKey(second, "adrs")).selected).toBe("ADR-0002");
  component.handleInput("\x1b[6~");
  const scrolled = component.describe();
  expect(scrolled).not.toBe(second);
  expect(byKey(scrolled, "body")?.scroll).toMatchObject({ by: "page-down" });
});

test("native clicks produce the same results as the keys", () => {
  const keyed = mount();
  keyed.component.handleInput("\x1b[B");
  keyed.component.handleInput("\r");
  keyed.component.handleInput("A");
  keyed.component.handleInput("O");
  const clicked = mount();
  clicked.component.handleNativeEvent({ type: "select", key: "split/sidebar/adrs", item: "ADR-0002" });
  clicked.component.handleNativeEvent({ type: "action", key: "decisions/decide", act: "decide", mods: [] });
  clicked.component.handleNativeEvent({ type: "action", key: "decisions/accept", act: "accept", mods: [] });
  clicked.component.handleNativeEvent({ type: "action", key: "head/tools/new", act: "new", mods: [] });
  expect(clicked.results).toEqual(keyed.results);
  expect(clicked.results.map(({ result }) => result)).toEqual([
    { kind: "decide", id: "ADR-0002" },
    { kind: "action", action: "accept", id: "ADR-0002" },
    { kind: "action", action: "new" },
  ]);

  const activated = mount();
  activated.component.handleNativeEvent({ type: "activate", key: "split/sidebar/adrs", item: "ADR-0003" });
  expect(activated.results.map(({ result }) => result)).toEqual([{ kind: "decide", id: "ADR-0003" }]);
});

test("filter tabs narrow the list, refused decisions explain why, and close follows Esc", () => {
  const { component, results } = mount({ query: "cache" });
  component.handleNativeEvent({ type: "action", key: "decisions/accept", act: "accept", mods: [] });
  const refused = component.describe();
  expect(props(byKey(refused, "message")).tone).toBe("error");
  expect(results).toEqual([]);

  component.handleNativeEvent({ type: "select", key: "head/filter", item: "superseded" });
  const filtered = component.describe();
  expect(byKey(filtered, "message")).toBeUndefined();
  expect(props(byKey(filtered, "filter")).active).toBe("superseded");
  expect(listItems(filtered, "adrs").map((row) => row.key)).toEqual(["ADR-0003"]);

  // The first close clears the search, as Esc does; the second closes with the filter kept.
  component.handleNativeEvent({ type: "action", key: "head/tools/esc-close", act: "close", mods: [] });
  expect(results).toEqual([]);
  component.handleNativeEvent({ type: "action", key: "head/tools/esc-close", act: "close", mods: [] });
  expect(results).toEqual([{ result: { kind: "close" }, state: { filter: "superseded", query: "", selectedId: "ADR-0003" } }]);
});

test("the preview lists Write, the files and Cancel, shows the selected file, and resolves like the keys", () => {
  const files = [
    { path: "docs/adr/0005-cache.md", content: "---\nstatus: proposed\n---\n# Cache\n\nBody." },
    { path: "docs/adr/index.json", content: '{"a":1}\n' },
  ];
  const results: boolean[] = [];
  const preview = new AdrPreview("Write these", files, theme, tui, (write) => results.push(write));
  expect(preview.nativeOverlay).toMatchObject({ role: "omp.overlay.adr.preview", size: "lg" });
  const root = preview.describe();
  expect(preview.describe()).toBe(root);
  expect(listItems(root, "rows")).toHaveLength(4);
  expect(props(byKey(root, "rows")).selected).toBe("r1");
  expect(markdown(root)).toEqual(["status: proposed", "# Cache\n\nBody."]);

  preview.handleNativeEvent({ type: "select", key: "split/sidebar/rows", item: "r2" });
  const second = preview.describe();
  expect(second).not.toBe(root);
  expect(markdown(second)).toEqual(['{"a":1}']);

  // Activating a file only explains, as Enter does; Cancel and Write resolve.
  preview.handleNativeEvent({ type: "activate", key: "split/sidebar/rows", item: "r1" });
  expect(results).toEqual([]);
  expect(byKey(preview.describe(), "message")).toBeDefined();
  preview.handleNativeEvent({ type: "activate", key: "split/sidebar/rows", item: "r3" });
  preview.handleNativeEvent({ type: "action", key: "actions/write", act: "write", mods: [] });
  preview.handleNativeEvent({ type: "action", key: "actions/cancel", act: "cancel", mods: [] });
  expect(results).toEqual([false, true, false]);
});
