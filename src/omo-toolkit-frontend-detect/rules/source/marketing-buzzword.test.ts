// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { marketingBuzzword } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/marketing-buzzword";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  ["<html><p>Streamline your work.</p></html>", 1],
  ["<html><p>Export invoices as CSV.</p></html>", 0],
  ["<html><script>const label='Streamline your work'</script><p>Export invoices.</p></html>", 0],
  ["<p>Streamline your work.</p>", 0],
])("#given marketing page source #then returns %i findings", (source, count) => {
  expect(checkSource(marketingBuzzword, source, { path: "a.vue" })).toHaveLength(count);
});
