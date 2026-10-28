import type { Judge, JudgmentRequest, NoulQuestion } from "@oh-my-pi/pi-ai";
import type { FindHit, FindRange, FindStats } from "@oh-my-pi/pi-tui/tools/find";

import type { PreviewReader } from "#src/preview.ts";
import type { ConsoleHit, HitScope } from "#src/report.ts";
import { countLabel } from "#src/results.ts";

const MAX_REQUESTS = 20;
const MAX_SEGMENTS = 256;
const SEGMENTS_PER_FILE = 24;
const SEGMENT_LINES = 12;
const SEGMENT_BYTES = 1536;
const WHOLE_FILE_BYTES = 24 * 1024;

interface Segment {
  start: number;
  end: number;
  text: string;
}

/** A whole-file reference is only justified by an explicit judgment of the entire untruncated file. */
export function decideHitScope(wholeScore: number | undefined, completeFile: boolean): HitScope {
  return completeFile && wholeScore !== undefined && wholeScore >= 0.8 ? "whole-file" : "ranges";
}

function segmentsFor(lines: readonly string[], windows: readonly FindRange[], limit: number) {
  const segments: Segment[] = [];
  const fallback: FindRange[] = [];
  for (const window of [...windows].sort((a, b) => a.start - b.start)) {
    let start = window.start;
    while (start <= Math.min(window.end, lines.length)) {
      if (segments.length >= limit) {
        fallback.push({ ...window, start });
        break;
      }
      let end = start;
      let text = lines[start - 1] ?? "";
      if (Buffer.byteLength(text) > SEGMENT_BYTES) {
        fallback.push({ ...window, start, end: start });
        start++;
        continue;
      }
      while (end < Math.min(window.end, lines.length) && end - start + 1 < SEGMENT_LINES) {
        const next = `${text}\n${lines[end] ?? ""}`;
        if (Buffer.byteLength(next) > SEGMENT_BYTES) break;
        text = next;
        end++;
      }
      segments.push({ start, end, text });
      start = end + 1;
    }
  }
  return { segments, fallback };
}

function mergeRanges(ranges: FindRange[]): FindRange[] {
  const merged: FindRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && previous.end + 1 >= range.start) {
      previous.end = Math.max(previous.end, range.end);
      previous.p = Math.max(previous.p, range.p);
    } else merged.push({ ...range });
  }
  return merged;
}

function probability(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** One bounded request per file; failures retain verified windows, never become negative evidence. */
export async function refineHits(options: {
  hits: readonly FindHit[];
  query: string;
  threshold: number;
  reader: PreviewReader;
  judge: Judge;
  stats: FindStats;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}): Promise<ConsoleHit[]> {
  const { hits, query, threshold, reader, judge, stats, signal, onProgress } = options;
  const segmentLimit = Math.min(SEGMENTS_PER_FILE, Math.floor(MAX_SEGMENTS / Math.max(1, Math.min(hits.length, MAX_REQUESTS))));
  return Promise.all(
    hits.map(async (hit, index): Promise<ConsoleHit> => {
      const result: ConsoleHit = { ...hit, scope: "ranges", refined: hit.ranges };
      const fail = (message: string) => {
        result.refineFailed = message;
        const detail = `refinement ${hit.rel}: ${message}`;
        if (!stats.failures.includes(detail)) stats.failures.push(detail);
      };
      if (index >= MAX_REQUESTS) {
        fail("request budget reached; using verified windows");
        return result;
      }
      signal.throwIfAborted();
      const source = await reader.read(hit);
      signal.throwIfAborted();
      if (source.error) {
        fail(source.error);
        return result;
      }
      const { segments, fallback } = segmentsFor(source.lines, hit.ranges, segmentLimit);
      if (!segments.length) {
        fail("segment budget or line size limit reached; using verified windows");
        return result;
      }
      const fullText = source.lines.join("\n");
      const completeFile = !source.truncated && Buffer.byteLength(fullText) <= WHOLE_FILE_BYTES;
      const passages: Record<string, string> = {};
      const questions: Record<string, NoulQuestion> = {};
      if (completeFile) {
        questions.whole = {
          type: "noul",
          instructions:
            "Is this file's overall purpose the answer to the search? Judge the entire fullFile, not whether it merely contains one relevant passage. A dedicated implementation or document about the requested subject is a whole-file answer; a general guide or multi-purpose module with one matching section is not.",
          criteria: {
            false: "Only isolated parts match, or the file is about something broader.",
            true: "The file as a whole is devoted to answering the search.",
          },
        };
      }
      segments.forEach((segment, i) => {
        const key = `s${i}`;
        passages[key] = `${segment.start}-${segment.end}:\n${segment.text}`;
        questions[key] = {
          type: "noul",
          instructions: `Does passage ${key} contain the implementation, definition, configuration, or substantive explanation answering the search? Judge this passage's actual content, not surrounding passages.`,
          criteria: { false: "Unrelated, or just a passing mention.", true: "Substantively answers an important part of the search." },
        };
      });
      const request: JudgmentRequest<Record<string, NoulQuestion>> = {
        state: { file: hit.rel, fullFile: completeFile ? fullText : null, passages, search: query },
        questions,
      };
      const started = performance.now();
      stats.requests++;
      onProgress(`refining ${index + 1}/${countLabel(hits.length, "hit")}`);
      try {
        const judged = await judge.judge(request, { signal });
        stats.inputTokens += judged.usage.input;
        stats.outputTokens += judged.usage.output;
        stats.cost += judged.usage.cost.total;
        const wholeScore = probability(judged.answers.whole?.noul);
        const missing = Object.keys(questions).filter((key) => probability(judged.answers[key]?.noul) === undefined);
        if (missing.length) {
          stats.unanswered += missing.length;
          fail(`${countLabel(missing.length, "unanswered question")}; using verified windows`);
          return result;
        }
        result.scope = decideHitScope(wholeScore, completeFile);
        if (result.scope === "whole-file") {
          result.refined = [];
          return result;
        }
        result.refined = mergeRanges([
          ...segments.flatMap((segment, i) => {
            const p = probability(judged.answers[`s${i}`]?.noul);
            return p !== undefined && p >= threshold
              ? [
                  {
                    start: segment.start,
                    end: segment.end,
                    p,
                    snippet:
                      segment.text
                        .split("\n")
                        .find((line) => line.trim())
                        ?.slice(0, 100) ?? "",
                  },
                ]
              : [];
          }),
          ...fallback.filter((range) => range.p >= threshold),
        ]);
        if (fallback.length) fail("segment budget or line size limit reached; unrefined portions keep verified windows");
        return result;
      } catch (error) {
        signal.throwIfAborted();
        stats.failed++;
        fail(`${error instanceof Error ? error.message : String(error)}; using verified windows`);
        return result;
      } finally {
        stats.apiMs += performance.now() - started;
      }
    }),
  );
}
