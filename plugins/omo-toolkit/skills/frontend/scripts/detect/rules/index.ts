// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../ATTRIBUTION.md section 7.
import type { Rule } from "../rule";
import { COLOR_RULES } from "./color";
import { COPY_RULES } from "./copy";
import { DECORATION_RULES } from "./decoration";
import { LAYOUT_RULES } from "./layout";
import { SOURCE_RULES } from "./source";
import { TYPOGRAPHY_RULES } from "./typography";

export const ALL_RULES: readonly Rule[] = [
  ...COLOR_RULES,
  ...TYPOGRAPHY_RULES,
  ...LAYOUT_RULES,
  ...DECORATION_RULES,
  ...COPY_RULES,
  ...SOURCE_RULES,
];
