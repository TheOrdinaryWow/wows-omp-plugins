import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { type KeyEvent, nativeRendering, type ScrollRequest, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";

import { type AdrRecord, type AdrStatus, STATUSES, withoutManagedLines } from "#src/documents.ts";
import { type Attrs, h, kv, span } from "#src/tsp.ts";

/** One line under the console body; failures render in the error color. */
export interface ConsoleMessage {
  text: string;
  level: "info" | "error";
}

/** Per-ADR keys, in the order the hints list them. `key` is the uppercase letter; Shift+letter sends it too. */
export const DECISION_KEYS = [
  ["A", "accept"],
  ["R", "reject"],
  ["D", "deprecate"],
  ["N", "note"],
  ["S", "supersede"],
] as const;
export type DecisionAction = (typeof DECISION_KEYS)[number][1];
export type GlobalAction = "new" | "check" | "check-fix";
const GLOBAL_KEYS: ReadonlyArray<readonly [string, GlobalAction, string]> = [
  ["O", "new", "new decision"],
  ["C", "check", "check"],
  ["F", "check-fix", "check + index"],
];

export type ConsoleResult =
  | { kind: "close" }
  | { kind: "decide"; id: string }
  | { kind: "action"; action: DecisionAction; id: string }
  | { kind: "action"; action: GlobalAction };

export interface ConsoleEntry {
  record: AdrRecord;
  detail: string;
  /** Actions `decisions()` offers for this ADR. */
  offered: readonly DecisionAction[];
}

/** Filter and search survive a console re-open after a local action. */
export interface ConsoleState {
  filter?: AdrStatus;
  query: string;
  selectedId?: string;
}

/** What the views read from the host: the terminal size, reactive inside nodes. */
export type ViewHost = Pick<ExtensionUiHost, "size">;

const PLUGIN = "ADR";
// Tern sizes lg sheets by content, so fix the root's line extent from terminal height; only a list scrolls.
const SHEET_MARGIN_LINES = 8;
const SHEET_MIN_LINES = 16;
const FILL = { grow: 1, shrink: 1, basis: 0, min: { h: 0 } } as const;
const SCROLLER = { ...FILL, max: { lines: 10_000 } } as const;

function sheetExtent(rows: number) {
  const h = `${Math.max(SHEET_MIN_LINES, rows - SHEET_MARGIN_LINES)}lines` as const;
  return { h };
}

/** Native tone and icon per status; the terminal colors the row in the tone. */
export const STATUS_TONE: Record<AdrStatus, "warning" | "success" | "error" | "muted"> = {
  proposed: "warning",
  accepted: "success",
  rejected: "error",
  deprecated: "muted",
  superseded: "muted",
};
const STATUS_ICON: Record<AdrStatus, string> = {
  proposed: "clock",
  accepted: "check",
  rejected: "x",
  deprecated: "minus",
  superseded: "forward",
};

const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;

/**
 * `detailText` split into its metadata fields (minus the title and status rows the views show
 * themselves) and the MADR body without its title heading.
 */
function detailParts(detail: string): { fields: Array<readonly [string, string]>; body: string } {
  // detailText: a metadata block (first line repeats the title), a blank line, then the MADR body.
  const split = detail.indexOf("\n\n");
  const meta = (split < 0 ? detail : detail.slice(0, split))
    .split("\n")
    .slice(1)
    .filter((line) => !line.startsWith("Status: "));
  const fields = meta.map((line) => {
    const colon = line.indexOf(": ");
    return colon > 0 ? ([line.slice(0, colon), line.slice(colon + 2)] as const) : (["", line] as const);
  });
  return { fields, body: split < 0 ? "" : detail.slice(split + 2).replace(/^# [^\n]*\n+/, "") };
}

/**
 * The terminal paints the sheet at the screen's size in a frame of two rows and four columns and scrolls
 * nothing itself, so the views budget their rows against what the frame leaves.
 */
interface Geometry {
  width: number;
  rows: number;
  sidebar: number;
}

function geometry(host: ViewHost): Geometry {
  const { columns, rows } = host.size();
  const width = Math.max(24, columns - 4);
  const sidebar = Math.max(18, Math.min(52, Math.floor(width * 0.36)));
  return { width, rows: Math.max(10, rows - 2), sidebar };
}

/** Rows `text` wraps to at `width`, estimated from its cell width. */
function rowsOf(text: string, width: number): number {
  return Math.max(1, Math.ceil(visibleWidth(text) / Math.max(1, width)));
}

/** The uppercase letter of `A` or Shift+a; undefined for any other key. */
function shiftLetter(key: KeyEvent): string | undefined {
  if (key.text && /^[A-Z]$/.test(key.text)) return key.text;
  return /^shift\+([a-z])$/.exec(key.id)?.[1]?.toUpperCase();
}

const shiftKeys = (letter: string): string[] => ["shift", letter.toLowerCase()];

function button(act: string, text: string, keys: readonly string[], variant?: Attrs<"button">["variant"]): UiNode {
  return h("button", { key: act, text, keys, actions: { click: act }, ...(variant ? { variant } : {}) });
}

/** Navigation keys the buttons do not show, as one muted line. */
function hintLine(hints: ReadonlyArray<readonly [string, string]>): UiNode {
  const spans: TspSpan[] = [];
  for (const [keys, label] of hints) {
    if (spans.length) spans.push(span("   "));
    spans.push(span(keys, "key"), span(` ${label}`, "muted"));
  }
  return h("text", { key: "hints", spans, truncate: "end" });
}

function messageLine(message: ConsoleMessage | undefined): UiNode | undefined {
  if (!message) return undefined;
  return h("text", { key: "message", spans: [span(message.text, message.level === "error" ? "error" : "warning")], wrap: "word" });
}

/** What a scrolling pane shows: `head`, then the body. */
interface PaneContent {
  /** A new key starts the pane at its top. */
  key: string;
  head: UiNode[];
  body?: { kind: "md"; text: string } | { kind: "code"; text: string; path: string };
}

function bodyNode(content: PaneContent): UiNode | undefined {
  const body = content.body;
  if (!body) return undefined;
  if (body.kind === "code") return h("code", { key: "code", text: body.text.replace(/\n$/, ""), path: body.path });
  return h("md", { key: "md", text: body.text });
}

/**
 * The right-hand pane. Tern scrolls it itself (PgUp/PgDn arrive as a scroll request on the scroller's
 * content, since Tern moves the scroller above the node that carries it). The terminal paints nothing in a
 * scroller, so there the pane is a canvas: the content painted offline at the pane's width, cached per width
 * and theme, shown from a row offset with a line above and below saying what is out of view.
 */
class Pane {
  #key: string | undefined;
  #offset = 0;
  #request: ScrollRequest | undefined;
  #painted: { width: number; theme: unknown; rows: readonly string[] } | undefined;
  /** Rows the content took and rows the pane showed, as last painted. */
  #extent = { total: 0, rows: 0 };

  constructor(readonly native: boolean) {}

  page(by: "page-up" | "page-down"): void {
    this.#request = { by, n: (this.#request?.n ?? 0) + 1 };
    const { total, rows } = this.#extent;
    const step = Math.max(1, rows - 3);
    this.#offset = Math.max(0, Math.min(this.#offset + (by === "page-down" ? step : -step), total - (rows - 1)));
  }

  /** The content's rows at `width` in the current theme, painted once per width and theme. */
  #rows(content: UiNode, width: number): readonly string[] {
    const theme = currentTheme();
    const painted = this.#painted;
    if (painted?.width === width && painted.theme === theme) return painted.rows;
    const rows = renderBlock(content, width, { theme }).rows;
    this.#painted = { width, theme, rows };
    return rows;
  }

  node(content: PaneContent, rows: number): UiNode {
    if (content.key !== this.#key) {
      this.#key = content.key;
      this.#offset = 0;
      this.#painted = undefined;
    }
    const body = h(
      "col",
      { key: "content", gap: "sm", ...(this.native ? { scroll: this.#request } : {}) },
      ...content.head,
      bodyNode(content),
    );
    if (this.native) return h("list", { ...SCROLLER, key: "body-scroll" }, body);
    return h("canvas", {
      key: "pane",
      paint: (width) => {
        const all = this.#rows(body, width);
        const offset = Math.max(0, Math.min(this.#offset, all.length - (rows - 1)));
        this.#offset = offset;
        this.#extent = { total: all.length, rows };
        if (all.length <= rows) return all;
        const above = offset > 0 ? [currentTheme().style("dim", truncate(`↑ ${offset} earlier lines: PgUp`, width))] : [];
        const room = rows - above.length;
        const below = all.length - offset > room ? 1 : 0;
        const shown = all.slice(offset, offset + room - below);
        const hidden = all.length - offset - shown.length;
        return [...above, ...shown, ...(below ? [currentTheme().style("dim", truncate(`… ${hidden} more lines: PgDn`, width))] : [])];
      },
    });
  }
}

interface SidebarItem {
  key: string;
  attrs: Omit<Attrs<"item">, "key">;
}

/**
 * The left-hand list. Tern scrolls it and reveals the selection; the terminal shows a window around the
 * selection (moving only as far as the selection needs) with a position line, padded to the pane's rows.
 */
class Sidebar {
  #start: number | undefined;
  #moves = 0;

  constructor(readonly native: boolean) {}

  moved(): void {
    this.#moves++;
  }

  node(
    key: string,
    items: readonly SidebarItem[],
    selected: string | undefined,
    geo: { rows: number; width: number },
    attrs: Pick<Attrs<"list">, "empty" | "onSelect" | "onActivate">,
  ): UiNode {
    if (this.native) {
      const reveal = { at: "nearest" as const, n: this.#moves };
      return h(
        "col",
        { key: "sidebar", max: { w: "32ch" }, shrink: 0, min: { h: 0 } },
        h(
          "list",
          { ...SCROLLER, ...attrs, key, selected: selected ?? null },
          items.map((item) => h("item", { ...item.attrs, key: item.key, ...(item.key === selected ? { reveal } : {}) })),
        ),
      );
    }
    const total = items.length;
    const overflow = total > geo.rows;
    const visible = overflow ? geo.rows - 1 : total;
    const index = Math.max(
      0,
      items.findIndex((item) => item.key === selected),
    );
    let start = this.#start ?? index - Math.floor(visible / 2);
    if (index < start) start = index;
    else if (index >= start + visible) start = index - visible + 1;
    start = Math.max(0, Math.min(start, total - visible));
    this.#start = start;
    const used = Math.max(1, visible) + (overflow ? 1 : 0);
    return h(
      "col",
      { key: "sidebar", basis: geo.width, shrink: 0 },
      h(
        "list",
        { ...attrs, key, selected: selected ?? null },
        items.slice(start, start + visible).map((item) => h("item", { ...item.attrs, key: item.key })),
      ),
      overflow ? h("text", { key: "position", spans: [span(`${start + 1}–${start + visible} of ${total}`, "dim")] }) : undefined,
      used < geo.rows
        ? h("text", { key: "fill", text: Array.from({ length: geo.rows - used }, () => " ").join("\n"), wrap: "none" })
        : undefined,
    );
  }
}

function splitRow(sidebar: UiNode, pane: UiNode): UiNode {
  return h("row", { key: "split", ...FILL, gap: "md", align: "stretch" }, sidebar, h("col", { key: "body", ...FILL }, pane));
}

/** A sheet: Tern shows it as a large modal glass sheet; the terminal frames it with the head in its top border. */
function sheet(role: string, head: string, host: ViewHost, handlers: Pick<Attrs<"overlay">, "onKey" | "onAction">, view: () => UiNode[]) {
  return h(
    "overlay",
    { role, size: "lg", anchor: "center", modal: true, head, ...handlers },
    h("col", { key: "screen", gap: "sm", min: () => sheetExtent(host.size().rows), max: () => sheetExtent(host.size().rows) }, view),
  );
}

/** Fullscreen `/adr` console: status filters, a searchable ADR sidebar, and the selected decision's full text. */
export class AdrConsole {
  /** The view `ctx.ui.custom` mounts. */
  readonly root: UiNode;
  readonly #revision = signal(0);
  readonly #pane: Pane;
  readonly #sidebar: Sidebar;
  #filter: AdrStatus | undefined;
  #query: string;
  #selectedId: string | undefined;
  #message: ConsoleMessage | undefined;

  constructor(
    readonly entries: readonly ConsoleEntry[],
    state: ConsoleState,
    readonly host: ViewHost,
    readonly done: (result: ConsoleResult, state: ConsoleState) => void,
    message?: ConsoleMessage,
  ) {
    const native = nativeRendering();
    this.#pane = new Pane(native);
    this.#sidebar = new Sidebar(native);
    this.#filter = state.filter && entries.some((entry) => entry.record.status === state.filter) ? state.filter : undefined;
    this.#query = state.query;
    this.#selectedId = state.selectedId;
    this.#message = message;
    this.root = sheet(
      "omp.overlay.adr.console",
      `${PLUGIN} · ${this.#summary()}`,
      host,
      { onKey: (key) => this.#key(key), onAction: (act) => this.#action(act) },
      () => {
        this.#revision();
        return this.#view();
      },
    );
  }

  #changed(): void {
    this.#revision.update((value) => value + 1);
  }

  #filters(): Array<AdrStatus | undefined> {
    return [undefined, ...STATUSES.filter((status) => this.entries.some((entry) => entry.record.status === status))];
  }

  #count(status: AdrStatus | undefined): number {
    return status ? this.entries.filter((entry) => entry.record.status === status).length : this.entries.length;
  }

  #visible(): ConsoleEntry[] {
    const words = this.#query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.entries.filter((entry) => {
      if (this.#filter && entry.record.status !== this.#filter) return false;
      const haystack = `${entry.record.id} ${entry.record.title} ${entry.record.status}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  /** The selected entry among the visible ones; when it is filtered out the first visible one becomes the selection. */
  #current(visible = this.#visible()): { entry?: ConsoleEntry; index: number } {
    const index = visible.findIndex((entry) => entry.record.id === this.#selectedId);
    if (index >= 0) return { entry: visible[index], index };
    if (visible[0]) this.#selectedId = visible[0].record.id;
    return { entry: visible[0], index: 0 };
  }

  #select(index: number): void {
    const visible = this.#visible();
    if (!visible.length) return;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (!next || next.record.id === this.#current(visible).entry?.record.id) return;
    this.#selectedId = next.record.id;
    this.#sidebar.moved();
  }

  #state(): ConsoleState {
    return { filter: this.#filter, query: this.#query, selectedId: this.#current().entry?.record.id ?? this.#selectedId };
  }

  #finish(result: ConsoleResult): void {
    this.done(result, this.#state());
  }

  #setFilter(filter: AdrStatus | undefined): void {
    this.#filter = filter;
    this.#sidebar.moved();
  }

  #cycle(delta: 1 | -1): void {
    const filters = this.#filters();
    const index = filters.indexOf(this.#filter);
    this.#setFilter(filters[(index + delta + filters.length) % filters.length]);
  }

  #decision(letter: string): void {
    const action = DECISION_KEYS.find(([key]) => key === letter)?.[1];
    if (!action) return;
    const entry = this.#current().entry;
    if (!entry) {
      this.#message = { text: "No ADR selected", level: "error" };
      return;
    }
    if (!entry.offered.includes(action)) {
      this.#message = { text: `${capitalize(action)} is not available for ${entry.record.id} (${entry.record.status})`, level: "error" };
      return;
    }
    this.#finish({ kind: "action", action, id: entry.record.id });
  }

  #escape(): void {
    if (this.#query) this.#query = "";
    else this.#finish({ kind: "close" });
  }

  #enter(): void {
    const entry = this.#current().entry;
    if (entry) this.#finish({ kind: "decide", id: entry.record.id });
    else if (!this.entries.length) this.#finish({ kind: "action", action: "new" });
  }

  #key(key: KeyEvent): boolean {
    if (key.kind === "release") return false;
    const letter = shiftLetter(key);
    const global = GLOBAL_KEYS.find(([candidate]) => candidate === letter);
    const typed = key.text !== undefined && !letter && (this.#query !== "" || key.text.trim() !== "") ? key.text : undefined;
    const known = ["escape", "shift+tab", "tab", "up", "down", "home", "end", "pageUp", "pageDown", "enter", "backspace"].includes(key.id);
    if (!known && !letter && typed === undefined) return false;
    this.#message = undefined;
    if (key.id === "escape") this.#escape();
    else if (key.id === "shift+tab") this.#cycle(-1);
    else if (key.id === "tab") this.#cycle(1);
    else if (key.id === "up") this.#select(this.#current().index - 1);
    else if (key.id === "down") this.#select(this.#current().index + 1);
    else if (key.id === "home") this.#select(0);
    else if (key.id === "end") this.#select(Number.MAX_SAFE_INTEGER);
    else if (key.id === "pageDown") this.#pane.page("page-down");
    else if (key.id === "pageUp") this.#pane.page("page-up");
    else if (key.id === "enter") this.#enter();
    else if (key.id === "backspace") this.#query = this.#query.slice(0, -1);
    else if (global) this.#finish({ kind: "action", action: global[1] });
    else if (letter) this.#decision(letter);
    else if (typed !== undefined) this.#query += typed;
    this.#changed();
    return true;
  }

  /** Buttons run the key paths. */
  #action(act: string): void {
    const global = GLOBAL_KEYS.find(([, action]) => action === act);
    const decision = DECISION_KEYS.find(([, action]) => action === act);
    if (act !== "close" && act !== "decide" && !global && !decision) return;
    this.#message = undefined;
    if (act === "close") this.#escape();
    else if (act === "decide") this.#enter();
    else if (global) this.#finish({ kind: "action", action: global[1] });
    else if (decision) this.#decision(decision[0]);
    this.#changed();
  }

  #summary(): string {
    const summary = STATUSES.map((status) => [status, this.#count(status)] as const)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ");
    return summary || "no ADRs yet";
  }

  /** Filter tabs (short labels when the full ones crowd the search out of a terminal row) and the search. */
  #head(geo: Geometry): UiNode {
    const filters = this.#filters();
    const label = (status: AdrStatus | undefined, short: boolean) => {
      const name = status ? capitalize(status) : "All";
      return `${short ? name.slice(0, 3) : name} ${this.#count(status)}`;
    };
    const tabsWidth = (short: boolean) => filters.reduce((sum, status) => sum + label(status, short).length + 4, 0);
    const short = !this.#pane.native && tabsWidth(false) + 18 > geo.width;
    const search = this.#query ? [span("Search: ", "muted"), span(this.#query, "strong")] : [span("Type to search", "dim")];
    return h(
      "row",
      { key: "head", gap: "md", align: "center", wrap: true },
      h("tabs", {
        key: "filter",
        items: filters.map((status) => ({ id: status ?? "all", label: label(status, short) })),
        active: this.#filter ?? "all",
        onSelect: (id) => {
          const filter = this.#filters().find((status) => (status ?? "all") === id);
          if (filter === undefined && id !== "all") return;
          this.#message = undefined;
          this.#setFilter(filter);
          this.#changed();
        },
      }),
      h("text", { key: "search", role: "omp.adr.search", spans: search, grow: 1, truncate: "end", lines: 1 }),
    );
  }

  /** The decision: id and title, status and dates, metadata, then the MADR body. */
  #content(entry: ConsoleEntry | undefined): PaneContent {
    if (!entry) {
      const empty = this.entries.length
        ? "No ADRs match; Esc clears the search, Tab changes the filter"
        : "No ADRs yet; press Shift+O to start one";
      return { key: "", head: [h("text", { key: "empty", spans: [span(empty, "dim")], wrap: "word" })] };
    }
    const { record } = entry;
    const { fields, body } = detailParts(entry.detail);
    const where = [
      record.date,
      record.stage ? `stage ${record.stage}` : "",
      record.superseded_by ? `superseded by ${record.superseded_by}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const meta = kv(fields);
    return {
      key: record.id,
      head: [
        h(
          "col",
          { key: "heading" },
          h("text", { key: "title", spans: [span(`${record.id}  `, "muted"), span(record.title, "strong accent")], wrap: "word" }),
          h("text", {
            key: "status",
            spans: [span(record.status, STATUS_TONE[record.status]), ...(where ? [span(`  ${where}`, "dim")] : [])],
            wrap: "word",
          }),
        ),
        ...(meta ? [meta] : []),
      ],
      ...(body.trim() ? { body: { kind: "md" as const, text: body } } : {}),
    };
  }

  #view(): UiNode[] {
    const geo = geometry(this.host);
    const visible = this.#visible();
    const { entry } = this.#current(visible);
    const message = this.#message;
    const footerRows = (entry ? 1 : 0) + 1 + (message ? rowsOf(message.text, geo.width) : 0) + 1;
    // The head row and the two gaps around the panes.
    const rows = Math.max(3, geo.rows - footerRows - 3);
    const items = visible.map(({ record }) => ({
      key: record.id,
      attrs: {
        label: [span(`${record.id} `, "muted"), span(record.title)],
        icon: STATUS_ICON[record.status],
        tone: STATUS_TONE[record.status],
        title: `${record.id} · ${record.status}`,
      },
    }));
    const sidebar = this.#sidebar.node(
      "adrs",
      items,
      entry?.record.id,
      { rows, width: geo.sidebar },
      {
        empty: this.entries.length ? "No ADRs match" : "No ADRs yet",
        onSelect: (id) => this.#pick(id),
        onActivate: (id) => {
          if (this.#pick(id)) this.#enter();
        },
      },
    );
    return [
      this.#head(geo),
      splitRow(sidebar, this.#pane.node(this.#content(entry), rows)),
      h(
        "col",
        { key: "footer" },
        entry
          ? h(
              "row",
              { key: "decisions", gap: "sm", wrap: true },
              button("decide", "Decide…", ["enter"], "primary"),
              ...DECISION_KEYS.filter(([, action]) => entry.offered.includes(action)).map(([letter, action]) =>
                button(action, capitalize(action), shiftKeys(letter)),
              ),
            )
          : undefined,
        h(
          "row",
          { key: "tools", gap: "sm", wrap: true },
          ...GLOBAL_KEYS.map(([letter, action, label]) => button(action, capitalize(label), shiftKeys(letter))),
          button("close", "Close", ["escape"], "quiet"),
        ),
        messageLine(message),
        hintLine([
          ["↑↓", "select"],
          ["PgUp PgDn", "scroll"],
          ["Tab", "filter"],
          ["type", "search"],
          ["Esc", this.#query ? "clear search" : "close"],
        ]),
      ),
    ];
  }

  /** A list click selects the row; false when the id is not listed. */
  #pick(id: string): boolean {
    const index = this.#visible().findIndex((candidate) => candidate.record.id === id);
    if (index < 0) return false;
    this.#message = undefined;
    this.#select(index);
    this.#changed();
    return true;
  }
}

export interface PreviewItem {
  path: string;
  content: string;
}

/** Fullscreen write preview: actions and files on the left, the selected file on the right. Resolves true to write. */
export class AdrPreview {
  /** The view `ctx.ui.custom` mounts. */
  readonly root: UiNode;
  readonly #revision = signal(0);
  readonly #pane: Pane;
  readonly #sidebar: Sidebar;
  /** Row 0 writes, rows 1..n are files, the last row cancels. */
  #selected: number;
  #message: ConsoleMessage | undefined;

  constructor(
    readonly title: string,
    readonly files: readonly PreviewItem[],
    readonly host: ViewHost,
    readonly done: (write: boolean) => void,
  ) {
    const native = nativeRendering();
    this.#pane = new Pane(native);
    this.#sidebar = new Sidebar(native);
    this.#selected = files.length ? 1 : 0;
    this.root = sheet(
      "omp.overlay.adr.preview",
      `${PLUGIN} · write preview`,
      host,
      { onKey: (key) => this.#key(key), onAction: (act) => this.#action(act) },
      () => {
        this.#revision();
        return this.#view();
      },
    );
  }

  get #cancelRow(): number {
    return this.files.length + 1;
  }

  get #count(): string {
    return `${this.files.length} file${this.files.length === 1 ? "" : "s"}`;
  }

  #changed(): void {
    this.#revision.update((value) => value + 1);
  }

  #select(index: number): void {
    const next = Math.max(0, Math.min(this.#cancelRow, index));
    if (next === this.#selected) return;
    this.#selected = next;
    this.#sidebar.moved();
  }

  #enter(): void {
    if (this.#selected === 0) this.done(true);
    else if (this.#selected === this.#cancelRow) this.done(false);
    else this.#message = { text: "Press Shift+W to write every file, or Esc to cancel", level: "info" };
  }

  #key(key: KeyEvent): boolean {
    if (key.kind === "release") return false;
    const write = shiftLetter(key) === "W";
    if (!write && !["escape", "up", "down", "home", "end", "pageUp", "pageDown", "enter"].includes(key.id)) return false;
    this.#message = undefined;
    if (key.id === "escape") this.done(false);
    else if (write) this.done(true);
    else if (key.id === "up") this.#select(this.#selected - 1);
    else if (key.id === "down") this.#select(this.#selected + 1);
    else if (key.id === "home") this.#select(0);
    else if (key.id === "end") this.#select(this.#cancelRow);
    else if (key.id === "pageDown") this.#pane.page("page-down");
    else if (key.id === "pageUp") this.#pane.page("page-up");
    else if (key.id === "enter") this.#enter();
    this.#changed();
    return true;
  }

  #action(act: string): void {
    if (act === "write") this.done(true);
    else if (act === "cancel") this.done(false);
  }

  /** A list click selects the row; false when the id is not a row. */
  #pick(id: string): boolean {
    const index = /^r\d+$/.test(id) ? Number(id.slice(1)) : -1;
    if (index < 0 || index > this.#cancelRow) return false;
    this.#message = undefined;
    this.#select(index);
    this.#changed();
    return true;
  }

  /** The selected file (Markdown rendered, front matter as YAML, anything else as code), or the summary on Write and Cancel. */
  #content(): PaneContent {
    const file = this.files[this.#selected - 1];
    if (!file) {
      const note = "Nothing is written until you choose Write. Select a file to read it before deciding.";
      return {
        key: "summary",
        head: [
          h(
            "col",
            { key: "files" },
            h("text", { key: "label", spans: [span("Files to write:", "muted")] }),
            ...this.files.map((entry) => h("text", { key: entry.path, spans: [span(`  ${entry.path}`, "path")], wrap: "word" })),
          ),
          h("text", { key: "note", spans: [span(note, "dim")], wrap: "word" }),
        ],
      };
    }
    const path = h("text", { key: "path", spans: [span(file.path, "path strong")], wrap: "word" });
    const key = `file:${this.#selected}`;
    if (!/\.md$/i.test(file.path)) return { key, head: [path], body: { kind: "code", text: file.content, path: file.path } };
    // YAML front matter is not Markdown: show it as YAML, then the document after it.
    const front = /^---\n[\s\S]*?\n---\n/.exec(file.content)?.[0] ?? "";
    const yaml = front.slice(4, -4).trim();
    return {
      key,
      head: [path, ...(yaml ? [h("code", { key: "front", text: yaml, lang: "yaml" })] : [])],
      body: { kind: "md", text: withoutManagedLines(file.content.slice(front.length)) },
    };
  }

  #view(): UiNode[] {
    const geo = geometry(this.host);
    const message = this.#message;
    const titleRows = rowsOf(this.title, geo.width);
    const footerRows = 1 + (message ? rowsOf(message.text, geo.width) : 0) + 1;
    const rows = Math.max(3, geo.rows - titleRows - footerRows - 2);
    const items: SidebarItem[] = [
      { key: "r0", attrs: { label: `Write ${this.#count}`, icon: "save", tone: "success" } },
      // The file name first: a long path would truncate it away; the directory follows dim and gives way first.
      ...this.files.map((file, index) => {
        const slash = file.path.lastIndexOf("/");
        return {
          key: `r${index + 1}`,
          attrs: {
            label: [span(file.path.slice(slash + 1), "path")],
            ...(slash > 0 ? { detail: file.path.slice(0, slash) } : {}),
            icon: "file",
            title: file.path,
          },
        };
      }),
      { key: `r${this.#cancelRow}`, attrs: { label: "Cancel", icon: "x", tone: "error" } },
    ];
    const sidebar = this.#sidebar.node(
      "rows",
      items,
      `r${this.#selected}`,
      { rows, width: geo.sidebar },
      {
        onSelect: (id) => this.#pick(id),
        onActivate: (id) => {
          if (!this.#pick(id)) return;
          this.#enter();
          this.#changed();
        },
      },
    );
    return [
      h("text", { key: "title", spans: [span(this.title, "strong")], wrap: "word" }),
      splitRow(sidebar, this.#pane.node(this.#content(), rows)),
      h(
        "col",
        { key: "footer" },
        h(
          "row",
          { key: "actions", gap: "sm", wrap: true },
          button("write", `Write ${this.#count}`, shiftKeys("W"), "primary"),
          button("cancel", "Cancel", ["escape"], "quiet"),
        ),
        messageLine(message),
        hintLine([
          ["↑↓", "select"],
          ["PgUp PgDn", "scroll"],
          ["Enter", "choose"],
          ["Esc", "cancel"],
        ]),
      ),
    ];
  }
}
