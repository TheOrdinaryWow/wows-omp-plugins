import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type FindArgs, parseFindArgs } from "#src/args.ts";

export interface WithinSearch {
  query: string;
  files: string[];
}

export interface HistoryEntry {
  args: FindArgs;
  searchedAt: number;
  within?: WithinSearch;
}

export const HISTORY_LIMIT = 50;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryFrom(value: unknown, version: number): HistoryEntry {
  if (!record(value)) throw new Error("Invalid history entry.");
  const stored = version === 1 ? value : value.args;
  if (!record(stored) || typeof stored.query !== "string" || !stored.query.trim()) throw new Error("Invalid history query.");
  const defaults = parseFindArgs("");
  const path = stored.path ?? defaults.path;
  const keywords = stored.keywords ?? defaults.keywords;
  const globs = stored.globs ?? defaults.globs;
  const extensions = stored.extensions ?? defaults.extensions;
  const minScore = stored.minScore ?? defaults.minScore;
  const limit = stored.limit;
  const noCache = stored.noCache ?? false;
  const noTranslate = stored.noTranslate ?? false;
  if (
    typeof path !== "string" ||
    !path ||
    !Array.isArray(keywords) ||
    !keywords.every((item) => typeof item === "string") ||
    !Array.isArray(globs) ||
    !globs.every((item) => typeof item === "string") ||
    !Array.isArray(extensions) ||
    !extensions.every((item) => typeof item === "string") ||
    typeof minScore !== "number" ||
    !Number.isFinite(minScore) ||
    minScore < 0.2 ||
    minScore > 1 ||
    (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)) ||
    typeof noCache !== "boolean" ||
    typeof noTranslate !== "boolean" ||
    typeof value.searchedAt !== "number" ||
    !Number.isFinite(value.searchedAt)
  )
    throw new Error("Invalid history flags or timestamp.");
  const args: FindArgs = { ...defaults, query: stored.query.trim(), path, keywords, globs, extensions, minScore, noCache, noTranslate };
  if (typeof limit === "number") args.limit = limit;
  let within: WithinSearch | undefined;
  if (value.within !== undefined) {
    if (
      !record(value.within) ||
      typeof value.within.query !== "string" ||
      !Array.isArray(value.within.files) ||
      !value.within.files.every((file) => typeof file === "string")
    )
      throw new Error("Invalid history file restriction.");
    within = { query: value.within.query, files: value.within.files };
  }
  return { args, searchedAt: value.searchedAt, ...(within ? { within } : {}) };
}

function dedupe(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  return [...entries]
    .sort((a, b) => b.searchedAt - a.searchedAt)
    .filter((entry) => {
      const key = JSON.stringify([entry.args.query.replace(/\s+/g, " ").toLowerCase(), entry.args.path, entry.within?.files]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, HISTORY_LIMIT);
}

/** Project state lives outside the copied plugin, so upgrades cannot erase recent searches. */
export class HistoryStore {
  readonly file: string;

  constructor(cwd: string) {
    this.file = join(cwd, ".omp", ".cache", "find-console", "history.json");
  }

  async load(): Promise<HistoryEntry[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    if (!record(raw) || (raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.entries))
      throw new Error(`Unsupported or invalid find history at ${this.file}; the file was preserved.`);
    const version = raw.version;
    const entries = dedupe(raw.entries.map((entry) => entryFrom(entry, version)));
    if (raw.version === 1) await this.save(entries);
    return entries;
  }

  async remember(entry: HistoryEntry): Promise<HistoryEntry[]> {
    const entries = dedupe([entry, ...(await this.load())]);
    await this.save(entries);
    return entries;
  }

  private async save(entries: readonly HistoryEntry[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 2, entries })}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Safe slash-command text for recent-query completion; within-result scopes are rerun through the history picker. */
export function historyCommand(entry: HistoryEntry): string {
  const { args } = entry;
  return [
    "--path",
    JSON.stringify(args.path),
    ...args.keywords.flatMap((value) => ["-k", JSON.stringify(value)]),
    ...args.globs.flatMap((value) => ["--glob", JSON.stringify(value)]),
    ...args.extensions.flatMap((value) => ["--ext", JSON.stringify(value)]),
    "--min-score",
    String(args.minScore),
    ...(args.limit === undefined ? [] : ["--limit", String(args.limit)]),
    ...(args.noCache ? ["--no-cache"] : []),
    ...(args.noTranslate ? ["--no-translate"] : []),
    "--",
    JSON.stringify(args.query),
  ].join(" ");
}
