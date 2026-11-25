import type { ComposerDecoration, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { magicKeywordRanges } from "@oh-my-pi/pi-coding-agent/session/magic-keywords";

/** Cyan to violet, the hue sweep snippet triggers have always glowed with, as the host builds a keyword gradient. */
const HUE = [190, 290] as const;
const STOPS = 14;
const GRADIENT = Array.from(
  { length: STOPS },
  (_, index) => Bun.color(`hsl(${Math.round(HUE[0] + (index / STOPS) * (HUE[1] - HUE[0]))}, 90%, 62%)`, "hex") ?? "#ffffff",
);

/** Each trigger word standing as prose in the draft, at the same boundaries the host glows its magic keywords. */
export function snippetDecorations(text: string, words: readonly string[]): ComposerDecoration[] {
  return magicKeywordRanges(text, words).map(({ from, to }) => ({ from, to, s: "accent", gradient: { stops: GRADIENT } }));
}

/** The composer decoration glowing live trigger words; only the interactive TUI has a composer to decorate. */
export class SnippetHighlights {
  #words: readonly string[] = [];
  #remove: (() => void) | undefined;

  update(ctx: ExtensionContext, words: readonly string[]): void {
    this.#words = words;
    if (this.#remove || !ctx.hasUI) return;
    this.#remove = ctx.ui.composer?.addDecorator((text) => snippetDecorations(text, this.#words));
  }

  detach(): void {
    this.#remove?.();
    this.#remove = undefined;
  }
}
