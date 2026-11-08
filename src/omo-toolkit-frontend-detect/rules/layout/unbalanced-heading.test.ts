// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { unbalancedHeading } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/layout/unbalanced-heading";
import { lines, marked } from "./support/layout-cases";

const heading = {
  id: "heading",
  tag: "h2",
  text: "Design that holds up under real content and real people",
  rect: { x: 24, y: 24, width: 500, height: 60 },
  lineRects: lines([500, 80]),
};

test("#given two heading lines with a tiny tail #then only the unbalanced heading reports", () => {
  expect(marked(unbalancedHeading, [heading])).toEqual(["#heading"]);
  expect(marked(unbalancedHeading, [{ ...heading, lineRects: lines([500, 400]) }])).toEqual([]);
});

test("#given authored balance and deliberate breaks #then heading line intent is respected", () => {
  expect(marked(unbalancedHeading, [heading])).toEqual(["#heading"]);
  expect(marked(unbalancedHeading, [{ ...heading, style: { "text-wrap": "balance" } }])).toEqual([]);
  expect(marked(unbalancedHeading, [{ ...heading, children: [{ tag: "br" }] }])).toEqual([]);
});

test("#given long statements and two word headings #then the balance rule stands down", () => {
  expect(marked(unbalancedHeading, [heading])).toEqual(["#heading"]);
  expect(marked(unbalancedHeading, [{ ...heading, lineRects: lines([500, 500, 500, 80]) }])).toEqual([]);
  expect(marked(unbalancedHeading, [{ ...heading, text: "Documentation hub" }])).toEqual([]);
});
