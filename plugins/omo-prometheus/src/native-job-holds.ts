import * as path from "node:path";

import type { AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { extractSessionInit } from "@oh-my-pi/pi-coding-agent/session/session-manager";

interface NativeJob {
  id: string;
  agentId: string;
  ownerId: string;
  type: "task";
  status: string;
  startTime: number;
  promise: Promise<unknown>;
}

interface ResearchDispatch {
  sessionId: string;
  toolCallId: string;
  artifactsDir: string;
  dispatchedAt: number;
  returnedAt?: number;
  children: Map<number, string>;
  count: number;
}

type HoldScope = { rows: string[] } | { reason: string };
interface JobHold {
  sessionId: string;
  ledgerId: string;
  job: NativeJob;
  settled: boolean;
  scope: HoldScope;
  ready: Promise<void>;
  read: () => Promise<HoldScope>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeJob(value: unknown): value is NativeJob {
  return (
    object(value) &&
    value.type === "task" &&
    typeof value.id === "string" &&
    typeof value.agentId === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.status === "string" &&
    typeof value.startTime === "number" &&
    value.promise instanceof Promise
  );
}

async function readScope(file: string, planSha256: string): Promise<HoldScope> {
  try {
    const loaded = await loadSessionFile(file, undefined, { throwIfMissing: true });
    if (loaded.invalidHeader || loaded.malformedRecords) return { reason: "the child transcript is malformed" };
    const init = extractSessionInit(loaded.entries);
    if (!init) return { reason: "the persisted init record is missing" };
    if (typeof init.task !== "string" || !Array.isArray(init.systemPrompt) || !init.systemPrompt.every((text) => typeof text === "string"))
      return { reason: "the persisted init record is malformed" };
    const bindings = new Map<string, string[]>();
    for (const text of [init.task, ...init.systemPrompt]) {
      for (const line of text.split("\n")) {
        if (!/^\s*atlas_assignment:/.test(line)) continue;
        const match = /^\s*atlas_assignment:\s*(\{[^\n]+\})\s*$/.exec(line);
        if (!match) return { reason: "an atlas_assignment line is malformed" };
        const binding: unknown = JSON.parse(match[1] ?? "");
        if (!object(binding) || typeof binding.planSha256 !== "string") return { reason: "an atlas_assignment binding is malformed" };
        if (binding.planSha256 !== planSha256) continue;
        const entries = binding.verify ?? binding.rows;
        if (
          (binding.verify !== undefined && binding.rows !== undefined) ||
          !object(entries) ||
          !Object.keys(entries).length ||
          !Object.entries(entries).every(([id, attempt]) => /^[TDXFP]\d+$/.test(id) && typeof attempt === "string" && attempt.length > 0)
        )
          return { reason: "an atlas_assignment binding for this plan is malformed" };
        const ordered = Object.entries(entries).sort(([left], [right]) => left.localeCompare(right));
        bindings.set(
          JSON.stringify([binding.verify !== undefined, ordered]),
          ordered.map(([id]) => id),
        );
      }
    }
    if (bindings.size > 1) return { reason: "the persisted init record carries conflicting bindings for this plan" };
    return { rows: bindings.values().next().value ?? [] };
  } catch {
    return { reason: "the persisted init record could not be read or parsed" };
  }
}

/** Recovered bindings can withhold dispatch and ownership, never authorize evidence. */
export class NativeJobHolds {
  readonly #holds = new Set<JobHold>();
  readonly #seen = new WeakMap<Promise<unknown>, Set<string>>();
  readonly #research = new Map<string, ResearchDispatch>();

  rememberResearch(sessionId: string, toolCallId: string, input: unknown, artifactsDir: string): void {
    const count = object(input) && Array.isArray(input.tasks) ? input.tasks.length : 1;
    this.#research.set(`${sessionId}:${toolCallId}`, {
      sessionId,
      toolCallId,
      artifactsDir,
      dispatchedAt: Date.now(),
      children: new Map(),
      count,
    });
  }

  observeResearch(payload: unknown): void {
    if (
      !object(payload) ||
      typeof payload.parentToolCallId !== "string" ||
      typeof payload.index !== "number" ||
      typeof payload.id !== "string" ||
      typeof payload.sessionFile !== "string"
    )
      return;
    for (const dispatch of this.#research.values()) {
      if (
        dispatch.toolCallId === payload.parentToolCallId &&
        payload.index >= 0 &&
        payload.index < dispatch.count &&
        path.resolve(payload.sessionFile) === path.resolve(dispatch.artifactsDir, `${payload.id}.jsonl`)
      )
        dispatch.children.set(payload.index, payload.id);
    }
  }

  observeResearchResult(sessionId: string, toolCallId: string, details: unknown): void {
    const dispatch = this.#research.get(`${sessionId}:${toolCallId}`);
    if (!dispatch) return;
    dispatch.returnedAt ??= Date.now();
    if (!object(details)) return;
    for (const result of [details.results, details.progress].flatMap((items) => (Array.isArray(items) ? items : []))) {
      if (
        object(result) &&
        typeof result.id === "string" &&
        typeof result.index === "number" &&
        result.index >= 0 &&
        result.index < dispatch.count
      )
        dispatch.children.set(result.index, result.id);
    }
  }

  observe(options: {
    sessionId: string;
    ledgerId: string;
    planSha256: string;
    artifactsDir: string | null;
    ownerId: string;
    jobs: readonly unknown[];
    registry: AgentRegistryApi;
    bound: (job: NativeJob) => boolean;
    inFlight: (job: NativeJob) => boolean;
    onSettled: () => void;
  }): void {
    for (const job of options.jobs) {
      if (!nativeJob(job) || job.ownerId !== options.ownerId) continue;
      const key = `${options.sessionId}:${options.ledgerId}`;
      const seen = this.#seen.get(job.promise) ?? new Set<string>();
      if (seen.has(key)) continue;
      const existing = [...this.#holds].find(
        (hold) => hold.sessionId === options.sessionId && hold.ledgerId === options.ledgerId && hold.job.promise === job.promise,
      );
      const knownResearch = [...this.#research.values()].some(
        (dispatch) =>
          dispatch.sessionId === options.sessionId &&
          [...dispatch.children.values()].includes(job.agentId) &&
          job.startTime >= dispatch.dispatchedAt &&
          (dispatch.returnedAt === undefined || job.startTime <= dispatch.returnedAt),
      );
      if (options.bound(job) || knownResearch) {
        if (existing) this.#holds.delete(existing);
        seen.add(key);
        this.#seen.set(job.promise, seen);
        continue;
      }
      if (existing || job.status !== "running") continue;
      if (
        options.inFlight(job) ||
        [...this.#research.values()].some(
          (dispatch) =>
            dispatch.sessionId === options.sessionId && dispatch.returnedAt === undefined && job.startTime >= dispatch.dispatchedAt,
        )
      )
        continue;
      const ref = options.registry.get(job.agentId);
      const file = options.artifactsDir ? path.resolve(options.artifactsDir, `${job.agentId}.jsonl`) : undefined;
      if (
        ref &&
        (ref.kind !== "sub" || ref.parentId !== options.ownerId || (file && ref.sessionFile && path.resolve(ref.sessionFile) !== file))
      )
        continue;
      const hold: JobHold = {
        sessionId: options.sessionId,
        ledgerId: options.ledgerId,
        job,
        settled: false,
        scope: { reason: "the persisted init record has not been read" },
        ready: Promise.resolve(),
        read: () =>
          file
            ? readScope(file, options.planSha256)
            : Promise.resolve<HoldScope>({ reason: "the parent's native artifact directory is unavailable" }),
      };
      this.#holds.add(hold);
      hold.ready = hold.read().then((scope) => {
        hold.scope = scope;
        options.onSettled();
      });
      // Cancellation changes status before the native run's promise settles. Retain that exact generation even after eviction.
      const settle = () => {
        hold.settled = true;
        this.#holds.delete(hold);
        options.onSettled();
      };
      void job.promise.then(settle, settle);
    }
  }

  hasPending(sessionId: string, ledgerId: string): boolean {
    return this.#pending(sessionId, ledgerId).length > 0;
  }

  async blockReason(sessionId: string, ledgerId: string, rowIds?: readonly string[]): Promise<string | undefined> {
    await Promise.all(this.#pending(sessionId, ledgerId).map((hold) => hold.ready));
    await Promise.all(
      this.#pending(sessionId, ledgerId).map(async (hold) => {
        if ("reason" in hold.scope) hold.scope = await hold.read();
      }),
    );
    const reasons = this.#pending(sessionId, ledgerId).flatMap((hold) => {
      if ("rows" in hold.scope && rowIds && !hold.scope.rows.some((id) => rowIds.includes(id))) return [];
      const scope =
        rowIds === undefined
          ? "Release is paused."
          : "rows" in hold.scope
            ? `Rows ${hold.scope.rows.join(", ")} are paused.`
            : `All bound dispatch is paused because ${hold.scope.reason}, so the affected rows could not be identified.`;
      const unresolved =
        rowIds === undefined && "reason" in hold.scope ? ` The affected rows could not be identified because ${hold.scope.reason}.` : "";
      return [
        `Native child ${hold.job.agentId} (job ${hold.job.id}) was not dispatched by this running session, or its dispatch record was lost on restart. ${scope}${unresolved} This hold lifts when that exact native job settles. Use wait until it settles, and do not cancel the child. The child's result is not evidence. After settlement, dispatch the affected work with a fresh binding from atlas_ledger start or verify.`,
      ];
    });
    return reasons.length ? `Atlas unbound native job guard: ${reasons.join(" ")}` : undefined;
  }

  #pending(sessionId: string, ledgerId: string): JobHold[] {
    return [...this.#holds].filter(
      (hold) =>
        hold.sessionId === sessionId && hold.ledgerId === ledgerId && !hold.settled && !("rows" in hold.scope && !hold.scope.rows.length),
    );
  }
}
