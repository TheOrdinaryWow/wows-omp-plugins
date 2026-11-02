import { beforeAll, expect, test } from "bun:test";

import { initTheme, type NativeChild, type NativeNode, type TUI, theme, visibleWidth } from "@oh-my-pi/pi-tui";

import { type ConsoleEntry, type ConsoleResult, type ConsoleState, SnippetConsole } from "../plugins/snippets/src/console.ts";
import type { SnippetScope } from "../plugins/snippets/src/snippet.ts";
import type { SnippetEntry } from "../plugins/snippets/src/store.ts";

beforeAll(async () => {
  await initTheme();
});

function snippet(key: string, scope: SnippetScope, extra: Partial<SnippetEntry> = {}): SnippetEntry {
  return {
    key,
    scope,
    id: scope === "global" ? `global:${key}` : `workspace:/w:${key}`,
    path: `/${scope}/${key}.md`,
    description: "",
    body: `Body of ${key}`,
    enabled: true,
    pinned: false,
    uses: 0,
    shadowed: false,
    ...extra,
  };
}

// Store order: pinned, then uses, then key.
const entries: ConsoleEntry[] = [
  { snippet: snippet("kyc", "workspace", { pinned: true, uses: 3, description: "Know your customer" }), trigger: ".kyc." },
  { snippet: snippet("kyc", "global", { shadowed: true }), trigger: ".kyc." },
  { snippet: snippet("sig", "global", { description: "Email signature", body: "Best regards,\nLi" }), trigger: ".sig." },
  { snippet: snippet("todo", "workspace", { enabled: false }), trigger: undefined },
];
const ids = entries.map((entry) => entry.snippet.id) as [string, string, string, string];
function tuiOf(rows: number): TUI {
  return { requestRender() {}, terminal: { rows } } as unknown as TUI;
}

function mount(state: ConsoleState = { query: "" }, list = entries, rows = 24) {
  const results: Array<{ result: ConsoleResult; state: ConsoleState }> = [];
  const component = new SnippetConsole(list, state, theme, tuiOf(rows), (result, next) => results.push({ result, state: next }));
  return { component, results };
}

const screen = (component: SnippetConsole, width = 120): string => Bun.stripANSI(component.render(width).join("\n"));
const sidebar = (component: SnippetConsole, width = 120): string[] =>
  component
    .render(width)
    .slice(3)
    .map((line) => Bun.stripANSI(line).split("│")[1]?.trim() ?? "")
    .filter(Boolean);

test("frames fill the terminal and never exceed the width, including empty and narrow consoles", () => {
  for (const [width, rows] of [
    [80, 24],
    [160, 48],
    [40, 12],
  ] as const) {
    for (const list of [entries, []]) {
      const lines = mount({ query: "" }, list, rows).component.render(width);
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
  expect(screen(mount({ query: "" }, []).component)).toMatch(/No snippets yet; press Shift\+N/);
});

test("Tab cycles All, Global and Workspace, and typing searches key, description and body until Esc clears it", () => {
  const { component, results } = mount();
  expect(screen(component)).toMatch(/Snippets · 2 global, 2 workspace/);
  expect(screen(component)).toMatch(/All 4.*Global 2.*Workspace 2/);
  component.handleInput("\t");
  const global = sidebar(component).join("\n");
  expect(global).toMatch(/kyc {2}global/);
  expect(global).toMatch(/sig {2}global · Email signature/);
  expect(global).not.toMatch(/todo/);
  component.handleInput("\t");
  expect(sidebar(component).join("\n")).not.toMatch(/sig/);
  component.handleInput("\t");
  // Back on All; "regards" is only in sig's body.
  for (const key of "regards") component.handleInput(key);
  const searched = screen(component);
  expect(searched).toMatch(/Search: regards/);
  expect(searched).toMatch(/Best regards,/);
  expect(searched).not.toMatch(/todo/);
  component.handleInput("\x1b");
  expect(results).toEqual([]);
  expect(screen(component)).toMatch(/Type to search/);
  component.handleInput("\x1b");
  expect(results).toEqual([{ result: { kind: "close" }, state: { filter: undefined, query: "", selectedId: "global:sig" } }]);
});

test("the preview shows the trigger word or menu only, scope, shadowing, state, uses and path", () => {
  const { component } = mount();
  const first = screen(component);
  expect(first).toMatch(/kyc {2}Know your customer/);
  expect(first).toMatch(/Trigger +\.kyc\./);
  expect(first).toMatch(/Scope +workspace, shadows global/);
  expect(first).toMatch(/State +enabled, pinned/);
  expect(first).toMatch(/Uses +3/);
  expect(first).toMatch(/Path +\/workspace\/kyc\.md/);
  component.handleInput("\x1b[B");
  expect(screen(component)).toMatch(/\.kyc\. \(shadowed; the workspace snippet expands\)/);
  expect(screen(component)).toMatch(/Scope +global, shadowed by workspace/);
  component.handleInput("\x1b[F");
  const last = screen(component);
  expect(last).toMatch(/Trigger +menu only/);
  expect(last).toMatch(/State +disabled/);
  // Hints name the state each toggle switches to.
  expect(last).toMatch(/enable/);
  expect(last).toMatch(/pin/);
});

test("Enter and the Shift letters act on the selection; lowercase letters search instead", () => {
  const { component, results } = mount();
  component.handleInput("\r");
  component.handleInput("S");
  component.handleInput("\x1b[B");
  component.handleInput("E");
  component.handleInput("D");
  component.handleInput("P");
  component.handleInput("X");
  component.handleInput("N");
  expect(results.map(({ result }) => result)).toEqual([
    { kind: "action", action: "insert", id: ids[0] },
    { kind: "action", action: "send", id: ids[0] },
    { kind: "action", action: "edit", id: ids[1] },
    { kind: "action", action: "toggle", id: ids[1] },
    { kind: "action", action: "pin", id: ids[1] },
    { kind: "action", action: "delete", id: ids[1] },
    { kind: "new" },
  ]);
  const typed = mount();
  for (const key of "sig") typed.component.handleInput(key);
  expect(typed.results).toEqual([]);
  typed.component.handleInput("\r");
  expect(typed.results.map(({ result }) => result)).toEqual([{ kind: "action", action: "insert", id: "global:sig" }]);

  const empty = mount({ query: "" }, []);
  empty.component.handleInput("S");
  expect(empty.results).toEqual([]);
  expect(screen(empty.component)).toMatch(/No snippet selected/);
  empty.component.handleInput("\r");
  expect(empty.results.map(({ result }) => result)).toEqual([{ kind: "new" }]);
});

test("a re-opened console restores filter, search and selection; the result line gives way to the problem notice", () => {
  const component = new SnippetConsole(entries, { filter: "workspace", query: "", selectedId: ids[3] }, theme, tuiOf(24), () => {}, {
    message: { text: "Disabled todo; its shortcut no longer expands.", level: "info" },
    notice: { text: "bad.md: broken", level: "warning" },
  });
  const first = screen(component);
  expect(first).toMatch(/Trigger +menu only/);
  expect(first).toMatch(/Disabled todo/);
  expect(first).not.toMatch(/bad\.md/);
  expect(sidebar(component).join("\n")).not.toMatch(/sig/);
  component.handleInput("\x1b[A");
  expect(screen(component)).toMatch(/bad\.md: broken/);
});

function isNode(child: NativeChild): child is NativeNode {
  return "k" in child;
}

function nodes(root: NativeNode): NativeNode[] {
  return [root, ...(root.c ?? []).filter(isNode).flatMap(nodes)];
}

const byKey = (root: NativeNode, key: string) => nodes(root).find((candidate) => candidate.key === key);
const props = (found: NativeNode | undefined) => (found?.p ?? {}) as Record<string, unknown>;
const listItems = (root: NativeNode) => (byKey(root, "snippets")?.c ?? []).filter(isNode);
const acts = (root: NativeNode) =>
  nodes(root)
    .map((candidate) => (props(candidate).actions as { click?: string } | undefined)?.click)
    .filter((act) => act && act !== "select");

test("Tern describes the same entries in a large glass sheet with state on the icon and the body verbatim", () => {
  const { component } = mount();
  expect(component.nativeOverlay).toMatchObject({ role: "omp.overlay.snippets.console", size: "lg" });
  expect(component.nativeOverlay).toBe(component.nativeOverlay);
  const root = component.describe();
  expect(component.describe()).toBe(root);
  expect(listItems(root).map((row) => row.key)).toEqual(ids);
  const rows = listItems(root).map((row) => props(row));
  expect(rows.map((row) => [row.label, row.icon, row.tone])).toEqual([
    ["kyc", "pin", "accent"],
    ["kyc", "eye-off", "muted"],
    ["sig", "globe", undefined],
    ["todo", "minus", "muted"],
  ]);
  expect(rows[2]?.detail).toBe("global · Email signature");
  expect(props(byKey(root, "snippets")).selected).toBe(ids[0]);
  expect(props(byKey(root, "filter")).active).toBe("all");
  expect(acts(root)).toEqual(expect.arrayContaining(["insert", "send", "edit", "toggle", "pin", "delete", "new", "close"]));
  component.handleNativeEvent({ type: "select", key: "split/sidebar/snippets", item: "global:sig" });
  const code = nodes(component.describe()).find((candidate) => candidate.k === "code");
  expect(props(code).text).toBe("Best regards,\nLi");
});

test("native clicks produce the same results as the keys", () => {
  const keyed = mount();
  keyed.component.handleInput("\x1b[B");
  keyed.component.handleInput("\x1b[B");
  keyed.component.handleInput("\r");
  keyed.component.handleInput("P");
  keyed.component.handleInput("X");
  keyed.component.handleInput("N");
  const clicked = mount();
  clicked.component.handleNativeEvent({ type: "select", key: "split/sidebar/snippets", item: "global:sig" });
  clicked.component.handleNativeEvent({ type: "action", key: "actions/insert", act: "insert", mods: [] });
  clicked.component.handleNativeEvent({ type: "action", key: "actions/pin", act: "pin", mods: [] });
  clicked.component.handleNativeEvent({ type: "action", key: "actions/delete", act: "delete", mods: [] });
  clicked.component.handleNativeEvent({ type: "action", key: "head/tools/new", act: "new", mods: [] });
  expect(clicked.results).toEqual(keyed.results);
  expect(clicked.results.map(({ result }) => result)).toEqual([
    { kind: "action", action: "insert", id: "global:sig" },
    { kind: "action", action: "pin", id: "global:sig" },
    { kind: "action", action: "delete", id: "global:sig" },
    { kind: "new" },
  ]);

  const activated = mount();
  activated.component.handleNativeEvent({ type: "activate", key: "split/sidebar/snippets", item: ids[3] });
  expect(activated.results.map(({ result }) => result)).toEqual([{ kind: "action", action: "insert", id: ids[3] }]);
});

test("native filter tabs narrow the list, close follows Esc, and the notice stays beside the result line", () => {
  const results: ConsoleResult[] = [];
  const tracked = new SnippetConsole(entries, { query: "kyc" }, theme, tuiOf(24), (result) => results.push(result), {
    notice: { text: "Invalid trigger", level: "warning" },
  });
  expect(props(byKey(tracked.describe(), "notice")).tone).toBe("warning");
  tracked.handleNativeEvent({ type: "select", key: "head/filter", item: "workspace" });
  const filtered = tracked.describe();
  expect(props(byKey(filtered, "filter")).active).toBe("workspace");
  expect(listItems(filtered).map((row) => row.key)).toEqual([ids[0]]);
  tracked.handleNativeEvent({ type: "action", key: "head/tools/esc-close", act: "close", mods: [] });
  expect(results).toEqual([]);
  expect(listItems(tracked.describe()).map((row) => row.key)).toEqual([ids[0], ids[3]]);
  tracked.handleNativeEvent({ type: "action", key: "head/tools/esc-close", act: "close", mods: [] });
  expect(results).toEqual([{ kind: "close" }]);
});
