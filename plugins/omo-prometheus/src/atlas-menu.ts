import { getSelectListTheme, matchesKey, padding, type Theme, type TUI, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { OverlayPanel, PanelDivider, PanelRows, rawKeyHint, renderSegmentTrack } from "@oh-my-pi/pi-tui/chrome";
import { type SelectItem, SelectList, type SelectListRenderItemContext } from "@oh-my-pi/pi-tui/components/select-list";

import type { AtlasPlanDetail } from "./atlas-store.ts";

export type AtlasFilter = "unfinished" | "all";
export type AtlasMenuAction = {
  kind: "enter" | "delete" | "rename" | "cancel";
  planId?: string;
  filter: AtlasFilter;
  query: string;
};

const FILTERS: AtlasFilter[] = ["unfinished", "all"];
const FILTER_LABELS: Record<AtlasFilter, string> = { unfinished: "Unfinished", all: "All" };
const LIST_ROWS = 8;
const DETAIL_ROWS = 10;
const BAR_WIDTH = 10;

/** Native OMP panel chrome (same frame as the ask/hook selector) around a host SelectList. */
export class AtlasMenu extends OverlayPanel {
  readonly #list: SelectList;
  readonly #details: Map<string, AtlasPlanDetail>;
  readonly #header = new PanelRows();
  readonly #detail = new PanelRows();
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
  ) {
    super("Atlas plans");
    this.#details = new Map(details.map((detail) => [detail.plan.id, detail]));
    this.#filter = filter;
    this.#list = new SelectList(this.#items(), LIST_ROWS, getSelectListTheme(), {
      search: "always",
      emptyText: "No plans in this view — press Tab for All",
      noMatchText: "No plans match the search",
      renderItem: (context) => [this.#renderPlanRow(context)],
      statusText: ({ query, visibleCount, totalCount }) =>
        `  ${query ? `Search: ${query}` : "Type to search"}  ${this.theme.fg("dim", `${visibleCount}/${totalCount}`)}`,
    });
    this.#list.setFilter(query);
    this.#list.onSelect = (item) => this.#act("enter", item.value);
    this.#list.onCancel = () => this.#act("cancel");
    this.#list.onSelectionChange = () => this.tui.requestRender();

    this.addChild(this.#header);
    this.addChild(this.#list);
    this.addChild(new PanelDivider());
    this.addChild(this.#detail);
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

  #bar(done: number, total: number): string {
    if (!total) return this.theme.fg("dim", "─".repeat(BAR_WIDTH));
    const filled = Math.round((done / total) * BAR_WIDTH);
    return this.theme.fg(done === total ? "success" : "accent", "━".repeat(filled)) + this.theme.fg("dim", "─".repeat(BAR_WIDTH - filled));
  }

  #statusColor(detail: AtlasPlanDetail): "success" | "warning" | "error" | "muted" {
    if (detail.status.startsWith("Invalid")) return "error";
    if (!detail.enterable && detail.unfinished) return "warning";
    if (detail.total && detail.done === detail.total) return "success";
    return "muted";
  }

  /** `❯ name ········ ━━━━──── 3/11  In progress` with fixed columns so every row aligns. */
  #renderPlanRow({ item, width, selected }: SelectListRenderItemContext): string {
    const detail = this.#details.get(item.value);
    const cursor = selected ? this.theme.fg("accent", `${this.theme.nav.cursor} `) : "  ";
    if (!detail) return cursor + item.label;
    const counts = detail.total ? `${detail.done}/${detail.total}` : "—";
    const status = detail.status.replace(/\s*\(\d+\/\d+\)/, "").replace(/^In progress \d+\/\d+/, "In progress");
    const tail = `  ${this.#bar(detail.done, detail.total)} ${counts.padStart(5)}  ${this.theme.fg(this.#statusColor(detail), status)}`;
    const nameWidth = Math.max(8, width - 2 - visibleWidth(tail));
    const name = truncateToWidth(item.label, nameWidth);
    const styledName = this.theme.fg(selected ? "accent" : "text", name);
    return truncateToWidth(cursor + styledName + padding(Math.max(0, nameWidth - visibleWidth(name))) + tail, width);
  }

  #rowMark(status: string): string {
    const s = this.theme.status;
    if (status === "done") return this.theme.fg("success", s.success);
    if (status === "in_progress") return this.theme.fg("accent", s.running);
    if (status === "blocked") return this.theme.fg("error", s.error);
    return this.theme.fg("dim", s.pending);
  }

  #syncRows(): void {
    const tabs = renderSegmentTrack(
      FILTERS.map((filter) => ({ label: FILTER_LABELS[filter] })),
      FILTERS.indexOf(this.#filter),
    );
    const note = this.#message
      ? this.theme.fg("warning", this.#message)
      : this.#filter === "all"
        ? this.theme.fg("dim", "Display only — Tab back to Unfinished to enter")
        : "";
    this.#header.setLines(["", `${tabs}  ${note}`, ""]);

    const selected = this.#list.getSelectedItem();
    const detail = selected && this.#details.get(selected.value);
    const lines: string[] = [];
    if (detail) {
      lines.push(`${this.theme.bold(this.theme.fg("accent", detail.plan.name))}  ${this.theme.fg("dim", detail.plan.id)}`);
      lines.push(this.theme.fg("muted", detail.plan.cwd || "Workspace unavailable"));
      if (detail.status.startsWith("Invalid") || detail.status.includes("Different workspace") || detail.status.startsWith("In use"))
        lines.push(this.theme.fg(this.#statusColor(detail), detail.status));
      lines.push("");
      const idWidth = Math.max(0, ...detail.rows.map((row) => row.id.length));
      // Theme status glyphs differ in cell width (✔ is 1, ⏳ is 2); pad them to one column width.
      const marks = detail.rows.map((row) => this.#rowMark(row.status));
      const markWidth = Math.max(1, ...marks.map((mark) => visibleWidth(mark)));
      detail.rows.slice(0, DETAIL_ROWS).forEach((row, index) => {
        const mark = marks[index] ?? "";
        lines.push(`${mark}${padding(markWidth - visibleWidth(mark))} ${this.theme.fg("muted", row.id.padEnd(idWidth))}  ${row.title}`);
      });
      const hidden = detail.rows.length - DETAIL_ROWS;
      if (hidden > 0) lines.push(this.theme.fg("dim", `… ${hidden} more ${hidden === 1 ? "row" : "rows"}`));
    } else {
      lines.push(this.theme.fg("dim", "No plan selected"));
    }
    this.#detail.setLines(lines);

    this.#footer.setLines([
      [
        rawKeyHint("space", "enter"),
        rawKeyHint("delete", "delete"),
        `${this.theme.fg("dim", "⇧N")}${this.theme.fg("muted", " rename")}`,
        rawKeyHint("tab", "filter"),
        rawKeyHint("escape", "close"),
      ].join("   "),
    ]);
  }

  #act(kind: AtlasMenuAction["kind"], planId?: string): void {
    const blocked =
      kind === "enter" &&
      (this.#filter === "all"
        ? "All is display-only; press Tab for Unfinished to enter"
        : planId && this.#details.get(planId)?.enterable === false
          ? `Cannot enter: ${this.#details.get(planId)?.status}`
          : undefined);
    if (blocked) {
      this.#message = blocked;
      this.tui.requestRender();
      return;
    }
    this.done({ kind, planId, filter: this.#filter, query: this.#list.getFilter() });
  }

  handleInput(key: string): void {
    if (matchesKey(key, "tab")) {
      this.#filter = this.#filter === "unfinished" ? "all" : "unfinished";
      this.#message = "";
      this.#list.setItems(this.#items());
    } else if (matchesKey(key, "space") || key === " ") {
      const selected = this.#list.getSelectedItem();
      if (selected) this.#act("enter", selected.value);
    } else if (matchesKey(key, "delete") || (matchesKey(key, "backspace") && !this.#list.getFilter())) {
      const selected = this.#list.getSelectedItem();
      if (selected) this.#act("delete", selected.value);
    } else if (key === "N" || matchesKey(key, "shift+n")) {
      const selected = this.#list.getSelectedItem();
      if (selected) this.#act("rename", selected.value);
    } else {
      this.#message = "";
      this.#list.handleInput(key);
    }
    this.tui.requestRender();
  }

  override render(width: number): readonly string[] {
    this.#syncRows();
    return super.render(width);
  }
}
