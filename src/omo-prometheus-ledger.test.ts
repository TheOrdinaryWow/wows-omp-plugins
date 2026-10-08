import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  addFixRow,
  createLedger,
  isComplete,
  ledgerRows,
  nextDispatchable,
  parsePlanChecklist,
  refreshDispatchAgents,
  renderLedgerSummary,
  reopenRow,
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

  test("never accepts plan checkboxes as execution receipts and starts all gates together", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    expect(ledger.items.map((item) => item.status)).toEqual(["open", "open", "open"]);
    expect(ledger.items[0]?.acceptance).toBe("initial behavior observed");
    expect(nextDispatchable(ledger).map((item) => item.id)).toEqual(["T1"]);
    expect(() => startRow(ledger, "T2")).toThrow("unfinished");
    for (const item of ledger.items) item.status = "done";
    expect(nextDispatchable(ledger).map((item) => item.id)).toEqual(["F1", "F2", "F3", "F4"]);
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

  test("lets Atlas choose a listed agent when a removed agent has no spawnable fallback", () => {
    const custom = plan.replace("Agent: deep-low", "Agent: custom-worker");
    const ledger = createLedger("local://custom-plan.md", custom, ["task", "custom-worker"]);
    const roster = ["task", "deep-low"];
    expect(refreshDispatchAgents(ledger, roster)).toBe(true);
    expect(ledger.items[0]?.dispatchAgent).toBeUndefined();
    expect(renderLedgerSummary(ledger, roster)).toContain("custom-worker -> unavailable (choose with agent on start)");
    expect(() => startRow(ledger, "T1", undefined, roster)).toThrow("task, deep-low");
    expect(() => startRow(ledger, "T1", "custom-worker", roster)).toThrow("not a spawnable agent");
    expect(ledger.items[0]?.status).toBe("open");

    expect(startRow(ledger, "T1", "deep-low", roster).dispatchAgent).toBe("deep-low");
    expect(refreshDispatchAgents(ledger, roster)).toBe(false);
    reopenRow(ledger, "T1");
    expect(startRow(ledger, "T1", "task", roster).dispatchAgent).toBe("task");
    expect(refreshDispatchAgents(ledger, ["task", "custom-worker"])).toBe(true); // The requested agent is back.
    expect(ledger.items[0]?.dispatchAgent).toBe("custom-worker");
    expect(refreshDispatchAgents(ledger, ["deep-low"])).toBe(true); // Neither the requested nor the chosen agent remains.
    expect(ledger.items[0]?.dispatchAgent).toBeUndefined();

    if (ledger.items[0]) ledger.items[0].status = "done";
    expect(() => startRow(ledger, "T2", "deep-low", ["task", "sonic", "deep-low"])).toThrow("dispatches to sonic");
  });

  test("rejects multi-node dependency cycles before any item can dispatch", () => {
    expect(() => createLedger("local://cycle-plan.md", plan.replace("Depends on: none", "Depends on: T2"))).toThrow("cycle");
    expect(() => createLedger("local://cycle-plan.md", plan.replace("Depends on: none", "Depends on: T3"))).toThrow("cycle");
  });

  test("reopening a row discards only its attempt and keeps completed dependents and passed gates", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    for (const row of ledgerRows(ledger)) {
      row.status = "done";
      row.attempt = "old-attempt";
      row.childAgentId = "OldChild";
    }
    reopenRow(ledger, "T1");
    expect(ledgerRows(ledger).map((row) => [row.id, row.status])).toEqual([
      ["T1", "open"],
      ["T2", "done"],
      ["T3", "done"],
      ["F1", "done"],
      ["F2", "done"],
      ["F3", "done"],
      ["F4", "done"],
    ]);
    expect(ledger.items[0]?.attempt).toBeUndefined();
    expect(ledger.items[1]?.attempt).toBe("old-attempt");
    const oldAttempt = startRow(ledger, "T1").attempt;
    expect(() => startRow(ledger, "T1")).toThrow("reopen");
    reopenRow(ledger, "T1");
    expect(startRow(ledger, "T1").attempt).not.toBe(oldAttempt);
    expect(restoreLedger(ledger, ledger.planFilePath, plan, ledger.planSha256)).toBe(ledger);
  });

  test("a gate rejection appends fix rows that only that gate waits for", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    for (const row of ledger.items) row.status = "done";
    for (const gate of ledger.gates) startRow(ledger, gate.id);
    const failedAttempt = ledger.gates[1]?.attempt;
    const fix = { title: "Remove wiring tests", acceptance: "bun test passes without them", agent: "task", reason: "wiring-only tests" };
    expect(addFixRow(ledger, "F2", fix).id).toBe("X1");
    expect(addFixRow(ledger, "F2", { ...fix, title: "Stabilize snapshot retention" }).id).toBe("X2");
    const f2 = ledger.gates[1];
    expect(f2?.status).toBe("open");
    expect(f2?.attempt).not.toBe(failedAttempt);
    expect(f2?.dependsOn).toEqual(["T1", "T2", "T3", "X1", "X2"]);
    expect(ledger.gates.filter((gate) => gate.id !== "F2").every((gate) => gate.status === "in_progress" && gate.attempt)).toBe(true);
    expect(ledger.items.every((row) => row.status === "done")).toBe(true);
    expect(nextDispatchable(ledger).map((row) => row.id)).toEqual(["X1", "X2"]);
    expect(() => startRow(ledger, "F2")).toThrow("X1, X2");
    for (const row of ledger.fixes) row.status = "done";
    expect(nextDispatchable(ledger).map((row) => row.id)).toEqual(["F2"]);
    expect(restoreLedger(structuredClone(ledger), ledger.planFilePath, plan, ledger.planSha256).fixes).toHaveLength(2);
  });

  test("fix rows are refused for tasks, passed gates, missing checks, and unknown agents", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    const fix = { title: "Correct it", acceptance: "check passes", agent: "task", reason: "rejected" };
    expect(() => addFixRow(ledger, "T2", fix)).toThrow("final gate");
    if (ledger.gates[0]) ledger.gates[0].status = "done";
    expect(() => addFixRow(ledger, "F1", fix)).toThrow("already passed");
    expect(() => addFixRow(ledger, "F2", { ...fix, acceptance: " " })).toThrow("acceptance");
    expect(() => addFixRow(ledger, "F2", { ...fix, agent: "made-up-agent" })).toThrow("made-up-agent");
    expect(ledger.fixes).toEqual([]);
  });

  test("refuses fix rows whose identity or gate binding was tampered with", () => {
    const ledger = createLedger("local://example-plan.md", plan);
    addFixRow(ledger, "F3", { title: "Rerun QA fixture", acceptance: "scenario passes", agent: "task", reason: "flaky" });
    const renumbered = structuredClone(ledger);
    if (renumbered.fixes[0]) renumbered.fixes[0].id = "X2";
    expect(() => restoreLedger(renumbered, ledger.planFilePath, plan, ledger.planSha256)).toThrow("fix row");
    const rebound = structuredClone(ledger);
    if (rebound.fixes[0]) rebound.fixes[0].origin = "F1";
    expect(() => restoreLedger(rebound, ledger.planFilePath, plan, ledger.planSha256)).toThrow("Malformed");
  });

  test("upgrades a version-two ledger in place and keeps its verified progress", () => {
    const current = createLedger("local://example-plan.md", plan);
    const { fixes: _fixes, ...rest } = current;
    const legacy = {
      ...rest,
      version: 2,
      items: current.items.map((row) => ({ ...row, status: row.id === "T2" ? "open" : "done", attempt: "a", startedAt: 1 })),
      gates: current.gates.map((row) => ({ ...row, dependsOn: row.id === "F4" ? [...row.dependsOn, "F1", "F2", "F3"] : row.dependsOn })),
    };
    const restored = restoreLedger(legacy, current.planFilePath, plan, current.planSha256);
    expect(restored).toBe(legacy as unknown as typeof restored);
    expect(restored.version).toBe(4);
    expect(restored.fixes).toEqual([]);
    expect(restored.gates[3]?.dependsOn).toEqual(["T1", "T2", "T3"]);
    expect(restored.items.map((row) => row.status)).toEqual(["done", "open", "done"]);
  });

  test("upgrades a version-three ledger in place to version four without a Git baseline", () => {
    const current = createLedger("local://example-plan.md", plan);
    addFixRow(current, "F2", { title: "Tighten scope", acceptance: "scope matches", agent: "task", reason: "drift" });
    const legacy = {
      ...structuredClone(current),
      version: 3,
      items: current.items.map((row) => ({ ...row, status: row.id === "T2" ? "open" : "done", attempt: "a", startedAt: 1 })),
    };
    const restored = restoreLedger(legacy, current.planFilePath, plan, current.planSha256);
    expect(restored).toBe(legacy as unknown as typeof restored);
    expect(restored.version).toBe(4);
    expect(restored.gitBaseline).toBeUndefined();
    expect(restored.fixes.map((row) => row.id)).toEqual(["X1"]);
    expect(restored.items.map((row) => row.status)).toEqual(["done", "open", "done"]);
  });

  test("records an optional Git baseline and refuses a malformed one", () => {
    const sha = "a".repeat(40);
    const ledger = createLedger("local://example-plan.md", plan, undefined, sha);
    expect(ledger.gitBaseline).toBe(sha);
    expect(restoreLedger(ledger, ledger.planFilePath, plan, ledger.planSha256)).toBe(ledger);
    expect(createLedger("local://example-plan.md", plan, undefined, "b".repeat(64)).gitBaseline).toBe("b".repeat(64));
    expect("gitBaseline" in createLedger("local://example-plan.md", plan)).toBe(false);
    expect(() => createLedger("local://example-plan.md", plan, undefined, "HEAD")).toThrow("Git baseline");
    expect(() => restoreLedger({ ...ledger, gitBaseline: "not-a-sha" }, ledger.planFilePath, plan, ledger.planSha256)).toThrow(
      "Git baseline",
    );
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
    expect(restored.version).toBe(4);
    expect([...restored.items, ...restored.gates].every((row) => row.status === "open" && row.receipt === undefined)).toBe(true);
  });
});
