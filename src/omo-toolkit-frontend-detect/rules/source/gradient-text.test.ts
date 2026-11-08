// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { gradientText } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/gradient-text";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  ['<h1 className="bg-gradient-to-r bg-clip-text" />', 1],
  ['<h1 className="bg-clip-text bg-blue-500" />', 0],
  [".a {background:linear-gradient(red,blue);\nbackground-clip:text;\n-webkit-background-clip:text}", 1],
  [".a{background:blue;background-clip:text}", 0],
])("#given gradient source %s #then returns %i findings", (source, count) => {
  expect(checkSource(gradientText, source, { path: "a.css" })).toHaveLength(count);
});
