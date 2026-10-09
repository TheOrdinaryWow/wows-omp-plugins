import { describe, expect, test } from "bun:test";

import { parseLegalAgentNames, resolveAgent } from "../plugins/omo-prometheus/src/agents.ts";

const description = `Spawn tasks[] concurrently.

# Available Agents
- \`task\`: General-purpose agent
- \`scout\` (READ-ONLY; investigation only): Read-only investigation
- \`reviewer\`: Code review
- \`librarian\`: External research
- \`deep-high\`: High-effort investigation
- \`custom-worker\`: User-defined agent
### usage
A heading inside a multi-line description names no agent.
`;

describe("Prometheus live agent routing", () => {
  test("parses the available-agent section of the task description", () => {
    expect(parseLegalAgentNames(description)).toEqual(["task", "scout", "reviewer", "librarian", "deep-high", "custom-worker"]);
    expect(parseLegalAgentNames("# Available Agents\nAgent spawning is currently disabled.")).toEqual([]);
    expect(parseLegalAgentNames("task has no roster section")).toBeUndefined();
    expect(parseLegalAgentNames("# Available Agents\nUnrecognized roster format")).toBeUndefined();
  });

  test("retains installed specialists and follows only spawnable fallback chains", () => {
    const toolkit = parseLegalAgentNames(description);
    const bundled = ["task", "sonic", "scout", "reviewer"];
    expect(resolveAgent("librarian", toolkit)).toEqual({ dispatchAgent: "librarian", fellBack: false });
    expect(resolveAgent("deep-high", toolkit)).toEqual({ dispatchAgent: "deep-high", fellBack: false });
    expect(resolveAgent("librarian", bundled)).toEqual({ dispatchAgent: "scout", fellBack: true });
    expect(resolveAgent("deep-high", bundled)).toEqual({ dispatchAgent: "task", fellBack: true });
    expect(resolveAgent("deep-low", bundled)).toEqual({ dispatchAgent: "task", fellBack: true });
    expect(resolveAgent("librarian", ["task"])).toEqual({ dispatchAgent: "task", fellBack: true });
    expect(resolveAgent("momus", ["task"])).toEqual({ dispatchAgent: "task", fellBack: true });
    expect(resolveAgent("librarian", [])).toEqual({ dispatchAgent: undefined, fellBack: false });
  });

  test("accepts listed custom agents and preserves requested names when the roster is unknown", () => {
    expect(resolveAgent("custom-worker", ["task", "custom-worker"])).toEqual({ dispatchAgent: "custom-worker", fellBack: false });
    expect(resolveAgent("custom-worker", ["task"]).dispatchAgent).toBeUndefined();
    expect(resolveAgent("librarian", undefined)).toEqual({ dispatchAgent: "librarian", fellBack: false });
  });
});
