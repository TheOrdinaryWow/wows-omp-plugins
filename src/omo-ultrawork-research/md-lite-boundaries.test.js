// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import { parseMarkdown } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/md-lite.mjs";
import { parseNumeral } from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/numerals.mjs";

describe("Markdown list continuation boundaries", () => {
  test("#given a continuation after a list item #when parsed #then a later marker stays paragraph text", () => {
    const text = `1. a
continued
2. b`,
      { blocks } = parseMarkdown(text);
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ["list_item", "a"],
      [
        "paragraph",
        `continued
2. b`,
      ],
    ]);
  });
  test("#given numbers beside a list continuation #when parsed #then fidelity numerals retain source offsets", () => {
    const text = `1. a 12%
continued
2. b 34%`,
      { blocks } = parseMarkdown(text),
      found = blocks.flatMap((block) => {
        const numerals = [];
        for (let numeral = parseNumeral(block.text); numeral; numeral = parseNumeral(block.text, numeral.span[1])) {
          const [start, end] = numeral.span;
          numerals.push([numeral.value, text.slice(block.start + start, block.start + end)]);
        }
        return numerals;
      });
    expect(found).toEqual([
      ["12", "12%"],
      ["2", "2"],
      ["34", "34%"],
    ]);
  });
});
describe("Markdown closing fence indentation", () => {
  test.each(["```", "~~~"])("#given a four-space %s closing candidate #when parsed #then the code runs to EOF", (fence) => {
    const text = `${fence}
code 12
    ${fence}
claim 34`,
      { blocks, problems } = parseMarkdown(text);
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      [
        "code",
        `code 12
    ${fence}
claim 34`,
      ],
    ]);
    expect(problems).toEqual([{ code: "unterminated_fence", line: 1, start: 0 }]);
  });
  test.each([0, 1, 2, 3])("#given a closing fence indented %s spaces #when parsed #then later prose is outside code", (spaces) => {
    const { blocks, problems } = parseMarkdown(`\`\`\`
code
${" ".repeat(spaces)}\`\`\`
claim 34`);
    expect(blocks.map((block) => block.kind)).toEqual(["code", "paragraph"]);
    expect(problems).toEqual([]);
  });
});
