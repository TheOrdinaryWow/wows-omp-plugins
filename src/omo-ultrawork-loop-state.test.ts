import { describe, expect, test } from "bun:test";

import {
  acquireGoal,
  appendGoal,
  createLoop,
  event,
  type GoalSeed,
  steer,
  upgradeLoopState,
  validateBatches,
} from "../plugins/omo-ultrawork/src/ulw-loop-state.ts";

const seed: GoalSeed = {
  title: "Upload restart",
  objective: "An upload survives restart",
  shape: "delivery",
  tier: "LIGHT",
  criteria: [{ scenario: "Restart during upload", expectedEvidence: "A resumed upload keeps its bytes" }],
};
const finding = {
  source: "finding" as const,
  evidence: "Restart QA exposed a missing recovery boundary",
  rationale: "Split the storage and resume behaviors so each has observable proof",
};
function state() {
  const value = createLoop("session-1", "/tmp/project", "Deliver restart-safe upload");
  value.status = "active";
  value.driver.goalId = "native-1";
  return value;
}

describe("ulw-loop state v1", () => {
  test("stable goal ids, one acquired goal, explicit failed retries and no-eligible is not success", () => {
    const value = state();
    appendGoal(value, seed);
    appendGoal(value, { ...seed, title: "Second boundary" });
    expect(value.goals.map((goal) => goal.id)).toEqual(["G001", "G002"]);
    expect(value.goals[0]?.criteria[0]?.id).toBe("C001");
    const first = acquireGoal(value);
    expect(first.goal).toMatchObject({ id: "G001", attempt: 1, status: "in_progress" });
    expect(acquireGoal(value).goal).toBe(first.goal);
    expect(first.goal?.attempt).toBe(1);
    if (!first.goal) throw new Error("missing goal");
    first.goal.status = "failed";
    value.activeGoalId = undefined;
    const second = acquireGoal(value).goal;
    expect(second?.id).toBe("G002");
    if (!second) throw new Error("missing second goal");
    second.status = "blocked";
    value.activeGoalId = undefined;
    expect(acquireGoal(value)).toEqual({ noEligibleWork: true, aggregateComplete: false });
    expect(acquireGoal(value, true).goal).toMatchObject({ id: "G001", attempt: 2 });
  });

  test("seven steering kinds preserve ids and supersession/batch links", () => {
    const value = state();
    appendGoal(value, seed);
    appendGoal(value, { ...seed, title: "QA closer" });
    value.validationBatches = [{ id: "B1", goalIds: ["G001", "G002"], finalGoalId: "G002" }];
    steer(value, { ...finding, kind: "add_subgoal", ...seed, title: "Documentation" });
    steer(value, { ...finding, kind: "reorder_pending", pendingOrder: ["G003", "G001", "G002"] });
    expect(value.goals.map((goal) => goal.id)).toEqual(["G003", "G001", "G002"]);
    steer(value, { ...finding, kind: "revise_pending_wording", targetGoalId: "G003", revisedTitle: "User documentation" });
    expect(value.goals[0]?.title).toBe("User documentation");
    steer(value, { ...finding, kind: "revise_criterion", goalId: "G001", criterionId: "C001", scenario: "Restart after checkpoint" });
    expect(value.goals.find((goal) => goal.id === "G001")?.criteria[0]?.revision).toBe(2);
    steer(value, {
      ...finding,
      kind: "split_subgoal",
      targetGoalId: "G001",
      childGoals: [
        { ...seed, title: "Storage" },
        { ...seed, title: "Resume" },
      ],
    });
    expect(value.goals.find((goal) => goal.id === "G001")).toMatchObject({ status: "superseded", replacedBy: ["G004", "G005"] });
    expect(value.validationBatches[0]?.goalIds).toEqual(["G004", "G005", "G002"]);
    steer(value, { ...finding, kind: "mark_blocked_superseded", targetGoalId: "G002", childGoals: [{ ...seed, title: "New closer" }] });
    expect(value.validationBatches[0]).toMatchObject({ goalIds: ["G004", "G005", "G006"], finalGoalId: "G006" });
    steer(value, { ...finding, kind: "annotate_ledger" });
    expect(value.events).toHaveLength(7);
    expect(upgradeLoopState(JSON.parse(JSON.stringify(value)), "session-1", "/tmp/project")).toEqual(value);
  });

  test("invalid steering does not reach the store, blocks do not count as completion, criterion history survives revision", () => {
    const value = state();
    const goal = appendGoal(value, seed);
    acquireGoal(value);
    expect(() => steer(value, { ...finding, kind: "split_subgoal", targetGoalId: goal.id, childGoals: [seed] })).toThrow("pending");
    expect(() => steer(value, { ...finding, kind: "reorder_pending", pendingOrder: [goal.id] })).toThrow("permutation");
    goal.criteria[0]?.evidenceHistory.push({
      id: "capture-1",
      goalAttempt: 1,
      criterionRevision: 1,
      status: "pass",
      capturedAt: new Date().toISOString(),
      evidence: "Original attempt",
      artifacts: [],
      binding: { kind: "artifacts" },
    });
    steer(value, {
      ...finding,
      kind: "revise_criterion",
      goalId: goal.id,
      criterionId: "C001",
      expectedEvidence: "Restart transcript plus checksum",
    });
    expect(goal.criteria[0]?.evidenceHistory[0]?.criterionRevision).toBe(1);
    expect(goal.criteria[0]?.revision).toBe(2);
    steer(value, { ...finding, kind: "mark_blocked_superseded", targetGoalId: goal.id, blockedReason: "Need user test credentials" });
    expect(value.status).toBe("blocked");
    value.status = "active";
    expect(acquireGoal(value)).toEqual({ noEligibleWork: true, aggregateComplete: false });
  });

  test("batch membership and completed state are validated instead of inventing success", () => {
    const value = state();
    appendGoal(value, seed);
    value.validationBatches = [{ id: "B1", goalIds: ["G001"], finalGoalId: "G002" }];
    expect(() => validateBatches(value)).toThrow("closer");
    value.validationBatches = [];
    value.status = "complete";
    expect(() => upgradeLoopState(value, "session-1", "/tmp/project")).toThrow("completion");
    value.status = "active";
    event(value, "test_snapshot");
    expect(() => upgradeLoopState({ ...value, version: 99 }, "session-1", "/tmp/project")).toThrow("version");
    expect(() => upgradeLoopState(value, "other-session", "/tmp/project")).toThrow("another session");
  });
});
