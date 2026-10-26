import {
  type Component,
  col,
  compact,
  type DescribeContext,
  elapsed as elapsedNode,
  getMarkdownTheme,
  getSelectListTheme,
  item as itemNode,
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
  text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import {
  bottomBorder,
  dividerSplit,
  editorKey,
  OverlayPanel,
  PanelDivider,
  PanelRows,
  rawKeyHint,
  renderSegmentTrack,
  row,
  splitBodyWidth,
  splitRow,
  topBorder,
} from "@oh-my-pi/pi-tui/chrome";
import { type SelectItem, SelectList, type SelectListRenderItemContext } from "@oh-my-pi/pi-tui/components/select-list";
import { Memo } from "@oh-my-pi/pi-tui/native/memo";
import { leafKey, type NativeScroll, type TspSpan } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, actionHint, hintsRow, itemIndex, selectList } from "@oh-my-pi/pi-tui/native/overlay";
import { formatNumber } from "@oh-my-pi/pi-utils";

import type { AtlasLive, AtlasLiveRow, AtlasLiveSnapshot } from "./atlas-live.ts";
import type { AtlasPlanDetail, AtlasRowDetail } from "./atlas-store.ts";
import type { AtlasEvent } from "./atlas-timeline.ts";
import type { OwnerRuling } from "./ledger.ts";

export type AtlasFilter = "unfinished" | "all";
export type AtlasDispatch = "start" | "resume";
export type AtlasMenuAction = {
  kind: AtlasDispatch | "inspect" | "delete" | "rename" | "cancel";
  planId?: string;
  filter: AtlasFilter;
  query: string;
};
export type AtlasPlanViewAction = AtlasDispatch | "exit" | "back";
/** `dispatch` can start/resume, `display` explains why it cannot, `active` is the running plan: read-only plus exit. */
export type AtlasPlanViewMode = "dispatch" | "display" | "active";

const TITLE = "Atlas Dispatch";
const FILTERS: AtlasFilter[] = ["unfinished", "all"];
const FILTER_LABELS: Record<AtlasFilter, string> = { unfinished: "Unfinished", all: "All" };
const LIST_ROWS = 8;
const PREVIEW_ROWS = 10;
const BAR_WIDTH = 10;
/** Rows per wheel notch, as in the host's fullscreen plan review. */
const WHEEL_ROWS = 3;
/** Tern shows both consoles as large glass sheets; it styles the `omp.overlay.*` roles itself. */
const MENU_OVERLAY: NonNullable<Component["nativeOverlay"]> = {
  role: "omp.overlay.omoPrometheus.dispatch",
  size: "lg",
  anchor: "center",
  head: TITLE,
};
const PLAN_OVERLAY_ROLE = "omp.overlay.omoPrometheus.plan";
const VIEW_TABS = [
  { id: "row", label: "Row" },
  { id: "timeline", label: "Timeline" },
];
/** Menu buttons that act on the highlighted plan, as their keys do. */
const MENU_PLAN_ACTIONS: readonly string[] = ["start", "resume", "inspect", "delete", "rename"] satisfies AtlasMenuAction["kind"][];
const EMPTY_TEXT = "No plans in this view; press Tab for All";
const NO_MATCH_TEXT = "No plans match the search";

/** Why a plan cannot be started or resumed from here; undefined when it can. */
export function dispatchBlock(detail: AtlasPlanDetail, kind: AtlasDispatch, displayOnly: boolean): string | undefined {
  if (displayOnly) return "All is display-only; press Tab for Unfinished to start or resume";
  if (detail.inUse) return `Cannot ${kind}: in use by another session, and a plan runs in one session at a time`;
  if (!detail.enterable) return `Cannot ${kind}: ${detail.status}`;
  if (kind === "resume" && !detail.started) return "Cannot resume: not started yet; press Enter to start";
  return undefined;
}

export function progressBar(theme: Theme, done: number, total: number): string {
  const { filled: full, empty } = theme.progress;
  if (!total) return theme.fg("dim", empty.repeat(BAR_WIDTH));
  const filled = Math.round((done / total) * BAR_WIDTH);
  return theme.fg(done === total ? "success" : "accent", full.repeat(filled)) + theme.fg("dim", empty.repeat(BAR_WIDTH - filled));
}

function statusColor(detail: AtlasPlanDetail): "success" | "warning" | "error" | "muted" {
  if (detail.status.startsWith("Invalid")) return "error";
  if (!detail.enterable && detail.unfinished) return "warning";
  if (detail.total && detail.done === detail.total) return "success";
  return "muted";
}

function shortStatus(detail: AtlasPlanDetail): string {
  return detail.status.replace(/\s*\(\d+\/\d+\)/, "").replace(/^In progress \d+\/\d+/, "In progress");
}

export function rowMark(theme: Theme, status: string): string {
  const s = theme.status;
  if (status === "done") return theme.fg("success", s.success);
  if (status === "in_progress") return theme.fg("accent", s.running);
  if (status === "blocked") return theme.fg("error", s.error);
  return theme.fg("dim", s.pending);
}

/** Preset status glyphs differ in cell width (unicode ✔ vs ⏳, ascii [ok] vs [*]); pad them to one column. */
function rowMarks(theme: Theme, rows: readonly AtlasRowDetail[]): { marks: string[]; width: number } {
  const marks = rows.map((item) => rowMark(theme, item.status));
  const width = Math.max(1, ...marks.map((mark) => visibleWidth(mark)));
  return { marks: marks.map((mark) => mark + padding(width - visibleWidth(mark))), width };
}

function hintLines(hints: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const hint of hints) {
    const next = line ? `${line}   ${hint}` : hint;
    if (line && visibleWidth(next) > width) {
      lines.push(line);
      line = hint;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatElapsed(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return "—";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Child-supplied text (intents, tool args, errors) collapsed onto one display line. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const ROW_STATUS: Record<string, string> = { open: "Not started", in_progress: "In progress", done: "Done", blocked: "Blocked" };
const TEXT_MARK: Record<string, string> = { open: "[ ]", in_progress: "[~]", done: "[x]", blocked: "[!]" };

/** Native counterparts of the row marks: one tone and icon per ledger status, and the checklist state it reads as. */
const ROW_TONE: Record<string, "accent" | "success" | "error" | "muted"> = {
  open: "muted",
  in_progress: "accent",
  done: "success",
  blocked: "error",
};
const ROW_ICON: Record<string, string> = { open: "circle", in_progress: "clock", done: "check", blocked: "x-circle" };
const ROW_CHECK: Record<string, "pending" | "active" | "done" | "blocked"> = {
  open: "pending",
  in_progress: "active",
  done: "done",
  blocked: "blocked",
};

/** A plan's progress as a native bar, green once every row is done; inside a row it takes the free width. */
export function progressNode(done: number, total: number, inRow = false): NativeNode {
  return node("progress", {
    value: total ? done / total : 0,
    label: total ? `${done}/${total}` : "—",
    tone: total && done === total ? "success" : "accent",
    ...(inRow ? { grow: 1, min: { w: "12ch" } } : {}),
  });
}

/** A row's evidence without the archive path the row already names. */
function evidenceSummary(item: AtlasRowDetail): string | undefined {
  return item.outputPath && item.evidence?.startsWith(`${item.outputPath}: `)
    ? item.evidence.slice(item.outputPath.length + 2)
    : item.evidence;
}

/** The owner ruling in force for a row: the latest one recorded for it. */
function rowRuling(detail: AtlasPlanDetail, rowId: string): OwnerRuling | undefined {
  return detail.rulings?.findLast((ruling) => ruling.rowId === rowId);
}

/** One line per plan for dialog-free hosts: name, id, status and workspace. */
export function atlasPlanList(details: readonly AtlasPlanDetail[]): string {
  if (!details.length) return "No shared approved plans are available.";
  return details.map(({ plan, status }) => `- ${plan.name} (${plan.id}) — ${status}${plan.cwd ? ` — ${plan.cwd}` : ""}`).join("\n");
}

/** Read-only text form of the plan inspector for hosts without terminal components. */
export function atlasPlanText(detail: AtlasPlanDetail): string {
  const { plan } = detail;
  const lines = [
    `${plan.name} (${plan.id})`,
    `Status: ${detail.status}`,
    `Progress: ${detail.done}/${detail.total}${detail.inUse ? " · in use by another session" : ""}`,
    `Workspace: ${plan.cwd || "unavailable"}`,
    `Plan file: ${plan.planFilePath}`,
  ];
  if (detail.startedAt !== undefined) lines.push(`Started: ${formatTime(detail.startedAt)}`);
  if (detail.rulings?.length) {
    lines.push("", `Owner rulings (user-confirmed amendments to the approved plan): ${detail.rulings.length}`);
    for (const ruling of detail.rulings) {
      lines.push(
        `- ${ruling.id} ${ruling.rowId}: ${singleLine(ruling.acceptance)} — ${singleLine(ruling.note)} (${formatTime(ruling.confirmedAt)})`,
      );
    }
  }
  for (const row of detail.rows) {
    lines.push("", `${TEXT_MARK[row.status] ?? "[?]"} ${row.id}. ${row.title} — ${ROW_STATUS[row.status] ?? row.status} — ${row.agent}`);
    if (row.dependsOn.length) lines.push(`    Depends on: ${row.dependsOn.join(", ")}`);
    const ruling = rowRuling(detail, row.id);
    if (ruling) {
      lines.push(`    Acceptance: ${singleLine(ruling.acceptance)} (amended by ${ruling.id})`);
      if (row.acceptance) lines.push(`    Approved: ${singleLine(row.acceptance)}`);
    } else if (row.acceptance) lines.push(`    Acceptance: ${singleLine(row.acceptance)}`);
    if (row.evidence) lines.push(`    Evidence: ${singleLine(row.evidence)}`);
    if (row.outputPath) lines.push(`    Output: ${row.outputPath}`);
  }
  return lines.join("\n");
}

/**
 * Native OMP panel chrome (same frame as the ask/hook selector) around a host SelectList. In Tern it describes a
 * glass sheet instead: filter tabs, the search, the plan list, the highlighted plan's rows and buttons for its keys.
 */
export class AtlasMenu extends OverlayPanel {
  readonly nativeOverlay = MENU_OVERLAY;
  readonly #list: SelectList;
  readonly #details: Map<string, AtlasPlanDetail>;
  readonly #header = new PanelRows();
  readonly #preview = new PanelRows();
  readonly #footer = new PanelRows();
  readonly #native = new Memo();
  #filter: AtlasFilter;
  #message = "";

  constructor(
    details: AtlasPlanDetail[],
    filter: AtlasFilter,
    query: string,
    readonly theme: Theme,
    readonly tui: TUI,
    readonly done: (result: AtlasMenuAction) => void,
    options: { selectedId?: string; message?: string } = {},
  ) {
    super(TITLE);
    this.#details = new Map(details.map((detail) => [detail.plan.id, detail]));
    this.#filter = filter;
    this.#list = new SelectList(this.#items(), LIST_ROWS, getSelectListTheme(), {
      search: "always",
      emptyText: EMPTY_TEXT,
      noMatchText: NO_MATCH_TEXT,
      renderItem: (context) => [this.#renderPlanRow(context)],
      statusText: ({ query, visibleCount, totalCount }) =>
        `  ${query ? `Search: ${query}` : "Type to search"}  ${this.theme.fg("dim", `${visibleCount}/${totalCount}`)}`,
    });
    this.#list.setFilter(query);
    if (options.selectedId) this.#list.setSelectedValue(options.selectedId);
    this.#message = options.message ?? "";
    this.#list.onSelect = (item) => this.#act("start", item.value);
    this.#list.onCancel = () => this.#act("cancel");
    this.#list.onSelectionChange = () => this.tui.requestRender();

    this.addChild(this.#header);
    this.addChild(this.#list);
    this.addChild(new PanelDivider());
    this.addChild(this.#preview);
    this.addChild(new PanelDivider());
    this.addChild(this.#footer);
  }

  #items(): SelectItem[] {
    return [...this.#details.values()]
      .filter((detail) => this.#filter === "all" || detail.unfinished)
      .map(({ plan, status }) => ({
        value: plan.id,
        label: plan.name,
        description: status,
        searchText: `${plan.id} ${status}`,
      }));
  }

  /** `❯ name ········ ━━━━──── 3/11  In progress` with fixed columns so every row aligns. */
  #renderPlanRow({ item, width, selected }: SelectListRenderItemContext): string {
    const detail = this.#details.get(item.value);
    const cursor = selected ? this.theme.fg("accent", `${this.theme.nav.cursor} `) : "  ";
    if (!detail) return cursor + item.label;
    const counts = detail.total ? `${detail.done}/${detail.total}` : this.theme.format.dash;
    const tail = `  ${progressBar(this.theme, detail.done, detail.total)} ${counts.padStart(5)}  ${this.theme.fg(statusColor(detail), shortStatus(detail))}`;
    const nameWidth = Math.max(8, width - 2 - visibleWidth(tail));
    const name = truncateToWidth(item.label, nameWidth);
    const styledName = this.theme.fg(selected ? "accent" : "text", name);
    return truncateToWidth(cursor + styledName + padding(Math.max(0, nameWidth - visibleWidth(name))) + tail, width);
  }

  #syncRows(width: number): void {
    const tabs = renderSegmentTrack(
      FILTERS.map((filter) => ({ label: FILTER_LABELS[filter] })),
      FILTERS.indexOf(this.#filter),
    );
    const note = this.#message
      ? this.theme.fg("warning", this.#message)
      : this.#filter === "all"
        ? this.theme.fg("dim", "Display only; press Tab for Unfinished to start or resume")
        : "";
    this.#header.setLines(["", `${tabs}  ${note}`, ""]);

    const selected = this.#list.getSelectedItem();
    const detail = selected && this.#details.get(selected.value);
    const lines: string[] = [];
    if (detail) {
      lines.push(`${this.theme.bold(this.theme.fg("accent", detail.plan.name))}  ${this.theme.fg("dim", detail.plan.id)}`);
      lines.push(this.theme.fg("muted", detail.plan.cwd || "Workspace unavailable"));
      if (detail.status.startsWith("Invalid") || detail.status.includes("Different workspace") || detail.inUse)
        lines.push(this.theme.fg(statusColor(detail), detail.status));
      lines.push("");
      const idWidth = Math.max(0, ...detail.rows.map((item) => item.id.length));
      const { marks } = rowMarks(this.theme, detail.rows);
      detail.rows.slice(0, PREVIEW_ROWS).forEach((item, index) => {
        lines.push(`${marks[index] ?? ""} ${this.theme.fg("muted", item.id.padEnd(idWidth))}  ${item.title}`);
      });
      const hidden = detail.rows.length - PREVIEW_ROWS;
      if (hidden > 0) lines.push(this.theme.fg("dim", `+${hidden} more ${hidden === 1 ? "row" : "rows"}; press Space for details`));
    } else {
      lines.push(this.theme.fg("dim", "No plan selected"));
    }
    this.#preview.setLines(lines);

    this.#footer.setLines(
      hintLines(
        [
          rawKeyHint("enter", "start"),
          rawKeyHint("space", "details"),
          rawKeyHint("shift+r", "resume"),
          rawKeyHint("delete", "delete"),
          rawKeyHint("shift+n", "rename"),
          rawKeyHint("tab", "filter"),
          rawKeyHint("escape", "close"),
        ],
        Math.max(1, width - 4),
      ),
    );
  }

  #act(kind: AtlasMenuAction["kind"], planId?: string): void {
    const detail = planId ? this.#details.get(planId) : undefined;
    const blocked = (kind === "start" || kind === "resume") && detail ? dispatchBlock(detail, kind, this.#filter === "all") : undefined;
    if (blocked) {
      this.#message = blocked;
      this.tui.requestRender();
      return;
    }
    this.done({ kind, planId, filter: this.#filter, query: this.#list.getFilter() });
  }

  #actOnSelected(kind: AtlasMenuAction["kind"]): void {
    const selected = this.#list.getSelectedItem();
    if (selected) this.#act(kind, selected.value);
  }

  #setFilter(filter: AtlasFilter): void {
    this.#filter = filter;
    this.#message = "";
    this.#list.setItems(this.#items());
  }

  handleInput(key: string): void {
    if (matchesKey(key, "tab")) {
      this.#setFilter(this.#filter === "unfinished" ? "all" : "unfinished");
    } else if (matchesKey(key, "space") || key === " " || key === "I" || matchesKey(key, "shift+i")) {
      this.#actOnSelected("inspect");
    } else if (key === "R" || matchesKey(key, "shift+r")) {
      this.#actOnSelected("resume");
    } else if (matchesKey(key, "delete") || (matchesKey(key, "backspace") && !this.#list.getFilter())) {
      this.#actOnSelected("delete");
    } else if (key === "N" || matchesKey(key, "shift+n")) {
      this.#actOnSelected("rename");
    } else {
      this.#message = "";
      this.#list.handleInput(key);
    }
    this.tui.requestRender();
  }

  override render(width: number): readonly string[] {
    this.#syncRows(width);
    return super.render(width);
  }

  /** Pointer actions in Tern run the key paths: tabs switch the filter, a click highlights, a double-click opens. */
  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action") {
      if (event.act === "cancel") this.#act("cancel");
      else if (MENU_PLAN_ACTIONS.includes(event.act)) this.#actOnSelected(event.act as AtlasMenuAction["kind"]);
    } else if (event.type === "select" || event.type === "activate") {
      const key = leafKey(event.key);
      if (key === "filter") {
        const filter = FILTERS.find((value) => value === event.item);
        if (filter && filter !== this.#filter) this.#setFilter(filter);
      } else if (key === "plans" && this.#details.has(event.item)) {
        this.#message = "";
        this.#list.setSelectedValue(event.item);
        if (event.type === "activate") this.#actOnSelected("inspect");
      }
    }
    this.tui.requestRender();
  }

  override describe(_cx: DescribeContext): NativeNode {
    const { items, selected, query } = this.#list.pickerView();
    return this.#native.get([this.#filter, this.#message, items, selected, query], () => this.#describe(items, selected, query));
  }

  /** The sheet is the frame (titled by `nativeOverlay`): a borderless column. */
  #describe(items: readonly SelectItem[], selected: string | null, query: string): NativeNode {
    const search: TspSpan[] = query.trim() ? [span("Search ", "muted"), span(query, "strong")] : [span("Type to search", "muted")];
    const head = rowNode(
      [
        node("tabs", { items: FILTERS.map((id) => ({ id, label: FILTER_LABELS[id] })), active: this.#filter }, undefined, "filter"),
        rowNode([text(search), text([span(`${items.length}/${this.#items().length}`, "dim")])], { gap: "sm", align: "center" }),
      ],
      { gap: "md", align: "center", justify: "between" },
    );
    const notice = this.#message
      ? text([span(this.#message, "warning")], { wrap: "word" })
      : this.#filter === "all"
        ? text([span("Display only; press Tab for Unfinished to start or resume", "muted")], { wrap: "word" })
        : undefined;
    const plans = selectList(
      "plans",
      items.map((entry) => this.#describePlan(entry)),
      { selected, filter: query.trim() || undefined, empty: query.trim() ? NO_MATCH_TEXT : EMPTY_TEXT, max: { lines: LIST_ROWS } },
    );
    const actions = actionBar([
      actionButton("Start", "start", { keys: "enter", tone: "accent" }),
      actionButton("Resume", "resume", { keys: "shift+r" }),
      actionButton("Details", "inspect", { keys: "space" }),
      actionButton("Rename", "rename", { keys: "shift+n" }),
      actionButton("Delete", "delete", { keys: "delete", tone: "error" }),
      null,
      actionButton("Close", "cancel", { keys: "escape" }),
    ]);
    return col(
      compact<NativeChild>([
        keyed(head, "head"),
        notice && keyed(notice, "notice"),
        plans,
        node("rule", undefined, undefined, "divider"),
        keyed(this.#describePreview(selected), "preview"),
        actions,
      ]),
      { gap: "md" },
    );
  }

  /** One plan: name, short status in its tone, and the done/total count the TUI bar shows. */
  #describePlan(entry: SelectItem): NativeNode {
    const detail = this.#details.get(entry.value);
    if (!detail) return itemNode(entry.value, { label: entry.label });
    const tone = statusColor(detail);
    return itemNode(entry.value, {
      label: detail.plan.name,
      detail: [span(shortStatus(detail), tone)],
      value: detail.total ? `${detail.done}/${detail.total}` : "—",
      tone,
    });
  }

  /** The highlighted plan: where it runs, why it cannot, its progress and its first rows as a checklist. */
  #describePreview(selected: string | null): NativeNode {
    const detail = selected === null ? undefined : this.#details.get(selected);
    if (!detail) return text([span("No plan selected", "muted")]);
    const flagged = detail.status.startsWith("Invalid") || detail.status.includes("Different workspace") || detail.inUse;
    const hidden = detail.rows.length - PREVIEW_ROWS;
    const checklist = node("checklist", {
      mode: "full",
      phases: [
        {
          id: "rows",
          title: "Rows",
          items: detail.rows.slice(0, PREVIEW_ROWS).map((item) => ({
            id: item.id,
            text: [span(item.id, "muted"), span(` ${item.title}`)],
            status: ROW_CHECK[item.status] ?? "pending",
          })),
        },
      ],
    });
    return col(
      compact<NativeChild>([
        rowNode([text([span(detail.plan.name, "strong accent")]), text([span(detail.plan.id, "dim")])], { gap: "sm", align: "baseline" }),
        text([span(detail.plan.cwd || "Workspace unavailable", "muted")]),
        flagged && text([span(detail.status, statusColor(detail))], { wrap: "word" }),
        progressNode(detail.done, detail.total),
        detail.rows.length ? checklist : text([span("No plan rows", "muted")]),
        hidden > 0 && text([span(`+${hidden} more ${hidden === 1 ? "row" : "rows"}; open Details for all of them`, "muted")]),
      ]),
      { gap: "sm", role: "omp.atlas.preview" },
    );
  }
}

/** An archived child output being read for the plan view, kept unstyled so both renderers can present it. */
type ChildOutput = { state: "loading" } | { state: "loaded"; text: string } | { state: "failed"; error: string };

/**
 * Fullscreen plan inspector: summary, a row sidebar, and the selected row's acceptance, evidence and
 * (on demand) its archived native child output. In Tern it describes the same as a large glass sheet.
 */
export class AtlasPlanView implements Component {
  #selected = 0;
  /** Row body and timeline scroll independently; Tab and live refreshes keep both. */
  #rowScroll = 0;
  #timelineScroll = 0;
  #timelineCache?: { events: readonly AtlasEvent[]; width: number; lines: string[] };
  #expanded = new Set<string>();
  #outputs = new Map<string, ChildOutput>();
  #markdown = new Map<string, Markdown>();
  #message = "";
  #bodyRows = 1;
  /** Last frame's geometry: mouse reports hit-test against what was painted. */
  #bodyTop = 0;
  #dividerCol = 0;
  #scrollMax = { row: Number.MAX_SAFE_INTEGER, timeline: Number.MAX_SAFE_INTEGER };
  #liveSnapshot?: AtlasLiveSnapshot;
  #unsubscribe?: () => void;
  #timeline = false;
  /** The last scroll key, forwarded to Tern's scroller (see `NativeNode.scroll`). */
  #nativeScroll?: NativeScroll;
  #nativeOverlay?: { name: string; props: NonNullable<Component["nativeOverlay"]> };
  readonly #nativeRoot = new Memo();
  readonly #nativeSidebar = new Memo();
  readonly #nativeBody = new Memo();

  constructor(
    detail: AtlasPlanDetail,
    readonly mode: AtlasPlanViewMode,
    readonly theme: Theme,
    readonly tui: TUI,
    readonly readOutput: (file: string) => Promise<string>,
    readonly done: (action: AtlasPlanViewAction) => void,
    live?: AtlasLive,
  ) {
    this.detail = detail;
    if (live && mode === "active")
      this.#unsubscribe = live.subscribe((snapshot) => {
        this.#liveSnapshot = snapshot;
        this.updateDetail(snapshot.detail);
      });
  }

  detail: AtlasPlanDetail;

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  updateDetail(detail: AtlasPlanDetail): void {
    const selectedId = this.#row()?.id;
    const next = detail.rows.findIndex((row) => row.id === selectedId);
    this.detail = detail;
    if (next >= 0) this.#selected = next;
    else {
      this.#selected = Math.min(this.#selected, Math.max(0, detail.rows.length - 1));
      this.#rowScroll = 0;
    }
    this.tui.requestRender();
  }

  #row(): AtlasRowDetail | undefined {
    return this.detail.rows[this.#selected];
  }

  #select(index: number): void {
    const next = Math.max(0, Math.min(this.detail.rows.length - 1, index));
    if (next === this.#selected) return;
    this.#selected = next;
    this.#rowScroll = 0;
    this.#scrollMax.row = Number.MAX_SAFE_INTEGER;
  }

  #scrollBy(delta: number): void {
    if (this.#timeline) this.#timelineScroll = Math.max(0, Math.min(this.#scrollMax.timeline, this.#timelineScroll + delta));
    else this.#rowScroll = Math.max(0, Math.min(this.#scrollMax.row, this.#rowScroll + delta));
  }

  /** Wheel over the sidebar moves the row selection, over the body scrolls it; every other report is swallowed. */
  #handleMouse(event: SgrMouseEvent): void {
    if (event.wheel === null) return;
    const line = event.row - this.#bodyTop;
    if (line < 0 || line >= this.#bodyRows) return;
    if (event.col < this.#dividerCol) this.#select(this.#selected + event.wheel);
    else if (event.col > this.#dividerCol) this.#scrollBy(event.wheel * WHEEL_ROWS);
  }

  #toggleOutput(): void {
    const item = this.#row();
    if (!item?.outputPath) {
      this.#message = "This row has no archived child output yet";
      return;
    }
    const file = item.outputPath;
    if (this.#expanded.delete(item.id)) return;
    this.#expanded.add(item.id);
    if (this.#outputs.has(file)) return;
    this.#outputs.set(file, { state: "loading" });
    this.readOutput(file).then(
      (content) => {
        this.#outputs.set(file, { state: "loaded", text: content.trimEnd() });
        this.tui.requestRender();
      },
      (error: unknown) => {
        this.#outputs.set(file, { state: "failed", error: error instanceof Error ? error.message : String(error) });
        this.tui.requestRender();
      },
    );
  }

  #outputText(file: string): string {
    const output = this.#outputs.get(file);
    if (!output) return "";
    if (output.state === "loading") return this.theme.fg("dim", "Loading...");
    if (output.state === "failed") return this.theme.fg("error", `Cannot read output: ${output.error}`);
    return output.text || this.theme.fg("dim", "(empty output)");
  }

  /** Tern owns the scrolling natively; a scroll key moves its scroller instead of the painted offset. */
  #scrollNative(by: NativeScroll["by"]): void {
    this.#nativeScroll = { by, n: (this.#nativeScroll?.n ?? 0) + 1 };
  }

  #dispatch(kind: AtlasDispatch): void {
    const blocked = dispatchBlock(this.detail, kind, this.mode === "display");
    if (blocked) {
      this.#message = blocked;
      return;
    }
    this.done(kind);
  }

  handleInput(key: string): void {
    // Checked before anything else: pointer motion must not clear the notice or act as a key.
    if (
      routeSgrMouseInput(key, (event) => {
        this.#handleMouse(event);
        return true;
      })
    ) {
      this.tui.requestRender();
      return;
    }
    this.#message = "";
    if (matchesKey(key, "escape") || matchesKey(key, "left")) {
      this.dispose();
      this.done("back");
    } else if (matchesKey(key, "tab")) this.#timeline = !this.#timeline;
    else if (matchesKey(key, "up")) {
      if (this.#timeline) {
        this.#scrollBy(-1);
        this.#scrollNative("line-up");
      } else this.#select(this.#selected - 1);
    } else if (matchesKey(key, "down")) {
      if (this.#timeline) {
        this.#scrollBy(1);
        this.#scrollNative("line-down");
      } else this.#select(this.#selected + 1);
    } else if (matchesKey(key, "home")) {
      if (this.#timeline) {
        this.#timelineScroll = 0;
        this.#scrollNative("start");
      } else this.#select(0);
    } else if (matchesKey(key, "end")) {
      // Render clamps to the last page.
      if (this.#timeline) {
        this.#timelineScroll = Number.MAX_SAFE_INTEGER;
        this.#scrollNative("end");
      } else this.#select(this.detail.rows.length - 1);
    } else if (matchesKey(key, "pageDown")) {
      this.#scrollBy(Math.max(1, this.#bodyRows - 2));
      this.#scrollNative("page-down");
    } else if (matchesKey(key, "pageUp")) {
      this.#scrollBy(-Math.max(1, this.#bodyRows - 2));
      this.#scrollNative("page-up");
    } else if (!this.#timeline && (matchesKey(key, "space") || key === " " || matchesKey(key, "right"))) this.#toggleOutput();
    else if (this.mode === "active") {
      if (key === "X" || matchesKey(key, "shift+x")) {
        this.dispose();
        this.done("exit");
      }
    } else if (matchesKey(key, "enter")) this.#dispatch("start");
    else if (key === "R" || matchesKey(key, "shift+r")) this.#dispatch("resume");
    this.tui.requestRender();
  }

  #sidebar(width: number, height: number): string[] {
    const rows = this.detail.rows;
    if (!rows.length) return [this.theme.fg("dim", "No plan rows")];
    const { marks } = rowMarks(this.theme, rows);
    const idWidth = Math.max(0, ...rows.map((item) => item.id.length));
    const now = this.#liveSnapshot?.at ?? Date.now();
    const start = Math.max(0, Math.min(this.#selected - Math.floor(height / 2), rows.length - height));
    return rows.slice(start, start + height).map((item, offset) => {
      const index = start + offset;
      const selected = index === this.#selected;
      const cursor = selected ? this.theme.fg("accent", `${this.theme.nav.cursor} `) : "  ";
      const prefix = `${cursor}${marks[index] ?? ""} ${this.theme.fg("muted", item.id.padEnd(idWidth))} `;
      // The elapsed clock is the live signal here, so the title gives way to it, not the other way round.
      const elapsed = item.status === "in_progress" ? ` ${formatElapsed(item.startedAt, now)}` : "";
      const titleWidth = Math.max(1, width - visibleWidth(prefix) - elapsed.length);
      const title = this.theme.fg(selected ? "accent" : "text", truncateToWidth(item.title, titleWidth));
      return truncateToWidth(`${prefix}${title}${this.theme.fg("dim", elapsed)}`, width);
    });
  }

  /** Newest first. Rebuilt only when a reload replaces the event list or the width changes. */
  #timelineBody(width: number): string[] {
    const events = this.detail.timeline;
    if (!events.length) return [this.theme.fg("dim", "No recorded activity")];
    const cached = this.#timelineCache;
    if (cached?.events === events && cached.width === width) return cached.lines;
    const lines: string[] = [];
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index] as AtlasEvent;
      const label = `${formatTime(event.at)}  ${event.kind.replaceAll("_", " ")}${event.row ? `  ${event.row}` : ""}${event.derived ? "  [derived]" : ""}`;
      lines.push(...wrapTextWithAnsi(this.theme.fg(event.derived ? "dim" : "text", label), width));
      if (event.detail) {
        // Evidence details repeat the archive path the row body already shows; two lines identify the event.
        const detail = wrapTextWithAnsi(singleLine(event.detail).replace(/^\/\S+\.md: /, ""), Math.max(1, width - 2));
        const shown = detail.length > 2 ? [detail[0] ?? "", truncateToWidth(`${detail[1]} ${detail[2]}`, width - 2)] : detail;
        for (const line of shown) lines.push(`  ${this.theme.fg("muted", line)}`);
      }
    }
    // New events arrive on top; keep a reader who scrolled into history on the same entries.
    if (cached && cached.width === width && this.#timelineScroll > 0)
      this.#timelineScroll = Math.max(0, this.#timelineScroll + lines.length - cached.lines.length);
    this.#timelineCache = { events, width, lines };
    return lines;
  }

  #body(width: number): string[] {
    if (this.#timeline) return this.#timelineBody(width);
    const item = this.#row();
    if (!item) return [this.theme.fg("dim", "No row selected")];
    const t = this.theme;
    const lines: string[] = [];
    const wrap = (text: string, style: (value: string) => string = (value) => value): void => {
      for (const paragraph of text.split("\n")) lines.push(...wrapTextWithAnsi(style(paragraph), width));
    };
    /** Label column with a hanging indent, so wrapped values stay aligned under their value. */
    const field = (label: string, value: string, maxLines = Number.POSITIVE_INFINITY): void => {
      if (width < 30) {
        lines.push(...wrapTextWithAnsi(`${t.fg("muted", label.padEnd(10))}${value}`, width).slice(0, maxLines));
        return;
      }
      const wrapped = wrapTextWithAnsi(value, width - 10).slice(0, maxLines);
      for (const [index, line] of wrapped.entries()) lines.push(`${index ? padding(10) : t.fg("muted", label.padEnd(10))}${line}`);
    };
    const markdown = (text: string): void => {
      let component = this.#markdown.get(text);
      if (!component) {
        component = new Markdown(text, 0, 0, getMarkdownTheme());
        this.#markdown.set(text, component);
      }
      lines.push(...component.render(width));
    };
    wrap(`${item.id}  ${item.title}`, (value) => t.bold(t.fg("accent", value)));
    lines.push("");
    const mark = rowMark(t, item.status);
    field(
      "Status",
      `${mark} ${ROW_STATUS[item.status] ?? item.status}${item.attempt ? t.fg("dim", ` · attempt ${item.attempt.slice(0, 8)}`) : ""}`,
    );
    field("Agent", item.agent);
    if (item.tier) field("Tier", item.tier.toUpperCase());
    if (item.verification) {
      field(
        "Verify",
        `${item.verification.status}${item.verification.summary ? t.fg("dim", ` · ${singleLine(item.verification.summary)}`) : ""}`,
      );
    }
    if (item.origin) field("Origin", `${item.origin}${item.reason ? t.fg("dim", ` · ${singleLine(item.reason)}`) : ""}`);
    field("Depends", item.dependsOn.length ? item.dependsOn.join(", ") : t.format.dash);
    field("Updated", formatTime(item.updatedAt));
    if (item.status === "in_progress") {
      const now = this.#liveSnapshot?.at ?? Date.now();
      const current = this.#liveSnapshot?.rows.get(item.id);
      const live = current && current.attempt === item.attempt ? current : undefined;
      const progress = live?.progress;
      lines.push("", t.bold("Live"));
      field("Child", live?.childAgentId ?? item.childAgentId ?? t.format.dash);
      if (live) field("State", live.status);
      field("Elapsed", formatElapsed(item.startedAt, now));
      if (progress) {
        field(
          "Model",
          `${progress.resolvedModel ?? t.format.dash}${progress.resolvedThinkingLevel ? ` · ${progress.resolvedThinkingLevel}` : ""}`,
        );
        if (progress.currentTool) {
          field("Tool", `${progress.currentTool} ${t.fg("dim", formatElapsed(progress.currentToolStartMs, now))}`);
          // Arguments can be a whole file body; the first wrapped lines identify the call.
          if (progress.currentToolArgs) field("", t.fg("dim", singleLine(progress.currentToolArgs)), 3);
        }
        if (progress.lastIntent) field("Intent", singleLine(progress.lastIntent));
        field("Usage", `${progress.toolCount} tools · ${progress.requests} requests · ${formatNumber(progress.tokens)} tokens`);
        if (progress.contextTokens !== undefined || progress.contextWindow !== undefined)
          field(
            "Context",
            `${progress.contextTokens === undefined ? "?" : formatNumber(progress.contextTokens)}/${progress.contextWindow === undefined ? "?" : formatNumber(progress.contextWindow)} tokens`,
          );
        field("Cost", `$${progress.cost.toFixed(4)}`);
        if (progress.retryState)
          field(
            "Retry",
            t.fg(
              "warning",
              `${progress.retryState.attempt}/${progress.retryState.maxAttempts} · ${singleLine(progress.retryState.errorMessage)}`,
            ),
          );
        if (progress.retryFailure) field("Failure", t.fg("error", singleLine(progress.retryFailure.errorMessage)));
        // The host keeps both lists newest first.
        if (progress.recentTools.length) {
          lines.push(t.fg("muted", "Recent tools"));
          for (const tool of progress.recentTools.slice(0, 3))
            lines.push(truncateToWidth(`  ${tool.tool} ${t.fg("dim", singleLine(tool.args))}`, width));
        }
        if (progress.recentOutput.length) {
          lines.push(t.fg("muted", "Recent output"));
          for (const output of progress.recentOutput.slice(0, 4).reverse()) wrap(`  ${output}`);
        }
      } else if (!live) lines.push(t.fg("dim", "Waiting for the child to start"));
      else if (live.status === "started" || live.status === "running") lines.push(t.fg("dim", "No progress reported by this child yet"));
      else lines.push(t.fg("dim", `Child ${live.status}; waiting for the ledger to record the result`));
    }
    lines.push("", t.bold("Evidence"));
    const summary = evidenceSummary(item);
    if (summary) markdown(summary);
    else lines.push(t.fg("dim", item.status === "done" ? "No evidence summary" : "No evidence yet"));
    if (item.receipt) {
      field("Child", t.fg("dim", item.receipt.childAgentId));
      field("Session", t.fg("dim", item.receipt.sessionId));
      field("Captured", t.fg("dim", formatTime(item.receipt.capturedAt)));
    }
    if (item.outputPath) {
      lines.push("");
      if (this.#expanded.has(item.id)) {
        lines.push(`${t.bold("Child output")}  ${t.fg("dim", item.outputPath)}`);
        wrap(this.#outputText(item.outputPath));
      } else {
        lines.push(t.fg("dim", `Press Space to show the archived child output (${item.outputPath})`));
      }
    }
    const ruling = rowRuling(this.detail, item.id);
    lines.push("", `${t.bold("Acceptance")}${ruling ? t.fg("warning", `  amended by ${ruling.id}`) : ""}`);
    if (ruling) {
      markdown(ruling.acceptance);
      if (ruling.note) field("Note", singleLine(ruling.note));
      field("Confirmed", formatTime(ruling.confirmedAt));
      lines.push("", t.fg("muted", "Approved plan"));
      wrap(item.acceptance, (value) => t.fg("dim", value));
    } else markdown(item.acceptance);
    return lines;
  }

  render(width: number): readonly string[] {
    const t = this.theme;
    const height = Math.max(12, this.tui.terminal?.rows || process.stdout.rows || 40);
    const inner = Math.max(1, width - 4);
    const sidebarWidth = Math.max(18, Math.min(52, Math.floor(width * 0.36)));
    const bodyWidth = Math.max(1, splitBodyWidth(width, sidebarWidth));
    const hints = hintLines(
      [
        this.theme.fg("dim", `${editorKey("tui.select.up")}/${editorKey("tui.select.down")}`) +
          this.theme.fg("muted", this.#timeline ? " scroll" : " row"),
        ...(!this.#timeline ? [rawKeyHint("space", "child output")] : []),
        rawKeyHint("tab", this.#timeline ? "row" : "timeline"),
        this.theme.fg("dim", "PgDn/wheel") + this.theme.fg("muted", " scroll"),
        ...(this.mode === "active"
          ? [rawKeyHint("shift+x", "exit Atlas")]
          : [rawKeyHint("enter", "start"), rawKeyHint("shift+r", "resume")]),
        rawKeyHint("escape", "back"),
      ],
      inner,
    );
    const counts = this.detail.total ? `${this.detail.done}/${this.detail.total}` : t.format.dash;
    const tally = (["done", "in_progress", "blocked", "open"] as const)
      .map((status) => [status, this.detail.rows.filter((item) => item.status === status).length] as const)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${rowMark(t, status)} ${count} ${ROW_STATUS[status]?.toLowerCase()}`)
      .join("  ");
    const status =
      this.mode === "active" ? t.fg("accent", "Active in this session") : t.fg(statusColor(this.detail), shortStatus(this.detail));
    const running = this.#running();
    const summary = `${status}  ${progressBar(t, this.detail.done, this.detail.total)} ${counts}  ${running} running · ${formatElapsed(this.detail.startedAt, this.#liveSnapshot?.at ?? Date.now())}  ${tally}`;
    const origin = t.fg("dim", `${this.detail.plan.id}  ${this.detail.plan.cwd || "Workspace unavailable"}`);
    const notice = this.#notice();
    const rulings = this.detail.rulings?.length
      ? [
          t.fg("warning", `Owner rulings ${this.detail.rulings.length}`) +
            t.fg("muted", `  ${this.detail.rulings.map((ruling) => `${ruling.id} ${ruling.rowId}`).join(" · ")}`),
        ]
      : [];
    const header = [summary, origin, ...rulings, ...(notice ? [t.fg("warning", notice)] : [])];

    this.#bodyRows = Math.max(3, height - 2 - header.length - 2 - hints.length);
    this.#bodyTop = 1 + header.length + 1;
    this.#dividerCol = sidebarWidth + 3;
    const body = this.#body(bodyWidth);
    const scrollMax = Math.max(0, body.length - this.#bodyRows);
    if (this.#timeline) this.#scrollMax.timeline = scrollMax;
    else this.#scrollMax.row = scrollMax;
    const scroll = Math.min(this.#timeline ? this.#timelineScroll : this.#rowScroll, scrollMax);
    if (this.#timeline) this.#timelineScroll = scroll;
    else this.#rowScroll = scroll;
    const shown = body.slice(scroll, scroll + this.#bodyRows);
    // The notice replaces the last visible line, so that line counts as hidden too.
    const more = body.length - scroll - shown.length + 1;
    if (more > 1 && shown.length) shown[shown.length - 1] = t.fg("dim", `+${more} more lines; PgDn/wheel to scroll`);
    const sidebar = this.#sidebar(sidebarWidth, this.#bodyRows);

    const box = t.boxRound;
    const splitOpen = t.fg(
      "border",
      box.teeRight +
        box.horizontal.repeat(sidebarWidth + 2) +
        box.teeDown +
        box.horizontal.repeat(Math.max(0, width - sidebarWidth - 5)) +
        box.teeLeft,
    );
    return [
      topBorder(width, `${TITLE} · ${this.detail.plan.name}`),
      ...header.map((line) => row(truncateToWidth(line, inner), width)),
      splitOpen,
      ...Array.from({ length: this.#bodyRows }, (_, index) => splitRow(sidebar[index] ?? "", shown[index] ?? "", width, sidebarWidth)),
      dividerSplit(width, sidebarWidth),
      ...hints.map((line) => row(line, width)),
      bottomBorder(width),
    ];
  }

  #running(): number {
    return this.#liveSnapshot?.runningChildren ?? this.detail.rows.filter((item) => item.status === "in_progress").length;
  }

  #notice(): string {
    return this.#message || (this.mode === "display" ? "Display only; start or resume from the Unfinished filter" : "");
  }

  /** The native sheet, titled by the plan's name. */
  get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
    const name = this.detail.plan.name;
    if (this.#nativeOverlay?.name !== name)
      this.#nativeOverlay = { name, props: { role: PLAN_OVERLAY_ROLE, size: "lg", anchor: "center", head: name } };
    return this.#nativeOverlay.props;
  }

  /**
   * Live refreshes arrive every second while a row runs. The description changes only when the ledger detail, the
   * selection, the view or the selected row's live child does; Tern clocks the elapsed counters itself.
   */
  describe(_cx: DescribeContext): NativeNode {
    const item = this.#row();
    // The child of a running row's current attempt, once it has reported.
    const current = item?.status === "in_progress" ? this.#liveSnapshot?.rows.get(item.id) : undefined;
    const live = current && current.attempt === item?.attempt ? current : undefined;
    const output = item?.outputPath ? this.#outputs.get(item.outputPath) : undefined;
    const expanded = item ? this.#expanded.has(item.id) : false;
    const sidebar = this.#nativeSidebar.get([this.detail.rows, this.#selected], () => this.#describeSidebar());
    const body = this.#nativeBody.get([this.detail, this.#timeline, item, expanded, output, live, this.#nativeScroll], () =>
      this.#describeBody(item, live),
    );
    const notice = this.#notice();
    const running = this.#running();
    return this.#nativeRoot.get([this.detail, this.mode, this.#timeline, notice, running, sidebar, body], () =>
      this.#describeRoot(notice, running, sidebar, body),
    );
  }

  /** Pointer actions in Tern run the key paths: the buttons, the Row/Timeline tabs, a row click and the output disclosure. */
  handleNativeEvent(event: NativeUiEvent): void {
    this.#message = "";
    if (event.type === "action") {
      if (event.act === "back" || (event.act === "exit" && this.mode === "active")) {
        this.dispose();
        this.done(event.act);
      } else if ((event.act === "start" || event.act === "resume") && this.mode !== "active") this.#dispatch(event.act);
    } else if (event.type === "select" || event.type === "activate") {
      const key = leafKey(event.key);
      if (key === "view") this.#timeline = event.item === "timeline";
      else if (key === "rows") {
        const index = itemIndex(event.item, "r");
        if (index >= 0 && index < this.detail.rows.length) {
          this.#select(index);
          this.#timeline = false;
        }
      }
    } else if (event.type === "toggle" && leafKey(event.key) === "output") {
      const item = this.#row();
      if (item && this.#expanded.has(item.id) === event.collapsed) this.#toggleOutput();
    }
    this.tui.requestRender();
  }

  /** The sheet is the frame (titled by `nativeOverlay`): tools, summary, the row sidebar beside the body, key hints. */
  #describeRoot(notice: string, running: number, sidebar: NativeNode, body: NativeNode): NativeNode {
    const { detail } = this;
    const buttons =
      this.mode === "active"
        ? [actionButton("Exit Atlas", "exit", { keys: "shift+x", tone: "error" }), actionButton("Back", "back", { keys: "escape" })]
        : [
            actionButton("Start", "start", { keys: "enter", tone: "accent" }),
            actionButton("Resume", "resume", { keys: "shift+r" }),
            actionButton("Back", "back", { keys: "escape" }),
          ];
    const tools = rowNode(
      [node("tabs", { items: VIEW_TABS, active: this.#timeline ? "timeline" : "row" }, undefined, "view"), actionBar(buttons)],
      { gap: "md", align: "center", justify: "between" },
    );
    const tally: TspSpan[] = [];
    for (const status of ["done", "in_progress", "blocked", "open"] as const) {
      const count = detail.rows.filter((item) => item.status === status).length;
      if (!count) continue;
      if (tally.length) tally.push(span(" · ", "dim"));
      tally.push(span(`${count} ${ROW_STATUS[status]?.toLowerCase()}`, ROW_TONE[status]));
    }
    const status = this.mode === "active" ? span("Active in this session", "accent") : span(shortStatus(detail), statusColor(detail));
    const summary = rowNode(
      compact<NativeChild>([
        text([status]),
        progressNode(detail.done, detail.total, true),
        text([span(`${running} running`, "muted")]),
        detail.startedAt !== undefined && elapsedNode(Date.now() - detail.startedAt),
        tally.length > 0 && text(tally),
      ]),
      { gap: "md", align: "center", wrap: true },
    );
    const origin = text([span(`${detail.plan.id} · ${detail.plan.cwd || "Workspace unavailable"}`, "dim")], {
      truncate: "middle",
      lines: 1,
    });
    const rulings = detail.rulings?.length
      ? text(
          [
            span(`Owner rulings ${detail.rulings.length}`, "warning"),
            span(`  ${detail.rulings.map((ruling) => `${ruling.id} ${ruling.rowId}`).join(" · ")}`, "muted"),
          ],
          { wrap: "word" },
        )
      : undefined;
    const hints = hintsRow([
      actionHint(["tui.select.up", "tui.select.down"], this.#timeline ? "scroll" : "row"),
      this.#timeline ? undefined : { keys: ["space"], label: "child output" },
      { keys: ["tab"], label: this.#timeline ? "row" : "timeline" },
      { keys: ["pageUp", "pageDown"], label: "scroll" },
    ]);
    return col(
      compact<NativeChild>([
        keyed(tools, "tools"),
        keyed(summary, "summary"),
        keyed(origin, "origin"),
        rulings ? keyed(rulings, "rulings") : undefined,
        notice ? keyed(text([span(notice, "warning")], { wrap: "word" }), "notice") : undefined,
        keyed(rowNode([sidebar, body], { gap: "lg", align: "start" }), "split"),
        hints,
      ]),
      { gap: "md" },
    );
  }

  /** Every ledger row, toned and marked by its status; a click selects it. */
  #describeSidebar(): NativeNode {
    const items = this.detail.rows.map((item, index) =>
      itemNode(`r${index}`, {
        label: [span(item.id, "muted"), span(` ${item.title}`)],
        icon: ROW_ICON[item.status],
        tone: ROW_TONE[item.status],
      }),
    );
    const list = selectList("rows", items, {
      selected: items.length ? `r${this.#selected}` : null,
      empty: "No plan rows",
      role: "omp.atlas.rows",
    });
    return node("col", { max: { w: "32ch" }, shrink: 0 }, [list], "sidebar");
  }

  #describeBody(item: AtlasRowDetail | undefined, live: AtlasLiveRow | undefined): NativeNode {
    const children = this.#timeline
      ? this.#describeTimeline()
      : item
        ? this.#describeRow(item, live)
        : [text([span("No row selected", "muted")])];
    const body = node("col", { grow: 1, gap: "md", role: "omp.atlas.body" }, children, "body");
    return this.#nativeScroll ? { ...body, scroll: this.#nativeScroll } : body;
  }

  /** The selected row: its fields, the live child while it runs, evidence, the archived output and acceptance. */
  #describeRow(item: AtlasRowDetail, live: AtlasLiveRow | undefined): NativeChild[] {
    const status: TspSpan[] = [span(ROW_STATUS[item.status] ?? item.status, ROW_TONE[item.status])];
    if (item.attempt) status.push(span(` · attempt ${item.attempt.slice(0, 8)}`, "dim"));
    const verification = item.verification;
    const fields = kv([
      ["Status", status],
      ["Agent", item.agent],
      ["Tier", item.tier?.toUpperCase()],
      [
        "Verify",
        verification
          ? [span(verification.status), ...(verification.summary ? [span(` · ${singleLine(verification.summary)}`, "dim")] : [])]
          : undefined,
      ],
      ["Origin", item.origin ? [span(item.origin), ...(item.reason ? [span(` · ${singleLine(item.reason)}`, "dim")] : [])] : undefined],
      ["Depends", item.dependsOn.length ? item.dependsOn.join(", ") : "—"],
      ["Updated", formatTime(item.updatedAt)],
    ]);
    const summary = evidenceSummary(item);
    const receipt = item.receipt
      ? kv([
          ["Child", [span(item.receipt.childAgentId, "dim")]],
          ["Session", [span(item.receipt.sessionId, "dim")]],
          ["Captured", [span(formatTime(item.receipt.capturedAt), "dim")]],
        ])
      : undefined;
    const evidence = col(
      compact<NativeChild>([
        text([span("Evidence", "strong")]),
        summary ? md(summary) : text([span(item.status === "done" ? "No evidence summary" : "No evidence yet", "muted")]),
        receipt,
      ]),
      { gap: "sm" },
    );
    return compact<NativeChild>([
      keyed(text([span(`${item.id} ${item.title}`, "strong accent")], { wrap: "word" }), "title"),
      fields && keyed(fields, "fields"),
      item.status === "in_progress" && keyed(this.#describeLive(item, live), "live"),
      keyed(evidence, "evidence"),
      item.outputPath ? this.#describeOutput(item.id, item.outputPath) : undefined,
      keyed(this.#describeAcceptance(item), "acceptance"),
    ]);
  }

  /** The acceptance in force; an amended row marks its ruling and keeps the approved plan's text below it. */
  #describeAcceptance(item: AtlasRowDetail): NativeNode {
    const ruling = rowRuling(this.detail, item.id);
    if (!ruling) return col([text([span("Acceptance", "strong")]), md(item.acceptance)], { gap: "sm" });
    return col(
      compact<NativeChild>([
        text([span("Acceptance", "strong"), span(` · amended by ${ruling.id}`, "warning")]),
        md(ruling.acceptance),
        kv([
          ["Note", ruling.note ? singleLine(ruling.note) : undefined],
          ["Confirmed", formatTime(ruling.confirmedAt)],
        ]),
        text([span("Approved plan: ", "muted"), span(singleLine(item.acceptance), "dim")], { wrap: "word" }),
      ]),
      { gap: "sm" },
    );
  }

  /** A running row's child: its clock, current tool, model and usage, and the newest tools and output. */
  #describeLive(item: AtlasRowDetail, live: AtlasLiveRow | undefined): NativeNode {
    const progress = live?.progress;
    const now = Date.now();
    const children: NativeChild[] = [
      rowNode(compact<NativeChild>([text([span("Live", "strong")]), item.startedAt !== undefined && elapsedNode(now - item.startedAt)]), {
        gap: "sm",
        align: "center",
      }),
    ];
    if (progress?.currentTool) {
      const started = progress.currentToolStartMs;
      children.push(
        rowNode(compact<NativeChild>([text([span(progress.currentTool, "code")]), started !== undefined && elapsedNode(now - started)]), {
          gap: "sm",
          align: "center",
        }),
      );
      // Arguments can be a whole file body; the first lines identify the call.
      if (progress.currentToolArgs)
        children.push(text([span(singleLine(progress.currentToolArgs), "dim")], { wrap: "word", lines: 3, truncate: "end" }));
    }
    const context =
      progress && (progress.contextTokens !== undefined || progress.contextWindow !== undefined)
        ? `${progress.contextTokens === undefined ? "?" : formatNumber(progress.contextTokens)}/${progress.contextWindow === undefined ? "?" : formatNumber(progress.contextWindow)} tokens`
        : undefined;
    const fields = kv([
      ["Child", live?.childAgentId ?? item.childAgentId ?? "—"],
      ["State", live?.status],
      [
        "Model",
        progress
          ? `${progress.resolvedModel ?? "—"}${progress.resolvedThinkingLevel ? ` · ${progress.resolvedThinkingLevel}` : ""}`
          : undefined,
      ],
      ["Intent", progress?.lastIntent ? singleLine(progress.lastIntent) : undefined],
      [
        "Usage",
        progress ? `${progress.toolCount} tools · ${progress.requests} requests · ${formatNumber(progress.tokens)} tokens` : undefined,
      ],
      ["Context", context],
      ["Cost", progress ? `$${progress.cost.toFixed(4)}` : undefined],
      [
        "Retry",
        progress?.retryState
          ? [
              span(
                `${progress.retryState.attempt}/${progress.retryState.maxAttempts} · ${singleLine(progress.retryState.errorMessage)}`,
                "warning",
              ),
            ]
          : undefined,
      ],
      ["Failure", progress?.retryFailure ? [span(singleLine(progress.retryFailure.errorMessage), "error")] : undefined],
    ]);
    if (fields) children.push(fields);
    // The host keeps both lists newest first.
    if (progress?.recentTools.length) {
      children.push(
        col(
          [
            text([span("Recent tools", "muted")]),
            ...progress.recentTools
              .slice(0, 3)
              .map((tool) => text([span(tool.tool, "code"), span(` ${singleLine(tool.args)}`, "dim")], { truncate: "end", lines: 1 })),
          ],
          { gap: "xs" },
        ),
      );
    }
    if (progress?.recentOutput.length) {
      children.push(
        col(
          [
            text([span("Recent output", "muted")]),
            ...progress.recentOutput
              .slice(0, 4)
              .reverse()
              .map((output) => text(output, { wrap: "word" })),
          ],
          { gap: "xs" },
        ),
      );
    }
    if (!progress) {
      const waiting = !live
        ? "Waiting for the child to start"
        : live.status === "started" || live.status === "running"
          ? "No progress reported by this child yet"
          : `Child ${live.status}; waiting for the ledger to record the result`;
      children.push(text([span(waiting, "muted")], { wrap: "word" }));
    }
    return col(children, { gap: "sm", role: "omp.atlas.live" });
  }

  /** The archived child output as a disclosure; opening it reads the archive, as Space does. */
  #describeOutput(id: string, file: string): NativeNode {
    const expanded = this.#expanded.has(id);
    const output = this.#outputs.get(file);
    let body: NativeChild[] = [];
    if (expanded && output?.state === "loading") body = [text([span("Loading...", "muted")])];
    else if (expanded && output?.state === "failed")
      body = [text([span(`Cannot read output: ${output.error}`, "error")], { wrap: "word" })];
    else if (expanded && output?.state === "loaded") body = [output.text ? md(output.text) : text([span("(empty output)", "muted")])];
    return node(
      "section",
      { head: [span("Child output", "strong"), span(` ${file}`, "dim")], collapsible: true, collapsed: !expanded },
      body,
      "output",
    );
  }

  /** Newest first, as the TUI timeline; entries keep their keys as new events arrive on top. */
  #describeTimeline(): NativeChild[] {
    const events = this.detail.timeline;
    if (!events.length) return [text([span("No recorded activity", "muted")])];
    const entries: NativeChild[] = [];
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index] as AtlasEvent;
      const head = rowNode(
        compact<NativeChild>([
          text([span(formatTime(event.at), "dim")]),
          text([span(event.kind.replaceAll("_", " "), event.derived ? "muted" : undefined)]),
          event.row ? text([span(event.row, "accent")]) : undefined,
          event.derived && node("badge", { text: "derived", tone: "muted" }),
        ]),
        { gap: "sm", align: "baseline", wrap: true },
      );
      // Evidence details repeat the archive path the row body already shows; two lines identify the event.
      const detail = event.detail
        ? text([span(singleLine(event.detail).replace(/^\/\S+\.md: /, ""), "muted")], { wrap: "word", lines: 2, truncate: "end" })
        : undefined;
      entries.push(keyed(col(compact<NativeChild>([head, detail]), { gap: "xs" }), `e${index}`));
    }
    return entries;
  }
}
