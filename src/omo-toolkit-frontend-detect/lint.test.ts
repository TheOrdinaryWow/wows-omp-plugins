// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { describe, expect, test } from "bun:test";

import { lintSnapshot } from "../../plugins/omo-toolkit/skills/frontend/scripts/detect/lint";
import type { PageRule } from "../../plugins/omo-toolkit/skills/frontend/scripts/detect/rule";
import { buildSnapshot } from "./testing/build-snapshot";

const twoHits: PageRule = {
  meta: { id: "two-hits", name: "Two hits", category: "quality", severity: "error", engine: "page", description: "d", fixHint: "f" },
  check: () => [
    { element: null, message: "default", snippet: "" },
    { element: null, message: "softer", snippet: "", severity: "advisory" },
  ],
};

describe("lintSnapshot severity", () => {
  test("#given a hit with its own severity #then it replaces the rule default for that hit only", () => {
    const findings = lintSnapshot(buildSnapshot([]), { rules: [twoHits] });
    expect(findings.map((f) => [f.message, f.severity])).toEqual([
      ["default", "error"],
      ["softer", "advisory"],
    ]);
  });

  test("#given a project override for the rule #then every hit takes the override", () => {
    const findings = lintSnapshot(buildSnapshot([]), { rules: [twoHits], config: { rules: { "two-hits": "warning" } } });
    expect(findings.map((f) => f.severity)).toEqual(["warning", "warning"]);
  });
});
