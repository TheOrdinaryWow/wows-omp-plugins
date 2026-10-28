// Behavioral tests ported from oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0; see /plugins/omo-ultrawork/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";

import {
  customProperties,
  fontFamilies,
  hexColors,
  mediaBreakpoints,
  normalizeHex,
  resolveVar,
  scanRules,
} from "../../plugins/omo-ultrawork/assets/ulw-research/scripts/css-lite.mjs";

const THEMED_CSS = `
/* tokens */
:root { --bg: #FAF6EF; --fg: #24211b; --accent: #c2410c; --ff: -apple-system, "Noto Sans KR", sans-serif; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0c0b0a; --fg: #fbf0df; }
}
html[data-theme="dark"] { --bg: #0c0b0a; --fg: #fbf0df; --accent: #f8b878; }
html[data-theme="light"] { --bg: #faf6ef; }
body { font-family: var(--ff); color: var(--fg); }
`;
describe("scanRules", () => {
  test("#given a minified one-line stylesheet with nested @media #when scanned #then every style rule is returned in source order", () => {
    const rules = scanRules("a{color:#fff}@media screen{@media (max-width:640px){.b{margin:0;padding:1px}.c{top:0}}}.d{left:0}");
    expect(rules.map((rule) => rule.selector)).toEqual(["a", ".b", ".c", ".d"]);
    expect(rules[1].atRule).toBe("@media screen @media (max-width:640px)");
    expect(rules[1].declarations).toEqual([
      { prop: "margin", value: "0" },
      { prop: "padding", value: "1px" },
    ]);
    expect(rules[0].atRule).toBeUndefined();
  });
  test("#given an unbalanced brace #when scanned #then the rules parsed so far are returned without throwing", () => {
    const rules = scanRules(".a{color:red}.b{color:blue}@media (min-width:1px){.c{top:0}.d{left:0");
    expect(rules.map((rule) => rule.selector)).toEqual([".a", ".b", ".c"]);
  });
  test("#given a stray closing brace and a top-level @import #when scanned #then both are ignored", () => {
    const rules = scanRules('@import url("x.css");}.a{color:red}');
    expect(rules).toEqual([{ selector: ".a", declarations: [{ prop: "color", value: "red" }] }]);
  });
  test("#given braces and semicolons inside strings, url() and comments #when scanned #then declarations stay intact", () => {
    const rules = scanRules('/* .x{} */.q::before{content:"};{";background:url(data:image/svg+xml;base64,AAA=)}');
    expect(rules).toHaveLength(1);
    expect(rules[0].declarations).toEqual([
      { prop: "content", value: '"};{"' },
      { prop: "background", value: "url(data:image/svg+xml;base64,AAA=)" },
    ]);
  });
  test("#given @font-face and @keyframes #when scanned #then font-face is a rule and keyframe steps carry the at-rule", () => {
    const rules = scanRules("@font-face{font-family:Pretendard;src:url(p.woff2)}@keyframes spin{from{opacity:0}to{opacity:1}}");
    expect(rules.map((rule) => rule.selector)).toEqual(["@font-face", "from", "to"]);
    expect(rules[1].atRule).toBe("@keyframes spin");
  });
  test("#given non-string input #when scanned #then an empty list is returned", () => {
    expect(scanRules(void 0)).toEqual([]);
  });
});
describe("customProperties", () => {
  test("#given a light and dark themed sample #when read #then both maps are returned", () => {
    const props = customProperties(THEMED_CSS);
    expect(props.light.get("--bg")).toBe("#faf6ef");
    expect(props.light.get("--accent")).toBe("#c2410c");
    expect(props.light.get("--ff")).toBe('-apple-system, "Noto Sans KR", sans-serif');
    expect(props.dark.get("--bg")).toBe("#0c0b0a");
    expect(props.dark.get("--fg")).toBe("#fbf0df");
    expect(props.dark.get("--accent")).toBe("#f8b878");
    expect(props.light.size).toBe(4);
    expect(props.dark.size).toBe(3);
  });
  test("#given custom properties on a component selector #when read #then they are not global tokens", () => {
    expect(customProperties(".card{--pad:4px}").light.size).toBe(0);
  });
});
describe("fontFamilies", () => {
  test("#given font-family, var() and font shorthand #when read #then families are split, unquoted and resolved", () => {
    const css = `${THEMED_CSS} code { font: 14px/1.5 ui-monospace, 'SFMono-Regular', monospace; } h1 { font-weight: 700; }`,
      fonts = fontFamilies(css);
    expect(fonts).toEqual([
      { selector: "body", families: ["-apple-system", "Noto Sans KR", "sans-serif"] },
      { selector: "code", families: ["ui-monospace", "SFMono-Regular", "monospace"] },
    ]);
  });
});
describe("hexColors / normalizeHex", () => {
  test("#given short, alpha and uppercase hex #when normalized #then six lowercase digits are returned", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#abcd")).toBe("#aabbcc");
    expect(normalizeHex("#AABBCC80")).toBe("#aabbcc");
    expect(normalizeHex("#12345")).toBeNull();
  });
  test("#given text with hex colors, entities and ids #when scanned #then only colors are returned with repeats", () => {
    const colors = hexColors("color:#FFF; fill: #fff; stroke:#c2410c80; &#123; #fade-in #s1 #abcdefg");
    expect(colors).toEqual(["#ffffff", "#ffffff", "#c2410c"]);
  });
});
describe("mediaBreakpoints", () => {
  test("#given max-width and min-width queries #when read #then px values are returned sorted", () => {
    expect(mediaBreakpoints("@media (max-width:640px){} @media (min-width: 1024px){}")).toEqual([640, 1024]);
  });
  test("#given duplicates, range syntax and non-width queries #when read #then unique widths only", () => {
    expect(mediaBreakpoints("@media (width <= 560px){} @media print{} @media (max-width:640px) and (min-width:560px){}")).toEqual([
      560, 640,
    ]);
  });
});
describe("resolveVar", () => {
  test("#given nested var() with fallbacks #when resolved #then known names resolve and unknown ones keep their text", () => {
    const props = new Map([
      ["--a", "var(--b)"],
      ["--b", "#123456"],
    ]);
    expect(resolveVar("1px solid var(--a)", props)).toBe("1px solid #123456");
    expect(resolveVar("var(--missing, var(--b))", props)).toBe("#123456");
    expect(resolveVar("var(--missing)", props)).toBe("var(--missing)");
    expect(resolveVar("var(--x)", { "--x": "red" })).toBe("red");
  });
  test("#given a self-referencing variable #when resolved #then it terminates", () => {
    expect(typeof resolveVar("var(--loop)", new Map([["--loop", "var(--loop)"]]))).toBe("string");
  });
});
