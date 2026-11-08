// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { emDashOveruse } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/em-dash-overuse";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  [`<html><p>${"a &mdash; b ".repeat(8)}</p></html>`, 1],
  [`<html><p>${"a -- b ".repeat(8)}</p></html>`, 1],
  [`<html><p>${"a --- b ".repeat(8)}</p></html>`, 0],
  [`<html><p>${"a &mdash; b ".repeat(7)}</p></html>`, 0],
  [`<html><p>${"a &mdash; b ".repeat(8)}${"x".repeat(5000)}</p></html>`, 0],
])("#given page dash source #then returns %i findings", (source, count) => {
  expect(checkSource(emDashOveruse, source, { path: "a.astro" })).toHaveLength(count);
});
