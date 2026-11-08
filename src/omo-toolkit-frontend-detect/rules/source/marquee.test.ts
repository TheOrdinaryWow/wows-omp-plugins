// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { marquee } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/marquee";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  ["<marquee>News</marquee>", 1],
  [
    "<style>@keyframes roll{from{transform:translateX(0)}to{transform:translateX(-100%)}}.track{animation:roll 10s linear infinite}</style>",
    1,
  ],
  ["<style>@keyframes roll{from{transform:translateX(0)}to{transform:translateX(-100%)}}.track{animation:roll 10s linear 1}</style>", 0],
  ["<style>@keyframes fade{from{opacity:0}to{opacity:1}}.track{animation:fade 1s infinite}</style>", 0],
])("#given marquee source #then returns %i findings", (source, count) => {
  expect(checkSource(marquee, `<html>${source}</html>`, { path: "a.astro" })).toHaveLength(count);
});
