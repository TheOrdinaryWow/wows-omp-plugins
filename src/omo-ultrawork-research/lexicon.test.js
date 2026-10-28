// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import {
  CAUSAL,
  CONCESSIVE,
  DIRECTION,
  HEDGES,
  NEGATION,
  QUALIFIERS,
  SCOPE_NARROW_TO_BROAD,
} from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/lexicon.mjs";

const LISTS = { HEDGES, QUALIFIERS, CAUSAL, CONCESSIVE, NEGATION, SCOPE_NARROW_TO_BROAD };
describe("lexicon", () => {
  test("given each exported list when read then it is non-empty and frozen", () => {
    for (const [name, list] of Object.entries(LISTS)) {
      expect({ name, length: list.length > 0 }).toEqual({ name, length: true });
      expect({ name, frozen: Object.isFrozen(list) }).toEqual({ name, frozen: true });
    }
    expect(Object.isFrozen(DIRECTION)).toBe(true);
    expect(Object.isFrozen(DIRECTION.up)).toBe(true);
    expect(Object.isFrozen(DIRECTION.down)).toBe(true);
    for (const pair of SCOPE_NARROW_TO_BROAD) expect(Object.isFrozen(pair)).toBe(true);
  });
  test("given HEDGES when read then it carries the named English and Korean hedges", () => {
    const english = ["estimated", "about", "approximately", "may", "might", "expected", "forecast", "provisional", "not yet"],
      korean = [
        "\uCD94\uC815",
        "\uC57D",
        "\uAC00\uB2A5",
        "\uC804\uB9DD",
        "\uC608\uC0C1",
        "\uC7A0\uC815",
        "\uC544\uC9C1",
        "\uBBF8\uD655\uC815",
        "\uAC83\uC73C\uB85C \uBCF4\uC778\uB2E4",
      ];
    expect(HEDGES).toEqual(expect.arrayContaining([...english, ...korean]));
  });
  test("given QUALIFIERS when read then it is exactly the closed bilingual list", () => {
    const korean = [
        "\uCD5C\uB300",
        "\uCD5C\uC18C",
        "\uC57D",
        "\uC774\uC0C1",
        "\uC774\uD558",
        "\uBBF8\uB9CC",
        "\uCD08\uACFC",
        "\uB0B4\uC678",
        "\uAE4C\uC9C0",
      ],
      english = ["up to", "at least", "at most", "about", "approximately", "nearly", "over", "under", "more than", "less than"];
    expect([...QUALIFIERS].sort()).toEqual([...korean, ...english].sort());
  });
  test("given DIRECTION when read then up and down carry both languages", () => {
    expect(DIRECTION.up).toEqual(expect.arrayContaining(["\uC99D\uAC00", "\uC0C1\uC2B9", "\uB298", "increase", "rise", "grow", "up"]));
    expect(DIRECTION.down).toEqual(
      expect.arrayContaining(["\uAC10\uC18C", "\uD558\uB77D", "\uC904", "decrease", "fall", "decline", "down"]),
    );
  });
  test("given CAUSAL, CONCESSIVE and NEGATION when read then they carry the named connectives", () => {
    expect(CAUSAL).toEqual(
      expect.arrayContaining([
        "because",
        "due to",
        "leads to",
        "results in",
        "causes",
        "therefore",
        "\uB54C\uBB38\uC5D0",
        "\uB85C \uC778\uD574",
        "\uB530\uB77C\uC11C",
        "\uADF8\uB798\uC11C",
        "\uCD08\uB798",
      ]),
    );
    expect(CONCESSIVE).toEqual(
      expect.arrayContaining([
        "although",
        "but",
        "however",
        "despite",
        "while",
        "\uC73C\uB098",
        "\uC9C0\uB9CC",
        "\uC5D0\uB3C4 \uBD88\uAD6C\uD558\uACE0",
        "\uBC18\uBA74",
        "\uC640 \uB2EC\uB9AC",
      ]),
    );
    expect(NEGATION).toEqual(expect.arrayContaining(["not", "no", "never", "\uC54A", "\uC5C6", "\uBABB"]));
  });
  test("given SCOPE_NARROW_TO_BROAD when read then it carries the named narrow-to-broad pairs", () => {
    expect(SCOPE_NARROW_TO_BROAD).toEqual(
      expect.arrayContaining([
        ["\uBD81\uBBF8", "\uC804 \uC138\uACC4"],
        ["pilot", "system"],
        ["one region", "all regions"],
        ["\uC77C\uBD80", "\uC804\uCCB4"],
        ["\uD55C \uC9C0\uC5ED", "\uC804\uAD6D"],
      ]),
    );
  });
});
