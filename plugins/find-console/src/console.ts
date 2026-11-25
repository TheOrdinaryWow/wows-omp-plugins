import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { getLanguageFromPath } from "@oh-my-pi/pi-coding-agent/utils/lang-from-path";
import { type JSXNode, type KeyEvent, nativeRendering, type ScrollRequest, signal, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";

import type { ConsoleAction, FindResultsController } from "#src/controller.ts";
import type { PreviewSource } from "#src/preview.ts";
import { bestRanges, countLabel, LITERAL_GROUP, scoreGauge } from "#src/results.ts";
import { h, span } from "#src/tsp.ts";
import {
  anchorTop,
  cacheTone,
  clampTop,
  codeMarks,
  listTop,
  rangeLabel,
  type SourceWindow,
  sourceChunks,
  splitPath,
  strength,
  UNRANKED,
  WHOLE_FILE,
  WINDOW_RANGES,
} from "#src/view.ts";

export const FULLSCREEN = { overlay: true, fullscreen: true } as const;
export const HALF_SCREEN = { overlay: true } as const;

/** Below this width the list stacks above the preview instead of beside it. */
const SPLIT_MIN_WIDTH = 96;
/** A stacked preview shorter than this is hidden, leaving the list. */
const STACKED_PREVIEW_MIN_ROWS = 6;
/** The shortest terminal frame the console lays out. */
const MIN_ROWS = 12;
/**
 * Height of the native source scroller in text lines, loaded or not: a fixed extent keeps the centered
 * sheet from jumping between hits and keeps the whole sheet inside the window (so revealing a range
 * scrolls only the source, never the sheet); the full file scrolls inside it.
 */
const NATIVE_SOURCE_ROWS = 16;
/** The same extent as the list's own scroll cap: a Tern list row is two text lines tall. */
const NATIVE_SCROLLER_LIST_ROWS = NATIVE_SOURCE_ROWS / 2;
/** Rows a native sidebar list shows before it scrolls. */
const NATIVE_LIST_ROWS = 6;
/** Horizontal excerpt budget leaves room for the line-number gutter and a visible ellipsis in the native split pane. */
const NATIVE_SOURCE_COLUMNS = 64;

type ListName = "hit" | "literal" | "range";

/** A part of the view and the terminal rows it takes (`rows` is unused natively, where the sheet scrolls). */
interface Part {
  node: JSXNode;
  rows: number;
}

/** Blank terminal rows that hold a pane at its height while its content is shorter. */
function filler(rows: number): UiNode | undefined {
  return rows > 0 ? h("text", { text: "\n".repeat(rows - 1), wrap: "none" }) : undefined;
}

/** Terminal rows `text` wraps to at `width`, at most `limit`. */
function wrappedRows(text: string, width: number, limit: number): number {
  return Math.max(1, Math.min(limit, wrap(text, Math.max(1, width)).length));
}

/**
 * The `/find` results console: the hit list beside (or, in a narrow terminal, above) the selected hit's
 * source, with the run's facts and actions under them. One node tree serves the terminal, where it fills
 * the screen (or its lower half), and Tern, where it is a large sheet. The source is the full file
 * (`full-file`) or a window around the active range (`snippet`), scrolled to the active refined range,
 * with only refined ranges marked. Keys, clicks and native events all run the controller's actions.
 */
export class FindConsole {
  readonly #revision = signal(0);
  /** First visible source line in the terminal, and the hit range it was last anchored on. */
  #top = 1;
  #anchor = "";
  #codeRows = 10;
  /** First shown row of each terminal list window. */
  readonly #tops = new Map<ListName, number>();
  /** Native reveal bookkeeping: bumped per anchor change; the scroller of `#mounted` was added at `#mountedFocus`. */
  #focus = 0;
  #nativeAnchor = "";
  #mounted: string | undefined;
  #mountedFocus = 0;
  /** PgUp/PgDn forwarded to the native scroller. */
  #nativeScroll: ScrollRequest | undefined;
  /** Native block texts of the loaded source, tab-expanded and clipped, by line span. */
  #blocks: { source: PreviewSource; texts: Map<string, { text: string; clipped: boolean }> } | undefined;

  constructor(
    readonly controller: FindResultsController,
    readonly ui: Pick<ExtensionUiHost, "size">,
    readonly halfScreen = false,
  ) {
    controller.onChange = () => this.#changed();
  }

  #changed(): void {
    this.#revision.update((revision) => revision + 1);
  }

  /** The root node: the screen itself in a terminal, the screen inside its own sheet in Tern. */
  view(): UiNode {
    const native = nativeRendering();
    const screen = h(
      "col",
      {
        gap: native ? "sm" : "none",
        ...(native
          ? {
              min: () => ({ h: `${this.#sheetRows()}lines` as const }),
              max: () => ({ h: `${this.#sheetRows()}lines` as const }),
            }
          : {}),
        onKey: (key) => this.key(key),
        onSelect: (item) => this.pick(item, false),
        onActivate: (item) => this.pick(item, true),
        onAction: (act) => this.action(act),
      },
      () => {
        this.#revision();
        const size = this.ui.size();
        return untrack(() => this.#screen(size.columns, size.rows, native));
      },
    );
    if (!native) return screen;
    return h(
      "overlay",
      { size: "lg", anchor: "center", modal: true, head: `Find: ${this.controller.queryLabel}`, role: "omp.overlay.find-console.results" },
      screen,
    );
  }

  #sheetRows(): number {
    return Math.max(16, this.ui.size().rows - 8);
  }

  /** Keys run the controller's actions; returns whether the key was taken. */
  key(key: KeyEvent): boolean {
    if (key.kind === "release") return false;
    const { actions, state } = this.controller;
    switch (key.id) {
      case "escape":
      case "ctrl+c":
        actions.close();
        return true;
      case "up":
        this.controller.select(state.selected - 1);
        return true;
      case "down":
        this.controller.select(state.selected + 1);
        return true;
      case "home":
        this.controller.select(0);
        return true;
      case "end":
        this.controller.select(this.controller.entries.length - 1);
        return true;
      case "left":
      case "shift+tab":
        actions.previousRange();
        return true;
      case "right":
      case "tab":
        actions.nextRange();
        return true;
      case "pageUp":
        this.#page(-1);
        return true;
      case "pageDown":
        this.#page(1);
        return true;
      case "space":
        actions.toggleMarked();
        return true;
      case "enter":
      case "i":
        actions.insert();
        return true;
      case "s":
        actions.send();
        return true;
      case "o":
        actions.open();
        return true;
      case "r":
        actions.refine();
        return true;
      case "h":
        actions.history();
        return true;
      default:
        return false;
    }
  }

  /** A click on a list row selects its hit, literal match or range; a double click (activate) also inserts it. */
  pick(item: string, activate: boolean): void {
    const separator = item.lastIndexOf("-");
    const list = item.slice(0, separator);
    const index = Number(item.slice(separator + 1));
    if (!Number.isInteger(index) || index < 0) return;
    if (list === "hit") this.controller.select(index);
    else if (list === "literal") this.controller.select(this.controller.report.hits.length + index);
    else if (list === "range") this.#chooseRange(index);
    else return;
    if (activate) this.controller.actions.insert();
  }

  /** Buttons act like their keys. */
  action(act: string): void {
    const { actions } = this.controller;
    if (act === "close") actions.close();
    else if (act === "insert") actions.insert();
    else if (act === "send") actions.send();
    else if (act === "open") actions.open();
    else if (act === "refine") actions.refine();
    else if (act === "history") actions.history();
    else if (act === "mark") actions.toggleMarked();
    else if (act === "next-range") actions.nextRange();
    else if (act === "previous-range") actions.previousRange();
  }

  #chooseRange(index: number): void {
    const delta = index - this.controller.state.range;
    if (delta) this.controller.cycleRange(delta);
  }

  #page(delta: 1 | -1): void {
    this.#nativeScroll = { by: delta > 0 ? "page-down" : "page-up", n: (this.#nativeScroll?.n ?? 0) + 1 };
    this.#top = clampTop(this.#top + delta * Math.max(1, this.#codeRows - 2), this.#codeRows, this.controller.previewLines);
    this.#changed();
  }

  #screen(columns: number, terminalRows: number, native: boolean): JSXNode[] {
    const width = Math.max(20, columns);
    const height = Math.max(MIN_ROWS, this.halfScreen ? Math.floor(terminalRows / 2) : terminalRows);
    const head = this.#head(width, native);
    let foot = this.#foot(width, native);
    const chrome = (parts: readonly Part[]) => parts.reduce((sum, part) => sum + part.rows, 0);
    // Short terminals keep three body rows: the reasons line goes first.
    if (!native && height - chrome(head) - chrome(foot) < 3) foot = this.#foot(width, native, false);
    const bodyRows = Math.max(3, height - chrome(head) - chrome(foot));
    const body = native || width >= SPLIT_MIN_WIDTH ? this.#split(width, bodyRows, native) : this.#stacked(width, bodyRows);
    return [...head.map((part) => part.node), body, ...foot.map((part) => part.node)];
  }

  /** The counts in the top rule, the query and scope with the coverage, how it was searched, and the coverage warning. */
  #head(width: number, native: boolean): Part[] {
    const c = this.controller;
    const { report } = c;
    const marked = c.state.marked.length;
    const literal = report.lexicalFallback.length;
    const parts: Part[] = [
      {
        node: h("rule", {
          key: "title",
          label: [
            span("Find", "strong"),
            span(` · ${countLabel(report.hits.length, "hit")}`),
            ...(literal ? [span(` · ${countLabel(literal, "literal match", "literal matches")}`, "warning")] : []),
            ...(marked ? [span(` · ${marked} marked`, "accent")] : []),
          ],
        }),
        rows: 1,
      },
      {
        node: h(
          "row",
          { key: "query", gap: "md", align: "center" },
          h("text", {
            spans: [span(c.queryLabel, "strong"), span(" in ", "muted"), span(report.scopePath ?? ".", "path")],
            grow: 1,
            truncate: "end",
            lines: 1,
          }),
          report.coverage === "complete"
            ? h("badge", { text: "complete coverage", tone: "success" })
            : report.coverage === "partial"
              ? h("badge", { text: "partial coverage", tone: "warning" })
              : h("badge", { text: "coverage unavailable", tone: "error" }),
        ),
        rows: 1,
      },
    ];
    const notes = this.#queryNotes();
    if (notes.length)
      parts.push({
        node: h("text", {
          key: "notes",
          spans: notes.flatMap((note, index) => [
            ...(index ? [span("  ·  ", "dim")] : []),
            span(note.label, note.tone ?? "muted"),
            ...(note.value ? [span(note.value, "strong")] : []),
          ]),
          ...(native ? { wrap: "word" as const } : { truncate: "end" as const, lines: 1 }),
          ...(report.translation && "model" in report.translation ? { title: `Translated by ${report.translation.model}` } : {}),
        }),
        rows: 1,
      });
    if (c.warning)
      parts.push({
        node: h("text", {
          key: "coverage",
          spans: [span(c.warning, "warning")],
          wrap: "word",
          lines: 2,
          ...(report.stats.failures.length ? { title: report.stats.failures.join("\n") } : {}),
        }),
        rows: wrappedRows(c.warning, width, 2),
      });
    parts.push({ node: h("rule", { key: "head-rule" }), rows: 1 });
    return parts;
  }

  /** What the search actually ran: the English query it searched as, the results it searched within, or why it was not translated. */
  #queryNotes(): { label: string; value?: string; tone?: "warning" }[] {
    const { report } = this.controller;
    const notes: { label: string; value?: string; tone?: "warning" }[] = [];
    if (report.originalQuery) notes.push({ label: "searched as: ", value: report.query });
    else if (report.translation && "skipped" in report.translation)
      notes.push({ label: `not translated: ${report.translation.skipped}`, tone: "warning" });
    if (report.within)
      notes.push({
        label: `within ${report.within.files} ${report.within.files === 1 ? "file" : "files"} of: `,
        value: report.within.query,
      });
    return notes;
  }

  /** A rule, where the answers came from with the cost and counts, the last message, why actions are unavailable, and the actions. */
  #foot(width: number, native: boolean, withReasons = true): Part[] {
    const c = this.controller;
    const parts: Part[] = [
      { node: h("rule", { key: "foot-rule" }), rows: 1 },
      {
        node: h(
          "row",
          { key: "stats", gap: "md", align: "center" },
          h("badge", { text: c.cacheLabel, tone: cacheTone(c.report.cache), title: "Where the judge's answers came from" }),
          h("text", { spans: [span("cost ", "muted"), span(c.costLabel, "num")], title: "Judge and translation cost of this search" }),
          h("text", { spans: [span(c.runStats, "muted")], grow: 1, truncate: "end", lines: 1, title: c.stats }),
        ),
        rows: 1,
      },
    ];
    if (c.message)
      parts.push({
        node: h("text", { key: "message", spans: [span(c.message, "warning")], wrap: "word", lines: 2 }),
        rows: wrappedRows(c.message, width, 2),
      });
    const reasons = (["insert", "open", "refine", "history"] as const).flatMap((action) => {
      const reason = c.actionReason(action);
      return reason ? [reason] : [];
    });
    if (reasons.length && withReasons && !native)
      parts.push({
        node: h("text", { key: "reasons", spans: [span(reasons.join(" "), "muted")], truncate: "end", lines: 1 }),
        rows: 1,
      });
    parts.push({ node: this.#actions(), rows: 2 });
    return parts;
  }

  /** Action buttons in two rows; an unavailable one is dimmed and names why in its tooltip. */
  #actions(): UiNode {
    const c = this.controller;
    const marked = c.state.marked.length;
    const button = (text: string, act: string, key: string, primary = false) => {
      const reason = act === "mark" || act === "close" || act === "send" ? undefined : c.actionReason(act as ConsoleAction);
      return h("button", {
        key: act,
        text,
        keys: [key],
        actions: { click: act },
        ...(primary ? { variant: "primary" as const } : {}),
        ...(reason ? { disabled: reason } : {}),
      });
    };
    return h(
      "col",
      { key: "actions", gap: "none" },
      h(
        "row",
        { key: "primary", gap: "sm", align: "center" },
        button("Insert reference", "insert", "enter", true),
        button(marked ? `Send ${marked} marked` : "Send to agent", "send", "s"),
        button(c.state.marked.includes(c.state.selected) ? "Unmark" : "Mark", "mark", "space"),
        button("Open in editor", "open", "o"),
      ),
      h(
        "row",
        { key: "secondary", gap: "sm", align: "center" },
        button("Search within results", "refine", "r"),
        button("Recent searches", "history", "h"),
        h("spacer", { grow: 1, size: "none" }),
        button("Close", "close", "escape"),
      ),
    );
  }

  /** The lists beside the preview: a sidebar of `rows` terminal rows (natively a fixed-width column). */
  #split(width: number, rows: number, native: boolean): UiNode {
    const sidebarWidth = Math.max(30, Math.min(52, Math.floor(width * 0.36)));
    const previewWidth = Math.max(10, width - sidebarWidth - 2);
    const sidebar = this.#lists(native ? undefined : rows, true);
    const preview = this.#preview(previewWidth, native ? undefined : rows);
    return h(
      "row",
      {
        key: "split",
        gap: "md",
        align: "start",
        ...(native ? { grow: 1, shrink: 1, basis: 0, min: { h: 0 } } : {}),
      },
      h(
        "col",
        native
          ? { key: "sidebar", gap: "none", shrink: 0, min: { w: "32ch" }, max: { w: "32ch" } }
          : { key: "sidebar", gap: "none", shrink: 0, basis: sidebarWidth },
        sidebar.node,
        native ? undefined : filler(rows - sidebar.rows),
      ),
      h(
        "col",
        { key: "preview", gap: native ? "sm" : "none", grow: 1, shrink: 1, basis: 0, min: { w: 0 } },
        preview.node,
        native ? undefined : filler(rows - preview.rows),
      ),
    );
  }

  /** A narrow terminal: the hit list over a rule over the preview, or, when too short for both, the lists with the selected hit's ranges. */
  #stacked(width: number, rows: number): UiNode {
    const entries = this.controller.entries.length + (this.controller.report.lexicalFallback.length ? 2 : 0) + 1;
    let listRows = Math.min(entries, Math.max(2, Math.floor(rows * 0.4)));
    if (rows >= STACKED_PREVIEW_MIN_ROWS + 3) listRows = Math.min(listRows, rows - STACKED_PREVIEW_MIN_ROWS - 1);
    let previewRows = rows - listRows - 1;
    if (previewRows < STACKED_PREVIEW_MIN_ROWS) {
      listRows = rows;
      previewRows = 0;
    }
    const list = this.#lists(listRows, previewRows === 0 && listRows >= 5);
    const preview = previewRows ? this.#preview(width, previewRows) : undefined;
    return h(
      "col",
      { key: "stacked", gap: "none" },
      h("col", { key: "sidebar", gap: "none" }, list.node, filler(listRows - list.rows)),
      preview && h("rule", { key: "preview-rule" }),
      preview && h("col", { key: "preview", gap: "none" }, preview.node, filler(previewRows - preview.rows)),
    );
  }

  /**
   * The hits (marked ones carry a pin, whole-file ones a tag), the unranked literal matches, then, with
   * `ranges`, the selected hit's refined ranges. In a terminal each list shows a window of `rows` that
   * follows the selection; natively each list scrolls.
   */
  #lists(rows: number | undefined, ranges: boolean): Part {
    const c = this.controller;
    const { report } = c;
    const ranked = report.hits.length;
    const literal = report.lexicalFallback.length;
    const hit = c.selectedHit;
    const rangeList = ranges && hit && !hit.literal && hit.scope === "ranges" ? bestRanges(hit) : undefined;
    const whole = ranges && hit && !hit.literal && hit.scope === "whole-file";
    // Section heads and the blank row between sections, then the rows left for list items.
    const sections = 1 + (literal ? 1 : 0) + (rangeList || whole ? 1 : 0);
    let left = rows === undefined ? 0 : rows - (sections - 1) - sections;
    let rangeRows = 0;
    let hitRows = 0;
    let literalRows = 0;
    if (rows !== undefined) {
      if (rangeList?.length) rangeRows = Math.min(rangeList.length, Math.max(1, Math.floor(left * 0.4)));
      left -= rangeRows;
      if (ranked && literal) {
        literalRows = Math.min(literal, Math.max(1, left - Math.min(ranked, Math.ceil(left / 2))));
        hitRows = Math.max(1, Math.min(ranked, left - literalRows));
      } else if (ranked) hitRows = Math.max(1, Math.min(ranked, left));
      else literalRows = Math.max(1, Math.min(literal, left));
    }
    const nodes: JSXNode[] = [];
    let used = sections - 1;
    if (ranked) {
      const list = this.#list(
        "hit",
        report.hits.map((entry, index) => {
          const { name, dir } = splitPath(entry.rel);
          const marked = c.state.marked.includes(index);
          const score = entry.contentScore.toFixed(2);
          const best = bestRanges(entry);
          const isWhole = entry.scope === "whole-file";
          return {
            label: !ranges && index === c.state.selected && c.activeRange ? `${name}${rangeLabel(c.activeRange)}` : name,
            ...(dir ? { detail: dir } : {}),
            value: [
              ...(isWhole ? [span(`${WHOLE_FILE} `, "accent")] : []),
              ...(entry.refineFailed ? [span("windows ", "warning")] : []),
              ...(entry.truncated ? [span("partial ", "warning")] : []),
              span(`${scoreGauge(entry.contentScore)} ${score}`, strength(entry.contentScore)),
            ],
            ...(marked ? { icon: "pin" } : {}),
            tone: strength(entry.contentScore),
            title: [
              `${entry.rel} · score ${score}`,
              `${entry.linesSeen} lines judged${entry.truncated ? ", partial file" : ""}`,
              ...(isWhole ? ["Whole file: the file as a whole answers the query"] : []),
              ...best.slice(0, 3).map((range) => `${rangeLabel(range)} ${range.p.toFixed(2)}  ${range.snippet.trim()}`),
              ...(best.length > 3 ? [`+${best.length - 3} more ranges`] : []),
              ...(entry.refineFailed ? [`Includes window ranges: ${entry.refineFailed}`] : []),
              ...(marked ? ["Marked for sending"] : []),
            ].join("\n"),
          };
        }),
        c.state.selected < ranked ? c.state.selected : undefined,
        hitRows,
        rows !== undefined,
      );
      nodes.push(
        h(
          "col",
          { key: "hits-section", gap: "none" },
          h("text", { key: "hits-head", spans: this.#listHead("Hits", list.window, ranked, "↑↓"), truncate: "end", lines: 1 }),
          list.node,
        ),
      );
      used += 1 + list.rows;
    } else {
      nodes.push(h("text", { key: "no-hits", spans: [span("No ranked hits.", "muted")], truncate: "end", lines: 1 }));
      used += 1;
    }
    if (literal) {
      const list = this.#list(
        "literal",
        report.lexicalFallback.map((match, index) => {
          const { name, dir } = splitPath(match.rel);
          const marked = c.state.marked.includes(ranked + index);
          return {
            label: `${name}:${match.line}`,
            detail: match.snippet,
            ...(marked ? { icon: "pin" } : {}),
            tone: "muted" as const,
            title: [
              `${match.rel}:${match.line} · ${UNRANKED}`,
              "Not semantically judged; not ranked evidence",
              match.snippet,
              ...(dir ? [`in ${dir}/`] : []),
              ...(marked ? ["Marked for sending"] : []),
            ].join("\n"),
          };
        }),
        c.state.selected >= ranked ? c.state.selected - ranked : undefined,
        literalRows,
        rows !== undefined,
      );
      nodes.push(
        h(
          "col",
          { key: "literal-section", gap: "none" },
          h("text", {
            key: "literal-head",
            spans: [span(LITERAL_GROUP, "warning strong"), span(" · not semantically judged", "dim")],
            truncate: "end",
            lines: 1,
          }),
          list.node,
        ),
      );
      used += 1 + list.rows;
    }
    if (hit && whole) {
      nodes.push(
        h("text", {
          key: "whole-head",
          spans: [span("Whole file", "accent strong"), span(` · ${splitPath(hit.rel).name} answers as a whole; no line ranges`, "dim")],
          ...(rows === undefined ? { wrap: "word" as const } : { truncate: "end" as const, lines: 1 }),
        }),
      );
      used += 1;
    } else if (hit && rangeList) {
      const list = this.#list(
        "range",
        rangeList.map((range) => ({
          label: rangeLabel(range),
          detail: range.snippet.trim(),
          value: [span(range.p.toFixed(2), strength(range.p))],
          tone: strength(range.p),
          title: `${hit.rel}${rangeLabel(range)} · ${range.p.toFixed(2)}\n${range.snippet.trim()}`,
        })),
        c.state.range,
        rangeRows,
        rows !== undefined,
      );
      nodes.push(
        h(
          "col",
          { key: "ranges-section", gap: "none" },
          h("text", {
            key: "ranges-head",
            spans: [...this.#listHead("Ranges", list.window, rangeList.length, "←→"), span(` in ${splitPath(hit.rel).name}`, "dim")],
            truncate: "end",
            lines: 1,
          }),
          list.node,
        ),
      );
      used += 1 + list.rows;
    }
    return {
      node: nodes.flatMap((node, index) => (index ? [h("spacer", { key: `gap-${index}`, size: "sm" }), node] : [node])),
      rows: used,
    };
  }

  #listHead(label: string, window: [number, number] | undefined, total: number, keys: string): TspSpan[] {
    return [
      span(label, "strong"),
      span(window ? ` ${window[0] + 1}–${window[1]} of ${total}` : ` ${total}`, "dim"),
      span(`  ${keys}`, "dim"),
    ];
  }

  /**
   * A selectable list of `items` keyed `<name>-<index>`. In a terminal (`windowed`) it shows `rows` items
   * around the selection, keeping its place while the selection is elsewhere; natively it holds every item
   * and scrolls, revealing the selected one.
   */
  #list(
    name: ListName,
    items: readonly {
      label: TspText;
      detail?: TspText;
      value?: TspText;
      icon?: string;
      tone: "success" | "warning" | "muted";
      title: string;
    }[],
    selected: number | undefined,
    rows: number,
    windowed: boolean,
  ): { node: UiNode; rows: number; window?: [number, number] } {
    let first = 0;
    let shown = items.length;
    if (windowed) {
      shown = Math.min(items.length, Math.max(1, rows));
      const previous = this.#tops.get(name) ?? 0;
      first =
        selected === undefined ? Math.min(previous, items.length - shown) : listTop(previous, items.length, shown, [selected, selected]);
      this.#tops.set(name, first);
    }
    const children = items.slice(first, first + shown).map((item, offset) => {
      const index = first + offset;
      return h("item", { ...item, key: `${name}-${index}`, ...(index === selected && !windowed ? { reveal: "nearest" as const } : {}) });
    });
    const node = h(
      "list",
      {
        key: name,
        selected: selected === undefined ? null : `${name}-${selected}`,
        ...(windowed ? {} : { max: { lines: NATIVE_LIST_ROWS } }),
      },
      children,
    );
    return { node, rows: shown, ...(shown < items.length ? { window: [first, first + shown] as [number, number] } : {}) };
  }

  /** The selected hit's head with range stepping, its facts, the shown extent, and its source. */
  #preview(width: number, rows: number | undefined): Part {
    const c = this.controller;
    const hit = c.selectedHit;
    if (!hit) return { node: h("text", { spans: [span("No hit selected.", "dim")] }), rows: 1 };
    const active = c.activeRange;
    const source = c.preview;
    const { name, dir } = splitPath(hit.rel);
    const whole = hit.scope === "whole-file";
    const count = bestRanges(hit).length;
    const ranked = c.report.hits.length;
    const where = hit.literal
      ? `literal ${c.state.selected - ranked + 1}/${c.entries.length - ranked}`
      : `hit ${c.state.selected + 1}/${ranked}`;
    const title = h("text", {
      spans: [span(name, "strong accent"), span(active ? rangeLabel(active) : "", "muted")],
      grow: 1,
      shrink: 1,
      truncate: "end",
      lines: 1,
    });
    const head =
      whole || hit.literal
        ? h(
            "row",
            { key: "head", gap: "sm", align: "center" },
            title,
            whole
              ? h("badge", {
                  text: WHOLE_FILE,
                  tone: "accent",
                  title: "The file as a whole answers the query; its reference is the bare path",
                })
              : h("badge", { text: UNRANKED, tone: "warning", title: "A literal keyword line; not semantically judged" }),
            h("text", { spans: [span(where, "dim")], shrink: 0 }),
          )
        : h(
            "row",
            { key: "head", gap: "sm", align: "center" },
            title,
            h("button", {
              key: "previous-range",
              keys: ["left"],
              aria: "Previous range",
              title: "Previous range  ←",
              actions: { click: "previous-range" },
            }),
            h("text", { spans: [span(`range ${count ? c.state.range + 1 : 0}/${count}`, "muted")], shrink: 0 }),
            h("button", {
              key: "next-range",
              keys: ["right"],
              aria: "Next range",
              title: "Next range  →",
              actions: { click: "next-range" },
            }),
            h("text", { spans: [span(where, "dim")], shrink: 0 }),
          );
    const score = active?.p ?? hit.contentScore;
    const facts = h(
      "row",
      { key: "facts", gap: "sm", align: "center" },
      h("text", {
        spans: hit.literal
          ? [span("Not semantically judged; not ranked evidence", "muted"), ...(dir ? [span(` · ${dir}/`, "dim")] : [])]
          : [
              span(`${scoreGauge(score)} ${score.toFixed(2)}`, strength(score)),
              span(` · ${hit.linesSeen} lines judged`, "muted"),
              ...(hit.truncated ? [span(" · partial file", "warning")] : []),
              ...(dir ? [span(` · ${dir}/`, "dim")] : []),
            ],
        grow: 1,
        shrink: 1,
        truncate: "end",
        lines: 1,
        title: `${active ? "range" : "file"} score ${score.toFixed(2)}`,
      }),
      hit.refineFailed && h("badge", { text: WINDOW_RANGES, tone: "warning", title: hit.refineFailed }),
      source?.truncated && h("badge", { text: "first 4 MiB", tone: "warning", title: "Preview limited to the first 4 MiB of this file" }),
    );
    const body = rows === undefined ? this.#nativeSource() : this.#terminalSource(width, rows - 3);
    return { node: [head, facts, ...body.nodes], rows: 2 + body.rows };
  }

  /** The extent line and the source lines in view, scrolled to the active range; or why there is no source. */
  #terminalSource(width: number, rows: number): { nodes: JSXNode[]; rows: number } {
    const c = this.controller;
    const hit = c.selectedHit;
    const source = c.preview;
    const active = c.activeRange;
    const codeRows = Math.max(1, rows);
    this.#codeRows = codeRows;
    if (!hit) return { nodes: [], rows: 0 };
    const note = (text: string, tone: string): { nodes: JSXNode[]; rows: number } => ({
      nodes: [
        h("text", { key: "extent", spans: [span(hit.rel, "dim")], truncate: "end", lines: 1 }),
        h("text", { key: "note", spans: [span(text, tone)], wrap: "word", lines: codeRows }),
      ],
      rows: 1 + wrappedRows(text, width, codeRows),
    });
    if (!source) return note("Loading preview…", "muted");
    if (source.error) return note(`Preview unavailable: ${source.error}`, "error");
    if (active && active.start > source.lines.length) return note("The judged range is no longer present in this file.", "warning");
    const window = c.previewLines;
    const anchor = `${c.state.selected}\n${hit.rel}\n${c.state.range}`;
    if (this.#anchor !== anchor) {
      this.#anchor = anchor;
      this.#top = anchorTop(active, codeRows, window);
    }
    this.#top = clampTop(this.#top, codeRows, window);
    const offset = this.#top - window.start;
    const lines = window.lines.slice(offset, offset + codeRows);
    if (!lines.length) return note("This file is empty.", "dim");
    const end = this.#top + lines.length - 1;
    const mode = window.lines.length < source.lines.length ? "snippet" : "full file";
    const lang = getLanguageFromPath(hit.rel);
    const marks = codeMarks(this.#top, end, active, window.highlight);
    return {
      nodes: [
        h("text", {
          key: "extent",
          spans: [span(`lines ${this.#top}-${end} of ${source.lines.length} · ${mode}`, "dim"), span("  PgUp/PgDn", "dim")],
          truncate: "end",
          lines: 1,
        }),
        h("code", {
          key: "source",
          text: lines.join("\n"),
          ...(lang ? { lang } : {}),
          start: this.#top,
          numbers: true,
          wrap: false,
          ...(marks.length ? { marks } : {}),
        }),
      ],
      rows: 1 + lines.length,
    };
  }

  /** The extent line and the source in a fixed-height scroller, its active block revealed. */
  #nativeSource(): { nodes: JSXNode[]; rows: number } {
    const c = this.controller;
    const hit = c.selectedHit;
    if (!hit) return { nodes: [], rows: 0 };
    const active = c.activeRange;
    const source = c.preview;
    const whole = hit.scope === "whole-file";
    const where = `${c.state.selected}\n${hit.rel}\n${c.state.range}`;
    if (this.#nativeAnchor !== where) {
      this.#nativeAnchor = where;
      this.#focus++;
    }
    if (!source || source.error || (active && active.start > source.lines.length)) {
      this.#mounted = undefined;
      const [note, tone] = !source
        ? ["Loading preview…", "muted"]
        : source.error
          ? [`Preview unavailable: ${source.error}`, "error"]
          : ["The judged range is no longer present in this file.", "warning"];
      return {
        nodes: [
          h("text", { key: "extent", spans: [span(source ? (whole ? "Whole file" : "Source") : "Loading…", "muted")] }),
          // The same fixed extent as the loaded scroller, so the centered sheet cannot jump while sources load.
          this.#scroller(`state:${hit.rel}`, [h("text", { key: "note", spans: [span(note, tone)], wrap: "word" })]),
        ],
        rows: 0,
      };
    }
    const window = c.previewLines;
    const chunks = sourceChunks(window, window.highlight);
    if (this.#mounted !== hit.rel) {
      this.#mounted = hit.rel;
      this.#mountedFocus = this.#focus;
    }
    // A scroller added with the hit reveals its active block by placement; later range moves bump `n`.
    const reveal = this.#focus === this.#mountedFocus ? ("start" as const) : { at: "start" as const, n: this.#focus };
    const lang = getLanguageFromPath(hit.rel);
    let clipped = false;
    const blocks = chunks.map((chunk, index) => {
      const block = this.#blockText(source, window, chunk.start, chunk.end);
      clipped ||= block.clipped;
      const marks = codeMarks(chunk.start, chunk.end, active, chunk.ranges);
      const holdsActive = active !== undefined && chunk.ranges.some((range) => range.start === active.start && range.end === active.end);
      return h("code", {
        key: `${chunk.start}`,
        text: block.text,
        ...(lang ? { lang } : {}),
        start: chunk.start,
        numbers: true,
        wrap: false,
        ...(marks.length ? { marks } : {}),
        ...(holdsActive ? { reveal } : {}),
        ...(index === 0 && this.#nativeScroll ? { scroll: this.#nativeScroll } : {}),
      });
    });
    const full = window.start === 1 && window.lines.length === source.lines.length;
    const extent = full
      ? `${source.lines.length} lines · full file`
      : `Lines ${window.start}–${window.start + window.lines.length - 1} of ${source.lines.length} · snippet`;
    return {
      nodes: [
        h("text", {
          key: "extent",
          spans: [span(`${extent} · scroll or PgUp/PgDn${clipped ? " · long lines end in …" : ""}`, "muted")],
        }),
        this.#scroller(
          `source:${hit.rel}`,
          blocks.length ? blocks : [h("text", { key: "empty", spans: [span("This file is empty.", "muted")] })],
        ),
      ],
      rows: 0,
    };
  }

  /** A fixed-height native scroller (a `list` capped at its height) holding source blocks or a status note. */
  #scroller(key: string, children: readonly UiNode[]): UiNode {
    return h("list", { key, max: { lines: NATIVE_SCROLLER_LIST_ROWS }, min: { h: `${NATIVE_SOURCE_ROWS}lines` } }, children);
  }

  /** Lines `start…end` of the source as one block: tabs expanded, long lines clipped with an ellipsis. Cached per source. */
  #blockText(source: PreviewSource, window: SourceWindow, start: number, end: number): { text: string; clipped: boolean } {
    if (this.#blocks?.source !== source) this.#blocks = { source, texts: new Map() };
    const id = `${start}-${end}`;
    let block = this.#blocks.texts.get(id);
    if (!block) {
      let clipped = false;
      const lines = window.lines.slice(start - window.start, end - window.start + 1).map((line) => {
        const expanded = line.replaceAll("\t", "  ");
        const shown = truncate(expanded, NATIVE_SOURCE_COLUMNS);
        if (shown !== expanded) clipped = true;
        return shown;
      });
      block = { text: lines.join("\n"), clipped };
      this.#blocks.texts.set(id, block);
    }
    return block;
  }
}
