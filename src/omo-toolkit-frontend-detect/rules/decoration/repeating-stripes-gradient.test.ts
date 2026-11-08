// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { test } from "bun:test";

import { repeatingStripesGradient } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/decoration/repeating-stripes-gradient";
import { assertCases } from "./support/assert-cases";

test("#given repeating gradients on elements and pseudo elements #then single gradients pass", () => {
  assertCases(
    repeatingStripesGradient,
    [
      { id: "flag", style: { "background-image": "repeating-linear-gradient(45deg,#000 0px,#fff 2px)" } },
      { id: "single", style: { "background-image": "linear-gradient(#000,#fff)" } },
      { id: "hidden", style: { display: "none", "background-image": "repeating-linear-gradient(#000,#fff)" } },
    ],
    ["#flag"],
  );
});
test("#given radial rings and full span ramps #then only patterns that tile report", () => {
  assertCases(
    repeatingStripesGradient,
    [
      { id: "full", style: { "background-image": "repeating-linear-gradient(147deg,#032e6d,#032e6d 40%,#021d45)" } },
      { id: "percent", style: { "background-image": "repeating-linear-gradient(147deg,#0394c9 0%,#0288ba 100%)" } },
      { id: "flag", after: { "background-image": "repeating-radial-gradient(#000 0px,#fff 2px)" } },
    ],
    ["#flag"],
  );
});
