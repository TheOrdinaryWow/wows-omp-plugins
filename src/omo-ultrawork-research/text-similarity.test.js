// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import { similarity } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/text-similarity.mjs";

describe("similarity", () => {
  test("#given identical strings #when compared #then similarity is exactly 1", () => {
    expect(similarity("a", "a")).toBe(1);
    expect(similarity("", "")).toBe(1);
  });
  test("#given an OCR-noisy copy of a sentence #when compared #then similarity is at least 0.95", () => {
    const score = similarity(
      "The company reported revenue of 100 billion won in the third quarter of 2025.",
      "The  cornpany reported revenue of 100 bi1lion won in the third quarter of 2025. ",
    );
    expect(score).toBeGreaterThanOrEqual(0.95);
    expect(score).toBeLessThan(1);
  });
  test("#given NFD vs NFC and curly vs straight quotes #when compared #then normalization makes them equal", () => {
    expect(
      similarity("\u201C\uB9E4\uCD9C\uC740 \uB298\uC5C8\uB2E4\u201D".normalize("NFD"), '"\uB9E4\uCD9C\uC740 \uB298\uC5C8\uB2E4"'),
    ).toBe(1);
  });
  test("#given a different sentence #when compared #then similarity is below 0.8", () => {
    const score = similarity(
      "The company reported revenue of 100 billion won in the third quarter of 2025.",
      "Analysts expect margins to shrink next year as input costs keep rising.",
    );
    expect(score).toBeLessThan(0.8);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
