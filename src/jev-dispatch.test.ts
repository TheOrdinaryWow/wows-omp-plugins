import { describe, expect, test } from "bun:test";

import {
  acceptRoutingDecision,
  assertNativeJevCandidate,
  isNativeJevCandidate,
  NonJevJudgeCandidateError,
  parseTaskInput,
  rewriteTaskAgents,
  selectRoutingSurface,
  serializeCandidate,
  standardRoutingDeadlineMs,
} from "../plugins/jev-dispatch/src/routing.ts";

describe("task input routing", () => {
  test("rewrites only the flat agent field", () => {
    const input = {
      agent: "task",
      task: "Review the authentication boundary",
      effort: "hi",
      isolated: true,
      outputSchema: { type: "object" },
    };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid flat task input");

    expect(routes).toEqual([
      {
        index: null,
        assignment: "Review the authentication boundary",
        requestedAgent: "task",
      },
    ]);
    expect(rewriteTaskAgents(input, routes, ["security-reviewer"])).toEqual({
      ...input,
      agent: "security-reviewer",
    });
    expect(rewriteTaskAgents(input, routes, [undefined])).toBe(input);
    expect(input.agent).toBe("task");
  });

  test("rewrites batch agents without changing shared context, effort, or sibling fields", () => {
    const input = {
      context: "Shared release constraints",
      async: true,
      tasks: [
        { name: "Audit", agent: "task", task: "Inspect the boundary", effort: "hi", isolated: true },
        { name: "Docs", agent: "sonic", task: "Correct one heading", effort: "lo", tools: ["lookup"] },
      ],
    };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid batch task input");
    const rewritten = rewriteTaskAgents(input, routes, ["security-reviewer", undefined]);

    expect(rewritten).toEqual({
      ...input,
      tasks: [{ ...input.tasks[0], agent: "security-reviewer" }, input.tasks[1]],
    });
    expect(input.tasks[0]?.agent).toBe("task");
    expect(input.tasks[1]?.effort).toBe("lo");
  });

  test("leaves malformed task shapes unparsed", () => {
    expect(parseTaskInput({ context: "shared", tasks: [{ agent: "task" }] })).toBeUndefined();
    expect(parseTaskInput({ task: "valid", agent: 42 })).toBeUndefined();
  });
});

test("candidate serialization exposes only compact routing metadata", () => {
  const serialized = serializeCandidate({
    name: "scout",
    description: "Read-only   repository\nresearch",
    source: "bundled",
    readOnly: true,
    declaredModelPatterns: ["@smol"],
    model: {
      patterns: ["openai/gpt-fast"],
      role: "smol",
      selected: "openai/gpt-fast",
      fallbackChain: ["anthropic/claude-haiku"],
    },
  });

  expect(serialized).toEqual({
    name: "scout",
    description: "Read-only repository research",
    source: "bundled",
    access: "read-only",
    model: {
      declared: ["@smol"],
      effective: ["openai/gpt-fast"],
      role: "smol",
      selected: "openai/gpt-fast",
      fallbacks: ["anthropic/claude-haiku"],
    },
  });
});

test("recognizes only native Jev candidate labels", () => {
  expect(isNativeJevCandidate("native", "typesafe/jev-latest")).toBe(true);
  expect(isNativeJevCandidate("native", "openrouter/~typesafe/jev-2")).toBe(true);
  expect(isNativeJevCandidate("native", "typesafe/system-one")).toBe(false);
  expect(isNativeJevCandidate("online", "typesafe/jev-latest")).toBe(false);
});

test("throws an ordinary control-flow error before a non-Jev candidate can run", () => {
  expect(() => assertNativeJevCandidate("native", "typesafe/jev-latest")).not.toThrow();
  expect(() => assertNativeJevCandidate("online", "openai/gpt-4.1")).toThrow(NonJevJudgeCandidateError);
});

test("selects exactly one routing surface from session-scoped mode and capability", () => {
  expect(selectRoutingSurface("standard", 1)).toEqual({
    surface: "standard",
    warnAboutEnhancedFallback: false,
  });
  expect(selectRoutingSurface("enhanced", 1)).toEqual({
    surface: "enhanced",
    warnAboutEnhancedFallback: false,
  });
  expect(selectRoutingSurface("enhanced", undefined)).toEqual({
    surface: "standard",
    warnAboutEnhancedFallback: true,
  });
});

test("keeps standard routing below the scoped tool-call timeout", () => {
  expect(standardRoutingDeadlineMs(30_000)).toBe(8_000);
  expect(standardRoutingDeadlineMs(5_000)).toBe(4_000);
  expect(standardRoutingDeadlineMs(1_200)).toBeUndefined();
  expect(standardRoutingDeadlineMs(Number.NaN)).toBeUndefined();
});

describe("routing decision acceptance", () => {
  const candidates = ["task", "scout"];

  test("accepts a legal native Jev choice at the threshold", () => {
    expect(
      acceptRoutingDecision({ kind: "native", api: "typesafe", model: "jev-latest", choice: "scout", confidence: 0.7 }, candidates, 0.7),
    ).toBe("scout");
  });

  test("rejects low-confidence, non-native, non-Jev, and illegal choices", () => {
    expect(
      acceptRoutingDecision({ kind: "native", api: "typesafe", model: "jev-latest", choice: "scout", confidence: 0.69 }, candidates, 0.7),
    ).toBeUndefined();
    expect(
      acceptRoutingDecision(
        { kind: "online", api: "openai-responses", model: "jev-latest", choice: "scout", confidence: 1 },
        candidates,
        0.7,
      ),
    ).toBeUndefined();
    expect(
      acceptRoutingDecision(
        { kind: "native", api: "openrouter-decisions", model: "jev-latest", choice: "missing", confidence: 1 },
        candidates,
        0.7,
      ),
    ).toBeUndefined();
    expect(
      acceptRoutingDecision({ kind: "native", api: "typesafe", model: "system-one", choice: "scout", confidence: 1 }, candidates, 0.7),
    ).toBeUndefined();
  });
});
