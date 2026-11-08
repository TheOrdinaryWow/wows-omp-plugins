// Behavioral tests ported from oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import { recompute } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-derive.mjs";
import { parseExpr } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-expr.mjs";
import { addRow, emptyLedger, OPERATIONS } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-ledger.mjs";
import {
  canonicalUnit,
  expectedUnit,
  isAffine,
  OPERATION_RULES,
  renderPrecision,
} from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/unit-rules.mjs";
import { derive } from "./tests/derive-clock.js";
import { ledger, MALFORMED, measured, OPS, PRECISION, RELABELS, REPEATED, relabel, rowOf, VALID } from "./tests/fact-unit-rules-support.js";

test("the case tables cover exactly the registry's operations, which are the ledger schema's operations", () => {
  expect([...OPS].sort()).toEqual([...OPERATIONS].sort());
  for (const table of [VALID, MALFORMED]) expect(Object.keys(table).sort()).toEqual([...OPS].sort());
});
describe.each(OPS)("%s", (op) => {
  test("valid typed operands derive, and the stored row recomputes ok", () => {
    for (const { spec, unit } of VALID[op]) {
      const book = ledger(),
        row = rowOf(derive(book, spec));
      expect(row.unit).toBe(unit);
      expect(recompute(book, row)).toMatchObject({ ok: !0 });
    }
  });
  test("every other unit, alias, or null is a relabel: recompute names the expected unit and derive refuses it", () => {
    for (const { spec, unit } of VALID[op]) {
      const book = ledger(),
        row = rowOf(derive(book, spec));
      for (const other of RELABELS.filter((candidate) => candidate !== unit)) {
        const [plain, ...withContext] = relabel(row, other),
          result = recompute(book, plain);
        expect({ other, ok: result.ok }).toEqual({ other, ok: !1 });
        expect(result.detail).toContain(`expected unit ${JSON.stringify(unit)}`);
        for (const variant of withContext) {
          const honest = op === "convert" ? derive(ledger(), { ...spec, to: other }).row : void 0,
            consistent =
              honest !== void 0 &&
              ["unit", "exact", "value", "render", "formula", "factor", "precision", "compatibility"].every(
                (key) => JSON.stringify(honest[key]) === JSON.stringify(variant[key]),
              ),
            rewritten = recompute(book, variant);
          expect({ other, context: variant.context, ok: rewritten.ok }).toEqual({ other, context: variant.context, ok: consistent });
        }
        const declared = derive(ledger(), { ...spec, unit: other });
        if (other !== "bp" && canonicalUnit(other) === unit) expect(declared.row?.unit).toBe(unit);
        else expect({ other, error: declared.error }).toEqual({ other, error: "incompatible_operands" });
      }
    }
  });
  test("render precision follows invariant 5: sum, diff, a +/- expr root, and %p by decimal places; the rest by significant figures", () => {
    for (const { spec, precision } of VALID[op]) {
      const row = rowOf(derive(ledger(), spec)),
        ast = op === "expr" ? parseExpr(spec.formula) : null;
      expect({ spec, precision: renderPrecision(op, row.unit, ast) }).toEqual({ spec, precision: precision ?? PRECISION[op] });
    }
  });
  test("the malformed cases are exactly the registry's malformed shapes", () => {
    expect(MALFORMED[op].map((mutation) => mutation.name).sort()).toEqual([...OPERATION_RULES[op].malformed].sort());
  });
  test("operand identity: derive refuses a repeated operand id; only expr may repeat an id, and only inside its formula", () => {
    const spec = REPEATED[op],
      result = derive(ledger(), spec);
    if (op === "expr") {
      expect(rowOf(result).operands).toEqual(["F1", "F2"]);
      return;
    }
    expect({ error: result.error, detail: result.detail }).toEqual({
      error: "incompatible_operands",
      detail: expect.stringContaining("is repeated"),
    });
  });
  test("each malformed shape is ok:false for its own reason and never throws", () => {
    for (const { name, base, mutate, reason } of MALFORMED[op]) {
      const book = ledger(),
        row = rowOf(derive(book, base));
      let result = { ok: !0 };
      expect(() => {
        result = recompute(book, mutate(row, book));
      }).not.toThrow();
      expect({ name, ok: result.ok }).toEqual({ name, ok: !1 });
      expect(result).toMatchObject({ shape: expect.any(String), expected: expect.anything() });
      expect({ name, detail: result.detail }).toEqual({ name, detail: expect.stringContaining(reason) });
    }
  });
});
describe("units", () => {
  test("aliases canonicalize at input and composites cancel", () => {
    expect(canonicalUnit("pp")).toBe("%p");
    expect(canonicalUnit("bp")).toBe("%p");
    expect(canonicalUnit("kilometre")).toBe("km");
    expect(canonicalUnit("USD/(USD/person)")).toBe("person");
    expect(canonicalUnit("USD / kg")).toBe("USD/kg");
    expect(canonicalUnit("m/m")).toBeNull();
    expect(canonicalUnit(null)).toBeNull();
    expect(isAffine("C")).toBe(!0);
    expect(isAffine("F")).toBe(!0);
    expect(isAffine("m")).toBe(!1);
  });
  test("unit text with no registered alias is stored as given, inner whitespace kept", () => {
    expect(canonicalUnit("USD / million people")).toBe("USD/million people");
    for (const unit of ["million people", "metric ton", "USD per person"]) {
      expect(canonicalUnit(` ${unit} `)).toBe(unit);
      const book = emptyLedger();
      addRow(book, measured("F1", "5", unit));
      addRow(book, measured("F2", "7", unit));
      const row = rowOf(derive(book, { op: "sum", operands: ["F1", "F2"], unit }));
      expect(row).toMatchObject({ unit, render: `12 ${unit}` });
      expect(recompute(book, row)).toMatchObject({ ok: !0 });
    }
  });
  test("review r6 LOW 2: a scale word is never a unit atom; plain unit text that contains one is stored as given", () => {
    for (const unit of ["million", "M", "bn", "billion", "e6", "thousand", "USD/M", "million*person"]) {
      expect(() => canonicalUnit(unit)).toThrow("scale word");
      const book = emptyLedger();
      expect(() => addRow(book, measured("F1", "5", unit))).toThrow("scale word");
      addRow(book, measured("F1", "5", "m"));
      addRow(book, measured("F2", "7", "m"));
      book.rows[0].unit = unit;
      const result = derive(book, { op: "sum", operands: ["F1", "F2"], unit: "m" });
      expect({ unit, error: result.error, detail: result.detail }).toEqual({
        unit,
        error: "incompatible_operands",
        detail: expect.stringContaining("scale word"),
      });
    }
    expect(canonicalUnit("million people")).toBe("million people");
  });
  test("expectedUnit is the registry's answer for stored operand rows", () => {
    const book = ledger(),
      rows = (ids) => ids.map((id) => book.rows.find((row) => row.fact_id === id));
    expect(expectedUnit("diff", rows(["F3", "F4"]), {})).toBe("%p");
    expect(expectedUnit("ratio", rows(["F10", "F11"]), {})).toBe("person");
    expect(expectedUnit("convert", rows(["F12"]), { context: { target: "km" } })).toBe("km");
  });
  test("nested derived operands are verified recursively; a cycle is refused", () => {
    const book = ledger(),
      inner = rowOf(derive(book, { op: "sum", operands: ["F1", "F2"], unit: "m" })),
      outer = rowOf(derive(book, { op: "convert", operands: [inner.fact_id], to: "km" }));
    expect(recompute(book, outer).ok).toBe(!0);
    inner.exact = { num: "5", den: "1" };
    const tampered = recompute(book, outer);
    expect(tampered.ok).toBe(!1);
    expect(tampered.detail).toContain(String(inner.fact_id));
    const a = { ...inner, fact_id: "F90", label: "cycle-a", operands: ["F91", "F1"], exact: { num: "4", den: "1" } },
      b = { ...inner, fact_id: "F91", label: "cycle-b", operands: ["F90", "F1"], exact: { num: "4", den: "1" } };
    book.rows.push(a, b);
    let cycle = { ok: !0 };
    expect(() => {
      cycle = recompute(book, a);
    }).not.toThrow();
    expect(cycle.ok).toBe(!1);
    expect(cycle.detail).toContain("cycle");
    const through = derive(book, { op: "sum", operands: ["F90", "F2"], unit: "m" });
    expect({ error: through.error, detail: through.detail }).toEqual({
      error: "incompatible_operands",
      detail: expect.stringContaining("cycle"),
    });
    const self = { ...inner, fact_id: "F92", label: "self", operands: ["F92", "F1"] };
    book.rows.push(self);
    expect(recompute(book, self)).toMatchObject({ ok: !1, detail: expect.stringContaining("cites itself") });
    const onSelf = derive(book, { op: "convert", operands: ["F92"], to: "km" });
    expect({ error: onSelf.error, detail: onSelf.detail }).toEqual({
      error: "incompatible_operands",
      detail: expect.stringContaining("cites itself"),
    });
  });
});
