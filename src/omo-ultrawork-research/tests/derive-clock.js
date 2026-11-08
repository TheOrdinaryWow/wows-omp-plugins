// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { derive as deriveAt } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-derive.mjs";
export const derive = (ledger, spec) =>
  deriveAt(ledger, spec !== null && typeof spec === "object" && !Array.isArray(spec) ? { now: "2026-10-23T08:00:00Z", ...spec } : spec);
