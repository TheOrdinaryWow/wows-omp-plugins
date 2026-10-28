import type { FindHit, FindRange, FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";
import { formatDuration } from "@oh-my-pi/pi-utils";

import type { CacheState, ConsoleHit, ConsoleReport } from "#src/report.ts";

export type FindMode = "auto" | "on" | "off";

export function disabledReason(mode: FindMode, nativeJudge: boolean): string | undefined {
  if (mode === "off") return "/find is disabled because find.enabled is off. Set find.enabled to auto or on to enable semantic search.";
  if (mode === "auto" && !nativeJudge)
    return "/find is disabled because find.enabled is auto and the judge role does not resolve first to a native judge. Configure a native judge (such as jev); no chat model will be used.";
  return undefined;
}

export function bestRanges(hit: FindHit | ConsoleHit): FindRange[] {
  const ranges = "scope" in hit ? (hit.scope === "whole-file" ? [] : hit.refined) : hit.ranges;
  return [...ranges].sort((a, b) => b.p - a.p || a.start - b.start);
}

export function selectedRange(hit: FindHit, index: number): FindRange | undefined {
  const ranges = bestRanges(hit);
  return ranges[((index % ranges.length) + ranges.length) % ranges.length];
}

export function reference(hit: FindHit, index = 0): string {
  const range = selectedRange(hit, index);
  return range ? `${hit.rel}:${range.start}-${range.end}` : hit.rel;
}

export function scoreGauge(score: number): string {
  const filled = Math.max(0, Math.min(6, Math.round(score * 6)));
  return "━".repeat(filled) + "─".repeat(6 - filled);
}

export function coverageWarning(report: FindToolDetails | ConsoleReport): string | undefined {
  if (report.coverage === "unavailable")
    return `Find unavailable: nothing was judged (${report.stats.failed} of ${report.stats.requests} judge requests failed). This is not evidence of absence; try grep.`;
  if (report.coverage === "partial" && !report.stats.failed && "cache" in report && report.hits.some((hit) => hit.refineFailed))
    return "Partial refinement: some passages retain verified window ranges. See the reported refinement failures; this is not negative evidence.";
  if (report.coverage === "partial")
    return `Partial coverage: ${report.stats.failed} of ${report.stats.requests} judge requests failed; unjudged files may still match.`;
  return undefined;
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.0001) return "<$0.0001";
  return `$${Number(cost.toPrecision(4))}`;
}

export function cacheLabel(cache: CacheState): string {
  if (cache.mode === "off") return "cache off";
  if (cache.mode === "unavailable") return "cache unavailable";
  if (!cache.cached) return "fresh";
  return `${cache.cached === cache.total ? "all cached" : "partly cached"} · answers ${cache.cached}/${cache.total}`;
}

export function reportStats(report: FindToolDetails | ConsoleReport): string {
  const { stats } = report;
  return `${report.hits.length} hits · ${formatCost(stats.cost)}${"cache" in report ? ` · ${cacheLabel(report.cache)}` : ""} · ${formatDuration(report.elapsedMs)} wall · ${stats.judged}/${stats.listed} names judged · ${stats.filesRead} files read · ${stats.requests} requests${stats.unanswered ? ` · ${stats.unanswered} unanswered` : ""}`;
}

export function rankedDigest(report: FindToolDetails | ConsoleReport): string {
  const original = "originalQuery" in report ? report.originalQuery : undefined;
  const heading = `Find: ${JSON.stringify(original ?? report.query)} in ${report.scopePath ?? "."} · threshold ${report.threshold.toFixed(2)}`;
  const warning = coverageWarning(report);
  const body = report.hits.flatMap((hit, index) => [
    `${index + 1}. ${scoreGauge(hit.contentScore)} ${hit.contentScore.toFixed(2)} ${hit.rel}${"scope" in hit && hit.scope === "whole-file" ? " · whole-file" : ""} · ${hit.linesSeen} lines judged${hit.truncated ? ", partial file" : ""}`,
    ...bestRanges(hit)
      .slice(0, 3)
      .map((range) => `   ${hit.rel}:${range.start}-${range.end} · ${range.p.toFixed(2)} · ${range.snippet.trim()}`),
  ]);
  return [
    heading,
    original ? `searched as: ${report.query}` : undefined,
    "translation" in report && report.translation && "skipped" in report.translation
      ? `Translation skipped: ${report.translation.skipped}`
      : undefined,
    "within" in report && report.within ? `within ${report.within.files} files of: ${report.within.query}` : undefined,
    warning,
    ...body,
    !report.hits.length && report.coverage !== "unavailable" ? "No hits." : undefined,
    reportStats(report),
    ...report.stats.failures,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export interface PreviewWindow {
  start: number;
  lines: string[];
}

export function previewWindow(lines: readonly string[], range: FindRange | undefined, context = 5): PreviewWindow {
  const start = Math.max(1, (range?.start ?? 1) - context);
  const end = Math.min(lines.length, (range?.end ?? 1) + context);
  return { start, lines: lines.slice(start - 1, end) };
}

export function hitMessage(report: FindToolDetails, hits: readonly FindHit[], current?: { hit: FindHit; range: number }): string {
  return [
    `Find results selected for ${JSON.stringify(report.query)}:`,
    ...hits.flatMap((hit) => [
      `\n${reference(hit, current?.hit === hit ? current.range : 0)} (score ${hit.contentScore.toFixed(2)})`,
      ...bestRanges(hit)
        .slice(0, 3)
        .map((range) => `${hit.rel}:${range.start}-${range.end}  ${range.snippet.trim()}`),
    ]),
    coverageWarning(report),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
