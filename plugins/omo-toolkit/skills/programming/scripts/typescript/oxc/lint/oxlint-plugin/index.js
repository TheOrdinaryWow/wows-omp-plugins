// Modified-port notice: OMP adaptation via oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e; retained MIT third-party license (see LICENSE).
import noEmDashCopy from "./no-em-dash-copy.js";
import requireSuppressionReason from "./require-suppression-reason.js";

export default {
  meta: { name: "programming" },
  rules: {
    "no-em-dash-copy": noEmDashCopy,
    "require-suppression-reason": requireSuppressionReason,
  },
};
