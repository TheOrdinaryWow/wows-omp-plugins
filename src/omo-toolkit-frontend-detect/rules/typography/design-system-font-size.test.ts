// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { designSystemFontSize } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/typography/design-system-font-size";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given a size ramp with near-token and duplicate sizes #then unique off-ramp sizes report", () => {
  const snapshot = buildSnapshot([
    { text: "Token", style: { "font-size": "16px" } },
    { text: "Tolerated", style: { "font-size": "16.5px" } },
    { id: "off", text: "Off ramp", style: { "font-size": "17px" } },
    { text: "Duplicate", style: { "font-size": "17px" } },
    { text: "Hidden", style: { "font-size": "19px", visibility: "hidden" } },
  ]);
  expect(
    designSystemFontSize.check({ snapshot, config: { designTokens: { fontSizes: [16, 24] } } }).map((h) => h.element?.selector),
  ).toEqual(["#off"]);
});

test("#given no size ramp #then sizes are not judged", () => {
  const snapshot = buildSnapshot([{ text: "Off ramp", style: { "font-size": "17px" } }]);
  expect(designSystemFontSize.check({ snapshot, config: {} })).toEqual([]);
  expect(designSystemFontSize.check({ snapshot, config: { designTokens: { fontSizes: [] } } })).toEqual([]);
  expect(designSystemFontSize.check({ snapshot, config: { designTokens: { fontSizes: [16] } } })).toHaveLength(1);
});
