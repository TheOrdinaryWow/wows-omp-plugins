import { createHash } from "node:crypto";

import type { ChoiceQuestion } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

import type { AtlasStagePlan } from "#src/atlas.ts";
import type { Model, StageDoc } from "#src/documents.ts";
import type { Receipt } from "#src/operations.ts";
import { planModeActive, type RoadmapSession } from "#src/ses.ts";
import { readPlanningGate } from "#src/settings.ts";
import { stageReadiness } from "#src/state.ts";
import type { RoadmapUi, WorkMode } from "#src/ui.ts";

const QUESTIONS = {
  size: {
    type: "choice",
    instructions:
      "The state describes one stage of a software project roadmap: its objective, scope and done criteria. Decide whether one agent session can implement and verify this stage directly, or whether it should first get a written, reviewed implementation plan that splits it into several tasks executed and verified separately.",
    criteria: {
      plan: "The stage needs several coordinated changes across modules or components, has many done criteria or open design decisions, or involves a migration, a new subsystem, a cross-component contract or a format cutover; more than about a day of focused developer work.",
      direct:
        "The stage is a bounded change one agent can implement and verify in a single session: one module or a few files, a few done criteria and no open design decisions, such as a bug fix, a setting, a small feature, documentation or tests.",
    },
  },
} satisfies Record<string, ChoiceQuestion>;

const QUESTIONS_JSON = JSON.stringify(QUESTIONS);
const TIMEOUT_MS = 30_000;

/** The probability that the stage needs a plan, or `unavailable` when OMP's judge role reaches no native judge. */
export type StageSizeJudge = (ctx: ExtensionContext, state: string, signal: AbortSignal) => Promise<number | "unavailable">;

export const nativeStageSizeJudge: StageSizeJudge = async (ctx, state, signal) => {
  const settings = findScopedSettings(ctx.cwd);
  if (!settings) return "unavailable";
  const session = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
  const judge = resolveJudge({
    settings,
    registry: ctx.modelRegistry,
    sessionModel: ctx.model,
    sessionId: ctx.sessionManager.getSessionId(),
    purpose: "roadmap-planning-gate",
    onUsage: journalJudgmentUsage(ctx.sessionManager),
    costGate: session && isLocalAgentSession(session) ? session.costGate : undefined,
  });
  // A chat-model judge has no calibrated confidence, so only a native first candidate is ever called.
  let reachedNative = false;
  try {
    return await judge.withCandidate<number | "unavailable">(
      async (candidate, kind) => {
        if (kind !== "native") return "unavailable";
        reachedNative = true;
        const { answers } = await candidate.judge({ state, questions: QUESTIONS }, { signal });
        return answers.size.probabilities.plan;
      },
      { signal },
    );
  } catch (error) {
    if (!reachedNative && !signal.aborted) return "unavailable";
    throw error;
  }
};

export function stageSizeState(stage: StageDoc): string {
  return [
    `Stage ${stage.id}: ${stage.title}`,
    `Objective:\n${stage.objective}`,
    `In scope:\n${stage.scope_in}`,
    `Out of scope:\n${stage.scope_out}`,
    `Done criteria:\n${stage.done_criteria}`,
    stage.design_constraints && `Design constraints:\n${stage.design_constraints}`,
    stage.risks && `Risks:\n${stage.risks}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface GateRequest {
  ses: RoadmapSession;
  ctx: ExtensionContext;
  repoRoot: string;
  model: Model;
  stage: StageDoc;
  ui: RoadmapUi;
  plans: readonly AtlasStagePlan[] | undefined;
  signal?: AbortSignal;
}

function mismatch(stage: StageDoc, mode: WorkMode): string {
  return mode === "planning"
    ? `${stage.id} — ${stage.title} looks small enough to implement directly; plan mode is not needed for it.`
    : `${stage.id} — ${stage.title} looks large enough to need a plan; plan it with /prometheus or plan mode before implementing it.`;
}

function switchRefusal(stage: StageDoc, mode: WorkMode): Extract<Receipt, { ok: false }> {
  return mode === "planning"
    ? {
        ok: false,
        reason: `The user chose to implement ${stage.id} directly instead of planning it. Nothing was started or bound.`,
        hints: [
          `Stop planning. Ask the user to leave plan mode (/prometheus leaves Prometheus planning), then start ${stage.id} with roadmap_stage start and implement it directly.`,
        ],
      }
    : {
        ok: false,
        reason: `The user chose to plan ${stage.id} before implementing it. Nothing was started.`,
        hints: [
          `Do not implement ${stage.id} now. Ask the user to enter planning with /prometheus or plan mode, then start ${stage.id} there with roadmap_stage start for its planning handoff.`,
        ],
      };
}

/**
 * Checks, before a stage starts, whether its size fits how the session works on it: planning a stage small enough to
 * implement directly, or implementing a large stage without a plan, stops the start until the user decides.
 */
export class PlanningGate {
  readonly #probabilities = new Map<string, number>();
  readonly #noticed = new Set<string>();

  constructor(
    private readonly logger: Pick<ExtensionAPI["logger"], "warn">,
    private readonly judge: () => StageSizeJudge,
  ) {}

  /** A refusal when the start must stop; undefined lets it proceed. */
  async check(request: GateRequest): Promise<Receipt | undefined> {
    const { ses, ctx, repoRoot, stage } = request;
    // Joining an active stage, a stage this session already bound in plan mode, or one with an Atlas plan is past the choice.
    if (ctx.agent.kind !== "main" || !stageReadiness(request.model, stage).startable) return;
    if (ses.getBinding(repoRoot)?.stage === stage.id || request.plans?.length) return;
    const mode: WorkMode = planModeActive(ctx) ? "planning" : "direct";
    if (ses.gateAnswered(ctx, repoRoot, stage.id, mode)) return;
    const settings = await readPlanningGate(ctx.cwd, this.logger);
    if (!settings.enabled) return;
    const probability = await this.#probability(request);
    if (probability === undefined || Math.abs(2 * probability - 1) < settings.minimumConfidence) return;
    if (probability >= 0.5 === (mode === "planning")) return;
    if (!request.ui.interactive)
      return {
        ok: false,
        reason: `${mismatch(stage, mode)} Nothing was started: no dialog can ask the user.`,
        hints: [
          `Tell the user. To start it ${mode === "planning" ? "in plan mode" : "without a plan"} anyway, the user runs /roadmap proceed ${stage.id}; then call roadmap_stage start again.`,
          switchRefusal(stage, mode).hints[0] as string,
        ],
      };
    const answer = await request.ui.planningGate({ stage: { id: stage.id, title: stage.title }, mode });
    if (request.signal?.aborted) return { ok: false, reason: "Stage start cancelled; nothing was started.", hints: [] };
    if (answer === "proceed") {
      ses.answerGate(ctx, repoRoot, stage.id, mode);
      return;
    }
    if (answer === "switch") return switchRefusal(stage, mode);
    return {
      ok: false,
      reason: `Stage start cancelled at the planning check; nothing was started. ${mismatch(stage, mode)}`,
      hints: [`Ask the user how to proceed with ${stage.id}.`],
    };
  }

  async #probability({ ctx, stage, ui, signal: caller }: GateRequest): Promise<number | undefined> {
    const state = stageSizeState(stage);
    const key = createHash("sha256").update(state).update(QUESTIONS_JSON).digest("hex");
    const cached = this.#probabilities.get(key);
    if (cached !== undefined) return cached;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    const notice = (message: string): void => {
      const session = ctx.sessionManager.getSessionId();
      if (this.#noticed.has(session)) return;
      this.#noticed.add(session);
      ui.notify(message, "warning");
    };
    try {
      const answer = await this.judge()(ctx, state, signal);
      if (answer === "unavailable") {
        notice(
          "The roadmap planning check needs a native judge in OMP's judge role; stages start without the size check until one is available.",
        );
        return undefined;
      }
      this.#probabilities.set(key, answer);
      return answer;
    } catch (error) {
      if (caller?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("roadmap planning gate judge failed", { error: message });
      notice(`The roadmap planning check could not judge ${stage.id} (${message}); the stage starts without it.`);
      return undefined;
    }
  }
}
