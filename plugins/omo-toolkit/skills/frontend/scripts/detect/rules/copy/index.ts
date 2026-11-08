// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import type { PageRule } from "../../rule";
import { aphoristicCadence } from "./aphoristic-cadence";
import { brokenImage } from "./broken-image";
import { emDashOveruse } from "./em-dash-overuse";
import { marketingBuzzword } from "./marketing-buzzword";
import { numberedSectionLabels } from "./numbered-section-labels";
import { repeatedContainerText } from "./repeated-container-text";
import { scriptError } from "./script-error";
import { skippedHeading } from "./skipped-heading";
import { theaterSlopPhrase } from "./theater-slop-phrase";

export const COPY_RULES: readonly PageRule[] = [
  emDashOveruse,
  marketingBuzzword,
  aphoristicCadence,
  theaterSlopPhrase,
  numberedSectionLabels,
  repeatedContainerText,
  skippedHeading,
  brokenImage,
  scriptError,
];
