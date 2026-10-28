// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { valueChecks } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-values.mjs";
import { buildContext } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/gates-static.mjs";
import { parseHtml } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/html-lite.mjs";

const FIX = join(import.meta.dir, "fixtures", "fidelity");
export const SOURCES = join(FIX, "sources"),
  LEDGER = JSON.parse(readFileSync(join(FIX, "ledger-verify.json"), "utf8"));
export function ledgerWith(id, patch) {
  const copy = structuredClone(LEDGER);
  copy.rows = copy.rows.map((row) => (row.fact_id === id ? { ...row, ...patch } : row));
  return copy;
}
export function run(body, options = {}) {
  const html = /<h2/.test(body)
      ? body
      : `<h2>Findings</h2>
${body}`,
    ctx = buildContext(parseHtml(html), { baseDir: options.baseDir ?? FIX }),
    sourcesDir = options.sourcesDir === void 0 ? SOURCES : options.sourcesDir;
  return valueChecks(ctx, options.ledger ?? LEDGER, options.fillMap ?? null, sourcesDir, options);
}
