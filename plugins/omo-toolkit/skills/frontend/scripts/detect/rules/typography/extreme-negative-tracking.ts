// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../ATTRIBUTION.md section 7.
import { fontSizePx, px, shortSnippet, styleOf } from "../../core/page";
import type { PageRule } from "../../rule";
import { cjk, visibleText } from "./support/text-context";

export const extremeNegativeTracking: PageRule = {
  meta: {
    id: "extreme-negative-tracking",
    name: "Crushed letter spacing",
    category: "slop",
    severity: "warning",
    engine: "page",
    description: "Negative tracking beyond the reading or display threshold damages letter shapes.",
    fixHint: "Keep tracking at or above -0.07em for reading text and -0.09em for display type.",
  },
  check: ({ snapshot }) =>
    snapshot.elements.flatMap((element) => {
      const size = fontSizePx(element);
      const tracking = (px(styleOf(element, "letter-spacing")) ?? 0) / size;
      if (
        visibleText(snapshot, element) === false ||
        element.ownText.length <= 10 ||
        element.text.length <= 20 ||
        size <= 0 ||
        tracking >= (size >= 40 ? -0.09 : -0.07) ||
        cjk(element.text)
      )
        return [];
      return [{ element, message: `Letter spacing ${tracking.toFixed(2)}em at ${size}px`, snippet: shortSnippet(element) }];
    }),
};
