import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, constants, type Dirent, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import * as path from "node:path";

import { type AtlasEvent, derivedTimeline, ledgerEvents, parseTimeline, rowSnapshot } from "#src/atlas-timeline.ts";

import { parseVerifyOutput, validateGateOutput } from "./evidence.ts";
import { gitHead } from "./git-evidence.ts";
import {
  type ChildReceipt,
  createLedger,
  currentAttempt,
  type DeferredFinding,
  type Delivery,
  type ExecutionLedger,
  type ItemStatus,
  isComplete,
  type LedgerItem,
  ledgerRows,
  planDigest,
  reopenRow,
  resetVerification,
  restoreLedger,
  type Tier,
  type VerificationStatus,
  verificationStatus,
} from "./ledger.ts";
import { withLedgerLock, writeLedgerAtomic } from "./ledger-store.ts";
import { type AtlasStagePlan, isRoadmapStage, type RoadmapStage } from "./roadmap-contract.ts";

export interface AtlasPlan {
  id: string;
  name: string;
  originalName: string;
  invalidReason?: string;
  cwd: string;
  directory: string;
  planFilePath: string;
  ledgerPath: string;
  planSha256: string;
  sourcePlanPath: string;
  sourceSessionId: string;
  proposedByToolCallId: string;
  roadmapStage?: RoadmapStage;
}

export interface AtlasRowDetail {
  id: string;
  title: string;
  status: ItemStatus;
  agent: string;
  /** Preserve the display agent while exposing the ledger's requested role to observers. */
  originalAgent?: string;
  dispatchAgent?: string;
  origin?: string;
  /** D rows: why the discovered defect belongs to the plan. */
  reason?: string;
  acceptance: string;
  dependsOn: string[];
  tier?: Tier;
  /** HEAVY rows: the verifier's state and, after a verdict, its summary. */
  verification?: { status: VerificationStatus; summary?: string };
  evidence?: string;
  /** The attempt bound to the child currently working the row: a running verifier's, else the row's own. */
  attempt?: string;
  startedAt?: number;
  childAgentId?: string;
  updatedAt: number;
  receipt?: Pick<ChildReceipt, "receiptId" | "childAgentId" | "sessionId" | "capturedAt">;
  /** Archived native child output backing a completed row. */
  outputPath?: string;
}

export interface AtlasPlanDetail {
  plan: AtlasPlan;
  status: string;
  done: number;
  total: number;
  rows: AtlasRowDetail[];
  timeline: AtlasEvent[];
  startedAt?: number;
  unfinished: boolean;
  enterable: boolean;
  /** Some row moved or a session has held the plan before. */
  started: boolean;
  inUse: boolean;
  /** Present for a readable ledger. */
  delivery?: Delivery;
  deferred?: DeferredFinding[];
}

/** Version 3 adds the stage's declared `criteria` and `revision`; versions 1 and 2 load unchanged and are never rewritten. */
interface Approval {
  version: 1 | 2 | 3;
  id: string;
  name: string;
  cwd: string;
  planSha256: string;
  sourcePlanPath: string;
  sourceSessionId: string;
  proposedByToolCallId: string;
  roadmapStage?: RoadmapStage;
}

interface Attempt {
  attempt: string;
  startedAt: number;
  receiptId: string | null;
  /** Version 2: a HEAVY row's verification attempt and the verifier's receipt once it passed. */
  verify?: { attempt: string; startedAt: number; receiptId: string | null };
}

/** Version 2 adds per-row verification attempts; version 1 files upgrade on load. */
interface Checkpoint {
  version: 2;
  approvalSha256: string;
  ledgerId: string;
  planSha256: string;
  attempts: Record<string, Attempt | null>;
}

interface Claim {
  version: 1;
  host: string;
  pid: number;
  processToken: string;
  storeToken: string;
  sessionId: string;
  token: string;
}

interface TransactionScope {
  store: AtlasStore;
  plan: AtlasPlan;
  sessionId: string;
  ledger: ExecutionLedger;
  active: boolean;
  checkpoint: Checkpoint;
  authenticated: Map<string, { receipt: string; startedAt: number }>;
}

const scopes = new AsyncLocalStorage<TransactionScope>();
const processToken = randomUUID();
const ID = /^[a-z0-9][a-z0-9-]*--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECEIPT_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u;
const HEX = /^[a-f0-9]{64}$/;
const INVALID_PROOF = "Historical child proof is missing or changed; a fresh child must revalidate this row.";

function validName(name: string): boolean {
  return NAME.test(name) && name !== "." && name !== ".." && name.trim() === name;
}

function safeId(id: string): void {
  if (!ID.test(id) || id.includes("..")) throw new Error("Invalid Atlas plan id");
}

function validReceipt(value: unknown): value is ChildReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<ChildReceipt>;
  return (
    typeof receipt.receiptId === "string" &&
    RECEIPT_ID.test(receipt.receiptId) &&
    [
      receipt.ledgerId,
      receipt.planSha256,
      receipt.rowId,
      receipt.attempt,
      receipt.childAgentId,
      receipt.parentAgentId,
      receipt.sessionId,
    ].every((field) => typeof field === "string" && field.length > 0) &&
    typeof receipt.outputSha256 === "string" &&
    HEX.test(receipt.outputSha256) &&
    Number.isFinite(receipt.childCreatedAt) &&
    Number.isFinite(receipt.capturedAt) &&
    receipt.nativeFinal === true
  );
}

async function regularFile(file: string): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Atlas storage is not a regular file: ${file}`);
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function jsonFile(file: string): Promise<unknown> {
  return JSON.parse(await regularFile(file));
}

/** Synchronous twin of `regularFile`, for answers that must complete inside an event emit. */
function regularFileSync(file: string): string {
  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(handle).isFile()) throw new Error(`Atlas storage is not a regular file: ${file}`);
    return readFileSync(handle, "utf8");
  } finally {
    closeSync(handle);
  }
}

function directorySync(file: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`Atlas storage directory is a symlink: ${file}`);
  if (!stat.isDirectory()) throw new Error(`Atlas storage is not a directory: ${file}`);
}

function parseApproval(raw: string, id: string): Approval {
  const data: unknown = JSON.parse(raw);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Atlas plan approval");
  const saved = data as Partial<Approval>;
  if (
    (saved.version !== 1 && saved.version !== 2 && saved.version !== 3) ||
    saved.id !== id ||
    typeof saved.name !== "string" ||
    !validName(saved.name) ||
    typeof saved.cwd !== "string" ||
    !path.isAbsolute(saved.cwd) ||
    path.resolve(saved.cwd) !== saved.cwd ||
    typeof saved.planSha256 !== "string" ||
    !HEX.test(saved.planSha256) ||
    [saved.sourcePlanPath, saved.sourceSessionId, saved.proposedByToolCallId].some((field) => typeof field !== "string" || !field.trim()) ||
    (saved.roadmapStage !== undefined && !isRoadmapStage(saved.roadmapStage))
  )
    throw new Error("Invalid Atlas plan approval");
  return saved as Approval;
}

/** The user's display name from `label.json`. */
function parseLabel(label: unknown): string {
  if (
    label === null ||
    typeof label !== "object" ||
    Array.isArray(label) ||
    !("version" in label) ||
    label.version !== 1 ||
    !("name" in label) ||
    typeof label.name !== "string" ||
    !validName(label.name)
  )
    throw new Error("Invalid Atlas display name");
  return label.name;
}

/** Verdicts of a complete plan's final gates, read from the gate outputs archived in its bundle `directory`. */
export function gateResults(ledger: ExecutionLedger, directory: string): Array<{ gateId: string; verdict: string; summary: string }> {
  return ledger.gates.map((gate) => {
    if (!gate.receipt) throw new Error(`Missing verified gate receipt for ${gate.id}`);
    const output = regularFileSync(path.join(directory, "evidence", `${gate.receipt.receiptId}.md`));
    validateGateOutput(output, ledger, gate);
    const result = JSON.parse(output) as { gateId: string; verdict: string; summary: string };
    return { gateId: result.gateId, verdict: result.verdict, summary: result.summary };
  });
}

/** A `pr` or `ship` plan's delivery once P1 is done: its inspected evidence without the archived-output path prefix. */
export function deliveryResult(ledger: ExecutionLedger, directory: string): { mode: "pr" | "ship"; summary: string } | undefined {
  const delivered = ledger.deliveries[0];
  if (ledger.delivery === "direct" || delivered?.status !== "done" || !delivered.receipt) return undefined;
  const prefix = `${path.join(directory, "evidence", `${delivered.receipt.receiptId}.md`)}: `;
  const evidence = delivered.evidence ?? "";
  return { mode: ledger.delivery, summary: evidence.startsWith(prefix) ? evidence.slice(prefix.length) : evidence };
}

async function directory(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw new Error(`Atlas storage directory is a symlink: ${file}`);
  if (!stat.isDirectory()) throw new Error(`Atlas storage is not a directory: ${file}`);
}

async function syncDirectory(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Publish a complete file at a previously unused path; never replace another writer's claim. */
async function exclusiveFile(file: string, data: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temp, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function checkpointFor(ledger: ExecutionLedger, approvalSha256: string): Checkpoint {
  return {
    version: 2,
    approvalSha256,
    ledgerId: ledger.ledgerId,
    planSha256: ledger.planSha256,
    attempts: Object.fromEntries(
      ledgerRows(ledger).map((row) => {
        const verification = row.verification;
        return [
          row.id,
          row.attempt && row.startedAt !== undefined
            ? {
                attempt: row.attempt,
                startedAt: row.startedAt,
                // A HEAVY row holds its implementation receipt while in progress; reopening always discards it.
                receiptId: row.receipt?.receiptId ?? null,
                ...(verification?.attempt && verification.startedAt !== undefined
                  ? {
                      verify: {
                        attempt: verification.attempt,
                        startedAt: verification.startedAt,
                        receiptId: verification.receipt?.receiptId ?? null,
                      },
                    }
                  : {}),
              }
            : null,
        ];
      }),
    ),
  };
}

function validAttempt(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Partial<Attempt>;
  return (
    typeof attempt.attempt === "string" &&
    attempt.attempt.length > 0 &&
    Number.isFinite(attempt.startedAt) &&
    (attempt.receiptId === null || (typeof attempt.receiptId === "string" && RECEIPT_ID.test(attempt.receiptId)))
  );
}

function validateCheckpoint(raw: unknown, ledger: ExecutionLedger, approvalSha256: string): Checkpoint {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Malformed Atlas attempt checkpoint");
  const value = raw as Partial<Omit<Checkpoint, "version">> & { version?: unknown };
  if (
    (value.version !== 1 && value.version !== 2) ||
    value.approvalSha256 !== approvalSha256 ||
    value.ledgerId !== ledger.ledgerId ||
    value.planSha256 !== ledger.planSha256 ||
    value.attempts === null ||
    typeof value.attempts !== "object" ||
    Array.isArray(value.attempts)
  )
    throw new Error("Atlas attempt checkpoint does not match the approved ledger");
  const attempts = { ...value.attempts };
  const rows = ledgerRows(ledger);
  // Version 1 predates delivery rows; a P row the upgraded ledger derived from its plan has not started yet.
  if (value.version === 1) for (const row of rows) if (row.id.startsWith("P") && !Object.hasOwn(attempts, row.id)) attempts[row.id] = null;
  // Appended rows are checkpointed before the ledger that adds them, so an interrupted write may leave only their key.
  const unexpected = Object.keys(attempts).filter((id) => !rows.some((row) => row.id === id));
  if (rows.some((row) => !Object.hasOwn(attempts, row.id)) || unexpected.some((id) => !/^[XD][1-9]\d*$/.test(id))) {
    throw new Error("Atlas attempt checkpoint has missing or unexpected rows");
  }
  for (const attempt of Object.values(attempts)) {
    if (attempt !== null && (!validAttempt(attempt) || (attempt.verify !== undefined && !validAttempt(attempt.verify))))
      throw new Error("Malformed Atlas attempt checkpoint");
  }
  return { version: 2, approvalSha256, ledgerId: ledger.ledgerId, planSha256: ledger.planSha256, attempts };
}

async function deadOwner(claim: Claim): Promise<boolean> {
  if (claim.host !== hostname()) throw new Error("Atlas plan belongs to a different host; ownership cannot be reclaimed safely");
  try {
    process.kill(claim.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new Error("Atlas owner process liveness is unknown");
  }
  // A reused live PID is ambiguous, not proof of death. No timeout can evict a live owner.
  return false;
}

function validateClaim(raw: unknown): Claim {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Malformed Atlas ownership claim");
  const value = raw as Partial<Claim>;
  if (
    value.version !== 1 ||
    typeof value.host !== "string" ||
    !value.host ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    [value.processToken, value.storeToken, value.sessionId, value.token].some((field) => typeof field !== "string" || !field)
  )
    throw new Error("Malformed Atlas ownership claim");
  return value as Claim;
}

export class AtlasStore {
  readonly #root: string;
  readonly #storeToken = randomUUID();
  readonly #held = new Map<string, { plan: AtlasPlan; approvalSha256: string; generation: number; claim: Claim }>();
  readonly #listeners = new Map<string, Set<() => void>>();

  constructor(sessionDir: string) {
    if (!path.isAbsolute(sessionDir)) throw new Error("Atlas requires an absolute file-backed session directory");
    this.#root = path.resolve(sessionDir, "atlas");
  }

  subscribe(planId: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(planId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(planId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(planId);
    };
  }

  #notify(planId: string): void {
    for (const listener of this.#listeners.get(planId) ?? []) {
      try {
        listener();
      } catch (error) {
        console.warn(`Atlas observation subscriber failed for ${planId}: ${String(error)}`);
      }
    }
  }

  async #base(create = false): Promise<boolean> {
    const sessionDir = path.dirname(this.#root);
    await directory(sessionDir);
    if ((await fs.realpath(sessionDir)) !== sessionDir) throw new Error("Atlas session directory contains a symlink");
    if (create) {
      try {
        await fs.mkdir(this.#root, { mode: 0o700 });
        await syncDirectory(sessionDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    try {
      await directory(this.#root);
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async #plan(id: string): Promise<{ plan: AtlasPlan; approvalSha256: string }> {
    safeId(id);
    if (!(await this.#base())) throw new Error("Atlas shared plan storage is missing");
    const base = path.join(this.#root, id);
    await directory(base);
    const raw = await regularFile(path.join(base, "approval.json"));
    const approval = parseApproval(raw, id);
    const planFilePath = path.join(base, "plan.md");
    if (planDigest(await regularFile(planFilePath)) !== approval.planSha256) throw new Error("Atlas plan differs from its exact approval");
    const checkpoint = await jsonFile(path.join(base, "checkpoint.json"));
    if (
      checkpoint === null ||
      typeof checkpoint !== "object" ||
      !("approvalSha256" in checkpoint) ||
      checkpoint.approvalSha256 !== planDigest(raw)
    )
      throw new Error("Atlas approval differs from its durable checkpoint");
    await directory(path.join(base, "evidence"));
    let name = approval.name;
    try {
      name = parseLabel(await jsonFile(path.join(base, "label.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      plan: {
        id,
        name,
        originalName: approval.name,
        cwd: approval.cwd,
        directory: base,
        planFilePath,
        ledgerPath: path.join(base, "ledger.json"),
        planSha256: approval.planSha256,
        sourcePlanPath: approval.sourcePlanPath,
        sourceSessionId: approval.sourceSessionId,
        proposedByToolCallId: approval.proposedByToolCallId,
        roadmapStage: approval.roadmapStage,
      },
      approvalSha256: planDigest(raw),
    };
  }

  async create(options: {
    name: string;
    content: string;
    cwd: string;
    sourcePlanPath: string;
    sourceSessionId: string;
    proposedByToolCallId: string;
    availableAgents?: readonly string[];
    roadmapStage?: RoadmapStage;
  }): Promise<AtlasPlan> {
    if (!validName(options.name)) throw new Error("Invalid Atlas plan name");
    if (typeof options.content !== "string" || !options.content.trim()) throw new Error("Atlas requires the exact approved plan content");
    for (const field of [options.sourcePlanPath, options.sourceSessionId, options.proposedByToolCallId]) {
      if (typeof field !== "string" || !field.trim()) throw new Error("Missing native approval provenance");
    }
    if (!path.isAbsolute(options.cwd) || (await fs.realpath(options.cwd)) !== options.cwd) {
      throw new Error("Atlas requires a canonical absolute workspace path");
    }
    if (options.roadmapStage !== undefined && !isRoadmapStage(options.roadmapStage)) throw new Error("Invalid Atlas roadmap stage");
    const slug =
      options.name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 48)
        .replace(/^-+|-+$/g, "") || "plan";
    const id = `${slug}--${randomUUID()}`;
    // The F1 gate measures executed changes from here; outside Git (or without commits) there is no baseline.
    const gitBaseline = await gitHead(options.cwd);
    await this.#base(true);
    const stage = path.join(this.#root, `.pending-${randomUUID()}`);
    const final = path.join(this.#root, id);
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      await fs.mkdir(path.join(stage, "evidence"), { mode: 0o700 });
      await fs.mkdir(path.join(stage, "ownership"), { mode: 0o700 });
      const planFilePath = path.join(final, "plan.md");
      const ledger = createLedger(planFilePath, options.content, options.availableAgents, gitBaseline);
      const approval: Approval = {
        version: 3,
        id,
        name: options.name,
        cwd: options.cwd,
        planSha256: ledger.planSha256,
        sourcePlanPath: options.sourcePlanPath,
        sourceSessionId: options.sourceSessionId,
        proposedByToolCallId: options.proposedByToolCallId,
        roadmapStage: options.roadmapStage,
      };
      const planHandle = await fs.open(path.join(stage, "plan.md"), "wx", 0o600);
      try {
        await planHandle.writeFile(options.content);
        await planHandle.sync();
      } finally {
        await planHandle.close();
      }
      await exclusiveFile(path.join(stage, "approval.json"), approval);
      const raw = await regularFile(path.join(stage, "approval.json"));
      await writeLedgerAtomic(path.join(stage, "checkpoint.json"), checkpointFor(ledger, planDigest(raw)));
      await writeLedgerAtomic(path.join(stage, "ledger.json"), ledger);
      const timeline = await fs.open(path.join(stage, "timeline.jsonl"), "wx", 0o600);
      try {
        await timeline.sync();
      } finally {
        await timeline.close();
      }
      await syncDirectory(path.join(stage, "evidence"));
      await syncDirectory(path.join(stage, "ownership"));
      await syncDirectory(stage);
      try {
        await fs.lstat(final);
        throw new Error("Atlas plan identity collision");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.rename(stage, final);
      await syncDirectory(this.#root);
      return (await this.#plan(id)).plan;
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Every approved plan whose approval records a roadmap stage in `repoRoot` (and `stage` when given), for the
   * `atlas:plans` answer. Synchronous, lock-free and read-only because the answer must arrive inside the request emit;
   * an unreadable or invalid bundle is skipped and reported through `warn`.
   */
  stagePlans(repoRoot: string, stage: string | undefined, warn: (planId: string, error: unknown) => void): AtlasStagePlan[] {
    let entries: Dirent[];
    try {
      const sessionDir = path.dirname(this.#root);
      directorySync(sessionDir);
      if (realpathSync(sessionDir) !== sessionDir) throw new Error("Atlas session directory contains a symlink");
      directorySync(this.#root);
      entries = readdirSync(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn("(store)", error);
      return [];
    }
    const plans: AtlasStagePlan[] = [];
    for (const entry of entries) {
      if (!ID.test(entry.name)) continue;
      try {
        const plan = this.#stagePlan(entry.name, repoRoot, stage);
        if (plan) plans.push(plan);
      } catch (error) {
        warn(entry.name, error);
      }
    }
    return plans.sort((a, b) => a.name.localeCompare(b.name) || a.planId.localeCompare(b.planId));
  }

  #stagePlan(id: string, repoRoot: string, stage: string | undefined): AtlasStagePlan | undefined {
    const base = path.join(this.#root, id);
    directorySync(base);
    const raw = regularFileSync(path.join(base, "approval.json"));
    const approval = parseApproval(raw, id);
    const bound = approval.roadmapStage;
    if (!bound || bound.repoRoot !== repoRoot || (stage !== undefined && bound.id !== stage)) return undefined;
    const planFilePath = path.join(base, "plan.md");
    const content = regularFileSync(planFilePath);
    if (planDigest(content) !== approval.planSha256) throw new Error("Atlas plan differs from its exact approval");
    const data: unknown = JSON.parse(regularFileSync(path.join(base, "ledger.json")));
    const ledger = restoreLedger(data, planFilePath, content, approval.planSha256);
    if (data !== ledger) throw new Error("Atlas shared ledger must use a receipt-bearing version");
    validateCheckpoint(JSON.parse(regularFileSync(path.join(base, "checkpoint.json"))), ledger, planDigest(raw));
    let name = approval.name;
    try {
      name = parseLabel(JSON.parse(regularFileSync(path.join(base, "label.json"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const rows = ledgerRows(ledger);
    const complete = isComplete(ledger);
    const delivery = deliveryResult(ledger, base);
    return {
      planId: id,
      name,
      repoRoot: bound.repoRoot,
      stage: bound.id,
      ...(bound.criteria ? { criteria: [...bound.criteria] } : {}),
      ...(bound.revision ? { revision: bound.revision } : {}),
      status: complete ? "complete" : "unfinished",
      done: rows.filter((row) => row.status === "done").length,
      total: rows.length,
      gates: complete ? gateResults(ledger, base) : [],
      ...(delivery ? { delivery } : {}),
      deferred: ledger.deferred.map((finding) => ({
        id: finding.id,
        title: finding.title,
        ...(finding.triage
          ? { disposition: finding.triage.disposition, ...(finding.triage.reference ? { reference: finding.triage.reference } : {}) }
          : {}),
      })),
      directory: base,
    };
  }

  async list(): Promise<AtlasPlan[]> {
    if (!(await this.#base())) return [];
    const plans: AtlasPlan[] = [];
    for (const entry of await fs.readdir(this.#root, { withFileTypes: true })) {
      if (!ID.test(entry.name)) continue;
      if (!entry.isDirectory()) throw new Error(`Invalid Atlas plan directory: ${entry.name}`);
      try {
        plans.push((await this.#plan(entry.name)).plan);
      } catch (error) {
        const base = path.join(this.#root, entry.name);
        try {
          await fs.lstat(base);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw missing;
        }
        plans.push({
          id: entry.name,
          name: entry.name,
          originalName: entry.name,
          cwd: "",
          directory: base,
          planFilePath: path.join(base, "plan.md"),
          ledgerPath: path.join(base, "ledger.json"),
          planSha256: "",
          sourcePlanPath: "",
          sourceSessionId: "",
          proposedByToolCallId: "",
          invalidReason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return plans.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async find(selector: string): Promise<AtlasPlan> {
    if (typeof selector !== "string" || (!validName(selector) && !ID.test(selector))) throw new Error("Invalid Atlas plan selector");
    if (ID.test(selector)) return (await this.#plan(selector)).plan;
    const plans = await this.list();
    const stem = selector.replace(/-plan$/, "");
    const matches = plans.filter((plan) => [plan.name, plan.originalName].some((name) => name === selector || name === stem));
    if (!matches.length) {
      const available = [...new Set(plans.map((plan) => plan.name))].join(", ");
      throw new Error(
        `No approved Atlas plan named ${selector}; ${available ? `available: ${available}` : "no approved Atlas plans exist"}`,
      );
    }
    if (matches.length > 1)
      throw new Error(`Ambiguous Atlas plan name ${selector}; select by id: ${matches.map((plan) => plan.id).join(", ")}`);
    return matches[0] as AtlasPlan;
  }

  async rename(planId: string, name: string): Promise<void> {
    safeId(planId);
    if (!validName(name)) throw new Error("Invalid Atlas plan name");
    await withLedgerLock(path.join(this.#root, planId, "ledger.json"), async () => {
      const { plan } = await this.#plan(planId);
      await writeLedgerAtomic(path.join(plan.directory, "label.json"), { version: 1, name }, false);
      this.#notify(planId);
    });
  }

  async delete(planId: string, hasPendingWork: () => boolean = () => false): Promise<void> {
    safeId(planId);
    await withLedgerLock(path.join(this.#root, planId, "ledger.json"), async () => {
      if (this.#held.has(planId)) throw new Error("This process holds Atlas plan ownership");
      if (hasPendingWork()) throw new Error("Atlas plan has pending native execution work");
      const base = path.join(this.#root, planId);
      await directory(base);
      await this.#assertNoLiveOwner(path.join(base, "ownership"));
      const staged = path.join(this.#root, `.deleting-${randomUUID()}`);
      // Check again after moving: another process may claim ownership between the first check and rename.
      await fs.rename(base, staged);
      try {
        await this.#assertNoLiveOwner(path.join(staged, "ownership"));
        if (this.#held.has(planId) || hasPendingWork()) throw new Error("Atlas plan has pending native execution work");
      } catch (error) {
        await fs.rename(staged, base);
        throw error;
      }
      await syncDirectory(this.#root);
      await fs.rm(staged, { recursive: true });
      await syncDirectory(this.#root);
    });
  }

  async details(workspace: string): Promise<AtlasPlanDetail[]> {
    return await Promise.all(
      (await this.list()).map(async (plan) => {
        const mismatch = plan.cwd !== workspace;
        if (plan.invalidReason)
          return {
            plan,
            status: `Invalid: ${plan.invalidReason}`,
            done: 0,
            total: 0,
            rows: [],
            timeline: [],
            unfinished: false,
            enterable: false,
            started: false,
            inUse: false,
          };
        try {
          const { approvalSha256 } = await this.#plan(plan.id);
          const data = await jsonFile(plan.ledgerPath);
          const ledger = restoreLedger(data, plan.planFilePath, await regularFile(plan.planFilePath), plan.planSha256);
          if (data !== ledger) throw new Error("Atlas shared ledger must use a receipt-bearing version");
          validateCheckpoint(await jsonFile(path.join(plan.directory, "checkpoint.json")), ledger, approvalSha256);
          const rows = ledgerRows(ledger);
          const done = rows.filter((row) => row.status === "done").length;
          const ownerDir = path.join(plan.directory, "ownership");
          const slots = await this.#ownershipSlots(ownerDir);
          let inUse = false;
          if (slots.length) {
            const generation = slots.length - 1;
            const claim = validateClaim(await jsonFile(path.join(ownerDir, `${generation}.json`)));
            if (!(await this.#released(ownerDir, generation, claim))) {
              try {
                inUse = !(await deadOwner(claim));
              } catch {
                inUse = true;
              }
            }
          }
          const complete = isComplete(ledger);
          const started = slots.length > 0 || rows.some((row) => row.status !== "open");
          const timeline = await this.#timeline(plan, ledger);
          const starts = timeline.filter((event) => event.kind === "started" || event.kind === "attached").map((event) => event.at);
          const status = inUse
            ? "In use by another session"
            : complete
              ? "Complete"
              : started
                ? `In progress ${done}/${rows.length}`
                : "Not started";
          return {
            plan,
            status: `${status}${status.startsWith("In progress") ? "" : ` (${done}/${rows.length})`}${mismatch ? " · Different workspace" : ""}`,
            done,
            total: rows.length,
            timeline,
            startedAt: starts.length ? Math.min(...starts) : undefined,
            rows: rows.map((row) => {
              const verification = verificationStatus(row);
              return {
                id: row.id,
                title: row.title,
                status: row.status,
                agent: row.dispatchAgent ?? row.agent,
                originalAgent: row.agent,
                dispatchAgent: row.dispatchAgent,
                origin: row.origin,
                reason: row.reason,
                acceptance: row.acceptance,
                dependsOn: row.dependsOn,
                tier: row.tier,
                verification: verification && { status: verification, summary: row.verification?.summary },
                evidence: row.evidence,
                attempt: currentAttempt(row),
                startedAt: row.startedAt,
                childAgentId: row.childAgentId,
                updatedAt: row.updatedAt,
                receipt: row.receipt && {
                  receiptId: row.receipt.receiptId,
                  childAgentId: row.receipt.childAgentId,
                  sessionId: row.receipt.sessionId,
                  capturedAt: row.receipt.capturedAt,
                },
                outputPath: row.receipt && path.join(plan.directory, "evidence", `${row.receipt.receiptId}.md`),
              };
            }),
            unfinished: !mismatch && !complete,
            enterable: !mismatch && !complete && !inUse,
            started,
            inUse,
            delivery: ledger.delivery,
            deferred: ledger.deferred.map((finding) => ({ ...finding })),
          };
        } catch (error) {
          return {
            plan,
            status: `Invalid: ${error instanceof Error ? error.message : String(error)}${mismatch ? " · Different workspace" : ""}`,
            done: 0,
            total: 0,
            rows: [],
            timeline: [],
            unfinished: false,
            enterable: false,
            started: false,
            inUse: false,
          };
        }
      }),
    );
  }

  async #timeline(plan: AtlasPlan, ledger: ExecutionLedger): Promise<AtlasEvent[]> {
    try {
      const saved = parseTimeline(await regularFile(path.join(plan.directory, "timeline.jsonl")));
      const derived = derivedTimeline(ledger, plan.sourceSessionId).filter(
        (event) =>
          !saved.some(
            (entry) =>
              entry.kind === event.kind &&
              entry.row === event.row &&
              (entry.kind === "reopened" || entry.kind === "fix_added" || entry.kind === "discovered" || entry.attempt === event.attempt),
          ),
      );
      return [...saved, ...derived].sort((a, b) => a.at - b.at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return derivedTimeline(ledger, plan.sourceSessionId);
      console.warn(`Atlas timeline could not be loaded for ${plan.id}: ${String(error)}`);
      return [];
    }
  }

  async #appendTimeline(plan: AtlasPlan, events: AtlasEvent[]): Promise<void> {
    if (!events.length) return;
    try {
      const handle = await fs.open(
        path.join(plan.directory, "timeline.jsonl"),
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        // Separate a partial final line left by a crash from the next real event.
        await handle.writeFile(`\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      console.warn(`Atlas timeline append failed for ${plan.id}: ${String(error)}`);
    }
  }

  async #assertNoLiveOwner(ownerDir: string): Promise<void> {
    await directory(ownerDir);
    const slots = await this.#ownershipSlots(ownerDir);
    if (!slots.length) return;
    const generation = slots.length - 1;
    const claim = validateClaim(await jsonFile(path.join(ownerDir, `${generation}.json`)));
    if (!(await this.#released(ownerDir, generation, claim)) && !(await deadOwner(claim))) {
      throw new Error("Atlas plan has a live execution owner");
    }
  }

  async #ownershipSlots(ownerDir: string): Promise<number[]> {
    const slots: number[] = [];
    for (const entry of await fs.readdir(ownerDir)) {
      if (entry.endsWith(".tmp") || /^\d+\.released\.json$/.test(entry)) continue;
      if (!/^(0|[1-9]\d*)\.json$/.test(entry)) throw new Error("Malformed Atlas ownership history");
      slots.push(Number(entry.slice(0, -5)));
    }
    slots.sort((a, b) => a - b);
    if (slots.some((slot, index) => !Number.isSafeInteger(slot) || slot !== index))
      throw new Error("Atlas ownership history has missing generations");
    return slots;
  }

  async #released(ownerDir: string, generation: number, claim: Claim): Promise<boolean> {
    try {
      const marker = await jsonFile(path.join(ownerDir, `${generation}.released.json`));
      if (
        marker === null ||
        typeof marker !== "object" ||
        !("version" in marker) ||
        marker.version !== 1 ||
        !("token" in marker) ||
        marker.token !== claim.token
      )
        throw new Error("Invalid Atlas ownership release");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async #ownershipDir(plan: AtlasPlan): Promise<string> {
    if (!(await this.#base())) throw new Error("Atlas shared plan storage is missing");
    await directory(plan.directory);
    const ownerDir = path.join(plan.directory, "ownership");
    await directory(ownerDir);
    return ownerDir;
  }

  /** Immutable generations are an exclusive-create CAS; recovery never removes a competing claim. */
  async #claimSlot(plan: AtlasPlan, sessionId: string): Promise<{ generation: number; claim: Claim }> {
    const ownerDir = await this.#ownershipDir(plan);
    const generation = (await this.#ownershipSlots(ownerDir)).length;
    if (generation > 0) {
      const previous = validateClaim(await jsonFile(path.join(ownerDir, `${generation - 1}.json`)));
      if (!(await this.#released(ownerDir, generation - 1, previous)) && !(await deadOwner(previous))) {
        throw new Error("Atlas plan has a live execution owner");
      }
    }
    const claim: Claim = {
      version: 1,
      host: hostname(),
      pid: process.pid,
      processToken,
      storeToken: this.#storeToken,
      sessionId,
      token: randomUUID(),
    };
    try {
      await exclusiveFile(path.join(ownerDir, `${generation}.json`), claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Atlas plan ownership was claimed concurrently; retry");
      throw error;
    }
    return { generation, claim };
  }

  async #assertOwner(plan: AtlasPlan, sessionId: string): Promise<{ generation: number; claim: Claim; approvalSha256: string }> {
    const held = this.#held.get(plan.id);
    if (!held || held.claim.sessionId !== sessionId) throw new Error("This Atlas store/session does not own the plan");
    const dir = await this.#ownershipDir(plan);
    const onDisk = validateClaim(await jsonFile(path.join(dir, `${held.generation}.json`)));
    if (JSON.stringify(onDisk) !== JSON.stringify(held.claim)) throw new Error("Atlas ownership claim changed");
    try {
      await jsonFile(path.join(dir, `${held.generation}.released.json`));
      throw new Error("Atlas ownership was released");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A later generation must never supersede a live claim. Detect one instead of writing under a split owner.
    try {
      await fs.lstat(path.join(dir, `${held.generation + 1}.json`));
      throw new Error("Atlas ownership has a competing successor");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return held;
  }

  async acquire(planId: string, sessionId: string): Promise<void> {
    safeId(planId);
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Atlas session identity is missing");
    await withLedgerLock(path.join(this.#root, planId, "ledger.json"), async () => {
      const { plan, approvalSha256 } = await this.#plan(planId);
      const data = await jsonFile(plan.ledgerPath);
      const ledger = restoreLedger(data, plan.planFilePath, await regularFile(plan.planFilePath), plan.planSha256);
      if (ledger !== data) throw new Error("Atlas shared ledger must use a receipt-bearing version");
      validateCheckpoint(await jsonFile(path.join(plan.directory, "checkpoint.json")), ledger, approvalSha256);
      if (this.#held.has(plan.id)) {
        const held = await this.#assertOwner(plan, sessionId);
        if (held.approvalSha256 !== approvalSha256) throw new Error("Atlas approval changed during ownership");
        return;
      }
      this.#held.set(plan.id, { plan, approvalSha256, ...(await this.#claimSlot(plan, sessionId)) });
      await this.#appendTimeline(plan, [{ version: 1, at: Date.now(), kind: "attached", sessionId }]);
      this.#notify(planId);
    });
  }

  async release(planId: string, sessionId: string): Promise<void> {
    safeId(planId);
    await withLedgerLock(path.join(this.#root, planId, "ledger.json"), async () => {
      // Exiting mode must still work when execution data is damaged. Only ownership is needed here.
      const owned = this.#held.get(planId);
      if (!owned) throw new Error("This Atlas store/session does not own the plan");
      const held = await this.#assertOwner(owned.plan, sessionId);
      await exclusiveFile(path.join(await this.#ownershipDir(owned.plan), `${held.generation}.released.json`), {
        version: 1,
        token: held.claim.token,
      });
      this.#held.delete(planId);
      await this.#appendTimeline(owned.plan, [{ version: 1, at: Date.now(), kind: "released", sessionId }]);
      this.#notify(planId);
    });
  }

  async #verifyReceipt(plan: AtlasPlan, ledger: ExecutionLedger, receipt: ChildReceipt): Promise<boolean> {
    if (!validReceipt(receipt) || receipt.ledgerId !== ledger.ledgerId || receipt.planSha256 !== ledger.planSha256) return false;
    try {
      await directory(path.join(plan.directory, "evidence"));
      const base = path.join(plan.directory, "evidence", receipt.receiptId);
      const saved = await jsonFile(`${base}.json`);
      const output = await regularFile(`${base}.md`);
      const row = ledgerRows(ledger).find((item) => item.id === receipt.rowId);
      const verify = row?.verification?.attempt !== undefined && receipt.attempt === row.verification.attempt;
      const startedAt = verify ? row?.verification?.startedAt : row?.startedAt;
      if (
        !row ||
        startedAt === undefined ||
        receipt.childCreatedAt < startedAt ||
        receipt.capturedAt < receipt.childCreatedAt ||
        JSON.stringify(saved) !== JSON.stringify(receipt) ||
        !output.trim() ||
        planDigest(output) !== receipt.outputSha256
      )
        return false;
      // Only a passing verifier's output is ever archived as verification proof.
      if (verify) return parseVerifyOutput(output, ledger, row).verdict === "PASS";
      if (row.id.startsWith("F")) validateGateOutput(output, ledger, row);
      return true;
    } catch {
      return false;
    }
  }

  /** The row's own child receipt matches its attempt, the leading checkpoint, and the archived output. */
  async #provenReceipt(plan: AtlasPlan, ledger: ExecutionLedger, row: LedgerItem, saved: Attempt | null | undefined): Promise<boolean> {
    const receipt = row.receipt;
    return (
      receipt !== undefined &&
      validReceipt(receipt) &&
      saved?.receiptId === receipt.receiptId &&
      receipt.rowId === row.id &&
      receipt.attempt === row.attempt &&
      receipt.childAgentId === row.childAgentId &&
      (await this.#verifyReceipt(plan, ledger, receipt))
    );
  }

  /** A HEAVY row's passing verifier: a fresh child bound to the checkpointed verification attempt. */
  async #provenVerification(
    plan: AtlasPlan,
    ledger: ExecutionLedger,
    row: LedgerItem,
    saved: Attempt | null | undefined,
  ): Promise<boolean> {
    const verification = row.verification;
    const receipt = verification?.receipt;
    const bound = saved?.verify;
    return (
      verification?.verdict === "pass" &&
      receipt !== undefined &&
      validReceipt(receipt) &&
      bound !== undefined &&
      bound.attempt === verification.attempt &&
      bound.startedAt === verification.startedAt &&
      bound.receiptId === receipt.receiptId &&
      receipt.rowId === row.id &&
      receipt.attempt === verification.attempt &&
      receipt.childAgentId === verification.childAgentId &&
      !(receipt.sessionId === row.receipt?.sessionId && receipt.childAgentId === row.receipt?.childAgentId) &&
      (await this.#verifyReceipt(plan, ledger, receipt))
    );
  }

  async transaction<T>(
    planId: string,
    sessionId: string,
    run: (ledger: ExecutionLedger, plan: AtlasPlan) => Promise<T> | T,
    options?: { resume?: boolean; assertActive?: () => void },
  ): Promise<T> {
    safeId(planId);
    return await withLedgerLock(path.join(this.#root, planId, "ledger.json"), async () => {
      const { plan, approvalSha256 } = await this.#plan(planId);
      const held = await this.#assertOwner(plan, sessionId);
      if (held.approvalSha256 !== approvalSha256) throw new Error("Atlas approval changed during ownership");
      const content = await regularFile(plan.planFilePath);
      const data = await jsonFile(plan.ledgerPath);
      const ledger = restoreLedger(data, plan.planFilePath, content, plan.planSha256);
      if (data !== ledger) throw new Error("Atlas shared ledger must use a receipt-bearing version");
      const checkpoint = validateCheckpoint(await jsonFile(path.join(plan.directory, "checkpoint.json")), ledger, approvalSha256);
      const beforeRecovery = rowSnapshot(ledger);
      let changed = false;
      for (const row of ledgerRows(ledger)) {
        const saved = checkpoint.attempts[row.id];
        const sameAttempt = saved !== null && saved !== undefined && saved.attempt === row.attempt && saved.startedAt === row.startedAt;
        if (row.status === "in_progress" && row.receipt) {
          // A HEAVY row's recorded implementation survives an interruption; only its unfinished verifier is discarded.
          if (row.tier !== "heavy" || !sameAttempt || !(await this.#provenReceipt(plan, ledger, row, saved))) {
            reopenRow(ledger, row.id, INVALID_PROOF);
            changed = true;
          } else if (row.verification?.attempt !== undefined) {
            const sameVerify = saved?.verify?.attempt === row.verification.attempt && saved.verify.startedAt === row.verification.startedAt;
            if (options?.resume || !sameVerify) {
              resetVerification(row);
              changed = true;
            }
          }
        } else if (row.status === "in_progress" && (options?.resume || !sameAttempt)) {
          reopenRow(ledger, row.id, "Interrupted or invalidated attempt reopened; dispatch a fresh child.");
          changed = true;
        }
        if (row.status !== "done") continue;
        if (
          !sameAttempt ||
          !(await this.#provenReceipt(plan, ledger, row, saved)) ||
          (row.tier === "heavy" && !(await this.#provenVerification(plan, ledger, row, saved)))
        ) {
          reopenRow(ledger, row.id, INVALID_PROOF);
          changed = true;
        }
      }
      // Recovery is committed before calling user code; a refused mutation cannot undo invalidation.
      if (changed) {
        await writeLedgerAtomic(path.join(plan.directory, "checkpoint.json"), checkpointFor(ledger, approvalSha256));
        await writeLedgerAtomic(plan.ledgerPath, ledger);
        await this.#appendTimeline(plan, ledgerEvents(beforeRecovery, ledger, sessionId));
        this.#notify(planId);
      }
      const recovered = JSON.stringify(ledger);
      const beforeMutation = rowSnapshot(ledger);
      options?.assertActive?.();
      const scope: TransactionScope = { store: this, plan, sessionId, ledger, checkpoint, active: true, authenticated: new Map() };
      for (const row of ledgerRows(ledger)) {
        if (row.receipt && row.startedAt !== undefined) {
          scope.authenticated.set(row.id, { receipt: JSON.stringify(row.receipt), startedAt: row.startedAt });
        }
        const verification = row.verification;
        if (verification?.receipt && verification.startedAt !== undefined) {
          scope.authenticated.set(`${row.id}#verify`, { receipt: JSON.stringify(verification.receipt), startedAt: verification.startedAt });
        }
      }
      let result: T;
      try {
        result = await scopes.run(scope, () => run(ledger, plan));
      } finally {
        scope.active = false;
      }
      const current = await this.#plan(planId);
      if (current.approvalSha256 !== approvalSha256) throw new Error("Atlas approval changed during transaction");
      await this.#assertOwner(plan, sessionId);
      const validated = restoreLedger(ledger, plan.planFilePath, content, plan.planSha256);
      if (validated !== ledger || ledger.ledgerId !== checkpoint.ledgerId) throw new Error("Atlas ledger identity changed in transaction");
      for (const row of ledgerRows(ledger)) {
        const holdsReceipt = row.status === "done" || (row.status === "in_progress" && row.tier === "heavy" && row.receipt !== undefined);
        if (!holdsReceipt) {
          if (row.receipt || row.verification?.receipt) throw new Error(`Atlas cannot persist a receipt on unfinished row ${row.id}`);
          continue;
        }
        if (
          !row.receipt ||
          row.receipt.rowId !== row.id ||
          row.receipt.attempt !== row.attempt ||
          row.receipt.childAgentId !== row.childAgentId ||
          scope.authenticated.get(row.id)?.receipt !== JSON.stringify(row.receipt) ||
          scope.authenticated.get(row.id)?.startedAt !== row.startedAt ||
          !(await this.#verifyReceipt(plan, ledger, row.receipt))
        ) {
          throw new Error(`Atlas cannot persist unverified completion for ${row.id}`);
        }
        const verification = row.verification;
        if (row.tier !== "heavy" || (row.status !== "done" && !verification?.receipt)) continue;
        const authenticated = scope.authenticated.get(`${row.id}#verify`);
        if (
          row.status !== "done" ||
          verification?.verdict !== "pass" ||
          !verification.receipt ||
          verification.receipt.rowId !== row.id ||
          verification.receipt.attempt !== verification.attempt ||
          verification.receipt.childAgentId !== verification.childAgentId ||
          authenticated?.receipt !== JSON.stringify(verification.receipt) ||
          authenticated.startedAt !== verification.startedAt ||
          !(await this.#verifyReceipt(plan, ledger, verification.receipt))
        ) {
          throw new Error(`Atlas cannot persist unverified completion for ${row.id}`);
        }
      }
      options?.assertActive?.();
      if (JSON.stringify(ledger) !== recovered) {
        // The checkpoint leads the ledger, so interrupted writes cannot authorize stale completion.
        await writeLedgerAtomic(path.join(plan.directory, "checkpoint.json"), checkpointFor(ledger, approvalSha256));
        await writeLedgerAtomic(plan.ledgerPath, ledger);
        await this.#appendTimeline(plan, ledgerEvents(beforeMutation, ledger, sessionId));
        this.#notify(planId);
      }
      return result;
    });
  }

  async saveReceipt(plan: AtlasPlan, receipt: ChildReceipt, nativeOutputPath: string): Promise<void> {
    const scope = scopes.getStore();
    if (!scope?.active || scope.store !== this || scope.plan.id !== plan.id || scope.plan.directory !== plan.directory) {
      throw new Error("Atlas receipts may only be saved inside their owned ledger transaction");
    }
    await this.#assertOwner(scope.plan, scope.sessionId);
    const ledger = scope.ledger;
    if (
      !validReceipt(receipt) ||
      receipt.sessionId !== scope.sessionId ||
      receipt.ledgerId !== ledger.ledgerId ||
      receipt.planSha256 !== ledger.planSha256 ||
      receipt.nativeFinal !== true
    )
      throw new Error("Atlas receipt differs from the owned native assignment");
    const row = ledgerRows(ledger).find((item) => item.id === receipt.rowId);
    // A verifier receipt binds the HEAVY row's verification attempt; every other receipt binds the row attempt.
    const verification = row?.verification;
    const verify = verification?.attempt !== undefined && receipt.attempt === verification.attempt;
    const startedAt = verify ? verification?.startedAt : row?.startedAt;
    const saved = row ? scope.checkpoint.attempts[row.id] : undefined;
    const bound = verify ? saved?.verify : saved;
    if (
      row?.status !== "in_progress" ||
      !row.attempt ||
      row.startedAt === undefined ||
      startedAt === undefined ||
      (verify ? !row.receipt || verification?.verdict !== undefined : row.receipt !== undefined || row.attempt !== receipt.attempt) ||
      receipt.childCreatedAt < startedAt ||
      receipt.capturedAt < receipt.childCreatedAt ||
      bound?.attempt !== receipt.attempt ||
      bound.startedAt !== startedAt
    )
      throw new Error("Atlas receipt does not match an active ledger attempt");
    const evidenceDir = path.join(scope.plan.directory, "evidence");
    await directory(evidenceDir);
    for (const name of await fs.readdir(evidenceDir)) {
      if (!name.endsWith(".json")) continue;
      const old = await jsonFile(path.join(evidenceDir, name));
      if (
        !validReceipt(old) ||
        name !== `${old.receiptId}.json` ||
        old.ledgerId !== ledger.ledgerId ||
        old.planSha256 !== ledger.planSha256
      ) {
        throw new Error("Malformed archived Atlas receipt");
      }
      if (old.receiptId === receipt.receiptId) throw new Error("Atlas receipt identity already exists");
      if ((verify || row.id.startsWith("F")) && old.sessionId === receipt.sessionId && old.childAgentId === receipt.childAgentId) {
        throw new Error("Final gates and verifications require a fresh native child in the origin session");
      }
    }
    const output = await regularFile(nativeOutputPath);
    if (!output.trim() || planDigest(output) !== receipt.outputSha256)
      throw new Error("Native child output no longer matches its captured digest");
    if (verify && parseVerifyOutput(output, ledger, row).verdict !== "PASS") throw new Error("Only a passing verification is archived");
    if (!verify && row.id.startsWith("F")) validateGateOutput(output, ledger, row);
    const copy = path.join(evidenceDir, `${receipt.receiptId}.md`);
    const handle = await fs.open(copy, "wx", 0o600);
    try {
      await handle.writeFile(output);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(evidenceDir);
    await exclusiveFile(path.join(evidenceDir, `${receipt.receiptId}.json`), receipt);
    if (!scope.active) throw new Error("Atlas receipt transaction has already ended");
    scope.authenticated.set(verify ? `${row.id}#verify` : row.id, { receipt: JSON.stringify(receipt), startedAt });
  }
}
