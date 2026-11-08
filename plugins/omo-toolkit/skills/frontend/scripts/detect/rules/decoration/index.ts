// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { Rule } from "../../rule";
import { blinkingCursor } from "./blinking-cursor";
import { borderAccentOnRounded } from "./border-accent-on-rounded";
import { bounceEasing } from "./bounce-easing";
import { buriedRaster } from "./buried-raster";
import { codexGridBackground } from "./codex-grid-background";
import { designSystemRadius } from "./design-system-radius";
import { gptThinBorderWideShadow } from "./gpt-thin-border-wide-shadow";
import { hardOffsetShadow } from "./hard-offset-shadow";
import { heroEyebrowChip } from "./hero-eyebrow-chip";
import { iconTileStack } from "./icon-tile-stack";
import { kickerAboveHeading } from "./kicker-above-heading";
import { marquee } from "./marquee";
import { organicClipPath } from "./organic-clip-path";
import { pulsingDot } from "./pulsing-dot";
import { repeatingStripesGradient } from "./repeating-stripes-gradient";
import { shapeAssembledIllustration } from "./shape-assembled-illustration";
import { sideTab } from "./side-tab";

export const DECORATION_RULES: readonly Rule[] = [
  hardOffsetShadow,
  sideTab,
  borderAccentOnRounded,
  gptThinBorderWideShadow,
  repeatingStripesGradient,
  codexGridBackground,
  organicClipPath,
  buriedRaster,
  shapeAssembledIllustration,
  iconTileStack,
  heroEyebrowChip,
  kickerAboveHeading,
  designSystemRadius,
  marquee,
  pulsingDot,
  blinkingCursor,
  bounceEasing,
];
