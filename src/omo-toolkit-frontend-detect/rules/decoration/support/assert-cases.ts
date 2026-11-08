// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect } from "bun:test";

import { lintSnapshot } from "../../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/lint";
import type { PageRule } from "../../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rule";
import type { DetectConfig } from "../../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/types";
import { buildSnapshot, type NodeSpec } from "../../../testing/build-snapshot";
export function assertCases(
  rule: PageRule,
  nodes: readonly NodeSpec[],
  expected: readonly string[],
  options: { readonly cssText?: readonly string[]; readonly config?: DetectConfig } = {},
): void {
  const snapshot = buildSnapshot(nodes, { cssText: options.cssText ?? [] });
  const findings = lintSnapshot(snapshot, { rules: [rule], config: options.config ?? {} });
  expect(findings.map((f) => (f.location.kind === "element" ? f.location.selector : "page"))).toEqual([...expected]);
}
export const round = (radius: string): Readonly<Record<string, string>> =>
  Object.fromEntries(["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => [`border-${c}-radius`, radius]));
export const border = (width: string, color = "rgb(230, 231, 233)"): Readonly<Record<string, string>> =>
  Object.fromEntries(
    ["top", "right", "bottom", "left"].flatMap((s) => [
      [`border-${s}-width`, width],
      [`border-${s}-style`, "solid"],
      [`border-${s}-color`, color],
    ]),
  );
