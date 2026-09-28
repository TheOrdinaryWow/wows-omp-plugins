import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createLedger, isComplete, nextDispatchable, parsePlanChecklist } from "../plugins/omo-prometheus/src/ledger.ts";

const plan = `# Work plan

## Tasks
- [x] T1. Establish the baseline
  - Agent: deep-low
  - Depends on: none
  - Acceptance: initial behavior observed
- [ ] T2. Implement the change
  - Agent: task
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
      { id: "T2", agent: "task", dependsOn: ["T1"], status: "open" },
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
});
