// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { PageRule } from "../../rule";
import { aiColorPalette } from "./ai-color-palette";
import { creamPalette } from "./cream-palette";
import { darkGlow } from "./dark-glow";
import { designSystemColor } from "./design-system-color";
import { gradientText } from "./gradient-text";
import { grayOnColor } from "./gray-on-color";
import { lowContrast } from "./low-contrast";
import { radialHalo } from "./radial-halo";
import { radialSpotlightGlow } from "./radial-spotlight-glow";

export const COLOR_RULES: readonly PageRule[] = [
  lowContrast,
  grayOnColor,
  aiColorPalette,
  creamPalette,
  gradientText,
  darkGlow,
  radialHalo,
  radialSpotlightGlow,
  designSystemColor,
];
