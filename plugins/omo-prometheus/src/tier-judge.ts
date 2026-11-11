import { createHash } from "node:crypto";

import type { ChoiceQuestion } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ChainJudge, type JudgmentUsageLedger, journalJudgmentUsage, resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

import type { ParsedPlan, Tier } from "./ledger.ts";

const QUESTIONS = {
  tier: {
    type: "choice",
    instructions:
      "The state describes one task of an approved software implementation plan. One agent will implement the task and show that its acceptance checks pass; the whole change is reviewed again at the end. Decide whether this task additionally needs a second, independent agent to re-verify it right after it is implemented (HEAVY), or not (LIGHT). Judge only from the task description.",
    criteria: {
      HEAVY:
        "The task changes production code or stored data, and a defect its own acceptance checks miss would plausibly cause one of: unauthorized access, a bypassed permission or policy check, a security or protection function that silently stops enforcing, or exposed secrets; loss or corruption of durably stored data; a destructive or irreversible migration or format cutover; money or paid quota charged, settled or credited wrongly; breaking existing callers of a published or cross-component contract; a concurrency defect on a production path. Or the task changes shared behavior that several other modules must change with. Or the task is by itself a very large new production subsystem.",
      LIGHT:
        "Any other task. In particular: tests, test harnesses, conformance, interop or scale suites, benchmarks, QA or evidence runs; documentation and reports; front-end presentation that calls existing server APIs; scripts, CI, build and local tooling; and production changes confined to one module whose failures show up in the task's own acceptance run, such as logging, metrics, renames, configuration parsing and additive features.",
    },
  },
  kind: {
    type: "choice",
    instructions:
      "The state describes one task of an approved software implementation plan. One agent will implement the task and show that its acceptance checks pass; the whole change is reviewed again at the end. What is the main deliverable of this task?",
    criteria: {
      production:
        "A change to production code, production data or schema that ships to users or runs in deployment, or an operation carried out on real systems or stored data, such as deleting, migrating or cutting over.",
      tests:
        "Tests, test harnesses, fixtures, conformance, interop or scale suites, benchmarks, QA walkthroughs, evidence capture or verification runs, with no production behavior change beyond test hooks.",
      docs: "Documentation, manuals, reports, notes, decision records, or committing planning files.",
      ui: "Front-end pages and components of a web or app interface that call existing server APIs, including role-gated navigation and forms.",
      tooling:
        "Developer or deployment tooling that changes no stored data: scripts, CI, build, local stacks, configuration files, dependency pinning.",
    },
  },
} satisfies Record<string, ChoiceQuestion>;

const QUESTIONS_JSON = JSON.stringify(QUESTIONS);
const CONCURRENCY = 4;
const TIMEOUT_MS = 30_000;
const UNAVAILABLE = Symbol("native-judge-unavailable");
type NativeJudge = Pick<ChainJudge, "withCandidate">;
type PlanTask = ParsedPlan["items"][number];

export interface TierJudgeSettings {
  enabled: boolean;
  minimumConfidence: number;
}

export const DEFAULT_TIER_JUDGE_SETTINGS: TierJudgeSettings = { enabled: true, minimumConfidence: 0.6 };

export function parseTierJudgeSettings(raw: Record<string, unknown>, warn: (message: string) => void): TierJudgeSettings {
  let enabled = DEFAULT_TIER_JUDGE_SETTINGS.enabled;
  let minimumConfidence = DEFAULT_TIER_JUDGE_SETTINGS.minimumConfidence;
  if (raw.tierJudge !== undefined) {
    if (typeof raw.tierJudge === "boolean") enabled = raw.tierJudge;
    else warn(`tierJudge is invalid; using true (${JSON.stringify(raw.tierJudge)})`);
  }
  if (raw.tierJudgeConfidence !== undefined) {
    const value = raw.tierJudgeConfidence;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) minimumConfidence = value;
    else warn(`tierJudgeConfidence is invalid; using 0.6 (${JSON.stringify(value)})`);
  }
  return { enabled, minimumConfidence };
}

export interface TierProbabilities {
  heavy: number;
  production: number;
}

export interface TierDecision {
  heavyProbability: number;
  confidence: number;
  tier?: Tier;
}

export function decideTier(probabilities: TierProbabilities, minimumConfidence: number): TierDecision {
  const heavyProbability = Math.min(probabilities.heavy, probabilities.production);
  const confidence = Math.abs(2 * heavyProbability - 1);
  return {
    heavyProbability,
    confidence,
    ...(confidence >= minimumConfidence ? { tier: heavyProbability >= 0.5 ? "heavy" : "light" } : {}),
  };
}

export function tierJudgeState(task: Pick<PlanTask, "title" | "bodyLines">): string {
  const body: string[] = [];
  let omittedIndent: number | undefined;
  for (const line of task.bodyLines) {
    if (!/^\s+\S/.test(line)) continue;
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (omittedIndent !== undefined && indent > omittedIndent) continue;
    omittedIndent = undefined;
    if (/^\s+(?:-\s*)?Tier(?: basis)?:/i.test(line)) {
      omittedIndent = indent;
      continue;
    }
    body.push(line.replace(/\b(HEAVY|LIGHT)\b/g, ""));
  }
  return `Task: ${task.title}\n${body.join("\n")}`.slice(0, 7000);
}

function ownerBasis(task: Pick<PlanTask, "tierBasis">): boolean {
  return /^owner\b/i.test(task.tierBasis ?? "");
}

export function evaluateTierRow(task: Pick<PlanTask, "id" | "tier" | "tierBasis">, decision?: TierDecision): string | undefined {
  if (ownerBasis(task)) return undefined;
  const basis = task.tierBasis !== undefined;
  if (!decision) {
    return basis
      ? undefined
      : `${task.id}: no native tier judgment is available. Decide LIGHT or HEAVY by the written criteria and add Tier basis: explaining the consequence of an uncaught defect, or why none applies. For an owner-decided tier, ask the user first, then record Tier basis: owner — <reason>.`;
  }
  if (decision.tier) {
    const judgment = `${decision.tier.toUpperCase()} with confidence ${decision.confidence.toFixed(3)}`;
    if (decision.tier !== (task.tier ?? "light")) {
      return `${task.id}: the judge decided ${judgment}. Change Tier: to ${decision.tier.toUpperCase()} and remove any planner basis; or ask the user to decide the tier, then record Tier basis: owner — <reason>.`;
    }
    if (basis) return `${task.id}: the judge settled ${judgment}. Remove the Tier basis: line; it is only for a planner or owner decision.`;
    return undefined;
  }
  return basis
    ? undefined
    : `${task.id}: the judge is undecided (HEAVY probability ${decision.heavyProbability.toFixed(3)}). Decide the tier by the written criteria and add Tier basis: explaining the consequence of an uncaught defect, or why none applies. For an owner-decided tier, ask the user first, then record Tier basis: owner — <reason>.`;
}

export function resolveTierJudge(ctx: ExtensionContext): ChainJudge {
  const currentSession = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
  const settings = findScopedSettings(ctx.cwd);
  if (!settings) throw new Error("the active session has no scoped Settings instance");
  return resolveJudge({
    settings,
    registry: ctx.modelRegistry,
    sessionId: ctx.sessionManager.getSessionId(),
    purpose: "prometheus-tier",
    onUsage: journalJudgmentUsage(ctx.sessionManager as unknown as Partial<JudgmentUsageLedger>),
    costGate: currentSession && isLocalAgentSession(currentSession) ? currentSession.costGate : undefined,
  });
}

export class TierJudge {
  readonly #resolve: () => NativeJudge;
  readonly #notice: (message: string) => void;
  readonly #answers = new Map<string, TierProbabilities>();
  #judge?: NativeJudge;
  #warnedUnavailable = false;

  constructor(resolve: () => NativeJudge, notice: (message: string) => void) {
    this.#resolve = resolve;
    this.#notice = notice;
  }

  #unavailable(): void {
    if (this.#warnedUnavailable) return;
    this.#warnedUnavailable = true;
    this.#notice(
      "Prometheus tier judge needs a native judge in OMP's judge role. Until one is available, every task needs a Tier basis: line.",
    );
  }

  async #query(state: string, signal: AbortSignal): Promise<TierProbabilities | typeof UNAVAILABLE | Error> {
    let reachedNative = false;
    try {
      this.#judge ??= this.#resolve();
      return await this.#judge.withCandidate<TierProbabilities | typeof UNAVAILABLE | Error>(
        async (candidate, kind) => {
          if (kind !== "native") return UNAVAILABLE;
          reachedNative = true;
          try {
            const { answers } = await candidate.judge({ state, questions: QUESTIONS }, { signal });
            return { heavy: answers.tier.probabilities.HEAVY, production: answers.kind.probabilities.production };
          } catch (error) {
            if (signal.aborted) throw error;
            return error instanceof Error ? error : new Error(String(error));
          }
        },
        { signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (!reachedNative) return UNAVAILABLE;
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  async check(tasks: readonly PlanTask[], settings: TierJudgeSettings, callerSignal?: AbortSignal): Promise<string | undefined> {
    const decisions = new Map<string, TierDecision>();
    const keys = new Map<string, string>();
    const states = new Map<string, string>();
    for (const task of tasks) {
      if (ownerBasis(task)) continue;
      const state = tierJudgeState(task);
      const key = createHash("sha256").update(state).update(QUESTIONS_JSON).digest("hex");
      keys.set(task.id, key);
      if (!this.#answers.has(key)) states.set(key, state);
    }
    if (settings.enabled && states.size) {
      const controller = new AbortController();
      const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
      const interrupted = Promise.withResolvers<never>();
      const onAbort = () => interrupted.reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new DOMException("Tier judge check exceeded 30 seconds", "TimeoutError")),
        TIMEOUT_MS,
      );
      let failure: unknown;
      try {
        signal.throwIfAborted();
        const pending = [...states];
        let next = 0;
        let stopped = false;
        const work = async () => {
          while (!stopped && next < pending.length) {
            signal.throwIfAborted();
            const entry = pending[next++];
            if (!entry) break;
            const [key, state] = entry;
            const answer = await this.#query(state, signal);
            signal.throwIfAborted();
            if (answer === UNAVAILABLE) {
              this.#unavailable();
              stopped = true;
            } else if (answer instanceof Error) {
              failure ??= answer;
              stopped = true;
            } else this.#answers.set(key, answer);
          }
        };
        await Promise.race([Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, work)), interrupted.promise]);
        signal.throwIfAborted();
      } catch (error) {
        failure ??= error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
      if (failure !== undefined) {
        this.#notice(
          `Prometheus tier judge call failed: ${failure instanceof Error ? failure.message : String(failure)}. Tasks it has not settled need a Tier basis: line for this check.`,
        );
      }
    }
    // Answers from earlier checks still bind when this check could not reach the judge.
    if (settings.enabled) {
      for (const task of tasks) {
        const key = keys.get(task.id);
        const answer = key ? this.#answers.get(key) : undefined;
        if (answer) decisions.set(task.id, decideTier(answer, settings.minimumConfidence));
      }
    }
    const reasons = tasks.flatMap((task) => {
      const reason = evaluateTierRow(task, decisions.get(task.id));
      return reason ? [reason] : [];
    });
    return reasons.length
      ? `Prometheus refused these task tiers:\n${reasons.join("\n")}\nCorrect every listed row, then dispatch the review or propose again.`
      : undefined;
  }
}
