import { MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";

export function registerSnippetHighlights(words: readonly string[]): void {
  setMagicKeywords([
    ...MAGIC_KEYWORDS.map(({ word, hue }) => ({ word, hue })),
    ...words.map((word) => ({ word, hue: [190, 290] as const })),
  ]);
}
