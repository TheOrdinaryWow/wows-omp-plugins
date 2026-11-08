// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { lintSnapshot } from "../../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/lint";
import type { PageRule } from "../../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rule";
import type { PageSnapshot } from "../../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/types";
import { buildSnapshot, type NodeSpec } from "../../../testing/build-snapshot";

export const marked = (rule: PageRule, nodes: readonly NodeSpec[], options: Parameters<typeof buildSnapshot>[1] = {}): readonly string[] =>
  selectors(rule, buildSnapshot(nodes, options));

export const selectors = (rule: PageRule, snapshot: PageSnapshot): readonly string[] =>
  lintSnapshot(snapshot, { rules: [rule] }).map((f) => (f.location.kind === "element" ? f.location.selector : "page"));

export const border = {
  "border-top-width": "1px",
  "border-right-width": "1px",
  "border-bottom-width": "1px",
  "border-left-width": "1px",
  "border-top-style": "solid",
  "border-right-style": "solid",
  "border-bottom-style": "solid",
  "border-left-style": "solid",
  "border-top-color": "#333",
  "border-right-color": "#333",
  "border-bottom-color": "#333",
  "border-left-color": "#333",
};

export const rounded = {
  "border-top-left-radius": "12px",
  "border-top-right-radius": "12px",
  "border-bottom-right-radius": "12px",
  "border-bottom-left-radius": "12px",
};

export const lines = (widths: readonly number[], x = 24, y = 24, height = 20) =>
  widths.map((width, i) => ({ x, y: y + i * 24, width, height }));
