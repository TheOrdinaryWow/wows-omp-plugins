// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { SourceRule } from "../../rule";
import { bodyText, componentExtensions, pageSource, sourceHit } from "./support/source-text";

export const aphoristicCadence: SourceRule = {
  meta: {
    id: "aphoristic-cadence",
    name: "Aphoristic-cadence copy",
    category: "slop",
    severity: "warning",
    engine: "source",
    description: "Several clipped rebuttals give page copy a repetitive slogan rhythm.",
    fixHint: "Replace repeated slogans with specific, naturally paced sentences.",
  },
  extensions: componentExtensions,
  check: (context) => {
    const source = pageSource(context);
    if (source === null) return [];
    const text = bodyText(source);
    const count =
      [...text.matchAll(/\bNot an? [a-z][^.!?]{1,40}[.!]\s+[A-Z][^.!?]{1,60}[.!]/g)].length +
      [...text.matchAll(/\b[A-Z][^.!?]{4,80}[.!]\s+(No|Just)\s+[a-z][^.!?]{2,60}[.!]/g)].length;
    return count >= 3 ? [sourceHit(source, 0, `${count} clipped slogan constructions`)] : [];
  },
};
