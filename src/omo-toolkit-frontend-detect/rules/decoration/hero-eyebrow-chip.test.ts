// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { test } from "bun:test";

import { heroEyebrowChip } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/decoration/hero-eyebrow-chip";
import type { NodeSpec } from "../../testing/build-snapshot";
import { assertCases } from "./support/assert-cases";

const label: NodeSpec = {
  tag: "span",
  text: "New platform",
  style: { "font-size": "12px", "text-transform": "uppercase", "letter-spacing": "1.2px" },
};
const hero = (id: string, size = "64px"): NodeSpec => ({
  id,
  tag: "h1",
  text: "Build a better workflow",
  style: { "font-size": size },
  rect: { y: 60 },
});
test("#given tracked caps above heroes #then ordinary and application titles pass", () => {
  assertCases(
    heroEyebrowChip,
    [
      { children: [label, hero("flag")] },
      { children: [{ ...label, style: { ...label.style, "letter-spacing": "normal" } }, hero("plain")] },
      { children: [label, hero("small", "24px")] },
      { attributes: { role: "tabpanel" }, children: [label, hero("app")] },
    ],
    ["#flag"],
  );
});
test("#given typed caps bold accents and dash prefixes #then neutral labels pass", () => {
  assertCases(
    heroEyebrowChip,
    [
      { children: [{ ...label, text: "FEATURED", style: { "font-size": "11px", "letter-spacing": "2px" } }, hero("caps")] },
      { children: [{ ...label, style: { "font-size": "12px", "font-weight": "700", color: "rgb(200,60,0)" } }, hero("bold")] },
      {
        children: [
          { ...label, style: { "font-size": "12px" }, before: { width: "20px", height: "2px", "background-color": "rgb(200,60,0)" } },
          hero("dash"),
        ],
      },
      { children: [{ ...label, style: { "font-size": "12px" } }, hero("neutral")] },
    ],
    ["#caps", "#bold", "#dash"],
  );
});
test("#given wrapped label typography and dated metadata #then only the actual eyebrow reports", () => {
  assertCases(
    heroEyebrowChip,
    [
      { children: [{ children: [label] }, hero("flag")] },
      { children: [{ ...label, text: "News 2026" }, hero("date")] },
      { children: [{ tag: "h2", text: "FEATURED", style: label.style ?? {} }, hero("heading")] },
    ],
    ["#flag"],
  );
});
test("#given two independent text children #then the wrapper typography is not borrowed", () => {
  assertCases(
    heroEyebrowChip,
    [
      { children: [label, hero("flag")] },
      {
        children: [
          {
            children: [
              { ...label, text: "North" },
              { ...label, text: "South" },
            ],
          },
          hero("pair"),
        ],
      },
    ],
    ["#flag"],
  );
});
