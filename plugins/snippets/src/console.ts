import {
  type Component,
  col,
  type DescribeContext,
  extractPrintableText,
  Input,
  item,
  keyed,
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
import { CLOSE_ACTION, picker, pickerAction, pickerEvent, pickerHits } from "@oh-my-pi/pi-tui/native/picker";
import type { TspPickerAction, TspPickerItem, TspSpan } from "@oh-my-pi/pi-wire";

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

/** Search words, lowercase: the list keeps snippets containing every one, and the picker marks them in the keys. */
function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

type Tone = "accent" | "muted" | undefined;

/** Pinned snippets show the pin, the rest their scope: a globe for global, a document for workspace. */
function snippetIcon(snippet: SnippetEntry): string {
  if (snippet.pinned) return "pin";
  return snippet.scope === "global" ? "globe" : "doc";
}

/** Native icon and tone of a generic list row: disabled and shadowed win over the scope icon. */
function nativeMark(snippet: SnippetEntry): { icon: string; tone: Tone } {
  if (snippet.shadowed) return { icon: "eye-off", tone: "muted" };
  if (!snippet.enabled) return { icon: "minus", tone: "muted" };
  return { icon: snippetIcon(snippet), tone: snippet.pinned ? "accent" : undefined };
}

/** A picker row: the key, the description beside it, state as tone and badges, the facts in the tooltip. */
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

/**
 * The selected snippet natively: key and description, a compact facts line, the body as plain wrapped text (it is
 * what the shortcut sends, so no Markdown or code block), then the path, truncated in the middle.
 */
function snippetPreview(entry: ConsoleEntry, all: readonly ConsoleEntry[]): NativeNode {
  const { snippet, trigger } = entry;
  const fields = new Map(snippetFields(entry, all));
  const separator = span(" · ", "dim");
  const facts: TspSpan[] = [
    trigger ? span(trigger, "code") : span("menu only", "muted"),
    separator,
    span(fields.get("Scope") ?? snippet.scope),
    separator,
    span(`${snippet.uses} ${snippet.uses === 1 ? "use" : "uses"}`),
    separator,
    span(fields.get("State") ?? "", snippet.enabled && !snippet.shadowed ? undefined : "muted"),
  ];
  return col(
    [
      text([span(snippet.key, "strong accent"), ...(snippet.description ? [span(`  ${snippet.description}`, "muted")] : [])], {
        wrap: "word",
      }),
      text(facts, { wrap: "word" }),
      snippet.body ? text(snippet.body, { wrap: "word", role: "omp.snippets.body" }) : text([span("(empty body)", "dim")]),
      text([span(snippet.path, "path dim")], { truncate: "middle", lines: 1 }),
    ],
    { gap: "sm" },
  );
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

/** Fullscreen `/snippets` console: scope filters, a searchable snippet sidebar, and the selected snippet's preview. */
export class SnippetConsole implements Component {
  readonly #frame: SplitFrame;
  readonly #marks: MarkSlots;
  #filter: SnippetScope | undefined;
  /** The search field: typing, motion, deletion and paste edit it; its caret is the picker's. */
  readonly #search = new Input();
  #selectedId: string | undefined;
  #message: ConsoleMessage | undefined;
  readonly #notice: ConsoleMessage | undefined;
  #scroll: BodyScroll | undefined;
  #nativeHead: { title: string; props: NonNullable<Component["nativeOverlay"]> } | undefined;
  #native: { sig: string; message: ConsoleMessage | undefined; node: NativeNode } | undefined;
  #picker: { sig: string; message: ConsoleMessage | undefined; node: NativeNode } | undefined;
  #pickerItems: TspPickerItem[] | undefined;
  readonly #previews = new Map<string, NativeNode>();

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
    this.#search.setValue(state.query);
    this.#selectedId = state.selectedId;
    this.#message = options.message;
    this.#notice = options.notice;
  }

  get #query(): string {
    return this.#search.getValue();
  }

  #count(scope: SnippetScope | undefined): number {
    return scope ? this.entries.filter((entry) => entry.snippet.scope === scope).length : this.entries.length;
  }

  #visible(): ConsoleEntry[] {
    const words = searchWords(this.#query);
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
    if (this.#query) this.#search.setValue("");
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

  /** One key into the search field; a changed query starts the preview at the top. */
  #edit(key: string): void {
    const before = this.#query;
    this.#search.handleInput(key);
    if (this.#query !== before) this.#frame.scroll = 0;
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
    // Uppercase letters without an action still search, so `API` finds `api`.
    else if (letter) this.#edit(letter);
    else {
      // Leading whitespace never starts a search; everything else (text, motion, deletion, paste) edits it.
      const typed = extractPrintableText(key);
      if (typed === undefined || this.#query || typed.trim()) this.#edit(key);
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

  /** Where Tern draws pickers the console is a picker sheet of its own, mounted without an overlay wrapper. */
  nativeSheet(cx: DescribeContext): boolean {
    return cx.supports("picker");
  }

  /** Without the picker kind the generic composition is a large glass sheet titled like the terminal frame. */
  get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
    const title = this.#title();
    if (this.#nativeHead?.title !== title)
      this.#nativeHead = { title, props: { role: "omp.overlay.snippets.console", size: "lg", anchor: "center", head: title } };
    return this.#nativeHead.props;
  }

  describe(cx?: DescribeContext): NativeNode {
    return cx?.supports("picker") ? this.#describePicker() : this.#describeGeneric();
  }

  /** The selected snippet's preview, built once per snippet: the entries never change while the console is open. */
  #preview(entry: ConsoleEntry): NativeNode {
    const id = entry.snippet.id;
    let preview = this.#previews.get(id);
    if (!preview) {
      preview = keyed(snippetPreview(entry, this.entries), `preview:${id}`);
      this.#previews.set(id, preview);
    }
    return preview;
  }

  /** The action bar: Insert and the per-snippet keys while one is selected, then New and Close (Clear search). */
  #pickerActions(entry: ConsoleEntry | undefined): TspPickerAction[] {
    const actions = entry
      ? [
          pickerAction("insert", "Insert", "enter", { primary: true }),
          ...ENTRY_KEYS.map(([key, action]) =>
            pickerAction(
              action,
              capitalize(actionLabel(action, entry.snippet)),
              `shift+${key.toLowerCase()}`,
              action === "delete" ? { danger: true } : undefined,
            ),
          ),
        ]
      : [];
    actions.push(pickerAction("new", "New", `shift+${NEW_KEY.toLowerCase()}`, entry ? undefined : { primary: true }));
    actions.push(this.#query ? { ...CLOSE_ACTION, label: "Clear search" } : CLOSE_ACTION);
    return actions;
  }

  /**
   * The picker sheet: the search field and scope tabs over the snippet rows, the selected snippet's preview below,
   * the result and problem line, and the action bar.
   */
  #describePicker(): NativeNode {
    const visible = this.#visible();
    const { entry } = this.#current(visible);
    const query = this.#query;
    const cursor = this.#search.getCursor();
    const sig = [this.#filter ?? "", query, cursor, entry?.snippet.id ?? ""].join("\n");
    if (this.#picker?.sig === sig && this.#picker.message === this.#message) return this.#picker.node;

    this.#pickerItems ??= this.entries.map(({ snippet }) => pickerItem(snippet));
    const words = searchWords(query);
    const hits: Record<string, [number, number][]> = {};
    for (const { snippet } of words.length ? visible : []) {
      const found = pickerHits(snippet.key, words);
      if (found.length) hits[snippet.id] = found;
    }
    const message = [this.#message, this.#notice]
      .filter((line): line is ConsoleMessage => line !== undefined)
      .flatMap((line, index): TspSpan[] => [...(index ? [span("  ·  ", "dim")] : []), span(line.text, messageColor(line.level))]);
    const described = picker(
      {
        title: PLUGIN,
        noun: "snippets",
        icon: "clipboard",
        size: "lg",
        layout: "rows",
        preview: "below",
        query,
        cursor,
        placeholder: "Search keys, descriptions and bodies…",
        tabs: FILTERS.map((scope) => ({ id: scope ?? "all", label: scope ? capitalize(scope) : "All", count: this.#count(scope) })),
        tab: this.#filter ?? "all",
        items: this.#pickerItems,
        order: visible.map(({ snippet }) => snippet.id),
        ...(words.length ? { hits } : {}),
        selected: entry?.snippet.id ?? null,
        total: this.entries.length,
        actions: this.#pickerActions(entry),
        // A ready picker draws `message` nowhere; the head's subtitle carries the result and problem line.
        ...(message.length ? { subtitle: message } : {}),
        empty: this.entries.length
          ? "No snippets match; Esc clears the search, a tab changes the filter"
          : "No snippets yet; choose New to create one",
      },
      entry ? [this.#preview(entry)] : undefined,
    );
    this.#picker = { sig, message: this.#message, node: described };
    return described;
  }

  /** Filter tabs, search and New; the snippet list beside the preview; its actions, the messages and key hints. */
  #describeGeneric(): NativeNode {
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
    // The body takes the rest of the row and may shrink below its content, so long lines wrap instead of clipping.
    const body: NativeNode = {
      ...node(
        "col",
        { role: "omp.snippets.body", grow: 1, shrink: 1, min: { w: 0 }, gap: "sm" },
        [entry ? this.#preview(entry) : text([span("No snippet selected", "dim")])],
        "body",
      ),
      ...(this.#scroll ? { scroll: this.#scroll } : {}),
    };
    // A fixed width: with only a maximum the sidebar follows its longest row and the body jumps between filters.
    const sidebar = node("col", { min: { w: "32ch" }, max: { w: "32ch" }, shrink: 0 }, [list], "sidebar");
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

  /**
   * A button's key path: Close is Esc, Insert is Enter, New and the per-snippet actions their Shift letters; the
   * picker's own Clear search (under "No snippets match") empties the field like the first Esc.
   */
  #run(act: string): boolean {
    const action = ENTRY_KEYS.find(([, candidate]) => candidate === act)?.[1];
    if (act !== "close" && act !== "clear" && act !== "insert" && act !== "new" && !action) return false;
    this.#message = undefined;
    if (act === "close") this.#escape();
    else if (act === "clear") this.#search.setValue("");
    else if (act === "insert") this.#enter();
    else if (act === "new") this.#finish({ kind: "new" });
    else if (action) this.#act(action);
    return true;
  }

  /** A scope tab, as if Tab or Shift+Tab had landed on it. */
  #filterTo(id: string | undefined): boolean {
    const index = FILTERS.findIndex((scope) => (scope ?? "all") === id);
    if (index < 0) return false;
    this.#message = undefined;
    this.#filter = FILTERS[index];
    this.#frame.scroll = 0;
    return true;
  }

  /** A row click selects like the arrows; a second click (activate) then inserts like Enter. */
  #pick(id: string, activate: boolean): boolean {
    const index = this.#visible().findIndex((candidate) => candidate.snippet.id === id);
    if (index < 0) return false;
    this.#message = undefined;
    this.#select(index);
    if (activate) this.#enter();
    return true;
  }

  /** Pointer events run the key paths, from the picker sheet (root keypath) and the generic composition alike. */
  handleNativeEvent(event: NativeUiEvent): void {
    const ev = pickerEvent(event);
    let handled = false;
    if (ev?.kind === "action") handled = ev.act === "tab" ? this.#filterTo(ev.value) : this.#run(ev.act);
    else if (ev) handled = this.#pick(ev.item, ev.kind === "activate");
    else if (event.type === "action") handled = this.#run(event.act);
    else if (event.type === "select" || event.type === "activate") {
      const leaf = leafKey(event.key);
      if (leaf === "filter") handled = this.#filterTo(event.item);
      else if (leaf === "snippets") handled = this.#pick(event.item, event.type === "activate");
    }
    if (handled) this.tui.requestRender();
  }
}
