import { describe, expect, test } from "bun:test";

import { parseLegalAgentNames, resolveAgent } from "../plugins/omo-prometheus/src/agents.ts";

const legacyDescription = `Delegate work to background subagents.

# Available Agents
Pick the most specific agent.
### task
General-purpose agent
### scout (READ-ONLY)
Read-only investigation
### reviewer
Code review
### librarian
External research
### deep-high
High-effort investigation
### custom-worker
User-defined agent
`;

const currentDescription = `Spawn tasks[] concurrently.

# Available Agents
- \`task\`: General-purpose agent
- \`scout\` (READ-ONLY; investigation only): Read-only investigation
- \`reviewer\`: Code review
- \`librarian\`: External research
- \`deep-high\`: High-effort investigation
- \`custom-worker\`: User-defined agent
`;

describe("Prometheus live agent routing", () => {
  test("parses the available-agent section in legacy and current task descriptions", () => {
    const expected = ["task", "scout", "reviewer", "librarian", "deep-high", "custom-worker"];
    expect(parseLegalAgentNames(legacyDescription)).toEqual(expected);
    expect(parseLegalAgentNames(currentDescription)).toEqual(expected);
    expect(parseLegalAgentNames("# Available Agents\nAgent spawning is currently disabled.")).toEqual([]);
    expect(parseLegalAgentNames("task has no roster section")).toBeUndefined();
    expect(parseLegalAgentNames("# Available Agents\nUnrecognized roster format")).toBeUndefined();
  });

  test("retains installed specialists and follows only spawnable fallback chains", () => {
    const toolkit = parseLegalAgentNames(currentDescription);
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
