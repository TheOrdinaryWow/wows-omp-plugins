// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { test } from "bun:test";

import { codexGridBackground } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/decoration/codex-grid-background";
import { assertCases } from "./support/assert-cases";

test("#given two tiled gradient hairlines #then a single rail and percentage cells pass", () => {
  const layer = "linear-gradient(rgb(0,0,0) 1px, transparent 1px)",
    grid = `${layer}, ${layer}`;
  assertCases(
    codexGridBackground,
    [
      { id: "flag", style: { "background-image": grid, "background-size": "40px 40px" } },
      { id: "rail", style: { "background-image": layer, "background-size": "40px 40px" } },
      { id: "percent", style: { "background-image": grid, "background-size": "50% 50%" } },
    ],
    ["#flag"],
  );
});
test("#given a pseudo grid #then hidden grids do not occupy the page finding", () => {
  const style = {
    "background-image": "linear-gradient(#111 1px, transparent 1px),linear-gradient(90deg,#111 1px,transparent 1px)",
    "background-size": "32px 32px",
  };
  assertCases(
    codexGridBackground,
    [{ id: "hidden", style: { ...style, display: "none" } }, { id: "flag", after: style }, { id: "plain" }],
    ["#flag"],
  );
});
