// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { emDashOveruse } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/copy/em-dash-overuse";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given dash floor and density boundaries #then only dense prose with eight marks reports", () => {
  const check = (text: string) => emDashOveruse.check({ snapshot: buildSnapshot([{ tag: "p", text }]), config: {} });
  expect(check("a — b — c — d — e — f — g — h — i")).toHaveLength(1);
  expect(check("a — b — c — d — e — f — g — h")).toHaveLength(0);
  expect(check(`${"—".repeat(8)}${"x".repeat(3992)}`)).toHaveLength(1);
  expect(check(`${"—".repeat(8)}${"x".repeat(3993)}`)).toHaveLength(0);
});

test("#given alternate dash spellings and table rules #then punctuation alone is counted", () => {
  const check = (text: string) => emDashOveruse.check({ snapshot: buildSnapshot([{ text }]), config: {} });
  expect(check("word---word ".repeat(8))).toHaveLength(1);
  expect(check("word--next ".repeat(8))).toHaveLength(1);
  expect(check("word —— next ".repeat(8))).toHaveLength(1);
  expect(check("word —— next ".repeat(7))).toHaveLength(0);
  expect(check("|-------| ------- rule ----x -- space ".repeat(10))).toHaveLength(0);
});

test("#given matrix markers choices and list separators #then actual prose remains counted", () => {
  const check = (prose: string) =>
    emDashOveruse.check({
      snapshot: buildSnapshot([
        { tag: "p", text: prose },
        ...Array.from({ length: 10 }, () => ({ tag: "td", text: "—" })),
        { tag: "select", children: Array.from({ length: 10 }, () => ({ tag: "option", text: "USD — US Dollar" })) },
        { tag: "ul", children: Array.from({ length: 8 }, (_, n) => ({ tag: "li", text: `Feature ${n} — Description` })) },
      ]),
      config: {},
    });
  expect(check("a — b — c — d — e — f — g — h — i")).toHaveLength(1);
  expect(check("Read the feature list.")).toHaveLength(0);
});

test("#given lowercase prose list items #then their dashes are not treated as separators", () => {
  const check = (ending: string) =>
    emDashOveruse.check({
      snapshot: buildSnapshot([
        { tag: "ul", children: Array.from({ length: 8 }, () => ({ tag: "li", text: `We ship every week — ${ending}` })) },
      ]),
      config: {},
    });
  expect(check("and every update is free.")).toHaveLength(1);
  expect(check("Current updates")).toHaveLength(0);
});
