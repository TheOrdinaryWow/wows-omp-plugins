// Repository-only tests ported from oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace; they model Impeccable detector fixture cases.
// Licenses: Sustainable Use License 1.0 (../../../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { expect, test } from "bun:test";

import { overusedFont } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/overused-font";
import { checkSource } from "../../../../plugins/omo-toolkit/skills/frontend/scripts/detect/rules/source/support/check-source";

test.each([
  ["font-family: 'Inter', sans-serif;", 1],
  ["font-family: 'Instrument Serif';", 1],
  ['@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400");', 1],
  ["font-family: Georgia, serif;", 0],
  ["/* font-family: Inter; */", 0],
  ['@import url("https://fonts.googleapis.com/css?family=DM+Sans:400|Inter:400");', 1],
  ["const A = styled.div`/* font-family: Inter */ font-family: Georgia;`", 0],
])("#given font source %s #then returns %i findings", (source, count) => {
  expect(checkSource(overusedFont, source)).toHaveLength(count);
});

test("#given a case-insensitive allowed font #then suppresses only that family", () => {
  expect(
    checkSource(overusedFont, ".a{font-family: Inter}\n.b{font-family: Roboto}", { path: "a.css", config: { allowFonts: ["INTER"] } }),
  ).toHaveLength(1);
  const source = '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400&family=Roboto:wght@400");';
  expect(checkSource(overusedFont, source, { config: { allowFonts: ["INTER"] } })[0]?.message).toBe("Google Fonts: roboto");
});
