import { afterEach, expect, test } from "bun:test";

import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { UiEvent } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { TspPickerAction, TspPickerItem, TspPickerProps } from "@oh-my-pi/pi-wire";

import {
  type ConsoleEntry,
  type ConsoleOptions,
  type ConsoleResult,
  type ConsoleState,
  SnippetConsole,
} from "../plugins/snippets/src/console.ts";
import type { SnippetScope } from "../plugins/snippets/src/snippet.ts";
import type { SnippetEntry } from "../plugins/snippets/src/store.ts";

const theme = loadThemeSync("dark");
const keys = KeybindingsManager.inMemory();

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

const terminals: TestTerminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

interface Mount {
  state?: ConsoleState;
  list?: readonly ConsoleEntry[];
  options?: ConsoleOptions;
  columns?: number;
  rows?: number;
  native?: boolean;
}

function mount({ state = { query: "" }, list = entries, options, columns = 120, rows = 48, native = false }: Mount = {}) {
  const results: Array<{ result: ConsoleResult; state: ConsoleState }> = [];
  const view = new SnippetConsole(
    list,
    state,
    { keys, theme, rows: () => rows, native },
    (result, next) => results.push({ result, state: next }),
    options,
  );
  const term = createTestTerminal(() => ({ dock: view.node }), { columns, rows, theme });
  terminals.push(term);
  term.focus(view.node);
  const props = () => view.node.props() as TspPickerProps;
  const event = <T extends UiEvent["type"]>(type: T, extra: object) => ({ type, key: "", mods: [], ...extra }) as never;
  return {
    view,
    term,
    results,
    props,
    // Plain rows: no frame edge on the right, and the hints' no-break spaces as spaces.
    screen: () =>
      term
        .screen()
        .map((row) => row.replace(/\s*│$/, "").replaceAll("\u00a0", " "))
        .join("\n"),
    select: (item: string) => view.node.handlers.onSelect?.(item, event("select", { item })),
    activate: (item: string) => view.node.handlers.onActivate?.(item, event("activate", { item })),
    act: (act: string, value?: string) => view.node.handlers.onAction?.(act, event("action", { act, value })),
  };
}

test("the sheet fits 80 and 120 columns, empty or not, with the title counts, tabs, rows and key hints", () => {
  for (const columns of [80, 120]) {
    for (const list of [entries, []]) {
      const { term, screen } = mount({ list, columns });
      for (const row of term.rows()) expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
      const shown = screen();
      expect(shown).toMatch(list.length ? /Snippets · 2 global, 2 workspace/ : /Snippets · none yet/);
      expect(shown).toMatch(list.length ? /All 4 +Global 2 +Workspace 2/ : /All 0 +Global 0 +Workspace 0/);
      expect(shown).toMatch(/↑↓ select/);
      expect(shown).toMatch(/Tab filter/);
      expect(shown).toMatch(/Esc close/);
      if (!list.length) expect(shown).toMatch(/No snippets yet; press Shift\+N to create one/);
    }
  }
  const rows = mount().term.screen();
  expect(rows.find((row) => row.includes("❯"))).toMatch(/❯ \S+ +kyc {2}workspace · Know your customer/);
  expect(rows.some((row) => /kyc {2}global$/.test(row.replace(/ *│$/, "")))).toBe(true);
});

test("Tab cycles All, Global and Workspace, and typing searches key, description and body until Esc clears it", () => {
  const { term, results, screen } = mount();
  term.press("tab");
  expect(screen()).toMatch(/sig {2}global · Email signature/);
  expect(screen()).not.toMatch(/todo/);
  term.press("tab");
  expect(screen()).not.toMatch(/sig {2}/);
  term.press("tab");
  // Back on All; "regards" is only in sig's body.
  term.type("regards");
  expect(screen()).toMatch(/Search regards/);
  expect(screen()).toMatch(/Best regards,/);
  expect(screen()).not.toMatch(/todo/);
  expect(screen()).toMatch(/Esc clear search/);
  term.press("escape");
  expect(results).toEqual([]);
  expect(screen()).toMatch(/type to search/);
  term.press("escape");
  expect(results).toEqual([{ result: { kind: "close" }, state: { filter: undefined, query: "", selectedId: "global:sig" } }]);
});

test("the preview shows the trigger word or menu only, scope, shadowing, state, uses and path", () => {
  const { term, screen } = mount();
  const first = screen();
  expect(first).toMatch(/kyc {2}Know your customer/);
  expect(first).toMatch(/Trigger +\.kyc\./);
  expect(first).toMatch(/Scope +workspace, shadows global/);
  expect(first).toMatch(/State +enabled, pinned/);
  expect(first).toMatch(/Uses +3/);
  expect(first).toMatch(/Path +\/workspace\/kyc\.md/);
  expect(first).toMatch(/⇧P unpin/);
  term.press("down");
  expect(screen()).toMatch(/\.kyc\. \(shadowed; the workspace snippet expands\)/);
  expect(screen()).toMatch(/Scope +global, shadowed by workspace/);
  term.press("end");
  const last = screen();
  expect(last).toMatch(/Trigger +menu only/);
  expect(last).toMatch(/State +disabled/);
  // Hints name the state each toggle switches to.
  expect(last).toMatch(/⇧D enable/);
  expect(last).toMatch(/⇧P pin/);
});

test("Enter and the Shift letters act on the selection; lowercase letters search instead", () => {
  const { term, results } = mount();
  term.press("enter");
  term.type("S");
  term.press("down");
  term.type("EDPXN");
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
  typed.term.type("sig");
  expect(typed.results).toEqual([]);
  typed.term.press("enter");
  expect(typed.results.map(({ result }) => result)).toEqual([{ kind: "action", action: "insert", id: "global:sig" }]);

  const empty = mount({ list: [] });
  empty.term.type("S");
  expect(empty.results).toEqual([]);
  expect(empty.screen()).toMatch(/No snippet selected/);
  empty.term.press("enter");
  expect(empty.results.map(({ result }) => result)).toEqual([{ kind: "new" }]);
});

test("a re-opened console restores filter, search and selection; the next key clears the result line, not the notice", () => {
  const { term, screen } = mount({
    state: { filter: "workspace", query: "", selectedId: ids[3] },
    options: {
      message: { text: "Disabled todo; its shortcut no longer expands.", level: "info" },
      notice: { text: "bad.md: broken", level: "warning" },
    },
  });
  expect(screen()).toMatch(/Trigger +menu only/);
  expect(screen()).toMatch(/Disabled todo/);
  expect(screen()).toMatch(/bad\.md: broken/);
  expect(screen()).not.toMatch(/sig {2}/);
  term.press("up");
  expect(screen()).not.toMatch(/Disabled todo/);
  expect(screen()).toMatch(/bad\.md: broken/);
});

test("the terminal preview pages through a long body with PgDn and PgUp; Tern gets the whole body", () => {
  const body = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
  const list = [{ snippet: snippet("long", "global", { body }), trigger: ".long." }];
  const { term, screen } = mount({ list, rows: 40 });
  expect(screen()).toMatch(/line 1\n/);
  expect(screen()).toMatch(/lines 1–\d+ of 40 · PgUp\/PgDn scroll/);
  expect(screen()).not.toMatch(/line 40/);
  for (let page = 0; page < 10; page++) term.press("pageDown");
  expect(screen()).toMatch(/line 40/);
  expect(screen()).not.toMatch(/line 1\n/);
  term.press("pageUp");
  expect(screen()).toMatch(/lines \d+–\d+ of 40/);
  for (const row of term.rows()) expect(visibleWidth(row)).toBeLessThanOrEqual(120);

  const native = mount({ list, native: true });
  const texts = (node = native.view.node): string[] =>
    node.children().flatMap((child) => {
      const props = child.props();
      const own = "text" in props && typeof props.text === "string" ? [props.text] : [];
      return [...own, ...texts(child)];
    });
  expect(texts()).toContain(body);
});

test("one long paragraph pages by its wrapped rows at the terminal width until its last words show", () => {
  const words = Array.from({ length: 400 }, (_, index) => `word${index + 1}`);
  const list = [{ snippet: snippet("essay", "global", { body: words.join(" ") }), trigger: ".essay." }];
  for (const columns of [80, 120]) {
    const { term, screen } = mount({ list, columns, rows: 40 });
    expect(screen()).toMatch(/word1 word2/);
    expect(screen()).not.toMatch(/word400/);
    const total = Number(/lines 1–\d+ of (\d+)/.exec(screen())?.[1]);
    expect(total).toBeGreaterThan(20);
    for (let page = 0; page < total; page++) term.press("pageDown");
    expect(screen()).toMatch(/word399 word400/);
    expect(screen()).not.toMatch(/word1 word2/);
    expect(screen()).toMatch(new RegExp(`lines \\d+–${total} of ${total}`));
    for (const row of term.rows()) expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
  }
});

test("Tern sees a picker sheet: tabs, rows with state, the search field and its hits, the action bar", () => {
  const { term, props } = mount();
  const p = props();
  expect(p).toMatchObject({ title: "Snippets", noun: "snippets", size: "lg", layout: "rows", preview: "below", query: "", cursor: 0 });
  expect(p.tabs).toEqual([
    { id: "all", label: "All", count: 4 },
    { id: "global", label: "Global", count: 2 },
    { id: "workspace", label: "Workspace", count: 2 },
  ]);
  expect(p).toMatchObject({ tab: "all", selected: ids[0], total: 4, order: ids });
  const items = p.items as TspPickerItem[];
  expect(items.map((row) => [row.label, row.detail, row.icon, row.tone, row.badges?.map((badge) => badge.text)])).toEqual([
    ["kyc", "Know your customer", "pin", undefined, undefined],
    ["kyc", undefined, "globe", undefined, ["shadowed"]],
    ["sig", "Email signature", "globe", undefined, undefined],
    ["todo", undefined, "doc", "muted", ["disabled"]],
  ]);
  const actions = p.actions as TspPickerAction[];
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

  // Typing edits the field: the query, its caret, the rows it keeps and the hits in their keys.
  term.type("sig");
  term.press("left");
  expect(props()).toMatchObject({ query: "sig", cursor: 2, order: [ids[2]], selected: ids[2], hits: { [ids[2]]: [[0, 3]] } });
  expect((props().actions as TspPickerAction[]).at(-1)?.label).toBe("Clear search");
  term.press("escape");
  expect(props()).toMatchObject({ query: "", order: ids });

  const empty = mount({ list: [] }).props();
  expect(empty).toMatchObject({ order: [], selected: null });
  expect((empty.actions as TspPickerAction[]).map(({ id }) => id)).toEqual(["new", "close"]);
  expect((empty.actions as TspPickerAction[])[0]?.primary).toBe(true);
});

test("picker events run the key paths: rows select and activate, tabs filter, buttons act, Close clears then closes", () => {
  const keyed = mount();
  keyed.term.press("down");
  keyed.term.press("down");
  keyed.term.press("enter");
  keyed.term.type("SEDPXN");
  const clicked = mount();
  clicked.select(ids[2]);
  for (const act of ["insert", "send", "edit", "toggle", "pin", "delete", "new"]) clicked.act(act);
  expect(clicked.results).toEqual(keyed.results);
  expect(clicked.results.map(({ result }) => result).slice(0, 2)).toEqual([
    { kind: "action", action: "insert", id: ids[2] },
    { kind: "action", action: "send", id: ids[2] },
  ]);

  const activated = mount();
  activated.activate(ids[3]);
  expect(activated.results.map(({ result }) => result)).toEqual([{ kind: "action", action: "insert", id: ids[3] }]);

  // The picker's own "Clear search" under an empty match list empties the field and keeps the sheet open.
  const cleared = mount({ state: { filter: "global", query: "long" } });
  cleared.act("clear");
  expect(cleared.props()).toMatchObject({ query: "", tab: "global", order: [ids[1], ids[2]] });
  expect(cleared.results).toEqual([]);

  const tabbed = mount({ state: { query: "kyc" } });
  tabbed.act("tab", "workspace");
  expect(tabbed.props()).toMatchObject({ tab: "workspace", order: [ids[0]] });
  tabbed.term.press("tab");
  expect(tabbed.props()).toMatchObject({ tab: "all" });
  tabbed.act("close");
  expect(tabbed.results).toEqual([]);
  expect(tabbed.props().query).toBe("");
  tabbed.act("close");
  expect(tabbed.results).toEqual([{ result: { kind: "close" }, state: { filter: undefined, query: "", selectedId: ids[0] } }]);
});

test("the picker head's subtitle shows the last result beside the store problems", () => {
  const { term, props } = mount({
    options: { message: { text: "Pinned kyc", level: "info" }, notice: { text: "bad.md: broken", level: "warning" } },
  });
  expect(props().subtitle).toEqual([
    { t: "Pinned kyc", s: "success" },
    { t: "  ·  ", s: "dim" },
    { t: "bad.md: broken", s: "warning" },
  ]);
  term.press("down");
  expect(props().subtitle).toEqual([{ t: "bad.md: broken", s: "warning" }]);
});

test("a paste lands in the search field on one line", () => {
  const { term, props } = mount();
  term.paste("Best\nregards");
  expect(props()).toMatchObject({ query: "Best regards", order: [ids[2]] });
});
