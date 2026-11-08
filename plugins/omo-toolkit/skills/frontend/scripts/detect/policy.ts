// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../ATTRIBUTION.md section 7.
import type { RuleEngine, Severity } from "./types";

/**
 * Page rules whose finding is a defect under any design direction: broken loading or images, content that is invisible,
 * clipped, covered or forces sideways scrolling, a broken heading outline, and WCAG text contrast. Every other rule is a
 * craft default or a generated-look tell: it is reported, and a person decides it, but it never blocks a gate.
 * @public
 */
export const OBJECTIVE_DEFECT_RULES: Readonly<Record<string, true>> = {
  "broken-image": true,
  "content-hidden-at-rest": true,
  "low-contrast": true,
  "script-error": true,
  "skipped-heading": true,
  "text-occlusion": true,
  "text-overflow": true,
  "viewport-reflow": true,
};

/** Only rendered evidence of an objective defect at error or warning severity blocks; source-text heuristics never do. */
export const isBlocking = (engine: RuleEngine, ruleId: string, severity: Severity): boolean =>
  engine === "page" && severity !== "advisory" && Object.hasOwn(OBJECTIVE_DEFECT_RULES, ruleId);
