// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { expect } from "bun:test";

import { addRow, emptyLedger } from "../../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-ledger.mjs";
import { derive } from "./derive-clock.js";

const now = "2026-10-23T08:00:00Z";
function book(values = ["1", "3"], units = ["m", "m"], extras = []) {
  const ledger = emptyLedger();
  values.forEach((value, i) => {
    addRow(ledger, {
      kind: "measured",
      value,
      unit: units[i],
      raw: value,
      quote: value,
      source_id: "S1",
      locator: { artifact: "sources/S1/text.txt", char_start: 0, char_end: 1 },
      snapshot_sha256: "a".repeat(64),
      extracted_by: "test",
      observed_at: now,
      label: `f${i + 1}`,
      ...extras[i],
    });
  });
  return ledger;
}
function row(ledger, spec) {
  const result = derive(ledger, { ...spec, now });
  if (!("row" in result)) throw Error(JSON.stringify(result));
  return result.row;
}
const sum = { op: "sum", operands: ["F1", "F2"], unit: "m" };
function refused(ledger, spec) {
  const before = structuredClone(ledger),
    result = derive(ledger, spec);
  expect(result).toMatchObject({ error: "incompatible_operands" });
  expect(ledger).toEqual(before);
  return result;
}

export { book, now, refused, row, sum };
