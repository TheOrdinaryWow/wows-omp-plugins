// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { PageRule } from "../../rule";
import { pageIgnored } from "../color/support/page-ignore";
import { borderHits, childStripeHit, stripeHit } from "./support/borders";
export const sideTab: PageRule = {
  meta: {
    id: "side-tab",
    name: "Side-tab accent border",
    category: "slop",
    severity: "warning",
    engine: "page",
    description: "A colored edge turns a card into a decorative side tab.",
    fixHint: "Remove the stripe and use spacing or a restrained surface change.",
  },
  check: ({ snapshot }) =>
    snapshot.elements.flatMap((e) =>
      pageIgnored(snapshot, e, "side-tab")
        ? []
        : [...borderHits(snapshot, e, "side-tab"), ...stripeHit(snapshot, e), ...childStripeHit(snapshot, e)],
    ),
};
