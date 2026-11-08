// Modified-port notice: OMP adaptation of oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace; SUL-1.0 (see plugin LICENSE-SUL-1.0).
import noEmDashCopy from "./no-em-dash-copy.js";
import requireSuppressionReason from "./require-suppression-reason.js";

export default {
  meta: { name: "programming" },
  rules: {
    "no-em-dash-copy": noEmDashCopy,
    "require-suppression-reason": requireSuppressionReason,
  },
};
