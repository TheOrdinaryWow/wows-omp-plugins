// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { SourceRule } from "../../rule";
import { bodyText, componentExtensions, pageSource, sourceHit } from "./support/source-text";

const phrases = [
  "streamline your",
  "empower your",
  "supercharge your",
  "unleash your",
  "unleash the power",
  "leverage the power",
  "built for the modern",
  "trusted by leading",
  "trusted by the world",
  "best-in-class",
  "industry-leading",
  "world-class",
  "enterprise-grade",
  "next-generation",
  "cutting-edge",
  "transform your business",
  "revolutionize",
  "game-changer",
  "game changing",
  "mission-critical",
  "best of breed",
  "future-proof",
  "future proof",
  "seamless experience",
  "seamlessly integrate",
  "drive engagement",
  "drive growth",
  "drive results",
  "harness the power",
];

export const marketingBuzzword: SourceRule = {
  meta: {
    id: "marketing-buzzword",
    name: "Marketing buzzword",
    category: "slop",
    severity: "warning",
    engine: "source",
    description: "Page copy contains generic promotional phrases instead of concrete information.",
    fixHint: "Describe what the product does and who it helps.",
  },
  extensions: componentExtensions,
  check: (context) => {
    const source = pageSource(context);
    if (source === null) return [];
    const text = bodyText(source).toLowerCase();
    let count = 0;
    for (const phrase of phrases) count += text.split(phrase).length - 1;
    return count > 0 ? [sourceHit(source, 0, `${count} generic promotional phrases`)] : [];
  },
};
