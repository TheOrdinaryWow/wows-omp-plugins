// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { PageRule } from "../../rule";
import { pageText } from "./support/page-text";

export const aphoristicCadence: PageRule = {
  meta: {
    id: "aphoristic-cadence",
    name: "Aphoristic-cadence copy",
    category: "slop",
    severity: "warning",
    engine: "page",
    description: "Three or more short rebuttals give unrelated sections the same cadence.",
    fixHint: "Replace repeated rebuttals with specific information and vary sentence structure.",
  },
  check: ({ snapshot }) => {
    const text = pageText(snapshot);
    const matches = [
      ...text.matchAll(/\bNot an? [a-z][^.!?]{1,40}[.!]\s+[A-Z][^.!?]{1,60}[.!]/g),
      ...text.matchAll(/\b[A-Z][^.!?]{4,80}[.!]\s+(No|Just)\s+[a-z][^.!?]{2,60}[.!]/g),
    ];
    return matches.length < 3
      ? []
      : [
          {
            element: null,
            message: `${matches.length} aphoristic constructions`,
            snippet: (matches[0]?.[0] ?? "").trim().slice(0, 80),
          },
        ];
  },
};
