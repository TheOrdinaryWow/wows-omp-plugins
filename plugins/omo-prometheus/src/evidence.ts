import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { type ChildReceipt, type ExecutionLedger, type LedgerItem, ledgerRows, planDigest } from "./ledger.ts";

interface Assignment {
  ledgerId: string;
  sessionId: string;
  planSha256: string;
  rows: Record<string, string>;
  dispatchedAt: number;
  artifactsDir: string;
  finalStatus?: "completed" | "failed";
  returnedAt?: number;
  nativeChildId?: string;
  nativeJobId?: string;
  nativeJobStart?: number;
  observingSettlement?: boolean;
  settled?: boolean;
  failedInFinalProgress?: boolean;
}

interface ObservedChild {
  childAgentId: string;
  assignment: Assignment;
  status: string;
  sessionFile: string;
  finalStatus?: "completed" | "failed";
  reactivation?: {
    startedAt: number;
    finishedAt?: number;
    supersededAt?: number;
    nativeJobId?: string;
    nativeJobStart?: number;
    observingSettlement?: boolean;
    settled?: boolean;
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The exact outputSchema given to a native gate child; it overrides any agent-native prose format. */
export function gateOutputSchema(ledger: ExecutionLedger, row: LedgerItem): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["gateId", "planSha256", "attempt", "verdict", "summary", "evidence"],
    properties: {
      gateId: { const: row.id },
      planSha256: { const: ledger.planSha256 },
      attempt: { const: row.attempt },
      verdict: { enum: ["PASS", "FAIL", "INCONCLUSIVE"] },
      summary: { type: "string", minLength: 1 },
      evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    },
  };
}

/** Gate verdicts come from the child's complete JSON artifact, never a word in caller prose. */
export function validateGateOutput(content: string, ledger: ExecutionLedger, row: LedgerItem): void {
  let result: unknown;
  try {
    result = JSON.parse(content);
  } catch {
    throw new Error(`${row.id} child output must be a JSON object matching the gate outputSchema`);
  }
  // Outputs from earlier plugin versions may carry a reviewedGates field; it no longer affects the verdict.
  if (
    !object(result) ||
    result.gateId !== row.id ||
    result.planSha256 !== ledger.planSha256 ||
    result.attempt !== row.attempt ||
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    !Array.isArray(result.evidence) ||
    !result.evidence.length ||
    result.evidence.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${row.id} child output does not match the current plan and attempt`);
  }
  if (result.verdict !== "PASS")
    throw new Error(
      `${row.id} did not pass: ${String(result.verdict)}. Record each correction with atlas_ledger fix, or report the blocker.`,
    );
}

/** Correlates native dispatch and terminal lifecycle events; it never launches or schedules children. */
export class ChildEvidence {
  readonly #dispatches = new Map<string, Assignment[]>();
  readonly #children = new Map<string, ObservedChild>();
  readonly #reactivations = new Set<ObservedChild>();

  rememberDispatch(toolCallId: string, sessionId: string, ledger: ExecutionLedger, input: unknown, artifactsDir: string): void {
    if (this.#dispatches.has(`${sessionId}:${toolCallId}`))
      throw new Error("Native task dispatch identity was already used in this session");
    if (!object(input)) throw new Error("Task input must identify its ledger assignment");
    const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
    if (!tasks.length) throw new Error("Task batch is empty");
    const bound = new Set<string>();
    const dispatchedAt = Date.now();
    const assignments = tasks.map((task) => {
      if (!object(task) || typeof task.task !== "string") throw new Error("Every task needs an assignment body");
      const text = `${typeof input.context === "string" ? input.context : ""}\n${task.task}`;
      const markers = [...text.matchAll(/^\s*atlas_assignment:\s*(\{[^\n]+\})\s*$/gm)];
      if (markers.length !== 1) throw new Error("Each task must include exactly one atlas_assignment JSON line from ledger start");
      const binding: unknown = JSON.parse(markers[0]?.[1] ?? "null");
      if (!object(binding) || binding.planSha256 !== ledger.planSha256 || !object(binding.rows) || !Object.keys(binding.rows).length) {
        throw new Error("Task assignment does not match the approved plan");
      }
      const rows: Record<string, string> = {};
      for (const [id, attempt] of Object.entries(binding.rows)) {
        const row = ledgerRows(ledger).find((candidate) => candidate.id === id);
        if (row?.status !== "in_progress" || typeof attempt !== "string" || attempt !== row.attempt) {
          throw new Error(`${id} has no current started attempt; use atlas_ledger start before dispatch`);
        }
        if (bound.has(id)) throw new Error(`${id} is assigned more than once in this batch`);
        if ((task.agent ?? "task") !== row.dispatchAgent) throw new Error(`${id} requires dispatch agent ${row.dispatchAgent}`);
        if (id.startsWith("F") && (Object.keys(binding.rows).length !== 1 || !object(task.outputSchema) || task.schemaMode !== "strict")) {
          throw new Error("Each final gate needs its own fresh child with the supplied outputSchema and schemaMode strict");
        }
        bound.add(id);
        rows[id] = attempt;
      }
      return { ledgerId: ledger.ledgerId, sessionId, planSha256: ledger.planSha256, rows, dispatchedAt, artifactsDir };
    });
    this.#dispatches.set(`${sessionId}:${toolCallId}`, assignments);
  }

  discardUnstartedDispatch(sessionId: string, toolCallId: string): void {
    const key = `${sessionId}:${toolCallId}`;
    const assignments = this.#dispatches.get(key);
    if (assignments && ![...this.#children.values()].some((child) => assignments.includes(child.assignment))) this.#dispatches.delete(key);
  }

  observe(payload: unknown): void {
    if (
      !object(payload) ||
      typeof payload.parentToolCallId !== "string" ||
      typeof payload.index !== "number" ||
      typeof payload.id !== "string" ||
      typeof payload.sessionFile !== "string" ||
      typeof payload.status !== "string"
    )
      return;
    // Lifecycle events are global. Tool-call ids alone do not establish the origin session.
    for (const [key, assignments] of this.#dispatches) {
      const assignment = assignments[payload.index];
      if (!assignment || key !== `${assignment.sessionId}:${payload.parentToolCallId}`) continue;
      if (path.resolve(payload.sessionFile) !== path.resolve(assignment.artifactsDir, `${payload.id}.jsonl`)) continue;
      const childKey = `${assignment.sessionId}:${payload.id}`;
      const previous = this.#children.get(childKey);
      if (previous?.assignment === assignment && previous.sessionFile === payload.sessionFile) {
        if (payload.status === "started" && (previous.status !== "started" || previous.finalStatus !== undefined)) {
          const startedAt = Date.now();
          if (previous.reactivation) previous.reactivation.supersededAt = startedAt;
          const child: ObservedChild = {
            childAgentId: payload.id,
            assignment,
            status: payload.status,
            sessionFile: payload.sessionFile,
            reactivation: { startedAt },
          };
          this.#children.set(childKey, child);
          this.#reactivations.add(child);
        } else {
          previous.status = payload.status;
          if (previous.reactivation && ["completed", "failed", "aborted"].includes(payload.status))
            previous.reactivation.finishedAt ??= Date.now();
        }
      } else {
        this.#children.set(childKey, { childAgentId: payload.id, assignment, status: payload.status, sessionFile: payload.sessionFile });
      }
    }
  }

  observeTaskResult(sessionId: string, toolCallId: string, details: unknown, isError = false): void {
    const assignments = this.#dispatches.get(`${sessionId}:${toolCallId}`);
    if (!assignments) return;
    for (const assignment of assignments) assignment.returnedAt ??= Date.now();
    if (!object(details)) {
      if (isError) for (const assignment of assignments) assignment.finalStatus = "failed";
      return;
    }
    if (object(details.async) && Array.isArray(details.progress)) {
      for (const progress of details.progress) {
        if (!object(progress) || typeof progress.id !== "string" || !Number.isInteger(progress.index)) continue;
        const assignment = assignments[progress.index as number];
        if (assignment) {
          assignment.nativeChildId = progress.id;
          if (progress.status === "failed" || progress.status === "aborted") assignment.failedInFinalProgress = true;
        }
      }
    }
    if (Array.isArray(details.results)) {
      for (const result of details.results) {
        if (!object(result) || typeof result.id !== "string" || !Number.isInteger(result.index)) continue;
        const assignment = assignments[result.index as number];
        if (!assignment) continue;
        const child = this.#children.get(`${sessionId}:${result.id}`);
        const finalStatus =
          !isError && result.exitCode === 0 && result.aborted !== true && result.error === undefined ? "completed" : "failed";
        assignment.finalStatus = finalStatus;
        if (child?.assignment === assignment && !child.reactivation)
          child.finalStatus = child.finalStatus === "failed" ? "failed" : finalStatus;
      }
    }
    // A returned synchronous call is terminal even if spawn failed before a child existed.
    // Async task results can contain only the synchronous subset; their remaining jobs stay owned.
    if (!object(details.async)) {
      for (const assignment of assignments) assignment.finalStatus ??= "failed";
    }
  }

  observeAsyncJobs(sessionId: string, snapshot: unknown, native?: { ownerId: string; jobs: unknown; onSettled: () => void }): void {
    if (!object(snapshot)) return;
    if (native && Array.isArray(native.jobs)) {
      for (const job of native.jobs) {
        if (
          !object(job) ||
          job.ownerId !== native.ownerId ||
          job.type !== "task" ||
          typeof job.id !== "string" ||
          typeof job.agentId !== "string" ||
          typeof job.startTime !== "number" ||
          !(job.promise instanceof Promise)
        )
          continue;
        for (const assignments of this.#dispatches.values()) {
          for (const assignment of assignments) {
            if (
              assignment.sessionId !== sessionId ||
              assignment.nativeChildId !== job.agentId ||
              assignment.returnedAt === undefined ||
              job.startTime < assignment.dispatchedAt ||
              job.startTime > assignment.returnedAt ||
              assignment.observingSettlement
            )
              continue;
            if (assignment.nativeJobId && (assignment.nativeJobId !== job.id || assignment.nativeJobStart !== job.startTime)) continue;
            assignment.nativeJobId = job.id;
            assignment.nativeJobStart = job.startTime;
            assignment.observingSettlement = true;
            // Keep the exact native promise/object even if the manager evicts its row on a session switch.
            void job.promise.then(
              () => {
                assignment.settled = true;
                assignment.finalStatus = job.status === "completed" && assignment.finalStatus !== "failed" ? "completed" : "failed";
                const child = this.#children.get(`${sessionId}:${job.agentId}`);
                if (child?.assignment === assignment && !child.reactivation) child.finalStatus = assignment.finalStatus;
                native.onSettled();
              },
              () => {
                assignment.settled = true;
                assignment.finalStatus = "failed";
                const child = this.#children.get(`${sessionId}:${job.agentId}`);
                if (child?.assignment === assignment && !child.reactivation) child.finalStatus = "failed";
                native.onSettled();
              },
            );
          }
        }
      }
    }
    for (const bucket of [snapshot.running, snapshot.recent]) {
      if (!Array.isArray(bucket)) continue;
      for (const job of bucket) {
        if (
          !object(job) ||
          job.type !== "task" ||
          typeof job.id !== "string" ||
          typeof job.agentId !== "string" ||
          typeof job.startTime !== "number"
        )
          continue;
        for (const assignments of this.#dispatches.values()) {
          for (const assignment of assignments) {
            if (
              assignment.sessionId !== sessionId ||
              assignment.nativeChildId !== job.agentId ||
              assignment.returnedAt === undefined ||
              job.startTime < assignment.dispatchedAt ||
              job.startTime > assignment.returnedAt
            )
              continue;
            if (assignment.nativeJobId && (assignment.nativeJobId !== job.id || assignment.nativeJobStart !== job.startTime)) continue;
            assignment.nativeJobId = job.id;
            assignment.nativeJobStart = job.startTime;
            const child = this.#children.get(`${sessionId}:${job.agentId}`);
            if (job.status === "failed") assignment.finalStatus = "failed";
            // cancelled/aborted is a request status until the native run actually settles.
            else if ((job.status === "cancelled" || job.status === "aborted") && assignment.settled) assignment.finalStatus = "failed";
            else if (job.status === "completed" && assignment.finalStatus !== "failed") assignment.finalStatus = "completed";
            if (child?.assignment === assignment && !child.reactivation && assignment.finalStatus)
              child.finalStatus = assignment.finalStatus;
          }
        }
      }
    }
    for (const assignments of this.#dispatches.values()) {
      for (const assignment of assignments) {
        // Native final mixed-call progress can be the only failure result for a member
        // whose scheduling/inline execution failed. A live job still requires its own outcome.
        if (assignment.sessionId !== sessionId || !assignment.failedInFinalProgress || assignment.nativeJobId) continue;
        assignment.finalStatus = "failed";
        const child = assignment.nativeChildId ? this.#children.get(`${sessionId}:${assignment.nativeChildId}`) : undefined;
        if (child?.assignment === assignment && !child.reactivation) child.finalStatus = "failed";
      }
    }
    this.#observeReactivations(sessionId, snapshot, native);
  }

  #observeReactivations(
    sessionId: string,
    snapshot: Record<string, unknown>,
    native?: { ownerId: string; jobs: unknown; onSettled: () => void },
  ): void {
    for (const child of this.#reactivations) {
      const turn = child.reactivation;
      if (!turn || child.assignment.sessionId !== sessionId) continue;
      const jobs =
        native && Array.isArray(native.jobs)
          ? native.jobs
          : [...(Array.isArray(snapshot.running) ? snapshot.running : []), ...(Array.isArray(snapshot.recent) ? snapshot.recent : [])];
      const candidates = jobs.filter((job): job is Record<string, unknown> => {
        if (
          !object(job) ||
          job.type !== "task" ||
          typeof job.id !== "string" ||
          job.agentId !== child.childAgentId ||
          typeof job.startTime !== "number" ||
          (native && job.ownerId !== native.ownerId)
        )
          return false;
        if (turn.nativeJobId) return job.id === turn.nativeJobId && job.startTime === turn.nativeJobStart;
        if (
          job.startTime < turn.startedAt ||
          (turn.finishedAt !== undefined && job.startTime > turn.finishedAt) ||
          (turn.supersededAt !== undefined && job.startTime >= turn.supersededAt)
        )
          return false;
        if (child.assignment.nativeJobId === job.id && child.assignment.nativeJobStart === job.startTime) return false;
        return ![...this.#reactivations].some(
          (other) => other !== child && other.reactivation?.nativeJobId === job.id && other.reactivation?.nativeJobStart === job.startTime,
        );
      });
      // Ambiguous generations never authorize a receipt or release writer ownership.
      if (candidates.length !== 1) continue;
      const job = candidates[0];
      if (!job) continue;
      turn.nativeJobId = job.id as string;
      turn.nativeJobStart = job.startTime as number;
      const abortSignal = object(job.abortController) && object(job.abortController.signal) ? job.abortController.signal : undefined;
      // IRC wake jobs wrap untilAborted(signal, outcome.promise). Cancelling the wrapper
      // settles job.promise before the underlying wake/finalizer, so it cannot release ownership.
      if (job.status === "cancelled" || job.status === "aborted" || abortSignal?.aborted === true) continue;
      if (native && job.promise instanceof Promise) {
        if (turn.observingSettlement) continue;
        turn.observingSettlement = true;
        void job.promise.then(
          () => {
            if ((job.status !== "completed" && job.status !== "failed") || abortSignal?.aborted === true) return;
            turn.settled = true;
            child.finalStatus = job.status;
            native.onSettled();
          },
          () => {
            // Native manager promises normally absorb run rejection. A rejected wrapper
            // cannot authenticate the underlying wake's final outcome.
            child.finalStatus = "failed";
          },
        );
      } else if (!native && job.status === "completed") {
        turn.settled = true;
        child.finalStatus = job.status;
      }
    }
  }

  /** Lifecycle completion is not final task success, and cannot release writer ownership. */
  hasPending(sessionId: string, ledgerId: string): boolean {
    return (
      [...this.#dispatches.values()].some((assignments) =>
        assignments.some(
          (assignment) =>
            assignment.sessionId === sessionId &&
            assignment.ledgerId === ledgerId &&
            (assignment.finalStatus === undefined || (assignment.observingSettlement === true && assignment.settled !== true)),
        ),
      ) ||
      [...this.#reactivations].some(
        (child) =>
          child.assignment.sessionId === sessionId && child.assignment.ledgerId === ledgerId && child.reactivation?.settled !== true,
      )
    );
  }

  async capture(options: {
    registry: AgentRegistry;
    parentAgentId: string;
    sessionId: string;
    artifactsDir: string;
    ledger: ExecutionLedger;
    row: LedgerItem;
    childAgentId: string;
    priorReceipts: readonly ChildReceipt[];
  }): Promise<ChildReceipt> {
    const { registry, parentAgentId, sessionId, artifactsDir, ledger, row, childAgentId, priorReceipts } = options;
    if (row.status !== "in_progress" || !row.attempt || row.startedAt === undefined)
      throw new Error(`${row.id} must be started before completion`);
    if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(childAgentId)) throw new Error("Invalid child agent id");
    const child = registry.get(childAgentId);
    const observed = this.#children.get(`${sessionId}:${childAgentId}`);
    if (child?.kind !== "sub" || child.parentId !== parentAgentId)
      throw new Error("Evidence must belong to a real direct child of this session");
    if (child.status !== "idle" && child.status !== "parked")
      throw new Error(`Evidence child ${childAgentId} is not completed (${child.status})`);
    if (
      observed?.status !== "completed" ||
      observed.assignment.sessionId !== sessionId ||
      observed.assignment.ledgerId !== ledger.ledgerId ||
      observed.assignment.planSha256 !== ledger.planSha256 ||
      observed.assignment.rows[row.id] !== row.attempt ||
      observed.sessionFile !== child.sessionFile ||
      child.createdAt < row.startedAt
    ) {
      throw new Error(
        "No native successful completion for this current assignment; use a fresh child to revalidate historical or stale work",
      );
    }
    if (observed.finalStatus !== "completed") {
      throw new Error(
        "The native task has not reported final success, including isolated-work capture; wait for its final result or repair the failure",
      );
    }
    const outputPath = path.join(artifactsDir, `${childAgentId}.md`);
    if (
      !child.history?.outputPath ||
      path.resolve(child.history.outputPath) !== path.resolve(outputPath) ||
      child.sessionFile === null ||
      path.resolve(child.sessionFile) !== path.resolve(artifactsDir, `${childAgentId}.jsonl`)
    ) {
      throw new Error("Child output is not an owned native artifact of this session");
    }
    if (
      row.id.startsWith("F") &&
      priorReceipts.some((receipt) => receipt.sessionId === sessionId && receipt.childAgentId === childAgentId)
    ) {
      throw new Error(
        "Final gates require distinct fresh verification children, never an implementation or previously used verifier child",
      );
    }
    const stat = await fs.lstat(outputPath);
    if (!stat.isFile()) throw new Error("Child evidence must be a native output file, not a link");
    const content = await fs.readFile(outputPath, "utf8");
    if (!content.trim()) throw new Error("Child output is empty");
    if (row.id.startsWith("F")) validateGateOutput(content, ledger, row);
    // A lifecycle change during the file read cannot authorize a now-running or replaced generation.
    if (
      registry.get(childAgentId) !== child ||
      (child.status !== "idle" && child.status !== "parked") ||
      this.#children.get(`${sessionId}:${childAgentId}`) !== observed ||
      observed.finalStatus !== "completed"
    )
      throw new Error("Child changed while evidence was being captured; retry after completion");
    return {
      receiptId: randomUUID(),
      ledgerId: ledger.ledgerId,
      planSha256: ledger.planSha256,
      rowId: row.id,
      attempt: row.attempt,
      childAgentId,
      parentAgentId,
      sessionId,
      childCreatedAt: child.createdAt,
      outputSha256: planDigest(content),
      capturedAt: Date.now(),
      nativeFinal: true,
    };
  }
}
