/**
 * Native nodes for text written for the model, so a user who opens it reads it formatted: Markdown tables become
 * native tables whose later columns hide first in a narrow card, embedded JSON becomes an indented code block, runs of
 * `Label: value` lines become an aligned field grid, and the remaining lines keep their breaks.
 */
import { code, kv, md, node, span, type TspSpan } from "@oh-my-pi/pi-tui";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const SEPARATOR_CELL = /^:?-{3,}:?$/;

/** Cells of a Markdown table line; `\|` stays inside its cell. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function table(lines: readonly string[]): NativeNode {
  const [header = [], ...body] = lines.map(cells);
  const rows = body.filter((row) => !row.every((cell) => SEPARATOR_CELL.test(cell)));
  return node("table", {
    cols: header.map((head, index) => ({
      id: String(index),
      head,
      truncate: "end",
      priority: header.length - index,
      ...(index === 0 ? { grow: 1 } : {}),
    })),
    rows: rows.map((row, index) => ({
      id: String(index),
      cells: Object.fromEntries(header.map((_, column) => [String(column), row[column] ?? ""])),
    })),
  });
}

/** The end of the JSON object or array opening at `start`, or -1 when it is not closed on this line. */
function closing(line: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The first parseable JSON object embedded in the line, with the text around it. */
function embeddedJson(line: string): { before: string; value: unknown; after: string } | undefined {
  for (let start = line.indexOf("{"); start !== -1; start = line.indexOf("{", start + 1)) {
    const end = closing(line, start);
    if (end === -1) continue;
    try {
      return { before: line.slice(0, start), value: JSON.parse(line.slice(start, end + 1)), after: line.slice(end + 1) };
    } catch {}
  }
  return undefined;
}

/** `T13 acceptance: …`, `Delivery: direct`: a short label without sentence punctuation, then a value. */
const FIELD_LINE = /^([A-Za-z][^:,.;|`()]{0,47}?):\s+(\S.*)$/;

/** Lines kept apart as Markdown hard breaks. */
function prose(lines: readonly string[]): NativeNode | undefined {
  const source = lines
    .map((line) => line.trimEnd())
    .join("\\\n")
    .trim();
  return source ? md(source) : undefined;
}

/** Runs of field lines as one grid each, the lines between them as prose. */
function block(lines: readonly string[]): NativeNode[] {
  const out: NativeNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const fields: [string, TspSpan[]][] = [];
    for (let match = FIELD_LINE.exec(lines[index]?.trim() ?? ""); match; match = FIELD_LINE.exec(lines[index]?.trim() ?? "")) {
      // Backtick runs keep the code style the Markdown would have given them.
      const value = (match[2] ?? "").split("`").flatMap((part, at) => (part ? [at % 2 ? span(part, "code") : span(part)] : []));
      fields.push([match[1] ?? "", value]);
      index += 1;
    }
    const grid = kv(fields);
    if (grid) out.push(grid);
    const start = index;
    while (index < lines.length && !FIELD_LINE.test(lines[index]?.trim() ?? "")) index += 1;
    const text = prose(lines.slice(start, index));
    if (text) out.push(text);
  }
  return out;
}

export function modelTextNodes(source: string): NativeNode[] {
  const out: NativeNode[] = [];
  let pending: string[] = [];
  const flush = () => {
    out.push(...block(pending));
    pending = [];
  };
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (TABLE_LINE.test(line)) {
      flush();
      const start = index;
      while (index + 1 < lines.length && TABLE_LINE.test(lines[index + 1] ?? "")) index += 1;
      out.push(table(lines.slice(start, index + 1)));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const json = embeddedJson(line);
    if (!json) {
      pending.push(line);
      continue;
    }
    // A call written around the JSON (`todo({...})`) loses its parentheses; the text after it, which may embed more, goes on as its own line.
    const call = json.before.endsWith("(") && json.after.startsWith(")");
    pending.push(call ? json.before.slice(0, -1) : json.before);
    flush();
    out.push(code(JSON.stringify(json.value, null, 2), { lang: "json" }));
    lines.splice(index + 1, 0, json.after.replace(/^[).,;:]*\s*/, ""));
  }
  flush();
  return out;
}
