// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../../ATTRIBUTION.md section 7.
import { ancestors, IGNORE_ATTRIBUTES, isIgnored } from "../../../core/page";
import type { ElementSnapshot, PageSnapshot } from "../../../types";

export function pageIgnored(snapshot: PageSnapshot, el: ElementSnapshot, rule: string): boolean {
  return (
    isIgnored(snapshot, el, rule) ||
    [el, ...ancestors(snapshot, el)].some((node) =>
      IGNORE_ATTRIBUTES.some((name) => (node.attributes[name] ?? "").split(/[\s,]+/).includes("*")),
    )
  );
}
