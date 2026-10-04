import { open, stat } from "node:fs/promises";

import { sanitizeText } from "../src/model.ts";

export interface TranscriptRead {
  entries: unknown[];
  reset: boolean;
}

/**
 * Tails a child session JSONL without the host's writer lock: reads only complete lines past the last
 * offset and restarts from the beginning when the file shrank (rewritten or truncated).
 */
export class TranscriptReader {
  #offset = 0;
  constructor(readonly file: string) {}

  async read(): Promise<TranscriptRead> {
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], reset: false };
      throw error;
    }
    let reset = false;
    if (size < this.#offset) {
      this.#offset = 0;
      reset = true;
    }
    if (size === this.#offset) return { entries: [], reset };
    const handle = await open(this.file, "r");
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(size - this.#offset);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, this.#offset);
      bytes = bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const end = bytes.lastIndexOf(10);
    if (end < 0) return { entries: [], reset };
    this.#offset += end + 1;
    const entries: unknown[] = [];
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A corrupt line is skipped; the host never rewrites earlier lines in place.
      }
    }
    return { entries, reset };
  }
}

export type TranscriptTone = "text" | "tool" | "result" | "error";
export interface TranscriptLine {
  tone: TranscriptTone;
  text: string;
}

const RESULT_LINES = 3;
const ARG_KEYS = ["command", "path", "pattern", "query", "url", "file", "op", "agent", "description"];

function argsSummary(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return JSON.stringify(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

const singleLine = (text: string): string => sanitizeText(text).replace(/\s+/g, " ").trim();
const displayLines = (text: string): string[] =>
  sanitizeText(text)
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());

/** Converts session entries into display lines: assistant text, tool calls, first lines of each tool result, errors. */
export function transcriptLines(entries: readonly unknown[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { type, message } = entry as { type?: string; message?: Record<string, unknown> };
    if (type !== "message" || !message) continue;
    if (message.role === "assistant") {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "text" && typeof block.text === "string") {
          for (const line of displayLines(block.text)) lines.push({ tone: "text", text: line });
        } else if (block?.type === "toolCall" && typeof block.name === "string") {
          lines.push({ tone: "tool", text: `${singleLine(block.name)}(${singleLine(argsSummary(block.arguments))})` });
        }
      }
      if (message.stopReason === "error" || typeof message.errorMessage === "string") {
        lines.push({ tone: "error", text: singleLine(String(message.errorMessage ?? "assistant error")) });
      }
    } else if (message.role === "toolResult") {
      const text = displayLines(textOf(message.content));
      const tone: TranscriptTone = message.isError === true ? "error" : "result";
      for (const line of text.slice(0, RESULT_LINES)) lines.push({ tone, text: `  ${line}` });
      if (text.length > RESULT_LINES) lines.push({ tone, text: `  … ${text.length - RESULT_LINES} more lines` });
    }
  }
  return lines;
}
