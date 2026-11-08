// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { justifiedText } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/typography/justified-text";
import { buildSnapshot } from "../../testing/build-snapshot";

test("#given narrow justified columns and wide, hyphenated or script controls #then only narrow Latin prose reports", () => {
  const text = "Forcing every line of a narrow column to the same width stretches the spaces between words.";
  const style = { "text-align": "justify", "line-height": "24px" };
  const lineRects = [
    { x: 0, y: 0, width: 300, height: 18 },
    { x: 0, y: 24, width: 280, height: 18 },
  ];
  const snapshot = buildSnapshot([
    { id: "narrow", tag: "p", text, style, rect: { width: 300 }, lineRects },
    { id: "manual", tag: "p", text, style: { ...style, hyphens: "manual" }, rect: { width: 260 }, lineRects },
    { tag: "p", text, style, rect: { width: 760 }, lineRects },
    { tag: "p", text, style: { ...style, hyphens: "auto" }, rect: { width: 300 }, lineRects },
    { tag: "p", text: "永慶房屋專注本業堅持創新提供消費者透明的資訊與安心的服務", style, lineRects },
    { tag: "p", text: "การจัดวางข้อความแบบชิดขอบทั้งสองด้านในภาษาไทย", style, lineRects },
    { tag: "p", text: "يعتمد ضبط النص في الخط العربي على استطالة الحروف على السطر", style, lineRects },
    {
      tag: "h4",
      text: "Research topics",
      style,
      rect: { width: 300 },
      lineRects: [lineRects[0] ?? { x: 0, y: 0, width: 100, height: 18 }],
    },
  ]);
  expect(justifiedText.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#narrow", "#manual"]);
});

test("#given inline text inheriting justification #then the containing block supplies the measure", () => {
  const text = "Wrapping the whole paragraph in a span changes nothing about the narrow measure it occupies.";
  const style = { "text-align": "justify", "line-height": "24px" };
  const lineRects = [
    { x: 0, y: 0, width: 280, height: 18 },
    { x: 0, y: 24, width: 260, height: 18 },
  ];
  const snapshot = buildSnapshot([
    { rect: { width: 280 }, style, children: [{ id: "span", tag: "span", text, style, lineRects }] },
    { rect: { width: 760 }, style, text: "A paragraph with text of its own.", children: [{ tag: "a", text, style, lineRects }] },
  ]);
  expect(justifiedText.check({ snapshot, config: {} }).map((h) => h.element?.selector)).toEqual(["#span"]);
});
