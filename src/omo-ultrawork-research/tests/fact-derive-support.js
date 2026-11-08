import { addRow, emptyLedger } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-ledger.mjs";

const HASH = "a".repeat(64),
  EOK_WON = "\uC5B5\uC6D0";
function measured(factId, value, unit, extra = {}) {
  return {
    fact_id: factId,
    kind: "measured",
    value,
    unit,
    raw: `${value} ${unit}`,
    quote: `The figure is ${value} ${unit}.`,
    source_id: "S1",
    locator: { artifact: "sources/S1/text.txt", char_start: 0, char_end: 20 },
    snapshot_sha256: HASH,
    extracted_by: "fact add --find",
    observed_at: "2026-10-23T08:00:00Z",
    label: factId.toLowerCase(),
    ...extra,
  };
}
function ledgerOf(rows) {
  const ledger = emptyLedger();
  for (const row of rows) addRow(ledger, row);
  return ledger;
}
function fixture() {
  return ledgerOf([
    measured("F5", "100", EOK_WON, { population: "all" }),
    measured("F6", "200", EOK_WON, { population: "all" }),
    measured("F7", "200", EOK_WON, { population: "subset" }),
    measured("F8", "15", "%"),
    measured("F9", "20", "%"),
    measured("F12", "320", "m"),
    measured("F19", "100", "case", { valid_at: "2025-Q3", entity: "acme" }),
    measured("F20", "112", "case", { valid_at: "2026-Q3", entity: "acme" }),
    measured("F30", "3.2", "m"),
  ]);
}
function rowOf(result) {
  if (!result.row) throw Error(`expected a row, got ${result.error}: ${result.detail}`);
  return result.row;
}

export { EOK_WON, fixture, HASH, ledgerOf, measured, rowOf };
