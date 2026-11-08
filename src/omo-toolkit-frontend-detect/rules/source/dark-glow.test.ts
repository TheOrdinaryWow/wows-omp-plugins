// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { darkGlow } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/dark-glow";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  ["<html><style>.a{box-shadow:0 0 20px #f00}</style></html>", 1],
  ["<html><style>body{background:#000}.a{box-shadow:0 4px 20px #f00}</style></html>", 1],
  ["<html><style>.a{box-shadow:0 4px 20px #f00}</style></html>", 0],
  ["<html><style>.a{box-shadow:0 0 20px #777}</style></html>", 0],
  ["<html><style>.a{box-shadow:0 0 4px #f00}</style></html>", 0],
  ["<html><style>.a{box-shadow:0 0 20px rgba(255,0,0,.1)}</style></html>", 0],
  ["<html><style>.a{box-shadow:0 0 20px -11px #f00}</style></html>", 0],
])("#given glow page source #then returns %i findings", (source, count) => {
  expect(checkSource(darkGlow, source, { path: "a.astro" })).toHaveLength(count);
});
