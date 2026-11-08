// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { marketingBuzzword } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/copy/marketing-buzzword";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given repeated stock phrases and concrete copy #then only stock phrases count", () => {
  const check = (text: string) => marketingBuzzword.check({ snapshot: buildSnapshot([{ tag: "p", text }]), config: {} });
  expect(check("STREAMLINE YOUR workflow and streamline your day. World-class enterprise-grade tools.")).toHaveLength(1);
  expect(check("Export an invoice as PDF in two clicks.")).toHaveLength(0);
  expect(check("revolutionize revolutionary")).toHaveLength(1);
});

test("#given hidden buzzwords beside visible concrete copy #then only painted copy contributes", () => {
  const check = (display: string) =>
    marketingBuzzword.check({
      snapshot: buildSnapshot([
        { style: { display }, children: [{ tag: "p", text: "Empower your team" }] },
        { tag: "p", text: "Send invoices." },
      ]),
      config: {},
    });
  expect(check("block")).toHaveLength(1);
  expect(check("none")).toHaveLength(0);
});
