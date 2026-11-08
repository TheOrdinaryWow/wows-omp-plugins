// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { theaterSlopPhrase } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/copy/theater-slop-phrase";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given dismissive framing and literal theaters #then only the closed vocabulary reports", () => {
  const check = (text: string) => theaterSlopPhrase.check({ snapshot: buildSnapshot([{ text }]), config: {} });
  for (const text of ["Security theater", "growth THEATER", "Accessibility theater"]) expect(check(text)).toHaveLength(1);
  for (const text of ["Southern Theater Command", "The official theater", "A theater of operations", "security theatrical"])
    expect(check(text)).toHaveLength(0);
});

test("#given framing split across inline elements #then rendered words still match", () => {
  const check = (text: string) =>
    theaterSlopPhrase.check({
      snapshot: buildSnapshot([
        {
          tag: "p",
          children: [
            { tag: "span", text },
            { tag: "em", text: "theater" },
          ],
        },
      ]),
      config: {},
    });
  expect(check("privacy")).toHaveLength(1);
  expect(check("national")).toHaveLength(0);
});
