// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { test } from "bun:test";

import { shapeAssembledIllustration } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/decoration/shape-assembled-illustration";
import type { NodeSpec } from "../../testing/build-snapshot";
import { assertCases } from "./support/assert-cases";

const primitives: readonly NodeSpec[] = Array.from({ length: 8 }, (_, i) => ({
  tag: i % 2 === 0 ? "rect" : "circle",
  attributes: { fill: ["#00bb55", "#dd3333", "#ffcc00"][i % 3] ?? "#00bb55", width: "40", height: "40" },
}));
const scene = (id: string): NodeSpec => ({ id, tag: "svg", rect: { width: 640, height: 480 }, children: primitives });
test("#given large primitive scenes #then small logos and path dominated art pass", () => {
  assertCases(
    shapeAssembledIllustration,
    [
      scene("flag"),
      { ...scene("logo"), rect: { width: 32, height: 32 } },
      { ...scene("traced"), children: [...primitives, ...Array.from({ length: 36 }, () => ({ tag: "path" }))] },
    ],
    ["#flag"],
  );
});
test("#given data graphics and texture patterns #then pictorial scenes alone report", () => {
  assertCases(
    shapeAssembledIllustration,
    [
      scene("flag"),
      { ...scene("chart"), children: [...primitives, ...Array.from({ length: 3 }, () => ({ tag: "text", text: "Data" }))] },
      { ...scene("pattern"), children: [...primitives, { tag: "defs", children: [{ tag: "pattern" }] }] },
      { ...scene("stroke"), children: primitives.map((p) => ({ ...p, attributes: { fill: "none" } })) },
    ],
    ["#flag"],
  );
});
test("#given unlabeled equal width bars #then charts pass but block scenes report", () => {
  assertCases(
    shapeAssembledIllustration,
    [
      scene("flag"),
      {
        ...scene("chart"),
        children: Array.from({ length: 10 }, (_, i) => ({
          tag: "rect",
          attributes: { width: "44", height: String(100 + i * 10), fill: ["#ffffff", "#6633ff", "#eeeeee"][i % 3] ?? "#ffffff" },
        })),
      },
    ],
    ["#flag"],
  );
});
test("#given definitions repeated through use elements #then only drawn primitives count", () => {
  const defs = { tag: "defs", children: primitives.map((p, i) => ({ ...p, attributes: { ...p.attributes, id: `shape${i}` } })) };
  assertCases(
    shapeAssembledIllustration,
    [
      { ...scene("flag"), children: [defs, ...primitives.map((_, i) => ({ tag: "use", attributes: { href: `#shape${i}` } }))] },
      { ...scene("unused"), children: [defs] },
    ],
    ["#flag"],
  );
});
