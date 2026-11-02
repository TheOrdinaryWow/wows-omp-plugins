import { maskNonProse } from "@oh-my-pi/pi-tui/prompt/markdown-prose";

import type { SnippetSettings } from "#src/settings.ts";
import type { SnippetEntry } from "#src/store.ts";

// Keep these identical to the host magic-keyword engine's prose boundaries.
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

export function triggerWord(settings: SnippetSettings, key: string): string | undefined {
  if (!settings.trigger || settings.problem) return undefined;
  return `${settings.trigger}${key}${settings.matching === "closed" ? settings.trigger : ""}`;
}

export function expandSnippets(
  text: string,
  active: readonly SnippetEntry[],
  settings: SnippetSettings,
): { text: string; used: SnippetEntry[] } {
  if (!settings.trigger || settings.problem || /^[!$]/.test(text.trimStart())) return { text, used: [] };
  const words = new Map<string, SnippetEntry>();
  for (const entry of active) {
    if (!entry.enabled || entry.shadowed) continue;
    const word = triggerWord(settings, entry.key);
    if (word) words.set(word, entry);
  }
  if (!words.size) return { text, used: [] };
  const alternatives = [...words.keys()]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("|");
  // Capture an escape separately so it can be removed without expanding the word.
  const pattern = new RegExp(`${LEFT_BOUNDARY}(\\\\)?(${alternatives})${RIGHT_BOUNDARY}`, "gu");
  const used: SnippetEntry[] = [];
  const chunks: string[] = [];
  let end = 0;
  for (const match of maskNonProse(text).matchAll(pattern)) {
    const word = match[2] ?? "";
    const entry = words.get(word);
    if (!entry) continue;
    chunks.push(text.slice(end, match.index), match[1] ? word : entry.body);
    if (!match[1]) used.push(entry);
    end = match.index + match[0].length;
  }
  if (!end) return { text, used };
  chunks.push(text.slice(end));
  return { text: chunks.join(""), used };
}
