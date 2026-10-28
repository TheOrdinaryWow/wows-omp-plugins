// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { expect, onTestFinished } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/report-tools.mjs";
export const FIX = join(import.meta.dir, "fixtures");
const BASE = JSON.parse(readFileSync(join(FIX, "fidelity", "ledger-verify.json"), "utf8"));
export const F1 = BASE.rows.find((r) => r.fact_id === "F1");
const extra = (fact_id, label, raw, value, unit, num, den = "1") => ({ ...F1, fact_id, label, raw, value, unit, exact: { num, den } });
export const LEDGER = {
  ...BASE,
  rows: [
    ...BASE.rows,
    extra("F20", "gap_pp", "3.2%p", "3.2", "%p", "16", "5"),
    extra("F21", "rev_eok", "3,234 KRW-e8", "3234", "KRW-e8", "3234"),
    extra("F22", "staff", "5\uBA85", "5", "person", "5"),
    extra("F23", "price", "$12", "12", "USD", "12"),
    extra("F24", "deck_len", "1.2 km", "1.2", "km", "6", "5"),
  ],
};
export async function filled(body, format = "html") {
  const dir = mkdtempSync(join(tmpdir(), "value-mode-unit-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "fact-ledger.json"), JSON.stringify(LEDGER));
  copyFileSync(join(FIX, "fidelity-brief-locked.md"), join(dir, "brief.md"));
  cpSync(join(FIX, "fidelity", "sources"), join(dir, "sources"), { recursive: true });
  const source = join(dir, `report.src.${format}`),
    report = join(dir, `report.${format}`);
  writeFileSync(source, body);
  const result = await run(["fact", "fill", source, "--out", report, "--session-dir", dir]);
  expect(result.exitCode).toBe(0);
  const verify = async () => await run(["fact", "verify", report, "--session-dir", dir]),
    edit = (from, to) => writeFileSync(report, readFileSync(report, "utf8").replace(from, to)),
    text = readFileSync(report, "utf8");
  return { verify, edit, text, write: (next) => writeFileSync(report, next) };
}
export const codes = (result) => result.json.defects.map((d) => d.code),
  prose = (pointer, tail) => `<h2>Findings</h2><p>Up to ${pointer}${tail} [S4].</p>`;
