// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { SourceRule } from "../../rule";
import { haloOffsets } from "./support/css-effects";
import { componentExtensions, pageSource, sourceHit } from "./support/source-text";

export const radialHalo: SourceRule = {
  meta: {
    id: "radial-halo",
    name: "Radial-gradient background halo",
    category: "slop",
    severity: "warning",
    engine: "source",
    description: "A saturated radial gradient fades into a dark background.",
    fixHint: "Use a quieter solid background or purposeful imagery.",
  },
  extensions: componentExtensions,
  check: (context) => {
    const text = pageSource(context);
    if (text === null) return [];
    const offset = haloOffsets(text)[0];
    return offset === undefined ? [] : [sourceHit(text, offset, "Radial color halo on a dark page")];
  },
};
