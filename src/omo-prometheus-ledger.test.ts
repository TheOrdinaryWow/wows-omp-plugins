import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  createLedger,
  invalidateRows,
  isComplete,
  nextDispatchable,
  parsePlanChecklist,
  refreshDispatchAgents,
  renderLedgerSummary,
  restoreLedger,
  startRow,
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
  - Agent: deep-low
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
      { id: "T3", agent: "deep-low", dependsOn: ["T2"], status: "in_progress" },
    ]);
    expect(result.gates.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "F1", status: "done" },
      { id: "F2", status: "open" },
      { id: "F3", status: "open" },
      { id: "F4", status: "open" },
    ]);
  });

  test("rejects a missing final section, fewer than four gates, and malformed rows", () => {
    expect(() => createLedger("local://example-plan.md", plan.replace(/## Final gates[\s\S]*$/, ""))).toThrow();
    expect(() => createLedger("local://example-plan.md", plan.replace("- [ ] F4. Success-criteria fidelity\n", ""))).toThrow();
    expect(() =>
      createLedger("local://example-plan.md", plan.replace("- [ ] T2. Implement the change", "- [ ] T2 Implement the change")),
    ).toThrow();
    expect(() =>
      createLedger("local://example-plan.md", plan.replace("- [ ] T2. Implement the change", "- [ ] T9. Implement the change")),
    ).toThrow();
    expect(() => createLedger("local://example-plan.md", plan.replace("  - Depends on: T1", "  - Depends on: T77"))).toThrow();
  });

  test("never accepts plan checkboxes as execution receipts and orders final synthesis", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    expect(ledger.items.map((item) => item.status)).toEqual(["open", "open", "open"]);
    expect(ledger.items[0]?.acceptance).toBe("initial behavior observed");
    expect(nextDispatchable(ledger).map((item) => item.id)).toEqual(["T1"]);
    expect(() => startRow(ledger, "T2")).toThrow("unfinished");
    for (const item of ledger.items) item.status = "done";
    expect(nextDispatchable(ledger).map((item) => item.id)).toEqual(["F1", "F2", "F3"]);
    expect(() => startRow(ledger, "F4")).toThrow("unfinished");
    for (const gate of ledger.gates.slice(0, 3)) gate.status = "done";
    expect(nextDispatchable(ledger).map((item) => item.id)).toEqual(["F4"]);
    for (const gate of ledger.gates) gate.status = "done";
    expect(isComplete(ledger)).toBe(false); // Status-only completion cannot authorize release.
  });

  test("pins the full plan content", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    expect(ledger.planSha256).toBe(createHash("sha256").update(plan).digest("hex"));
  });

  test("accepts user-defined names only in the live roster and retains known fallback names", () => {
    const custom = plan.replace("Agent: deep-low", "Agent: custom-worker");
    expect(parsePlanChecklist(custom, ["task", "custom-worker"]).errors).toEqual([]);
    expect(createLedger("local://custom-plan.md", custom, ["task", "custom-worker"]).items[0]?.dispatchAgent).toBe("custom-worker");
    expect(() => createLedger("local://custom-plan.md", custom, ["task"])).toThrow();
    expect(() => createLedger("local://custom-plan.md", custom)).toThrow();
    expect(parsePlanChecklist(plan, ["task"]).errors).toEqual([]);
    expect(() => createLedger("local://example-plan.md", plan.replace("Agent: deep-low", "Agent: unknown-worker"), ["task"])).toThrow();
  });

  test("persists installed agents or available fallbacks for tasks and gates", () => {
    const toolkit = createLedger("local://example-plan.md", plan, ["task", "sonic", "deep-low", "deep-high", "momus"]);
    expect(toolkit.items.map((item) => item.dispatchAgent)).toEqual(["deep-low", "sonic", "deep-low"]);
    expect(toolkit.gates.map((gate) => gate.dispatchAgent)).toEqual(["momus", "deep-high", "deep-low", "deep-high"]);

    const bundled = createLedger("local://example-plan.md", plan, ["task", "sonic", "scout", "reviewer"]);
    expect(bundled.items.map((item) => item.dispatchAgent)).toEqual(["task", "sonic", "task"]);
    expect(bundled.gates.map((gate) => gate.dispatchAgent)).toEqual(["reviewer", "task", "task", "task"]);
    expect(renderLedgerSummary(bundled)).toContain("deep-low -> task");
    expect(renderLedgerSummary(bundled)).toContain("momus -> reviewer");
    expect(createLedger("local://example-plan.md", plan).items[0]?.dispatchAgent).toBe("deep-low");
  });

  test("rebinds unfinished rows after the installed roster changes", () => {
    const ledger = createLedger("local://example-plan.md", plan, ["task", "sonic", "reviewer"]);
    if (ledger.items[0]) ledger.items[0].status = "done";
    if (ledger.gates[0]) ledger.gates[0].status = "done";
    const oldLedger = JSON.parse(JSON.stringify(ledger)) as typeof ledger;
    for (const row of [...oldLedger.items, ...oldLedger.gates]) delete row.dispatchAgent;
    expect(renderLedgerSummary(oldLedger, ["task", "reviewer"])).toContain("deep-low -> task");
    expect(refreshDispatchAgents(oldLedger, ["task", "reviewer"])).toBe(true);
    expect(oldLedger.items[0]?.dispatchAgent).toBeUndefined(); // T1 was completed before the roster changed.
    expect(oldLedger.items[1]?.dispatchAgent).toBe("task");
    expect(oldLedger.gates[0]?.dispatchAgent).toBeUndefined(); // F1 was completed before the roster changed.
    expect(oldLedger.gates[1]?.dispatchAgent).toBe("task");
    expect(refreshDispatchAgents(oldLedger, ["task", "reviewer"])).toBe(false);
    expect(refreshDispatchAgents(oldLedger, ["task", "sonic", "reviewer"])).toBe(true);
    expect(oldLedger.items[1]?.dispatchAgent).toBe("sonic");
  });

  test("rejects multi-node dependency cycles before any item can dispatch", () => {
    expect(() => createLedger("local://cycle-plan.md", plan.replace("Depends on: none", "Depends on: T2"))).toThrow("cycle");
    expect(() => createLedger("local://cycle-plan.md", plan.replace("Depends on: none", "Depends on: T3"))).toThrow("cycle");
  });

  test("reopening work invalidates transitive descendants and all verification attempts", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    for (const row of [...ledger.items, ...ledger.gates]) {
      row.status = "done";
      row.attempt = "old-attempt";
      row.childAgentId = "OldChild";
      row.evidence = "obsolete proof";
    }
    if (ledger.gates[3]) ledger.gates[3].status = "in_progress";
    expect(invalidateRows(ledger, "T1")).toEqual(["T1", "T2", "T3", "F1", "F2", "F3", "F4"]);
    expect(
      [...ledger.items, ...ledger.gates].every(
        (row) => row.status === "open" && row.attempt === undefined && row.childAgentId === undefined && row.evidence === undefined,
      ),
    ).toBe(true);
    const started = startRow(ledger, "T1");
    expect(() => startRow(ledger, "T1")).toThrow("reopen");
    const oldAttempt = started.attempt;
    invalidateRows(ledger, "T1");
    expect(startRow(ledger, "T1").attempt).not.toBe(oldAttempt);
  });

  test("reopening one independent review invalidates synthesis without discarding other reviews", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    for (const row of [...ledger.items, ...ledger.gates]) row.status = "done";
    expect(invalidateRows(ledger, "F2")).toEqual(["F2", "F4"]);
    expect(ledger.gates.map((row) => row.status)).toEqual(["done", "open", "done", "open"]);
  });

  test("refuses altered plan bytes and corrupt structural state on restore", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    expect(() => restoreLedger(ledger, ledger.planFilePath, `${plan}\n`, ledger.planSha256)).toThrow("approved plan");
    const altered = structuredClone(ledger);
    if (altered.items[0]) altered.items[0].acceptance = "weaker check";
    expect(() => restoreLedger(altered, ledger.planFilePath, plan, ledger.planSha256)).toThrow("Malformed");
    expect(() => restoreLedger({ ...ledger, gates: [] }, ledger.planFilePath, plan, ledger.planSha256)).toThrow("rows differ");
    expect(() => restoreLedger({ ...ledger, items: [null] }, ledger.planFilePath, plan, ledger.planSha256)).toThrow();
  });

  test("migrates legacy status-only ledgers by reopening rather than grandfathering completion", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    const legacy = {
      ...ledger,
      version: 1,
      items: ledger.items.map((row) => ({ ...row, status: "done" })),
      gates: ledger.gates.map((row) => ({ ...row, dependsOn: [], status: "done" })),
    };
    const restored = restoreLedger(legacy, ledger.planFilePath, plan, ledger.planSha256);
    expect(restored.version).toBe(2);
    expect([...restored.items, ...restored.gates].every((row) => row.status === "open" && row.receipt === undefined)).toBe(true);
  });
});
