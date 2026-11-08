// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { aphoristicCadence } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/copy/aphoristic-cadence";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given two versus three rebuttal constructions #then the three-construction floor applies", () => {
  const phrases = ["Not a dashboard. Your command center.", "Not an app. Your working memory.", "Not a tool. Your daily companion."];
  const check = (count: number) =>
    aphoristicCadence.check({
      snapshot: buildSnapshot(phrases.slice(0, count).map((text) => ({ tag: "p", text }))),
      config: {},
    });
  expect(check(3)).toHaveLength(1);
  expect(check(2)).toHaveLength(0);
});

test("#given short no and just rebuttals #then ordinary sentences remain clear", () => {
  const check = (text: string) => aphoristicCadence.check({ snapshot: buildSnapshot([{ text }]), config: {} });
  expect(check("Everything you need. No friction. All your work. Just results. Bring your team. No limits.")).toHaveLength(1);
  expect(check("The invoice is ready. Send it to your customer. Track the payment.")).toHaveLength(0);
});
