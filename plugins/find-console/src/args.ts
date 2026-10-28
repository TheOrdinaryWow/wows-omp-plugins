import type { FindFilters } from "#src/filters.ts";

export interface FindArgs extends FindFilters {
  query: string;
  path: string;
  keywords: string[];
  help: boolean;
  cancel: boolean;
  noCache: boolean;
  noTranslate: boolean;
  history: boolean;
}

export const USAGE =
  "Usage: /find [--path PATH] [-k KEYWORD]... [--glob PATTERN]... [--ext EXT]... [--min-score 0.2..1] [--limit N] [--no-cache] [--no-translate] <query>\n/find --history reruns a recent search with its flags. /find --cancel cancels a running search. Quote paths, globs and keywords containing spaces. Use -- before dash-leading query text. /find prompts for a query.";

export function splitArguments(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | undefined;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "\\" && quote !== "'" && i + 1 < input.length && /[\s\\"']/.test(input[i + 1] ?? "")) {
      word += input[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char ?? "")) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in /find arguments.");
  if (started) words.push(word);
  return words;
}

export function parseFindArgs(input: string): FindArgs {
  const args = splitArguments(input);
  const result: FindArgs = {
    query: "",
    path: ".",
    keywords: [],
    help: false,
    cancel: false,
    noCache: false,
    noTranslate: false,
    history: false,
    globs: [],
    extensions: [],
    minScore: 0.2,
  };
  const query: string[] = [];
  let options = true;
  let scoped = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (options && arg === "--") {
      options = false;
    } else if (options && (arg === "--help" || arg === "-h")) {
      result.help = true;
    } else if (options && arg === "--cancel") {
      result.cancel = true;
    } else if (options && arg === "--no-cache") {
      result.noCache = true;
    } else if (options && arg === "--no-translate") {
      result.noTranslate = true;
    } else if (options && arg === "--history") {
      result.history = true;
    } else if (options && ["--path", "-p", "-k", "--keyword", "--glob", "--ext", "--min-score", "--limit"].includes(arg)) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("-")) throw new Error(`${arg} requires a value. ${USAGE}`);
      if (arg === "--path" || arg === "-p") {
        if (scoped) throw new Error("Use --path only once.");
        result.path = value;
        scoped = true;
      } else if (arg === "--glob") {
        result.globs.push(value);
      } else if (arg === "--ext") {
        const ext = value.replace(/^\./, "").toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(ext)) throw new Error("--ext requires a file extension, such as ts or .test.ts.");
        result.extensions.push(ext);
      } else if (arg === "--min-score") {
        const score = Number(value);
        if (!Number.isFinite(score) || score < 0.2 || score > 1)
          throw new Error("--min-score must be at least the cascade threshold (0.2) and at most 1.");
        result.minScore = score;
      } else if (arg === "--limit") {
        const limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit requires a positive integer.");
        result.limit = limit;
      } else result.keywords.push(value);
    } else if (options && arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}. ${USAGE}`);
    } else query.push(arg);
  }
  result.query = query.join(" ").trim();
  if (result.cancel && args.length !== 1) throw new Error("Use /find --cancel on its own.");
  if (result.history && args.length !== 1) throw new Error("Use /find --history on its own; saved flags are restored from history.");
  return result;
}

const OPTIONS = [
  ["--path", "Scope to a directory, file, or internal URL"],
  ["-k", "Add one lexical keyword; repeat to add more"],
  ["--no-cache", "Bypass judgment cache reads and writes"],
  ["--no-translate", "Search the original query without automatic English translation"],
  ["--glob", "Restrict files by glob; repeat for alternatives"],
  ["--ext", "Restrict file extensions; repeat for alternatives"],
  ["--min-score", "Minimum probability from 0.2 to 1, for hits and refined ranges"],
  ["--limit", "Return at most this many hits"],
  ["--history", "Pick a recent search and rerun its original flags"],
  ["--help", "Show command syntax"],
  ["--cancel", "Cancel the current search"],
] as const;

export function argumentCompletions(prefix: string) {
  const match = /(^|\s)(-\S*)$/.exec(prefix);
  if (!match && prefix.trim()) return null;
  const start = match ? prefix.slice(0, prefix.length - (match[2]?.length ?? 0)) : "";
  const partial = match?.[2] ?? "";
  const items = OPTIONS.filter(([flag]) => flag.startsWith(partial)).map(([flag, description]) => ({
    value: `${start}${flag} `,
    label: flag,
    description,
  }));
  return items.length ? items : null;
}
