import { basename, dirname } from "node:path";

import {
  getLanguageFromPath,
  highlightCode,
  padding,
  renderProgressBar,
  replaceTabs,
  type Theme,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { FindRange } from "@oh-my-pi/pi-tui/tools/find";

import type { ConsoleState } from "#src/controller.ts";
import type { CacheState, ConsoleHit } from "#src/report.ts";
import { bestRanges } from "#src/results.ts";

/** Score bands of the host's find renderer: strong (0.7+), plausible (0.4+), weak. */
export type Strength = "success" | "warning" | "muted";

export function strength(p: number): Strength {
  return p >= 0.7 ? "success" : p >= 0.4 ? "warning" : "muted";
}

/** Where the answers came from, as a tone: all cached, partly cached, fresh or off, and a missing cache. */
export function cacheTone(cache: CacheState): "success" | "accent" | "muted" | "warning" {
  if (cache.mode === "unavailable") return "warning";
  if (cache.mode === "off" || !cache.cached) return "muted";
  return cache.cached === cache.total ? "success" : "accent";
}

/** Label of a hit whose file as a whole answers the query: no line ranges, the bare path is the reference. */
export const WHOLE_FILE = "whole file";
/** Label of a hit whose refinement fell back, wholly or partly, to the cascade's verified windows. */
export const WINDOW_RANGES = "includes window ranges";

/** File name first, then its directory (`""` at the search root). */
export function splitPath(rel: string): { name: string; dir: string } {
  const dir = dirname(rel);
  return { name: basename(rel) || rel, dir: dir === "." ? "" : dir };
}

export function rangeLabel(range: FindRange): string {
  return range.start === range.end ? `:${range.start}` : `:${range.start}-${range.end}`;
}

/** The host find renderer's six-cell score gauge, toned by strength. */
export function gauge(theme: Theme, p: number, width = 6): string {
  const tone = strength(p);
  return renderProgressBar(p, width, {
    style: {
      filled: theme.symbol("progress.filled"),
      empty: theme.symbol("progress.empty"),
      styleFilled: (cells) => theme.fg(tone, cells),
      styleEmpty: (cells) => theme.fg("dim", cells),
    },
  });
}

/** An inverted accent chip, so a whole-file hit reads as a different kind of answer at a glance. */
export function wholeFileBadge(theme: Theme): string {
  return theme.inverse(theme.fg("accent", ` ${WHOLE_FILE} `));
}

/** `left` and `right` on one line of `width` cells with `right` flush right; `left` gives way first. */
export function spread(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (!right || rightWidth + 2 > width) return truncateToWidth(left, width);
  const shown = truncateToWidth(left, width - rightWidth - 2);
  return `${shown}${padding(width - visibleWidth(shown) - rightWidth)}${right}`;
}

/** `line` padded to `width` cells on the selection background. */
export function band(theme: Theme, line: string, width: number): string {
  return theme.bg("selectedBg", truncateToWidth(line, width, undefined, true));
}

/** A plain path tail that fits `width` cells: the nearest directories matter most. */
export function tail(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return width ? "…" : "";
  let start = text.length - 1;
  while (start > 0 && visibleWidth(text.slice(start - 1)) < width) start--;
  return `…${text.slice(start)}`;
}

/** One rendered hit-list line and what a click on it selects. */
export interface ListRow {
  text: string;
  hit?: number;
  range?: number;
}

export interface HitList {
  rows: ListRow[];
  /** First and last row of the selected hit's block. */
  selected: [number, number];
}

/** Ranges listed under a hit that is not selected; the selected hit lists all of them. */
const COLLAPSED_RANGES = 3;

/**
 * The hit list: per hit its file name (marked state in the checkbox, the cursor and a selection band on
 * the selected one), score gauge, scope and directory, then its refined ranges with probability and
 * snippet. A whole-file hit carries a badge instead of ranges. `compact` folds the gauge onto the name
 * line and lists ranges only under the selected hit.
 */
export function hitList(theme: Theme, hits: readonly ConsoleHit[], state: ConsoleState, width: number, compact: boolean): HitList {
  const t = theme;
  const boxWidth = Math.max(visibleWidth(t.checkbox.checked), visibleWidth(t.checkbox.unchecked));
  const cursorWidth = visibleWidth(t.nav.cursor);
  const indent = padding(cursorWidth + boxWidth + 2);
  const rows: ListRow[] = [];
  let selected: [number, number] = [0, 0];
  hits.forEach((hit, index) => {
    if (index > 0 && !compact) rows.push({ text: "" });
    const first = rows.length;
    const chosen = index === state.selected;
    const marked = state.marked.includes(index);
    const { name, dir } = splitPath(hit.rel);
    const cursor = chosen ? t.fg("accent", t.nav.cursor) : padding(cursorWidth);
    const box = marked ? t.fg("accent", t.checkbox.checked) : t.fg("dim", t.checkbox.unchecked);
    const label = chosen ? t.bold(t.fg("accent", name)) : t.fg("text", name);
    const score = `${gauge(t, hit.contentScore)} ${t.fg(strength(hit.contentScore), hit.contentScore.toFixed(2))}`;
    const tags = [
      hit.scope === "whole-file" ? ` ${wholeFileBadge(t)}` : "",
      hit.refineFailed ? t.fg("warning", ` ${WINDOW_RANGES}`) : "",
      hit.truncated ? t.fg("warning", " partial") : "",
    ].join("");
    const head = `${cursor} ${box}${padding(boxWidth - visibleWidth(marked ? t.checkbox.checked : t.checkbox.unchecked))} ${label}`;
    if (compact) {
      const facts = `  ${score}${tags}`;
      const room = width - visibleWidth(head) - visibleWidth(facts) - 2;
      const where = dir && room > 4 ? `  ${t.fg("dim", tail(`${dir}/`, room))}` : "";
      const line = `${head}${facts}${where}`;
      rows.push({ text: chosen ? band(t, line, width) : truncateToWidth(line, width), hit: index });
    } else {
      rows.push({ text: chosen ? band(t, head, width) : truncateToWidth(head, width), hit: index });
      const facts = `${indent}${score}${tags}`;
      const room = width - visibleWidth(facts) - 2;
      rows.push({
        text: truncateToWidth(`${facts}${dir && room > 4 ? `  ${t.fg("dim", tail(`${dir}/`, room))}` : ""}`, width),
        hit: index,
      });
    }
    if (!compact || chosen) {
      const ranges = bestRanges(hit);
      const shown = chosen ? ranges : ranges.slice(0, COLLAPSED_RANGES);
      const more = ranges.length - shown.length;
      const refWidth = Math.max(0, ...shown.map((range) => rangeLabel(range).length));
      shown.forEach((range, rangeIndex) => {
        const active = chosen && rangeIndex === state.range;
        const branch = t.fg("dim", rangeIndex === shown.length - 1 && !more ? t.tree.last : t.tree.branch);
        const ref = rangeLabel(range).padEnd(refWidth);
        const pointer = active ? t.fg("accent", t.nav.expand) : " ";
        const reference = active ? t.bold(t.fg("accent", ref)) : t.fg("muted", ref);
        const snippet = t.fg("toolOutput", replaceTabs(range.snippet.trim()));
        const line = `${indent}${branch}${pointer}${reference} ${t.fg(strength(range.p), range.p.toFixed(2))} ${snippet}`;
        rows.push({ text: truncateToWidth(line, width), hit: index, range: rangeIndex });
      });
      if (more) rows.push({ text: truncateToWidth(`${indent}${t.fg("dim", `${t.tree.last} +${more} more`)}`, width), hit: index });
    }
    if (chosen) selected = [first, rows.length - 1];
  });
  return { rows, selected };
}

/** First visible row of a list window that keeps the selected block in view, moving as little as possible. */
export function listTop(previous: number, total: number, rows: number, [first, last]: [number, number]): number {
  let top = Math.min(previous, Math.max(0, total - rows));
  if (last >= top + rows) top = last - rows + 1;
  if (first < top) top = first;
  return Math.max(0, top);
}

/** Context lines kept above the active range when the source view anchors on it. */
export const CONTEXT = 5;

/** The previewed lines: `lines[0]` is file line `start`. */
export interface SourceWindow {
  start: number;
  lines: readonly string[];
}

/** `top` clamped so `rows` lines from it stay inside the window. */
export function clampTop(top: number, rows: number, window: SourceWindow): number {
  return Math.max(window.start, Math.min(top, window.start + window.lines.length - rows));
}

/** The first visible source line that centers `range` in `rows` lines, keeping some context above it. */
export function anchorTop(range: FindRange | undefined, rows: number, window: SourceWindow): number {
  if (!range) return window.start;
  const length = range.end - range.start + 1;
  const above = Math.max(Math.min(CONTEXT, Math.floor(rows / 3)), Math.floor((rows - length) / 2));
  return clampTop(range.start - above, rows, window);
}

/**
 * Highlighted source lines `top…top+rows-1` of `window` with a gutter: a strength-toned bar on lines of
 * the highlighted (refined) ranges, the active range in the accent color on the selection band, then the
 * line number. Long lines end in an ellipsis at the pane edge.
 */
export function sourceRows(
  theme: Theme,
  path: string,
  window: SourceWindow,
  active: FindRange | undefined,
  highlight: readonly FindRange[],
  top: number,
  rows: number,
  width: number,
): string[] {
  const t = theme;
  const offset = top - window.start;
  const slice = window.lines.slice(offset, offset + rows);
  const highlighted = highlightCode(replaceTabs(slice.join("\n")), getLanguageFromPath(path), t);
  const numberWidth = String(window.start + window.lines.length - 1).length;
  const separator = t.fg("dim", "│");
  return slice.map((_line, index) => {
    const number = top + index;
    const inActive = active !== undefined && number >= active.start && number <= active.end;
    const judged = highlight.find((range) => number >= range.start && number <= range.end);
    const bar = inActive ? t.fg("accent", "▌") : judged ? t.fg(strength(judged.p), "▎") : " ";
    const digits = String(number).padStart(numberWidth);
    const label = inActive ? t.bold(t.fg("accent", digits)) : t.fg(judged ? "muted" : "dim", digits);
    // Multi-line tokens leave their color open at the line end; close it before the frame border.
    const line = `${bar} ${label} ${separator} ${highlighted[index] ?? ""}\x1b[39m`;
    return inActive ? band(t, line, width) : truncateToWidth(line, width);
  });
}

/** One block of the native source view: its file lines and the highlighted ranges that start in it. */
export interface SourceChunk {
  start: number;
  end: number;
  ranges: FindRange[];
}

/** Lines of context a native range block carries above its range, so the revealed block reads in context. */
export const CHUNK_CONTEXT = 3;

/**
 * The window cut into blocks for a native scroller: the gaps between highlighted ranges, and per range
 * (overlapping ranges merged) a block from a few lines above it to its end. Blocks keep their identity
 * while the active range changes, so the scroller only re-reveals; the block holding the active range
 * is the one revealed.
 */
export function sourceChunks(window: SourceWindow, highlight: readonly FindRange[]): SourceChunk[] {
  const last = window.start + window.lines.length - 1;
  const chunks: SourceChunk[] = [];
  let next = window.start;
  const ranges = highlight.filter((range) => range.end >= window.start && range.start <= last).sort((a, b) => a.start - b.start);
  for (const range of ranges) {
    const previous = chunks.at(-1);
    if (previous?.ranges.length && range.start <= previous.end + 1) {
      previous.end = Math.min(last, Math.max(previous.end, range.end));
      previous.ranges.push(range);
      next = previous.end + 1;
      continue;
    }
    const from = Math.max(next, range.start - CHUNK_CONTEXT);
    if (from > next) chunks.push({ start: next, end: from - 1, ranges: [] });
    const end = Math.min(last, Math.max(from, range.end));
    chunks.push({ start: from, end, ranges: [range] });
    next = end + 1;
  }
  if (next <= last) chunks.push({ start: next, end: last, ranges: [] });
  return chunks;
}

/** Hints joined three spaces apart and wrapped into lines of `width` cells. */
export function hintLines(hints: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const hint of hints) {
    const next = line ? `${line}   ${hint}` : hint;
    if (line && visibleWidth(next) > width) {
      lines.push(truncateToWidth(line, width));
      line = hint;
    } else line = next;
  }
  if (line) lines.push(truncateToWidth(line, width));
  return lines;
}
