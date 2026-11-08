// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { overusedFont } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/typography/overused-font";
import { buildSnapshot } from "../../testing/build-snapshot";

const nodes = (font: string, count: number, text = "Feature line set in the primary face") =>
  Array.from({ length: count }, () => ({ tag: "p", text, style: { "font-family": font } }));

test("#given a dominant overused font and normalized spellings #then one page finding reports", () => {
  const snapshot = buildSnapshot([...nodes("GeistSans", 12), ...nodes('"Geist Sans"', 11), ...nodes("Georgia", 1)]);
  expect(overusedFont.check({ snapshot, config: {} })).toHaveLength(1);
  expect(overusedFont.check({ snapshot, config: { allowFonts: ["gEiSt SaNs"] } })).toEqual([]);
});

test("#given ties, small pages, secondary faces and platform stacks #then only the dominant face qualifies", () => {
  for (const snapshot of [
    buildSnapshot(nodes("Inter", 19)),
    buildSnapshot([...nodes("Inter", 10), ...nodes("Georgia", 10)]),
    buildSnapshot([...nodes("Georgia", 18), ...nodes("Inter", 2)]),
    buildSnapshot(nodes("-apple-system, BlinkMacSystemFont, Roboto, sans-serif", 22)),
  ])
    expect(overusedFont.check({ snapshot, config: {} })).toEqual([]);
  expect(overusedFont.check({ snapshot: buildSnapshot(nodes("Inter", 20)), config: {} })).toHaveLength(1);
});

test("#given label fonts with negligible character share #then only substantial visible usage reports", () => {
  const tiny = buildSnapshot([...nodes("Inter", 30, "1"), ...nodes("Georgia", 8, "Long ordinary body copy ".repeat(10))]);
  const substantial = buildSnapshot([...nodes("Inter", 30, "Platform"), ...nodes("Georgia", 8, "Long ordinary body copy ".repeat(10))]);
  expect(overusedFont.check({ snapshot: tiny, config: {} })).toEqual([]);
  expect(overusedFont.check({ snapshot: substantial, config: {} })).toHaveLength(1);
});

test("#given a brand face on its owner's domain #then only the owning domain is exempt", () => {
  const snapshot = buildSnapshot(nodes("Geist", 20));
  expect(overusedFont.check({ snapshot: { ...snapshot, url: "https://vercel.com" }, config: {} })).toEqual([]);
  expect(overusedFont.check({ snapshot: { ...snapshot, url: "https://notvercel.com" }, config: {} })).toHaveLength(1);
});
