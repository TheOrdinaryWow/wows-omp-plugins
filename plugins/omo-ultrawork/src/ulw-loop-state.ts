import { randomUUID } from "node:crypto";

export type LoopStatus = "active" | "paused" | "blocked" | "complete" | "stopped";
export type GoalStatus = "pending" | "in_progress" | "complete" | "failed" | "blocked" | "superseded";
export type EvidenceStatus = "pass" | "fail" | "blocked";
export type UserModel = "happy" | "edge" | "regression" | "adversarial";
export interface CriterionSeed {
  scenario: string;
  expectedEvidence: string;
  essential?: boolean;
  userModel?: UserModel;
}
export interface GoalSeed {
  title: string;
  objective: string;
  shape: "delivery" | "research";
  tier: "LIGHT" | "HEAVY";
  criteria: CriterionSeed[];
}
export interface EvidenceArtifact {
  path: string;
  originalPath: string;
  sha256: string;
  bytes: number;
}
export interface EvidenceBinding {
  kind: "git-tree" | "artifacts";
  treeHash?: string;
}
export interface EvidenceCapture {
  id: string;
  goalAttempt: number;
  criterionRevision: number;
  status: EvidenceStatus;
  capturedAt: string;
  evidence: string;
  notes?: string;
  artifacts: EvidenceArtifact[];
  binding: EvidenceBinding;
}
export interface LoopCriterion extends Required<CriterionSeed> {
  id: string;
  revision: number;
  evidenceHistory: EvidenceCapture[];
}
export interface LoopGoal extends Omit<GoalSeed, "criteria"> {
  id: string;
  status: GoalStatus;
  attempt: number;
  criteria: LoopCriterion[];
  replaces?: string;
  replacedBy?: string[];
  blockedReason?: string;
  repairFor?: string;
}
export interface ValidationBatch {
  id: string;
  goalIds: string[];
  finalGoalId: string;
}
export interface QualityGateReceipt {
  path: string;
  sha256: string;
  binding: EvidenceBinding;
  captureIds: string[];
  artifacts: EvidenceArtifact[];
  reviewAgentId: string;
}
export interface LoopState {
  version: 1;
  sessionId: string;
  runId: string;
  cwd: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  status: LoopStatus;
  brief: string;
  briefPath?: string;
  objective: string;
  driver: { kind: "native-goal"; pendingObjective: string; goalId?: string };
  activeGoalId?: string;
  goals: LoopGoal[];
  validationBatches: ValidationBatch[];
  events: { id: string; at: string; kind: string; payload: Record<string, unknown> }[];
  gates: { goalId: string; receipt: QualityGateReceipt }[];
  completion?: { at: string; evidence: string; nativeNotified: boolean; eventNotified: boolean };
  pauseReason?: string;
}

export class LoopError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LoopError";
  }
}
export function requireLoop(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new LoopError(code, message);
}
export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function event(state: LoopState, kind: string, payload: Record<string, unknown> = {}): void {
  const at = new Date().toISOString();
  state.updatedAt = at;
  state.revision++;
  state.events.push({ id: `E${String(state.events.length + 1).padStart(5, "0")}`, at, kind, payload });
}
export function createLoop(sessionId: string, cwd: string, objective: string): LoopState {
  requireLoop(nonempty(objective), "ULW_LOOP_OBJECTIVE_REQUIRED", "Supply a concrete loop objective.");
  const runId = randomUUID();
  const at = new Date().toISOString();
  return {
    version: 1,
    sessionId,
    runId,
    cwd,
    revision: 0,
    createdAt: at,
    updatedAt: at,
    status: "paused",
    brief: "",
    objective,
    driver: { kind: "native-goal", pendingObjective: `ULW loop [${runId}]: ${objective}` },
    goals: [],
    validationBatches: [],
    events: [],
    gates: [],
    pauseReason: "Native goal creation pending; use /ulw-loop resume if interrupted.",
  };
}
export function goalById(state: LoopState, id: string): LoopGoal {
  const goal = state.goals.find((candidate) => candidate.id === id);
  requireLoop(goal, "ULW_LOOP_GOAL_UNKNOWN", `No loop goal ${id}. Read ulw_loop status for current ids.`);
  return goal;
}
export function criterionById(goal: LoopGoal, id: string): LoopCriterion {
  const criterion = goal.criteria.find((candidate) => candidate.id === id);
  requireLoop(criterion, "ULW_LOOP_CRITERION_UNKNOWN", `No criterion ${id} on ${goal.id}.`);
  return criterion;
}
export function editable(state: LoopState): void {
  requireLoop(
    state.status !== "complete",
    "ULW_LOOP_PLAN_EXISTS_COMPLETE",
    "This session's loop is complete and read-only. Use a new session for unrelated work.",
  );
  requireLoop(
    state.status !== "stopped",
    "ULW_LOOP_STOPPED",
    "The loop was stopped without success. Explicitly resume it before mutating goals.",
  );
}
export function validateSeed(seed: GoalSeed): void {
  requireLoop(
    nonempty(seed.title) && nonempty(seed.objective),
    "ULW_LOOP_SEED_INVALID",
    "Every goal needs a concrete title and objective.",
  );
  requireLoop(
    ["delivery", "research"].includes(seed.shape) && ["LIGHT", "HEAVY"].includes(seed.tier),
    "ULW_LOOP_SEED_INVALID",
    "Invalid goal shape or tier.",
  );
  requireLoop(
    Array.isArray(seed.criteria) && seed.criteria.length > 0,
    "ULW_LOOP_CRITERIA_REQUIRED",
    "Every goal needs at least one concrete criterion.",
  );
  for (const criterion of seed.criteria) {
    requireLoop(
      nonempty(criterion.scenario) && nonempty(criterion.expectedEvidence),
      "ULW_LOOP_SEED_INVALID",
      "Criteria need a scenario and expected evidence.",
    );
    requireLoop(
      criterion.essential === undefined || typeof criterion.essential === "boolean",
      "ULW_LOOP_SEED_INVALID",
      "essential must be boolean.",
    );
    requireLoop(
      criterion.userModel === undefined || ["happy", "edge", "regression", "adversarial"].includes(criterion.userModel),
      "ULW_LOOP_SEED_INVALID",
      "Invalid criterion userModel.",
    );
  }
}
export function appendGoal(state: LoopState, seed: GoalSeed): LoopGoal {
  editable(state);
  validateSeed(seed);
  const goal: LoopGoal = {
    ...seed,
    id: `G${String(state.goals.length + 1).padStart(3, "0")}`,
    status: "pending",
    attempt: 0,
    criteria: seed.criteria.map((criterion, index) => ({
      ...criterion,
      id: `C${String(index + 1).padStart(3, "0")}`,
      essential: criterion.essential ?? true,
      userModel: criterion.userModel ?? "happy",
      revision: 1,
      evidenceHistory: [],
    })),
  };
  state.goals.push(goal);
  return goal;
}
export function validateBatches(state: LoopState): void {
  const batchIds = new Set<string>();
  for (const batch of state.validationBatches) {
    requireLoop(
      nonempty(batch.id) && !batchIds.has(batch.id),
      "ULW_LOOP_BATCH_INVALID",
      "Validation batch ids must be unique and non-empty.",
    );
    batchIds.add(batch.id);
    requireLoop(
      batch.goalIds.length > 0 && new Set(batch.goalIds).size === batch.goalIds.length,
      "ULW_LOOP_BATCH_INVALID",
      "A batch needs unique members.",
    );
    requireLoop(batch.goalIds.includes(batch.finalGoalId), "ULW_LOOP_BATCH_INVALID", "A batch closer must be one of its members.");
    for (const id of batch.goalIds) goalById(state, id);
  }
}
export function acquireGoal(
  state: LoopState,
  retryFailed = false,
): { goal?: LoopGoal; noEligibleWork: boolean; aggregateComplete: boolean } {
  if (state.status === "complete") return { noEligibleWork: true, aggregateComplete: true };
  editable(state);
  requireLoop(state.status === "active", "ULW_LOOP_NOT_ACTIVE", "Resume the loop before acquiring work.");
  let goal = state.goals.find((candidate) => candidate.status === "in_progress");
  goal ??= state.goals.find((candidate) => candidate.status === "pending" || (retryFailed && candidate.status === "failed"));
  if (!goal) return { noEligibleWork: true, aggregateComplete: false };
  if (goal.status !== "in_progress") {
    goal.status = "in_progress";
    goal.attempt++;
    state.activeGoalId = goal.id;
    event(state, "goal_acquired", { goalId: goal.id, attempt: goal.attempt });
  }
  return { goal, noEligibleWork: false, aggregateComplete: false };
}

export type Steering = { source: "finding"; evidence: string; rationale: string } & (
  | ({ kind: "add_subgoal" } & GoalSeed)
  | { kind: "split_subgoal"; targetGoalId: string; childGoals: GoalSeed[] }
  | { kind: "reorder_pending"; pendingOrder: string[] }
  | { kind: "revise_pending_wording"; targetGoalId: string; revisedTitle?: string; revisedObjective?: string }
  | { kind: "revise_criterion"; goalId: string; criterionId: string; scenario?: string; expectedEvidence?: string; userModel?: UserModel }
  | { kind: "annotate_ledger" }
  | { kind: "mark_blocked_superseded"; targetGoalId: string; childGoals?: GoalSeed[]; blockedReason?: string }
);
export function steer(state: LoopState, change: Steering): void {
  editable(state);
  requireLoop(
    change.source === "finding" && nonempty(change.evidence) && nonempty(change.rationale),
    "ULW_LOOP_STEERING_INVALID",
    "Steering needs finding evidence and rationale.",
  );
  switch (change.kind) {
    case "add_subgoal":
      appendGoal(state, change);
      break;
    case "reorder_pending": {
      const pending = state.goals.filter((goal) => goal.status === "pending");
      requireLoop(
        change.pendingOrder.length === pending.length &&
          new Set(change.pendingOrder).size === pending.length &&
          pending.every((goal) => change.pendingOrder.includes(goal.id)),
        "ULW_LOOP_STEERING_INVALID",
        "pendingOrder must be a complete permutation of pending ids.",
      );
      const order = change.pendingOrder.map((id) => goalById(state, id));
      let index = 0;
      state.goals = state.goals.map((goal) => (goal.status === "pending" ? (order[index++] as LoopGoal) : goal));
      break;
    }
    case "revise_pending_wording": {
      const goal = goalById(state, change.targetGoalId);
      requireLoop(goal.status === "pending", "ULW_LOOP_STEERING_INVALID", "Only pending goal wording may change.");
      requireLoop(
        nonempty(change.revisedTitle) || nonempty(change.revisedObjective),
        "ULW_LOOP_STEERING_INVALID",
        "Supply revisedTitle or revisedObjective.",
      );
      if (change.revisedTitle !== undefined) {
        requireLoop(nonempty(change.revisedTitle), "ULW_LOOP_STEERING_INVALID", "Revised title cannot be empty.");
        goal.title = change.revisedTitle;
      }
      if (change.revisedObjective !== undefined) {
        requireLoop(nonempty(change.revisedObjective), "ULW_LOOP_STEERING_INVALID", "Revised objective cannot be empty.");
        goal.objective = change.revisedObjective;
      }
      break;
    }
    case "revise_criterion": {
      const goal = goalById(state, change.goalId);
      requireLoop(goal.status !== "superseded", "ULW_LOOP_STEERING_INVALID", "Cannot revise a superseded goal.");
      const criterion = criterionById(goal, change.criterionId);
      requireLoop(
        change.scenario !== undefined || change.expectedEvidence !== undefined || change.userModel !== undefined,
        "ULW_LOOP_STEERING_INVALID",
        "Supply a criterion field to revise.",
      );
      if (change.scenario !== undefined) {
        requireLoop(nonempty(change.scenario), "ULW_LOOP_STEERING_INVALID", "Scenario cannot be empty.");
        criterion.scenario = change.scenario;
      }
      if (change.expectedEvidence !== undefined) {
        requireLoop(nonempty(change.expectedEvidence), "ULW_LOOP_STEERING_INVALID", "Expected evidence cannot be empty.");
        criterion.expectedEvidence = change.expectedEvidence;
      }
      if (change.userModel !== undefined) criterion.userModel = change.userModel;
      criterion.revision++;
      if (goal.status === "complete") goal.status = "pending";
      state.gates = state.gates.filter((gate) => gate.goalId !== goal.id);
      break;
    }
    case "split_subgoal":
    case "mark_blocked_superseded": {
      const goal = goalById(state, change.targetGoalId);
      requireLoop(
        goal.status !== "complete" && goal.status !== "superseded",
        "ULW_LOOP_STEERING_INVALID",
        "Cannot replace completed or superseded work.",
      );
      if (change.kind === "split_subgoal")
        requireLoop(goal.status === "pending", "ULW_LOOP_STEERING_INVALID", "Only pending goals may be split.");
      const seeds = change.childGoals ?? [];
      requireLoop(
        seeds.length > 0 || (change.kind === "mark_blocked_superseded" && nonempty(change.blockedReason)),
        "ULW_LOOP_STEERING_INVALID",
        "Provide replacement goals or a concrete blockedReason.",
      );
      seeds.forEach(validateSeed);
      const children = seeds.map((seed) => appendGoal(state, seed));
      goal.status = children.length ? "superseded" : "blocked";
      if (change.kind === "mark_blocked_superseded") goal.blockedReason = change.blockedReason ?? change.rationale;
      goal.replacedBy = children.map((child) => child.id);
      for (const child of children) child.replaces = goal.id;
      if (state.activeGoalId === goal.id) state.activeGoalId = undefined;
      for (const batch of state.validationBatches) {
        if (!children.length || !batch.goalIds.includes(goal.id)) continue;
        batch.goalIds = batch.goalIds.flatMap((id) => (id === goal.id ? children.map((child) => child.id) : [id]));
        if (batch.finalGoalId === goal.id) batch.finalGoalId = (children.at(-1) as LoopGoal).id;
      }
      if (!children.length) state.status = "blocked";
      break;
    }
    case "annotate_ledger":
      break;
  }
  event(state, "steering", { ...change });
}

/** The only shipped loop format is v1; future versions add explicit upgrades here. */
export function upgradeLoopState(raw: unknown, sessionId: string, cwd: string): LoopState {
  const invalid = (condition: unknown, message: string): void => requireLoop(condition, "ULW_LOOP_STATE_INVALID", message);
  invalid(raw !== null && typeof raw === "object", "Loop state is not an object; preserve it and repair the store.");
  const state = raw as LoopState;
  requireLoop(
    state.version === 1,
    "ULW_LOOP_STATE_VERSION",
    `Unsupported loop state version ${String(state.version)}; do not overwrite the store.`,
  );
  invalid(state.sessionId === sessionId && state.cwd === cwd, "Loop state belongs to another session or working directory.");
  invalid(
    nonempty(state.runId) && nonempty(state.objective) && Number.isInteger(state.revision) && state.revision >= 0,
    "Invalid loop identity or revision.",
  );
  invalid(typeof state.brief === "string" && nonempty(state.createdAt) && nonempty(state.updatedAt), "Invalid loop brief or timestamps.");
  invalid(["active", "paused", "blocked", "complete", "stopped"].includes(state.status), "Invalid loop status.");
  invalid(state.driver?.kind === "native-goal" && nonempty(state.driver.pendingObjective), "Invalid native driver intent.");
  invalid(state.driver.goalId === undefined || nonempty(state.driver.goalId), "Invalid native goal id.");
  invalid(
    Array.isArray(state.goals) && Array.isArray(state.events) && Array.isArray(state.validationBatches) && Array.isArray(state.gates),
    "Missing loop collections.",
  );
  const ids = new Set<string>();
  for (const goal of state.goals) {
    validateSeed(goal);
    invalid(/^G\d{3,}$/.test(goal.id) && !ids.has(goal.id), "Invalid or duplicate goal id.");
    ids.add(goal.id);
    invalid(
      ["pending", "in_progress", "complete", "failed", "blocked", "superseded"].includes(goal.status) &&
        Number.isInteger(goal.attempt) &&
        goal.attempt >= 0,
      "Invalid goal state or attempt.",
    );
    const criteria = new Set<string>();
    for (const criterion of goal.criteria) {
      invalid(
        /^C\d{3,}$/.test(criterion.id) && !criteria.has(criterion.id) && Number.isInteger(criterion.revision) && criterion.revision > 0,
        "Invalid criterion id or definition revision.",
      );
      criteria.add(criterion.id);
      invalid(typeof criterion.essential === "boolean" && Array.isArray(criterion.evidenceHistory), "Invalid criterion evidence history.");
      for (const capture of criterion.evidenceHistory) {
        invalid(nonempty(capture.id) && nonempty(capture.evidence) && nonempty(capture.capturedAt), "Invalid evidence capture identity.");
        invalid(
          Number.isInteger(capture.goalAttempt) &&
            capture.goalAttempt > 0 &&
            Number.isInteger(capture.criterionRevision) &&
            capture.criterionRevision > 0,
          "Invalid evidence attempt or criterion revision.",
        );
        invalid(
          ["pass", "fail", "blocked"].includes(capture.status) && ["git-tree", "artifacts"].includes(capture.binding?.kind),
          "Invalid evidence status or binding.",
        );
        invalid(
          capture.binding.kind !== "git-tree" || /^[a-f0-9]{40,64}$/.test(capture.binding.treeHash ?? ""),
          "Invalid Git tree binding.",
        );
        invalid(Array.isArray(capture.artifacts), "Invalid evidence artifacts.");
        for (const artifact of capture.artifacts)
          invalid(
            nonempty(artifact.path) &&
              nonempty(artifact.originalPath) &&
              /^[a-f0-9]{64}$/.test(artifact.sha256) &&
              Number.isInteger(artifact.bytes) &&
              artifact.bytes > 0,
            "Invalid evidence artifact.",
          );
      }
    }
  }
  invalid(state.goals.filter((goal) => goal.status === "in_progress").length <= 1, "Multiple goals are in progress.");
  invalid(
    state.activeGoalId === undefined || state.goals.some((goal) => goal.id === state.activeGoalId && goal.status === "in_progress"),
    "Active goal cursor is invalid.",
  );
  for (const item of state.events)
    invalid(
      nonempty(item.id) && nonempty(item.at) && nonempty(item.kind) && item.payload !== null && typeof item.payload === "object",
      "Invalid journal entry.",
    );
  for (const gate of state.gates)
    invalid(
      ids.has(gate.goalId) &&
        nonempty(gate.receipt?.path) &&
        /^[a-f0-9]{64}$/.test(gate.receipt.sha256) &&
        Array.isArray(gate.receipt.captureIds) &&
        Array.isArray(gate.receipt.artifacts) &&
        nonempty(gate.receipt.reviewAgentId),
      "Invalid quality gate receipt.",
    );
  validateBatches(state);
  invalid(
    state.status !== "complete" ||
      (state.completion &&
        nonempty(state.completion.at) &&
        nonempty(state.completion.evidence) &&
        typeof state.completion.nativeNotified === "boolean" &&
        typeof state.completion.eventNotified === "boolean" &&
        state.goals.length > 0 &&
        state.goals.every((goal) => goal.status === "complete" || goal.status === "superseded")),
    "Completed loop lacks its completion record.",
  );
  return state;
}
