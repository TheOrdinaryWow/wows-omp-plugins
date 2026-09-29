import {
  type Component,
  getSelectListTheme,
  matchesKey,
  padding,
  type Theme,
  type TUI,
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

import type { AtlasPlanDetail, AtlasRowDetail } from "./atlas-store.ts";

export type AtlasFilter = "unfinished" | "all";
export type AtlasDispatch = "start" | "resume";
export type AtlasMenuAction = {
  kind: AtlasDispatch | "inspect" | "delete" | "rename" | "cancel";
  planId?: string;
  filter: AtlasFilter;
  query: string;
};
export type AtlasPlanViewAction = AtlasDispatch | "back";

const TITLE = "Atlas Dispatch";
const FILTERS: AtlasFilter[] = ["unfinished", "all"];
const FILTER_LABELS: Record<AtlasFilter, string> = { unfinished: "Unfinished", all: "All" };
const LIST_ROWS = 8;
const PREVIEW_ROWS = 10;
const BAR_WIDTH = 10;

/** Why a plan cannot be started or resumed from here; undefined when it can. */
export function dispatchBlock(detail: AtlasPlanDetail, kind: AtlasDispatch, displayOnly: boolean): string | undefined {
  if (displayOnly) return "All is display-only; press Tab for Unfinished to start or resume";
  if (detail.inUse) return `Cannot ${kind}: in use by another session, and a plan runs in one session at a time`;
  if (!detail.enterable) return `Cannot ${kind}: ${detail.status}`;
  if (kind === "resume" && !detail.started) return "Cannot resume: not started yet; press Enter to start";
  return undefined;
}

function progressBar(theme: Theme, done: number, total: number): string {
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

function rowMark(theme: Theme, status: string): string {
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

const ROW_STATUS: Record<string, string> = { open: "Not started", in_progress: "In progress", done: "Done", blocked: "Blocked" };

/** Native OMP panel chrome (same frame as the ask/hook selector) around a host SelectList. */
export class AtlasMenu extends OverlayPanel {
  readonly #list: SelectList;
  readonly #details: Map<string, AtlasPlanDetail>;
  readonly #header = new PanelRows();
  readonly #preview = new PanelRows();
  readonly #footer = new PanelRows();
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
      emptyText: "No plans in this view; press Tab for All",
      noMatchText: "No plans match the search",
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

  handleInput(key: string): void {
    if (matchesKey(key, "tab")) {
      this.#filter = this.#filter === "unfinished" ? "all" : "unfinished";
      this.#message = "";
      this.#list.setItems(this.#items());
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
}

/**
 * Fullscreen plan inspector: summary, a row sidebar, and the selected row's acceptance, evidence and
 * (on demand) its archived native child output.
 */
export class AtlasPlanView implements Component {
  #selected = 0;
  #scroll = 0;
  #expanded = new Set<string>();
  #outputs = new Map<string, string>();
  #message = "";
  #bodyRows = 1;

  constructor(
    readonly detail: AtlasPlanDetail,
    readonly displayOnly: boolean,
    readonly theme: Theme,
    readonly tui: TUI,
    readonly readOutput: (file: string) => Promise<string>,
    readonly done: (action: AtlasPlanViewAction) => void,
  ) {}

  #row(): AtlasRowDetail | undefined {
    return this.detail.rows[this.#selected];
  }

  #select(index: number): void {
    const next = Math.max(0, Math.min(this.detail.rows.length - 1, index));
    if (next === this.#selected) return;
    this.#selected = next;
    this.#scroll = 0;
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
    this.#outputs.set(file, this.theme.fg("dim", "Loading..."));
    this.readOutput(file).then(
      (text) => {
        this.#outputs.set(file, text.trimEnd() || this.theme.fg("dim", "(empty output)"));
        this.tui.requestRender();
      },
      (error: unknown) => {
        this.#outputs.set(file, this.theme.fg("error", `Cannot read output: ${error instanceof Error ? error.message : String(error)}`));
        this.tui.requestRender();
      },
    );
  }

  #dispatch(kind: AtlasDispatch): void {
    const blocked = dispatchBlock(this.detail, kind, this.displayOnly);
    if (blocked) {
      this.#message = blocked;
      return;
    }
    this.done(kind);
  }

  handleInput(key: string): void {
    this.#message = "";
    if (matchesKey(key, "escape") || matchesKey(key, "left")) this.done("back");
    else if (matchesKey(key, "up")) this.#select(this.#selected - 1);
    else if (matchesKey(key, "down")) this.#select(this.#selected + 1);
    else if (matchesKey(key, "home")) this.#select(0);
    else if (matchesKey(key, "end")) this.#select(this.detail.rows.length - 1);
    else if (matchesKey(key, "pageDown")) this.#scroll += Math.max(1, this.#bodyRows - 2);
    else if (matchesKey(key, "pageUp")) this.#scroll = Math.max(0, this.#scroll - Math.max(1, this.#bodyRows - 2));
    else if (matchesKey(key, "space") || key === " " || matchesKey(key, "right")) this.#toggleOutput();
    else if (matchesKey(key, "enter")) this.#dispatch("start");
    else if (key === "R" || matchesKey(key, "shift+r")) this.#dispatch("resume");
    this.tui.requestRender();
  }

  #sidebar(width: number, height: number): string[] {
    const rows = this.detail.rows;
    if (!rows.length) return [this.theme.fg("dim", "No plan rows")];
    const { marks } = rowMarks(this.theme, rows);
    const idWidth = Math.max(0, ...rows.map((item) => item.id.length));
    const start = Math.max(0, Math.min(this.#selected - Math.floor(height / 2), rows.length - height));
    return rows.slice(start, start + height).map((item, offset) => {
      const index = start + offset;
      const selected = index === this.#selected;
      const cursor = selected ? this.theme.fg("accent", `${this.theme.nav.cursor} `) : "  ";
      const label = `${marks[index] ?? ""} ${this.theme.fg("muted", item.id.padEnd(idWidth))} ${this.theme.fg(selected ? "accent" : "text", item.title)}`;
      return truncateToWidth(cursor + label, width);
    });
  }

  #body(width: number): string[] {
    const item = this.#row();
    if (!item) return [this.theme.fg("dim", "No row selected")];
    const t = this.theme;
    const lines: string[] = [];
    const wrap = (text: string, style: (value: string) => string = (value) => value): void => {
      for (const paragraph of text.split("\n")) lines.push(...wrapTextWithAnsi(style(paragraph), width));
    };
    const field = (label: string, value: string): void => {
      lines.push(...wrapTextWithAnsi(`${t.fg("muted", label.padEnd(10))}${value}`, width));
    };
    wrap(`${item.id}  ${item.title}`, (value) => t.bold(t.fg("accent", value)));
    lines.push("");
    const mark = rowMark(t, item.status);
    field(
      "Status",
      `${mark} ${ROW_STATUS[item.status] ?? item.status}${item.attempt ? t.fg("dim", ` · attempt ${item.attempt.slice(0, 8)}`) : ""}`,
    );
    field("Agent", item.agent);
    field("Depends", item.dependsOn.length ? item.dependsOn.join(", ") : t.format.dash);
    field("Updated", formatTime(item.updatedAt));
    lines.push("", t.bold("Evidence"));
    const summary =
      item.outputPath && item.evidence?.startsWith(`${item.outputPath}: `)
        ? item.evidence.slice(item.outputPath.length + 2)
        : item.evidence;
    if (summary) wrap(summary);
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
        wrap(this.#outputs.get(item.outputPath) ?? "");
      } else {
        lines.push(t.fg("dim", `Press Space to show the archived child output (${item.outputPath})`));
      }
    }
    lines.push("", t.bold("Acceptance"));
    wrap(item.acceptance);
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
        this.theme.fg("dim", `${editorKey("tui.select.up")}/${editorKey("tui.select.down")}`) + this.theme.fg("muted", " row"),
        rawKeyHint("space", "child output"),
        rawKeyHint("pageDown", "scroll"),
        rawKeyHint("enter", "start"),
        rawKeyHint("shift+r", "resume"),
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
    const summary = `${t.fg(statusColor(this.detail), shortStatus(this.detail))}  ${progressBar(t, this.detail.done, this.detail.total)} ${counts}    ${tally}`;
    const origin = t.fg("dim", `${this.detail.plan.id}  ${this.detail.plan.cwd || "Workspace unavailable"}`);
    const notice = this.#message || (this.displayOnly ? "Display only; start or resume from the Unfinished filter" : "");
    const header = [summary, origin, ...(notice ? [t.fg("warning", notice)] : [])];

    this.#bodyRows = Math.max(3, height - 2 - header.length - 2 - hints.length);
    const body = this.#body(bodyWidth);
    this.#scroll = Math.max(0, Math.min(this.#scroll, body.length - this.#bodyRows));
    const shown = body.slice(this.#scroll, this.#scroll + this.#bodyRows);
    const more = body.length - this.#scroll - shown.length;
    if (more > 0 && shown.length) shown[shown.length - 1] = t.fg("dim", `+${more} more lines; PgDn to scroll`);
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
}
