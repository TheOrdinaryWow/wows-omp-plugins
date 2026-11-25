import { batch, type KeyEvent, type PasteEvent, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspPickerAction, TspPickerItem, TspSpan } from "@oh-my-pi/pi-wire";

import { editField, type Field, type FieldKeys, field, insertText, KillRing } from "#src/field.ts";
import type { SnippetScope } from "#src/snippet.ts";
import type { SnippetEntry } from "#src/store.ts";
import { h, kv, span } from "#src/tsp.ts";

/** One line under the console body: an action result or the store and settings problems. */
export interface ConsoleMessage {
  text: string;
  level: "info" | "warning" | "error";
}

/**
 * Per-snippet keys, in the order the hints list them. `key` is the uppercase letter; Shift+letter sends it too,
 * so lowercase typing still searches. Enter inserts.
 */
export const ENTRY_KEYS = [
  ["S", "send"],
  ["E", "edit"],
  ["D", "toggle"],
  ["P", "pin"],
  ["X", "delete"],
] as const;
export type EntryAction = "insert" | (typeof ENTRY_KEYS)[number][1];
/** Creates a snippet; works with nothing selected. */
export const NEW_KEY = "N";

export type ConsoleResult = { kind: "close" } | { kind: "new" } | { kind: "action"; action: EntryAction; id: string };

export interface ConsoleEntry {
  snippet: SnippetEntry;
  /** The shortcut that expands it at send, or undefined when shortcuts are off ("menu only"). */
  trigger: string | undefined;
}

/** Filter, search and selection survive a console re-open after a mutation. */
export interface ConsoleState {
  filter?: SnippetScope;
  query: string;
  selectedId?: string;
}

export interface ConsoleOptions {
  /** Result of the last action; cleared by the next key. */
  message?: ConsoleMessage;
  /** Store and settings problems; shown until they are fixed. */
  notice?: ConsoleMessage;
}

/** What the console needs from its host. */
export interface ConsoleEnv {
  /** The keymap the factory receives: search field edits follow the user's `tui.editor.*` bindings. */
  keys: FieldKeys;
  /** Glyphs for the terminal's row marks, and the style of the body's position line. */
  theme: Pick<Theme, "symbols" | "style">;
  /** Terminal rows (reactive): the terminal preview shows as much of the body as fits. */
  rows: () => number;
  /** Tern draws the sheet and scrolls the preview itself, so the body is sent whole. */
  native: boolean;
}

const PLUGIN = "Snippets";
const FILTERS: ReadonlyArray<SnippetScope | undefined> = [undefined, "global", "workspace"];
/** Snippet rows the terminal list shows before it scrolls. */
const LIST_ROWS = 8;
/** Terminal rows besides the list, the body and the notes: the sheet's frame, head, preview facts and hints, and the status line. */
const CHROME_ROWS = 24;
const MIN_BODY_ROWS = 2;

const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;

/** The label an action carries for this snippet: toggle and pin name the state they switch to. */
export function actionLabel(action: EntryAction, snippet: Pick<SnippetEntry, "enabled" | "pinned">): string {
  if (action === "toggle") return snippet.enabled ? "disable" : "enable";
  if (action === "pin") return snippet.pinned ? "unpin" : "pin";
  if (action === "send") return "send now";
  return action;
}

/** Facts the preview shows under the title; the dialog menu puts them in its title. */
export function snippetFields(entry: ConsoleEntry, all: readonly ConsoleEntry[]): Array<readonly [string, string]> {
  const { snippet, trigger } = entry;
  let shortcut = trigger ?? "menu only";
  if (trigger && snippet.shadowed) shortcut += " (shadowed; the workspace snippet expands)";
  else if (trigger && !snippet.enabled) shortcut += " (disabled; does not expand)";
  const shadows = snippet.scope === "workspace" && all.some(({ snippet: other }) => other.scope === "global" && other.key === snippet.key);
  const scope = snippet.shadowed ? "global, shadowed by workspace" : shadows ? "workspace, shadows global" : snippet.scope;
  const state = [snippet.enabled ? "enabled" : "disabled", snippet.pinned ? "pinned" : ""].filter(Boolean).join(", ");
  return [
    ["Trigger", shortcut],
    ["Scope", scope],
    ["State", state],
    ["Uses", String(snippet.uses)],
    ["Path", snippet.path],
  ];
}

/** Search words, lowercase: the list keeps snippets containing every one, and the rows mark them in the keys. */
function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Where the search words occur in `label`, as sorted, merged UTF-16 ranges. */
export function wordHits(label: string, words: readonly string[]): [number, number][] {
  const lower = label.toLowerCase();
  const ranges: [number, number][] = [];
  for (const word of words)
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) ranges.push([at, at + word.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/** Pinned snippets show the pin, the rest their scope: a globe for global, a document for workspace. */
function snippetIcon(snippet: SnippetEntry): string {
  if (snippet.pinned) return "pin";
  return snippet.scope === "global" ? "globe" : "doc";
}

/** A Tern picker row: the key, the description beside it, state as tone and badges, the facts in the tooltip. */
function pickerItem(snippet: SnippetEntry): TspPickerItem {
  const badges = [
    ...(snippet.enabled ? [] : [{ text: "disabled", tone: "muted" as const }]),
    ...(snippet.shadowed
      ? [{ text: "shadowed", tone: "muted" as const, title: "The workspace snippet with this key expands instead" }]
      : []),
  ];
  return {
    id: snippet.id,
    label: snippet.key,
    ...(snippet.description ? { detail: snippet.description } : {}),
    icon: snippetIcon(snippet),
    ...(snippet.enabled ? {} : { tone: "muted" as const }),
    ...(badges.length ? { badges } : {}),
    title: `${snippet.scope} · ${snippet.uses} ${snippet.uses === 1 ? "use" : "uses"}`,
  };
}

/** Terminal row marks (pin, then disabled or shadowed), each slot padded to one width so the keys line up. */
interface MarkSlots {
  pin: string;
  disabled: string;
  shadowed: string;
  blank: string;
}

function markSlots(theme: Pick<Theme, "symbols">): MarkSlots {
  const glyphs = {
    pin: theme.symbols.symbol("icon.pin"),
    disabled: theme.symbols.symbol("status.disabled"),
    shadowed: theme.symbols.symbol("status.shadowed"),
  };
  const width = Math.max(1, ...Object.values(glyphs).map((glyph) => visibleWidth(glyph)));
  const pad = (glyph: string) => glyph + " ".repeat(width - visibleWidth(glyph));
  return { pin: pad(glyphs.pin), disabled: pad(glyphs.disabled), shadowed: pad(glyphs.shadowed), blank: " ".repeat(width) };
}

function messageColor(level: ConsoleMessage["level"]): "success" | "warning" | "error" {
  return level === "info" ? "success" : level;
}

const action = (id: string, label: string, keys: readonly string[], extra: Partial<TspPickerAction> = {}): TspPickerAction => ({
  id,
  label,
  keys,
  ...extra,
});

/**
 * `/snippets` console: a picker of every snippet with scope tabs, a search field, the selected snippet's preview
 * below and an action bar. The terminal paints it as a framed sheet with key hints; Tern draws its picker sheet.
 */
export class SnippetConsole {
  readonly node: UiNode;
  readonly #filter = signal<SnippetScope | undefined>(undefined);
  readonly #search = signal<Field>(field(""));
  readonly #selectedId = signal<string | undefined>(undefined);
  readonly #message = signal<ConsoleMessage | undefined>(undefined);
  /** First body line the terminal preview shows. */
  readonly #bodyTop = signal(0);
  /** Width the terminal body was last painted at; paging wraps the body the same way. */
  #bodyWidth = 0;
  /** What word and line deletions cut from the search field, for the yank bindings to paste back. */
  readonly #ring = new KillRing();
  readonly #notice: ConsoleMessage | undefined;
  readonly #items: TspPickerItem[];
  readonly #marks: MarkSlots;

  constructor(
    readonly entries: readonly ConsoleEntry[],
    state: ConsoleState,
    readonly env: ConsoleEnv,
    readonly done: (result: ConsoleResult, state: ConsoleState) => void,
    options: ConsoleOptions = {},
  ) {
    this.#filter.set(state.filter);
    this.#search.set(field(state.query));
    this.#selectedId.set(state.selectedId);
    this.#message.set(options.message);
    this.#notice = options.notice;
    this.#items = entries.map(({ snippet }) => pickerItem(snippet));
    this.#marks = markSlots(env.theme);
    this.node = this.#view();
  }

  #count(scope: SnippetScope | undefined): number {
    return scope ? this.entries.filter((entry) => entry.snippet.scope === scope).length : this.entries.length;
  }

  #visible(): ConsoleEntry[] {
    const filter = this.#filter();
    const words = searchWords(this.#search().text);
    return this.entries.filter(({ snippet }) => {
      if (filter && snippet.scope !== filter) return false;
      const haystack = `${snippet.key} ${snippet.description} ${snippet.body}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  /** The selected entry among the visible ones; when it is filtered out the first visible one stands in. */
  #current(visible = this.#visible()): { entry?: ConsoleEntry; index: number } {
    const selected = this.#selectedId();
    const index = visible.findIndex((entry) => entry.snippet.id === selected);
    return index >= 0 ? { entry: visible[index], index } : { entry: visible[0], index: 0 };
  }

  #state(): ConsoleState {
    return { filter: this.#filter(), query: this.#search().text, selectedId: this.#current().entry?.snippet.id ?? this.#selectedId() };
  }

  #finish(result: ConsoleResult): void {
    this.done(result, this.#state());
  }

  #select(index: number): void {
    const visible = this.#visible();
    const next = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (!next || next.snippet.id === this.#current(visible).entry?.snippet.id) return;
    batch(() => {
      this.#selectedId.set(next.snippet.id);
      this.#bodyTop.set(0);
    });
  }

  /** A filter or search that hides the selection moves it to the first match, which then stays selected when it clears. */
  #keepSelection(): void {
    const entry = this.#current().entry;
    if (entry) this.#selectedId.set(entry.snippet.id);
  }

  #filterTo(scope: SnippetScope | undefined): void {
    batch(() => {
      this.#filter.set(scope);
      this.#bodyTop.set(0);
      this.#keepSelection();
    });
  }

  #cycle(delta: 1 | -1): void {
    const index = FILTERS.indexOf(this.#filter());
    this.#filterTo(FILTERS[(index + delta + FILTERS.length) % FILTERS.length]);
  }

  #setSearch(next: Field): void {
    batch(() => {
      if (next.text !== this.#search().text) this.#bodyTop.set(0);
      this.#search.set(next);
      this.#keepSelection();
    });
  }

  #act(action: EntryAction): void {
    const entry = this.#current().entry;
    if (!entry) {
      this.#message.set({ text: "No snippet selected", level: "error" });
      return;
    }
    this.#finish({ kind: "action", action, id: entry.snippet.id });
  }

  #escape(): void {
    if (this.#search().text) this.#setSearch(field(""));
    else this.#finish({ kind: "close" });
  }

  #enter(): void {
    if (this.#current().entry) this.#act("insert");
    else if (!this.entries.length) this.#finish({ kind: "new" });
  }

  /** Body rows the terminal preview has room for. */
  #bodyRows(): number {
    const listed = Math.max(1, Math.min(LIST_ROWS, this.#visible().length));
    const notes = [this.#message(), this.#notice].filter(Boolean).length;
    return Math.max(MIN_BODY_ROWS, this.env.rows() - CHROME_ROWS - listed - notes);
  }

  #scrollBody(direction: 1 | -1): void {
    const body = this.#current().entry?.snippet.body ?? "";
    if (!this.#bodyWidth) return;
    const rows = this.#bodyRows();
    const last = Math.max(0, wrap(body, this.#bodyWidth).length - rows);
    this.#bodyTop.set(Math.max(0, Math.min(last, this.#bodyTop() + direction * Math.max(1, rows - 1))));
  }

  /** Keys first reach the console: it moves the selection, runs the actions and edits the search field. */
  key(key: KeyEvent): boolean {
    if (key.kind === "release") return false;
    this.#message.set(undefined);
    const typed = key.text;
    const letter = typed && /^[A-Z]$/.test(typed) ? typed : /^shift\+([a-z])$/.exec(key.id)?.[1]?.toUpperCase();
    const entryAction = ENTRY_KEYS.find(([candidate]) => candidate === letter)?.[1];
    if (key.id === "escape") this.#escape();
    else if (key.id === "shift+tab") this.#cycle(-1);
    else if (key.id === "tab") this.#cycle(1);
    else if (key.id === "up") this.#select(this.#current().index - 1);
    else if (key.id === "down") this.#select(this.#current().index + 1);
    else if (key.id === "home") this.#select(0);
    else if (key.id === "end") this.#select(Number.MAX_SAFE_INTEGER);
    else if (key.id === "pageDown" || key.id === "pageUp") this.#scrollBody(key.id === "pageDown" ? 1 : -1);
    else if (key.id === "enter") this.#enter();
    else if (letter === NEW_KEY) this.#finish({ kind: "new" });
    else if (entryAction) this.#act(entryAction);
    else {
      // Leading whitespace never starts a search; uppercase letters without an action still search, so `API` finds `api`.
      const search = this.#search();
      if (!search.text && typed !== undefined && !typed.trim()) return true;
      const next = letter ? insertText(search, letter) : editField(search, key, this.env.keys, false, this.#ring);
      if (!next) return false;
      this.#setSearch(next);
    }
    return true;
  }

  paste(paste: PasteEvent): boolean {
    this.#message.set(undefined);
    this.#setSearch(insertText(this.#search(), paste.text));
    return true;
  }

  /** A row click selects like the arrows; a second click (activate) then inserts like Enter. */
  pick(id: string, activate: boolean): void {
    const index = this.#visible().findIndex((candidate) => candidate.snippet.id === id);
    if (index < 0) return;
    this.#message.set(undefined);
    this.#select(index);
    if (activate) this.#enter();
  }

  /**
   * A button's key path: Close is Esc, Insert is Enter, New and the per-snippet actions their Shift letters, a tab
   * filters; the picker's own Clear search (under "No snippets match") empties the field like the first Esc.
   */
  run(act: string, value?: string): void {
    const entryAction = ENTRY_KEYS.find(([, candidate]) => candidate === act)?.[1];
    this.#message.set(undefined);
    if (act === "tab") {
      const scope = FILTERS.find((candidate) => (candidate ?? "all") === value);
      if (scope !== undefined || value === "all") this.#filterTo(scope);
    } else if (act === "close") this.#escape();
    else if (act === "clear") this.#setSearch(field(""));
    else if (act === "insert") this.#enter();
    else if (act === "new") this.#finish({ kind: "new" });
    else if (entryAction) this.#act(entryAction);
  }

  /** Insert and the per-snippet actions while one is selected, then New and Close (Clear search). */
  #actions(): TspPickerAction[] {
    const entry = this.#current().entry;
    const actions = entry
      ? [
          action("insert", "Insert", ["enter"], { primary: true }),
          ...ENTRY_KEYS.map(([key, id]) =>
            action(id, capitalize(actionLabel(id, entry.snippet)), ["shift", key.toLowerCase()], id === "delete" ? { danger: true } : {}),
          ),
        ]
      : [];
    actions.push(action("new", "New", ["shift", NEW_KEY.toLowerCase()], entry ? {} : { primary: true }));
    actions.push(action("close", this.#search().text ? "Clear search" : "Close", ["escape"], { end: true }));
    return actions;
  }

  #hits(): Record<string, [number, number][]> {
    const words = searchWords(this.#search().text);
    const hits: Record<string, [number, number][]> = {};
    for (const { snippet } of words.length ? this.#visible() : []) {
      const found = wordHits(snippet.key, words);
      if (found.length) hits[snippet.id] = found;
    }
    return hits;
  }

  #messages(): ConsoleMessage[] {
    return [this.#message(), this.#notice].filter((line): line is ConsoleMessage => line !== undefined);
  }

  #empty(): string {
    return this.entries.length
      ? "No snippets match; Esc clears the search, Tab changes the filter"
      : "No snippets yet; press Shift+N to create one";
  }

  /** The terminal row of a snippet: its marks, the key with the search hits marked, then scope and description. */
  #row(snippet: SnippetEntry, hits: readonly [number, number][] | undefined): TspSpan[] {
    const marks = this.#marks;
    const muted = snippet.shadowed || !snippet.enabled;
    const style = muted ? "muted" : undefined;
    const spans: TspSpan[] = [
      span(snippet.pinned ? marks.pin : marks.blank, "accent"),
      span(snippet.shadowed ? marks.shadowed : snippet.enabled ? marks.blank : marks.disabled, "muted"),
      span(" "),
    ];
    let at = 0;
    for (const [from, to] of hits ?? []) {
      if (from > at) spans.push(span(snippet.key.slice(at, from), style));
      spans.push(span(snippet.key.slice(from, to), muted ? "muted mark" : "mark"));
      at = to;
    }
    if (at < snippet.key.length) spans.push(span(snippet.key.slice(at), style));
    spans.push(span(`  ${snippet.description ? `${snippet.scope} · ${snippet.description}` : snippet.scope}`, "dim"));
    return spans;
  }

  /** The terminal head: the scope tabs with their counts, then the search field with its caret. */
  #head(): TspSpan[][] {
    const filter = this.#filter();
    const tabs: TspSpan[] = [];
    for (const scope of FILTERS) {
      const label = ` ${scope ? capitalize(scope) : "All"} ${this.#count(scope)} `;
      tabs.push(span(label, scope === filter ? "selectedBg accent strong" : "muted"), span(" "));
    }
    const { text, cursor } = this.#search();
    const search: TspSpan[] = [span("Search ", "muted")];
    if (!text) search.push(span(" ", "inverse"), span("type to search keys, descriptions and bodies", "dim"));
    else {
      const caret = text.slice(cursor, cursor + 1);
      search.push(span(text.slice(0, cursor), "strong"), span(caret || " ", "inverse strong"), span(text.slice(cursor + 1), "strong"));
    }
    return [tabs, search];
  }

  /** The terminal hint rows: the picker's actions and the keys the console adds. */
  #hint(): TspSpan[] {
    const parts: Array<[string, string]> = [["↑↓", "select"]];
    for (const { keys, label } of this.#actions()) {
      const caps = keys
        ?.map((key) => (key === "enter" ? "⏎" : key === "escape" ? "Esc" : key === "shift" ? "⇧" : key.toUpperCase()))
        .join("");
      if (caps) parts.push([caps, label.toLowerCase()]);
    }
    parts.splice(parts.length - 1, 0, ["Tab", "filter"], ["PgUp/PgDn", "scroll body"]);
    // No-break spaces keep each key beside its label, and each separator after the item before it, when the hint wraps.
    return parts.flatMap(([keys, label], index) => [
      ...(index ? [span("\u00a0\u00a0·  ", "dim")] : []),
      span(keys, "key"),
      span(`\u00a0${label.replaceAll(" ", "\u00a0")}`, "muted"),
    ]);
  }

  #term(): Record<string, unknown> {
    const counts = [`${this.#count("global")} global`, `${this.#count("workspace")} workspace`];
    const hits = this.#hits();
    const rows: Record<string, TspSpan[]> = {};
    for (const { snippet } of this.#visible()) rows[snippet.id] = this.#row(snippet, hits[snippet.id]);
    return {
      title: `${PLUGIN} · ${this.entries.length ? counts.join(", ") : "none yet"}`,
      head: this.#head(),
      search: false,
      rows,
      maxRows: LIST_ROWS,
      wrap: false,
      empty: this.#empty(),
      hint: this.#hint(),
      hintWrap: true,
      notes: this.#messages().map((line) => [span(line.text, messageColor(line.level))]),
    };
  }

  /** The body as the terminal shows it: a terminal-only canvas, so it pages by the rows it wraps to at its own width. */
  #body(body: string): UiNode[] {
    if (!body) return [h("text", { spans: [span("(empty body)", "dim")] })];
    if (this.env.native) return [h("text", { text: body, wrap: "word" })];
    return [h("canvas", { paint: (width) => this.#paintBody(body, width) })];
  }

  /** The wrapped rows that fit from the scroll position, and where they are in the body when it is cut. */
  #paintBody(body: string, width: number): string[] {
    this.#bodyWidth = width;
    const lines = wrap(body, width);
    const rows = this.#bodyRows();
    if (lines.length <= rows) return lines;
    const top = Math.min(this.#bodyTop(), lines.length - rows);
    const end = top + rows;
    const where = `lines ${top + 1}–${end} of ${lines.length} · PgUp/PgDn scroll`;
    return [...lines.slice(top, end), truncate(this.env.theme.style("dim", where), width)];
  }

  /** The selected snippet: key and description, its facts, the body as plain text (it is what the shortcut sends). */
  #preview(): UiNode {
    const entry = this.#current().entry;
    if (!entry) return h("text", { spans: [span("No snippet selected", "dim")] });
    const { snippet } = entry;
    const fields = snippetFields(entry, this.entries).map(([label, value]) =>
      label === "Path" ? ([label, [span(value, "path dim")]] as const) : ([label, value] as const),
    );
    const gap = () => h("spacer", { size: "sm" });
    return h(
      "col",
      { key: `preview:${snippet.id}` },
      h("text", {
        spans: [span(snippet.key, "strong accent"), ...(snippet.description ? [span(`  ${snippet.description}`, "muted")] : [])],
        wrap: "word",
      }),
      gap(),
      kv(fields),
      gap(),
      this.#body(snippet.body),
      // Sets the key hints off from the body.
      gap(),
    );
  }

  #view(): UiNode {
    const subtitle = (): TspSpan[] | undefined => {
      const lines = this.#messages();
      if (!lines.length) return undefined;
      return lines.flatMap((line, index) => [...(index ? [span("  ·  ", "dim")] : []), span(line.text, messageColor(line.level))]);
    };
    return h(
      "picker",
      {
        title: PLUGIN,
        noun: "snippets",
        icon: "clipboard",
        size: "lg",
        layout: "rows",
        preview: "below",
        query: () => this.#search().text,
        cursor: () => this.#search().cursor,
        placeholder: "Search keys, descriptions and bodies…",
        tabs: FILTERS.map((scope) => ({ id: scope ?? "all", label: scope ? capitalize(scope) : "All", count: this.#count(scope) })),
        tab: () => this.#filter() ?? "all",
        items: this.#items,
        order: () => this.#visible().map(({ snippet }) => snippet.id),
        hits: () => this.#hits(),
        selected: () => this.#current().entry?.snippet.id ?? null,
        total: this.entries.length,
        actions: () => this.#actions(),
        // A ready picker draws `message` nowhere; the head's subtitle carries the result and problem line.
        subtitle,
        empty: () =>
          this.entries.length
            ? "No snippets match; Esc clears the search, a tab changes the filter"
            : "No snippets yet; choose New to create one",
        term: () => this.#term(),
        onKey: (key) => this.key(key),
        onPaste: (paste) => this.paste(paste),
        onSelect: (id) => this.pick(id, false),
        onActivate: (id) => this.pick(id, true),
        onAction: (act, event) => this.run(act, event.value),
      },
      () => this.#preview(),
    );
  }
}
