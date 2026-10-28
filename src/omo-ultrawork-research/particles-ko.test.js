// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import { finalReading, rewriteParticle } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/particles-ko.mjs";

describe("finalReading", () => {
  test("given a value ending in a Hangul syllable when read then the final consonant decides", () => {
    expect(finalReading("3\uC870 8,000\uC5B5 \uC6D0", null)).toBe("closed");
    expect(finalReading("5\uC870", null)).toBe("open");
    expect(finalReading("7\uB2EC", null)).toBe("l");
  });
  test("given a value ending in a unit token when read then the unit's Korean reading decides", () => {
    expect(finalReading("15.2%", null)).toBe("open");
    expect(finalReading("3.1%p", null)).toBe("open");
    expect(finalReading("320 m", null)).toBe("open");
    expect(finalReading("12 kg", null)).toBe("closed");
  });
  test("given a value ending in a digit when read then the Sino-Korean reading decides", () => {
    expect(finalReading("4,200", null)).toBe("closed");
    expect(finalReading("1", null)).toBe("l");
    expect(finalReading("2", null)).toBe("open");
    expect(finalReading("3", null)).toBe("closed");
    expect(finalReading("7", null)).toBe("l");
    expect(finalReading("8", null)).toBe("l");
    expect(finalReading("9", null)).toBe("open");
    expect(finalReading("6.5", null)).toBe("open");
  });
  test("given an integer whose spoken end is jo when read then the magnitude decides, not the last zero", () => {
    expect(finalReading("1000000000000", null)).toBe("open");
    expect(finalReading("10,000", null)).toBe("closed");
  });
  test("given a round integer past one jo when read then the last 10^4 group word decides, not sip/baek/cheon", () => {
    expect(finalReading("10000000000000", null)).toBe("open");
    expect(finalReading("100000000000000", null)).toBe("open");
    expect(finalReading("1000000000000000", null)).toBe("open");
    expect(finalReading("100000", null)).toBe("closed");
    expect(finalReading("1000000000", null)).toBe("closed");
  });
  test("given an explicit unit token when read then it overrides the value text", () => {
    expect(finalReading("15.2", "%")).toBe("open");
    expect(finalReading("15", "kg")).toBe("closed");
  });
  test("given an unknown trailing token when read then no reading is claimed", () => {
    expect(finalReading("12 zorks", null)).toBeNull();
  });
});
describe("rewriteParticle", () => {
  test("given an object particle with a boundary after an open value when rewritten then it becomes the open form", () => {
    expect(rewriteParticle("\uC744 \uAE30\uB85D", "open")).toEqual({ text: "\uB97C \uAE30\uB85D", applied: true, candidate: true });
  });
  test("given a bare particle at end of string when rewritten then it is applied", () => {
    expect(rewriteParticle("\uC740", "open")).toEqual({ text: "\uB294", applied: true, candidate: true });
  });
  test("given a particle-like prefix with no boundary when rewritten then it stays untouched and is flagged as a candidate", () => {
    expect(rewriteParticle("\uC774\uC0C1 \uAE30\uB85D", "closed")).toEqual({
      text: "\uC774\uC0C1 \uAE30\uB85D",
      applied: false,
      candidate: true,
    });
    expect(rewriteParticle("\uC774\uC0C1.", "open")).toEqual({ text: "\uC774\uC0C1.", applied: false, candidate: true });
  });
  test("given English or a non-particle word when rewritten then nothing changes and it is not a candidate", () => {
    expect(rewriteParticle(" is the span", "open")).toEqual({ text: " is the span", applied: false, candidate: false });
    expect(rewriteParticle("\uAE30\uB85D\uD588\uB2E4", "open")).toEqual({
      text: "\uAE30\uB85D\uD588\uB2E4",
      applied: false,
      candidate: false,
    });
  });
  test("given each particle pair when rewritten then the reading picks the form", () => {
    expect(rewriteParticle("\uC774 \uC62C\uB790\uB2E4", "open").text).toBe("\uAC00 \uC62C\uB790\uB2E4");
    expect(rewriteParticle("\uAC00 \uC62C\uB790\uB2E4", "closed").text).toBe("\uC774 \uC62C\uB790\uB2E4");
    expect(rewriteParticle("\uB294,", "l").text).toBe("\uC740,");
    expect(rewriteParticle("\uACFC \uD568\uAED8", "open").text).toBe("\uC640 \uD568\uAED8");
    expect(rewriteParticle("\uC640 \uD568\uAED8", "l").text).toBe("\uACFC \uD568\uAED8");
    expect(rewriteParticle("\uB85C \uB298\uC5C8\uB2E4", "closed").text).toBe("\uC73C\uB85C \uB298\uC5C8\uB2E4");
    expect(rewriteParticle("\uC73C\uB85C \uB298\uC5C8\uB2E4", "l").text).toBe("\uB85C \uB298\uC5C8\uB2E4");
    expect(rewriteParticle("\uC73C\uB85C \uB298\uC5C8\uB2E4", "open").text).toBe("\uB85C \uB298\uC5C8\uB2E4");
  });
  test("given no reading when rewritten then a candidate is left unchanged", () => {
    expect(rewriteParticle("\uC744 \uAE30\uB85D", null)).toEqual({ text: "\uC744 \uAE30\uB85D", applied: false, candidate: true });
  });
});
