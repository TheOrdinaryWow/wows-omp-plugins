// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { radialHalo } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/radial-halo";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  ["body{background:#000}.a{background:radial-gradient(#a855f7,transparent 70%)}", 1],
  ["body{background:#fff}.a{background:radial-gradient(#a855f7,transparent 70%)}", 0],
  ["body{background:#000}.a{background:radial-gradient(#777,transparent 70%)}", 0],
  ["body{background:#000}.a{background:radial-gradient(#a855f7 2px,transparent 4px)}", 0],
  ["body{background:#000}.a{background:repeating-radial-gradient(#a855f7,transparent 70%)}", 0],
  ["body{background:#fff}.glass{background:rgba(18,20,26,0.86)}.a{background:radial-gradient(#a855f7,transparent 70%)}", 0],
  ["body{background:rgba(18,20,26,0.86)}.a{background:radial-gradient(#a855f7,transparent 70%)}", 1],
  [":root{--background:#000}.a{background:radial-gradient(#a855f7,transparent 70%)}", 0],
])("#given radial source %s #then returns %i findings", (source, count) => {
  expect(checkSource(radialHalo, `<html><style>${source}</style></html>`, { path: "a.astro" })).toHaveLength(count);
});
