// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { test } from "bun:test";

import { borderAccentOnRounded } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/decoration/border-accent-on-rounded";
import { assertCases, border, round } from "./support/assert-cases";

test("#given top and bottom accent borders #then rounded visible boxes report", () => {
  const style = { ...round("8px"), "border-top-width": "3px", "border-top-style": "solid", "border-top-color": "rgb(220,40,60)" };
  assertCases(
    borderAccentOnRounded,
    [
      { id: "flag", style },
      { id: "square", style: { ...style, ...round("0px") } },
      { id: "neutral", style: { ...style, "border-top-color": "rgb(20,20,20)" } },
      { id: "status", attributes: { role: "status" }, style },
      { id: "hidden", style: { ...style, visibility: "hidden" } },
    ],
    ["#flag"],
  );
});
test("#given ring arcs and even frames #then only dominant rounded accents report", () => {
  assertCases(
    borderAccentOnRounded,
    [
      { id: "flag", style: { ...round("8px"), "border-bottom-width": "4px", "border-bottom-color": "rgb(40,80,220)" } },
      { id: "frame", style: { ...round("8px"), ...border("3px", "rgb(40,80,220)") } },
      {
        id: "circle",
        rect: { width: 64, height: 64 },
        style: { ...round("50%"), "border-top-width": "4px", "border-top-color": "rgb(40,80,220)" },
      },
    ],
    ["#flag"],
  );
});
