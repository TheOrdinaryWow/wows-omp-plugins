export interface FindArgs {
  query: string;
  path: string;
  keywords: string[];
  help: boolean;
  cancel: boolean;
}

export const USAGE =
  "Usage: /find [--path PATH] [-k KEYWORD]... <query>\nQuote paths and keywords containing spaces. Use -- before query text beginning with a dash. /find prompts for a query; /find --cancel cancels a running search.";

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
  const result: FindArgs = { query: "", path: ".", keywords: [], help: false, cancel: false };
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
    } else if (options && (arg === "--path" || arg === "-p" || arg === "-k" || arg === "--keyword")) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("-")) throw new Error(`${arg} requires a value. ${USAGE}`);
      if (arg === "--path" || arg === "-p") {
        if (scoped) throw new Error("Use --path only once.");
        result.path = value;
        scoped = true;
      } else result.keywords.push(value);
    } else if (options && arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}. ${USAGE}`);
    } else query.push(arg);
  }
  result.query = query.join(" ").trim();
  if (result.cancel && (result.query || scoped || result.keywords.length)) throw new Error("Use /find --cancel on its own.");
  return result;
}

const OPTIONS = [
  ["--path", "Scope to a directory, file, or internal URL"],
  ["-k", "Add one lexical keyword; repeat to add more"],
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
