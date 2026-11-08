// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { aphoristicCadence } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/aphoristic-cadence";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  [`<html><p>${"Not a tool. A whole new world. ".repeat(3)}</p></html>`, 1],
  [`<html><p>${"Not a tool. A whole new world. ".repeat(2)}</p></html>`, 0],
  ["<html><p>Export invoices, send reports, and compare totals.</p></html>", 0],
  ["Not a tool. A whole new world. ".repeat(3), 0],
])("#given clipped page copy #then returns %i findings", (source, count) => {
  expect(checkSource(aphoristicCadence, source, { path: "a.svelte" })).toHaveLength(count);
});
