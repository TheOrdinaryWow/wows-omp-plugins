import {
  type Component,
  getMarkdownTheme,
  getSelectListTheme,
  Markdown,
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
import { formatNumber } from "@oh-my-pi/pi-utils";

import type { AtlasLive, AtlasLiveSnapshot } from "./atlas-live.ts";
import type { AtlasPlanDetail, AtlasRowDetail } from "./atlas-store.ts";
import type { AtlasEvent } from "./atlas-timeline.ts";

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
  /** Row body and timeline scroll independently; Tab and live refreshes keep both. */
  #rowScroll = 0;
  #timelineScroll = 0;
  #timelineCache?: { events: readonly AtlasEvent[]; width: number; lines: string[] };
  #expanded = new Set<string>();
  #outputs = new Map<string, string>();
  #markdown = new Map<string, Markdown>();
  #message = "";
  #bodyRows = 1;
  #liveSnapshot?: AtlasLiveSnapshot;
  #unsubscribe?: () => void;
  #timeline = false;

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
  }

  #scrollBy(delta: number): void {
    if (this.#timeline) this.#timelineScroll = Math.max(0, this.#timelineScroll + delta);
    else this.#rowScroll = Math.max(0, this.#rowScroll + delta);
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
    const blocked = dispatchBlock(this.detail, kind, this.mode === "display");
    if (blocked) {
      this.#message = blocked;
      return;
    }
    this.done(kind);
  }

  handleInput(key: string): void {
    this.#message = "";
    if (matchesKey(key, "escape") || matchesKey(key, "left")) {
      this.dispose();
      this.done("back");
    } else if (matchesKey(key, "tab")) this.#timeline = !this.#timeline;
    else if (matchesKey(key, "up")) {
      if (this.#timeline) this.#scrollBy(-1);
      else this.#select(this.#selected - 1);
    } else if (matchesKey(key, "down")) {
      if (this.#timeline) this.#scrollBy(1);
      else this.#select(this.#selected + 1);
    } else if (matchesKey(key, "home")) {
      if (this.#timeline) this.#timelineScroll = 0;
      else this.#select(0);
    } else if (matchesKey(key, "end")) {
      // Render clamps to the last page.
      if (this.#timeline) this.#timelineScroll = Number.MAX_SAFE_INTEGER;
      else this.#select(this.detail.rows.length - 1);
    } else if (matchesKey(key, "pageDown")) this.#scrollBy(Math.max(1, this.#bodyRows - 2));
    else if (matchesKey(key, "pageUp")) this.#scrollBy(-Math.max(1, this.#bodyRows - 2));
    else if (!this.#timeline && (matchesKey(key, "space") || key === " " || matchesKey(key, "right"))) this.#toggleOutput();
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
    const summary =
      item.outputPath && item.evidence?.startsWith(`${item.outputPath}: `)
        ? item.evidence.slice(item.outputPath.length + 2)
        : item.evidence;
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
        wrap(this.#outputs.get(item.outputPath) ?? "");
      } else {
        lines.push(t.fg("dim", `Press Space to show the archived child output (${item.outputPath})`));
      }
    }
    lines.push("", t.bold("Acceptance"));
    markdown(item.acceptance);
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
        rawKeyHint("pageDown", "scroll"),
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
    const running = this.#liveSnapshot?.runningChildren ?? this.detail.rows.filter((item) => item.status === "in_progress").length;
    const summary = `${status}  ${progressBar(t, this.detail.done, this.detail.total)} ${counts}  ${running} running · ${formatElapsed(this.detail.startedAt, this.#liveSnapshot?.at ?? Date.now())}  ${tally}`;
    const origin = t.fg("dim", `${this.detail.plan.id}  ${this.detail.plan.cwd || "Workspace unavailable"}`);
    const notice = this.#message || (this.mode === "display" ? "Display only; start or resume from the Unfinished filter" : "");
    const header = [summary, origin, ...(notice ? [t.fg("warning", notice)] : [])];

    this.#bodyRows = Math.max(3, height - 2 - header.length - 2 - hints.length);
    const body = this.#body(bodyWidth);
    const scroll = Math.max(0, Math.min(this.#timeline ? this.#timelineScroll : this.#rowScroll, body.length - this.#bodyRows));
    if (this.#timeline) this.#timelineScroll = scroll;
    else this.#rowScroll = scroll;
    const shown = body.slice(scroll, scroll + this.#bodyRows);
    // The notice replaces the last visible line, so that line counts as hidden too.
    const more = body.length - scroll - shown.length + 1;
    if (more > 1 && shown.length) shown[shown.length - 1] = t.fg("dim", `+${more} more lines; PgDn to scroll`);
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
