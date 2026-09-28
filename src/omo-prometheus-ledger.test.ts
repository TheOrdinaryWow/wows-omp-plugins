import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  createLedger,
  isComplete,
  nextDispatchable,
  parsePlanChecklist,
  refreshDispatchAgents,
  renderLedgerSummary,
} from "../plugins/omo-prometheus/src/ledger.ts";

const plan = `# Work plan

## Tasks
- [x] T1. Establish the baseline
  - Agent: deep-low
  - Depends on: none
  - Acceptance: initial behavior observed
- [ ] T2. Implement the change
  - Agent: sonic
  - Depends on: T1
  - Acceptance: changed behavior observed
- [~] T3. Check downstream behavior
  - Agent: qa-executor
  - Depends on: T2
  - Acceptance: exercised real interface

## Final gates
- [x] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

describe("Prometheus execution ledger", () => {
  test("parses task dependencies, checkbox states, and four exact gates", () => {
    const result = parsePlanChecklist(plan);
    expect(result.errors).toEqual([]);
    expect(result.items.map(({ id, agent, dependsOn, status }) => ({ id, agent, dependsOn, status }))).toEqual([
      { id: "T1", agent: "deep-low", dependsOn: [], status: "done" },
      { id: "T2", agent: "sonic", dependsOn: ["T1"], status: "open" },
      { id: "T3", agent: "qa-executor", dependsOn: ["T2"], status: "in_progress" },
    ]);
    expect(result.gates.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "F1", status: "done" },
      { id: "F2", status: "open" },
      { id: "F3", status: "open" },
      { id: "F4", status: "open" },
    ]);
  });

  test("rejects a missing final section, fewer than four gates, and malformed rows", () => {
    expect(parsePlanChecklist(plan.replace(/## Final gates[\s\S]*$/, "")).errors).toContain(
      "## Final gates must contain exactly four F rows",
    );
    expect(parsePlanChecklist(plan.replace("- [ ] F4. Success-criteria fidelity\n", "")).errors).toContain(
      "## Final gates must contain exactly four F rows",
    );
    expect(parsePlanChecklist(plan.replace("- [ ] T2. Implement the change", "- [ ] T2 Implement the change")).errors).toContain(
      "Line 8: malformed tasks checklist row",
    );
    expect(parsePlanChecklist(plan.replace("- [ ] T2. Implement the change", "- [ ] T9. Implement the change")).errors).toContain(
      "Line 8: task ids must be unique and sequential from T1",
    );
    expect(parsePlanChecklist(plan.replace("  - Depends on: T1", "  - Depends on: T77")).errors).toContain("T2: invalid dependency T77");
  });

  test("dispatches only open items with completed dependencies and requires every gate for completion", () => {
    const fresh = createLedger("local://fresh-plan.md", plan.replace("- [x] T1.", "- [ ] T1.").replace("- [x] F1.", "- [ ] F1."));
    expect(nextDispatchable(fresh).map((item) => item.id)).toEqual(["T1"]);

    const ledger = createLedger("local://example-plan.md", plan);
    expect(nextDispatchable(ledger).map((item) => item.id)).toEqual(["T2"]);
    for (const item of ledger.items) item.status = "done";
    expect(isComplete(ledger)).toBe(false);
    for (const gate of ledger.gates) gate.status = "done";
    expect(isComplete(ledger)).toBe(true);
  });

  test("pins the full plan content and throws on invalid grammar", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    expect(ledger.planSha256).toBe(createHash("sha256").update(plan).digest("hex"));
    expect(() => createLedger("local://example-plan.md", plan.replace(/## Final gates[\s\S]*$/, ""))).toThrow("Final gates");
  });

  test("accepts user-defined names only in the live roster and retains known fallback names", () => {
    const custom = plan.replace("Agent: deep-low", "Agent: custom-worker");
    expect(parsePlanChecklist(custom, ["task", "custom-worker"]).errors).toEqual([]);
    expect(createLedger("local://custom-plan.md", custom, ["task", "custom-worker"]).items[0]?.dispatchAgent).toBe("custom-worker");
    expect(parsePlanChecklist(custom, ["task"]).errors).toContain("T1: Agent must name an available or known fallback agent");
    expect(parsePlanChecklist(custom).errors).toContain("T1: Agent must name an available or known fallback agent");
    expect(parsePlanChecklist(plan, ["task"]).errors).toEqual([]);
    expect(parsePlanChecklist(plan.replace("Agent: deep-low", "Agent: unknown-worker"), ["task"]).errors).toContain(
      "T1: Agent must name an available or known fallback agent",
    );
  });

  test("persists installed agents or available fallbacks for tasks and gates", () => {
    const toolkit = createLedger("local://example-plan.md", plan, [
      "task",
      "sonic",
      "deep-low",
      "qa-executor",
      "momus",
      "code-reviewer",
      "gate-reviewer",
    ]);
    expect(toolkit.items.map((item) => item.dispatchAgent)).toEqual(["deep-low", "sonic", "qa-executor"]);
    expect(toolkit.gates.map((gate) => gate.dispatchAgent)).toEqual(["momus", "code-reviewer", "qa-executor", "gate-reviewer"]);

    const bundled = createLedger("local://example-plan.md", plan, ["task", "sonic", "scout", "reviewer"]);
    expect(bundled.items.map((item) => item.dispatchAgent)).toEqual(["task", "sonic", "task"]);
    expect(bundled.gates.map((gate) => gate.dispatchAgent)).toEqual(["reviewer", "reviewer", "task", "reviewer"]);
    expect(renderLedgerSummary(bundled)).toContain("deep-low -> task");
    expect(renderLedgerSummary(bundled)).toContain("momus -> reviewer");
    expect(createLedger("local://example-plan.md", plan).items[0]?.dispatchAgent).toBe("deep-low");
  });

  test("rebinds only unfinished rows on resume and resolves legacy version-one rows at read time", () => {
    const ledger = createLedger("local://example-plan.md", plan, ["task", "sonic", "reviewer"]);
    const oldLedger = JSON.parse(JSON.stringify(ledger)) as typeof ledger;
    for (const row of [...oldLedger.items, ...oldLedger.gates]) delete row.dispatchAgent;
    expect(renderLedgerSummary(oldLedger, ["task", "reviewer"])).toContain("deep-low -> task");
    expect(refreshDispatchAgents(oldLedger, ["task", "reviewer"])).toBe(true);
    expect(oldLedger.items[0]?.dispatchAgent).toBeUndefined(); // T1 was completed before the roster changed.
    expect(oldLedger.items[1]?.dispatchAgent).toBe("task");
    expect(oldLedger.gates[0]?.dispatchAgent).toBeUndefined(); // F1 was completed before the roster changed.
    expect(oldLedger.gates[1]?.dispatchAgent).toBe("reviewer");
    expect(refreshDispatchAgents(oldLedger, ["task", "reviewer"])).toBe(false);
    expect(refreshDispatchAgents(oldLedger, ["task", "sonic", "reviewer"])).toBe(true);
    expect(oldLedger.items[1]?.dispatchAgent).toBe("sonic");
  });
});
