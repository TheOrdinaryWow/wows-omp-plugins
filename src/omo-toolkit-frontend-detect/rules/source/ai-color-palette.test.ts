// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { aiColorPalette } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/ai-color-palette";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  ['<h1 className="text-purple-500" />', 1],
  ['<div className="text-purple-500 text-3xl" />', 1],
  ['<div className="from-purple-500 to-cyan-400" />', 1],
  ['<p className="text-purple-500" />', 0],
  ['<div className="from-red-500 to-orange-400" />', 0],
])("#given palette source %s #then returns %i findings", (source, count) => {
  expect(checkSource(aiColorPalette, source)).toHaveLength(count);
});
