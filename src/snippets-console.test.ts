import { beforeAll, expect, test } from "bun:test";

import { type DescribeContext, initTheme, type NativeChild, type NativeNode, type TUI, theme, visibleWidth } from "@oh-my-pi/pi-tui";

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

test("without the picker kind Tern gets a glass sheet: fixed sidebar, state on the icon, the body as plain text", () => {
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
  expect(props(byKey(root, "sidebar"))).toMatchObject({ min: { w: "32ch" }, max: { w: "32ch" }, shrink: 0 });
  expect(acts(root)).toEqual(expect.arrayContaining(["insert", "send", "edit", "toggle", "pin", "delete", "new", "close"]));
  component.handleNativeEvent({ type: "select", key: "split/sidebar/snippets", item: "global:sig" });
  const described = nodes(component.describe());
  expect(described.some((candidate) => candidate.k === "code")).toBe(false);
  expect(props(described.find((candidate) => props(candidate).role === "omp.snippets.body" && candidate.k === "text")).text).toBe(
    "Best regards,\nLi",
  );

  const plain = mount({ query: "" }, [{ snippet: snippet("note", "workspace"), trigger: undefined }]).component.describe();
  expect(props(listItems(plain)[0]).icon).toBe("doc");
});

const pickerCx = { supports: (kind: string) => kind === "picker" } as unknown as DescribeContext;
const pickerProps = (component: SnippetConsole) => props(component.describe(pickerCx));
const pickerActs = (component: SnippetConsole) => (pickerProps(component).actions as Array<{ id: string }>).map(({ id }) => id);
const previewText = (component: SnippetConsole) =>
  nodes(component.describe(pickerCx))
    .filter((candidate) => candidate.k === "text")
    .map((candidate) => {
      const p = props(candidate);
      return typeof p.text === "string" ? p.text : ((p.spans as Array<{ t: string }>) ?? []).map(({ t }) => t).join("");
    });

test("where Tern draws pickers the console is a picker sheet: tabs, rows with state, a search field and the preview below", () => {
  const { component } = mount();
  expect(component.nativeSheet(pickerCx)).toBe(true);
  expect(component.nativeSheet({ supports: () => false } as unknown as DescribeContext)).toBe(false);
  const root = component.describe(pickerCx);
  expect(root.k).toBe("picker");
  expect(component.describe(pickerCx)).toBe(root);
  const p = props(root);
  expect(p).toMatchObject({ title: "Snippets", noun: "snippets", size: "lg", layout: "rows", preview: "below", query: "", cursor: 0 });
  expect(p.tabs).toEqual([
    { id: "all", label: "All", count: 4 },
    { id: "global", label: "Global", count: 2 },
    { id: "workspace", label: "Workspace", count: 2 },
  ]);
  expect(p.tab).toBe("all");
  expect(p.selected).toBe(ids[0]);
  expect(p.total).toBe(4);
  expect(p.order).toEqual(ids);
  const items = p.items as Array<Record<string, unknown>>;
  expect(
    items.map((row) => [
      row.label,
      row.detail,
      row.icon,
      row.tone,
      (row.badges as Array<{ text: string }> | undefined)?.map((b) => b.text),
    ]),
  ).toEqual([
    ["kyc", "Know your customer", "pin", undefined, undefined],
    ["kyc", undefined, "globe", undefined, ["shadowed"]],
    ["sig", "Email signature", "globe", undefined, undefined],
    ["todo", undefined, "doc", "muted", ["disabled"]],
  ]);
  const actions = p.actions as Array<Record<string, unknown>>;
  expect(actions.map((action) => [action.id, action.label])).toEqual([
    ["insert", "Insert"],
    ["send", "Send now"],
    ["edit", "Edit"],
    ["toggle", "Disable"],
    ["pin", "Unpin"],
    ["delete", "Delete"],
    ["new", "New"],
    ["close", "Close"],
  ]);
  expect(actions[0]).toMatchObject({ primary: true, keys: ["enter"] });
  expect(actions[5]).toMatchObject({ danger: true, keys: ["shift", "x"] });
  expect(actions[7]).toMatchObject({ end: true });
  expect(previewText(component)).toEqual([
    "kyc  Know your customer",
    ".kyc. · workspace, shadows global · 3 uses · enabled, pinned",
    "Body of kyc",
    "/workspace/kyc.md",
  ]);

  // Typing edits the field: the query, its caret, the rows it keeps and the hits in their keys.
  for (const key of "sig") component.handleInput(key);
  component.handleInput("\x1b[D");
  const searched = pickerProps(component);
  expect(searched).toMatchObject({ query: "sig", cursor: 2, order: [ids[2]], selected: ids[2], hits: { [ids[2]]: [[0, 3]] } });
  expect(pickerActs(component).at(-1)).toBe("close");
  expect((searched.actions as Array<{ label: string }>).at(-1)?.label).toBe("Clear search");
  expect(previewText(component)).toContain("Best regards,\nLi");
  component.handleInput("\x1b");
  expect(pickerProps(component)).toMatchObject({ query: "", order: ids });

  const empty = mount({ query: "" }, []).component;
  expect(pickerProps(empty)).toMatchObject({ order: [], selected: null });
  expect(pickerActs(empty)).toEqual(["new", "close"]);
  expect((pickerProps(empty).actions as Array<{ primary?: boolean }>)[0]?.primary).toBe(true);
});

test("picker events run the key paths: rows select and activate, tabs filter, buttons act, Close clears then closes", () => {
  const keyed = mount();
  for (const key of ["\x1b[B", "\x1b[B", "\r", "S", "E", "D", "P", "X", "N"]) keyed.component.handleInput(key);
  const clicked = mount();
  clicked.component.handleNativeEvent({ type: "select", key: "", item: ids[2] });
  for (const act of ["insert", "send", "edit", "toggle", "pin", "delete", "new"])
    clicked.component.handleNativeEvent({ type: "action", key: "", act, mods: [] });
  expect(clicked.results).toEqual(keyed.results);
  expect(clicked.results.map(({ result }) => result).slice(0, 2)).toEqual([
    { kind: "action", action: "insert", id: ids[2] },
    { kind: "action", action: "send", id: ids[2] },
  ]);

  const activated = mount();
  activated.component.handleNativeEvent({ type: "activate", key: "", item: ids[3] });
  expect(activated.results.map(({ result }) => result)).toEqual([{ kind: "action", action: "insert", id: ids[3] }]);

  // The picker's own "Clear search" under an empty match list empties the field and keeps the sheet open.
  const cleared = mount({ filter: "global", query: "long" });
  cleared.component.handleNativeEvent({ type: "action", key: "", act: "clear", mods: [] });
  expect(pickerProps(cleared.component)).toMatchObject({ query: "", tab: "global", order: [ids[1], ids[2]] });
  expect(cleared.results).toEqual([]);

  const tabbed = mount({ query: "kyc" });
  tabbed.component.handleNativeEvent({ type: "action", key: "", act: "tab", value: "workspace", mods: [] });
  expect(pickerProps(tabbed.component)).toMatchObject({ tab: "workspace", order: [ids[0]] });
  tabbed.component.handleInput("\t");
  expect(pickerProps(tabbed.component)).toMatchObject({ tab: "all" });
  tabbed.component.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
  expect(tabbed.results).toEqual([]);
  expect(pickerProps(tabbed.component).query).toBe("");
  tabbed.component.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
  expect(tabbed.results).toEqual([{ result: { kind: "close" }, state: { filter: undefined, query: "", selectedId: ids[0] } }]);
});

test("the picker head's subtitle shows the last result beside the store problems", () => {
  const component = new SnippetConsole(entries, { query: "" }, theme, tuiOf(24), () => {}, {
    message: { text: "Pinned kyc", level: "info" },
    notice: { text: "bad.md: broken", level: "warning" },
  });
  expect(pickerProps(component).subtitle).toEqual([
    { t: "Pinned kyc", s: "success" },
    { t: "  ·  ", s: "dim" },
    { t: "bad.md: broken", s: "warning" },
  ]);
  component.handleInput("\x1b[B");
  expect(pickerProps(component).subtitle).toEqual([{ t: "bad.md: broken", s: "warning" }]);
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
