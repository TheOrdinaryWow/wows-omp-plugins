import { expect, test } from "bun:test";

import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

import { atlasTodoPhases, mergeAtlasTodos, syncAtlasTodos } from "../plugins/omo-prometheus/src/atlas-todo.ts";
import { addFixRow, createLedger, startRow } from "../plugins/omo-prometheus/src/ledger.ts";

const plan = `# Plan
## Tasks
- [ ] T1. First deliverable
  - Agent: task
  - Depends on: none
  - Acceptance: observed result
- [ ] T2. Second deliverable
  - Agent: task
  - Depends on: T1
  - Acceptance: observed result
## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

function ledger() {
  return createLedger("/bundle/plan.md", plan, ["task"]);
}

test("Atlas phases map task, correction, and gate state without erasing parallel progress", () => {
  const state = ledger();
  startRow(state, "T1");
  const blocked = state.items.find((item) => item.id === "T2");
  if (!blocked) throw new Error("Missing T2 row");
  blocked.status = "blocked";
  blocked.evidence = `Awaiting  data\n${"x".repeat(300)}`;
  addFixRow(state, "F1", { title: "Correct defect", acceptance: "verified", agent: "task", reason: "Gate rejected" }, ["task"]);
  const phases = atlasTodoPhases(state);
  expect(phases.map((phase) => phase.name)).toEqual(["Atlas tasks", "Atlas fixes", "Atlas final gates"]);
  expect(phases[0]?.tasks).toEqual([
    { content: "T1. First deliverable", status: "in_progress" },
    { content: "T2. Second deliverable", status: "blocked", blocker: `Awaiting data ${"x".repeat(226)}` },
  ]);
  expect(phases[1]?.tasks).toEqual([{ content: "X1. Correct defect", status: "pending" }]);
  expect(phases[2]?.tasks[0]).toEqual({ content: "F1. Plan compliance review", status: "pending" });
});

test("sync replaces only Atlas phases, retains other phase positions, and skips identical snapshots", () => {
  const state = ledger();
  const personal: TodoPhase = { name: "Personal", tasks: [{ content: "Keep this", status: "in_progress" }] };
  const later: TodoPhase = { name: "Deployment", tasks: [{ content: "Release", status: "pending" }] };
  let current: TodoPhase[] = [personal, { name: "Atlas tasks", tasks: [{ content: "T1. First deliverable", status: "completed" }] }, later];
  const writes: TodoPhase[][] = [];
  const session = {
    getTodoPhases: () => current,
    setTodoPhases: (phases: TodoPhase[]) => {
      current = phases;
    },
  };
  const manager = { appendCustomEntry: (_type: string, data: { phases: TodoPhase[] }) => writes.push(data.phases) };
  expect(syncAtlasTodos(session, manager, state)).toBe(true);
  expect(current.map((phase) => phase.name)).toEqual(["Personal", "Atlas tasks", "Deployment", "Atlas final gates"]);
  expect(current[0]).toBe(personal);
  expect(current[2]).toBe(later);
  expect(current[1]?.tasks[0]?.status).toBe("pending");
  expect(writes).toHaveLength(1);
  expect(syncAtlasTodos(session, manager, state)).toBe(false);
  expect(writes).toHaveLength(1);
  startRow(state, "T1");
  const next = mergeAtlasTodos(current, state);
  expect(next?.[1]?.tasks[0]?.status).toBe("in_progress");
  expect(next?.[0]).toBe(personal);
});
