import { basename, dirname } from "node:path";

import type { FindRange } from "@oh-my-pi/pi-coding-agent/tools/details/find";
import type { TspCodeMark } from "@oh-my-pi/pi-wire";

import type { CacheState } from "#src/report.ts";

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
/** Label of a literal keyword line: not semantically judged, so it carries no score. */
export const UNRANKED = "unranked literal match";

/** File name first, then its directory (`""` at the search root). */
export function splitPath(rel: string): { name: string; dir: string } {
  const dir = dirname(rel);
  return { name: basename(rel) || rel, dir: dir === "." ? "" : dir };
}

export function rangeLabel(range: FindRange): string {
  return range.start === range.end ? `:${range.start}` : `:${range.start}-${range.end}`;
}

/** First row of a `rows`-row window over `total` rows that keeps rows `first…last` in view, moving as little as possible. */
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
 * Marks of file lines `start…end`: the active range in the accent color, lines of the other highlighted
 * (refined) ranges in their strength tone.
 */
export function codeMarks(start: number, end: number, active: FindRange | undefined, highlight: readonly FindRange[]): TspCodeMark[] {
  const marks: TspCodeMark[] = [];
  for (let line = start; line <= end; line++) {
    if (active && line >= active.start && line <= active.end) {
      marks.push({ line, tone: "accent" });
      continue;
    }
    const judged = highlight.find((range) => line >= range.start && line <= range.end);
    if (judged) marks.push({ line, tone: strength(judged.p) });
  }
  return marks;
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
