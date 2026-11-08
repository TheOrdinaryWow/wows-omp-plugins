// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { PageRule } from "../../rule";
import { borderHits } from "./support/borders";
export const borderAccentOnRounded: PageRule = {
  meta: {
    id: "border-accent-on-rounded",
    name: "Border accent on rounded element",
    category: "slop",
    severity: "warning",
    engine: "page",
    description: "A heavy accent band competes with rounded corners.",
    fixHint: "Remove the accent border or square the container.",
  },
  check: ({ snapshot }) => snapshot.elements.flatMap((e) => borderHits(snapshot, e, "border-accent-on-rounded")),
};
