// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { SourceRule } from "../../rule";
import { darkBackground, resolveValues } from "./support/css-effects";
import { sourceShadows } from "./support/source-shadow";
import { componentExtensions, pageSource, sourceHit } from "./support/source-text";

export const darkGlow: SourceRule = {
  meta: {
    id: "dark-glow",
    name: "Glowing shadow accents",
    category: "slop",
    severity: "warning",
    engine: "source",
    description: "A colored blurred shadow creates a visible glow.",
    fixHint: "Use neutral elevation shadows instead of chromatic halos.",
  },
  extensions: componentExtensions,
  check: (context) => {
    const text = pageSource(context);
    if (text === null) return [];
    const dark = darkBackground(text);
    for (const m of resolveValues(text).matchAll(/(?<![-\w])(?:box|text)-shadow\s*:\s*([^;{}]+)/gi)) {
      for (const s of sourceShadows(m[1] ?? "")) {
        if (
          Math.max(s.color.r, s.color.g, s.color.b) - Math.min(s.color.r, s.color.g, s.color.b) < 30 ||
          s.blur <= 4 ||
          s.blur * s.color.a < 3 ||
          s.blur / 2 + s.spread <= 0
        )
          continue;
        if (dark || (s.x === 0 && s.y === 0)) return [sourceHit(text, m.index ?? 0, "Colored shadow glow")];
      }
    }
    return [];
  },
};
