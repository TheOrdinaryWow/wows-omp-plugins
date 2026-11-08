// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../../ATTRIBUTION.md section 7.
import type { SourceHit, SourceRule } from "../../../rule";
import type { DetectConfig } from "../../../types";

export function checkSource(
  rule: SourceRule,
  text: string,
  options: { readonly path?: string; readonly config?: DetectConfig } = {},
): readonly SourceHit[] {
  return rule.check({ file: { path: options.path ?? "fixture.tsx", text }, config: options.config ?? {} });
}
