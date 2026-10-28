// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import { splitSentences } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/sentence-split.mjs";

function at(records, index) {
  const record = records[index];
  if (record === void 0) throw Error(`no sentence at index ${index}`);
  return record;
}
function expectSlices(text, records) {
  for (const record of records) expect(text.slice(record.start, record.end)).toBe(record.text);
}
describe("splitSentences", () => {
  test("#given a Korean paragraph with da/yo/nida endings #when split #then sids and offsets match each sentence", () => {
    const text =
        "\uB9E4\uCD9C\uC740 100\uC5B5 \uC6D0\uC785\uB2C8\uB2E4. \uBE44\uC6A9\uB3C4 \uB298\uC5C8\uC5B4\uC694. \uC774\uC775\uC740 \uC904\uC5C8\uB2E4.\uB2E4\uB9CC \uD68C\uBCF5\uC774 \uAE30\uB300\uB41C\uB2E4.",
      records = splitSentences(text);
    expect(records.map((r) => r.sid)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(records.map((r) => r.text)).toEqual([
      "\uB9E4\uCD9C\uC740 100\uC5B5 \uC6D0\uC785\uB2C8\uB2E4.",
      "\uBE44\uC6A9\uB3C4 \uB298\uC5C8\uC5B4\uC694.",
      "\uC774\uC775\uC740 \uC904\uC5C8\uB2E4.",
      "\uB2E4\uB9CC \uD68C\uBCF5\uC774 \uAE30\uB300\uB41C\uB2E4.",
    ]);
    expect(at(records, 1).start).toBe(text.indexOf("\uBE44\uC6A9\uB3C4"));
    expectSlices(text, records);
  });
  test("#given an English paragraph with abbreviations and decimals #when split #then e.g. and 3.2 do not end a sentence", () => {
    const text = "Use units, e.g. 3.2 m per bar. The next one follows! Is it fine? Yes.",
      records = splitSentences(text);
    expect(records.map((r) => r.sid)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(records.map((r) => r.text)).toEqual(["Use units, e.g. 3.2 m per bar.", "The next one follows!", "Is it fine?", "Yes."]);
    expect(at(records, 3).start).toBe(text.indexOf("Yes."));
    expect(at(records, 3).end).toBe(text.length);
    expectSlices(text, records);
  });
  test("#given line breaks and blank lines #when split #then each non-empty line yields its own record", () => {
    const text = `\uB9E4\uCD9C\uC740 100\uC5B5 \uC6D0\uC774\uB2E4. \uB2E4\uB9CC \uC544\uC9C1 \uD655\uC815\uB418\uC9C0 \uC54A\uC558\uB2E4.

  Second line without stop
Third?`,
      records = splitSentences(text);
    expect(records.map((r) => r.text)).toEqual([
      "\uB9E4\uCD9C\uC740 100\uC5B5 \uC6D0\uC774\uB2E4.",
      "\uB2E4\uB9CC \uC544\uC9C1 \uD655\uC815\uB418\uC9C0 \uC54A\uC558\uB2E4.",
      "Second line without stop",
      "Third?",
    ]);
    expect(records.map((r) => r.sid)).toEqual(["s1", "s2", "s3", "s4"]);
    expectSlices(text, records);
  });
  test("#given Korean quoted speech closed right after a da ending #when split #then the quote stays inside one sentence", () => {
    const single = '\uADF8\uB294 "\uB9E4\uCD9C\uC774 \uB298\uC5C8\uB2E4."\uB77C\uACE0 \uB9D0\uD588\uB2E4.',
      pair =
        '\uADF8\uB294 "\uB9E4\uCD9C\uC774 \uB298\uC5C8\uB2E4."\uB77C\uACE0 \uB9D0\uD588\uB2E4. \uB2E4\uC74C \uB0A0 \uB5A8\uC5B4\uC84C\uB2E4.',
      bracket = "\uADF8\uB294 \u300C\uC88B\uC544\uC694.\u300D\uB77C\uACE0 \uB2F5\uD588\uB2E4.",
      singleRecords = splitSentences(single),
      pairRecords = splitSentences(pair),
      bracketRecords = splitSentences(bracket);
    expect(singleRecords.map((r) => r.text)).toEqual([single]);
    expect(pairRecords.map((r) => r.text)).toEqual([
      '\uADF8\uB294 "\uB9E4\uCD9C\uC774 \uB298\uC5C8\uB2E4."\uB77C\uACE0 \uB9D0\uD588\uB2E4.',
      "\uB2E4\uC74C \uB0A0 \uB5A8\uC5B4\uC84C\uB2E4.",
    ]);
    expect(pairRecords.map((r) => r.sid)).toEqual(["s1", "s2"]);
    expect(at(pairRecords, 0).start).toBe(0);
    expect(at(pairRecords, 1).start).toBe(pair.indexOf("\uB2E4\uC74C \uB0A0"));
    expect(at(pairRecords, 1).end).toBe(pair.length);
    expect(bracketRecords.map((r) => r.text)).toEqual([bracket]);
    expectSlices(pair, pairRecords);
  });
  test("#given the word no #when split #then it is an abbreviation only before a number", () => {
    const answer = "The answer was no. Then we left.",
      numbered = "See No. 5 for details. Then stop.",
      answerRecords = splitSentences(answer),
      numberedRecords = splitSentences(numbered);
    expect(answerRecords.map((r) => r.text)).toEqual(["The answer was no.", "Then we left."]);
    expect(at(answerRecords, 1).start).toBe(answer.indexOf("Then"));
    expect(numberedRecords.map((r) => r.text)).toEqual(["See No. 5 for details.", "Then stop."]);
    expectSlices(answer, answerRecords);
    expectSlices(numbered, numberedRecords);
  });
  test("#given empty or whitespace-only text #when split #then no records are produced", () => {
    expect(splitSentences("")).toEqual([]);
    expect(
      splitSentences(` 
	
`),
    ).toEqual([]);
  });
});
