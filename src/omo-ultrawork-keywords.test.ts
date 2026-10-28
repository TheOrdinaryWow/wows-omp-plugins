import { describe, expect, test } from "bun:test";

import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";

import {
  containsHostKeyword,
  detectPointers,
  detectUltrawork,
  hasEmbeddedDirective,
  type Pointer,
  type PointerTarget,
} from "../plugins/omo-ultrawork/src/keywords.ts";
import { triggersOrchestrate } from "../plugins/omo-ultrawork/src/orchestrate.ts";

const mention = (target: PointerTarget): Pointer => ({ target, intent: "mention" });
const binding = (target: PointerTarget): Pointer => ({ target, intent: "binding" });

function expectArms(texts: readonly string[], armed: boolean, keywords?: readonly string[]): void {
  for (const text of texts) expect({ text, armed: detectUltrawork(text, keywords) }).toEqual({ text, armed });
}

function expectPointers(cases: ReadonlyArray<readonly [string, readonly Pointer[]]>): void {
  for (const [text, pointers] of cases) expect({ text, pointers: detectPointers(text) }).toEqual({ text, pointers: [...pointers] });
}

describe("ultrawork keyword detection", () => {
  test("arms on the keyword as a word of its own, including chained workflow names", () => {
    const requests = [
      "ulw say hi",
      "ulw fix it",
      "ULTRAWORK now",
      "ulw-loop",
      "ulw-loop fix the flaky test",
      "ulw-plan.",
      "ulw-plan the migration",
      "can you ulw this refactor for me",
      "ulw fix src/foo.ts",
      "이거 끝까지 해줘 ulw",
    ];
    expectArms(requests, true);
  });

  test("does not arm on identifiers, file names, paths, or slash commands", () => {
    const references = [
      "ulwmode and my_ulw_var",
      "ulw_helper.ts",
      "v1.ulw",
      "see .omo/ulw/",
      "write the result to .omo/ulw/browser-gaps/notes.md",
      "open ulw-plan.md and summarize it",
      "summarize ulw.md",
      "what happened in the mass-ulw-refactor session",
      "the senpi-ulw-loop lane finished",
      "the mass-ulw-loop-runner session finished",
      "what happened in the ulw-plan-refactor session",
      "branch fix/ulw-plan-gate has the change",
      "the ulw-research_v2 file",
      "C:\\work\\ulw\\notes.txt",
      "ulw\\notes",
      "/ulw-plan",
      "/ulw-plan draft the migration",
      "mass-ulw the migration",
      "meth ship the docs refresh",
    ];
    expectArms(references, false);
  });

  test("does not arm on quoted, relayed, linked, or prohibited mentions", () => {
    const mentions = [
      '"ulw"',
      "'ulw-loop'",
      "\u201Culw\u201D",
      "\u2018ulw\u2019",
      'the bug: a message that says "please ulw this" arms the directive',
      "> ulw this",
      "[REPORT] lane | done | the executor quoted ulw",
      "[lead via coordinator -> lane, PR#1] fold both findings, then ulw the delta",
      "Lead (main) to lane: ulw this",
      "Lead (main), lane: ulw this",
      "see https://example.com/search?q=ulw&page=2",
      "file:///tmp/ulw/notes",
      "Do not use ulw",
      "Don't use ulw for this, just answer",
      "never run ulw-loop, ultrawork, or any skill here",
      "never arm ulw, mulw",
    ];
    expectArms(mentions, false);
  });

  test("recognizes the user's own request beside a masked mention", () => {
    const requests = [
      "> ulw-loop the migration\nulw fix it",
      "[step 1 -> step 2] ulw fix it",
      "check .omo/ulw/notes.md, then ulw the fix",
      "see https://example.com/ulw?q=1, then ulw the fix",
      "I don't think it's done, ulw the rest",
      "Don't use tmux. ulw this",
      "do not stop until done, ulw",
      "Do not use tmux, but ulw the fix",
      "Do not use tmux then ulw the fix",
      "Do not use tmux - ulw the fix",
      "don\u2019t use tmux \u2014 ulw this",
      "never mind, ulw this",
      "don't run the old one; ulw the new one",
    ];
    expectArms(requests, true);
  });

  test("applies the same guards to configured literals without a trailing word boundary", () => {
    const keywords = ["focus", "c++"];
    expectArms(["FOCUS now", "c++ now", "write it in c++.", "c++, then ship"], true, keywords);
    const guarded = ["ulw", "myfocus_var", "v2.focus now", "focus/notes", "abc++ now", "use lib/c++ headers", "include c++.h"];
    expectArms([...guarded, '"c++" is quoted', "Do not use c++"], false, keywords);
    expectArms(["`focus` then act"], false, ["focus"]);
    expectArms(["f.o now"], true, ["f.o"]);
    expectArms(["fxo now"], false, ["f.o"]);
  });

  test("an empty keyword list disables only the generic trigger", () => {
    expectArms(["focus", "ulw-loop now"], false, []);
    expect(detectPointers("ulw-loop now")).toEqual([mention("ulw-loop")]);
  });

  test("ignores code spans, fences, and injected blocks without joining the text around them", () => {
    const masked = [
      "explain `ulw` today",
      "explain ``ulw `status` ``",
      "```ts\nulw\n```\nnormal text",
      "~~~ts\nulw\n~~~\nnormal text",
      "````text\n```\nulw\n````",
      "```text\nulw",
      "<ultrawork-mode>ulw</ultrawork-mode>",
      "<omo-ultrawork-reminder>ulw</omo-ultrawork-reminder>",
      "<omo-mass-ulw-pointer>ulw</omo-mass-ulw-pointer>",
      "<omo-mass-ulw-mode>ulw</omo-mass-ulw-mode>",
      "ul`quoted`w",
    ];
    expectArms(masked, false);
    expectArms(["a `ulw` b ulw"], true);
  });

  test("requires both directive tags before treating input as an embedded directive", () => {
    expect(hasEmbeddedDirective("<ultrawork-mode>text</ultrawork-mode>")).toBe(true);
    expect(hasEmbeddedDirective("<ultrawork-mode> text only")).toBe(false);
    expect(hasEmbeddedDirective("no directive")).toBe(false);
  });

  test("stays linear on long URL-like input", () => {
    const long = "a.".repeat(100_000);
    const started = performance.now();
    expect(detectUltrawork(long)).toBe(false);
    expect(detectPointers(long)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("workflow pointer detection", () => {
  test("recognizes spaced, hyphenated, and fused spellings of every target", () => {
    const spellings: [PointerTarget, string[]][] = [
      ["mass-ulw", ["mass ulw", "massulw", "MASS ULW", "Mass-Ulw", "mass  ulw", "mass-ulw", "ulw mass", "ulwmass", "mulw", "meth"]],
      ["prometheus", ["ulw plan", "ulw-plan", "ulwplan", "ULW PLAN", "Ulw-Plan", "go ulw plan the migration", "ulw-plan."]],
      ["ulw-loop", ["ulw loop", "ulw-loop", "ulwloop", "ULW LOOP", "ulw  loop", "go ulw loop"]],
      ["ulw-research", ["ulw research", "ulw-research", "ulwresearch", "ULW RESEARCH"]],
    ];
    expectPointers(spellings.flatMap(([target, texts]) => texts.map((text) => [text, [mention(target)]] as const)));
  });

  test("composes independent targets once each, in table order", () => {
    const massLoop = [mention("mass-ulw"), mention("ulw-loop")];
    const massResearch = [mention("mass-ulw"), mention("ulw-research")];
    const loopResearch = [mention("ulw-loop"), mention("ulw-research")];
    expectPointers([
      ["mass ulw loop", massLoop],
      ["mass ulw-loop ship the refactor", massLoop],
      ["run mass ulw-loop on the refactor", massLoop],
      ["mass ulw research", massResearch],
      ["mulw research", massResearch],
      ["meth research", massResearch],
      ["ulw mass research", massResearch],
      ["ulwmass-research", massResearch],
      ["MULW RESEARCH", massResearch],
      ["mass ulw plan it out", [mention("mass-ulw"), mention("prometheus")]],
      ["ulw research first, ulw loop second", loopResearch],
      ["ulw loop then ulw research, then ulw loop again", loopResearch],
    ]);
  });

  test("ignores near misses, identifiers, paths, URLs, and file names", () => {
    const references = [
      "ulw",
      "ultrawork",
      "the mass of ulw",
      "ulw massive",
      "ulwmassive",
      "simulw",
      "mulwark",
      "method",
      "methane",
      "promethean",
      "amethyst",
      "ulw-looper",
      "ulwloops go brr",
      "ulw planning session",
      "loop ulw",
      "research ulw",
      "kulw loop of yarn",
      "what happened in the mass-ulw-refactor session",
      "the senpi-ulw-loop lane finished",
      "notes are in .omo/ulw-plan/draft.md",
      "the mass-ulw-loop-runner session finished",
      "see mass-ulw-research-notes.md",
      "open ulw-plan.md",
      "/ulw-plan",
      "C:\\work\\ulw-loop\\state.json",
      "https://host/ulw-plan?q=1",
      "file:///tmp/ulw-loop/",
      "run mass ulw.ts again",
      "use mass ulw.md as the reference",
      "use ulw-research_v2 on the notes",
    ];
    expectPointers(references.map((text) => [text, []] as const));
  });

  test("ignores quoted, relayed, prohibited, coded, and injected mentions", () => {
    const tags = ["omo-ulw-loop-pointer", "omo-mass-ulw-mode", "omo-ulw-research-mode", "ultrawork-mode", "omo-ultrawork-reminder"];
    const mentions = [
      '"ulw-loop"',
      "'ulw-loop'",
      "\u201Cmass ulw research\u201D",
      "\u2018ulw research\u2019",
      "they typed \u201Cmass ulw research the market\u201D and it armed",
      "the failing test is 'run mass ulw research > binds both'",
      "> ulw-loop the migration\nshould this have armed?",
      "[REPORT] lane | filed | an executor quoted mass ulw research and ulw-loop",
      "Lead (main), lane: your report mentioned ulw-research and mass-ulw",
      "Lead (main) to duty: the lane relayed ulw-loop and mass ulw research",
      "[lead via coordinator -> lane, PR#1] run mass ulw research on the fix",
      "Do not load mass-ulw or ulw-research or launch your own workflow.",
      "don't load mass-ulw or ulw-research",
      "never arm ulw, mulw",
      "explain `ulw-loop` without running it",
      "explain ``ulw-loop `status` ``",
      "review this log:\n```text\nulw-loop\n```",
      "ulw `not a request` loop",
      "mass`quoted`ulw",
      ...tags.map((tag) => `<${tag}>mass ulw research and ulw-loop</${tag}>`),
    ];
    expectPointers(mentions.map((text) => [text, []] as const));
  });

  test("keeps the user's own mention beside a masked one", () => {
    expectPointers([
      ["explain `ulw-plan`, then run ulw-loop", [mention("ulw-loop")]],
      ["Do not use tmux, but ulw-loop the fix", [mention("ulw-loop")]],
      ["> ulw-loop the migration\nulw research the market", [mention("ulw-research")]],
      ["[lane-a w46:p6P] ran mass ulw on the docs refresh", [mention("mass-ulw")]],
      ["the status report mentions ulw-loop", [mention("ulw-loop")]],
    ]);
  });

  test("binds mass-ulw and ulw-research only on their fixed request forms", () => {
    const mass = [binding("mass-ulw")];
    const research = [binding("ulw-research")];
    const both = [binding("mass-ulw"), binding("ulw-research")];
    expectPointers([
      ["/mass-ulw split the docs refresh into lanes", mass],
      ["/mulw fix the flaky suite", mass],
      ["/skill:mass-ulw ship it", mass],
      ["/ulw-research compare the gateway options", research],
      ["/mulw research the gateway options", both],
      ["run mass ulw research https://www.youtube.com/watch?v=abc and recreate it", both],
      ["run mass ulw on index.ts. Then report", mass],
      ["run mass ulw on the flaky suite", mass],
      ["run mass ulw on https://host/ulw-plan?q=1", mass],
      ["Run mass-ulw", mass],
      ["start mass ulw: fix the flaky suite", mass],
      ["use mass-ulw to split the docs refresh into lanes", mass],
      ["do mass ulw research on the housing market", both],
      ["execute mass ulw research for this video", both],
      ["use ulw-research to compare the gateway options", research],
      ["[Image #1] run mass ulw on this", mass],
      ["mass ulw 돌려줘", mass],
      ["mass ulw로 실행해줘", mass],
      ["mass ulw 써줘.", mass],
      ["mass ulw 해줘", mass],
      ["mass ulw 돌려", mass],
      ["ulw research 실행해", research],
      ["mass ulw research 돌려줘\n결과는 표로 정리", both],
    ]);
  });

  test("keeps questions, statements, bare meth, and non-leading requests conditional", () => {
    const mass = [mention("mass-ulw")];
    const massResearch = [mention("mass-ulw"), mention("ulw-research")];
    const research = [mention("ulw-research")];
    expectPointers([
      ["https://www.youtube.com/live/qt5p-_tE8d0 How is this possible? Recreate it in 3D. mass ulw research", massResearch],
      ["mass ulw is broken in this repo, can you look into it?", mass],
      ["Mass ulw keeps failing on my machine", mass],
      ["mass ulw research didn't start a workflow yesterday. why", massResearch],
      ["mass ulw fix the flaky suite", mass],
      ["how do I use mass ulw", mass],
      ["Fix the flaky suite, mass ulw.", mass],
      ["what is ulw research?", research],
      ["is ulw research any good? I tried ulw research", research],
      ["please don't do mass ulw research", massResearch],
      ["Use mass-ulw's docs to explain the planner", mass],
      ["run the mass-ulw test suite", mass],
      ["Do mass ulw tests pass on dev?", mass],
      ["Use ulw research results from yesterday to write the summary", research],
      ["run mass ulw on dev?", mass],
      ["run mass ulw on index.ts?", mass],
      ["use mass ulw. Is that the right choice?", mass],
      ["/mass-ulw is this the right tool?", []],
      ["run mass ulw on it. 이거 맞아\uFF1F", mass],
      ["Why is the suite flaky? run mass ulw on it", mass],
      ["mass ulw로 해줘. 근데 이게 맞아?", mass],
      ["run mass ulw on v1.2 of the planner?", mass],
      ["what is mass ulw research at https://example.com?", massResearch],
      ["how does mass ulw differ from ulw-loop?", [mention("mass-ulw"), mention("ulw-loop")]],
      ["[step 1 -> step 2] run mass ulw on this migration", mass],
      ["The suite is flaky. Run mass-ulw on it and report back", mass],
      ["please use mass-ulw to split the docs refresh", mass],
      ["fix the flaky suite in mass ulw", mass],
      ["meth ship the docs refresh", mass],
      ["run meth on the docs refresh", mass],
      ["run meth research on the market", massResearch],
      ["use ulw-loop to fix the flaky test", [mention("ulw-loop")]],
      ["run ulw plan on the migration", [mention("prometheus")]],
      ["请用 mass ulw research 对比这些方案", massResearch],
      ["用 mass ulw 跑一下测试", mass],
    ]);
  });

  test("keeps declarative and questioning Korean conditional", () => {
    const statements = [
      "mass ulw 돌려도 돼?",
      "mass ulw를 돌려볼까?",
      "mass ulw 돌려봤는데 안 되네",
      "mass ulw 써서 만든 결과가 이상해",
      "mass ulw 실행해줘?",
      "mass ulw 돌렸어",
      "mass ulw 했어",
      "mass ulw 하니",
      "mass ulw 했는데 결과가 없어",
      "mass ulw 돌려봐",
      "mass ulw 실행해주세요",
      "mass ulw 돌려줘서 고마워",
    ];
    expectPointers(statements.map((text) => [text, [mention("mass-ulw")]] as const));
  });

  test("never manufactures a binding across masked or glued text", () => {
    expectPointers([
      ['"note" run mass ulw on it', [mention("mass-ulw")]],
      ["> quoted\nrun mass ulw on it", [mention("mass-ulw")]],
      ["[REPORT] run mass ulw on it", []],
      ["run mass `x` ulw on it", []],
      ["run mass ulwnow", []],
    ]);
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
      "'orchestrate' it",
      "\u201Corchestrate\u201D it",
      "Do not use orchestrate here",
      "> orchestrate this",
      "[REPORT] lane: orchestrate it",
      "see https://example.com/orchestrate",
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

  test("keeps host-visible quoted and prohibited text out of the workflow scanner's masks", () => {
    for (const text of ['"orchestrate" it', "Do not use orchestrate here"]) {
      const seen = { host: containsHostKeyword(text, "orchestrate"), workflow: detectUltrawork(text, ["orchestrate"]) };
      expect({ text, ...seen }).toEqual({ text, host: true, workflow: false });
    }
    expect(triggersOrchestrate('ulw "orchestrate" it', ["task"], settings())).toBe(true);
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
