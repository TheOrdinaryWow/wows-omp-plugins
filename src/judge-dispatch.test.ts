import { describe, expect, test } from "bun:test";

import {
  acceptRoutingDecision,
  parseLegalAgentNames,
  parseTaskInput,
  rewriteTaskRoutes,
  routableCandidates,
  routingDeadlineMs,
  serializeCandidate,
} from "../plugins/judge-dispatch/src/routing.ts";

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
    expect(rewriteTaskRoutes(input, routes, [{ agent: "security-reviewer" }])).toEqual({
      ...input,
      agent: "security-reviewer",
    });
    expect(rewriteTaskRoutes(input, routes, [undefined])).toBe(input);
    expect(rewriteTaskRoutes(input, routes, [{ agent: "task", effort: "hi" }])).toBe(input);
    expect(input.agent).toBe("task");
  });

  test("a judged effort replaces or fills the requested effort", () => {
    const input = { agent: "task", task: "Trace the deadlock", effort: "lo" };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid flat task input");

    expect(rewriteTaskRoutes(input, routes, [{ effort: "hi" }])).toEqual({ ...input, effort: "hi" });
    const { effort: _, ...withoutEffort } = input;
    expect(rewriteTaskRoutes(withoutEffort, routes, [{ effort: "med" }])).toEqual({ ...withoutEffort, effort: "med" });
    expect(input.effort).toBe("lo");
  });

  test("rewrites batch items independently without changing shared context or sibling fields", () => {
    const input = {
      context: "Shared release constraints",
      async: true,
      tasks: [
        { name: "Audit", agent: "task", task: "Inspect the boundary", effort: "hi", isolated: true },
        { name: "Docs", agent: "sonic", task: "Correct one heading", effort: "lo", tools: ["lookup"] },
        { name: "Plan", agent: "task", task: "Sketch the migration" },
      ],
    };
    const routes = parseTaskInput(input);
    if (!routes) throw new Error("expected valid batch task input");
    const rewritten = rewriteTaskRoutes(input, routes, [{ agent: "security-reviewer" }, undefined, { effort: "med" }]);

    expect(rewritten).toEqual({
      ...input,
      tasks: [{ ...input.tasks[0], agent: "security-reviewer" }, input.tasks[1], { ...input.tasks[2], effort: "med" }],
    });
    expect(input.tasks[0]?.agent).toBe("task");
    expect(input.tasks[2]).not.toHaveProperty("effort");
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

test("keeps routing below the scoped tool-call timeout", () => {
  expect(routingDeadlineMs(30_000)).toBe(8_000);
  expect(routingDeadlineMs(5_000)).toBe(4_000);
  expect(routingDeadlineMs(1_200)).toBeUndefined();
  expect(routingDeadlineMs(Number.NaN)).toBeUndefined();
});

describe("legal agent extraction", () => {
  const description = [
    "Delegate work to background subagents.",
    "",
    "# Available Agents",
    "Pick the most specific agent.",
    "### scout (READ-ONLY)",
    "Fast read-only research.",
    "### security-reviewer",
    "Evidence-backed security analysis.",
  ].join("\n");

  test("reads the host's rendered spawnable agent list", () => {
    expect(parseLegalAgentNames(description)).toEqual(["scout", "security-reviewer"]);
  });

  test("reads backticked bullet names only inside the available agents section", () => {
    const bulletDescription = [
      "# Available Agents",
      "`m<N>` is a user-tagged model.",
      "- `scout` (READ-ONLY; investigation only, no edits): Research",
      "- `task`: Implement",
      "- `scout`: Duplicate entry",
      "# Other Section",
      "- `audit-fixer`: Not a task agent",
    ].join("\n");
    expect(parseLegalAgentNames(bulletDescription)).toEqual(["scout", "task"]);
    expect(parseLegalAgentNames("# Available Agents\n### task\n# Other Section\n### intruder")).toEqual(["task"]);
  });

  test("does not treat an unrecognized or empty section as disabled", () => {
    expect(parseLegalAgentNames("# Available Agents\nUnrecognized listing format\n")).toBeUndefined();
    expect(parseLegalAgentNames("# Available Agents\n# Other Section\nAgent spawning is currently disabled.")).toBeUndefined();
    expect(parseLegalAgentNames("# Available Agents\n")).toBeUndefined();
  });

  test("reports spawning-disabled sessions as an empty legal set", () => {
    expect(parseLegalAgentNames("# Available Agents\nAgent spawning is currently disabled.\n")).toEqual([]);
  });

  test("returns undefined when the section is absent so callers can fail open", () => {
    expect(parseLegalAgentNames("Delegate work to ONE background subagent per call.")).toBeUndefined();
  });
});

describe("routing authority boundaries", () => {
  const candidates = [
    { name: "task", readOnly: false },
    { name: "audit-auditor", readOnly: true },
    { name: "scout", readOnly: true },
    { name: "audit-fixer", readOnly: false },
    { name: "metis", readOnly: true },
    { name: "momus", readOnly: true },
    { name: "oracle", readOnly: true },
    { name: "reviewer", readOnly: true },
  ];

  test("never offers workflow-owned agents as destinations", () => {
    expect(routableCandidates("task", candidates)?.map((candidate) => candidate.name)).toEqual(["task", "scout", "reviewer"]);
    expect(routableCandidates(undefined, candidates)?.map((candidate) => candidate.name)).toEqual(["task", "scout", "reviewer"]);
  });

  test("keeps workflow-owned and unknown explicit sources untouched, including effort", () => {
    for (const name of ["audit-fixer", "audit-auditor", "metis", "momus", "oracle", "unknown-agent"]) {
      expect(routableCandidates(name, candidates)).toBeUndefined();
    }
  });

  test("restricts a read-only source to read-only destinations", () => {
    expect(routableCandidates("scout", candidates)?.map((candidate) => candidate.name)).toEqual(["scout", "reviewer"]);
  });
});

describe("routing decision acceptance", () => {
  const candidates = ["task", "scout"];

  test("accepts a legal native choice at the threshold", () => {
    expect(acceptRoutingDecision({ kind: "native", choice: "scout", confidence: 0.7 }, candidates, 0.7)).toBe("scout");
  });

  test("rejects low-confidence, non-native, and illegal choices", () => {
    expect(acceptRoutingDecision({ kind: "native", choice: "scout", confidence: 0.69 }, candidates, 0.7)).toBeUndefined();
    expect(acceptRoutingDecision({ kind: "native", choice: "scout", confidence: Number.NaN }, candidates, 0.7)).toBeUndefined();
    expect(acceptRoutingDecision({ kind: "online", choice: "scout", confidence: 1 }, candidates, 0.7)).toBeUndefined();
    expect(acceptRoutingDecision({ kind: "local", choice: "scout", confidence: 1 }, candidates, 0.7)).toBeUndefined();
    expect(acceptRoutingDecision({ kind: "native", choice: "missing", confidence: 1 }, candidates, 0.7)).toBeUndefined();
  });
});
