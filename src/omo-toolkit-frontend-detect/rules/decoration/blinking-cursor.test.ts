// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { test } from "bun:test";

import { blinkingCursor } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/decoration/blinking-cursor";
import type { NodeSpec } from "../../testing/build-snapshot";
import { assertCases, round } from "./support/assert-cases";

const caret = (id: string): NodeSpec => ({
  id,
  rect: { width: 10, height: 18, y: 40 },
  style: { "background-color": "rgb(30,200,80)", "animation-name": "blink", "animation-iteration-count": "infinite" },
});
test("#given a cursor captured during its off phase #then its own opacity and visibility do not hide it", () => {
  assertCases(
    blinkingCursor,
    [
      { ...caret("opacity"), style: { ...caret("opacity").style, opacity: "0" } },
      { ...caret("visibility"), style: { ...caret("visibility").style, visibility: "hidden" } },
      { style: { visibility: "hidden" }, children: [caret("panel")] },
      { ...caret("none"), style: { ...caret("none").style, display: "none" } },
    ],
    ["#opacity", "#visibility"],
  );
});
test("#given fake cursors and real editable surfaces #then only fake carets report", () => {
  assertCases(
    blinkingCursor,
    [
      caret("flag"),
      { attributes: { contenteditable: "true" }, children: [caret("editable")] },
      { attributes: { role: "textbox" }, children: [caret("textbox")] },
      { ...caret("deep"), rect: { width: 10, height: 18, y: 1400 } },
      { ...caret("dot"), rect: { width: 8, height: 8 }, style: { ...caret("dot").style, ...round("50%") } },
    ],
    ["#flag"],
  );
});
test("#given visibility keyframes without cursor names #then glyph and bar cursors report", () => {
  assertCases(
    blinkingCursor,
    [
      { id: "glyph", tag: "span", text: "\u258c", style: { "animation-name": "flicker", "animation-iteration-count": "infinite" } },
      { ...caret("bar"), rect: { width: 12, height: 3 } },
      { id: "word", text: "LIVE", style: { "animation-name": "flicker", "animation-iteration-count": "infinite" } },
      { ...caret("panel"), rect: { width: 200, height: 90 } },
    ],
    ["#glyph", "#bar"],
    { cssText: ["@keyframes flicker {50%{opacity:0}}"] },
  );
});
