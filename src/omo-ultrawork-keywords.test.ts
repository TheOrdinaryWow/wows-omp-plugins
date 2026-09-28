import { describe, expect, test } from "bun:test";

import { detectPointers, detectUltrawork, hasEmbeddedDirective } from "../plugins/omo-ultrawork/src/keywords.ts";

describe("ultrawork keyword detection", () => {
  test("recognizes standalone triggers without matching longer identifiers", () => {
    expect(detectUltrawork("ulw say hi")).toBe(true);
    expect(detectUltrawork("ULTRAWORK now")).toBe(true);
    expect(detectUltrawork("ulwmode and my_ulw_var")).toBe(false);
  });
  test("uses configured whole-word triggers and escapes regex punctuation", () => {
    expect(detectUltrawork("ulw", ["focus", "c++"])).toBe(false);
    expect(detectUltrawork("FOCUS now", ["focus", "c++"])).toBe(true);
    expect(detectUltrawork("c++ now", ["focus", "c++"])).toBe(true);
    expect(detectUltrawork("myfocus_var", ["focus"])).toBe(false);
    expect(detectUltrawork("`focus` then act", ["focus"])).toBe(false);
    expect(detectUltrawork("focus", [])).toBe(false);
  });

  test("ignores paired directive, reminder, pointer, inline code, and fenced text", () => {
    expect(detectUltrawork("explain `ulw` today")).toBe(false);
    expect(detectUltrawork("```ts\nulw\n```\nnormal text")).toBe(false);
    expect(detectUltrawork("~~~ts\nulw\n~~~\nnormal text")).toBe(false);
    expect(detectUltrawork("<ultrawork-mode>ulw</ultrawork-mode>")).toBe(false);
    expect(detectUltrawork("<omo-ultrawork-reminder>ulw</omo-ultrawork-reminder>")).toBe(false);
    expect(detectUltrawork("<omo-mass-ulw-pointer>ulw</omo-mass-ulw-pointer>")).toBe(false);
    expect(detectUltrawork("a `ulw` b ulw")).toBe(true);
    expect(detectUltrawork("ul`quoted`w")).toBe(false);
    expect(detectPointers("mass`quoted`ulw")).toEqual([]);
  });

  test("requires both directive tags before treating input as an embedded directive", () => {
    expect(hasEmbeddedDirective("<ultrawork-mode>text</ultrawork-mode>")).toBe(true);
    expect(hasEmbeddedDirective("<ultrawork-mode> text only")).toBe(false);
    expect(hasEmbeddedDirective("no directive")).toBe(false);
  });

  test("detects only the supported mass-ulw pointer, outside quoted regions", () => {
    for (const text of ["mass ulw", "mass-ulw", "mulw", "meth", "ulw-mass"]) {
      expect(detectPointers(text)).toEqual(["mass-ulw"]);
    }
    expect(detectPointers("ulw")).toEqual([]);
    expect(detectPointers("`mulw`\n~~~\nmeth\n~~~")).toEqual([]);
  });
});
