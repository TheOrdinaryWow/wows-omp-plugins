import {
  type Component,
  code,
  col,
  extractPrintableText,
  item,
  keyed,
  kv,
  matchesKey,
  type NativeChild,
  type NativeNode,
  type NativeUiEvent,
  row as nativeRow,
  node,
  padding,
  routeSgrMouseInput,
  type SgrMouseEvent,
  span,
  type Theme,
  type TUI,
  text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import {
  bottomBorder,
  dividerSplit,
  rawKeyHint,
  renderSegmentTrack,
  row,
  splitBodyWidth,
  splitRow,
  topBorder,
} from "@oh-my-pi/pi-tui/chrome";
import { leafKey } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, escCloseButton, hintsRow, selectList } from "@oh-my-pi/pi-tui/native/overlay";

import type { SnippetScope } from "#src/snippet.ts";
import type { SnippetEntry } from "#src/store.ts";

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

const PLUGIN = "Snippets";
const FILTERS: ReadonlyArray<SnippetScope | undefined> = [undefined, "global", "workspace"];
/** Rows per wheel notch, as in the host's fullscreen plan review. */
const WHEEL_ROWS = 3;

const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;

/** The label an action carries for this snippet: toggle and pin name the state they switch to. */
export function actionLabel(action: EntryAction, snippet: Pick<SnippetEntry, "enabled" | "pinned">): string {
  if (action === "toggle") return snippet.enabled ? "disable" : "enable";
  if (action === "pin") return snippet.pinned ? "unpin" : "pin";
  if (action === "send") return "send now";
  return action;
}

/** Facts the preview shows under the title, shared by the terminal and the native body. */
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

/** Dim sidebar detail: scope first, then the description. */
function rowDetail(snippet: SnippetEntry): string {
  return snippet.description ? `${snippet.scope} · ${snippet.description}` : snippet.scope;
}

type Tone = "accent" | "muted" | undefined;
/** Native icon and tone: pinned, disabled and shadowed win over the scope icon. */
function nativeMark(snippet: SnippetEntry): { icon: string; tone: Tone } {
  if (snippet.shadowed) return { icon: "eye-off", tone: "muted" };
  if (!snippet.enabled) return { icon: "minus", tone: "muted" };
  if (snippet.pinned) return { icon: "pin", tone: "accent" };
  return { icon: snippet.scope === "global" ? "globe" : "folder", tone: undefined };
}

/** Natively the terminal scrolls the body; PgUp/PgDn still reach the program, which forwards them as a scroll request. */
type BodyScroll = { by: "page-up" | "page-down"; n: number };

const CONSOLE_HINTS = hintsRow([
  { keys: ["up", "down"], label: "select" },
  { keys: ["pageUp", "pageDown"], label: "scroll" },
  { keys: ["tab", "shift+tab"], label: "filter" },
  { keys: ["escape"], label: "clear search / close" },
]);

export function hintLines(hints: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const hint of hints) {
    const next = line ? `${line}   ${hint}` : hint;
    if (line && visibleWidth(next) > width) {
      lines.push(truncateToWidth(line, width));
      line = hint;
    } else {
      line = next;
    }
  }
  if (line) lines.push(truncateToWidth(line, width));
  return lines;
}

function messageColor(level: ConsoleMessage["level"]): "success" | "warning" | "error" {
  return level === "info" ? "success" : level;
}

/** Scrollable split-pane frame: title, header, sidebar|body, message, hints. */
class SplitFrame {
  bodyRows = 1;
  bodyTop = 0;
  dividerCol = 0;
  scroll = 0;
  scrollMax = Number.MAX_SAFE_INTEGER;

  constructor(readonly theme: Theme) {}

  scrollBy(delta: number): void {
    this.scroll = Math.max(0, Math.min(this.scrollMax, this.scroll + delta));
  }

  render(
    width: number,
    height: number,
    parts: {
      title: string;
      header: string;
      sidebarWidth: number;
      sidebar: (rows: number) => string[];
      body: (width: number) => string[];
      message?: ConsoleMessage;
      hints: readonly string[];
    },
  ): string[] {
    const t = this.theme;
    const inner = Math.max(1, width - 4);
    // Short terminals keep at least three body rows; the hints that do not fit are dropped.
    const hints = hintLines(parts.hints, inner).slice(0, Math.max(1, height - 9));
    const sidebarWidth = parts.sidebarWidth;
    const bodyWidth = Math.max(1, splitBodyWidth(width, sidebarWidth));
    // Title, header, split rule, divider, message, bottom border.
    this.bodyRows = Math.max(1, height - 6 - hints.length);
    this.bodyTop = 3;
    this.dividerCol = sidebarWidth + 3;
    const body = parts.body(bodyWidth);
    this.scrollMax = Math.max(0, body.length - this.bodyRows);
    this.scroll = Math.min(this.scroll, this.scrollMax);
    const shown = body.slice(this.scroll, this.scroll + this.bodyRows);
    // The notice replaces the last visible line, so that line counts as hidden too.
    const more = body.length - this.scroll - shown.length + 1;
    if (more > 1 && shown.length) shown[shown.length - 1] = t.fg("dim", `+${more} more lines; PgDn/wheel to scroll`);
    const sidebar = parts.sidebar(this.bodyRows);
    const box = t.boxRound;
    const splitOpen = t.fg(
      "border",
      box.teeRight +
        box.horizontal.repeat(sidebarWidth + 2) +
        box.teeDown +
        box.horizontal.repeat(Math.max(0, width - sidebarWidth - 5)) +
        box.teeLeft,
    );
    const message = parts.message ? t.fg(messageColor(parts.message.level), parts.message.text) : "";
    return [
      topBorder(width, parts.title),
      row(truncateToWidth(parts.header, inner), width),
      splitOpen,
      ...Array.from({ length: this.bodyRows }, (_, index) =>
        splitRow(truncateToWidth(sidebar[index] ?? "", sidebarWidth), truncateToWidth(shown[index] ?? "", bodyWidth), width, sidebarWidth),
      ),
      dividerSplit(width, sidebarWidth),
      row(truncateToWidth(message, inner), width),
      ...hints.map((line) => row(line, width)),
      bottomBorder(width),
    ];
  }

  /** Wheel over the sidebar calls `select`, over the body scrolls it; every other report is swallowed. */
  mouse(event: SgrMouseEvent, select: (delta: number) => void): void {
    if (event.wheel === null) return;
    const line = event.row - this.bodyTop;
    if (line < 0 || line >= this.bodyRows) return;
    if (event.col < this.dividerCol) select(event.wheel);
    else if (event.col > this.dividerCol) this.scrollBy(event.wheel * WHEEL_ROWS);
  }

  pageRows(): number {
    return Math.max(1, this.bodyRows - 2);
  }
}

/** The pressed uppercase letter for `A` or Shift+a (legacy or Kitty encoding); undefined otherwise. */
function shiftLetter(key: string): string | undefined {
  const typed = extractPrintableText(key);
  if (typed && /^[A-Z]$/.test(typed)) return typed;
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (matchesKey(key, `shift+${letter.toLowerCase()}` as never)) return letter;
  return undefined;
}

/** Sidebar marks, each padded to one cell width. */
interface MarkSlots {
  pin: string;
  disabled: string;
  shadowed: string;
  blank: string;
}

/** Preset glyphs differ in cell width; pad each mark slot to one width so keys line up. */
function markSlots(theme: Theme): MarkSlots {
  const raw = {
    pin: theme.fg("accent", theme.icon.pin),
    disabled: theme.fg("muted", theme.status.disabled),
    shadowed: theme.fg("dim", theme.status.shadowed),
  };
  const width = Math.max(1, ...Object.values(raw).map((mark) => visibleWidth(mark)));
  const pad = (mark: string) => mark + padding(width - visibleWidth(mark));
  return { pin: pad(raw.pin), disabled: pad(raw.disabled), shadowed: pad(raw.shadowed), blank: padding(width) };
}

/** Fullscreen `/snippet` console: scope filters, a searchable snippet sidebar, and the selected snippet's preview. */
export class SnippetConsole implements Component {
  readonly #frame: SplitFrame;
  readonly #marks: MarkSlots;
  #filter: SnippetScope | undefined;
  #query: string;
  #selectedId: string | undefined;
  #message: ConsoleMessage | undefined;
  readonly #notice: ConsoleMessage | undefined;
  #scroll: BodyScroll | undefined;
  #nativeHead: { title: string; props: NonNullable<Component["nativeOverlay"]> } | undefined;
  #native: { sig: string; message: ConsoleMessage | undefined; node: NativeNode } | undefined;
  readonly #nativeBodies = new Map<string, NativeNode>();

  constructor(
    readonly entries: readonly ConsoleEntry[],
    state: ConsoleState,
    readonly theme: Theme,
    readonly tui: TUI,
    readonly done: (result: ConsoleResult, state: ConsoleState) => void,
    options: ConsoleOptions = {},
  ) {
    this.#frame = new SplitFrame(theme);
    this.#marks = markSlots(theme);
    this.#filter = state.filter;
    this.#query = state.query;
    this.#selectedId = state.selectedId;
    this.#message = options.message;
    this.#notice = options.notice;
  }

  #count(scope: SnippetScope | undefined): number {
    return scope ? this.entries.filter((entry) => entry.snippet.scope === scope).length : this.entries.length;
  }

  #visible(): ConsoleEntry[] {
    const words = this.#query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.entries.filter(({ snippet }) => {
      if (this.#filter && snippet.scope !== this.#filter) return false;
      const haystack = `${snippet.key} ${snippet.description} ${snippet.body}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  /** The selected entry among the visible ones; when it is filtered out the first visible one becomes the selection. */
  #current(visible = this.#visible()): { entry?: ConsoleEntry; index: number } {
    const index = visible.findIndex((entry) => entry.snippet.id === this.#selectedId);
    if (index >= 0) return { entry: visible[index], index };
    if (visible[0]) this.#selectedId = visible[0].snippet.id;
    return { entry: visible[0], index: 0 };
  }

  #select(index: number): void {
    const visible = this.#visible();
    if (!visible.length) return;
    const next = visible[Math.max(0, Math.min(visible.length - 1, index))];
    if (!next || next.snippet.id === this.#current(visible).entry?.snippet.id) return;
    this.#selectedId = next.snippet.id;
    this.#frame.scroll = 0;
  }

  #state(): ConsoleState {
    return { filter: this.#filter, query: this.#query, selectedId: this.#current().entry?.snippet.id ?? this.#selectedId };
  }

  #finish(result: ConsoleResult): void {
    this.done(result, this.#state());
  }

  #cycle(delta: 1 | -1): void {
    const index = FILTERS.indexOf(this.#filter);
    this.#filter = FILTERS[(index + delta + FILTERS.length) % FILTERS.length];
    this.#frame.scroll = 0;
  }

  #act(action: EntryAction): void {
    const entry = this.#current().entry;
    if (!entry) {
      this.#message = { text: "No snippet selected", level: "error" };
      return;
    }
    this.#finish({ kind: "action", action, id: entry.snippet.id });
  }

  #escape(): void {
    if (this.#query) this.#query = "";
    else this.#finish({ kind: "close" });
  }

  #enter(): void {
    if (this.#current().entry) this.#act("insert");
    else if (!this.entries.length) this.#finish({ kind: "new" });
  }

  #page(by: BodyScroll["by"]): void {
    this.#frame.scrollBy(by === "page-down" ? this.#frame.pageRows() : -this.#frame.pageRows());
    this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
  }

  handleInput(key: string): void {
    // Checked before anything else: pointer motion must not clear the message or act as a key.
    if (
      routeSgrMouseInput(key, (event) => {
        this.#frame.mouse(event, (delta) => this.#select(this.#current().index + delta));
        return true;
      })
    ) {
      this.tui.requestRender();
      return;
    }
    this.#message = undefined;
    const letter = shiftLetter(key);
    const action = ENTRY_KEYS.find(([candidate]) => candidate === letter)?.[1];
    if (matchesKey(key, "escape")) this.#escape();
    else if (matchesKey(key, "shift+tab")) this.#cycle(-1);
    else if (matchesKey(key, "tab")) this.#cycle(1);
    else if (matchesKey(key, "up")) this.#select(this.#current().index - 1);
    else if (matchesKey(key, "down")) this.#select(this.#current().index + 1);
    else if (matchesKey(key, "home")) this.#select(0);
    else if (matchesKey(key, "end")) this.#select(Number.MAX_SAFE_INTEGER);
    else if (matchesKey(key, "pageDown")) this.#page("page-down");
    else if (matchesKey(key, "pageUp")) this.#page("page-up");
    else if (matchesKey(key, "enter")) this.#enter();
    else if (letter === NEW_KEY) this.#finish({ kind: "new" });
    else if (action) this.#act(action);
    else if (letter) {
      // Uppercase letters without an action still search, so `API` finds `api`.
      this.#query += letter;
      this.#frame.scroll = 0;
    } else if (matchesKey(key, "backspace")) {
      this.#query = this.#query.slice(0, -1);
      this.#frame.scroll = 0;
    } else {
      const typed = extractPrintableText(key);
      if (typed !== undefined && (this.#query || typed.trim())) {
        this.#query += typed;
        this.#frame.scroll = 0;
      }
    }
    this.tui.requestRender();
  }

  #title(): string {
    const counts = [`${this.#count("global")} global`, `${this.#count("workspace")} workspace`];
    return `${PLUGIN} · ${this.entries.length ? counts.join(", ") : "none yet"}`;
  }

  #header(width: number): string {
    const t = this.theme;
    const search = this.#query ? `Search: ${this.#query}` : t.fg("dim", "Type to search");
    const track = (short: boolean) =>
      renderSegmentTrack(
        FILTERS.map((scope) => {
          const label = scope ? capitalize(scope) : "All";
          return { label: `${short ? label.slice(0, 3) : label} ${this.#count(scope)}` };
        }),
        FILTERS.indexOf(this.#filter),
      );
    const full = track(false);
    const tabs = visibleWidth(`${full}  ${search}`) <= width ? full : track(true);
    return `${tabs}  ${search}`;
  }

  #sidebar(width: number, rows: number, visible: ConsoleEntry[]): string[] {
    const t = this.theme;
    if (!visible.length)
      return wrapTextWithAnsi(
        t.fg(
          "dim",
          this.entries.length
            ? "No snippets match; Esc clears the search, Tab changes the filter"
            : "No snippets yet; press Shift+N to create one",
        ),
        width,
      );
    const { index: selected } = this.#current(visible);
    const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), visible.length - rows));
    return visible.slice(start, start + rows).map(({ snippet }, offset) => {
      const isSelected = start + offset === selected;
      const cursor = isSelected ? t.fg("accent", `${t.nav.cursor} `) : "  ";
      const state = snippet.shadowed ? this.#marks.shadowed : snippet.enabled ? this.#marks.blank : this.#marks.disabled;
      const prefix = `${cursor}${snippet.pinned ? this.#marks.pin : this.#marks.blank}${state} `;
      const muted = snippet.shadowed || !snippet.enabled;
      const key = t.fg(isSelected ? "accent" : muted ? "muted" : "text", snippet.key);
      return truncateToWidth(`${prefix}${key}  ${t.fg("dim", rowDetail(snippet))}`, width);
    });
  }

  #body(width: number, entry: ConsoleEntry | undefined): string[] {
    const t = this.theme;
    if (!entry) return [t.fg("dim", "No snippet selected")];
    const { snippet } = entry;
    const lines = wrapTextWithAnsi(
      `${t.bold(t.fg("accent", snippet.key))}${snippet.description ? `  ${t.fg("muted", snippet.description)}` : ""}`,
      width,
    );
    lines.push("");
    const fields = snippetFields(entry, this.entries);
    const labelWidth = Math.max(0, ...fields.map(([label]) => label.length)) + 2;
    for (const [label, value] of fields) {
      if (width < labelWidth + 20) {
        lines.push(...wrapTextWithAnsi(`${t.fg("muted", `${label}: `)}${value}`, width));
        continue;
      }
      for (const [index, line] of wrapTextWithAnsi(value, width - labelWidth).entries())
        lines.push(`${index ? padding(labelWidth) : t.fg("muted", label.padEnd(labelWidth))}${line}`);
    }
    lines.push("");
    // The body is plain text: it is what the shortcut sends, so no Markdown rendering.
    if (!snippet.body) lines.push(t.fg("dim", "(empty body)"));
    else for (const line of snippet.body.split("\n")) lines.push(...(line ? wrapTextWithAnsi(line, width) : [""]));
    return lines;
  }

  #hints(entry: ConsoleEntry | undefined): string[] {
    const t = this.theme;
    return [
      rawKeyHint(["up", "down"], "select"),
      t.fg("dim", "PgUp/PgDn/wheel") + t.fg("muted", " scroll"),
      ...(entry
        ? [
            rawKeyHint("enter", "insert"),
            ...ENTRY_KEYS.map(([key, action]) => rawKeyHint(`shift+${key.toLowerCase()}` as never, actionLabel(action, entry.snippet))),
          ]
        : []),
      rawKeyHint(`shift+${NEW_KEY.toLowerCase()}` as never, "new"),
      rawKeyHint(["tab", "shift+tab"], "filter"),
      rawKeyHint("escape", this.#query ? "clear search" : "close"),
    ];
  }

  render(width: number): readonly string[] {
    const visible = this.#visible();
    const { entry } = this.#current(visible);
    // Sidebar width and the terminal-height floor match the adr console.
    const sidebarWidth = Math.max(18, Math.min(52, Math.floor(width * 0.36)));
    const height = Math.max(12, this.tui.terminal?.rows || process.stdout.rows || 40);
    return this.#frame.render(width, height, {
      title: this.#title(),
      header: this.#header(Math.max(1, width - 4)),
      sidebarWidth,
      sidebar: (rows) => this.#sidebar(sidebarWidth, rows, visible),
      body: (bodyWidth) => this.#body(bodyWidth, entry),
      message: this.#message ?? this.#notice,
      hints: this.#hints(entry),
    });
  }

  /** In Tern the console is a large glass sheet titled like the terminal frame. */
  get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
    const title = this.#title();
    if (this.#nativeHead?.title !== title)
      this.#nativeHead = { title, props: { role: "omp.overlay.snippets.console", size: "lg", anchor: "center", head: title } };
    return this.#nativeHead.props;
  }

  /** Filter tabs, search and New; the snippet list beside the preview; its actions, the messages and key hints. */
  describe(): NativeNode {
    const visible = this.#visible();
    const { entry } = this.#current(visible);
    const sig = [this.#filter ?? "", this.#query, entry?.snippet.id ?? "", this.#scroll?.n ?? 0].join("\n");
    if (this.#native?.sig === sig && this.#native.message === this.#message) return this.#native.node;

    const tabs = node(
      "tabs",
      {
        items: FILTERS.map((scope) => ({ id: scope ?? "all", label: `${scope ? capitalize(scope) : "All"} ${this.#count(scope)}` })),
        active: this.#filter ?? "all",
      },
      undefined,
      "filter",
    );
    const search = text(this.#query ? [span("Search ", "muted"), span(this.#query, "strong")] : [span("Type to search", "dim")], {
      role: "omp.snippets.search",
      grow: 1,
      truncate: "end",
      lines: 1,
    });
    const tools = actionBar(
      [actionButton("New snippet", "new", { keys: `shift+${NEW_KEY.toLowerCase()}` as never }), escCloseButton()],
      "tools",
    );
    const list = selectList(
      "snippets",
      visible.map(({ snippet }) => {
        // Items are one line that truncates: state rides on the toned icon, the facts in the tooltip.
        const mark = nativeMark(snippet);
        const facts = [
          snippet.scope,
          snippet.pinned ? "pinned" : "",
          snippet.enabled ? "" : "disabled",
          snippet.shadowed ? "shadowed" : "",
        ];
        return item(snippet.id, {
          label: snippet.key,
          detail: rowDetail(snippet),
          icon: mark.icon,
          ...(mark.tone ? { tone: mark.tone } : {}),
          title: `${snippet.key} · ${facts.filter(Boolean).join(", ")} · ${snippet.uses} uses`,
        });
      }),
      {
        selected: entry?.snippet.id ?? null,
        empty: this.entries.length
          ? "No snippets match; Esc clears the search, a tab changes the filter"
          : "No snippets yet; choose New snippet to create one",
        role: "omp.snippets.list",
      },
    );
    const body: NativeNode = {
      ...node("col", { role: "omp.snippets.body", grow: 1, gap: "sm" }, [this.#describeBody(entry)], "body"),
      ...(this.#scroll ? { scroll: this.#scroll } : {}),
    };
    const sidebar = node("col", { max: { w: "32ch" }, shrink: 0 }, [list], "sidebar");
    const children: NativeChild[] = [
      keyed(nativeRow([tabs, search, tools], { gap: "md", align: "center", wrap: true }), "head"),
      keyed(nativeRow([sidebar, body], { gap: "lg", align: "start" }), "split"),
    ];
    if (entry)
      children.push(
        actionBar(
          [
            actionButton("Insert", "insert", { keys: "enter", tone: "accent" }),
            ...ENTRY_KEYS.map(([key, action]) =>
              actionButton(capitalize(actionLabel(action, entry.snippet)), action, { keys: `shift+${key.toLowerCase()}` as never }),
            ),
          ],
          "actions",
        ),
      );
    const message = this.#message;
    for (const [line, key] of [
      [message, "message"],
      [this.#notice, "notice"],
    ] as const)
      if (line) children.push(keyed(text(line.text, { tone: messageColor(line.level), wrap: "word" }), key));
    children.push(CONSOLE_HINTS);
    const described = col(children, { gap: "md" });
    this.#native = { sig, message, node: described };
    return described;
  }

  /** The snippet as the terminal frame shows it: key and description, its facts, then the body verbatim. */
  #describeBody(entry: ConsoleEntry | undefined): NativeNode {
    if (!entry) return text([span("No snippet selected", "dim")]);
    const { snippet } = entry;
    const cached = this.#nativeBodies.get(snippet.id);
    if (cached) return cached;
    const children: NativeNode[] = [
      text([span(snippet.key, "strong accent"), ...(snippet.description ? [span(`  ${snippet.description}`, "muted")] : [])], {
        wrap: "word",
      }),
    ];
    const meta = kv(snippetFields(entry, this.entries));
    if (meta) children.push(meta);
    children.push(snippet.body ? code(snippet.body) : text([span("(empty body)", "dim")]));
    const described = col(children, { gap: "sm" });
    this.#nativeBodies.set(snippet.id, described);
    return described;
  }

  /** Clicks run the key paths: tabs filter, list rows select (double-click inserts), buttons act like their keys. */
  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action") {
      const action = ENTRY_KEYS.find(([, candidate]) => candidate === event.act)?.[1];
      if (event.act !== "close" && event.act !== "insert" && event.act !== "new" && !action) return;
      this.#message = undefined;
      if (event.act === "close") this.#escape();
      else if (event.act === "insert") this.#enter();
      else if (event.act === "new") this.#finish({ kind: "new" });
      else if (action) this.#act(action);
    } else if (event.type === "select" || event.type === "activate") {
      const leaf = leafKey(event.key);
      if (leaf === "filter") {
        const index = FILTERS.findIndex((scope) => (scope ?? "all") === event.item);
        if (index < 0) return;
        this.#message = undefined;
        this.#filter = FILTERS[index];
        this.#frame.scroll = 0;
      } else if (leaf === "snippets") {
        const index = this.#visible().findIndex((candidate) => candidate.snippet.id === event.item);
        if (index < 0) return;
        this.#message = undefined;
        this.#select(index);
        if (event.type === "activate") this.#enter();
      } else return;
    } else return;
    this.tui.requestRender();
  }
}
