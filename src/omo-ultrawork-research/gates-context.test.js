// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseLineageMode, parsePalette } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/design-spec.mjs";
import * as gatesStatic from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import * as gatesStructure from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-structure.mjs";
import { parseHtml } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

const FIXTURES = join(import.meta.dir, "tests", "fixtures"),
  GOOD = readFileSync(join(FIXTURES, "good-report.html"), "utf8"),
  SPEC = readFileSync(join(FIXTURES, "design-spec.md"), "utf8");
function buildContextExport() {
  const buildContext = gatesStatic.buildContext;
  if (typeof buildContext !== "function") throw Error("buildContext is not exported");
  return buildContext;
}
describe("static-gate context exports", () => {
  test("#given gates-static #when imported #then buildContext is an exported function", () => {
    const kind = typeof gatesStatic.buildContext;
    expect(kind).toBe("function");
  });
  test("#given the passing fixture report #when buildContext runs #then the walk, sections and helpers are present", () => {
    const buildContext = buildContextExport(),
      options = { palette: parsePalette(SPEC), lineageMode: parseLineageMode(SPEC), requireSections: [], baseDir: FIXTURES },
      ctx = buildContext(parseHtml(GOOD), options);
    expect(ctx.elements.length).toBeGreaterThan(0);
    expect(ctx.texts.length).toBeGreaterThan(0);
    expect(ctx.sections.length).toBeGreaterThan(0);
    expect(ctx.sections.map((section) => section.kind)).toContain("sources");
    expect(typeof ctx.util.hasCitation).toBe("function");
    expect(ctx.util.citationMarker).toBeInstanceOf(RegExp);
    expect(typeof ctx.kindOf).toBe("function");
  });
  test("#given gates-structure #when imported #then UNCHECKED_KINDS lists the closing and sources kinds", () => {
    const unchecked = gatesStructure.UNCHECKED_KINDS,
      kinds = unchecked ? [...unchecked] : [];
    expect(unchecked).toBeInstanceOf(Set);
    expect(kinds).toContain("closing");
    expect(kinds).toContain("sources");
  });
});
