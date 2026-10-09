import { describe, expect, test } from "bun:test";

import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";

import { containsHostKeyword, detectPointers, detectUltrawork, hasEmbeddedDirective } from "../plugins/omo-ultrawork/src/keywords.ts";
import { triggersOrchestrate } from "../plugins/omo-ultrawork/src/orchestrate.ts";

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

describe("orchestrate conflict detection", () => {
  const settings =
    (overrides: Record<string, boolean> = {}) =>
    (id: string) =>
      overrides[id] ?? true;

  test("agrees with the host's magic-keyword matcher", () => {
    const samples = [
      "ulw orchestrate the migration",
      "orchestrate, then ship",
      '"orchestrate" it',
      "ulw `orchestrate` it",
      "``a `orchestrate` b``",
      "```\norchestrate\n```\nulw",
      "~~~\norchestrate\n~~~",
      "ulw orchestrated it",
      "ulw Orchestrate it",
      "ulw orchestrate.ts",
      "foo::orchestrate",
      "orchestrate() now",
      "src/orchestrate here",
      "re-orchestrate",
      "<!-- orchestrate --> ulw",
      "<note>orchestrate</note> ulw",
      "<br> orchestrate",
      "a < b orchestrate",
    ];
    for (const text of samples) {
      expect({ text, match: containsHostKeyword(text, "orchestrate") }).toEqual({ text, match: containsMagicKeyword(text, "orchestrate") });
    }
  });

  test("requires the host to recognize orchestrate in the message", () => {
    expect(triggersOrchestrate("ulw orchestrate the migration", ["task"], settings())).toBe(true);
    expect(triggersOrchestrate("ulw `orchestrate` it", ["task"], settings())).toBe(false);
  });

  test("ignores orchestrate when the host keyword is disabled or task is inactive", async () => {
    const text = "ulw orchestrate the migration";
    expect(await triggersOrchestrate(text, [], settings())).toBe(false);
    expect(await triggersOrchestrate(text, ["task"], settings({ "magicKeywords.orchestrate": false }))).toBe(false);
    expect(await triggersOrchestrate(text, ["task"], settings({ "magicKeywords.enabled": false }))).toBe(false);
  });
});
