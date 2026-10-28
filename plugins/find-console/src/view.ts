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
import type { FindHit, FindRange } from "@oh-my-pi/pi-tui/tools/find";

import type { ConsoleState } from "#src/controller.ts";
import { bestRanges } from "#src/results.ts";

/** Score bands of the host's find renderer: strong (0.7+), plausible (0.4+), weak. */
export type Strength = "success" | "warning" | "muted";

export function strength(p: number): Strength {
  return p >= 0.7 ? "success" : p >= 0.4 ? "warning" : "muted";
}

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
 * the selected one), score gauge and directory, then its best ranges with probability and snippet.
 * `compact` folds the gauge onto the name line and lists ranges only under the selected hit.
 */
export function hitList(theme: Theme, hits: readonly FindHit[], state: ConsoleState, width: number, compact: boolean): HitList {
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
    const partial = hit.truncated ? t.fg("warning", " partial") : "";
    const head = `${cursor} ${box}${padding(boxWidth - visibleWidth(marked ? t.checkbox.checked : t.checkbox.unchecked))} ${label}`;
    if (compact) {
      const facts = `  ${score}${partial}`;
      const room = width - visibleWidth(head) - visibleWidth(facts) - 2;
      const where = dir && room > 4 ? `  ${t.fg("dim", tail(`${dir}/`, room))}` : "";
      const line = `${head}${facts}${where}`;
      rows.push({ text: chosen ? band(t, line, width) : truncateToWidth(line, width), hit: index });
    } else {
      rows.push({ text: chosen ? band(t, head, width) : truncateToWidth(head, width), hit: index });
      const facts = `${indent}${score}${partial}`;
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
const CONTEXT = 5;

export function clampTop(top: number, rows: number, total: number): number {
  return Math.max(1, Math.min(top, total - rows + 1));
}

/** The first visible source line that centers `range` in `rows` lines, keeping some context above it. */
export function anchorTop(range: FindRange | undefined, rows: number, total: number): number {
  if (!range) return 1;
  const length = range.end - range.start + 1;
  const above = Math.max(Math.min(CONTEXT, Math.floor(rows / 3)), Math.floor((rows - length) / 2));
  return clampTop(range.start - above, rows, total);
}

/**
 * Highlighted source lines `top…top+rows-1` with a gutter: a strength-toned bar on judged lines, the
 * active range in the accent color on the selection band, then the line number.
 */
export function sourceRows(
  theme: Theme,
  hit: FindHit,
  active: FindRange | undefined,
  lines: readonly string[],
  top: number,
  rows: number,
  width: number,
): string[] {
  const t = theme;
  const end = Math.min(lines.length, top + rows - 1);
  const slice = lines.slice(top - 1, end);
  const highlighted = highlightCode(replaceTabs(slice.join("\n")), getLanguageFromPath(hit.rel), t);
  const numberWidth = String(lines.length).length;
  const ranges = bestRanges(hit);
  const separator = t.fg("dim", "│");
  return slice.map((_line, offset) => {
    const number = top + offset;
    const inActive = active !== undefined && number >= active.start && number <= active.end;
    const judged = ranges.find((range) => number >= range.start && number <= range.end);
    const bar = inActive ? t.fg("accent", "▌") : judged ? t.fg(strength(judged.p), "▎") : " ";
    const digits = String(number).padStart(numberWidth);
    const label = inActive ? t.bold(t.fg("accent", digits)) : t.fg(judged ? "muted" : "dim", digits);
    // Multi-line tokens leave their color open at the line end; close it before the frame border.
    const line = `${bar} ${label} ${separator} ${highlighted[offset] ?? ""}\x1b[39m`;
    return inActive ? band(t, line, width) : truncateToWidth(line, width);
  });
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
