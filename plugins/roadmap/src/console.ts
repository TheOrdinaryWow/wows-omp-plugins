import { relative } from "node:path";

import {
  type Component,
  code,
  col,
  getMarkdownTheme,
  item,
  type KeyId,
  keyed,
  kv,
  Markdown,
  matchesKey,
  md,
  type NativeChild,
  type NativeNode,
  type NativeUiEvent,
  node,
  padding,
  routeSgrMouseInput,
  row as rowNode,
  type SgrMouseEvent,
  span,
  type Theme,
  type TUI,
  text as textNode,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import {
  bottomBorder,
  dividerSplit,
  editorKey,
  rawKeyHint,
  renderSegmentTrack,
  row,
  splitBodyWidth,
  splitRow,
  topBorder,
} from "@oh-my-pi/pi-tui/chrome";
import { leafKey } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, actionHint, hintsRow, itemIndex, type NativeHint, selectList } from "@oh-my-pi/pi-tui/native/overlay";

import { type AtlasStagePlan, type StageCoverage, stageCoverage } from "#src/atlas.ts";
import { type Model, overdue, type RoundDoc, type StageDoc, type StageStatus, type TodoItem, today } from "#src/documents.ts";
import { planLabel } from "#src/handoff.ts";
import { byId, plannedRoundCounts, roundActual, schedule, stageReadiness } from "#src/state.ts";
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
}

/** What the console asks the command to do: the status menu's actions plus the typed planning actions it offers by key. */
export type ConsoleAction = "check" | "close" | "close-round" | "new-round" | "plan-round" | "drop-round" | "retarget" | "upgrade";

/** `stage` names the stage to close or retarget; `round` the planned round to revise or drop, or the round to retarget. */
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

const SECTIONS: readonly ConsoleSection[] = ["stages", "rounds", "todos"];
const SECTION_LABELS: Readonly<Record<ConsoleSection, string>> = { stages: "Stages", rounds: "Rounds", todos: "Open TODOs" };
/** Rows per wheel notch, as in the host's fullscreen plan review. */
const WHEEL_ROWS = 3;
const LABEL_WIDTH = 10;
/** Below this many columns the frame cannot hold both panes; lines are clipped instead of overflowing. */
const MIN_FRAME_WIDTH = 24;

type Entry =
  | { kind: "stage"; id: string; title: string; stage: StageDoc }
  | { kind: "round"; id: string; title: string; round: RoundDoc }
  | { kind: "todo"; id: string; title: string; todo: TodoItem; round: string };

/** Theme colors a detail run may take; native spans read the same names as semantic tokens (`bold` as `strong`). */
type Ink = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "bold";
/** One run of styled text, painted with the theme for the terminal and sent as a span to Tern. */
type Run = string | { readonly t: string; readonly ink: Ink };
type Rich = string | readonly Run[];
/** A native text span (`TspSpan`): `s` holds the semantic tokens. */
type Span = { t: string; s?: string };
type Tone = NonNullable<NonNullable<NativeNode["p"]>["tone"]>;

/** A keyed command the console offers: one key hint in the terminal, one button in Tern. */
interface Command {
  act: string;
  key: KeyId;
  label: string;
  tone?: "accent" | "error";
}

function ink(t: string, color: Ink): Run {
  return { t, ink: color };
}

function paint(theme: Theme, value: Rich): string {
  if (typeof value === "string") return value;
  return value.map((run) => (typeof run === "string" ? run : run.ink === "bold" ? theme.bold(run.t) : theme.fg(run.ink, run.t))).join("");
}

function spans(value: Rich): Span[] {
  if (typeof value === "string") return [span(value)];
  return value.map((run) => (typeof run === "string" ? span(run) : span(run.t, run.ink === "bold" ? "strong" : run.ink)));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function statusRun(theme: Theme, status: StageStatus): Run {
  if (status === "closed") return ink(theme.status.success, "success");
  if (status === "active") return ink(theme.status.running, "accent");
  if (status === "dropped") return ink(theme.status.disabled, "muted");
  return ink(theme.status.pending, "dim");
}

function todoRun(theme: Theme, item: TodoItem): Run {
  if (item.severity === "high") return ink(theme.status.warning, "error");
  if (item.severity === "low") return ink(theme.status.info, "dim");
  return ink(theme.status.info, "warning");
}

const STATUS_TONES: Readonly<Record<StageStatus, Tone>> = { closed: "success", active: "accent", dropped: "muted", planned: "pending" };

function hintLines(hints: readonly string[], width: number): string[] {
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

/** Keeps the end of a path, which names the file, when the sidebar is too narrow for all of it. */
function truncateStart(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return truncateToWidth(text, width);
  const chars = [...text];
  let tail = "";
  for (let index = chars.length - 1; index >= 0; index--) {
    const next = `${chars[index]}${tail}`;
    if (visibleWidth(next) > width - 1) break;
    tail = next;
  }
  return `…${tail}`;
}

/** What a detail pane is written into: terminal rows ({@link DetailLines}) or native nodes ({@link NativeDetail}). */
interface DetailSink {
  heading(text: string): void;
  blank(): void;
  /** A bold line opening a group of rows. */
  subheading(text: string): void;
  text(value: Rich): void;
  field(label: string, value: Rich): void;
  /** One row per value: lists name items whose detail is elsewhere. The label shows on the first. */
  list(label: string, values: readonly Rich[]): void;
  section(title: string, body: string | undefined): void;
}

/** Field rows with a hanging indent, wrapped paragraphs and Markdown sections for a detail pane. */
class DetailLines implements DetailSink {
  readonly lines: string[] = [];

  constructor(
    readonly theme: Theme,
    readonly width: number,
    readonly markdown: (text: string, width: number) => readonly string[],
  ) {}

  heading(text: string): void {
    this.lines.push(...wrapTextWithAnsi(this.theme.bold(this.theme.fg("accent", text)), this.width));
  }

  blank(): void {
    this.lines.push("");
  }

  subheading(text: string): void {
    this.lines.push(this.theme.bold(text));
  }

  text(value: Rich): void {
    for (const paragraph of paint(this.theme, value).split("\n")) this.lines.push(...wrapTextWithAnsi(paragraph, this.width));
  }

  field(label: string, value: Rich): void {
    const painted = paint(this.theme, value);
    if (this.width < 30) {
      this.lines.push(...wrapTextWithAnsi(`${this.theme.fg("muted", label.padEnd(LABEL_WIDTH))}${painted}`, this.width));
      return;
    }
    const wrapped = wrapTextWithAnsi(painted, this.width - LABEL_WIDTH);
    for (const [index, line] of wrapped.entries())
      this.lines.push(`${index ? padding(LABEL_WIDTH) : this.theme.fg("muted", label.padEnd(LABEL_WIDTH))}${line}`);
  }

  /** Each row is cut to the pane. */
  list(label: string, values: readonly Rich[]): void {
    values.forEach((value, index) => {
      const head = index ? padding(LABEL_WIDTH) : this.theme.fg("muted", label.padEnd(LABEL_WIDTH));
      this.lines.push(truncateToWidth(`${head}${paint(this.theme, value)}`, this.width));
    });
  }

  section(title: string, body: string | undefined): void {
    if (!body?.trim()) return;
    this.lines.push("", this.theme.bold(title));
    this.lines.push(...this.markdown(body.trim(), this.width));
  }
}

/** The same detail as native nodes: consecutive fields and lists form one `kv` grid, sections render as Markdown. */
class NativeDetail implements DetailSink {
  readonly #nodes: NativeNode[] = [];
  #pairs: [string, Span[]][] = [];

  #flush(): void {
    const grid = kv(this.#pairs);
    if (grid) this.#nodes.push(keyed(grid, `kv${this.#nodes.length}`));
    this.#pairs = [];
  }

  #push(described: NativeNode): void {
    this.#flush();
    this.#nodes.push(keyed(described, `n${this.#nodes.length}`));
  }

  heading(text: string): void {
    this.#push(textNode([span(text, "accent strong")], { wrap: "word" }));
  }

  /** Native layout spaces the groups itself. */
  blank(): void {}

  subheading(text: string): void {
    this.#push(textNode([span(text, "strong")]));
  }

  text(value: Rich): void {
    this.#push(textNode(spans(value), { wrap: "word" }));
  }

  field(label: string, value: Rich): void {
    this.#pairs.push([label, spans(value)]);
  }

  list(label: string, values: readonly Rich[]): void {
    values.forEach((value, index) => {
      this.#pairs.push([index ? "" : label, spans(value)]);
    });
  }

  section(title: string, body: string | undefined): void {
    if (!body?.trim()) return;
    this.#push(col([textNode([span(title, "strong")]), md(body.trim())], { gap: "xs" }));
  }

  nodes(): NativeNode[] {
    this.#flush();
    return this.#nodes;
  }
}

/**
 * Fullscreen two-pane frame shared by the console and the preview: title bar, header rows, a selectable sidebar,
 * an independently scrolling detail pane, one message row and wrapped key hints. In Tern the same panes are
 * described natively inside a large glass sheet: the sidebar as a selectable list, the detail beside it, the
 * message and the key commands as buttons below.
 */
abstract class SplitPane implements Component {
  protected selected = 0;
  protected message: ConsoleMessage | undefined;
  #scroll = 0;
  #scrollMax = Number.MAX_SAFE_INTEGER;
  #bodyRows = 1;
  /** Last frame's geometry: mouse reports hit-test against what was painted. */
  #bodyTop = 0;
  #dividerCol = 0;
  readonly #markdown = new Map<string, Markdown>();
  #nativeOverlay: { head: string; props: NonNullable<Component["nativeOverlay"]> } | undefined;
  #nativeRoot: NativeNode | undefined;
  #nativeSignature: string | undefined;

  constructor(
    readonly theme: Theme,
    readonly tui: TUI,
  ) {}

  protected abstract count(): number;
  protected abstract title(): string;
  /** Rows between the title bar and the split, at most `width` columns each once truncated. */
  protected abstract header(width: number): string[];
  protected abstract sidebarRow(index: number, width: number): string;
  protected abstract emptySidebar(): string;
  protected abstract body(width: number): string[];
  protected abstract hints(): string[];
  /** Keys other than mouse reports and the shared navigation keys. */
  protected abstract handleKey(key: string): void;
  /** `omp.overlay.roadmap.<view>`: the role Tern styles the sheet by. */
  protected abstract nativeRole(): string;
  /** Every state describe() reads beyond the selection and the message, so an unchanged frame reuses its node. */
  protected abstract nativeSignature(): string;
  /** Nodes above the split. */
  protected abstract describeTop(): NativeChild[];
  /** Sidebar items, keyed `i<index>` like the rows they stand for. */
  protected abstract describeItems(): NativeNode[];
  /** Nodes above the sidebar list. */
  protected describeSidebarTop(): NativeChild[] {
    return [];
  }
  /** The selected item's detail, keyed by its identity so a new item starts at its top. */
  protected abstract describeBody(): NativeNode;
  /** Buttons below the panes; `null` end-aligns what follows. */
  protected abstract describeActions(): (NativeNode | null)[];
  protected abstract nativeHints(): (NativeHint | undefined)[];
  /** What Enter does on the selected row; a double click on a row does the same. */
  protected abstract activate(): void;
  /** A button's action, routed to the code path of the key it shows. */
  protected abstract handleAction(act: string): void;
  /** Selections on described lists other than the sidebar. */
  protected handleSelect(_list: string, _item: string): void {}

  protected select(index: number): void {
    const next = Math.max(0, Math.min(this.count() - 1, index));
    if (next === this.selected) return;
    this.selected = next;
    this.#scroll = 0;
    this.#scrollMax = Number.MAX_SAFE_INTEGER;
  }

  /** Jumps to `index` even when it equals the current row, so a changed list starts at the top of its detail. */
  protected reset(index: number): void {
    this.selected = Math.max(0, Math.min(this.count() - 1, index));
    this.#scroll = 0;
    this.#scrollMax = Number.MAX_SAFE_INTEGER;
  }

  protected markdown(text: string, width: number): readonly string[] {
    let component = this.#markdown.get(text);
    if (!component) {
      component = new Markdown(text, 0, 0, getMarkdownTheme());
      this.#markdown.set(text, component);
    }
    return component.render(width);
  }

  protected detail(width: number): DetailLines {
    return new DetailLines(this.theme, width, (text, at) => this.markdown(text, at));
  }

  #scrollBy(delta: number): void {
    this.#scroll = Math.max(0, Math.min(this.#scrollMax, this.#scroll + delta));
  }

  /** Wheel over the sidebar moves the selection, over the detail scrolls it; every other report is swallowed. */
  #handleMouse(event: SgrMouseEvent): void {
    if (event.wheel === null) return;
    const line = event.row - this.#bodyTop;
    if (line < 0 || line >= this.#bodyRows) return;
    if (event.col < this.#dividerCol) this.select(this.selected + event.wheel);
    else if (event.col > this.#dividerCol) this.#scrollBy(event.wheel * WHEEL_ROWS);
  }

  handleInput(key: string): void {
    // Checked before anything else: pointer motion must not clear the message or act as a key.
    if (
      routeSgrMouseInput(key, (event) => {
        this.#handleMouse(event);
        return true;
      })
    ) {
      this.tui.requestRender();
      return;
    }
    this.message = undefined;
    if (matchesKey(key, "up")) this.select(this.selected - 1);
    else if (matchesKey(key, "down")) this.select(this.selected + 1);
    else if (matchesKey(key, "home")) this.select(0);
    else if (matchesKey(key, "end")) this.select(this.count() - 1);
    else if (matchesKey(key, "pageDown")) this.#scrollBy(Math.max(1, this.#bodyRows - 2));
    else if (matchesKey(key, "pageUp")) this.#scrollBy(-Math.max(1, this.#bodyRows - 2));
    else this.handleKey(key);
    this.tui.requestRender();
  }

  /** Shared hints for the navigation keys this frame handles. */
  protected navigationHints(item: string): string[] {
    return [
      this.theme.fg("dim", `${editorKey("tui.select.up")}/${editorKey("tui.select.down")}`) + this.theme.fg("muted", ` ${item}`),
      this.theme.fg("dim", "PgDn/wheel") + this.theme.fg("muted", " scroll"),
    ];
  }

  /** The large glass sheet Tern wraps the view in, titled like the frame. */
  get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
    const head = this.title();
    if (this.#nativeOverlay?.head !== head)
      this.#nativeOverlay = { head, props: { role: this.nativeRole(), size: "lg", anchor: "center", head } };
    return this.#nativeOverlay.props;
  }

  describe(): NativeNode {
    const signature = [this.selected, this.message?.level ?? "", this.message?.text ?? "", this.nativeSignature()].join("\u0000");
    if (this.#nativeRoot && signature === this.#nativeSignature) return this.#nativeRoot;
    const sidebar = node(
      "col",
      { max: { w: "40ch" }, shrink: 0, gap: "sm" },
      [
        ...this.describeSidebarTop(),
        selectList("items", this.describeItems(), {
          selected: this.count() ? `i${this.selected}` : null,
          empty: [span(this.emptySidebar(), "dim")],
        }),
      ],
      "sidebar",
    );
    const body = node("col", { grow: 1, gap: "md" }, [this.describeBody()], "body");
    const children: NativeChild[] = [...this.describeTop(), keyed(rowNode([sidebar, body], { gap: "lg", align: "start" }), "split")];
    if (this.message)
      children.push(
        keyed(
          textNode([span(singleLine(this.message.text), this.message.level === "error" ? "error" : "info")], { wrap: "word" }),
          "message",
        ),
      );
    children.push(actionBar(this.describeActions()), hintsRow(this.nativeHints()));
    this.#nativeSignature = signature;
    // The sheet is the frame: a borderless column, titled by `nativeOverlay`.
    this.#nativeRoot = col(children, { gap: "md" });
    return this.#nativeRoot;
  }

  /** Pointer actions run what the keys run: a row click selects it, a double click is Enter, a button its key. */
  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action") {
      this.message = undefined;
      this.handleAction(event.act);
      return;
    }
    if (event.type !== "select" && event.type !== "activate") return;
    this.message = undefined;
    const list = leafKey(event.key);
    if (list !== "items") {
      this.handleSelect(list, event.item);
      return;
    }
    const index = itemIndex(event.item, "i");
    if (index < 0 || index >= this.count()) return;
    this.select(index);
    if (event.type === "activate") this.activate();
  }

  render(width: number): readonly string[] {
    const t = this.theme;
    const height = Math.max(12, this.tui.terminal?.rows || process.stdout.rows || 40);
    const frameWidth = Math.max(width, MIN_FRAME_WIDTH);
    const inner = frameWidth - 4;
    let sidebarWidth = Math.max(18, Math.min(52, Math.floor(frameWidth * 0.36)));
    if (splitBodyWidth(frameWidth, sidebarWidth) < 16) sidebarWidth = Math.max(4, Math.floor((frameWidth - 7) / 2));
    const bodyWidth = Math.max(1, splitBodyWidth(frameWidth, sidebarWidth));
    const header = this.header(inner);
    // Short terminals keep most rows for the panes: hints get at most a third, dropped from the end.
    const hints = hintLines(this.hints(), inner).slice(0, Math.max(1, Math.floor((height - header.length - 5) / 3)));
    const message = this.message
      ? t.fg(this.message.level === "error" ? "error" : "warning", truncateToWidth(singleLine(this.message.text), inner))
      : "";

    // Title, header, split rule, body, closing rule, message, hints and bottom border fill the terminal.
    this.#bodyRows = Math.max(3, height - header.length - hints.length - 5);
    this.#bodyTop = 1 + header.length + 1;
    this.#dividerCol = sidebarWidth + 3;
    const body = this.body(bodyWidth);
    this.#scrollMax = Math.max(0, body.length - this.#bodyRows);
    this.#scroll = Math.min(this.#scroll, this.#scrollMax);
    const shown = body.slice(this.#scroll, this.#scroll + this.#bodyRows);
    // The notice replaces the last visible line, so that line counts as hidden too.
    const more = body.length - this.#scroll - shown.length + 1;
    if (more > 1 && shown.length) shown[shown.length - 1] = t.fg("dim", `+${more} more lines; PgDn/wheel to scroll`);

    const total = this.count();
    let sidebar: string[];
    if (!total) sidebar = wrapTextWithAnsi(t.fg("dim", this.emptySidebar()), sidebarWidth);
    else {
      const start = Math.max(0, Math.min(this.selected - Math.floor(this.#bodyRows / 2), total - this.#bodyRows));
      sidebar = Array.from({ length: Math.min(this.#bodyRows, total - start) }, (_, offset) =>
        truncateToWidth(this.sidebarRow(start + offset, sidebarWidth), sidebarWidth),
      );
    }

    const box = t.boxRound;
    const splitOpen = t.fg(
      "border",
      box.teeRight +
        box.horizontal.repeat(sidebarWidth + 2) +
        box.teeDown +
        box.horizontal.repeat(Math.max(0, frameWidth - sidebarWidth - 5)) +
        box.teeLeft,
    );
    const lines = [
      topBorder(frameWidth, this.title()),
      ...header.map((line) => row(truncateToWidth(line, inner), frameWidth)),
      splitOpen,
      ...Array.from({ length: this.#bodyRows }, (_, index) =>
        splitRow(sidebar[index] ?? "", truncateToWidth(shown[index] ?? "", bodyWidth), frameWidth, sidebarWidth),
      ),
      dividerSplit(frameWidth, sidebarWidth),
      row(message, frameWidth),
      ...hints.map((line) => row(line, frameWidth)),
      bottomBorder(frameWidth),
    ];
    return frameWidth === width ? lines : lines.map((line) => truncateToWidth(line, Math.max(0, width)));
  }
}

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
  #section: ConsoleSection;
  #query: string;
  #visible: Entry[] = [];
  #finished = false;

  constructor(
    readonly model: Model,
    state: ConsoleState,
    theme: Theme,
    tui: TUI,
    readonly done: (choice: ConsoleChoice | undefined) => void,
    readonly plans?: StagePlans,
  ) {
    super(theme, tui);
    this.#on = state.on ?? today();
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
    return this.model.stages
      .filter((stage) => stage.round === this.#stageRound)
      .sort(byId)
      .map((stage) => ({ kind: "stage", id: stage.id, title: stage.title, stage }));
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

  /** Revising or dropping acts on the planned round selected in Rounds. */
  #onPlannedRound(action: "plan-round" | "drop-round", verb: string): void {
    const entry = this.#current();
    if (entry?.kind === "round" && entry.round.status === "planned") this.#choose({ action, round: entry.id });
    else this.message = { text: `Select a planned round in Rounds to ${verb} it`, level: "info" };
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

  protected handleKey(key: string): void {
    if (matchesKey(key, "escape")) this.#escape();
    else if (matchesKey(key, "tab") || matchesKey(key, "shift+tab")) {
      const step = matchesKey(key, "tab") ? 1 : SECTIONS.length - 1;
      this.#switchTo(SECTIONS[(SECTIONS.indexOf(this.#section) + step) % SECTIONS.length] as ConsoleSection);
    } else if (matchesKey(key, "enter")) this.#primary();
    else if (key === "C" || matchesKey(key, "shift+c")) this.handleAction("check");
    else if (key === "X" || matchesKey(key, "shift+x")) this.handleAction("close-stage");
    else if (key === "R" || matchesKey(key, "shift+r")) this.handleAction("close-round");
    else if (key === "N" || matchesKey(key, "shift+n")) this.handleAction("new-round");
    else if (key === "P" || matchesKey(key, "shift+p")) this.handleAction("plan-round");
    else if (key === "E" || matchesKey(key, "shift+e")) this.handleAction("revise");
    else if (key === "D" || matchesKey(key, "shift+d")) this.handleAction("drop");
    else if (key === "T" || matchesKey(key, "shift+t")) this.handleAction("retarget");
    else if (key === "U" || matchesKey(key, "shift+u")) this.handleAction("upgrade");
    else if (matchesKey(key, "backspace")) {
      if (!this.#query) return;
      this.#query = [...this.#query].slice(0, -1).join("");
      this.#refilter(this.#current()?.id);
    } else if ([...key].length === 1 && !/[\p{Cc}]/u.test(key)) {
      this.#query += key;
      this.#refilter(this.#current()?.id);
    }
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

  #summary(): Run[] {
    const round = this.#active;
    const planned = this.model.rounds.filter((candidate) => candidate.status === "planned").length;
    const open = this.#entries.todos.length;
    let parts: Run[][];
    if (round) {
      const stages = this.#activeStages();
      const settled = stages.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
      const late = stages.filter((stage) => overdue(stage, this.#on)).length;
      const dates = schedule(round, roundActual(round), this.#on);
      parts = [
        [statusRun(this.theme, round.status), " ", ink(`${round.id} ${round.title}`, "bold")],
        [`${settled}/${plural(stages.length, "stage")} settled`],
        [plural(open, "open TODO")],
        ...(dates ? [[dates]] : []),
        ...(late ? [[ink(plural(late, "overdue stage"), "warning")]] : []),
        ...(planned ? [[plural(planned, "planned round")]] : []),
      ];
    } else {
      const last = this.model.rounds
        .filter((candidate) => candidate.status !== "planned")
        .sort(byId)
        .at(-1);
      parts = [
        [last ? `No active round (last: ${last.id} ${last.title}, ${last.status})` : planned ? "No active round" : "No rounds yet"],
        ...(planned ? [[plural(planned, "planned round")]] : []),
        ...(open ? [[plural(open, "open TODO")]] : []),
      ];
    }
    const runs = parts.flatMap((part, index) => (index ? [" · ", ...part] : part));
    if (this.model.index.format === 1) runs.push(ink(" · format 1", "dim"));
    return runs;
  }

  /** Section labels with their sizes; Stages names its round once Enter on another round chose it. */
  #sectionLabel(section: ConsoleSection): string {
    const label =
      section === "stages" && this.#stageRound && this.#stageRound !== this.#active?.id
        ? `Stages ${this.#stageRound}`
        : SECTION_LABELS[section];
    return `${label} ${this.#entries[section].length}`;
  }

  #search(): Run[] {
    return this.#query
      ? [`Search: ${this.#query}`, ink(`  ${this.#visible.length}/${this.#entries[this.#section].length}`, "dim")]
      : [ink("Type to search", "dim")];
  }

  protected header(width: number): string[] {
    const tabs = renderSegmentTrack(
      SECTIONS.map((section) => ({ label: this.#sectionLabel(section) })),
      SECTIONS.indexOf(this.#section),
    );
    // Long round titles wrap onto a second row rather than hiding the counts.
    return [...wrapTextWithAnsi(paint(this.theme, this.#summary()), width).slice(0, 2), `${tabs}  ${paint(this.theme, this.#search())}`];
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

  #markRun(entry: Entry): Run {
    if (entry.kind === "stage") return statusRun(this.theme, entry.stage.status);
    if (entry.kind === "round") return statusRun(this.theme, entry.round.status);
    return todoRun(this.theme, entry.todo);
  }

  #late(entry: Entry): boolean {
    return entry.kind === "stage" ? overdue(entry.stage, this.#on) : entry.kind === "round" ? overdue(entry.round, this.#on) : false;
  }

  protected sidebarRow(index: number, width: number): string {
    const t = this.theme;
    const entry = this.#visible[index] as Entry;
    const isSelected = index === this.selected;
    const cursorWidth = visibleWidth(t.nav.cursor) + 1;
    const cursor = isSelected ? t.fg("accent", `${t.nav.cursor} `) : padding(cursorWidth);
    // Preset glyphs differ in cell width (unicode ✔ vs ascii [ok]); pad them to one column.
    const markWidth = Math.max(1, ...this.#visible.map((candidate) => visibleWidth(paint(t, [this.#markRun(candidate)]))));
    const mark = paint(t, [this.#markRun(entry)]);
    const idWidth = Math.max(0, ...this.#visible.map((candidate) => candidate.id.length));
    const prefix = `${cursor}${mark}${padding(markWidth - visibleWidth(mark))} ${t.fg("muted", entry.id.padEnd(idWidth))} `;
    const tail = this.#late(entry) ? ` ${t.fg("warning", t.status.warning)}` : "";
    const titleWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(tail));
    const title = t.fg(isSelected ? "accent" : "text", truncateToWidth(singleLine(entry.title), titleWidth));
    return `${prefix}${title}${tail}`;
  }

  /** The keyed commands that apply to the current item, in hint order; the first is Enter when an item is selected. */
  #commands(): Command[] {
    const entry = this.#current();
    const round = this.#active;
    const planned = entry?.kind === "round" && entry.round.status === "planned" ? entry.id : undefined;
    const enter = entry?.kind === "todo" ? "go to target" : entry?.kind === "stage" ? "its round" : "its stages";
    return [
      ...(entry ? [{ act: "primary", key: "enter", label: enter } as const] : []),
      ...(entry?.kind === "stage" && entry.stage.status === "active"
        ? [{ act: "close-stage", key: "shift+x", label: "close stage" } as const]
        : []),
      ...(planned
        ? [
            { act: "revise", key: "shift+e", label: `revise ${planned}` } as const,
            { act: "drop", key: "shift+d", label: `drop ${planned}`, tone: "error" } as const,
          ]
        : []),
      ...(this.#retargetable() ? [{ act: "retarget", key: "shift+t", label: "target date" } as const] : []),
      ...(round && this.#roundSettled()
        ? [{ act: "close-round", key: "shift+r", label: `close ${round.id}`, tone: "accent" } as const]
        : []),
      ...(!round
        ? [
            {
              act: "new-round",
              key: "shift+n",
              label: this.#nextPlanned ? `activate ${this.#nextPlanned.id}` : "new round",
              tone: "accent",
            } as const,
          ]
        : []),
      { act: "plan-round", key: "shift+p", label: "plan a round" },
      ...(this.model.index.format === 1 ? [{ act: "upgrade", key: "shift+u", label: "upgrade to format 2" } as const] : []),
      { act: "check", key: "shift+c", label: "check" },
    ];
  }

  protected hints(): string[] {
    const commands = this.#commands();
    const [first, ...rest] = commands;
    const primary = first?.act === "primary" ? [first] : [];
    const others = first?.act === "primary" ? rest : commands;
    return [
      ...this.navigationHints("select"),
      ...primary.map((command) => rawKeyHint(command.key, command.label)),
      rawKeyHint("tab", "section"),
      ...others.map((command) => rawKeyHint(command.key, command.label)),
      rawKeyHint("escape", this.#query ? "clear search" : "close"),
    ];
  }

  protected body(width: number): string[] {
    const entry = this.#current();
    if (!entry) return [this.theme.fg("dim", "Nothing selected")];
    const detail = this.detail(width);
    this.#detail(detail, entry);
    return detail.lines;
  }

  #detail(detail: DetailSink, entry: Entry): void {
    if (entry.kind === "stage") this.#stageDetail(detail, entry.stage);
    else if (entry.kind === "round") this.#roundDetail(detail, entry.round);
    else this.#todoDetail(detail, entry.todo, entry.round);
  }

  #stageLine(stage: StageDoc): Run[] {
    return [statusRun(this.theme, stage.status), ` ${stage.id} ${singleLine(stage.title)}`];
  }

  #openTodos(target: string): Run[][] {
    return this.#entries.todos.flatMap((entry) =>
      entry.kind === "todo" && entry.todo.target === target
        ? [
            [
              todoRun(this.theme, entry.todo),
              ` ${entry.id} ${singleLine(entry.title)}`,
              ink(` · ${entry.todo.severity ?? "normal"}`, "dim"),
            ],
          ]
        : [],
    );
  }

  #stagePlans(stage: string): readonly AtlasStagePlan[] | undefined {
    if (!this.#plans.has(stage)) this.#plans.set(stage, this.plans?.(stage));
    return this.#plans.get(stage);
  }

  #stageDetail(detail: DetailSink, stage: StageDoc): void {
    const t = this.theme;
    detail.heading(`${stage.id} — ${stage.title}`);
    detail.blank();
    const readiness = stageReadiness(this.model, stage);
    const ready = readiness.startable
      ? [ink(" · ready to start", "success")]
      : readiness.blockedBy.length
        ? [ink(` · blocked by ${readiness.blockedBy.join(", ")}`, "warning")]
        : [];
    detail.field("Status", [statusRun(t, stage.status), ` ${stage.status}`, ...ready]);
    const round = this.model.rounds.find((candidate) => candidate.id === stage.round);
    detail.field("Round", round ? `${round.id} ${singleLine(round.title)} [${round.status}]` : stage.round);
    if (stage.target) detail.field("Target", [stage.target, ...(overdue(stage, this.#on) ? [ink(" · overdue", "warning")] : [])]);
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
    detail.list("Depends", dependencies.length ? dependencies : [t.format.dash]);
    if (stage.follows) detail.field("Follows", stage.follows);
    const adrs = (this.model.adrs?.records ?? [])
      .filter((record) => record.stage === stage.id)
      .sort(byId)
      .map((record) => [
        `${record.id} ${singleLine(record.title)}`,
        ink(` · ${record.status}`, record.status === "proposed" ? "warning" : "dim"),
      ]);
    if (adrs.length) detail.list("ADRs", adrs);
    const todos = this.#openTodos(stage.id);
    detail.list("TODOs", todos.length ? todos : [[ink("none open", "dim")]]);
    detail.field("File", [ink(this.model.repo ? relative(this.model.repo.repoRoot, stage.path) : stage.path, "dim")]);
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
  #plansDetail(detail: DetailSink, stage: StageDoc): void {
    const plans = this.#stagePlans(stage.id);
    if (!plans) return;
    const t = this.theme;
    detail.blank();
    detail.subheading("Atlas plans");
    let coverage: StageCoverage;
    try {
      coverage = stageCoverage(stage, plans);
    } catch (error) {
      detail.text([ink(`Coverage unavailable: ${error instanceof Error ? error.message : String(error)}`, "error")]);
      return;
    }
    if (!plans.length) detail.text([ink("No Atlas plan is bound to this stage yet", "dim")]);
    for (const plan of plans) {
      const mark = plan.status === "complete" ? ink(t.status.success, "success") : ink(t.status.running, "accent");
      const declared = plan.criteria ? plan.criteria.join(", ") : "coverage undeclared";
      const drift = coverage.drifted.includes(plan) ? [ink(" · drift", "warning")] : [];
      detail.text([mark, ` ${planLabel(plan)}`, ink(` · ${plan.status} · ${plan.done}/${plan.total} rows · ${declared}`, "dim"), ...drift]);
    }
    for (const entry of coverage.criteria) {
      detail.field(entry.id, [
        entry.complete.length
          ? ink(`covered by complete ${entry.complete.map(planLabel).join(", ")}`, "success")
          : entry.unfinished.length
            ? ink(`only by unfinished ${entry.unfinished.map(planLabel).join(", ")}`, "warning")
            : ink("uncovered", "error"),
      ]);
    }
    if (coverage.undeclared.length)
      detail.text([ink(`Coverage undeclared by ${coverage.undeclared.map(planLabel).join(", ")}; check their scope`, "warning")]);
    if (coverage.drifted.length)
      detail.text([
        ink(
          `Drift: ${coverage.drifted.map(planLabel).join(", ")} approved before the objective, scope, criteria or design constraints changed`,
          "warning",
        ),
      ]);
  }

  #roundDetail(detail: DetailSink, round: RoundDoc): void {
    const t = this.theme;
    detail.heading(`${round.id} — ${round.title}`);
    detail.blank();
    detail.field("Status", [
      statusRun(t, round.status),
      ` ${round.status}`,
      ...(round === this.#nextPlanned ? [ink(" · next to activate", "dim")] : []),
    ]);
    if (round.target) detail.field("Target", [round.target, ...(overdue(round, this.#on) ? [ink(" · overdue", "warning")] : [])]);
    const actual = roundActual(round);
    if (actual) detail.field("Dates", actual);
    detail.field("File", [ink(this.model.repo ? relative(this.model.repo.repoRoot, round.path) : round.path, "dim")]);
    const stages = this.model.stages.filter((stage) => stage.round === round.id).sort(byId);
    const settled = stages.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
    detail.field("Stages", stages.length ? `${settled}/${stages.length} settled` : [ink("none yet", "dim")]);
    detail.list(
      "",
      stages.map((stage) => [...this.#stageLine(stage), ...(overdue(stage, this.#on) ? [ink(" · overdue", "warning")] : [])]),
    );
    const { openTodos } = plannedRoundCounts(this.model, round.id);
    detail.field("TODOs", openTodos ? `${openTodos} open` : [ink("none open", "dim")]);
    detail.section("Goal", round.goal);
    detail.section("Constraints", round.constraints);
    detail.section("Non-goals", round.non_goals);
    detail.section("Principles", round.principles);
    detail.section("Known limitations", round.known_limitations);
    detail.section("Outcome", round.outcome);
  }

  #todoDetail(detail: DetailSink, item: TodoItem, round: string): void {
    detail.heading(`${item.id} — ${item.title}`);
    detail.blank();
    detail.field("Status", [todoRun(this.theme, item), ` ${item.status} · ${item.severity ?? "normal"} severity`]);
    const owner = this.model.rounds.find((candidate) => candidate.id === round);
    detail.field("Round", owner ? `${owner.id} ${singleLine(owner.title)} [${owner.status}]` : round);
    if (item.target) {
      const stage = this.model.stages.find((candidate) => candidate.id === item.target);
      detail.field("Target", stage ? [...this.#stageLine(stage), ink(` · ${stage.round}`, "dim")] : item.target);
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

  protected nativeSignature(): string {
    return [this.#section, this.#query, this.#stageRound ?? ""].join("\u0000");
  }

  protected describeTop(): NativeChild[] {
    const tabs = node(
      "tabs",
      {
        items: SECTIONS.map((section) => ({ id: section, label: this.#sectionLabel(section) })),
        active: this.#section,
        actions: { click: "select" },
      },
      undefined,
      "sections",
    );
    return [keyed(textNode(spans(this.#summary()), { wrap: "word" }), "summary"), tabs];
  }

  protected override describeSidebarTop(): NativeChild[] {
    return [keyed(textNode(spans(this.#search())), "search")];
  }

  /** Atlas plan coverage of a stage's done criteria as list badges; nothing without an answer from omo-prometheus. */
  #coverageBadges(stage: StageDoc): Run[] {
    const plans = this.#stagePlans(stage.id);
    if (!plans?.length) return [];
    let coverage: StageCoverage;
    try {
      coverage = stageCoverage(stage, plans);
    } catch {
      return [ink("coverage unavailable", "error")];
    }
    const total = coverage.criteria.length;
    const covered = coverage.criteria.filter((entry) => entry.complete.length).length;
    return [
      ...(total ? [ink(`${covered}/${total} covered`, covered === total ? "success" : "warning")] : []),
      ...(coverage.drifted.length ? [ink("drift", "warning")] : []),
    ];
  }

  /** One line under a row's title: a planned stage's readiness, a round's progress, a TODO's severity and target. */
  #itemDetail(entry: Entry): Run[] | undefined {
    if (entry.kind === "stage") {
      if (entry.stage.status !== "planned") return undefined;
      const readiness = stageReadiness(this.model, entry.stage);
      if (readiness.startable) return [ink("ready to start", "success")];
      return readiness.blockedBy.length ? [ink(`blocked by ${readiness.blockedBy.join(", ")}`, "warning")] : undefined;
    }
    if (entry.kind === "round") {
      const stages = this.model.stages.filter((stage) => stage.round === entry.id);
      const settled = stages.filter((stage) => stage.status === "closed" || stage.status === "dropped").length;
      return [
        ink(`${settled}/${plural(stages.length, "stage")} settled`, "dim"),
        ...(entry.round === this.#nextPlanned ? [ink(" · next to activate", "dim")] : []),
      ];
    }
    const where = entry.todo.target ?? (entry.todo.trigger ? `trigger: ${singleLine(entry.todo.trigger)}` : undefined);
    return [ink(`${entry.todo.severity ?? "normal"}${where ? ` · ${where}` : ""}`, "dim")];
  }

  protected describeItems(): NativeNode[] {
    return this.#visible.map((entry, index) => {
      const badges = [
        ...(this.#late(entry) ? [ink("overdue", "warning")] : []),
        ...(entry.kind === "stage" ? this.#coverageBadges(entry.stage) : []),
      ];
      const detail = this.#itemDetail(entry);
      return item(`i${index}`, {
        label: spans([this.#markRun(entry), " ", ink(entry.id, "muted"), ` ${singleLine(entry.title)}`]),
        ...(detail ? { detail: spans(detail) } : {}),
        ...(badges.length ? { value: spans(badges.flatMap((badge, at) => (at ? [" ", badge] : [badge]))) } : {}),
        tone:
          entry.kind === "stage"
            ? STATUS_TONES[entry.stage.status]
            : entry.kind === "round"
              ? STATUS_TONES[entry.round.status]
              : entry.todo.severity === "high"
                ? "error"
                : entry.todo.severity === "low"
                  ? "muted"
                  : "warning",
      });
    });
  }

  protected describeBody(): NativeNode {
    const entry = this.#current();
    if (!entry) return keyed(textNode([span("Nothing selected", "dim")]), "detail");
    const detail = new NativeDetail();
    this.#detail(detail, entry);
    return keyed(col(detail.nodes(), { gap: "md" }), `detail-${entry.kind}-${entry.id}`);
  }

  protected describeActions(): (NativeNode | null)[] {
    return [
      ...this.#commands().map((command) =>
        actionButton(`${command.label.charAt(0).toUpperCase()}${command.label.slice(1)}`, command.act, {
          keys: command.key,
          ...(command.tone ? { tone: command.tone } : {}),
        }),
      ),
      null,
      actionButton(this.#query ? "Clear search" : "Close", "close", { keys: "escape" }),
    ];
  }

  protected nativeHints(): (NativeHint | undefined)[] {
    return [actionHint(["tui.select.up", "tui.select.down"], "select"), { keys: ["tab", "shift+tab"], label: "section" }];
  }
}

/** Frontmatter stays plain so the YAML that will be written reads exactly; the rest renders as Markdown. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content);
  return match ? { frontmatter: match[0].trimEnd(), body: content.slice(match[0].length) } : { frontmatter: "", body: content };
}

/**
 * Fullscreen write preview: the write and cancel actions around the repo-relative file list on the left, the selected
 * file on the right. Resolves true to write every file and false to write nothing.
 */
export class PreviewView extends SplitPane {
  #raw = false;
  #finished = false;
  readonly #paths: string[];

  constructor(
    readonly preview: PreviewRequest,
    theme: Theme,
    tui: TUI,
    readonly done: (answer: boolean) => void,
  ) {
    super(theme, tui);
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

  /** Enter: the Write row writes, the Cancel row cancels, a file row explains. */
  #enter(): void {
    if (this.selected === 0) this.#answer(true);
    else if (this.selected === this.count() - 1) this.#answer(false);
    else this.message = { text: "Shift+W or the Write row writes every file; Esc cancels", level: "info" };
  }

  protected handleKey(key: string): void {
    if (matchesKey(key, "escape")) this.#answer(false);
    else if (key === "W" || matchesKey(key, "shift+w")) this.#answer(true);
    else if (matchesKey(key, "enter")) this.#enter();
    else if ((matchesKey(key, "space") || key === " ") && this.#file() !== undefined) this.#raw = !this.#raw;
  }

  protected handleAction(act: string): void {
    if (act === "write") this.#answer(true);
    else if (act === "cancel") this.#answer(false);
    else if (act === "raw" && this.#file() !== undefined) this.#raw = !this.#raw;
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

  protected header(): string[] {
    return [this.theme.bold(this.#headline())];
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

  protected sidebarRow(index: number, width: number): string {
    const t = this.theme;
    const isSelected = index === this.selected;
    const cursor = isSelected ? t.fg("accent", `${t.nav.cursor} `) : padding(visibleWidth(t.nav.cursor) + 1);
    const marks = [t.fg("success", t.status.success), t.fg("error", t.status.error)];
    const markWidth = Math.max(...marks.map((mark) => visibleWidth(mark)));
    const style = (text: string): string => t.fg(isSelected ? "accent" : "text", text);
    if (index === 0) return `${cursor}${marks[0]}${padding(markWidth - visibleWidth(marks[0] as string))} ${style(this.#writeLabel())}`;
    if (index === this.count() - 1)
      return `${cursor}${marks[1]}${padding(markWidth - visibleWidth(marks[1] as string))} ${style("Cancel")}`;
    const prefix = `${cursor}${padding(markWidth + 1)}`;
    return `${prefix}${style(truncateStart(this.#paths[index - 1] ?? "", Math.max(1, width - visibleWidth(prefix))))}`;
  }

  protected hints(): string[] {
    const onFile = this.#file() !== undefined;
    return [
      ...this.navigationHints("file"),
      ...(this.selected === 0 ? [rawKeyHint("enter", "write")] : this.selected === this.count() - 1 ? [rawKeyHint("enter", "cancel")] : []),
      rawKeyHint("shift+w", "write all"),
      ...(onFile ? [rawKeyHint("space", this.#raw ? "rendered" : "raw text")] : []),
      rawKeyHint("escape", "cancel"),
    ];
  }

  protected body(width: number): string[] {
    const t = this.theme;
    const detail = this.detail(width);
    const index = this.#file();
    if (index === undefined) {
      if (this.selected === 0) {
        detail.text(this.preview.title);
        detail.blank();
        detail.lines.push(t.bold("Files"));
        this.#paths.forEach((path, at) => {
          detail.lines.push(...wrapTextWithAnsi(`${path}${t.fg("dim", ` · ${plural(this.#lines(at), "line")}`)}`, width));
        });
        detail.blank();
        detail.lines.push(...wrapTextWithAnsi(t.fg("dim", "Enter or Shift+W writes every file. Esc cancels and writes nothing."), width));
      } else detail.lines.push(...wrapTextWithAnsi(t.fg("dim", "Enter cancels: nothing is written."), width));
      return detail.lines;
    }
    const file = this.preview.files[index] as PreviewFile;
    detail.heading(this.#paths[index] ?? file.path);
    detail.lines.push(t.fg("dim", this.#raw ? "Raw text" : "Rendered; Space shows the raw text"));
    detail.blank();
    if (this.#raw || !/\.md$/i.test(file.path)) {
      for (const line of file.content.replace(/\n$/, "").split("\n")) detail.lines.push(...wrapTextWithAnsi(line, width));
      return detail.lines;
    }
    const { frontmatter, body } = splitFrontmatter(file.content);
    for (const line of frontmatter ? frontmatter.split(/\r?\n/) : []) detail.lines.push(...wrapTextWithAnsi(t.fg("dim", line), width));
    if (frontmatter) detail.blank();
    // The managed-file comment renders as nothing; drop the blank rows it leaves before the title.
    const rendered = body.trim() ? this.markdown(body.trim(), width) : [];
    detail.lines.push(
      ...rendered.slice(
        Math.max(
          0,
          rendered.findIndex((line) => Bun.stripANSI(line).trim() !== ""),
        ),
      ),
    );
    return detail.lines;
  }

  protected nativeRole(): string {
    return "omp.overlay.roadmap.preview";
  }

  protected nativeSignature(): string {
    return String(this.#raw);
  }

  protected describeTop(): NativeChild[] {
    return [keyed(textNode([span(this.#headline(), "strong")], { wrap: "word" }), "headline")];
  }

  protected describeItems(): NativeNode[] {
    const t = this.theme;
    return [
      item("i0", { label: [span(t.status.success, "success"), span(` ${this.#writeLabel()}`)], tone: "success" }),
      ...this.#paths.map((path, at) =>
        item(`i${at + 1}`, { label: [span(path, "path")], detail: [span(plural(this.#lines(at), "line"), "dim")] }),
      ),
      item(`i${this.count() - 1}`, { label: [span(t.status.error, "error"), span(" Cancel")], tone: "error" }),
    ];
  }

  /** The Write row lists what is written; a file shows as Markdown (frontmatter as YAML) or, raw or not Markdown, as code. */
  protected describeBody(): NativeNode {
    const index = this.#file();
    if (index === undefined) {
      if (this.selected !== 0) return keyed(textNode([span("Cancel writes nothing.", "dim")], { wrap: "word" }), "detail-cancel");
      const files = kv(this.#paths.map((path, at) => [path, [span(plural(this.#lines(at), "line"), "dim")]] as const));
      return keyed(
        col(
          [
            textNode(this.preview.title, { wrap: "word" }),
            ...(files ? [files] : []),
            textNode([span("Write writes every file. Cancel writes nothing.", "dim")], { wrap: "word" }),
          ],
          { gap: "md" },
        ),
        "detail-write",
      );
    }
    const file = this.preview.files[index] as PreviewFile;
    const path = this.#paths[index] ?? file.path;
    const children: NativeNode[] = [textNode([span(path, "accent strong path")], { wrap: "char" })];
    if (this.#raw || !/\.md$/i.test(file.path)) children.push(code(file.content.replace(/\n$/, ""), { path: file.path, wrap: true }));
    else {
      const { frontmatter, body } = splitFrontmatter(file.content);
      if (frontmatter) children.push(code(frontmatter, { lang: "yaml" }));
      if (body.trim()) children.push(md(body.trim()));
    }
    return keyed(col(children, { gap: "md" }), `detail-file${index}`);
  }

  protected describeActions(): (NativeNode | null)[] {
    const onMarkdown = this.#file() !== undefined && /\.md$/i.test(this.preview.files[this.#file() as number]?.path ?? "");
    return [
      actionButton(this.#writeLabel(), "write", { keys: "shift+w", tone: "accent" }),
      ...(onMarkdown ? [actionButton(this.#raw ? "Rendered" : "Raw text", "raw", { keys: "space" })] : []),
      null,
      actionButton("Cancel", "cancel", { keys: "escape" }),
    ];
  }

  protected nativeHints(): (NativeHint | undefined)[] {
    return [actionHint(["tui.select.up", "tui.select.down"], "file"), actionHint("tui.select.confirm", "write or cancel on its row")];
  }
}
