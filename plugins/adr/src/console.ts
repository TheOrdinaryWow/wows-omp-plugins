import {
  type Component,
  code,
  col,
  extractPrintableText,
  getMarkdownTheme,
  item,
  keyed,
  kv,
  Markdown,
  matchesKey,
  md,
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
import { actionBar, actionButton, escCloseButton, hintsRow, itemIndex, selectList } from "@oh-my-pi/pi-tui/native/overlay";

import { type AdrRecord, type AdrStatus, STATUSES } from "#src/documents.ts";

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

const PLUGIN = "ADR";
/** Rows per wheel notch, as in the host's fullscreen plan review. */
const WHEEL_ROWS = 3;

type StatusStyle = { glyph: (theme: Theme) => string; color: "warning" | "success" | "error" | "muted" | "dim" };
const STATUS_STYLE: Record<AdrStatus, StatusStyle> = {
  proposed: { glyph: (t) => t.status.pending, color: "warning" },
  accepted: { glyph: (t) => t.status.success, color: "success" },
  rejected: { glyph: (t) => t.status.error, color: "error" },
  deprecated: { glyph: (t) => t.status.disabled, color: "muted" },
  superseded: { glyph: (t) => t.status.shadowed, color: "dim" },
};

/** Preset glyphs differ in cell width (unicode ✔ vs ⏳, ascii [ok] vs [*]); pad them to one column. */
function statusMarks(theme: Theme): Record<AdrStatus, string> {
  const raw = STATUSES.map((status) => theme.fg(STATUS_STYLE[status].color, STATUS_STYLE[status].glyph(theme)));
  const width = Math.max(1, ...raw.map((mark) => visibleWidth(mark)));
  return Object.fromEntries(
    STATUSES.map((status, index) => [status, (raw[index] ?? "") + padding(width - visibleWidth(raw[index] ?? ""))]),
  ) as Record<AdrStatus, string>;
}

/** Native tone and icon per status, the same meaning the terminal colors and glyphs carry. */
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

/** Natively the terminal scrolls the body; PgUp/PgDn still reach the program, which forwards them as a scroll request. */
type BodyScroll = { by: "page-up" | "page-down"; n: number };

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

/** Fixed footer hints of the native views; buttons carry the per-decision keys. */
const CONSOLE_HINTS = hintsRow([
  { keys: ["up", "down"], label: "select" },
  { keys: ["pageUp", "pageDown"], label: "scroll" },
  { keys: ["tab", "shift+tab"], label: "filter" },
  { keys: ["escape"], label: "clear search / close" },
]);
const PREVIEW_HINTS = hintsRow([
  { keys: ["up", "down"], label: "select" },
  { keys: ["pageUp", "pageDown"], label: "scroll" },
  { keys: ["enter"], label: "choose" },
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

/** Sidebar column width shared by the console and the preview, as in Atlas. */
function sidebarWidthFor(width: number): number {
  return Math.max(18, Math.min(52, Math.floor(width * 0.36)));
}

/** Scrollable split-pane frame both components draw: title, header, sidebar|body, message, hints. */
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
    const message = parts.message ? t.fg(parts.message.level === "error" ? "error" : "warning", parts.message.text) : "";
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

function terminalRows(tui: TUI): number {
  return Math.max(12, tui.terminal?.rows || process.stdout.rows || 40);
}

/** The pressed uppercase letter for `A` or Shift+a (legacy or Kitty encoding); undefined otherwise. */
function shiftLetter(key: string): string | undefined {
  const text = extractPrintableText(key);
  if (text && /^[A-Z]$/.test(text)) return text;
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (matchesKey(key, `shift+${letter.toLowerCase()}` as never)) return letter;
  return undefined;
}

/** Fullscreen `/adr` console: status filters, a searchable ADR sidebar, and the selected decision's full text. */
export class AdrConsole implements Component {
  readonly #frame: SplitFrame;
  readonly #marks: Record<AdrStatus, string>;
  readonly #markdown = new Map<string, Markdown>();
  #filter: AdrStatus | undefined;
  #query: string;
  #selectedId: string | undefined;
  #message: ConsoleMessage | undefined;
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
    message?: ConsoleMessage,
  ) {
    this.#frame = new SplitFrame(theme);
    this.#marks = statusMarks(theme);
    this.#filter = state.filter && entries.some((entry) => entry.record.status === state.filter) ? state.filter : undefined;
    this.#query = state.query;
    this.#selectedId = state.selectedId;
    this.#message = message;
  }

  #filters(): Array<AdrStatus | undefined> {
    return [undefined, ...STATUSES.filter((status) => this.entries.some((entry) => entry.record.status === status))];
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
    this.#frame.scroll = 0;
  }

  #state(): ConsoleState {
    return { filter: this.#filter, query: this.#query, selectedId: this.#current().entry?.record.id ?? this.#selectedId };
  }

  #finish(result: ConsoleResult): void {
    this.done(result, this.#state());
  }

  #cycle(delta: 1 | -1): void {
    const filters = this.#filters();
    const index = filters.indexOf(this.#filter);
    this.#filter = filters[(index + delta + filters.length) % filters.length];
    this.#frame.scroll = 0;
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
      this.#message = {
        text: `${action[0]?.toUpperCase()}${action.slice(1)} is not available for ${entry.record.id} (${entry.record.status})`,
        level: "error",
      };
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

  #page(by: BodyScroll["by"]): void {
    this.#frame.scrollBy(by === "page-down" ? this.#frame.pageRows() : -this.#frame.pageRows());
    this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
  }

  handleInput(key: string): void {
    // Checked before anything else: pointer motion must not clear the notice or act as a key.
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
    const global = GLOBAL_KEYS.find(([key]) => key === letter);
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
    else if (global) this.#finish({ kind: "action", action: global[1] });
    else if (letter) this.#decision(letter);
    else if (matchesKey(key, "backspace")) {
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

  #header(width: number): string {
    const t = this.theme;
    const filters = this.#filters();
    const count = (status: AdrStatus | undefined) =>
      status ? this.entries.filter((entry) => entry.record.status === status).length : this.entries.length;
    const search = this.#query ? `Search: ${this.#query}` : t.fg("dim", "Type to search");
    const track = (short: boolean) =>
      renderSegmentTrack(
        filters.map((status) => {
          const label = status ? `${status[0]?.toUpperCase()}${status.slice(1)}` : "All";
          return { label: `${short ? label.slice(0, 3) : label} ${count(status)}` };
        }),
        filters.indexOf(this.#filter),
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
          this.entries.length ? "No ADRs match; Esc clears the search, Tab changes the filter" : "No ADRs yet; press Shift+O to start one",
        ),
        width,
      );
    const { index: selected } = this.#current(visible);
    const idWidth = Math.max(0, ...visible.map((entry) => entry.record.id.length));
    const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), visible.length - rows));
    return visible.slice(start, start + rows).map((entry, offset) => {
      const isSelected = start + offset === selected;
      const cursor = isSelected ? t.fg("accent", `${t.nav.cursor} `) : "  ";
      const prefix = `${cursor}${this.#marks[entry.record.status]} ${t.fg("muted", entry.record.id.padEnd(idWidth))} `;
      const title = truncateToWidth(entry.record.title, Math.max(1, width - visibleWidth(prefix)));
      return truncateToWidth(`${prefix}${t.fg(isSelected ? "accent" : "text", title)}`, width);
    });
  }

  #body(width: number, entry: ConsoleEntry | undefined): string[] {
    const t = this.theme;
    if (!entry) return [t.fg("dim", "No ADR selected")];
    const { record } = entry;
    const lines: string[] = [];
    lines.push(...wrapTextWithAnsi(t.bold(t.fg("accent", `${record.id}  ${record.title}`)), width));
    const where = [
      record.date,
      record.stage ? `stage ${record.stage}` : "",
      record.superseded_by ? `superseded by ${record.superseded_by}` : "",
    ];
    lines.push(
      ...wrapTextWithAnsi(
        `${this.#marks[record.status]} ${t.fg(STATUS_STYLE[record.status].color, record.status)}  ${t.fg("dim", where.filter(Boolean).join(" · "))}`,
        width,
      ),
      "",
    );
    const { fields, body } = detailParts(entry.detail);
    const labelWidth = Math.max(0, ...fields.map(([label]) => label.length)) + 2;
    for (const [label, value] of fields) {
      if (width < labelWidth + 20) {
        lines.push(...wrapTextWithAnsi(`${t.fg("muted", label ? `${label}: ` : "")}${value}`, width));
        continue;
      }
      const wrapped = wrapTextWithAnsi(value, width - labelWidth);
      for (const [index, line] of wrapped.entries())
        lines.push(`${index ? padding(labelWidth) : t.fg("muted", label.padEnd(labelWidth))}${line}`);
    }
    if (body.trim()) {
      lines.push("");
      let markdown = this.#markdown.get(record.id);
      if (!markdown) {
        markdown = new Markdown(body, 0, 0, getMarkdownTheme());
        this.#markdown.set(record.id, markdown);
      }
      lines.push(...markdown.render(width));
    }
    return lines;
  }

  #hints(entry: ConsoleEntry | undefined): string[] {
    const offered = entry?.offered ?? [];
    return [
      rawKeyHint(["up", "down"], "select"),
      this.theme.fg("dim", "PgUp/PgDn/wheel") + this.theme.fg("muted", " scroll"),
      ...(entry ? [rawKeyHint("enter", "decide")] : []),
      ...DECISION_KEYS.filter(([, action]) => offered.includes(action)).map(([key, action]) =>
        rawKeyHint(`shift+${key.toLowerCase()}` as never, action),
      ),
      ...GLOBAL_KEYS.map(([key, , label]) => rawKeyHint(`shift+${key.toLowerCase()}` as never, label)),
      rawKeyHint(["tab", "shift+tab"], "filter"),
      rawKeyHint("escape", this.#query ? "clear search" : "close"),
    ];
  }

  #summary(): string {
    const records = this.entries.map((entry) => entry.record);
    const summary = STATUSES.map((status) => [status, records.filter((record) => record.status === status).length] as const)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ");
    return summary || "no ADRs yet";
  }

  render(width: number): readonly string[] {
    const visible = this.#visible();
    const { entry } = this.#current(visible);
    const sidebarWidth = sidebarWidthFor(width);
    return this.#frame.render(width, terminalRows(this.tui), {
      title: `${PLUGIN} · ${this.#summary()}`,
      header: this.#header(Math.max(1, width - 4)),
      sidebarWidth,
      sidebar: (rows) => this.#sidebar(sidebarWidth, rows, visible),
      body: (bodyWidth) => this.#body(bodyWidth, entry),
      message: this.#message,
      hints: this.#hints(entry),
    });
  }

  /** In Tern the console is a large glass sheet titled like the terminal frame. */
  get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
    const title = `${PLUGIN} · ${this.#summary()}`;
    if (this.#nativeHead?.title !== title)
      this.#nativeHead = { title, props: { role: "omp.overlay.adr.console", size: "lg", anchor: "center", head: title } };
    return this.#nativeHead.props;
  }

  /** Filter tabs, search and tools; the ADR list beside the selected decision; its actions, the message and key hints. */
  describe(): NativeNode {
    const visible = this.#visible();
    const { entry } = this.#current(visible);
    const sig = [this.#filter ?? "", this.#query, entry?.record.id ?? "", this.#scroll?.n ?? 0].join("\n");
    if (this.#native?.sig === sig && this.#native.message === this.#message) return this.#native.node;

    const filters = this.#filters();
    const count = (status: AdrStatus | undefined) =>
      status ? this.entries.filter((candidate) => candidate.record.status === status).length : this.entries.length;
    const tabs = node(
      "tabs",
      {
        items: filters.map((status) => ({ id: status ?? "all", label: `${status ? capitalize(status) : "All"} ${count(status)}` })),
        active: this.#filter ?? "all",
      },
      undefined,
      "filter",
    );
    const search = text(this.#query ? [span("Search ", "muted"), span(this.#query, "strong")] : [span("Type to search", "dim")], {
      role: "omp.adr.search",
      grow: 1,
      truncate: "end",
      lines: 1,
    });
    const tools = actionBar(
      [
        ...GLOBAL_KEYS.map(([key, action, label]) =>
          actionButton(capitalize(label), action, { keys: `shift+${key.toLowerCase()}` as never }),
        ),
        escCloseButton(),
      ],
      "tools",
    );
    const list = selectList(
      "adrs",
      visible.map(({ record }) =>
        // Items are one line that truncates, so the status rides on the toned icon and the id in the tooltip.
        item(record.id, {
          label: record.title,
          icon: STATUS_ICON[record.status],
          tone: STATUS_TONE[record.status],
          title: `${record.id} · ${record.status}`,
        }),
      ),
      {
        selected: entry?.record.id ?? null,
        empty: this.entries.length
          ? "No ADRs match; Esc clears the search, a tab changes the filter"
          : "No ADRs yet; choose New decision to start one",
        role: "omp.adr.list",
      },
    );
    const body: NativeNode = {
      ...node("col", { role: "omp.adr.body", grow: 1, gap: "sm" }, [this.#describeBody(entry)], "body"),
      ...(this.#scroll ? { scroll: this.#scroll } : {}),
    };
    const sidebar = node("col", { max: { w: "32ch" }, shrink: 0 }, [list], "sidebar");
    const decisions = entry
      ? actionBar(
          [
            actionButton("Decide…", "decide", { keys: "enter", tone: "accent" }),
            ...DECISION_KEYS.filter(([, action]) => entry.offered.includes(action)).map(([key, action]) =>
              actionButton(capitalize(action), action, { keys: `shift+${key.toLowerCase()}` as never }),
            ),
          ],
          "decisions",
        )
      : undefined;
    const message = this.#message;
    const children: NativeChild[] = [
      keyed(nativeRow([tabs, search, tools], { gap: "md", align: "center", wrap: true }), "head"),
      keyed(nativeRow([sidebar, body], { gap: "lg", align: "start" }), "split"),
    ];
    if (decisions) children.push(decisions);
    if (message)
      children.push(keyed(text(message.text, { tone: message.level === "error" ? "error" : "warning", wrap: "word" }), "message"));
    children.push(CONSOLE_HINTS);
    const described = col(children, { gap: "md" });
    this.#native = { sig, message, node: described };
    return described;
  }

  /** The decision as the terminal frame shows it: id and title, status and dates, metadata, then the MADR body. */
  #describeBody(entry: ConsoleEntry | undefined): NativeNode {
    if (!entry) return text([span("No ADR selected", "dim")]);
    const { record } = entry;
    const cached = this.#nativeBodies.get(record.id);
    if (cached) return cached;
    const { fields, body } = detailParts(entry.detail);
    const where = [
      record.date,
      record.stage ? `stage ${record.stage}` : "",
      record.superseded_by ? `superseded by ${record.superseded_by}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const children: NativeNode[] = [
      text([span(`${record.id}  `, "muted"), span(record.title, "strong accent")], { wrap: "word" }),
      text([span(record.status, STATUS_TONE[record.status]), ...(where ? [span(`  ${where}`, "dim")] : [])]),
    ];
    const meta = kv(fields);
    if (meta) children.push(meta);
    if (body.trim()) children.push(md(body));
    const described = col(children, { gap: "sm" });
    this.#nativeBodies.set(record.id, described);
    return described;
  }

  /** Clicks run the key paths: tabs filter, list rows select (double-click decides), buttons act like their keys. */
  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action") {
      const global = GLOBAL_KEYS.find(([, action]) => action === event.act);
      const decision = DECISION_KEYS.find(([, action]) => action === event.act);
      if (event.act !== "close" && event.act !== "decide" && !global && !decision) return;
      this.#message = undefined;
      if (event.act === "close") this.#escape();
      else if (event.act === "decide") this.#enter();
      else if (global) this.#finish({ kind: "action", action: global[1] });
      else if (decision) this.#decision(decision[0]);
    } else if (event.type === "select" || event.type === "activate") {
      const leaf = leafKey(event.key);
      if (leaf === "filter") {
        const filters = this.#filters();
        const index = filters.findIndex((status) => (status ?? "all") === event.item);
        if (index < 0) return;
        this.#message = undefined;
        this.#filter = filters[index];
        this.#frame.scroll = 0;
      } else if (leaf === "adrs") {
        const index = this.#visible().findIndex((candidate) => candidate.record.id === event.item);
        if (index < 0) return;
        this.#message = undefined;
        this.#select(index);
        if (event.type === "activate") this.#enter();
      } else return;
    } else return;
    this.tui.requestRender();
  }
}

export interface PreviewItem {
  path: string;
  content: string;
}

/** Fullscreen write preview: actions and files on the left, the selected file on the right. Resolves true to write. */
export class AdrPreview implements Component {
  readonly #frame: SplitFrame;
  readonly #markdown = new Map<number, Markdown>();
  /** Row 0 writes, rows 1..n are files, the last row cancels. */
  #selected: number;
  #message: ConsoleMessage | undefined;
  #scroll: BodyScroll | undefined;
  #native: { selected: number; message: ConsoleMessage | undefined; scroll: number; node: NativeNode } | undefined;
  readonly #nativeBodies = new Map<number, NativeNode>();
  /** In Tern the preview is a large glass sheet titled like the terminal frame. */
  readonly nativeOverlay: NonNullable<Component["nativeOverlay"]> = {
    role: "omp.overlay.adr.preview",
    size: "lg",
    anchor: "center",
    head: `${PLUGIN} · write preview`,
  };

  constructor(
    readonly title: string,
    readonly files: readonly PreviewItem[],
    readonly theme: Theme,
    readonly tui: TUI,
    readonly done: (write: boolean) => void,
  ) {
    this.#frame = new SplitFrame(theme);
    this.#selected = files.length ? 1 : 0;
  }

  /** Row 0 writes, rows 1..n are files, this last row cancels. */
  get #cancelRow(): number {
    return this.files.length + 1;
  }

  #select(index: number): void {
    const next = Math.max(0, Math.min(this.#cancelRow, index));
    if (next === this.#selected) return;
    this.#selected = next;
    this.#frame.scroll = 0;
  }

  #enter(): void {
    if (this.#selected === 0) this.done(true);
    else if (this.#selected === this.#cancelRow) this.done(false);
    else this.#message = { text: "Press Shift+W to write every file, or Esc to cancel", level: "info" };
  }

  #page(by: BodyScroll["by"]): void {
    this.#frame.scrollBy(by === "page-down" ? this.#frame.pageRows() : -this.#frame.pageRows());
    this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
  }

  handleInput(key: string): void {
    if (
      routeSgrMouseInput(key, (event) => {
        this.#frame.mouse(event, (delta) => this.#select(this.#selected + delta));
        return true;
      })
    ) {
      this.tui.requestRender();
      return;
    }
    this.#message = undefined;
    if (matchesKey(key, "escape")) this.done(false);
    else if (shiftLetter(key) === "W") this.done(true);
    else if (matchesKey(key, "up")) this.#select(this.#selected - 1);
    else if (matchesKey(key, "down")) this.#select(this.#selected + 1);
    else if (matchesKey(key, "home")) this.#select(0);
    else if (matchesKey(key, "end")) this.#select(this.#cancelRow);
    else if (matchesKey(key, "pageDown")) this.#page("page-down");
    else if (matchesKey(key, "pageUp")) this.#page("page-up");
    else if (matchesKey(key, "enter")) this.#enter();
    this.tui.requestRender();
  }

  #sidebar(width: number, rows: number): string[] {
    const t = this.theme;
    const labels = [
      t.fg("success", `${t.status.success} Write ${this.files.length} file${this.files.length === 1 ? "" : "s"}`),
      ...this.files.map((file) => file.path),
      t.fg("error", `${t.status.error} Cancel`),
    ];
    const start = Math.max(0, Math.min(this.#selected - Math.floor(rows / 2), labels.length - rows));
    return labels.slice(start, start + rows).map((label, offset) => {
      const selected = start + offset === this.#selected;
      const cursor = selected ? t.fg("accent", `${t.nav.cursor} `) : "  ";
      const isFile = start + offset > 0 && start + offset <= this.files.length;
      return truncateToWidth(`${cursor}${isFile ? t.fg(selected ? "accent" : "text", label) : label}`, width);
    });
  }

  #body(width: number): string[] {
    const t = this.theme;
    const file = this.files[this.#selected - 1];
    if (!file) {
      const lines = wrapTextWithAnsi(t.bold(this.title), width);
      lines.push("", ...wrapTextWithAnsi(t.fg("muted", "Files to write:"), width));
      for (const entry of this.files) lines.push(...wrapTextWithAnsi(`  ${entry.path}`, width));
      lines.push(
        "",
        ...wrapTextWithAnsi(t.fg("dim", "Nothing is written until you choose Write. Select a file to read it before deciding."), width),
      );
      return lines;
    }
    const lines = [truncateToWidth(t.bold(t.fg("accent", file.path)), width), ""];
    if (/\.md$/i.test(file.path)) {
      // YAML front matter is not Markdown: show it verbatim, then render the document after it.
      const front = /^---\n[\s\S]*?\n---\n/.exec(file.content)?.[0] ?? "";
      for (const line of front.trimEnd().split("\n").filter(Boolean)) lines.push(...wrapTextWithAnsi(t.fg("muted", line), width));
      let markdown = this.#markdown.get(this.#selected);
      if (!markdown) {
        markdown = new Markdown(file.content.slice(front.length), 0, 0, getMarkdownTheme());
        this.#markdown.set(this.#selected, markdown);
      }
      lines.push(...markdown.render(width));
    } else {
      for (const line of file.content.replace(/\n$/, "").split("\n")) lines.push(...wrapTextWithAnsi(line, width));
    }
    return lines;
  }

  render(width: number): readonly string[] {
    const sidebarWidth = sidebarWidthFor(width);
    return this.#frame.render(width, terminalRows(this.tui), {
      title: `${PLUGIN} · write preview`,
      header: this.title,
      sidebarWidth,
      sidebar: (rows) => this.#sidebar(sidebarWidth, rows),
      body: (bodyWidth) => this.#body(bodyWidth),
      message: this.#message,
      hints: [
        rawKeyHint(["up", "down"], "select"),
        this.theme.fg("dim", "PgUp/PgDn/wheel") + this.theme.fg("muted", " scroll"),
        rawKeyHint("enter", "choose"),
        rawKeyHint("shift+w", "write all"),
        rawKeyHint("escape", "cancel"),
      ],
    });
  }

  /** Write, the files and Cancel as a list beside the selected file; buttons for Write all and Cancel, then the hints. */
  describe(): NativeNode {
    const scroll = this.#scroll?.n ?? 0;
    const memo = this.#native;
    if (memo?.selected === this.#selected && memo.message === this.#message && memo.scroll === scroll) return memo.node;
    const count = `${this.files.length} file${this.files.length === 1 ? "" : "s"}`;
    const rows = selectList(
      "rows",
      [
        item("r0", { label: `Write ${count}`, icon: "save", tone: "success" }),
        // The file name first: a long path would truncate it away; the directory follows dim and gives way first.
        ...this.files.map((file, index) => {
          const slash = file.path.lastIndexOf("/");
          return item(`r${index + 1}`, {
            label: [span(file.path.slice(slash + 1), "path")],
            detail: slash > 0 ? file.path.slice(0, slash) : undefined,
            icon: /\.md$/i.test(file.path) ? "markdown" : "file",
            title: file.path,
          });
        }),
        item(`r${this.#cancelRow}`, { label: "Cancel", icon: "x", tone: "error" }),
      ],
      { selected: `r${this.#selected}`, role: "omp.adr.preview.rows" },
    );
    const body: NativeNode = {
      ...node("col", { role: "omp.adr.preview.body", grow: 1, gap: "sm" }, [this.#describeBody()], "body"),
      ...(this.#scroll ? { scroll: this.#scroll } : {}),
    };
    const children: NativeChild[] = [
      keyed(text([span(this.title, "strong")], { wrap: "word" }), "title"),
      keyed(nativeRow([node("col", { max: { w: "32ch" }, shrink: 0 }, [rows], "sidebar"), body], { gap: "lg", align: "start" }), "split"),
      actionBar([
        actionButton(`Write ${count}`, "write", { keys: "shift+w", tone: "accent" }),
        actionButton("Cancel", "cancel", { keys: "escape" }),
      ]),
    ];
    const message = this.#message;
    if (message)
      children.push(keyed(text(message.text, { tone: message.level === "error" ? "error" : "warning", wrap: "word" }), "message"));
    children.push(PREVIEW_HINTS);
    const described = col(children, { gap: "md" });
    this.#native = { selected: this.#selected, message, scroll, node: described };
    return described;
  }

  /** The selected file (Markdown rendered, front matter as YAML, anything else as code), or the summary on Write and Cancel. */
  #describeBody(): NativeNode {
    const file = this.files[this.#selected - 1];
    const index = file ? this.#selected : 0;
    const cached = this.#nativeBodies.get(index);
    if (cached) return cached;
    let described: NativeNode;
    if (!file) {
      described = col(
        [
          text([span("Files to write:", "muted")]),
          ...this.files.map((entry) => text([span(entry.path, "path")])),
          text([span("Nothing is written until you choose Write. Select a file to read it before deciding.", "dim")], { wrap: "word" }),
        ],
        { gap: "sm" },
      );
    } else if (/\.md$/i.test(file.path)) {
      const front = /^---\n[\s\S]*?\n---\n/.exec(file.content)?.[0] ?? "";
      const yaml = front.slice(4, -4).trim();
      described = col(
        [text([span(file.path, "path strong")]), ...(yaml ? [code(yaml, { lang: "yaml" })] : []), md(file.content.slice(front.length))],
        { gap: "sm" },
      );
    } else {
      described = col([text([span(file.path, "path strong")]), code(file.content.replace(/\n$/, ""), { path: file.path })], { gap: "sm" });
    }
    this.#nativeBodies.set(index, described);
    return described;
  }

  /** Clicks run the key paths: a row selects (double-click chooses it like Enter), the buttons write or cancel. */
  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action") {
      if (event.act === "write") this.done(true);
      else if (event.act === "cancel") this.done(false);
      return;
    }
    if ((event.type !== "select" && event.type !== "activate") || leafKey(event.key) !== "rows") return;
    const index = itemIndex(event.item, "r");
    if (index < 0 || index > this.#cancelRow) return;
    this.#message = undefined;
    this.#select(index);
    if (event.type === "activate") this.#enter();
    this.tui.requestRender();
  }
}
