import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ContractEvents } from "./adr.ts";
import { parseDoneCriteria, planningRevision, type StageDoc } from "./documents.ts";

export type DeferredDisposition = "todo" | "duplicate" | "wontfix" | "report";

/** One Atlas plan bundle bound to a roadmap stage, as omo-prometheus answers `atlas:plans` (contract v1). */
export interface AtlasStagePlan {
  planId: string;
  name: string;
  repoRoot: string;
  stage: string;
  /** Declared coverage; absent when the approval predates `Roadmap criteria:` or the binding carried no criteria. */
  criteria?: string[];
  /** The stage's planning-basis revision when the plan was approved. */
  revision?: string;
  status: "unfinished" | "complete";
  done: number;
  total: number;
  gates: Array<{ gateId: string; verdict: string; summary: string }>;
  delivery?: { mode: "pr" | "ship"; summary: string };
  deferred: Array<{ id: string; title: string; disposition?: DeferredDisposition; reference?: string }>;
  directory: string;
}

const DISPOSITIONS: Readonly<Record<string, true>> = { todo: true, duplicate: true, wontfix: true, report: true };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates every field of one answered plan and keeps only contract fields; undefined when anything is malformed. */
function stagePlan(value: unknown): AtlasStagePlan | undefined {
  if (
    !object(value) ||
    typeof value.planId !== "string" ||
    !value.planId ||
    typeof value.name !== "string" ||
    typeof value.repoRoot !== "string" ||
    typeof value.stage !== "string" ||
    !/^S\d+$/.test(value.stage) ||
    (value.status !== "unfinished" && value.status !== "complete") ||
    !count(value.done) ||
    !count(value.total) ||
    value.done > value.total ||
    typeof value.directory !== "string" ||
    !isAbsolute(value.directory) ||
    !Array.isArray(value.gates) ||
    !Array.isArray(value.deferred)
  )
    return undefined;
  const criteria = value.criteria;
  if (
    criteria !== undefined &&
    (!Array.isArray(criteria) ||
      !criteria.every((id) => typeof id === "string" && /^DC[1-9]\d*$/.test(id)) ||
      new Set(criteria).size !== criteria.length)
  )
    return undefined;
  if (value.revision !== undefined && (typeof value.revision !== "string" || !/^[0-9a-f]{64}$/.test(value.revision))) return undefined;
  const gates: AtlasStagePlan["gates"] = [];
  for (const gate of value.gates) {
    if (!object(gate) || typeof gate.gateId !== "string" || typeof gate.verdict !== "string" || typeof gate.summary !== "string")
      return undefined;
    gates.push({ gateId: gate.gateId, verdict: gate.verdict, summary: gate.summary });
  }
  let delivery: AtlasStagePlan["delivery"];
  if (value.delivery !== undefined) {
    if (
      !object(value.delivery) ||
      (value.delivery.mode !== "pr" && value.delivery.mode !== "ship") ||
      typeof value.delivery.summary !== "string"
    )
      return undefined;
    delivery = { mode: value.delivery.mode, summary: value.delivery.summary };
  }
  const deferred: AtlasStagePlan["deferred"] = [];
  for (const finding of value.deferred) {
    if (
      !object(finding) ||
      typeof finding.id !== "string" ||
      !finding.id ||
      typeof finding.title !== "string" ||
      (finding.disposition !== undefined &&
        (typeof finding.disposition !== "string" || !Object.hasOwn(DISPOSITIONS, finding.disposition))) ||
      (finding.reference !== undefined && typeof finding.reference !== "string")
    )
      return undefined;
    deferred.push({
      id: finding.id,
      title: finding.title,
      ...(finding.disposition === undefined ? {} : { disposition: finding.disposition as DeferredDisposition }),
      ...(finding.reference === undefined ? {} : { reference: finding.reference }),
    });
  }
  return {
    planId: value.planId,
    name: value.name,
    repoRoot: value.repoRoot,
    stage: value.stage,
    ...(criteria === undefined ? {} : { criteria: [...(criteria as string[])] }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    status: value.status,
    done: value.done,
    total: value.total,
    gates,
    ...(delivery ? { delivery } : {}),
    deferred,
    directory: value.directory,
  };
}

/**
 * Asks omo-prometheus for the Atlas plans bound to this repository (and stage). It answers synchronously inside the
 * emit or not at all; undefined means no plugin answered, and a malformed answer is dropped like a missing one.
 */
export function requestPlans(
  events: ContractEvents,
  request: { sessionId: string; repoRoot: string; stage?: string },
): AtlasStagePlan[] | undefined {
  const requestId = randomUUID();
  let plans: AtlasStagePlan[] | undefined;
  const unsubscribe = events.on("atlas:plans", (payload) => {
    if (
      plans ||
      !object(payload) ||
      payload.v !== 1 ||
      payload.sessionId !== request.sessionId ||
      payload.requestId !== requestId ||
      !Array.isArray(payload.plans)
    )
      return;
    const answered = payload.plans.map(stagePlan);
    if (answered.some((plan) => !plan)) return;
    plans = (answered as AtlasStagePlan[]).filter(
      (plan) => plan.repoRoot === request.repoRoot && (request.stage === undefined || plan.stage === request.stage),
    );
  });
  try {
    events.emit("atlas:plans-request", {
      v: 1,
      sessionId: request.sessionId,
      requestId,
      repoRoot: request.repoRoot,
      ...(request.stage === undefined ? {} : { stage: request.stage }),
    });
  } finally {
    unsubscribe();
  }
  return plans;
}

export interface StageCoverage {
  /** Every current done criterion in document order, with the declaring plans by progress. */
  criteria: Array<{ id: string; complete: AtlasStagePlan[]; unfinished: AtlasStagePlan[] }>;
  unfinished: AtlasStagePlan[];
  /** Plans that declare no criteria: their coverage cannot be read from the declarations. */
  undeclared: AtlasStagePlan[];
  /** Plans approved against an earlier planning basis of the stage. */
  drifted: AtlasStagePlan[];
  untriaged: Array<{ plan: AtlasStagePlan; id: string; title: string }>;
}

export function stageCoverage(stage: StageDoc, plans: readonly AtlasStagePlan[]): StageCoverage {
  const revision = planningRevision(stage);
  return {
    criteria: parseDoneCriteria(stage.done_criteria).map(({ id }) => ({
      id,
      complete: plans.filter((plan) => plan.status === "complete" && plan.criteria?.includes(id)),
      unfinished: plans.filter((plan) => plan.status === "unfinished" && plan.criteria?.includes(id)),
    })),
    unfinished: plans.filter((plan) => plan.status === "unfinished"),
    undeclared: plans.filter((plan) => plan.criteria === undefined),
    drifted: plans.filter((plan) => plan.revision !== undefined && plan.revision !== revision),
    untriaged: plans.flatMap((plan) =>
      plan.deferred.filter((finding) => finding.disposition === undefined).map(({ id, title }) => ({ plan, id, title })),
    ),
  };
}
