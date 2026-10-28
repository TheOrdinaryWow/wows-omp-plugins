// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import { findNormalized, normalizeText, tokenize } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/text-normalize.mjs";

describe("normalizeText", () => {
  test("#given NFD and NFC Korean #when normalized #then both are equal NFC strings", () => {
    const nfc = "\uB9E4\uCD9C\uC740 \uD55C\uAD6D\uC5B4\uB85C \uC801\uC5C8\uB2E4",
      nfd = nfc.normalize("NFD"),
      a = normalizeText(nfd),
      b = normalizeText(nfc);
    expect(nfd).not.toBe(nfc);
    expect(a).toBe(b);
    expect(a).toBe(nfc);
  });
  test("#given curly and CJK quote glyphs #when normalized #then they become straight quotes", () => {
    const out = normalizeText("\u201Cgrowth\u201D \u2018ok\u2019 \u300Cquoted\u300D \u300Etitle\u300F \xABfr\xBB");
    expect(out).toBe(`"growth" 'ok' "quoted" "title" "fr"`);
  });
  test("#given runs of mixed whitespace #when normalized #then they collapse to single spaces and are trimmed", () => {
    const out = normalizeText(`  a 	
 b\xA0\xA0c  `);
    expect(out).toBe("a b c");
  });
});
describe("tokenize", () => {
  test("#given Latin words and Hangul eojeol with punctuation #when tokenized #then tokens split on whitespace and punctuation", () => {
    const tokens = tokenize("Revenue rose, \uB9E4\uCD9C\uC740 100\uC5B5 \uC6D0\uC774\uB2E4. (\u201Cok\u201D)");
    expect(tokens).toEqual(["Revenue", "rose", "\uB9E4\uCD9C\uC740", "100\uC5B5", "\uC6D0\uC774\uB2E4", "ok"]);
  });
});
describe("findNormalized", () => {
  test("#given raw text with double spaces and curly quotes #when a straight-quoted needle is found #then RAW offsets slice back to the raw substring", () => {
    const hay = `He said  \u201Cgrowth  is
 strong\u201D  today.`,
      hit = findNormalized(hay, '"growth is strong"');
    if (hit === null) throw Error("needle not found");
    expect(hay.slice(hit.start, hit.end)).toBe(`\u201Cgrowth  is
 strong\u201D`);
  });
  test("#given NFD Korean raw text with double spaces #when an NFC needle is found #then RAW offsets slice the NFD substring", () => {
    const hay = "\uC55E \uBB38\uC7A5. \uB9E4\uCD9C\uC740  100\uC5B5 \uC6D0\uC774\uB2E4. \uB05D".normalize("NFD"),
      expected = "\uB9E4\uCD9C\uC740  100\uC5B5 \uC6D0\uC774\uB2E4".normalize("NFD"),
      hit = findNormalized(hay, "\uB9E4\uCD9C\uC740 100\uC5B5 \uC6D0\uC774\uB2E4");
    if (hit === null) throw Error("needle not found");
    expect(hay.slice(hit.start, hit.end)).toBe(expected);
  });
  test("#given a needle absent from the text #when searched #then null is returned", () => {
    expect(findNormalized("abc", "zzz")).toBeNull();
    expect(findNormalized("abc", "   ")).toBeNull();
  });
});
