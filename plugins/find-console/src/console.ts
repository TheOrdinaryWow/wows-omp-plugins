import {
  type Component,
  code,
  col,
  getLanguageFromPath,
  item,
  kbd,
  keyed,
  matchesKey,
  type NativeChild,
  type NativeNode,
  type NativeUiEvent,
  row as nativeRow,
  node,
  routeSgrMouseInput,
  type SgrMouseEvent,
  span,
  type Theme,
  type TUI,
  text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { bottomBorder, divider, dividerSplit, rawKeyHint, row, splitBodyWidth, splitRow, topBorder } from "@oh-my-pi/pi-tui/chrome";
import { leafKey, type NativeScroll } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, escCloseButton, hintsRow, itemIndex, selectList } from "@oh-my-pi/pi-tui/native/overlay";

import type { ConsoleAction, FindResultsController } from "#src/controller.ts";
import type { PreviewSource } from "#src/preview.ts";
import { bestRanges, scoreGauge } from "#src/results.ts";
import {
  anchorTop,
  cacheTone,
  clampTop,
  gauge,
  hintLines,
  hitList,
  type ListRow,
  listTop,
  rangeLabel,
  type SourceWindow,
  type Strength,
  sourceChunks,
  sourceRows,
  splitPath,
  spread,
  strength,
  WHOLE_FILE,
  WINDOW_RANGES,
  wholeFileBadge,
} from "#src/view.ts";

export const FULLSCREEN = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
} as const;

/** Below this width the list stacks above the preview instead of beside it. */
const SPLIT_MIN_WIDTH = 96;
/** A stacked preview shorter than this is hidden, leaving the list. */
const STACKED_PREVIEW_MIN_ROWS = 6;
/** Rows per wheel notch over the preview, as in the host's fullscreen plan review. */
const WHEEL_ROWS = 3;
/**
 * Height of the native source scroller in text lines, loaded or not: a fixed extent keeps the centered
 * sheet from jumping between hits and keeps the whole sheet inside the window (so revealing a range
 * scrolls only the source, never the sheet); the whole file scrolls inside it.
 */
const NATIVE_SOURCE_ROWS = 16;
/** The same extent as the list's own scroll cap: a Tern list row is two text lines tall. */
const NATIVE_SCROLLER_LIST_ROWS = NATIVE_SOURCE_ROWS / 2;
/** Horizontal excerpt budget leaves room for the line-number gutter and a visible ellipsis in the native split pane. */
const NATIVE_SOURCE_COLUMNS = 64;

const NATIVE_HINTS = hintsRow([
  { keys: ["up", "down"], label: "hit" },
  { keys: ["left", "right"], label: "range" },
  { keys: ["pageUp", "pageDown"], label: "scroll preview" },
  { keys: ["r"], label: "search within results" },
  { keys: ["h"], label: "recent searches" },
  { keys: ["escape"], label: "close" },
]);

/** A rendered screen area, in frame rows and columns. */
interface Region {
  top: number;
  rows: number;
  left: number;
  right: number;
}

function inside(region: Region | undefined, event: SgrMouseEvent): region is Region {
  return (
    region !== undefined &&
    event.row >= region.top &&
    event.row < region.top + region.rows &&
    event.col >= region.left &&
    event.col < region.right
  );
}

/**
 * The `/find` results console. In a terminal it is a fullscreen (or half-screen) frame with the hit list
 * beside (or, when narrow, above) the selected hit's source; in Tern it is a large glass sheet with the
 * same parts. The source is the whole file (`full-file`) or a window around the active range (`snippet`),
 * scrolled to the active refined range, with only refined ranges highlighted. Keys, mouse and native
 * clicks all run the controller's actions.
 */
export class FindConsole implements Component {
  readonly nativeOverlay: NonNullable<Component["nativeOverlay"]>;
  #revision = 0;
  #memo: { key: string; lines: readonly string[] } | undefined;
  #native: { revision: number; node: NativeNode } | undefined;
  /** First visible source line, and the hit range it was last anchored on. */
  #top = 1;
  #anchor = "";
  #codeRows = 10;
  #listTop = 0;
  #list: { region: Region; rows: ListRow[] } | undefined;
  #source: Region | undefined;
  /** Native reveal bookkeeping: bumped per anchor change; the scroller of `#mounted` was added at `#mountedFocus`. */
  #focus = 0;
  #nativeAnchor = "";
  #mounted: string | undefined;
  #mountedFocus = 0;
  /** PgUp/PgDn forwarded to the native scroller. */
  #nativeScroll: NativeScroll | undefined;
  /** Native block texts of the loaded source, tab-expanded and clipped, by line span. */
  #blocks: { source: PreviewSource; texts: Map<string, { text: string; clipped: boolean }> } | undefined;

  constructor(
    readonly controller: FindResultsController,
    readonly theme: Theme,
    readonly tui: TUI,
    readonly halfScreen = false,
  ) {
    this.nativeOverlay = {
      role: "omp.overlay.find-console.results",
      size: "lg",
      anchor: "center",
      head: `Find: ${controller.queryLabel}`,
    };
    controller.onChange = () => this.#changed();
  }

  #changed(): void {
    this.#revision++;
    this.tui.requestRender();
  }

  #chooseRange(index: number): void {
    const delta = index - this.controller.state.range;
    if (delta) this.controller.cycleRange(delta);
  }

  #scroll(lines: number): void {
    this.#top = clampTop(this.#top + lines, this.#codeRows, this.controller.previewLines);
    this.#changed();
  }

  #page(delta: 1 | -1): void {
    this.#nativeScroll = { by: delta > 0 ? "page-down" : "page-up", n: (this.#nativeScroll?.n ?? 0) + 1 };
    this.#scroll(delta * Math.max(1, this.#codeRows - 2));
  }

  handleInput(key: string): void {
    if (routeSgrMouseInput(key, (event) => this.#mouse(event))) return;
    const { actions, state } = this.controller;
    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) actions.close();
    else if (matchesKey(key, "up")) this.controller.select(state.selected - 1);
    else if (matchesKey(key, "down")) this.controller.select(state.selected + 1);
    else if (matchesKey(key, "home")) this.controller.select(0);
    else if (matchesKey(key, "end")) this.controller.select(this.controller.hits.length - 1);
    else if (matchesKey(key, "shift+tab") || matchesKey(key, "left")) actions.previousRange();
    else if (matchesKey(key, "tab") || matchesKey(key, "right")) actions.nextRange();
    else if (matchesKey(key, "pageUp")) this.#page(-1);
    else if (matchesKey(key, "pageDown")) this.#page(1);
    else if (matchesKey(key, "space")) actions.toggleMarked();
    else if (matchesKey(key, "enter") || key === "i") actions.insert();
    else if (key === "s") actions.send();
    else if (key === "o") actions.open();
    else if (key === "r") actions.refine();
    else if (key === "h") actions.history();
  }

  /** Wheel over the list moves the selection and over the source scrolls it; a click on a list row selects its hit and range. */
  #mouse(event: SgrMouseEvent): boolean {
    if (this.halfScreen) event = { ...event, row: event.row - Math.ceil((this.tui.terminal?.rows || 40) / 2) };
    const list = this.#list;
    if (event.wheel !== null) {
      if (inside(list?.region, event)) this.controller.select(this.controller.state.selected + event.wheel);
      else if (inside(this.#source, event)) this.#scroll(event.wheel * WHEEL_ROWS);
    } else if (event.leftClick && list && inside(list.region, event)) {
      const target = list.rows[event.row - list.region.top];
      if (target?.hit !== undefined) {
        this.controller.select(target.hit);
        if (target.range !== undefined) this.#chooseRange(target.range);
      }
    }
    return true;
  }

  invalidate(): void {
    this.#memo = undefined;
    this.#native = undefined;
  }

  render(width: number): readonly string[] {
    const terminalRows = this.tui.terminal?.rows || process.stdout.rows || 40;
    const height = Math.max(9, this.halfScreen ? Math.floor(terminalRows / 2) : terminalRows);
    const key = `${width}x${height}:${this.#revision}`;
    if (this.#memo?.key !== key) this.#memo = { key, lines: this.#frame(width, height) };
    return this.#memo.lines;
  }

  #frame(width: number, height: number): string[] {
    const t = this.theme;
    const c = this.controller;
    const inner = Math.max(1, width - 4);
    const split = width >= SPLIT_MIN_WIDTH;
    const header = this.#header(inner);
    let warning = c.warning ? wrapTextWithAnsi(t.fg("warning", `${t.status.warning} ${c.warning}`), inner).slice(0, 2) : [];
    const status = c.message ? t.fg("warning", `${t.status.warning} ${c.message}`) : this.#status();
    let reasons = this.#reasons();
    let hints = hintLines(this.#hints(), inner);
    // Top border, the header, the rule over the body, the rule under it, status, bottom border.
    const chrome = () => 5 + header.length + warning.length + (reasons ? 1 : 0) + hints.length;
    // Short terminals keep three body rows: the reasons go first, then wrapped hint and warning lines.
    const minimum = 3;
    if (height - chrome() < minimum) reasons = undefined;
    if (height - chrome() < minimum) hints = hints.slice(0, 1);
    if (height - chrome() < minimum) warning = warning.slice(0, 1);
    const bodyRows = Math.max(minimum, height - chrome());

    const marked = c.state.marked.length;
    const title = `Find · ${c.hits.length} ${c.hits.length === 1 ? "hit" : "hits"}${marked ? ` · ${marked} marked` : ""}`;
    const lines = [topBorder(width, title), ...header.map((line) => row(line, width)), ...warning.map((line) => row(line, width))];
    const bodyTop = lines.length + 1;
    if (split) {
      const sidebarWidth = Math.max(30, Math.min(52, Math.floor(width * 0.36)));
      const bodyWidth = splitBodyWidth(width, sidebarWidth);
      const list = this.#listRows(sidebarWidth, bodyRows, false, { top: bodyTop, rows: bodyRows, left: 0, right: sidebarWidth + 3 });
      const source = this.#sourceRows(bodyWidth, bodyRows);
      this.#source = { top: bodyTop, rows: bodyRows, left: sidebarWidth + 4, right: width };
      const box = t.boxRound;
      lines.push(
        t.fg(
          "border",
          box.teeRight +
            box.horizontal.repeat(sidebarWidth + 2) +
            box.teeDown +
            box.horizontal.repeat(Math.max(0, width - sidebarWidth - 5)) +
            box.teeLeft,
        ),
        ...Array.from({ length: bodyRows }, (_, index) => splitRow(list[index] ?? "", source[index] ?? "", width, sidebarWidth)),
        dividerSplit(width, sidebarWidth),
      );
    } else {
      const compact = hitList(t, c.hits, c.state, inner, true).rows.length;
      let listRows = Math.min(compact, Math.max(2, Math.floor(bodyRows * 0.4)));
      if (bodyRows >= STACKED_PREVIEW_MIN_ROWS + 3) listRows = Math.min(listRows, bodyRows - STACKED_PREVIEW_MIN_ROWS - 1);
      let previewRows = bodyRows - listRows - 1;
      if (previewRows < STACKED_PREVIEW_MIN_ROWS) {
        listRows = bodyRows;
        previewRows = 0;
      }
      const list = this.#listRows(inner, listRows, true, { top: bodyTop, rows: listRows, left: 0, right: width });
      lines.push(divider(width), ...Array.from({ length: listRows }, (_, index) => row(list[index] ?? "", width)));
      if (previewRows) {
        const source = this.#sourceRows(inner, previewRows);
        this.#source = { top: bodyTop + listRows + 1, rows: previewRows, left: 0, right: width };
        lines.push(divider(width), ...Array.from({ length: previewRows }, (_, index) => row(source[index] ?? "", width)));
      } else this.#source = undefined;
      lines.push(divider(width));
    }
    lines.push(row(truncateToWidth(status, inner), width));
    if (reasons) lines.push(row(truncateToWidth(reasons, inner), width));
    lines.push(...hints.map((line) => row(line, width)), bottomBorder(width));
    return lines;
  }

  /** The query as typed and the scope, with the coverage flush right; then how it was searched, when that differs. */
  #header(width: number): string[] {
    const t = this.theme;
    const c = this.controller;
    const { report } = c;
    const coverage =
      report.coverage === "complete"
        ? t.fg("success", `${t.status.success} complete coverage`)
        : report.coverage === "partial"
          ? t.fg("warning", `${t.status.warning} partial coverage`)
          : t.fg("error", `${t.status.error} coverage unavailable`);
    const lines = [spread(`${t.bold(c.queryLabel)}${t.fg("muted", ` in ${report.scopePath ?? "."}`)}`, coverage, width)];
    const notes = this.#queryNotes().map(({ label, value, tone }) => `${t.fg(tone ?? "muted", label)}${value ? t.fg("text", value) : ""}`);
    if (notes.length) lines.push(truncateToWidth(notes.join(t.fg("dim", "  ·  ")), width));
    return lines;
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

  /** Where the answers came from, what they cost, then the run's counts: three separate facts. */
  #status(): string {
    const t = this.theme;
    const c = this.controller;
    const gap = t.fg("dim", "  ·  ");
    return `${t.fg(cacheTone(c.report.cache), c.cacheLabel)}${gap}${t.fg("muted", "cost ")}${t.fg("text", c.costLabel)}${gap}${t.fg("muted", c.runStats)}`;
  }

  #listRows(width: number, rows: number, compact: boolean, region: Region): string[] {
    const list = hitList(this.theme, this.controller.hits, this.controller.state, width, compact);
    this.#listTop = listTop(this.#listTop, list.rows.length, rows, list.selected);
    const shown = list.rows.slice(this.#listTop, this.#listTop + rows);
    this.#list = { region, rows: shown };
    return shown.map((line) => line.text);
  }

  /** The selected hit's head, its facts, a rule, then its highlighted source scrolled to the active range. */
  #sourceRows(width: number, rows: number): string[] {
    const t = this.theme;
    const c = this.controller;
    const hit = c.selectedHit;
    if (!hit) return [t.fg("dim", "No hit selected.")];
    const active = c.activeRange;
    const source = c.preview;
    const { name, dir } = splitPath(hit.rel);
    const whole = hit.scope === "whole-file";
    const count = bestRanges(hit).length;
    const where = t.fg("dim", `hit ${c.state.selected + 1}/${c.hits.length}`);
    const position = whole
      ? where
      : `${t.fg("muted", "range ")}${t.fg("accent", `${count ? c.state.range + 1 : 0}/${count}`)}${t.fg("dim", " · ")}${where}`;
    const label = whole ? ` ${wholeFileBadge(t)}` : active ? t.fg("muted", rangeLabel(active)) : "";
    const head = spread(`${t.bold(t.fg("accent", name))}${label}`, position, width);
    const score = active?.p ?? hit.contentScore;
    const facts = [
      `${gauge(t, score)} ${t.fg(strength(score), score.toFixed(2))}`,
      t.fg("dim", `${hit.linesSeen} lines judged`),
      hit.refineFailed ? t.fg("warning", WINDOW_RANGES) : "",
      hit.truncated ? t.fg("warning", "partial file") : "",
      source?.truncated ? t.fg("warning", "first 4 MiB") : "",
      dir ? t.fg("dim", `${dir}/`) : "",
    ].filter(Boolean);
    const codeRows = Math.max(1, rows - 3);
    this.#codeRows = codeRows;
    let body: string[];
    let shown = "";
    if (!source) body = [t.fg("muted", "Loading preview…")];
    else if (source.error) body = wrapTextWithAnsi(t.fg("error", `${t.status.error} Preview unavailable: ${source.error}`), width);
    else if (active && active.start > source.lines.length)
      body = wrapTextWithAnsi(t.fg("warning", `${t.status.warning} The judged range is no longer present in this file.`), width);
    else {
      const window = c.previewLines;
      const anchor = `${hit.rel}\n${c.state.range}`;
      if (this.#anchor !== anchor) {
        this.#anchor = anchor;
        this.#top = anchorTop(active, codeRows, window);
      }
      this.#top = clampTop(this.#top, codeRows, window);
      body = sourceRows(t, hit.rel, window, active, window.highlight, this.#top, codeRows, width);
      const snippet = window.lines.length < source.lines.length ? " · snippet" : "";
      if (body.length) shown = t.fg("dim", `lines ${this.#top}-${this.#top + body.length - 1} of ${source.lines.length}${snippet}`);
      else body = [t.fg("dim", "This file is empty.")];
    }
    return [head, spread(facts.join(t.fg("dim", " · ")), shown, width), t.fg("borderMuted", "─".repeat(width)), ...body];
  }

  /** Key hints; an unavailable action is struck through and its reason shown on the line below. */
  #hints(): string[] {
    const t = this.theme;
    const c = this.controller;
    const marked = c.state.marked.length;
    const hint = (keys: Parameters<typeof rawKeyHint>[0], label: string, action?: ConsoleAction) =>
      action && c.actionReason(action) ? t.fg("dim", t.strikethrough(`${rawKeyHint(keys, label)}`)) : rawKeyHint(keys, label);
    return [
      rawKeyHint(["up", "down"], "hit"),
      rawKeyHint(["left", "right"], "range"),
      rawKeyHint(["pageUp", "pageDown"], "scroll"),
      rawKeyHint("space", c.state.marked.includes(c.state.selected) ? "unmark" : "mark"),
      hint("enter", "insert", "insert"),
      hint("s", marked ? `send ${marked} marked` : "send", "send"),
      hint("o", "open", "open"),
      hint("r", "search within results", "refine"),
      hint("h", "recent searches", "history"),
      rawKeyHint("escape", "close"),
    ];
  }

  #reasons(): string | undefined {
    const t = this.theme;
    const reasons = (["insert", "open", "refine", "history"] as const).flatMap((action) => {
      const reason = this.controller.actionReason(action);
      return reason ? [reason] : [];
    });
    return reasons.length ? t.fg("muted", `${t.status.disabled} ${reasons.join(" ")}`) : undefined;
  }

  describe(): NativeNode {
    if (this.#native?.revision === this.#revision) return this.#native.node;
    const c = this.controller;
    const { report } = c;
    const hit = c.selectedHit;
    const coverage =
      report.coverage === "complete"
        ? node("badge", { text: "complete coverage", tone: "success" })
        : report.coverage === "partial"
          ? node("badge", { text: "partial coverage", tone: "warning" })
          : node("badge", { text: "coverage unavailable", tone: "error" });
    const children: NativeChild[] = [
      keyed(
        nativeRow(
          [
            text(
              [
                span(`${c.hits.length} ${c.hits.length === 1 ? "hit" : "hits"}`, "strong"),
                span(" in ", "muted"),
                span(report.scopePath ?? ".", "path"),
                ...(c.state.marked.length ? [span(` · ${c.state.marked.length} marked`, "accent")] : []),
              ],
              { grow: 1, truncate: "end", lines: 1 },
            ),
            coverage,
            escCloseButton(),
          ],
          { gap: "md", align: "center" },
        ),
        "head",
      ),
    ];
    const notes = this.#queryNotes();
    if (notes.length)
      children.push(
        keyed(
          text(
            notes.flatMap((note, index) => [
              ...(index ? [span(" · ", "dim")] : []),
              span(note.label, note.tone ?? "muted"),
              ...(note.value ? [span(note.value, "strong")] : []),
            ]),
            {
              wrap: "word",
              role: "omp.find-console.query",
              ...(report.translation && "model" in report.translation ? { title: `Translated by ${report.translation.model}` } : {}),
            },
          ),
          "query",
        ),
      );
    if (c.warning)
      children.push(
        keyed(
          nativeRow([node("icon", { name: "warning", tone: "warning" }), text(c.warning, { tone: "warning", wrap: "word", grow: 1 })], {
            gap: "sm",
            align: "start",
            role: "omp.find-console.coverage",
            ...(report.stats.failures.length ? { title: report.stats.failures.join("\n") } : {}),
          }),
          "coverage",
        ),
      );
    const sidebar = node("col", { min: { w: "32ch" }, max: { w: "32ch" }, shrink: 0, gap: "md" }, this.#describeLists(), "sidebar");
    const preview = node("col", { grow: 1, gap: "sm", role: "omp.find-console.preview" }, hit ? this.#describeSource() : [], "preview");
    children.push(keyed(nativeRow([sidebar, preview], { gap: "lg", align: "start" }), "split"), this.#describeActions());
    if (c.message) children.push(keyed(text(c.message, { tone: "warning", wrap: "word" }), "message"));
    children.push(
      keyed(
        nativeRow(
          [
            node("badge", { text: c.cacheLabel, tone: cacheTone(report.cache), title: "Where the judge's answers came from" }),
            text([span("cost ", "muted"), span(c.costLabel, "num")], { title: "Judge and translation cost of this search" }),
            text(c.runStats, { tone: "muted", grow: 1, truncate: "end", lines: 1, title: c.stats }),
          ],
          { gap: "md", align: "center", role: "omp.find-console.stats" },
        ),
        "stats",
      ),
      NATIVE_HINTS,
    );
    const described = col(children, { gap: "md" });
    this.#native = { revision: this.#revision, node: described };
    return described;
  }

  /** The hits (marked ones carry a pin, whole-file ones a badge), then the selected hit's refined ranges. */
  #describeLists(): NativeNode[] {
    const c = this.controller;
    const hits = selectList(
      "hits",
      c.hits.map((hit, index) => {
        const { name, dir } = splitPath(hit.rel);
        const marked = c.state.marked.includes(index);
        const score = hit.contentScore.toFixed(2);
        const ranges = bestRanges(hit);
        const whole = hit.scope === "whole-file";
        return item(`hit-${index}`, {
          label: name,
          detail: dir ? `${score} · ${dir}` : score,
          value: [
            ...(whole ? [span(WHOLE_FILE, "mark accent")] : []),
            ...(hit.refineFailed ? [span("windows", "warning")] : []),
            span(scoreGauge(hit.contentScore), strength(hit.contentScore)),
          ],
          icon: marked ? "pin" : "file",
          tone: strength(hit.contentScore),
          title: [
            `${hit.rel} · score ${score}`,
            `${hit.linesSeen} lines judged${hit.truncated ? ", partial file" : ""}`,
            ...(whole ? ["Whole file: the file as a whole answers the query"] : []),
            ...ranges.slice(0, 3).map((range) => `${rangeLabel(range)} ${range.p.toFixed(2)}  ${range.snippet.trim()}`),
            ...(ranges.length > 3 ? [`+${ranges.length - 3} more ranges`] : []),
            ...(hit.refineFailed ? [`Includes window ranges: ${hit.refineFailed}`] : []),
            ...(marked ? ["Marked for sending"] : []),
          ].join("\n"),
        });
      }),
      { selected: `hit-${c.state.selected}`, role: "omp.find-console.hits" },
    );
    const hit = c.selectedHit;
    if (!hit) return [hits];
    const { name } = splitPath(hit.rel);
    if (hit.scope === "whole-file")
      return [
        hits,
        text([span("Whole file", "accent strong"), span(` · ${name} answers as a whole; no line ranges`, "dim")], { wrap: "word" }),
      ];
    const ranges = bestRanges(hit);
    return [
      hits,
      text([span("Ranges", "muted"), span(` · ${ranges.length} in ${name}`, "dim")], { truncate: "end", lines: 1 }),
      selectList(
        "ranges",
        ranges.map((range, index) =>
          item(`range-${index}`, {
            label: rangeLabel(range),
            detail: `${range.p.toFixed(2)} · ${range.snippet.trim()}`,
            tone: strength(range.p),
            title: `${hit.rel}${rangeLabel(range)} · ${range.p.toFixed(2)}\n${range.snippet.trim()}`,
          }),
        ),
        { selected: `range-${c.state.range}`, role: "omp.find-console.ranges" },
      ),
    ];
  }

  /** The selected hit's head with range stepping, its facts, and its source in a fixed-height scroller. */
  #describeSource(): NativeNode[] {
    const c = this.controller;
    const hit = c.selectedHit;
    if (!hit) return [];
    const active = c.activeRange;
    const source = c.preview;
    const { name, dir } = splitPath(hit.rel);
    const whole = hit.scope === "whole-file";
    const count = bestRanges(hit).length;
    const where = `${hit.rel}\n${c.state.range}`;
    if (this.#nativeAnchor !== where) {
      this.#nativeAnchor = where;
      this.#focus++;
    }
    const children: NativeNode[] = [
      {
        ...nativeRow(
          whole
            ? [
                text([span(name, "strong accent")], { grow: 1, truncate: "end", lines: 1 }),
                node("badge", {
                  text: WHOLE_FILE,
                  tone: "accent",
                  title: "The file as a whole answers the query; its reference is the bare path",
                }),
              ]
            : [
                text([span(name, "strong accent"), span(active ? rangeLabel(active) : "", "muted")], {
                  grow: 1,
                  truncate: "end",
                  lines: 1,
                }),
                actionButton("Previous", "previous-range", { keys: "left", title: "Previous range  ←" }),
                text(`${count ? c.state.range + 1 : 0}/${count}`, { tone: "muted" }),
                actionButton("Next", "next-range", { keys: "right", title: "Next range  →" }),
              ],
          { gap: "sm", align: "center" },
        ),
        key: `head:${where}`,
      },
    ];
    const score = active?.p ?? hit.contentScore;
    children.push(
      keyed(
        nativeRow(
          [
            node("progress", {
              value: score,
              tone: strength(score),
              title: `${active ? "range" : "file"} score ${score.toFixed(2)}`,
              max: { w: "10ch" },
            }),
            text(
              [
                span(score.toFixed(2), strength(score)),
                span(` · ${hit.linesSeen} lines judged`, "muted"),
                ...(hit.truncated ? [span(" · partial file", "warning")] : []),
                ...(dir ? [span(` · ${dir}/`, "dim")] : []),
              ],
              { grow: 1, truncate: "end", lines: 1 },
            ),
            ...(hit.refineFailed ? [node("badge", { text: WINDOW_RANGES, tone: "warning", title: hit.refineFailed })] : []),
          ],
          { gap: "sm", align: "center" },
        ),
        "facts",
      ),
    );
    if (!source || source.error || (active && active.start > source.lines.length)) {
      this.#mounted = undefined;
      const [note, tone] = !source
        ? ["Loading preview…", "muted"]
        : source.error
          ? [`Preview unavailable: ${source.error}`, "error"]
          : ["The judged range is no longer present in this file.", "warning"];
      children.push(
        keyed(text(source ? (whole ? "Whole file" : "Source") : "Loading…", { tone: "muted" }), "position"),
        // The same fixed extent as the loaded scroller, so the centered sheet cannot jump while sources load.
        this.#scroller(`state:${hit.rel}`, [keyed(text(note, { tone: tone as "muted", wrap: "word" }), "note")]),
      );
      return children;
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
    const blocks = chunks.map((chunk, index): NativeNode => {
      const block = this.#blockText(source, window, chunk.start, chunk.end);
      clipped ||= block.clipped;
      const marks: { line: number; tone: "accent" | Strength }[] = [];
      let holdsActive = false;
      for (const range of chunk.ranges) {
        const isActive = active !== undefined && active.start === range.start && active.end === range.end;
        holdsActive ||= isActive;
        const tone = isActive ? "accent" : strength(range.p);
        for (let line = Math.max(range.start, chunk.start); line <= Math.min(range.end, chunk.end); line++) marks.push({ line, tone });
      }
      return {
        ...code(block.text, {
          ...(lang ? { lang } : {}),
          start: chunk.start,
          numbers: true,
          wrap: false,
          ...(marks.length ? { marks } : {}),
        }),
        key: `${chunk.start}`,
        ...(holdsActive ? { reveal } : {}),
        ...(index === 0 && this.#nativeScroll ? { scroll: this.#nativeScroll } : {}),
      };
    });
    const full = window.start === 1 && window.lines.length === source.lines.length;
    const extent = full
      ? `${source.lines.length} lines · whole file`
      : `Lines ${window.start}–${window.start + window.lines.length - 1} of ${source.lines.length} · snippet`;
    children.push(
      keyed(text(`${extent} · scroll or PgUp/PgDn${clipped ? " · long lines end in …" : ""}`, { tone: "muted" }), "position"),
      this.#scroller(`source:${hit.rel}`, blocks.length ? blocks : [keyed(text("This file is empty.", { tone: "muted" }), "empty")]),
    );
    if (source.truncated) children.push(keyed(text("Preview limited to the first 4 MiB of this file.", { tone: "warning" }), "truncated"));
    return children;
  }

  /** A fixed-height native scroller (a `list` capped at its height) holding source blocks or a status note. */
  #scroller(key: string, children: readonly NativeChild[]): NativeNode {
    return node(
      "list",
      { max: { lines: NATIVE_SCROLLER_LIST_ROWS }, min: { h: `${NATIVE_SOURCE_ROWS}lines` }, role: "omp.find-console.source" },
      children,
      key,
    );
  }

  /** Lines `start…end` of the source as one block: tabs expanded, long lines clipped with an ellipsis. Cached per source. */
  #blockText(source: PreviewSource, window: SourceWindow, start: number, end: number): { text: string; clipped: boolean } {
    if (this.#blocks?.source !== source) this.#blocks = { source, texts: new Map() };
    const id = `${start}-${end}`;
    let block = this.#blocks.texts.get(id);
    if (!block) {
      let clipped = false;
      const lines = window.lines.slice(start - window.start, end - window.start + 1).map((line) => {
        const shown = truncateToWidth(line.replaceAll("\t", "  "), NATIVE_SOURCE_COLUMNS);
        if (shown !== line && shown.endsWith("…")) clipped = true;
        return shown;
      });
      block = { text: lines.join("\n"), clipped };
      this.#blocks.texts.set(id, block);
    }
    return block;
  }

  /** Action buttons; an unavailable one is muted, says why in its tooltip, and a click shows the reason. */
  #describeActions(): NativeNode {
    const c = this.controller;
    const marked = c.state.marked.length;
    const button = (label: string, act: ConsoleAction, keys: Parameters<typeof kbd>[0], accent = false): NativeNode => {
      const reason = c.actionReason(act);
      if (!reason) return actionButton(label, act, { keys: keys as never, ...(accent ? { tone: "accent" as const } : {}) });
      return node(
        "row",
        { role: "omp.btn", gap: "xs", align: "center", tone: "muted", actions: { click: act }, title: reason },
        [text(label), kbd(keys)],
        act,
      );
    };
    return actionBar([
      button("Insert reference", "insert", "enter", true),
      button(marked ? `Send ${marked} marked` : "Send to agent", "send", "s"),
      actionButton(c.state.marked.includes(c.state.selected) ? "Unmark" : "Mark for sending", "mark", { keys: "space" }),
      button("Open in editor", "open", "o"),
      null,
      button("Search within results", "refine", "r"),
      button("Recent searches", "history", "h"),
    ]);
  }

  /** Clicks run the key paths: list rows select (double-click inserts), buttons act like their keys. */
  handleNativeEvent(event: NativeUiEvent): void {
    const { actions } = this.controller;
    if (event.type === "action") {
      if (event.act === "close") actions.close();
      else if (event.act === "insert") actions.insert();
      else if (event.act === "send") actions.send();
      else if (event.act === "open") actions.open();
      else if (event.act === "refine") actions.refine();
      else if (event.act === "history") actions.history();
      else if (event.act === "mark") actions.toggleMarked();
      else if (event.act === "next-range") actions.nextRange();
      else if (event.act === "previous-range") actions.previousRange();
      return;
    }
    if (event.type !== "select" && event.type !== "activate") return;
    const leaf = leafKey(event.key);
    if (leaf === "hits") {
      const index = itemIndex(event.item, "hit-");
      if (index < 0) return;
      this.controller.select(index);
    } else if (leaf === "ranges") {
      const index = itemIndex(event.item, "range-");
      if (index < 0) return;
      this.#chooseRange(index);
    } else return;
    if (event.type === "activate") actions.insert();
  }
}
