import { getSelectListTheme, matchesKey, type Theme, type TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { type SelectItem, SelectList } from "@oh-my-pi/pi-tui/components/select-list";

import type { AtlasPlanDetail } from "./atlas-store.ts";

export type AtlasFilter = "unfinished" | "all";
export type AtlasMenuAction = {
  kind: "enter" | "delete" | "rename" | "cancel";
  planId?: string;
  filter: AtlasFilter;
  query: string;
};

export class AtlasMenu {
  readonly #list: SelectList;
  readonly #details: Map<string, AtlasPlanDetail>;
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
    this.#details = new Map(details.map((detail) => [detail.plan.id, detail]));
    this.#filter = filter;
    this.#list = new SelectList(this.#items(), 8, getSelectListTheme(), {
      search: "always",
      emptyText: "No plans in this view. Press Tab for All.",
      statusText: ({ query }) =>
        `  ${this.#filter === "all" ? "All · Display-only (enter refused)" : "Unfinished"}${query ? ` · Search: ${query}` : ""}${this.#message ? ` · ${this.#message}` : ""}`,
    });
    this.#list.setFilter(query);
    this.#list.onSelect = (item) => this.#act("enter", item.value);
    this.#list.onCancel = () => this.#act("cancel");
    this.#list.onSelectionChange = () => this.tui.requestRender();
  }

  #items(): SelectItem[] {
    return [...this.#details.values()]
      .filter((detail) => this.#filter === "all" || detail.unfinished)
      .map(({ plan, status }) => ({
        value: plan.id,
        label: plan.name,
        description: `${status} · ${plan.id}`,
        searchText: `${plan.id} ${status}`,
      }));
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

  render(width: number): string[] {
    const lines = [this.theme.fg("accent", "Atlas plans"), ...this.#list.render(width)];
    const selected = this.#list.getSelectedItem();
    const detail = selected && this.#details.get(selected.value);
    if (detail) {
      lines.push(this.theme.fg("muted", truncateToWidth(`  ${detail.plan.cwd || "Workspace unavailable"}`, width)));
      for (const row of detail.rows) {
        lines.push(truncateToWidth(`  ${row.id} ${row.title} · ${row.status}`, width));
      }
    }
    lines.push(this.theme.fg("muted", truncateToWidth("  Type: search · Space/Enter: enter · Backspace (empty)/Delete: delete", width)));
    lines.push(this.theme.fg("muted", truncateToWidth("  Shift+N: rename · Tab: Unfinished/All · Esc: close", width)));
    return lines;
  }

  invalidate(): void {
    this.#list.invalidate();
  }
}
