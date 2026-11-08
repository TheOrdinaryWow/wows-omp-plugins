// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { monotonousSpacing } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/monotonous-spacing";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  [`<html>${'<div class="p-4"></div>'.repeat(10)}</html>`, 1],
  [`<html>${'<div class="p-0"></div>'.repeat(10)}</html>`, 0],
  [`<html>${'<div class="p-4"></div>'.repeat(9)}</html>`, 0],
  [`<html>${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<div class="p-${n}"></div>`).join("")}</html>`, 0],
  ['<div class="p-4"></div>'.repeat(10), 0],
])("#given page spacing source #then returns %i findings", (source, count) => {
  expect(checkSource(monotonousSpacing, source, { path: "a.astro" })).toHaveLength(count);
});
