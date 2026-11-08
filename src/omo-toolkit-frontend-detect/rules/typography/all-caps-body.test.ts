// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { allCapsBody } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/typography/all-caps-body";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given sentence-length uppercase prose and short labels #then only prose is flagged", () => {
  const snapshot = buildSnapshot([
    { id: "paragraph", tag: "p", text: "Reading copy ".repeat(8), style: { "text-transform": "uppercase" } },
    { id: "blurb", text: "A product blurb with more than eighty characters. ".repeat(3), style: { "text-transform": "uppercase" } },
    { id: "short", text: "A short kicker", style: { "text-transform": "uppercase" } },
    { id: "heading", tag: "h2", text: "Reading copy ".repeat(8), style: { "text-transform": "uppercase" } },
    { id: "normal", text: "Reading copy ".repeat(8) },
    { id: "parent", text: "Short bar label", style: { "text-transform": "uppercase" }, children: [{ text: "Child copy ".repeat(8) }] },
  ]);
  expect(allCapsBody.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#paragraph", "#blurb"]);
});

test("#given eighty-character boundary and hidden text #then only the visible boundary reports", () => {
  const snapshot = buildSnapshot([
    { id: "floor", text: "a".repeat(80), style: { "text-transform": "uppercase" } },
    { id: "below", text: "a".repeat(79), style: { "text-transform": "uppercase" } },
    { id: "hidden", text: "a".repeat(80), style: { "text-transform": "uppercase", display: "none" } },
  ]);
  expect(allCapsBody.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#floor"]);
});
