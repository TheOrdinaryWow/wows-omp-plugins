import {
  type Component,
  code,
  col,
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
import { leafKey } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, escCloseButton, hintsRow, itemIndex, selectList } from "@oh-my-pi/pi-tui/native/overlay";

import type { ConsoleAction, FindResultsController } from "#src/controller.ts";
import { bestRanges, scoreGauge } from "#src/results.ts";
import {
  anchorTop,
  clampTop,
  gauge,
  hintLines,
  hitList,
  type ListRow,
  listTop,
  rangeLabel,
  sourceRows,
  splitPath,
  spread,
  strength,
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
/** A bounded source page keeps the glass sheet's actions visible; PgUp/PgDn move through the complete source. */
const NATIVE_PAGE_ROWS = 12;
/** Horizontal excerpt budget leaves room for the line-number gutter and a visible ellipsis in the native split pane. */
const NATIVE_SOURCE_COLUMNS = 64;

const NATIVE_HINTS = hintsRow([
  { keys: ["up", "down"], label: "hit" },
  { keys: ["left", "right"], label: "range" },
  { keys: ["pageUp", "pageDown"], label: "scroll preview" },
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
 * The `/find` results console. In a terminal it is a fullscreen frame with the hit list beside (or, when
 * narrow, above) the selected hit's source; in Tern it is a large glass sheet with the same parts. Keys,
 * mouse and native clicks all run the controller's actions.
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
      head: `Find: ${controller.report.query}`,
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
    const total = this.controller.preview?.lines.length ?? 0;
    this.#top = clampTop(this.#top + lines, this.#codeRows, total);
    this.#changed();
  }

  #page(delta: 1 | -1): void {
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
    let warning = c.warning ? wrapTextWithAnsi(t.fg("warning", `${t.status.warning} ${c.warning}`), inner).slice(0, 2) : [];
    const status = c.message ? t.fg("warning", `${t.status.warning} ${c.message}`) : t.fg("muted", c.stats);
    let reasons = this.#reasons();
    let hints = hintLines(this.#hints(), inner);
    // Top border, header, the rule over the body, the rule under it, status, bottom border.
    const chrome = () => 6 + warning.length + (reasons ? 1 : 0) + hints.length;
    // Short terminals keep three body rows: the reasons go first, then wrapped hint and warning lines.
    const minimum = 3;
    if (height - chrome() < minimum) reasons = undefined;
    if (height - chrome() < minimum) hints = hints.slice(0, 1);
    if (height - chrome() < minimum) warning = warning.slice(0, 1);
    const bodyRows = Math.max(minimum, height - chrome());

    const marked = c.state.marked.length;
    const title = `Find · ${c.hits.length} ${c.hits.length === 1 ? "hit" : "hits"}${marked ? ` · ${marked} marked` : ""}`;
    const lines = [topBorder(width, title), row(this.#header(inner), width), ...warning.map((line) => row(line, width))];
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

  /** The query and scope, with the coverage flush right. */
  #header(width: number): string {
    const t = this.theme;
    const { report } = this.controller;
    const coverage =
      report.coverage === "complete"
        ? t.fg("success", `${t.status.success} complete coverage`)
        : report.coverage === "partial"
          ? t.fg("warning", `${t.status.warning} partial coverage`)
          : t.fg("error", `${t.status.error} coverage unavailable`);
    return spread(`${t.bold(report.query)}${t.fg("muted", ` in ${report.scopePath ?? "."}`)}`, coverage, width);
  }

  #listRows(width: number, rows: number, compact: boolean, region: Region): string[] {
    const list = hitList(this.theme, this.controller.hits, this.controller.state, width, compact);
    this.#listTop = listTop(this.#listTop, list.rows.length, rows, list.selected);
    const shown = list.rows.slice(this.#listTop, this.#listTop + rows);
    this.#list = { region, rows: shown };
    return shown.map((line) => line.text);
  }

  /** The selected hit's head, its range facts, a rule, then its highlighted source around the active range. */
  #sourceRows(width: number, rows: number): string[] {
    const t = this.theme;
    const c = this.controller;
    const hit = c.selectedHit;
    if (!hit) return [t.fg("dim", "No hit selected.")];
    const active = c.activeRange;
    const source = c.preview;
    const { name, dir } = splitPath(hit.rel);
    const count = hit.ranges.length;
    const position = `${t.fg("muted", "range ")}${t.fg("accent", `${count ? c.state.range + 1 : 0}/${count}`)}${t.fg("dim", ` · hit ${c.state.selected + 1}/${c.hits.length}`)}`;
    const head = spread(`${t.bold(t.fg("accent", name))}${active ? t.fg("muted", rangeLabel(active)) : ""}`, position, width);
    const facts = [
      active ? `${gauge(t, active.p)} ${t.fg(strength(active.p), active.p.toFixed(2))}` : "",
      t.fg("dim", `${hit.linesSeen} lines judged`),
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
      const anchor = `${hit.rel}\n${c.state.range}`;
      if (this.#anchor !== anchor) {
        this.#anchor = anchor;
        this.#top = anchorTop(active, codeRows, source.lines.length);
      }
      this.#top = clampTop(this.#top, codeRows, source.lines.length);
      body = sourceRows(t, hit, active, source.lines, this.#top, codeRows, width);
      if (body.length) shown = t.fg("dim", `lines ${this.#top}-${this.#top + body.length - 1} of ${source.lines.length}`);
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
      rawKeyHint("escape", "close"),
    ];
  }

  #reasons(): string | undefined {
    const t = this.theme;
    const reasons = (["insert", "open"] as const).flatMap((action) => {
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
    children.push(keyed(text(c.stats, { tone: "muted", wrap: "word" }), "stats"), NATIVE_HINTS);
    const described = col(children, { gap: "md" });
    this.#native = { revision: this.#revision, node: described };
    return described;
  }

  /** The hits (marked ones carry a pin), then every judged range of the selected hit. */
  #describeLists(): NativeNode[] {
    const c = this.controller;
    const hits = selectList(
      "hits",
      c.hits.map((hit, index) => {
        const { name, dir } = splitPath(hit.rel);
        const marked = c.state.marked.includes(index);
        const score = hit.contentScore.toFixed(2);
        const ranges = bestRanges(hit);
        return item(`hit-${index}`, {
          label: name,
          detail: dir ? `${score} · ${dir}` : score,
          value: [span(scoreGauge(hit.contentScore), strength(hit.contentScore))],
          icon: marked ? "pin" : "file",
          tone: strength(hit.contentScore),
          title: [
            `${hit.rel} · score ${score}`,
            `${hit.linesSeen} lines judged${hit.truncated ? ", partial file" : ""}`,
            ...ranges.slice(0, 3).map((range) => `${rangeLabel(range)} ${range.p.toFixed(2)}  ${range.snippet.trim()}`),
            ...(ranges.length > 3 ? [`+${ranges.length - 3} more ranges`] : []),
            ...(marked ? ["Marked for sending"] : []),
          ].join("\n"),
        });
      }),
      { selected: `hit-${c.state.selected}`, role: "omp.find-console.hits" },
    );
    const hit = c.selectedHit;
    if (!hit) return [hits];
    const ranges = bestRanges(hit);
    return [
      hits,
      text([span("Ranges", "muted"), span(` · ${ranges.length} in ${splitPath(hit.rel).name}`, "dim")], { truncate: "end", lines: 1 }),
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

  /** The selected hit's head with range stepping, its facts, and its source from just above the active range. */
  #describeSource(): NativeNode[] {
    const c = this.controller;
    const hit = c.selectedHit;
    if (!hit) return [];
    const active = c.activeRange;
    const source = c.preview;
    const { name, dir } = splitPath(hit.rel);
    const count = hit.ranges.length;
    const where = `${hit.rel}\n${c.state.range}`;
    const children: NativeNode[] = [
      {
        ...nativeRow(
          [
            text([span(name, "strong accent"), span(active ? rangeLabel(active) : "", "muted")], { grow: 1, truncate: "end", lines: 1 }),
            actionButton("Previous", "previous-range", { keys: "left", title: "Previous range  ←" }),
            text(`${count ? c.state.range + 1 : 0}/${count}`, { tone: "muted" }),
            actionButton("Next", "next-range", { keys: "right", title: "Next range  →" }),
          ],
          { gap: "sm", align: "center" },
        ),
        key: `head:${where}`,
      },
    ];
    if (active)
      children.push(
        keyed(
          nativeRow(
            [
              node("progress", {
                value: active.p,
                tone: strength(active.p),
                title: `range score ${active.p.toFixed(2)}`,
                max: { w: "10ch" },
              }),
              text(
                [
                  span(active.p.toFixed(2), strength(active.p)),
                  span(` · ${hit.linesSeen} lines judged`, "muted"),
                  ...(hit.truncated ? [span(" · partial file", "warning")] : []),
                  ...(dir ? [span(` · ${dir}/`, "dim")] : []),
                ],
                { grow: 1, truncate: "end", lines: 1 },
              ),
            ],
            { gap: "sm", align: "center" },
          ),
          "facts",
        ),
      );
    if (!source)
      children.push(
        keyed(text("Loading preview…", { tone: "muted" }), "position"),
        // Use the same native code chrome and twelve-line extent as the loaded page, so the centered sheet cannot jump.
        keyed(
          code("\n".repeat(NATIVE_PAGE_ROWS - 1), { path: hit.rel, start: active?.start ?? 1, numbers: true, wrap: false }),
          `code:${where}`,
        ),
      );
    else if (source.error) children.push(keyed(text(`Preview unavailable: ${source.error}`, { tone: "error", wrap: "word" }), "error"));
    else if (active && active.start > source.lines.length)
      children.push(keyed(text("The judged range is no longer present in this file.", { tone: "warning", wrap: "word" }), "missing"));
    else {
      this.#codeRows = NATIVE_PAGE_ROWS;
      if (this.#anchor !== where) {
        this.#anchor = where;
        this.#top = anchorTop(active, NATIVE_PAGE_ROWS, source.lines.length);
      }
      this.#top = clampTop(this.#top, NATIVE_PAGE_ROWS, source.lines.length);
      const start = this.#top;
      const end = Math.min(source.lines.length, start + NATIVE_PAGE_ROWS - 1);
      const ranges = bestRanges(hit);
      const marks = [];
      for (let line = start; line <= end; line++) {
        if (active && line >= active.start && line <= active.end) marks.push({ line, tone: "accent" as const });
        else {
          const judged = ranges.find((range) => line >= range.start && line <= range.end);
          if (judged) marks.push({ line, tone: strength(judged.p) });
        }
      }
      children.push(
        keyed(text(`Lines ${start}–${end} of ${source.lines.length} · PgUp/PgDn to scroll · … clipped`, { tone: "muted" }), "position"),
        keyed(
          code(
            source.lines
              .slice(start - 1, end)
              .map((line) => truncateToWidth(line.replaceAll("\t", "  "), NATIVE_SOURCE_COLUMNS))
              .join("\n"),
            { path: hit.rel, start, numbers: true, marks, wrap: false },
          ),
          `code:${where}`,
        ),
      );
      if (source.truncated)
        children.push(keyed(text("Preview limited to the first 4 MiB of this file.", { tone: "warning" }), "truncated"));
    }
    return children;
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
