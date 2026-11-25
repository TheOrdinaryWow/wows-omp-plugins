import { relative } from "node:path";

import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { type KeyEvent, nativeRendering, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";

import { type AtlasStagePlan, type StageCoverage, stageCoverage } from "#src/atlas.ts";
import { type Model, overdue, type RoundDoc, type StageDoc, type StageStatus, type TodoItem, today } from "#src/documents.ts";
import { planLabel } from "#src/handoff.ts";
import type { StageOrder } from "#src/settings.ts";
import { byId, orderStages, plannedRoundCounts, roundActual, schedule, stageReadiness } from "#src/state.ts";
import { h, kv, span } from "#src/tsp.ts";
import type { PreviewFile } from "#src/ui.ts";

export type ConsoleSection = "stages" | "rounds" | "todos";

/** Where the console stood when it closed, so a reopened console shows the same section, search and item. */
export interface ConsoleView {
  section: ConsoleSection;
  query: string;
  selected?: string;
  /** The round whose stages Stages lists when it is not the active round. */
  stageRound?: string;
}

/** The one-line result of the last action; `error` marks a refused or failed one. */
export interface ConsoleMessage {
  text: string;
  level: "info" | "error";
}

export interface ConsoleState {
  view?: ConsoleView;
  message?: ConsoleMessage;
  /** YYYY-MM-DD deciding which unfinished targets are overdue; defaults to today. */
  on?: string;
  /** How the Stages section and a round's stage list are ordered; defaults to dependency. Shift+O switches it. */
  order?: StageOrder;
}

/** What the console asks the command to do: the status menu's actions plus the typed planning actions it offers by key. */
export type ConsoleAction = "check" | "close" | "close-round" | "new-round" | "plan-round" | "drop-round" | "retarget" | "upgrade";

/** `stage` names the stage to close or retarget; `round` the round to revise, drop or retarget. */
export interface ConsoleChoice {
  action: ConsoleAction;
  stage?: string;
  round?: string;
  /** The view to restore when the console reopens. */
  view: ConsoleView;
}

/** A stage's Atlas plans as omo-prometheus answers them; undefined when nothing answered. */
export type StagePlans = (stage: string) => readonly AtlasStagePlan[] | undefined;

export interface PreviewRequest {
  title: string;
  root: string;
  files: PreviewFile[];
}

/** What a view reads from the host: the terminal size, reactively. */
export type ConsoleHost = Pick<ExtensionUiHost, "size">;

const SECTIONS: readonly ConsoleSection[] = ["stages", "rounds", "todos"];
const SECTION_LABELS: Readonly<Record<ConsoleSection, string>> = { stages: "Stages", rounds: "Rounds", todos: "Open TODOs" };

// Tern sizes lg sheets by content, so fix the root's line extent from terminal height; only a list with max scrolls.
const SHEET_MARGIN_LINES = 8;
const SHEET_MIN_LINES = 16;
const FILL = { grow: 1, shrink: 1, basis: 0, min: { h: 0 } } as const;
const SCROLLER = { ...FILL, max: { lines: 10_000 } } as const;

type Rich = string | readonly TspSpan[];

/** A keyed command the console offers: one key hint in the terminal, one button in Tern. */
interface Command {
  act: string;
  key: string;
  label: string;
  tone?: "accent" | "error";
}

/** One sidebar row. */
interface Row {
  label: TspSpan[];
  detail?: TspText;
  value?: TspText;
  tone?: TspTone;
  title?: string;
}

/** The selected item's detail: a heading and the groups below it. */
interface DetailView {
  key: string;
  heading: string;
  groups: UiNode[];
}

function spansOf(value: Rich): TspSpan[] {
  return typeof value === "string" ? [span(value)] : [...value];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function glyph(theme: Theme, key: string, style: string): TspSpan {
  return span(theme.symbols.symbol(key), style);
}

function statusSpan(theme: Theme, status: StageStatus): TspSpan {
  if (status === "closed") return glyph(theme, "status.success", "success");
  if (status === "active") return glyph(theme, "status.running", "accent");
  if (status === "dropped") return glyph(theme, "status.disabled", "muted");
  return glyph(theme, "status.pending", "dim");
}

function todoSpan(theme: Theme, item: TodoItem): TspSpan {
  if (item.severity === "high") return glyph(theme, "status.warning", "error");
  if (item.severity === "low") return glyph(theme, "status.info", "dim");
  return glyph(theme, "status.info", "warning");
}

/** Key ids as hints show them: `shift+x` as ⇧X, `pageDown` as PgDn. */
function keyLabel(id: string): string {
  const names: Readonly<Record<string, string>> = {
    enter: "Enter",
    escape: "Esc",
    tab: "Tab",
    space: "Space",
    backspace: "Backspace",
    pageUp: "PgUp",
    pageDown: "PgDn",
    up: "↑",
    down: "↓",
    home: "Home",
    end: "End",
  };
  const parts = id.split("+");
  const key = parts.at(-1) ?? id;
  const name = names[key] ?? key.toUpperCase();
  return parts.includes("shift") ? `⇧${name}` : name;
}

/** One hint: its key and what it does, kept on one line. */
function hint(keys: string, label: string): TspSpan[] {
  return [span(keys, "accent"), span(`\u00a0${label.replace(/ /g, "\u00a0")}`, "muted")];
}

/** The detail of one item as groups: consecutive fields and lists form one `kv` grid, sections render as Markdown. */
class Detail {
  readonly groups: UiNode[] = [];
  #pairs: [string, TspSpan[]][] = [];

  #flush(): void {
    const grid = kv(this.#pairs);
    if (grid) this.groups.push(grid);
    this.#pairs = [];
  }

  #push(node: UiNode): void {
    this.#flush();
    this.groups.push(node);
  }

  /** A bold line opening a group of rows. */
  subheading(text: string): void {
    this.#push(h("text", { spans: [span(text, "strong")], wrap: "word" }));
  }

  text(value: Rich): void {
    this.#push(h("text", { spans: spansOf(value), wrap: "word" }));
  }

  field(label: string, value: Rich): void {
    this.#pairs.push([label, spansOf(value)]);
  }

  /** One row per value: lists name items whose detail is elsewhere. The label shows on the first. */
  list(label: string, values: readonly Rich[]): void {
    values.forEach((value, index) => {
      this.#pairs.push([index ? "" : label, spansOf(value)]);
    });
  }

  section(title: string, body: string | undefined): void {
    if (!body?.trim()) return;
    this.#push(h("col", {}, h("text", { spans: [span(title, "strong")] }), h("md", { text: body.trim() })));
  }

  markdown(source: string): void {
    this.#push(h("md", { text: source }));
  }

  code(source: string, options: { path?: string; lang?: string }): void {
    this.#push(h("code", { text: source, ...options, wrap: true }));
  }

  done(): UiNode[] {
    this.#flush();
    return this.groups;
  }
}

/**
 * The two-pane screen shared by the console and the preview: header rows, a selectable sidebar, the selected item's
 * detail, one message line and the keys. The terminal fills the screen and pages the detail; Tern gets the same panes
 * in a large sheet, scrolling natively, with the keyed commands as buttons.
 */
abstract class SplitPane {
  /** Bumped on every change; the screen rebuilds from it. */
  readonly revision = signal(0);
  protected selected = 0;
  protected message: ConsoleMessage | undefined;
  /** Bumped on every change but a page step, so the painted detail is reused while paging. */
  #content = 0;
  /** The first detail row the terminal shows, and the rows a page step moves and the pane shows. */
  #offset = 0;
  #viewRows = 1;
  /** The terminal detail as last painted, reused while content, width and theme stay. */
  #painted: { content: number; width: number; theme: Theme; rows: readonly string[] } | undefined;
  /** Tern's forwarded detail scrolling. */
  #scroll: { by: "page-up" | "page-down"; n: number } | undefined;

  constructor(readonly theme: Theme) {}

  protected abstract count(): number;
  protected abstract title(): string;
  /** Rows above the panes, with the number of terminal rows they take at `width` (Tern ignores it). */
  protected abstract header(native: boolean, width: number): { nodes: UiNode[]; rows: number };
  /** A one-line row above the sidebar list (the search), if any. */
  protected sidebarHead(): TspText | undefined {
    return undefined;
  }
  /** Sidebar rows; `native` adds the tooltips only Tern shows. */
  protected abstract rows(native: boolean): Row[];
  protected abstract emptySidebar(): string;
  protected abstract detail(): DetailView;
  /** The keyed commands that apply now; `primary` names what Enter does on the selected row. */
  protected abstract commands(): Command[];
  /** The terminal hint strip. */
  protected abstract hints(): TspSpan[][];
  /** The close button. */
  protected abstract closeCommand(): Command;
  /** Keys besides the shared navigation; true when the key was used. */
  protected abstract handleKey(key: KeyEvent): boolean;
  /** `omp.overlay.roadmap.<view>`: the role Tern styles the sheet by. */
  protected abstract nativeRole(): string;
  /** What Enter does on the selected row; a double click on a row does the same. */
  protected abstract activate(): void;
  /** A button's action, routed to the code path of the key it shows. */
  protected abstract handleAction(act: string): void;
  /** Selections on lists other than the sidebar (the section tabs). */
  protected handleSelect(_list: string, _item: string): void {}

  protected changed(): void {
    this.#content++;
    this.revision.update((value) => value + 1);
  }

  protected select(index: number): void {
    const next = Math.max(0, Math.min(this.count() - 1, index));
    if (next === this.selected) return;
    this.selected = next;
    this.#offset = 0;
  }

  /** Jumps to `index` even when it equals the current row, so a changed list starts at the top of its detail. */
  protected reset(index: number): void {
    this.selected = Math.max(0, Math.min(this.count() - 1, index));
    this.#offset = 0;
  }

  /** Moves the terminal detail by a page less one row, within its painted rows; Tern scrolls its own pane. */
  #page(by: "page-up" | "page-down"): void {
    const step = Math.max(1, this.#viewRows - 1) * (by === "page-down" ? 1 : -1);
    const last = Math.max(0, (this.#painted?.rows.length ?? 0) - this.#viewRows);
    this.#offset = Math.max(0, Math.min(last, this.#offset + step));
    this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
    this.revision.update((value) => value + 1);
  }

  /** The detail painted at `width` in `theme`, painted again only after a change other than a page step. */
  #detailRows(content: UiNode, width: number, theme: Theme): readonly string[] {
    const painted = this.#painted;
    if (painted?.content === this.#content && painted.width === width && painted.theme === theme) return painted.rows;
    const rows = renderBlock(content, width, { theme }).rows;
    this.#painted = { content: this.#content, width, theme, rows };
    return rows;
  }

  /** A key on the screen; any used key clears the last message first. */
  input(key: KeyEvent): boolean {
    if (key.kind === "release") return false;
    const previous = this.message;
    this.message = undefined;
    let used = true;
    if (key.id === "up") this.select(this.selected - 1);
    else if (key.id === "down") this.select(this.selected + 1);
    else if (key.id === "home") this.select(0);
    else if (key.id === "end") this.select(this.count() - 1);
    else if (key.id === "pageDown" || key.id === "pageUp") {
      this.#page(key.id === "pageDown" ? "page-down" : "page-up");
      return true;
    } else used = this.handleKey(key);
    if (!used) {
      this.message = previous;
      return false;
    }
    this.changed();
    return true;
  }

  /** A list selection or activation: a sidebar row selects it (activation also runs Enter), a tab switches to it. */
  pick(keypath: string, item: string, activate: boolean): void {
    this.message = undefined;
    const list = keypath.slice(keypath.lastIndexOf("/") + 1);
    if (list === "items") {
      const index = /^i\d+$/.test(item) ? Number(item.slice(1)) : -1;
      if (index >= 0 && index < this.count()) {
        this.select(index);
        if (activate) this.activate();
      }
    } else this.handleSelect(list, item);
    this.changed();
  }

  /** A button. */
  act(act: string): void {
    this.message = undefined;
    this.handleAction(act);
    this.changed();
  }

  /** The screen: a terminal view filling `host.size()`, or with `native` the Tern sheet around the same panes. */
  view(host: ConsoleHost, native = nativeRendering()): UiNode {
    const lines = (): `${number}lines` => `${Math.max(SHEET_MIN_LINES, host.size().rows - SHEET_MARGIN_LINES)}lines`;
    const screen = h(
      "col",
      {
        onKey: (key) => this.input(key),
        onSelect: (item, event) => this.pick(event.key, item, false),
        onActivate: (item, event) => this.pick(event.key, item, true),
        onAction: (act) => this.act(act),
        ...(native ? { gap: "md", min: () => ({ h: lines() }), max: () => ({ h: lines() }) } : {}),
      },
      () => {
        this.revision();
        return native ? this.#native() : this.#terminal(host);
      },
    );
    if (!native) return screen;
    return h(
      "overlay",
      {
        role: this.nativeRole(),
        size: "lg",
        anchor: "center",
        modal: true,
        head: () => {
          this.revision();
          return this.title();
        },
      },
      screen,
    );
  }

  #message(truncate: boolean): UiNode | undefined {
    if (!this.message) return undefined;
    const spans = [span(singleLine(this.message.text), this.message.level === "error" ? "error" : "accent")];
    return h("text", { key: "message", spans, ...(truncate ? { truncate: "end" as const } : { wrap: "word" as const }) });
  }

  #items(native: boolean, from: number, to: number): UiNode {
    const rows = this.rows(native);
    return h(
      "list",
      {
        key: "items",
        selected: this.count() ? `i${this.selected}` : null,
        empty: [span(this.emptySidebar(), "dim")],
        ...(native ? SCROLLER : {}),
      },
      rows.slice(from, to).map((row, offset) => {
        const index = from + offset;
        return h("item", {
          key: `i${index}`,
          label: row.label,
          ...(row.detail ? { detail: row.detail } : {}),
          ...(row.value ? { value: row.value } : {}),
          ...(row.tone ? { tone: row.tone } : {}),
          ...(row.title ? { title: row.title } : {}),
          ...(native && index === this.selected ? { reveal: "nearest" as const } : {}),
        });
      }),
    );
  }

  #terminal(host: ConsoleHost): UiNode[] {
    const { columns, rows } = host.size();
    const width = Math.max(1, columns);
    const header = this.header(false, width);
    const hints = this.hints().flatMap((parts, index) => (index ? [span("   "), ...parts] : parts));
    const hintRows = Math.min(
      wrap(hints.map((part) => part.t).join(""), width).length,
      Math.max(1, Math.floor((rows - header.rows - 5) / 3)),
    );
    const message = this.#message(true);
    // Header, the two rules around the panes, the message and the hints leave the rest of the screen to the panes.
    const bodyRows = Math.max(3, rows - header.rows - 2 - (message ? 1 : 0) - hintRows);
    let sidebarWidth = Math.max(18, Math.min(52, Math.floor(width * 0.36)));
    if (width - sidebarWidth - 2 < 16) sidebarWidth = Math.max(4, Math.floor((width - 2) / 2));
    const detailWidth = Math.max(1, width - sidebarWidth - 2);

    const head = this.sidebarHead();
    const listRows = Math.max(1, bodyRows - (head ? 1 : 0));
    const total = this.count();
    const from = Math.max(0, Math.min(this.selected - Math.floor(listRows / 2), total - listRows));
    const to = Math.min(total, from + listRows);
    // An empty list explains itself across as many rows as it needs.
    const empty = total ? undefined : wrap(this.emptySidebar(), Math.max(1, sidebarWidth));
    const shown = empty ? empty.length : to - from;
    const sidebar = h(
      "col",
      { key: "sidebar", basis: sidebarWidth, grow: 0, shrink: 0 },
      head ? h("text", { key: "search", spans: spansOf(head), truncate: "end" }) : undefined,
      empty ? h("text", { key: "items", spans: [span(this.emptySidebar(), "dim")], wrap: "word" }) : this.#items(false, from, to),
      listRows > shown ? h("text", { text: Array.from({ length: listRows - shown }, () => " ").join("\n") }) : undefined,
    );

    const detail = this.detail();
    const content = h("col", { gap: "sm" }, detail.groups);
    const viewRows = Math.max(1, bodyRows - 1);
    this.#viewRows = viewRows;
    // Painted once per content, width and theme, then cut to the page: no node scrolls in the terminal.
    const page = h("canvas", {
      key: detail.key,
      paint: (width) => {
        const theme = currentTheme();
        const rows = this.#detailRows(content, width, theme);
        const offset = Math.min(this.#offset, Math.max(0, rows.length - viewRows));
        const shown = rows.slice(offset, offset + viewRows);
        const below = rows.length - offset - viewRows;
        if (below > 0) shown[viewRows - 1] = theme.style("dim", truncate(`… ${below + 1} more lines; PgDn scrolls`, width));
        return shown;
      },
    });
    const body = h(
      "col",
      { key: "body", basis: detailWidth, grow: 0, shrink: 1 },
      h("text", { key: "heading", spans: [span(detail.heading, "accent strong")], truncate: "end" }),
      page,
    );
    return [
      ...header.nodes,
      h("rule", { key: "top" }),
      h("row", { key: "split", gap: "md" }, sidebar, body),
      h("rule", { key: "bottom" }),
      message,
      h("text", { key: "hints", spans: hints, wrap: "word", lines: hintRows }),
    ].filter((node): node is UiNode => node !== undefined);
  }

  #native(): UiNode[] {
    const head = this.sidebarHead();
    const sidebar = h(
      "col",
      { key: "sidebar", max: { w: "40ch" }, shrink: 0, gap: "sm", min: { h: 0 } },
      head ? h("text", { key: "search", spans: spansOf(head) }) : undefined,
      this.#items(true, 0, this.count()),
    );
    const detail = this.detail();
    const content = h(
      "col",
      { key: detail.key, gap: "md", scroll: this.#scroll },
      h("text", { key: "heading", spans: [span(detail.heading, "accent strong")], wrap: "word" }),
      detail.groups,
    );
    const body = h("col", { key: "body", ...FILL }, h("list", { key: `scroll-${detail.key}`, ...SCROLLER }, content));
    const close = this.closeCommand();
    const actions = h(
      "row",
      { key: "actions", gap: "sm", wrap: true },
      this.commands().map((command) => this.#button(command)),
      h("spacer", { grow: 1 }),
      this.#button(close),
    );
    return [
      ...this.header(true, 0).nodes,
      h("row", { key: "split", ...FILL, gap: "lg", align: "stretch" }, sidebar, body),
      this.#message(false),
      actions,
    ].filter((node): node is UiNode => node !== undefined);
  }

  #button(command: Command): UiNode {
    return h("button", {
      key: command.act,
      text: `${command.label.charAt(0).toUpperCase()}${command.label.slice(1)}`,
      keys: command.key.split("+"),
      actions: { click: command.act },
      ...(command.tone === "accent" ? { variant: "primary" as const } : command.tone === "error" ? { variant: "danger" as const } : {}),
    });
  }

  /** Hints for the navigation keys every pane shares. */
  protected navigationHints(item: string): TspSpan[][] {
    return [hint("↑/↓", item), hint("PgUp/PgDn", "scroll")];
  }
}

type Entry =
  | { kind: "stage"; id: string; title: string; stage: StageDoc }
  | { kind: "round"; id: string; title: string; round: RoundDoc }
  | { kind: "todo"; id: string; title: string; todo: TodoItem; round: string };

/**
 * The fullscreen `/roadmap` console: the Stages of one round (the active round unless Enter on a round chose another),
 * every Round and the Open TODOs as Tab sections, the selected item's detail on the right. Actions close it with a
 * {@link ConsoleChoice}; Esc closes with undefined.
 */
export class RoadmapConsole extends SplitPane {
  readonly #on: string;
  readonly #active: RoundDoc | undefined;
  readonly #nextPlanned: RoundDoc | undefined;
  readonly #entries: Record<ConsoleSection, Entry[]>;
  /** The last selected id per section, so Tab returns to it. */
  readonly #remembered = new Map<ConsoleSection, string>();
  /** Atlas plans per stage, asked once per showing. */
  readonly #plans = new Map<string, readonly AtlasStagePlan[] | undefined>();
  #stageRound: string | undefined;
  #order: StageOrder;
  #section: ConsoleSection;
  #query: string;
  #visible: Entry[] = [];
  #finished = false;

  constructor(
    readonly model: Model,
    state: ConsoleState,
    theme: Theme,
    readonly done: (choice: ConsoleChoice | undefined) => void,
    readonly plans?: StagePlans,
    /** Told the new order whenever Shift+O switches it, so later lists in the session follow it. */
    readonly onOrder?: (order: StageOrder) => void,
  ) {
    super(theme);
    this.#on = state.on ?? today();
    this.#order = state.order ?? "dependency";
    this.#active = model.rounds.find((round) => round.status === "active");
    this.#nextPlanned = model.rounds.filter((round) => round.status === "planned").sort(byId)[0];
    const scope = state.view?.stageRound;
    this.#stageRound = scope && model.rounds.some((round) => round.id === scope) ? scope : this.#active?.id;
    const rounds = [...model.rounds].sort(byId);
    const todos = model.todos
      .flatMap((doc) => doc.items.filter((item) => item.status === "open").map((todo) => ({ todo, round: doc.round })))
      .sort((a, b) => byId(a.todo, b.todo));
    this.#entries = {
      stages: this.#stageEntries(),
      rounds: rounds.map((round) => ({ kind: "round", id: round.id, title: round.title, round })),
      todos: todos.map(({ todo, round }) => ({ kind: "todo", id: todo.id, title: todo.title, todo, round })),
    };
    this.#section = state.view?.section ?? (this.#active ? "stages" : "rounds");
    this.#query = state.view?.query ?? "";
    this.message = state.message;
    this.#refilter(state.view?.selected ?? this.#defaultSelection(this.#section));
  }

  #stageEntries(): Entry[] {
    return orderStages(
      this.model.stages.filter((stage) => stage.round === this.#stageRound),
      this.#order,
    ).map((stage) => ({ kind: "stage", id: stage.id, title: stage.title, stage }));
  }

  /** Shift+O: dependency order and id order trade places for the rest of the session; the selection stays on its item. */
  #toggleOrder(): void {
    this.#order = this.#order === "dependency" ? "id" : "dependency";
    this.onOrder?.(this.#order);
    this.#entries.stages = this.#stageEntries();
    if (this.#section === "stages") this.#refilter(this.#current()?.id);
    this.message = { text: `Stages are listed in ${this.#order} order for the rest of this session`, level: "info" };
  }

  #activeStages(): StageDoc[] {
    return this.model.stages.filter((stage) => stage.round === this.#active?.id);
  }

  #defaultSelection(section: ConsoleSection): string | undefined {
    if (section === "stages") {
      const stages = this.#entries.stages.flatMap((entry) => (entry.kind === "stage" ? [entry.stage] : []));
      return (stages.find((stage) => stage.status === "active") ?? stages.find((stage) => stage.status === "planned"))?.id;
    }
    if (section === "rounds") return (this.#active ?? this.#nextPlanned ?? [...this.model.rounds].sort(byId).at(-1))?.id;
    return undefined;
  }

  #matches(entry: Entry, query: string): boolean {
    const extra =
      entry.kind === "stage"
        ? entry.stage.status
        : entry.kind === "round"
          ? entry.round.status
          : `${entry.todo.severity ?? ""} ${entry.todo.target ?? ""} ${entry.todo.trigger ?? ""}`;
    return `${entry.id} ${entry.title} ${extra}`.toLowerCase().includes(query);
  }

  #refilter(selectedId: string | undefined): void {
    const query = this.#query.trim().toLowerCase();
    this.#visible = this.#entries[this.#section].filter((entry) => !query || this.#matches(entry, query));
    this.reset(
      Math.max(
        0,
        this.#visible.findIndex((entry) => entry.id === selectedId),
      ),
    );
  }

  #current(): Entry | undefined {
    return this.#visible[this.selected];
  }

  #switchTo(section: ConsoleSection, selectedId?: string): void {
    const current = this.#current();
    if (current) this.#remembered.set(this.#section, current.id);
    this.#section = section;
    this.#query = "";
    this.#refilter(selectedId ?? this.#remembered.get(section) ?? this.#defaultSelection(section));
  }

  #view(): ConsoleView {
    const current = this.#current();
    return {
      section: this.#section,
      query: this.#query,
      ...(current ? { selected: current.id } : {}),
      ...(this.#stageRound && this.#stageRound !== this.#active?.id ? { stageRound: this.#stageRound } : {}),
    };
  }

  #choose(choice: Omit<ConsoleChoice, "view">): void {
    if (this.#finished) return;
    this.#finished = true;
    this.done({ ...choice, view: this.#view() });
  }

  #roundSettled(): boolean {
    return this.#activeStages().every((stage) => stage.status === "closed" || stage.status === "dropped");
  }

  /** Lists the stages of `round` in Stages and selects `selectedId` there. */
  #showStages(round: string, selectedId?: string): void {
    if (round !== this.#stageRound) {
      this.#stageRound = round;
      this.#entries.stages = this.#stageEntries();
      this.#remembered.delete("stages");
    }
    this.#switchTo("stages", selectedId);
  }

  /** Enter navigates: a stage to its round, a round to its stages, a TODO to its target. */
  #primary(): void {
    const entry = this.#current();
    if (!entry) this.message = { text: this.emptySidebar(), level: "info" };
    else if (entry.kind === "stage") this.#switchTo("rounds", entry.stage.round);
    else if (entry.kind === "round") this.#showStages(entry.id);
    else this.#goToTarget(entry.todo);
  }

  /** Esc clears the search first and then closes without a choice. */
  #escape(): void {
    if (this.#query) {
      const current = this.#current();
      this.#query = "";
      this.#refilter(current?.id);
    } else if (!this.#finished) {
      this.#finished = true;
      this.done(undefined);
    }
  }

  #goToTarget(item: TodoItem): void {
    if (!item.target) {
      this.message = {
        text: `${item.id} waits on a trigger${item.trigger ? ` (${singleLine(item.trigger)})` : ""}, not a stage`,
        level: "info",
      };
      return;
    }
    const stage = this.model.stages.find((candidate) => candidate.id === item.target);
    if (stage) this.#showStages(stage.round, stage.id);
    else if (this.model.rounds.some((round) => round.id === item.target)) this.#switchTo("rounds", item.target);
    else this.message = { text: `${item.id} targets ${item.target}, which is not in the roadmap`, level: "error" };
  }

  #closeStage(): void {
    const entry = this.#current();
    if (entry?.kind === "stage" && entry.stage.status === "active") this.#choose({ action: "close", stage: entry.id });
    else this.message = { text: "Select an active stage in Stages to close it", level: "info" };
  }

  #closeRound(): void {
    if (!this.#active) this.message = { text: "There is no active round to close", level: "info" };
    else if (!this.#roundSettled())
      this.message = { text: `Close or drop every stage of ${this.#active.id} before closing the round`, level: "info" };
    else this.#choose({ action: "close-round" });
  }

  #newRound(): void {
    if (this.#active) this.message = { text: `Close ${this.#active.id} before opening another round`, level: "info" };
    else this.#choose({ action: "new-round" });
  }

  #onPlannedRound(action: "plan-round" | "drop-round", verb: string): void {
    const entry = this.#current();
    if (entry?.kind === "round" && (entry.round.status === "planned" || (action === "plan-round" && entry.round.status === "active")))
      this.#choose({ action, round: entry.id });
    else
      this.message = {
        text: `Select ${action === "plan-round" ? "an active or planned" : "a planned"} round in Rounds to ${verb} it`,
        level: "info",
      };
  }

  /** The unclosed stage or round whose target date can change; format 1 has no target dates. */
  #retargetable(): Pick<ConsoleChoice, "stage" | "round"> | undefined {
    const entry = this.#current();
    if (this.model.index.format !== 2 || !entry || entry.kind === "todo") return undefined;
    const status = entry.kind === "stage" ? entry.stage.status : entry.round.status;
    if (status !== "planned" && status !== "active") return undefined;
    return entry.kind === "stage" ? { stage: entry.id } : { round: entry.id };
  }

  #retarget(): void {
    const target = this.#retargetable();
    if (target) this.#choose({ action: "retarget", ...target });
    else if (this.model.index.format !== 2)
      this.message = { text: "Target dates need roadmap format 2; Shift+U upgrades the repository", level: "info" };
    else this.message = { text: "Select an unclosed stage or round to change its target date", level: "info" };
  }

  #upgrade(): void {
    if (this.model.index.format === 1) this.#choose({ action: "upgrade" });
    else this.message = { text: "This repository already uses roadmap format 2", level: "info" };
  }

  /** Shift+letter commands, by the letter. */
  static readonly #SHORTCUTS: Readonly<Record<string, string>> = {
    C: "check",
    X: "close-stage",
    R: "close-round",
    N: "new-round",
    P: "plan-round",
    E: "revise",
    D: "drop",
    T: "retarget",
    U: "upgrade",
    O: "order",
  };

  protected handleKey(key: KeyEvent): boolean {
    const shortcut = /^shift\+([a-z])$/.exec(key.id)?.[1]?.toUpperCase();
    if (key.id === "escape") this.#escape();
    else if (key.id === "tab" || key.id === "shift+tab") {
      const step = key.id === "tab" ? 1 : SECTIONS.length - 1;
      this.#switchTo(SECTIONS[(SECTIONS.indexOf(this.#section) + step) % SECTIONS.length] as ConsoleSection);
    } else if (key.id === "enter") this.#primary();
    else if (shortcut && RoadmapConsole.#SHORTCUTS[shortcut]) this.handleAction(RoadmapConsole.#SHORTCUTS[shortcut] as string);
    else if (key.id === "backspace") {
      if (!this.#query) return true;
      this.#query = [...this.#query].slice(0, -1).join("");
      this.#refilter(this.#current()?.id);
    } else if (key.text && [...key.text].length === 1 && !/[\p{Cc}]/u.test(key.text)) {
      this.#query += key.text;
      this.#refilter(this.#current()?.id);
    } else return false;
    return true;
  }

  protected handleAction(act: string): void {
    if (act === "primary") this.#primary();
    else if (act === "close") this.#escape();
    else if (act === "check") this.#choose({ action: "check" });
    else if (act === "close-stage") this.#closeStage();
    else if (act === "close-round") this.#closeRound();
    else if (act === "new-round") this.#newRound();
    else if (act === "plan-round") this.#choose({ action: "plan-round" });
    else if (act === "revise") this.#onPlannedRound("plan-round", "revise");
    else if (act === "drop") this.#onPlannedRound("drop-round", "drop");
    else if (act === "retarget") this.#retarget();
    else if (act === "upgrade") this.#upgrade();
    else if (act === "order") this.#toggleOrder();
  }

  /** A click on a section tab switches to it as Tab does. */
  protected override handleSelect(list: string, item: string): void {
    const section = SECTIONS.find((candidate) => candidate === item);
    if (list === "sections" && section && section !== this.#section) this.#switchTo(section);
  }

  protected activate(): void {
    this.#primary();
  }

  protected count(): number {
    return this.#visible.length;
  }

  protected title(): string {
    return `Roadmap · ${this.model.index.title}`;
  }

  #summary(): TspSpan[] {
    const round = this.#active;
    const planned = this.model.rounds.filter((candidate) => candidate.status === "planned").length;
    const open = this.#entries.todos.length;
    let parts: TspSpan[][];
    if (round) {
      const stages = this.#activeStages();
      const settled = stages.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
      const late = stages.filter((stage) => overdue(stage, this.#on)).length;
      const dates = schedule(round, roundActual(round), this.#on);
      parts = [
        [statusSpan(this.theme, round.status), span(" "), span(`${round.id} ${round.title}`, "strong")],
        [span(`${settled}/${plural(stages.length, "stage")} settled`)],
        [span(plural(open, "open TODO"))],
        ...(dates ? [[span(dates)]] : []),
        ...(late ? [[span(plural(late, "overdue stage"), "warning")]] : []),
        ...(planned ? [[span(plural(planned, "planned round"))]] : []),
      ];
    } else {
      const last = this.model.rounds
        .filter((candidate) => candidate.status !== "planned")
        .sort(byId)
        .at(-1);
      parts = [
        [span(last ? `No active round (last: ${last.id} ${last.title}, ${last.status})` : planned ? "No active round" : "No rounds yet")],
        ...(planned ? [[span(plural(planned, "planned round"))]] : []),
        ...(open ? [[span(plural(open, "open TODO"))]] : []),
      ];
    }
    const spans = parts.flatMap((part, index) => (index ? [span(" · ", "dim"), ...part] : part));
    if (this.model.index.format === 1) spans.push(span(" · format 1", "dim"));
    return spans;
  }

  /** Section labels with their sizes; Stages names its round once Enter on another round chose it. */
  #sectionLabel(section: ConsoleSection): string {
    const label =
      section === "stages" && this.#stageRound && this.#stageRound !== this.#active?.id
        ? `Stages ${this.#stageRound}`
        : SECTION_LABELS[section];
    return `${label} ${this.#entries[section].length}`;
  }

  protected header(native: boolean, width: number): { nodes: UiNode[]; rows: number } {
    const summary = this.#summary();
    const tabs = h("tabs", {
      key: "sections",
      items: SECTIONS.map((section) => ({ id: section, label: this.#sectionLabel(section) })),
      active: this.#section,
      actions: { click: "select" },
    });
    if (native) return { nodes: [h("text", { key: "summary", spans: summary, wrap: "word" }), tabs], rows: 0 };
    // Long round titles wrap onto a second row rather than hiding the counts.
    const summaryRows = Math.min(2, wrap(summary.map((part) => part.t).join(""), width).length);
    return {
      nodes: [
        h("text", {
          key: "title",
          spans: [span("Roadmap", "accent strong"), span(` · ${this.model.index.title}`, "strong")],
          truncate: "end",
        }),
        h("text", { key: "summary", spans: summary, wrap: "word", lines: summaryRows }),
        tabs,
      ],
      rows: 2 + summaryRows,
    };
  }

  protected override sidebarHead(): TspText {
    const all = this.#entries[this.#section].length;
    const position = this.#visible.length > 1 ? [span(`  ${this.selected + 1}/${this.#visible.length}`, "dim")] : [];
    return this.#query
      ? [span("Search: "), span(this.#query, "strong"), span(`  ${this.#visible.length}/${all} match`, "dim")]
      : [span("Type to search", "dim"), ...position];
  }

  protected emptySidebar(): string {
    if (this.#query) return "Nothing matches the search; Esc clears it";
    if (this.#section === "stages") {
      if (this.#stageRound) return `${this.#stageRound} has no stages yet`;
      return `No active round; Shift+N ${this.#nextPlanned ? `activates ${this.#nextPlanned.id}` : "opens a new round"}`;
    }
    if (this.#section === "rounds") return "No rounds yet";
    return "No open TODOs";
  }

  #mark(entry: Entry): TspSpan {
    if (entry.kind === "stage") return statusSpan(this.theme, entry.stage.status);
    if (entry.kind === "round") return statusSpan(this.theme, entry.round.status);
    return todoSpan(this.theme, entry.todo);
  }

  #late(entry: Entry): boolean {
    return entry.kind === "stage" ? overdue(entry.stage, this.#on) : entry.kind === "round" ? overdue(entry.round, this.#on) : false;
  }

  /** Atlas plan coverage of a stage's done criteria; nothing without an answer from omo-prometheus. */
  #coverageNotes(stage: StageDoc): string[] {
    const plans = this.#stagePlans(stage.id);
    if (!plans?.length) return [];
    let coverage: StageCoverage;
    try {
      coverage = stageCoverage(stage, plans);
    } catch {
      return ["coverage unavailable"];
    }
    const total = coverage.criteria.length;
    const covered = coverage.criteria.filter((entry) => entry.complete.length).length;
    return [...(total ? [`${covered}/${total} criteria covered`] : []), ...(coverage.drifted.length ? ["plan drift"] : [])];
  }

  /**
   * A row's state beyond its title: status, a planned stage's readiness, a round's progress, a TODO's severity and
   * target, overdue and Atlas plan coverage. The detail pane shows all of it in full.
   */
  #itemNotes(entry: Entry): string[] {
    const late = this.#late(entry) ? ["overdue"] : [];
    if (entry.kind === "stage") {
      const readiness = entry.stage.status === "planned" ? stageReadiness(this.model, entry.stage) : undefined;
      return [
        entry.stage.status,
        ...(readiness?.startable
          ? ["ready to start"]
          : readiness?.blockedBy.length
            ? [`blocked by ${readiness.blockedBy.join(", ")}`]
            : []),
        ...late,
        ...this.#coverageNotes(entry.stage),
      ];
    }
    if (entry.kind === "round") {
      const stages = this.model.stages.filter((stage) => stage.round === entry.id);
      const settled = stages.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
      return [
        entry.round.status,
        `${settled}/${plural(stages.length, "stage")} settled`,
        ...(entry.round === this.#nextPlanned ? ["next to activate"] : []),
        ...late,
      ];
    }
    const where = entry.todo.target ?? (entry.todo.trigger ? `trigger: ${singleLine(entry.todo.trigger)}` : undefined);
    return [`${entry.todo.severity ?? "normal"} severity`, ...(where ? [where] : [])];
  }

  /**
   * One line per item: the status glyph, the id and the title, an overdue mark at the end; the active item takes the
   * accent and a dropped one is muted. The rest rides in the tooltip.
   */
  protected rows(native: boolean): Row[] {
    // Preset glyphs differ in cell width (unicode ✔ vs ascii [+]); pad them to one column.
    const markWidth = Math.max(1, ...this.#visible.map((entry) => visibleWidth(this.#mark(entry).t)));
    const idWidth = Math.max(0, ...this.#visible.map((entry) => entry.id.length));
    return this.#visible.map((entry) => {
      const mark = this.#mark(entry);
      const status = entry.kind === "stage" ? entry.stage.status : entry.kind === "round" ? entry.round.status : undefined;
      return {
        label: [
          mark,
          span(" ".repeat(markWidth - visibleWidth(mark.t) + 1)),
          span(entry.id.padEnd(idWidth), "muted"),
          span(` ${singleLine(entry.title)}`),
        ],
        ...(this.#late(entry) ? { value: [glyph(this.theme, "status.warning", "warning")] } : {}),
        ...(status === "active" ? { tone: "accent" as const } : status === "dropped" ? { tone: "muted" as const } : {}),
        ...(native ? { title: [`${entry.id} ${singleLine(entry.title)}`, ...this.#itemNotes(entry)].join(" · ") } : {}),
      };
    });
  }

  /** The keyed commands that apply to the current item; the first is Enter when an item is selected. */
  protected commands(): Command[] {
    const entry = this.#current();
    const round = this.#active;
    const planned = entry?.kind === "round" && entry.round.status === "planned" ? entry.id : undefined;
    const revisable =
      entry?.kind === "round" && (entry.round.status === "active" || entry.round.status === "planned") ? entry.id : undefined;
    const enter = entry?.kind === "todo" ? "go to target" : entry?.kind === "stage" ? "its round" : "its stages";
    return [
      ...(entry ? [{ act: "primary", key: "enter", label: enter }] : []),
      ...(entry?.kind === "stage" && entry.stage.status === "active" ? [{ act: "close-stage", key: "shift+x", label: "close stage" }] : []),
      ...(revisable ? [{ act: "revise", key: "shift+e", label: `revise ${revisable}` }] : []),
      ...(planned ? [{ act: "drop", key: "shift+d", label: `drop ${planned}`, tone: "error" as const }] : []),
      ...(this.#retargetable() ? [{ act: "retarget", key: "shift+t", label: "target date" }] : []),
      ...(round && this.#roundSettled()
        ? [{ act: "close-round", key: "shift+r", label: `close ${round.id}`, tone: "accent" as const }]
        : []),
      ...(!round
        ? [
            {
              act: "new-round",
              key: "shift+n",
              label: this.#nextPlanned ? `activate ${this.#nextPlanned.id}` : "new round",
              tone: "accent" as const,
            },
          ]
        : []),
      { act: "plan-round", key: "shift+p", label: "plan a round" },
      ...(this.model.index.format === 1 ? [{ act: "upgrade", key: "shift+u", label: "upgrade to format 2" }] : []),
      { act: "order", key: "shift+o", label: `order: ${this.#order}` },
      { act: "check", key: "shift+c", label: "check" },
    ];
  }

  protected closeCommand(): Command {
    return { act: "close", key: "escape", label: this.#query ? "clear search" : "close" };
  }

  protected hints(): TspSpan[][] {
    const commands = this.commands();
    const [first, ...rest] = commands;
    const primary = first?.act === "primary" ? [first] : [];
    const others = first?.act === "primary" ? rest : commands;
    const close = this.closeCommand();
    return [
      ...this.navigationHints("select"),
      ...primary.map((command) => hint(keyLabel(command.key), command.label)),
      hint("Tab", "section"),
      ...others.map((command) => hint(keyLabel(command.key), command.label)),
      hint(keyLabel(close.key), close.label),
    ];
  }

  protected detail(): DetailView {
    const entry = this.#current();
    if (!entry) return { key: "detail", heading: "Nothing selected", groups: [] };
    const detail = new Detail();
    if (entry.kind === "stage") this.#stageDetail(detail, entry.stage);
    else if (entry.kind === "round") this.#roundDetail(detail, entry.round);
    else this.#todoDetail(detail, entry.todo, entry.round);
    return { key: `detail-${entry.kind}-${entry.id}`, heading: `${entry.id} — ${entry.title}`, groups: detail.done() };
  }

  #stageLine(stage: StageDoc): TspSpan[] {
    return [statusSpan(this.theme, stage.status), span(` ${stage.id} ${singleLine(stage.title)}`)];
  }

  #openTodos(target: string): TspSpan[][] {
    return this.#entries.todos.flatMap((entry) =>
      entry.kind === "todo" && entry.todo.target === target
        ? [
            [
              todoSpan(this.theme, entry.todo),
              span(` ${entry.id} ${singleLine(entry.title)}`),
              span(` · ${entry.todo.severity ?? "normal"}`, "dim"),
            ],
          ]
        : [],
    );
  }

  #stagePlans(stage: string): readonly AtlasStagePlan[] | undefined {
    if (!this.#plans.has(stage)) this.#plans.set(stage, this.plans?.(stage));
    return this.#plans.get(stage);
  }

  #stageDetail(detail: Detail, stage: StageDoc): void {
    const readiness = stageReadiness(this.model, stage);
    const ready = readiness.startable
      ? [span(" · ready to start", "success")]
      : readiness.blockedBy.length
        ? [span(` · blocked by ${readiness.blockedBy.join(", ")}`, "warning")]
        : [];
    detail.field("Status", [statusSpan(this.theme, stage.status), span(` ${stage.status}`), ...ready]);
    const round = this.model.rounds.find((candidate) => candidate.id === stage.round);
    detail.field("Round", round ? `${round.id} ${singleLine(round.title)} [${round.status}]` : stage.round);
    if (stage.target) detail.field("Target", [span(stage.target), ...(overdue(stage, this.#on) ? [span(" · overdue", "warning")] : [])]);
    detail.field(
      "Dates",
      [`created ${stage.created}`, stage.started ? `started ${stage.started}` : "", stage.closed ? `${stage.status} ${stage.closed}` : ""]
        .filter(Boolean)
        .join(" · "),
    );
    const dependencies = stage.depends_on.map((id): Rich => {
      const other = this.model.stages.find((candidate) => candidate.id === id);
      return other ? this.#stageLine(other) : id;
    });
    detail.list("Depends", dependencies.length ? dependencies : [this.theme.symbols.symbol("format.dash")]);
    if (stage.follows) detail.field("Follows", stage.follows);
    const adrs = (this.model.adrs?.records ?? [])
      .filter((record) => record.stage === stage.id)
      .sort(byId)
      .map((record) => [
        span(`${record.id} ${singleLine(record.title)}`),
        span(` · ${record.status}`, record.status === "proposed" ? "warning" : "dim"),
      ]);
    if (adrs.length) detail.list("ADRs", adrs);
    const todos = this.#openTodos(stage.id);
    detail.list("TODOs", todos.length ? todos : [[span("none open", "dim")]]);
    detail.field("File", [span(this.model.repo ? relative(this.model.repo.repoRoot, stage.path) : stage.path, "dim")]);
    this.#plansDetail(detail, stage);
    detail.section("Objective", stage.objective);
    detail.section("In scope", stage.scope_in);
    detail.section("Out of scope", stage.scope_out);
    detail.section("Done criteria", stage.done_criteria);
    detail.section("Design constraints", stage.design_constraints);
    detail.section("Risks", stage.risks);
    detail.section("Amendments", stage.amendments);
    detail.section("Free-work log", stage.free_work_log);
    detail.section("Outcome", stage.outcome);
  }

  /** The same Atlas plan coverage the stage's status report lists; nothing without an answer from omo-prometheus. */
  #plansDetail(detail: Detail, stage: StageDoc): void {
    const plans = this.#stagePlans(stage.id);
    if (!plans) return;
    detail.subheading("Atlas plans");
    let coverage: StageCoverage;
    try {
      coverage = stageCoverage(stage, plans);
    } catch (error) {
      detail.text([span(`Coverage unavailable: ${error instanceof Error ? error.message : String(error)}`, "error")]);
      return;
    }
    if (!plans.length) detail.text([span("No Atlas plan is bound to this stage yet", "dim")]);
    for (const plan of plans) {
      const mark =
        plan.status === "complete" ? glyph(this.theme, "status.success", "success") : glyph(this.theme, "status.running", "accent");
      const declared = plan.criteria ? plan.criteria.join(", ") : "coverage undeclared";
      const drift = coverage.drifted.includes(plan) ? [span(" · drift", "warning")] : [];
      detail.text([
        mark,
        span(` ${planLabel(plan)}`),
        span(` · ${plan.status} · ${plan.done}/${plan.total} rows · ${declared}`, "dim"),
        ...drift,
      ]);
    }
    for (const entry of coverage.criteria) {
      detail.field(entry.id, [
        entry.complete.length
          ? span(`covered by complete ${entry.complete.map(planLabel).join(", ")}`, "success")
          : entry.unfinished.length
            ? span(`only by unfinished ${entry.unfinished.map(planLabel).join(", ")}`, "warning")
            : span("uncovered", "error"),
      ]);
    }
    if (coverage.undeclared.length)
      detail.text([span(`Coverage undeclared by ${coverage.undeclared.map(planLabel).join(", ")}; check their scope`, "warning")]);
    if (coverage.drifted.length)
      detail.text([
        span(
          `Drift: ${coverage.drifted.map(planLabel).join(", ")} approved before the objective, scope, criteria or design constraints changed`,
          "warning",
        ),
      ]);
  }

  #roundDetail(detail: Detail, round: RoundDoc): void {
    detail.field("Status", [
      statusSpan(this.theme, round.status),
      span(` ${round.status}`),
      ...(round === this.#nextPlanned ? [span(" · next to activate", "dim")] : []),
    ]);
    if (round.target) detail.field("Target", [span(round.target), ...(overdue(round, this.#on) ? [span(" · overdue", "warning")] : [])]);
    const actual = roundActual(round);
    if (actual) detail.field("Dates", actual);
    detail.field("File", [span(this.model.repo ? relative(this.model.repo.repoRoot, round.path) : round.path, "dim")]);
    const stages = orderStages(
      this.model.stages.filter((stage) => stage.round === round.id),
      this.#order,
    );
    const settled = stages.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
    detail.field("Stages", stages.length ? `${settled}/${stages.length} settled` : [span("none yet", "dim")]);
    detail.list(
      "",
      stages.map((stage) => [...this.#stageLine(stage), ...(overdue(stage, this.#on) ? [span(" · overdue", "warning")] : [])]),
    );
    const { openTodos } = plannedRoundCounts(this.model, round.id);
    detail.field("TODOs", openTodos ? `${openTodos} open` : [span("none open", "dim")]);
    detail.section("Goal", round.goal);
    detail.section("Constraints", round.constraints);
    detail.section("Non-goals", round.non_goals);
    detail.section("Principles", round.principles);
    detail.section("Known limitations", round.known_limitations);
    detail.section("Outcome", round.outcome);
  }

  #todoDetail(detail: Detail, item: TodoItem, round: string): void {
    detail.field("Status", [todoSpan(this.theme, item), span(` ${item.status} · ${item.severity ?? "normal"} severity`)]);
    const owner = this.model.rounds.find((candidate) => candidate.id === round);
    detail.field("Round", owner ? `${owner.id} ${singleLine(owner.title)} [${owner.status}]` : round);
    if (item.target) {
      const stage = this.model.stages.find((candidate) => candidate.id === item.target);
      detail.field("Target", stage ? [...this.#stageLine(stage), span(` · ${stage.round}`, "dim")] : item.target);
    }
    if (item.trigger) detail.field("Trigger", singleLine(item.trigger));
    if (item.source) detail.field("Source", singleLine(item.source));
    if (item.carried_from) detail.field("Carried", `from ${item.carried_from}`);
    if (item.reference) detail.field("Reference", singleLine(item.reference));
    detail.section("Details", item.body);
  }

  protected nativeRole(): string {
    return "omp.overlay.roadmap.console";
  }
}

/** Frontmatter stays plain so the YAML that will be written reads exactly; the rest renders as Markdown. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  return match ? { frontmatter: match[0].trimEnd(), body: content.slice(match[0].length) } : { frontmatter: "", body: content };
}

/**
 * Fullscreen write preview: the write and cancel rows around the repo-relative file list on the left, the selected
 * file on the right. Resolves true to write every file and false to write nothing.
 */
export class PreviewView extends SplitPane {
  #raw = false;
  #finished = false;
  readonly #paths: string[];

  constructor(
    readonly preview: PreviewRequest,
    theme: Theme,
    readonly done: (answer: boolean) => void,
  ) {
    super(theme);
    this.#paths = preview.files.map((file) => relative(preview.root, file.path));
  }

  #answer(answer: boolean): void {
    if (this.#finished) return;
    this.#finished = true;
    this.done(answer);
  }

  /** Index of the selected file, or undefined on the write and cancel rows. */
  #file(): number | undefined {
    const index = this.selected - 1;
    return index >= 0 && index < this.preview.files.length ? index : undefined;
  }

  /** Whether the selected row is a Markdown file, which shows rendered unless Space asked for the raw text. */
  #onMarkdown(): boolean {
    const index = this.#file();
    return index !== undefined && /\.md$/i.test(this.preview.files[index]?.path ?? "");
  }

  /** Enter: the Write row writes, the Cancel row cancels, a file row explains. */
  #enter(): void {
    if (this.selected === 0) this.#answer(true);
    else if (this.selected === this.count() - 1) this.#answer(false);
    else this.message = { text: "Shift+W or the Write row writes every file; Esc cancels", level: "info" };
  }

  protected handleKey(key: KeyEvent): boolean {
    if (key.id === "escape") this.#answer(false);
    else if (key.id === "shift+w") this.#answer(true);
    else if (key.id === "enter") this.#enter();
    else if (key.id === "space") {
      if (this.#onMarkdown()) this.#raw = !this.#raw;
    } else return false;
    return true;
  }

  protected handleAction(act: string): void {
    if (act === "write") this.#answer(true);
    else if (act === "cancel") this.#answer(false);
    else if (act === "raw" && this.#onMarkdown()) this.#raw = !this.#raw;
  }

  protected activate(): void {
    this.#enter();
  }

  protected count(): number {
    return this.preview.files.length + 2;
  }

  protected title(): string {
    return `Roadmap preview · ${plural(this.preview.files.length, "file")}`;
  }

  #headline(): string {
    return singleLine(this.preview.title.split("\n")[0] ?? "");
  }

  protected header(native: boolean, width: number): { nodes: UiNode[]; rows: number } {
    const headline = h("text", {
      key: "headline",
      spans: [span(this.#headline(), "strong")],
      wrap: "word",
      ...(native ? {} : { lines: 2 }),
    });
    if (native) return { nodes: [headline], rows: 0 };
    const title = h("text", { key: "title", spans: [span(this.title(), "accent strong")], truncate: "end" });
    return { nodes: [title, headline], rows: 1 + Math.min(2, wrap(this.#headline(), width).length) };
  }

  protected emptySidebar(): string {
    return "";
  }

  #writeLabel(): string {
    return `Write ${plural(this.preview.files.length, "file")}`;
  }

  #lines(index: number): number {
    return (this.preview.files[index]?.content ?? "").split("\n").length;
  }

  /** The file name leads, so a long path cannot truncate it away; the directory follows and gives way first. */
  protected rows(): Row[] {
    return [
      { label: [glyph(this.theme, "status.success", "success"), span(` ${this.#writeLabel()}`)], tone: "success" },
      ...this.#paths.map((path, at): Row => {
        const slash = path.lastIndexOf("/");
        return {
          label: [span(path.slice(slash + 1), "path")],
          ...(slash > 0 ? { detail: [span(path.slice(0, slash), "dim")] } : {}),
          title: `${path} · ${plural(this.#lines(at), "line")}`,
        };
      }),
      { label: [glyph(this.theme, "status.error", "error"), span(" Cancel")], tone: "error" },
    ];
  }

  protected commands(): Command[] {
    return [
      { act: "write", key: "shift+w", label: this.#writeLabel(), tone: "accent" },
      ...(this.#onMarkdown() ? [{ act: "raw", key: "space", label: this.#raw ? "rendered" : "raw text" }] : []),
    ];
  }

  protected closeCommand(): Command {
    return { act: "cancel", key: "escape", label: "cancel" };
  }

  protected hints(): TspSpan[][] {
    const last = this.count() - 1;
    return [
      ...this.navigationHints("file"),
      ...(this.selected === 0 ? [hint("Enter", "write")] : this.selected === last ? [hint("Enter", "cancel")] : []),
      hint("⇧W", "write all"),
      ...(this.#onMarkdown() ? [hint("Space", this.#raw ? "rendered" : "raw text")] : []),
      hint("Esc", "cancel"),
    ];
  }

  /** The Write row lists what is written; a file shows as Markdown (frontmatter as YAML) or, raw or not Markdown, as code. */
  protected detail(): DetailView {
    const detail = new Detail();
    const index = this.#file();
    if (index === undefined) {
      if (this.selected !== 0) {
        detail.text([span("Enter cancels: nothing is written.", "dim")]);
        return { key: "detail-cancel", heading: "Cancel", groups: detail.done() };
      }
      detail.text(this.preview.title);
      detail.subheading("Files");
      detail.text(
        this.#paths.flatMap((path, at) => [
          ...(at ? [span("\n")] : []),
          span(path, "path"),
          span(` · ${plural(this.#lines(at), "line")}`, "dim"),
        ]),
      );
      detail.text([span("Enter or Shift+W writes every file. Esc cancels and writes nothing.", "dim")]);
      return { key: "detail-write", heading: this.#writeLabel(), groups: detail.done() };
    }
    const file = this.preview.files[index] as PreviewFile;
    const markdown = this.#onMarkdown();
    if (markdown) detail.text([span(this.#raw ? "Raw text; Space shows it rendered" : "Rendered; Space shows the raw text", "dim")]);
    if (this.#raw || !markdown) detail.code(file.content.replace(/\n$/, ""), { path: file.path });
    else {
      const { frontmatter, body } = splitFrontmatter(file.content);
      if (frontmatter) detail.code(frontmatter, { lang: "yaml" });
      // Comment-only lines (the managed-file marker) render as nothing or literally.
      const shown = body.replace(/^[ \t]*<!--[^\n]*-->[ \t]*(?:\n|$)/gm, "").trim();
      if (shown) detail.markdown(shown);
    }
    return { key: `detail-file${index}`, heading: this.#paths[index] ?? file.path, groups: detail.done() };
  }

  protected nativeRole(): string {
    return "omp.overlay.roadmap.preview";
  }
}
