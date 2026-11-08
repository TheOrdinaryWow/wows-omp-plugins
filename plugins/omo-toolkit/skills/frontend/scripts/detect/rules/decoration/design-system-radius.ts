// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.

import { shortSnippet, styleOf } from "../../core/page";
import type { PageRule } from "../../rule";
import { corners, length, splitTop, visible } from "./support/appearance";
export const designSystemRadius: PageRule = {
  meta: {
    id: "design-system-radius",
    name: "Radius outside DESIGN.md",
    category: "quality",
    severity: "advisory",
    engine: "page",
    description: "A corner radius is outside the project radius scale.",
    fixHint: "Use a documented radius token or deliberately update the scale.",
  },
  check: ({ snapshot, config }) => {
    const tokens = config.designTokens?.radii;
    if (!tokens?.length) return [];
    return snapshot.elements.flatMap((e) => {
      if (!visible(snapshot, e)) return [];
      const values = [
        ...new Set(
          corners
            .flatMap((c) => splitTop(styleOf(e, `border-${c}-radius`), /\s/))
            .filter((v) => !v.includes("%"))
            .map(length)
            .filter((v) => Number.isFinite(v) && v > 0.5 && !tokens.some((t) => Math.abs(t - v) <= 0.5 || (t >= 99 && v >= 99))),
        ),
      ];
      return values.map((v) => ({ element: e, message: `${v}px radius is outside the project scale`, snippet: shortSnippet(e) }));
    });
  },
};
