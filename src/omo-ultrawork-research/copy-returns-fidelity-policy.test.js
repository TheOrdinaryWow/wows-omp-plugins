// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FILL_INPUT_FORMAT_RULES,
  FILL_INPUT_FORMATS,
} from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-commands-fill.mjs";
import { FILL_FORMATS } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-fill.mjs";
import { KIND_RULES } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fact-ledger-kinds.mjs";
import { meaningCheckEnabled as briefMeaningCheckEnabled } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-brief.mjs";
import {
  FIDELITY_VALUE_RULES,
  meaningCheckEnabled,
  parseSourceFloor,
  policyErrors,
  SOURCE_FLOOR_RULES,
  sourceInsideFloor,
} from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/fidelity-policy.mjs";

const policyRow = (fact_id, kind, source_id, operands = []) => ({ fact_id, kind, status: "active", source_id, operands, derived_from: [] });
function floorRefusals(rows, ids, floor) {
  const found = ids.map((id, index) => ({ token: `{{${id}}}`, start: index, parsed: { id } }));
  return policyErrors(ids.map((id) => `{{${id}}}`).join(""), found, { rows }, tmpdir(), { derivedNone: false, floor }).errors.map(
    (error) => [error.code, error.message],
  );
}

import { pointedFlag } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/source-commands.mjs";

function briefWithFloor(floor) {
  const dir = mkdtempSync(join(tmpdir(), "policy-registry-")),
    lines = [
      "as of: latest at run start, 2026-10-23",
      "meaning check: on",
      `source floor: ${floor}`,
      "derived numbers: allowed",
      "languages: report en; sources en; quotes original",
      "identifier classes: none",
      "fallback: block-quote",
    ];
  writeFileSync(
    join(dir, "brief.md"),
    `## Fidelity
${lines
  .map((line) => `${line} (answered_by: default)`)
  .join(`
`)}
`,
  );
  return dir;
}
const floorOf = (text) => {
    const parsed = parseSourceFloor(text);
    if (parsed === null) throw Error(`parseSourceFloor(${text}) read no floor`);
    return parsed;
  },
  derivedRefusal = (kind) => {
    return policyErrors(
      "{{F1}}",
      [{ token: "{{F1}}", start: 0, parsed: { id: "F1" } }],
      { rows: [{ fact_id: "F1", kind, status: "active", source_id: null, operands: [], derived_from: [] }] },
      tmpdir(),
      { derivedNone: true, floor: null },
    ).errors.some((error) => error.code === "derived_not_allowed");
  };
describe("fidelity-policy registry: copies must not return", () => {
  test("#given every ledger kind #when derived numbers none refuses #then policyErrors agrees with FIDELITY_VALUE_RULES and assumed is refused", () => {
    const kinds = Object.keys(KIND_RULES);
    for (const kind of kinds)
      expect({ kind, refused: derivedRefusal(kind) }).toEqual({ kind, refused: FIDELITY_VALUE_RULES.derivedRefused(kind) });
    for (const kind of FIDELITY_VALUE_RULES.derivedKinds) expect(kinds).toContain(kind);
    expect(FIDELITY_VALUE_RULES.derivedRefused("assumed")).toBe(true);
  });
  test("#given each source floor form #when parsed #then the rule matches the registry and an unknown form is a usage error", () => {
    expect(parseSourceFloor("standard")).toBeNull();
    expect(parseSourceFloor("Primary Only")).toEqual({ kind: "primary" });
    expect(parseSourceFloor("pointed only: S4, https://a.example/x")).toEqual({ kind: "pointed", list: ["S4", "https://a.example/x"] });
    expect(parseSourceFloor("classes: example.com, gov.uk")).toEqual({ kind: "classes", list: ["example.com", "gov.uk"] });
    for (const rule of SOURCE_FLOOR_RULES) expect(Object.isFrozen(rule)).toBe(true);
    expect(() => parseSourceFloor("only nice sources")).toThrow(/source floor/);
  });
  test("#given pointed and classes floors #when evaluated #then ids, urls, hosts, and suffixes match and notexample.com does not", () => {
    const pointed = floorOf("pointed only: S4, https://a.example/x");
    expect(sourceInsideFloor(pointed, "S4", { url: null })).toBe(true);
    expect(sourceInsideFloor(pointed, "S9", { url: "https://a.example/x" })).toBe(true);
    expect(sourceInsideFloor(pointed, "S9", { url: "https://a.example/y" })).toBe(false);
    const classes = floorOf("classes: example.com");
    for (const [url, inside] of [
      ["https://example.com/a", true],
      ["https://docs.example.com/a", true],
      ["https://notexample.com/a", false],
      [null, false],
    ])
      expect({ url, inside: sourceInsideFloor(classes, "S1", { url }) }).toEqual({ url, inside });
    expect(sourceInsideFloor({ kind: "primary" }, "S1", { provenance: "primary" })).toBe(true);
    expect(sourceInsideFloor({ kind: "primary" }, "S1", { provenance: "secondary" })).toBe(false);
  });
  test("#given a brief floor #when pointedFlag reads it #then it agrees with parseSourceFloor for every form", () => {
    const url = "https://a.example/x";
    for (const floor of ["pointed only: S4, https://a.example/x", "pointed only: S4", "standard", "primary only", "classes: a.example"]) {
      const dir = briefWithFloor(floor);
      try {
        const rule = (() => {
          try {
            return parseSourceFloor(floor);
          } catch {
            return null;
          }
        })();
        expect({ floor, flag: pointedFlag(dir, url) }).toEqual({ floor, flag: rule?.kind === "pointed" && rule.list.includes(url) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  test("#given a malformed or pending floor #when pointedFlag reads it #then malformed is a usage error and pending is not pointed", () => {
    const malformed = briefWithFloor("not a floor"),
      pending = mkdtempSync(join(tmpdir(), "policy-registry-"));
    writeFileSync(
      join(pending, "brief.md"),
      `## Fidelity
source floor: pending (answered_by: pending)
`,
    );
    try {
      expect(() => pointedFlag(malformed, "https://a.example/x")).toThrow(/source floor "not a floor"/);
      expect(pointedFlag(pending, "https://a.example/x")).toBe(false);
    } finally {
      for (const dir of [malformed, pending]) rmSync(dir, { recursive: true, force: true });
    }
  });
  test("#given derived numbers and fallback values #when read #then only their table values pass, any case, and anything else names field and value", () => {
    expect(["none", "None", " none "].map((value) => FIDELITY_VALUE_RULES.derivedNone(value))).toEqual([true, true, true]);
    expect(["allowed", "Allowed"].map((value) => FIDELITY_VALUE_RULES.derivedNone(value))).toEqual([false, false]);
    for (const value of ["nope", "no", "n/a", "none.", "measured only"])
      expect(() => FIDELITY_VALUE_RULES.derivedNone(value)).toThrow(`derived numbers "${value}" is not allowed, none`);
    expect(["block-quote", "Omit"].map((value) => FIDELITY_VALUE_RULES.fallback(value))).toEqual(["quote", "omit"]);
    for (const value of ["drop", "omit sentence", "quote"])
      expect(() => FIDELITY_VALUE_RULES.fallback(value)).toThrow(`fallback "${value}" is not block-quote, omit`);
  });
  test("#given sourceless rows #when judged under a strict floor and under standard #then strict refuses each, a derived row over one included, and standard refuses none", () => {
    const rows = [
        policyRow("F1", "measured", "S1"),
        policyRow("A1", "assumed", null),
        policyRow("D1", "derived", null, ["F1", "A1"]),
        policyRow("D2", "derived", null, ["F9"]),
      ],
      ids = ["F1", "A1", "D1", "D2"];
    expect(floorRefusals(rows, ids, floorOf("pointed only: S1"))).toEqual([
      ["source_outside_floor", "A1 rests on no source, outside the source floor"],
      ["source_outside_floor", "D1 rests on no source, outside the source floor"],
      ["source_outside_floor", "D2 rests on no source, outside the source floor"],
    ]);
    expect(floorRefusals(rows, ids, parseSourceFloor("standard"))).toEqual([]);
  });
  test("#given the meaning check value rule #when read through the policy or the brief #then both are the same function", () => {
    expect(meaningCheckEnabled).toBe(briefMeaningCheckEnabled);
    for (const value of ["on", "off", "Off", "on; force strong: money", "offline"])
      expect({ value, on: FIDELITY_VALUE_RULES.meaningCheck(value) }).toEqual({
        value,
        on: meaningCheckEnabled({ fields: { "meaning check": value } }),
      });
  });
  test("#given the fill input vocabulary #when derived #then every input maps to a FILL_FORMATS member and every output format is reachable", () => {
    const target = (format) => FILL_INPUT_FORMAT_RULES.aliases[format] ?? format;
    for (const format of FILL_INPUT_FORMATS) expect(FILL_FORMATS).toContain(target(format));
    for (const format of FILL_FORMATS) expect(FILL_INPUT_FORMATS).toContain(format);
    for (const format of Object.values(FILL_INPUT_FORMAT_RULES.extensions)) expect(FILL_INPUT_FORMATS).toContain(format);
    expect(FILL_INPUT_FORMAT_RULES.aliases).toEqual({ tex: "md" });
  });
});
