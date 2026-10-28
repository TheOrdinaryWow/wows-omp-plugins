// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import { buildContext, checkStatic } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

describe("HTML exact Closing headings", () => {
  test.each([
    ["Closing", "closing", false],
    ["Closing the gap: GPU prices", null, true],
  ])("#given %s as an HTML heading #when checked #then closing scope matches the whole heading", (heading, kind, missing) => {
    const root = parseHtml(`<h2>${heading}</h2><p>Prices fell 8%.</p>`);
    expect(buildContext(root, {}).sections.map((section) => section.kind)).toEqual([kind]);
    const { defects } = checkStatic(root, {});
    expect(defects.some((defect) => "code" in defect && defect.code === "missing_closing_section")).toBe(missing);
    expect(defects.some((defect) => "code" in defect && defect.code === "unsourced_number")).toBe(missing);
  });
});
