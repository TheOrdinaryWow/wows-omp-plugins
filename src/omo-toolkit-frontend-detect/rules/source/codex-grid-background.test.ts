// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { codexGridBackground } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/codex-grid-background";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  [
    ".grid{background:linear-gradient(red 1px, transparent 1px),linear-gradient(90deg, red 1px, transparent 1px);background-size:24px 24px}",
    1,
  ],
  [".line{background:linear-gradient(red 1px, transparent 1px);background-size:24px 24px}", 0],
  [".grid{background:linear-gradient(red 1px, transparent 1px),linear-gradient(90deg, red 1px, transparent 1px)}", 0],
])("#given background source %s #then returns %i findings", (source, count) => {
  expect(checkSource(codexGridBackground, source, { path: "a.css" })).toHaveLength(count);
});
