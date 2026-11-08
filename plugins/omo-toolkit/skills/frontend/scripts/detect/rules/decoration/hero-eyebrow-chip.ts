// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.

import { shortSnippet } from "../../core/page";
import type { PageRule } from "../../rule";
import { heroLabel } from "./support/labels";
export const heroEyebrowChip: PageRule = {
  meta: {
    id: "hero-eyebrow-chip",
    name: "Hero eyebrow / pill chip",
    category: "slop",
    severity: "warning",
    engine: "page",
    description: "A tiny tracked or accented label decorates a display hero heading.",
    fixHint: "Remove the eyebrow or integrate its words into the heading.",
  },
  check: ({ snapshot }) =>
    snapshot.elements.flatMap((h) => {
      const label = heroLabel(snapshot, h);
      return label ? [{ element: h, message: "Small decorative eyebrow above the hero heading", snippet: shortSnippet(h) }] : [];
    }),
};
