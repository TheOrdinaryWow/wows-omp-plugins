import {
  computed,
  type JSXNode,
  type KeyEvent,
  nativeRendering,
  type ScrollRequest,
  signal,
  type UiEvent,
  type UiNode,
} from "@oh-my-pi/pi-tui";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspPickerAction, TspPickerItem, TspSpan, TspText } from "@oh-my-pi/pi-wire";

import { h, kv, span } from "#src/tsp.ts";

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
/** The terminal's size in cells, as `ui.size()` reports it (reactive inside nodes). */
export type AtlasViewSize = () => { readonly columns: number; readonly rows: number };

const TITLE = "Atlas Dispatch";
const FILTERS: AtlasFilter[] = ["unfinished", "all"];
const FILTER_LABELS: Record<AtlasFilter, string> = { unfinished: "Unfinished", all: "All" };
const LIST_ROWS = 8;
const PREVIEW_ROWS = 10;
const PLAN_ROLE = "omp.overlay.omoPrometheus.plan";
/** Menu buttons that act on the highlighted plan, as their keys do. */
const MENU_PLAN_ACTIONS: readonly string[] = ["start", "resume", "inspect", "delete", "rename"] satisfies AtlasMenuAction["kind"][];
const EMPTY_TEXT = "No plans in this view; press Tab for All";
const NO_MATCH_TEXT = "No plans match the search";
const DISPLAY_ONLY = "Display only; press Tab for Unfinished to start or resume";

// Tern sizes lg sheets by content, so roots take a fixed terminal line extent; a list is the only scroll container.
const FILL = { grow: 1, shrink: 1, basis: 0, min: { h: 0 } } as const;
const SCROLLER = { ...FILL, max: { lines: 10_000 } } as const;
const SHEET_MARGIN_LINES = 8;
const SHEET_MIN_LINES = 16;

function sheetLines(rows: number): number {
  return Math.max(SHEET_MIN_LINES, rows - SHEET_MARGIN_LINES);
}

/** The view itself in a terminal (the host frames it); in Tern a large modal sheet of the plugin's own role around it. */
function sheet(screen: UiNode, role: string, head: TspText | (() => TspText)): UiNode {
  return nativeRendering() ? h("overlay", { role, size: "lg", anchor: "center", modal: true, head }, screen) : screen;
}

/** The last segment of an event's keypath: the key of the node it names. */
function leafKey(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** Why a plan cannot be started or resumed from here; undefined when it can. */
export function dispatchBlock(detail: AtlasPlanDetail, kind: AtlasDispatch, displayOnly: boolean): string | undefined {
  if (displayOnly) return "All is display-only; press Tab for Unfinished to start or resume";
  if (detail.inUse) return `Cannot ${kind}: in use by another session, and a plan runs in one session at a time`;
  if (!detail.enterable) return `Cannot ${kind}: ${detail.status}`;
  if (kind === "resume" && !detail.started) return "Cannot resume: not started yet; press Enter to start";
  return undefined;
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

/** Statuses worth repeating in full under the plan: why it cannot run here. */
function flaggedStatus(detail: AtlasPlanDetail): boolean {
  return detail.status.startsWith("Invalid") || detail.status.includes("Different workspace") || detail.inUse;
}

export function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Child-supplied text (intents, tool args, errors) collapsed onto one display line. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const ROW_STATUS: Record<string, string> = { open: "Not started", in_progress: "In progress", done: "Done", blocked: "Blocked" };
const TEXT_MARK: Record<string, string> = { open: "[ ]", in_progress: "[~]", done: "[x]", blocked: "[!]" };

/** One tone and icon per ledger status, and the checklist state it reads as. */
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

/** A plan's progress as a bar, green once every row is done, labelled with its counts unless `label` says more. */
export function progressNode(done: number, total: number, label?: TspText): UiNode {
  return h("progress", {
    value: total ? done / total : 0,
    label: label ?? (total ? `${done}/${total}` : "—"),
    tone: total && done === total ? "success" : "accent",
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

/** A key the user typed as text: a printable character without a control modifier. */
function typedText(key: KeyEvent): string | undefined {
  if (!key.text || [...key.text].length !== 1 || /^(ctrl|alt|super)\+/.test(key.id)) return undefined;
  return key.text;
}

/**
 * The Atlas Dispatch console: filter tabs, a searchable plan list and the highlighted plan's rows, drawn as one
 * `picker` by the terminal and by Tern. Keys, row clicks, tab clicks and buttons all run the same actions.
 */
export class AtlasMenu {
  readonly #details: Map<string, AtlasPlanDetail>;
  readonly #revision = signal(0);
  #filter: AtlasFilter;
  #query: string;
  #selected: string | undefined;
  #message: string;

  constructor(
    details: readonly AtlasPlanDetail[],
    filter: AtlasFilter,
    query: string,
    readonly done: (result: AtlasMenuAction) => void,
    options: { selectedId?: string; message?: string } = {},
  ) {
    this.#details = new Map(details.map((detail) => [detail.plan.id, detail]));
    this.#filter = filter;
    this.#query = query;
    this.#selected = options.selectedId;
    this.#message = options.message ?? "";
  }

  #changed(): void {
    this.#revision.update((value) => value + 1);
  }

  #inFilter(): AtlasPlanDetail[] {
    return [...this.#details.values()].filter((detail) => this.#filter === "all" || detail.unfinished);
  }

  /** Plans in the filter whose name, id or status contains every search word. */
  #visible(): AtlasPlanDetail[] {
    const words = this.#query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.#inFilter().filter((detail) => {
      const haystack = `${detail.plan.name} ${detail.plan.id} ${detail.status}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  /** The highlighted plan: the remembered one while it is shown, else the first shown. */
  #current(visible = this.#visible()): AtlasPlanDetail | undefined {
    return visible.find((detail) => detail.plan.id === this.#selected) ?? visible[0];
  }

  #act(kind: AtlasMenuAction["kind"], planId?: string): void {
    const detail = planId ? this.#details.get(planId) : undefined;
    const blocked = (kind === "start" || kind === "resume") && detail ? dispatchBlock(detail, kind, this.#filter === "all") : undefined;
    if (blocked) {
      this.#message = blocked;
      this.#changed();
      return;
    }
    this.done({ kind, planId, filter: this.#filter, query: this.#query });
  }

  #actOnSelected(kind: AtlasMenuAction["kind"]): void {
    const selected = this.#current();
    if (selected) this.#act(kind, selected.plan.id);
  }

  #setFilter(filter: AtlasFilter): void {
    this.#filter = filter;
    this.#message = "";
    this.#changed();
  }

  #select(id: string): void {
    this.#selected = id;
    this.#message = "";
    this.#changed();
  }

  /** Move the highlight by `delta`; single steps wrap, pages stop at the ends. */
  #move(delta: number): void {
    const visible = this.#visible();
    if (!visible.length) return;
    const at = Math.max(0, visible.indexOf(this.#current(visible) as AtlasPlanDetail));
    let next = at + delta;
    if (Math.abs(delta) === 1) next = (next + visible.length) % visible.length;
    else next = Math.max(0, Math.min(visible.length - 1, next));
    this.#select((visible[next] as AtlasPlanDetail).plan.id);
  }

  #search(query: string): void {
    this.#query = query;
    this.#message = "";
    this.#changed();
  }

  /** Every key the console answers; typed characters search. */
  key(key: KeyEvent): boolean {
    if (key.kind === "release") return false;
    switch (key.id) {
      case "tab":
        this.#setFilter(this.#filter === "unfinished" ? "all" : "unfinished");
        return true;
      case "space":
      case "shift+i":
        this.#actOnSelected("inspect");
        return true;
      case "shift+r":
        this.#actOnSelected("resume");
        return true;
      case "shift+n":
        this.#actOnSelected("rename");
        return true;
      case "delete":
        this.#actOnSelected("delete");
        return true;
      case "backspace":
        if (this.#query) this.#search(this.#query.slice(0, -1));
        else this.#actOnSelected("delete");
        return true;
      case "enter":
        this.#actOnSelected("start");
        return true;
      case "escape":
        this.#act("cancel");
        return true;
      case "up":
        this.#move(-1);
        return true;
      case "down":
        this.#move(1);
        return true;
      case "pageUp":
        this.#move(-LIST_ROWS);
        return true;
      case "pageDown":
        this.#move(LIST_ROWS);
        return true;
      case "home":
        this.#move(-this.#details.size);
        return true;
      case "end":
        this.#move(this.#details.size);
        return true;
    }
    const typed = typedText(key);
    if (typed === undefined) return false;
    this.#search(this.#query + typed);
    return true;
  }

  /** A row click highlights a plan; double-clicking (or clicking the highlighted row) opens its details. */
  #onEvent(event: UiEvent): void {
    if (event.type === "select" && this.#details.has(event.item)) this.#select(event.item);
    else if (event.type === "activate" && this.#details.has(event.item)) {
      this.#selected = event.item;
      this.#act("inspect", event.item);
    } else if (event.type === "action") {
      if (event.act === "tab") {
        const filter = FILTERS.find((value) => value === event.value);
        if (filter && filter !== this.#filter) this.#setFilter(filter);
      } else if (event.act === "filter") this.#setFilter(this.#filter === "unfinished" ? "all" : "unfinished");
      else if (event.act === "clear") this.#search("");
      else if (event.act === "cancel" || event.act === "close") this.#act("cancel");
      else if (MENU_PLAN_ACTIONS.includes(event.act)) this.#actOnSelected(event.act as AtlasMenuAction["kind"]);
    }
  }

  /** The console's root: the picker, which Tern draws as its own sheet. */
  view(): UiNode {
    const state = computed(() => {
      this.#revision();
      const visible = this.#visible();
      return {
        visible,
        current: this.#current(visible),
        total: this.#inFilter().length,
        query: this.#query,
        filter: this.#filter,
        tabs: this.#tabs(),
        notice: this.#notice(),
      };
    });
    return h(
      "picker",
      {
        title: TITLE,
        noun: "plans",
        size: "lg",
        layout: "rows",
        preview: "side",
        placeholder: "Type to search",
        query: () => state().query,
        tabs: () => state().tabs,
        tab: () => state().filter,
        columns: [
          { id: "progress", format: "bar", min: 10 },
          { id: "count", format: "num" },
        ],
        items: () => state().visible.map((detail) => this.#item(detail)),
        selected: () => state().current?.plan.id ?? null,
        total: () => state().total,
        empty: () => (state().query.trim() ? NO_MATCH_TEXT : EMPTY_TEXT),
        // Tern shows a ready picker's subtitle, not its message: refusals and the display-only note go there.
        subtitle: () => state().notice,
        actions: MENU_ACTIONS,
        term: () => this.#term(state().visible, state().total),
        onKey: (key) => this.key(key),
        onEvent: (event) => this.#onEvent(event),
      },
      () => this.#preview(state().current),
    );
  }

  #tabs(): { id: string; label: TspText; count: number }[] {
    const unfinished = [...this.#details.values()].filter((detail) => detail.unfinished).length;
    return FILTERS.map((id) => ({ id, label: FILTER_LABELS[id], count: id === "all" ? this.#details.size : unfinished }));
  }

  #notice(): TspText | undefined {
    if (this.#message) return [span(this.#message, "warning")];
    return this.#filter === "all" ? [span(DISPLAY_ONLY, "muted")] : undefined;
  }

  /** One plan: name, short status in its tone, and its done/total as a bar and a count. */
  #item(detail: AtlasPlanDetail): TspPickerItem {
    const tone = statusColor(detail);
    return {
      id: detail.plan.id,
      label: detail.plan.name,
      detail: [span(shortStatus(detail), tone)],
      tone,
      title: detail.plan.cwd || "Workspace unavailable",
      facts: { progress: detail.total ? detail.done / detail.total : 0, count: detail.total ? `${detail.done}/${detail.total}` : "—" },
    };
  }

  /** Terminal look: the filter strip and notice above the search, one aligned row per plan, wrapped key hints. */
  #term(visible: readonly AtlasPlanDetail[], total: number): Record<string, unknown> {
    const strip: TspSpan[] = [];
    for (const tab of this.#tabs()) {
      if (strip.length) strip.push(span("  "));
      const active = tab.id === this.#filter;
      strip.push(span(` ${tab.label} ${tab.count} `, active ? "strong accent inverse" : "muted"));
    }
    strip.push(span(`   ${visible.length}/${total} shown`, "dim"));
    const notice = this.#notice();
    const nameWidth = Math.min(40, Math.max(12, ...visible.map((detail) => visibleWidth(detail.plan.name))));
    const rows: Record<string, TspText> = {};
    for (const detail of visible) {
      const count = detail.total ? `${detail.done}/${detail.total}` : "—";
      rows[detail.plan.id] = [
        span(padTo(truncate(detail.plan.name, nameWidth), nameWidth)),
        span(`  ${count.padStart(5)}  `, "muted"),
        span(shortStatus(detail), statusColor(detail)),
      ];
    }
    return {
      head: notice ? [strip, notice] : [strip],
      rows,
      maxRows: LIST_ROWS,
      hintWrap: true,
      empty: this.#query.trim() ? NO_MATCH_TEXT : EMPTY_TEXT,
    };
  }

  /** The highlighted plan: where it runs, why it cannot, its progress and its first rows as a checklist. */
  #preview(detail: AtlasPlanDetail | undefined): JSXNode {
    if (!detail) return h("text", { key: "preview", spans: [span("No plan selected", "muted")] });
    const hidden = detail.rows.length - PREVIEW_ROWS;
    return h(
      "col",
      { key: "preview", gap: "sm" },
      h(
        "col",
        {},
        h("text", { spans: [span(detail.plan.name, "strong accent"), span(`  ${detail.plan.id}`, "dim")], truncate: "end" }),
        h("text", { spans: [span(detail.plan.cwd || "Workspace unavailable", "muted")], truncate: "middle" }),
        flaggedStatus(detail) ? h("text", { spans: [span(detail.status, statusColor(detail))], wrap: "word" }) : undefined,
      ),
      progressNode(detail.done, detail.total),
      detail.rows.length
        ? h("checklist", {
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
          })
        : h("text", { spans: [span("No plan rows", "muted")] }),
      hidden > 0
        ? h("text", { spans: [span(`+${hidden} more ${hidden === 1 ? "row" : "rows"}; press Space for details`, "muted")] })
        : undefined,
    );
  }
}

const MENU_ACTIONS: readonly TspPickerAction[] = [
  { id: "start", label: "Start", keys: ["enter"], primary: true },
  { id: "inspect", label: "Details", keys: ["space"] },
  { id: "resume", label: "Resume", keys: ["shift", "r"] },
  { id: "rename", label: "Rename", keys: ["shift", "n"] },
  { id: "delete", label: "Delete", keys: ["delete"], danger: true },
  { id: "filter", label: "Filter", keys: ["tab"] },
  { id: "cancel", label: "Close", keys: ["esc"], end: true },
];

/** An archived child output being read for the plan view. */
type ChildOutput = { state: "loading" } | { state: "loaded"; text: string } | { state: "failed"; error: string };

function blank(): JSXNode {
  return h("text", { text: " " });
}

function textLine(spans: readonly TspSpan[], wrapped = true): JSXNode {
  return h("text", { spans, ...(wrapped ? { wrap: "word" } : { truncate: "end" }) });
}

/**
 * Fullscreen plan inspector: summary, a row sidebar, and the selected row's acceptance, evidence and (on demand) its
 * archived native child output, or the plan's timeline. One node tree for the terminal and Tern's sheet.
 */
export class AtlasPlanView {
  #selected = 0;
  /** Terminal body scroll in painted rows; row body and timeline scroll independently, and Tab and live refreshes keep both. */
  #rowScroll = 0;
  #timelineScroll = 0;
  #expanded = new Set<string>();
  #outputs = new Map<string, ChildOutput>();
  #message = "";
  #liveSnapshot?: AtlasLiveSnapshot;
  #unsubscribe?: () => void;
  #timeline = false;
  /** Rows the terminal body painted last, for clamping scroll keys. */
  #bodyTotal = 0;
  #bodyCache?: { content: UiNode; width: number; rows: readonly string[]; timeline: boolean; events: readonly AtlasEvent[] };
  /** The last scroll key while Tern renders, forwarded to its scroller (see `ScrollRequest`). */
  #nativeScroll?: ScrollRequest;
  readonly #revision = signal(0);
  detail: AtlasPlanDetail;

  constructor(
    detail: AtlasPlanDetail,
    readonly mode: AtlasPlanViewMode,
    readonly readOutput: (file: string) => Promise<string>,
    readonly done: (action: AtlasPlanViewAction) => void,
    live?: AtlasLive,
    readonly size: AtlasViewSize = () => ({ columns: process.stdout.columns || 100, rows: process.stdout.rows || 40 }),
  ) {
    this.detail = detail;
    if (live && mode === "active")
      this.#unsubscribe = live.subscribe((snapshot) => {
        const previous = this.#liveSnapshot;
        this.#liveSnapshot = snapshot;
        if (snapshot.detail !== this.detail) this.updateDetail(snapshot.detail);
        // The terminal paints elapsed clocks once per frame, so it redraws on every tick; Tern clocks them itself.
        else if (!previous || !nativeRendering() || this.#liveChanged(previous, snapshot)) this.#changed();
      });
  }

  /** Clock ticks repeat the last state; only the running count or a running row's child changes what is shown. */
  #liveChanged(previous: AtlasLiveSnapshot, next: AtlasLiveSnapshot): boolean {
    if (previous.runningChildren !== next.runningChildren) return true;
    return this.detail.rows.some((item) => item.status === "in_progress" && previous.rows.get(item.id) !== next.rows.get(item.id));
  }

  #changed(): void {
    this.#revision.update((value) => value + 1);
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  updateDetail(detail: AtlasPlanDetail): void {
    const selectedId = this.#row()?.id;
    const next = detail.rows.findIndex((row) => row.id === selectedId);
    // New events arrive on top; keep a reader who scrolled into history on the same entries.
    const added = detail.timeline.length - this.detail.timeline.length;
    if (this.#timelineScroll > 0 && added > 0) this.#timelineScroll += added;
    this.detail = detail;
    if (next >= 0) this.#selected = next;
    else {
      this.#selected = Math.min(this.#selected, Math.max(0, detail.rows.length - 1));
      this.#rowScroll = 0;
    }
    this.#changed();
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

  // ── geometry ──

  #sidebarWidth(columns: number): number {
    return Math.max(18, Math.min(52, Math.floor(columns * 0.36)));
  }

  /** Lines left for the sidebar and body under the header. */
  #bodyRows(rows: number): number {
    const height = nativeRendering() ? sheetLines(rows) : rows;
    const header = (nativeRendering() ? 7 : 8) + (this.detail.rulings?.length ? 1 : 0) + (this.#notice() ? 1 : 0);
    return Math.max(3, height - header);
  }

  // ── scrolling ──

  #scroll(): number {
    return this.#timeline ? this.#timelineScroll : this.#rowScroll;
  }

  /** Scroll the terminal body to `value` rows, clamped so the last painted row can still reach the bottom. */
  #setScroll(value: number): void {
    const max = Math.max(0, this.#bodyTotal - this.#bodyRows(this.size().rows));
    const next = Math.max(0, Math.min(max, value));
    if (this.#timeline) this.#timelineScroll = next;
    else this.#rowScroll = next;
  }

  /** Terminal: move the body by its height less one row. Tern: page its own scroller. */
  #page(direction: 1 | -1): void {
    if (nativeRendering()) this.#requestScroll(direction > 0 ? "page-down" : "page-up");
    else this.#setScroll(this.#scroll() + direction * Math.max(1, this.#bodyRows(this.size().rows) - 1));
  }

  #requestScroll(by: ScrollRequest["by"]): void {
    this.#nativeScroll = { by, n: (this.#nativeScroll?.n ?? 0) + 1 };
  }

  /** Timeline line and end keys: rows in the terminal, Tern's scroller in Tern. */
  #scrollTimeline(by: "line-up" | "line-down" | "start" | "end"): void {
    if (nativeRendering()) this.#requestScroll(by);
    else if (by === "start") this.#setScroll(0);
    else if (by === "end") this.#setScroll(Number.MAX_SAFE_INTEGER);
    else this.#setScroll(this.#timelineScroll + (by === "line-down" ? 1 : -1));
  }

  // ── input ──

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
        this.#changed();
      },
      (error: unknown) => {
        this.#outputs.set(file, { state: "failed", error: error instanceof Error ? error.message : String(error) });
        this.#changed();
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

  #leave(action: "back" | "exit"): void {
    this.dispose();
    this.done(action);
  }

  /** Every key the view answers; any key clears the last notice. */
  key(key: KeyEvent): boolean {
    if (key.kind === "release") return false;
    this.#message = "";
    switch (key.id) {
      case "escape":
      case "left":
        this.#leave("back");
        break;
      case "tab":
        this.#timeline = !this.#timeline;
        break;
      case "up":
        if (this.#timeline) this.#scrollTimeline("line-up");
        else this.#select(this.#selected - 1);
        break;
      case "down":
        if (this.#timeline) this.#scrollTimeline("line-down");
        else this.#select(this.#selected + 1);
        break;
      case "home":
        if (this.#timeline) this.#scrollTimeline("start");
        else this.#select(0);
        break;
      case "end":
        if (this.#timeline) this.#scrollTimeline("end");
        else this.#select(this.detail.rows.length - 1);
        break;
      case "pageDown":
        this.#page(1);
        break;
      case "pageUp":
        this.#page(-1);
        break;
      case "space":
      case "right":
        if (!this.#timeline) this.#toggleOutput();
        break;
      case "shift+x":
        if (this.mode === "active") this.#leave("exit");
        break;
      case "enter":
        if (this.mode !== "active") this.#dispatch("start");
        break;
      case "shift+r":
        if (this.mode !== "active") this.#dispatch("resume");
        break;
    }
    this.#changed();
    return true;
  }

  /** Clicks run the key paths: the buttons, the Row/Timeline tabs, a row in the sidebar and the output disclosure. */
  #onEvent(event: UiEvent): void {
    this.#message = "";
    if (event.type === "action") {
      if (event.act === "back" || (event.act === "exit" && this.mode === "active")) {
        this.#leave(event.act);
        return;
      }
      if ((event.act === "start" || event.act === "resume") && this.mode !== "active") this.#dispatch(event.act);
    } else if (event.type === "select" || event.type === "activate") {
      const key = leafKey(event.key);
      if (key === "view") this.#timeline = event.item === "timeline";
      else if (key === "rows" && /^r\d+$/.test(event.item)) {
        const index = Number(event.item.slice(1));
        if (index < this.detail.rows.length) {
          this.#select(index);
          this.#timeline = false;
        }
      }
    } else if (event.type === "toggle" && leafKey(event.key) === "output") {
      const item = this.#row();
      if (item && this.#expanded.has(item.id) === event.collapsed) this.#toggleOutput();
    }
    this.#changed();
  }

  // ── view ──

  /** The view's root: the screen, in Tern inside the plugin's sheet titled by the plan. */
  view(): UiNode {
    const screen = h(
      "col",
      {
        onKey: (key) => this.key(key),
        onEvent: (event) => this.#onEvent(event),
        min: () => (nativeRendering() ? { h: `${sheetLines(this.size().rows)}lines` } : undefined),
        max: () => (nativeRendering() ? { h: `${sheetLines(this.size().rows)}lines` } : undefined),
      },
      () => {
        this.#revision();
        return this.#screen(this.size());
      },
    );
    return sheet(screen, PLAN_ROLE, () => {
      this.#revision();
      return this.detail.plan.name;
    });
  }

  #notice(): string {
    return this.#message || (this.mode === "display" ? "Display only; start or resume from the Unfinished filter" : "");
  }

  #running(): number {
    return this.#liveSnapshot?.runningChildren ?? this.detail.rows.filter((item) => item.status === "in_progress").length;
  }

  #screen({ columns, rows }: { columns: number; rows: number }): JSXNode[] {
    const { detail } = this;
    const native = nativeRendering();
    const notice = this.#notice();
    const tally: TspSpan[] = [];
    for (const status of ["done", "in_progress", "blocked", "open"] as const) {
      const count = detail.rows.filter((item) => item.status === status).length;
      if (!count) continue;
      if (tally.length) tally.push(span(" · ", "dim"));
      tally.push(span(`${count} ${ROW_STATUS[status]?.toLowerCase()}`, ROW_TONE[status]));
    }
    const status = this.mode === "active" ? span("Active in this session", "accent") : span(shortStatus(detail), statusColor(detail));
    const buttons =
      this.mode === "active"
        ? [button("Exit Atlas", "exit", ["shift", "x"], "danger"), button("Back", "back", ["escape"])]
        : [button("Start", "start", ["enter"], "primary"), button("Resume", "resume", ["shift", "r"]), button("Back", "back", ["escape"])];
    const hints: TspSpan[] = [
      span("↑↓", "accent"),
      span(this.#timeline ? " scroll" : " row", "muted"),
      ...(this.#timeline ? [] : [span("  Space", "accent"), span(" child output", "muted")]),
      span("  Tab", "accent"),
      span(this.#timeline ? " row" : " timeline", "muted"),
      span("  PgUp/PgDn", "accent"),
      span(" page", "muted"),
    ];
    const bodyRows = this.#bodyRows(rows);
    const sidebarWidth = this.#sidebarWidth(columns);
    return [
      native
        ? undefined
        : h("text", { key: "title", spans: [span(`${TITLE} · `, "muted"), span(detail.plan.name, "strong accent")], truncate: "end" }),
      h(
        "row",
        { key: "tools", gap: "md", align: "center", justify: "between" },
        h("tabs", {
          key: "view",
          items: [
            { id: "row", label: "Row" },
            { id: "timeline", label: "Timeline" },
          ],
          active: this.#timeline ? "timeline" : "row",
        }),
        h("row", { key: "actions", gap: "sm", align: "center" }, ...buttons),
      ),
      h(
        "col",
        { key: "progress" },
        progressNode(detail.done, detail.total, [
          status,
          span(`  ${detail.total ? `${detail.done}/${detail.total} rows done` : "no rows"}`, "muted"),
        ]),
      ),
      h(
        "row",
        { key: "summary", gap: "md", align: "center" },
        h("text", { spans: [span(`${this.#running()} running`, "muted")], shrink: 0 }),
        detail.startedAt !== undefined ? h("elapsed", { age: Date.now() - detail.startedAt, format: "short", shrink: 0 }) : undefined,
        tally.length ? h("text", { spans: tally, truncate: "end", shrink: 1 }) : undefined,
      ),
      h("text", {
        key: "origin",
        spans: [span(`${detail.plan.id} · ${detail.plan.cwd || "Workspace unavailable"}`, "dim")],
        truncate: "middle",
        lines: 1,
      }),
      detail.rulings?.length
        ? h("text", {
            key: "rulings",
            spans: [
              span(`Owner rulings ${detail.rulings.length}`, "warning"),
              span(`  ${detail.rulings.map((ruling) => `${ruling.id} ${ruling.rowId}`).join(" · ")}`, "muted"),
            ],
            truncate: "end",
          })
        : undefined,
      notice ? h("text", { key: "notice", spans: [span(notice, "warning")], truncate: "end" }) : undefined,
      h("text", { key: "hints", spans: hints, truncate: "end" }),
      h("rule", { key: "divider" }),
      h(
        "row",
        { key: "split", ...FILL, gap: "md", align: "stretch" },
        this.#sidebar(native, sidebarWidth, bodyRows),
        this.#body(native, bodyRows),
      ),
    ];
  }

  /** The ledger rows around the selection, toned and marked by status; a click selects one. */
  #sidebar(native: boolean, width: number, height: number): UiNode {
    const rows = this.detail.rows;
    const start = native ? 0 : Math.max(0, Math.min(this.#selected - Math.floor(height / 2), rows.length - height));
    const shown = native ? rows : rows.slice(start, start + height);
    const items = shown.map((item, offset) =>
      h("item", {
        key: `r${start + offset}`,
        label: [span(item.id, "muted"), span(` ${item.title}`)],
        icon: ROW_ICON[item.status],
        tone: ROW_TONE[item.status],
        ...(start + offset === this.#selected ? { reveal: "nearest" as const } : {}),
      }),
    );
    const list = h(
      "list",
      { key: "rows", ...(native ? SCROLLER : {}), selected: rows.length ? `r${this.#selected}` : null, empty: "No plan rows" },
      items,
    );
    return h("col", { key: "sidebar", ...(native ? { max: { w: "32ch" } } : { basis: width }), shrink: 0, min: { h: 0 } }, list);
  }

  /**
   * The body. The terminal paints all of it offline and shows the rows from the scroll position, so paging moves by
   * painted rows and reaches the last one; Tern keeps the whole body in its scroller and gets the scroll keys forwarded.
   */
  #body(native: boolean, height: number): UiNode {
    const scroll = native ? this.#nativeScroll : undefined;
    const content = h("col", { key: "content", ...(scroll ? { scroll } : {}) }, ...this.#lines());
    if (native) return h("col", { key: "body", ...FILL }, h("list", { key: "body-scroll", ...SCROLLER }, content));
    return h("canvas", { key: "body", ...FILL, paint: (width: number) => this.#paintBody(content, width, height) });
  }

  #paintBody(content: UiNode, width: number, height: number): readonly string[] {
    const theme = currentTheme();
    const cached = this.#bodyCache;
    const events = this.detail.timeline;
    const rows = cached?.content === content && cached.width === width ? cached.rows : renderBlock(content, width, { theme }).rows;
    // New events arrive on top; keep a reader who scrolled into history on the same entries.
    if (this.#timeline && cached?.timeline && cached.width === width && cached.events !== events && this.#timelineScroll > 0)
      this.#timelineScroll += rows.length - cached.rows.length;
    this.#bodyCache = { content, width, rows, timeline: this.#timeline, events };
    this.#bodyTotal = rows.length;
    this.#setScroll(this.#scroll());
    const offset = this.#scroll();
    if (offset + height >= rows.length) return rows.slice(offset);
    const more = rows.length - offset - (height - 1);
    return [...rows.slice(offset, offset + height - 1), truncate(theme.style("dim", `… ${more} more lines; PgDn to scroll`), width)];
  }

  /** The body's nodes: the selected row, or the timeline. */
  #lines(): JSXNode[] {
    if (this.#timeline) return this.#timelineLines();
    const item = this.#row();
    return item ? this.#rowLines(item) : [textLine([span("No row selected", "muted")])];
  }

  /** The selected row: its fields, the live child while it runs, evidence, the archived output and acceptance. */
  #rowLines(item: AtlasRowDetail): JSXNode[] {
    const lines: JSXNode[] = [];
    const push = (line: JSXNode | undefined): void => {
      if (line) lines.push(line);
    };
    push(textLine([span(`${item.id}  ${item.title}`, "strong accent")]));
    push(blank());
    const status: TspSpan[] = [span(ROW_STATUS[item.status] ?? item.status, ROW_TONE[item.status])];
    if (item.attempt) status.push(span(` · attempt ${item.attempt.slice(0, 8)}`, "dim"));
    const verification = item.verification;
    push(
      kv([
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
      ]),
    );
    if (item.status === "in_progress") lines.push(blank(), ...this.#liveLines(item));

    lines.push(blank(), textLine([span("Evidence", "strong")]));
    const summary = evidenceSummary(item);
    if (summary) lines.push(h("md", { text: summary }));
    else push(textLine([span(item.status === "done" ? "No evidence summary" : "No evidence yet", "muted")]));
    if (item.receipt)
      push(
        kv([
          ["Child", [span(item.receipt.childAgentId, "dim")]],
          ["Session", [span(item.receipt.sessionId, "dim")]],
          ["Captured", [span(formatTime(item.receipt.capturedAt), "dim")]],
        ]),
      );
    if (item.outputPath) lines.push(blank(), ...this.#outputLines(item.id, item.outputPath));

    const ruling = rowRuling(this.detail, item.id);
    lines.push(blank(), textLine([span("Acceptance", "strong"), ...(ruling ? [span(`  amended by ${ruling.id}`, "warning")] : [])]));
    if (ruling) {
      lines.push(h("md", { text: ruling.acceptance }));
      push(
        kv([
          ["Note", ruling.note ? singleLine(ruling.note) : undefined],
          ["Confirmed", formatTime(ruling.confirmedAt)],
        ]),
      );
      lines.push(blank(), textLine([span("Approved plan", "muted")]));
      for (const line of item.acceptance.split("\n")) push(line.trim() ? textLine([span(line, "dim")]) : blank());
    } else lines.push(h("md", { text: item.acceptance }));
    return lines;
  }

  /** A running row's child: its clock, current tool, model and usage, and the newest tools and output. */
  #liveLines(item: AtlasRowDetail): JSXNode[] {
    const current = this.#liveSnapshot?.rows.get(item.id);
    const live: AtlasLiveRow | undefined = current && current.attempt === item.attempt ? current : undefined;
    const progress = live?.progress;
    const now = Date.now();
    const lines: JSXNode[] = [
      h(
        "row",
        { key: "live", gap: "sm", align: "center" },
        h("text", { spans: [span("Live", "strong")] }),
        item.startedAt !== undefined ? h("elapsed", { age: now - item.startedAt, format: "short" }) : undefined,
      ),
    ];
    if (progress?.currentTool) {
      const started = progress.currentToolStartMs;
      lines.push(
        h(
          "row",
          { gap: "sm", align: "center" },
          h("text", { spans: [span(progress.currentTool, "code")] }),
          started !== undefined ? h("elapsed", { age: now - started, format: "short" }) : undefined,
        ),
      );
      // Arguments can be a whole file body; the first lines identify the call.
      if (progress.currentToolArgs)
        lines.push(h("text", { spans: [span(singleLine(progress.currentToolArgs), "dim")], wrap: "word", lines: 3 }));
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
    if (fields) lines.push(fields);
    // The host keeps both lists newest first.
    if (progress?.recentTools.length) {
      lines.push(textLine([span("Recent tools", "muted")]));
      for (const tool of progress.recentTools.slice(0, 3))
        lines.push(textLine([span(`  ${tool.tool}`, "code"), span(` ${singleLine(tool.args)}`, "dim")], false));
    }
    if (progress?.recentOutput.length) {
      lines.push(textLine([span("Recent output", "muted")]));
      for (const output of progress.recentOutput.slice(0, 4).reverse()) lines.push(textLine([span(`  ${output}`)]));
    }
    if (!progress) {
      const waiting = !live
        ? "Waiting for the child to start"
        : live.status === "started" || live.status === "running"
          ? "No progress reported by this child yet"
          : `Child ${live.status}; waiting for the ledger to record the result`;
      lines.push(textLine([span(waiting, "muted")]));
    }
    return lines;
  }

  /** The archived child output as a disclosure; opening it reads the archive, as Space does. */
  #outputLines(id: string, file: string): JSXNode[] {
    const expanded = this.#expanded.has(id);
    const output = this.#outputs.get(file);
    const head = h("section", {
      key: "output",
      head: [span("Child output", "strong"), span(` ${file}`, "dim"), ...(expanded ? [] : [span("  Space to show", "muted")])],
      collapsible: true,
      collapsed: !expanded,
    });
    if (!expanded || !output) return [head];
    if (output.state === "loading") return [head, textLine([span("Loading...", "muted")])];
    if (output.state === "failed") return [head, textLine([span(`Cannot read output: ${output.error}`, "error")])];
    if (!output.text) return [head, textLine([span("(empty output)", "muted")])];
    return [head, ...output.text.split("\n").map((line) => (line.trim() ? textLine([span(line)]) : blank()))];
  }

  /** Newest first; entries keep their keys as new events arrive on top. */
  #timelineLines(): JSXNode[] {
    const events = this.detail.timeline;
    if (!events.length) return [textLine([span("No recorded activity", "muted")])];
    const lines: JSXNode[] = [];
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index] as AtlasEvent;
      const headSpans: TspSpan[] = [
        span(formatTime(event.at), "dim"),
        span(`  ${event.kind.replaceAll("_", " ")}`, event.derived ? "muted" : undefined),
        ...(event.row ? [span(`  ${event.row}`, "accent")] : []),
        ...(event.derived ? [span("  derived", "dim")] : []),
      ];
      // Evidence details repeat the archive path the row body already shows; two lines identify the event.
      const detail = event.detail ? singleLine(event.detail).replace(/^\/\S+\.md: /, "") : undefined;
      lines.push(
        h(
          "col",
          { key: `e${index}` },
          h("text", { spans: headSpans, truncate: "end" }),
          detail ? h("text", { spans: [span(`  ${detail}`, "muted")], wrap: "word", lines: 2 }) : undefined,
        ),
      );
    }
    return lines;
  }
}

function button(text: string, act: string, keys: readonly string[], variant?: "primary" | "danger"): UiNode {
  return h("button", { key: act, text, keys, size: "sm", actions: { click: act }, ...(variant ? { variant } : {}) });
}
