// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { Rule } from "../../rule";
import { bodyTextViewportEdge } from "./body-text-viewport-edge";
import { clippedOverflowContainer } from "./clipped-overflow-container";
import { contentHiddenAtRest } from "./content-hidden-at-rest";
import { crampedPadding } from "./cramped-padding";
import { edgeFlushCards } from "./edge-flush-cards";
import { firstViewportColumnOverflow } from "./first-viewport-column-overflow";
import { headingRhythm } from "./heading-rhythm";
import { monotonousSpacing } from "./monotonous-spacing";
import { nestedCards } from "./nested-cards";
import { straggler } from "./straggler";
import { textOcclusion } from "./text-occlusion";
import { textOverflow } from "./text-overflow";
import { unbalancedHeading } from "./unbalanced-heading";
import { viewportReflow } from "./viewport-reflow";

export const LAYOUT_RULES: readonly Rule[] = [
  nestedCards,
  monotonousSpacing,
  edgeFlushCards,
  textOcclusion,
  firstViewportColumnOverflow,
  crampedPadding,
  bodyTextViewportEdge,
  textOverflow,
  clippedOverflowContainer,
  headingRhythm,
  straggler,
  unbalancedHeading,
  contentHiddenAtRest,
  viewportReflow,
];
