import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type { EvidenceStatus, GoalSeed, Steering, ValidationBatch } from "#src/ulw-loop-state.ts";

export type LoopParameters =
  | { op: "help" | "status" }
  | { op: "create_goals"; briefPath: string; objective: string; goals: GoalSeed[]; validationBatches?: ValidationBatch[] }
  | { op: "complete_goals"; retryFailed?: boolean }
  | { op: "criteria"; goalId: string }
  | {
      op: "record_evidence";
      goalId: string;
      criterionId: string;
      status: EvidenceStatus;
      evidence: string;
      artifacts: string[];
      notes?: string;
    }
  | { op: "checkpoint"; printTemplate: true; goalId?: string }
  | { op: "checkpoint"; goalId: string; status: "complete" | "failed" | "blocked"; evidence: string; qualityGatePath?: string }
  | ({ op: "steer" } & Steering)
  | ({ op: "add_goal" } & GoalSeed)
  | { op: "record_review_blockers"; goalId: string; title: string; objective: string; evidence: string; artifacts: string[] }
  | { op: "pause" | "resume" | "stop"; reason?: string };

/** Strict operation/steering unions keep typos and unrelated fields out of durable state. */
export function loopParameters(pi: ExtensionAPI) {
  const z = pi.zod;
  const text = z.string().trim().min(1);
  const criterion = z
    .object({
      scenario: text,
      expectedEvidence: text,
      essential: z.boolean().optional(),
      userModel: z.enum(["happy", "edge", "regression", "adversarial"]).optional(),
    })
    .strict();
  const seed = {
    title: text,
    objective: text,
    shape: z.enum(["delivery", "research"]),
    tier: z.enum(["LIGHT", "HEAVY"]),
    criteria: z.array(criterion).min(1),
  };
  const goal = z.object(seed).strict();
  const finding = { op: z.literal("steer"), source: z.literal("finding"), evidence: text, rationale: text };
  const steering = z.union([
    z.object({ ...finding, kind: z.literal("add_subgoal"), ...seed }).strict(),
    z.object({ ...finding, kind: z.literal("split_subgoal"), targetGoalId: text, childGoals: z.array(goal).min(1) }).strict(),
    z.object({ ...finding, kind: z.literal("reorder_pending"), pendingOrder: z.array(text) }).strict(),
    z
      .object({
        ...finding,
        kind: z.literal("revise_pending_wording"),
        targetGoalId: text,
        revisedTitle: text.optional(),
        revisedObjective: text.optional(),
      })
      .strict(),
    z
      .object({
        ...finding,
        kind: z.literal("revise_criterion"),
        goalId: text,
        criterionId: text,
        scenario: text.optional(),
        expectedEvidence: text.optional(),
        userModel: z.enum(["happy", "edge", "regression", "adversarial"]).optional(),
      })
      .strict(),
    z.object({ ...finding, kind: z.literal("annotate_ledger") }).strict(),
    z
      .object({
        ...finding,
        kind: z.literal("mark_blocked_superseded"),
        targetGoalId: text,
        childGoals: z.array(goal).optional(),
        blockedReason: text.optional(),
      })
      .strict(),
  ]);
  const checkpoint = z.union([
    z.object({ op: z.literal("checkpoint"), printTemplate: z.literal(true), goalId: text.optional() }).strict(),
    z
      .object({
        op: z.literal("checkpoint"),
        goalId: text,
        status: z.enum(["complete", "failed", "blocked"]),
        evidence: text,
        qualityGatePath: text.optional(),
      })
      .strict(),
  ]);
  // The two checkpoint shapes share an op; Zod's union preserves their mutually exclusive payloads.
  return z.union([
    z.object({ op: z.literal("help") }).strict(),
    z.object({ op: z.literal("status") }).strict(),
    z
      .object({
        op: z.literal("create_goals"),
        briefPath: text,
        objective: text,
        goals: z.array(goal).min(1),
        validationBatches: z.array(z.object({ id: text, goalIds: z.array(text).min(1), finalGoalId: text }).strict()).optional(),
      })
      .strict(),
    z.object({ op: z.literal("complete_goals"), retryFailed: z.boolean().optional() }).strict(),
    z.object({ op: z.literal("criteria"), goalId: text }).strict(),
    z
      .object({
        op: z.literal("record_evidence"),
        goalId: text,
        criterionId: text,
        status: z.enum(["pass", "fail", "blocked"]),
        evidence: text,
        artifacts: z.array(text),
        notes: text.optional(),
      })
      .strict(),
    checkpoint,
    steering,
    z.object({ op: z.literal("add_goal"), ...seed }).strict(),
    z
      .object({
        op: z.literal("record_review_blockers"),
        goalId: text,
        title: text,
        objective: text,
        evidence: text,
        artifacts: z.array(text).min(1),
      })
      .strict(),
    ...(["pause", "resume", "stop"] as const).map((op) => z.object({ op: z.literal(op), reason: text.optional() }).strict()),
  ]);
}
