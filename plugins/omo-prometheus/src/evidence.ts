import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { type ChildReceipt, type ExecutionLedger, type LedgerItem, planDigest } from "./ledger.ts";

interface Assignment {
  ledgerId: string;
  sessionId: string;
  planSha256: string;
  rows: Record<string, string>;
}

interface ObservedChild {
  assignment: Assignment;
  status: string;
  sessionFile: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reviewedGates(ledger: ExecutionLedger, row: LedgerItem): Record<string, string> {
  if (row.id !== "F4") return {};
  const hashes: Record<string, string> = {};
  for (const gate of ledger.gates.filter((candidate) => candidate.id !== "F4")) {
    if (gate.status !== "done" || !gate.receipt) throw new Error("F4 requires completed F1–F3 receipts");
    hashes[gate.id] = gate.receipt.outputSha256;
  }
  return hashes;
}

/** The exact outputSchema given to a native gate child; it overrides any agent-native prose format. */
export function gateOutputSchema(ledger: ExecutionLedger, row: LedgerItem): Record<string, unknown> {
  const reviewed = reviewedGates(ledger, row);
  return {
    type: "object",
    additionalProperties: false,
    required: ["gateId", "planSha256", "attempt", "verdict", "summary", "evidence", "reviewedGates"],
    properties: {
      gateId: { const: row.id },
      planSha256: { const: ledger.planSha256 },
      attempt: { const: row.attempt },
      verdict: { enum: ["PASS", "FAIL", "INCONCLUSIVE"] },
      summary: { type: "string", minLength: 1 },
      evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      reviewedGates: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(reviewed),
        properties: Object.fromEntries(Object.entries(reviewed).map(([id, hash]) => [id, { const: hash }])),
      },
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
  const expected = reviewedGates(ledger, row);
  if (
    !object(result) ||
    result.gateId !== row.id ||
    result.planSha256 !== ledger.planSha256 ||
    result.attempt !== row.attempt ||
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    !Array.isArray(result.evidence) ||
    !result.evidence.length ||
    result.evidence.some((entry) => typeof entry !== "string" || !entry.trim()) ||
    !object(result.reviewedGates) ||
    Object.keys(result.reviewedGates).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([id, hash]) => result.reviewedGates && object(result.reviewedGates) && result.reviewedGates[id] !== hash)
  ) {
    throw new Error(`${row.id} child output does not match the current plan, attempt, and prerequisite reports`);
  }
  if (result.verdict !== "PASS")
    throw new Error(`${row.id} did not pass: ${String(result.verdict)}. Reopen affected work or report the blocker.`);
}

/** Correlates native dispatch and terminal lifecycle events; it never launches or schedules children. */
export class ChildEvidence {
  readonly #dispatches = new Map<string, Assignment[]>();
  readonly #children = new Map<string, ObservedChild>();

  rememberDispatch(toolCallId: string, sessionId: string, ledger: ExecutionLedger, input: unknown): void {
    if (!object(input)) throw new Error("Task input must identify its ledger assignment");
    const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
    if (!tasks.length) throw new Error("Task batch is empty");
    const bound = new Set<string>();
    const assignments = tasks.map((task) => {
      if (!object(task) || typeof task.task !== "string") throw new Error("Every task needs an assignment body");
      const text = `${typeof input.context === "string" ? input.context : ""}\n${task.task}`;
      const markers = [...text.matchAll(/^\s*prometheus_assignment:\s*(\{[^\n]+\})\s*$/gm)];
      if (markers.length !== 1) throw new Error("Each task must include exactly one prometheus_assignment JSON line from ledger start");
      const binding: unknown = JSON.parse(markers[0]?.[1] ?? "null");
      if (!object(binding) || binding.planSha256 !== ledger.planSha256 || !object(binding.rows) || !Object.keys(binding.rows).length) {
        throw new Error("Task assignment does not match the approved plan");
      }
      const rows: Record<string, string> = {};
      for (const [id, attempt] of Object.entries(binding.rows)) {
        const row = [...ledger.items, ...ledger.gates].find((candidate) => candidate.id === id);
        if (row?.status !== "in_progress" || typeof attempt !== "string" || attempt !== row.attempt) {
          throw new Error(`${id} has no current started attempt; use prometheus_ledger start before dispatch`);
        }
        if (bound.has(id)) throw new Error(`${id} is assigned more than once in this batch`);
        if ((task.agent ?? "task") !== row.dispatchAgent) throw new Error(`${id} requires dispatch agent ${row.dispatchAgent}`);
        if (id.startsWith("F") && (Object.keys(binding.rows).length !== 1 || !object(task.outputSchema) || task.schemaMode !== "strict")) {
          throw new Error("Each final gate needs its own fresh child with the supplied outputSchema and schemaMode strict");
        }
        bound.add(id);
        rows[id] = attempt;
      }
      return { ledgerId: ledger.ledgerId, sessionId, planSha256: ledger.planSha256, rows };
    });
    this.#dispatches.set(toolCallId, assignments);
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
    const assignment = this.#dispatches.get(payload.parentToolCallId)?.[payload.index];
    if (!assignment) return;
    this.#children.set(`${assignment.sessionId}:${payload.id}`, { assignment, status: payload.status, sessionFile: payload.sessionFile });
  }

  clearSession(sessionId: string): void {
    for (const [key, assignments] of this.#dispatches) if (assignments[0]?.sessionId === sessionId) this.#dispatches.delete(key);
    for (const [key, child] of this.#children) if (child.assignment.sessionId === sessionId) this.#children.delete(key);
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
    const outputPath = path.join(artifactsDir, `${childAgentId}.md`);
    if (
      !child.history?.outputPath ||
      path.resolve(child.history.outputPath) !== path.resolve(outputPath) ||
      child.sessionFile === null ||
      path.resolve(child.sessionFile) !== path.resolve(artifactsDir, `${childAgentId}.jsonl`)
    ) {
      throw new Error("Child output is not an owned native artifact of this session");
    }
    if (row.id.startsWith("F") && priorReceipts.some((receipt) => receipt.childAgentId === childAgentId)) {
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
      this.#children.get(`${sessionId}:${childAgentId}`) !== observed
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
    };
  }
}
