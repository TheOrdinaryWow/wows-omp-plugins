// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import {
  convertFactor,
  dimensionOf,
  koreanReadingOf,
  normalizeUnit,
} from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/units.mjs";

describe("normalizeUnit", () => {
  test("ignores whitespace and spelling variants", () => {
    expect(normalizeUnit("\uC5B5 \uC6D0")).toBe(normalizeUnit("\uC5B5\uC6D0"));
    expect(normalizeUnit("\uC5B5\uC6D0")).not.toBeNull();
    expect(normalizeUnit("million")).toBe(normalizeUnit("M"));
    expect(normalizeUnit("USD")).toBe(normalizeUnit("$"));
    expect(normalizeUnit("\uB2EC\uB7EC")).toBe(normalizeUnit("USD"));
    expect(normalizeUnit("%")).not.toBe(normalizeUnit("%p"));
    expect(normalizeUnit("m")).not.toBe(normalizeUnit("M"));
    expect(normalizeUnit("furlongs")).toBeNull();
  });
  test("common measure suffixes read as units: mn, pct, hrs, yr(s), mo", () => {
    expect(normalizeUnit("mn")).toBe(normalizeUnit("M"));
    expect(normalizeUnit("pct")).toBe(normalizeUnit("%"));
    expect(normalizeUnit("hrs")).toBe(normalizeUnit("h"));
    expect(normalizeUnit("yrs")).toBe(normalizeUnit("yr"));
    expect(normalizeUnit("mo")).not.toBeNull();
    expect(convertFactor("yr", "mo")).toEqual({ num: 12n, den: 1n });
    expect(convertFactor("yr", "s")).toBeNull();
  });
  test("a normalized token normalizes to itself", () => {
    for (const raw of ["\uC5B5 \uC6D0", "m", "kg", "GB", "%p", "USD", "C", "F"]) {
      const token = normalizeUnit(raw);
      expect(normalizeUnit(token)).toBe(token);
    }
  });
});
describe("dimensionOf and convertFactor", () => {
  test("length, mass, time and data convert exactly", () => {
    expect(convertFactor("m", "mm")).toEqual({ num: 1000n, den: 1n });
    expect(convertFactor("mm", "m")).toEqual({ num: 1n, den: 1000n });
    expect(convertFactor("km", "cm")).toEqual({ num: 100000n, den: 1n });
    expect(convertFactor("kg", "t")).toEqual({ num: 1n, den: 1000n });
    expect(convertFactor("h", "s")).toEqual({ num: 3600n, den: 1n });
    expect(convertFactor("GB", "MB")).toEqual({ num: 1000n, den: 1n });
    expect(dimensionOf(normalizeUnit("cm"))).toBe("length");
  });
  test("the Korean currency scales convert within one currency", () => {
    expect(convertFactor("\uC5B5 \uC6D0", "\uC6D0")).toEqual({ num: 100000000n, den: 1n });
    expect(convertFactor("\uC870\uC6D0", "\uC5B5\uC6D0")).toEqual({ num: 10000n, den: 1n });
  });
  test("currency is never converted across currencies, and dimensions never mix", () => {
    expect(convertFactor("USD", "KRW")).toBeNull();
    expect(convertFactor("m", "kg")).toBeNull();
    expect(convertFactor("%", "%p")).toBeNull();
    expect(convertFactor("m", "furlongs")).toBeNull();
  });
  test("temperature is affine", () => {
    expect(convertFactor("C", "F")).toEqual({ num: 9n, den: 5n, offset: { num: 32n, den: 1n } });
    expect(convertFactor("F", "C")).toEqual({ num: 5n, den: 9n, offset: { num: -160n, den: 9n } });
  });
});
describe("koreanReadingOf", () => {
  const cases = [
    ["%", "open"],
    ["%p", "open"],
    ["m", "open"],
    ["km", "open"],
    ["\uC6D0", "closed"],
    ["\uB2EC\uB7EC", "open"],
    ["\uC720\uB85C", "open"],
    ["\uC5D4", "closed"],
    ["\uBC30", "open"],
    ["\uAC74", "closed"],
    ["\uBA85", "closed"],
    ["\uC870", "open"],
    ["\uC5B5", "closed"],
    ["\uB9CC", "closed"],
    ["\uCC9C", "closed"],
    ["kg", "closed"],
    ["GB", "open"],
  ];
  for (const [raw, reading] of cases)
    test(`${raw} reads ${reading}`, () => {
      expect(koreanReadingOf(raw)).toBe(reading);
    });
  test("unknown units have no reading", () => {
    expect(koreanReadingOf("furlongs")).toBeNull();
  });
});
