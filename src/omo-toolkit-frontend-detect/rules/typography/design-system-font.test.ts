// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { designSystemFont } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/typography/design-system-font";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given declared fonts, off-system duplicates and quoted commas #then unique undeclared families report", () => {
  const snapshot = buildSnapshot([
    { text: "Allowed font", style: { "font-family": "Georgia, serif" } },
    { id: "off", text: "Different font", style: { "font-family": "Comic Sans MS, cursive" } },
    { text: "Same different font", style: { "font-family": '"Comic Sans MS", cursive' } },
    { text: "Comma family", style: { "font-family": '"Foo, Bar", serif' } },
    { text: "Platform only", style: { "font-family": "system-ui, sans-serif" } },
    { text: "Invisible", style: { "font-family": "Hidden Face", display: "none" } },
  ]);
  expect(
    designSystemFont.check({ snapshot, config: { designTokens: { fonts: ["GEORGIA", "Foo, Bar"] } } }).map((h) => h.element?.selector),
  ).toEqual(["#off"]);
});

test("#given absent font tokens #then no font drift is inferred", () => {
  const snapshot = buildSnapshot([{ text: "Different font", style: { "font-family": "Comic Sans MS" } }]);
  expect(designSystemFont.check({ snapshot, config: {} })).toEqual([]);
  expect(designSystemFont.check({ snapshot, config: { designTokens: { fonts: [] } } })).toEqual([]);
  expect(designSystemFont.check({ snapshot, config: { designTokens: { fonts: ["Georgia"] } } })).toHaveLength(1);
});
