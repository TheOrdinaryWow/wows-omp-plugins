import { createHash, randomUUID } from "node:crypto";

import { isKnownAgent, resolveAgent } from "./agents.ts";

export type ItemStatus = "open" | "in_progress" | "done" | "blocked";

export interface LedgerItem {
  id: string;
  title: string;
  agent: string;
  acceptance: string;
  /** Resolved against the live spawnable roster. */
  dispatchAgent?: string;
  dependsOn: string[];
  status: ItemStatus;
  evidence?: string;
  childAgentId?: string;
  attempt?: string;
  startedAt?: number;
  receipt?: ChildReceipt;
  updatedAt: number;
}

export interface ExecutionLedger {
  version: 2;
  ledgerId: string;
  planFilePath: string;
  planSha256: string;
  items: LedgerItem[];
  gates: LedgerItem[];
  createdAt: number;
}

/** Produced only after a native completed-child result has been inspected. Mirrored in session entries. */
export interface ChildReceipt {
  receiptId: string;
  ledgerId: string;
  planSha256: string;
  rowId: string;
  attempt: string;
  childAgentId: string;
  parentAgentId: string;
  sessionId: string;
  childCreatedAt: number;
  outputSha256: string;
  capturedAt: number;
  nativeFinal: true;
}

export function planDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const ROW = /^- \[([ xX~])\] (T\d+|F[1-4])\. (.+)$/;
const AGENT_NAME = /^[A-Za-z0-9_-]+$/;
const GATES = [
  { id: "F1", title: "Plan compliance review", agent: "momus" },
  { id: "F2", title: "Code quality review", agent: "deep-high" },
  { id: "F3", title: "Real-surface QA", agent: "deep-low" },
  { id: "F4", title: "Success-criteria fidelity", agent: "deep-high" },
] as const;

type ParsedItem = Omit<LedgerItem, "updatedAt">;

export function parsePlanChecklist(
  planContent: string,
  availableAgents?: readonly string[],
): { items: ParsedItem[]; gates: ParsedItem[]; errors: string[] } {
  const items: ParsedItem[] = [];
  const gates: ParsedItem[] = [];
  const errors: string[] = [];
  let section: "tasks" | "gates" | undefined;
  let hasTasks = false;
  let hasGates = false;
  let body: string[] = [];
  let current: ParsedItem | undefined;
  let fence: { marker: string; length: number } | undefined;

  const finishTask = () => {
    if (!current || section !== "tasks") return;
    const fields = new Map<string, string>();
    for (const line of body) {
      const match = /^\s+(?:-\s*)?(Agent|Depends on|Acceptance):\s*(.*?)\s*$/i.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        const key = match[1].toLowerCase();
        if (fields.has(key)) errors.push(`${current.id}: duplicate ${match[1]} field`);
        fields.set(key, match[2]);
      }
    }
    const agent = fields.get("agent");
    if (!agent || !AGENT_NAME.test(agent) || (!isKnownAgent(agent) && !availableAgents?.includes(agent))) {
      errors.push(`${current.id}: Agent must name an available or known fallback agent`);
    } else current.agent = agent;
    const depends = fields.get("depends on");
    if (!depends || !/^(?:none|T[1-9]\d*(?:\s*,\s*T[1-9]\d*)*)$/i.test(depends)) {
      errors.push(`${current.id}: Depends on must list T-ids or none`);
    } else {
      current.dependsOn = depends.toLowerCase() === "none" ? [] : depends.toUpperCase().split(/\s*,\s*/);
    }
    current.acceptance = fields.get("acceptance") ?? "";
    if (!current.acceptance) errors.push(`${current.id}: Acceptance must describe an observable check`);
    body = [];
    current = undefined;
  };

  for (const [index, line] of planContent.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    const fenceMarker = fenceMatch?.[1];
    if (fence) {
      if (fenceMarker?.[0] === fence.marker && fenceMarker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceMarker) {
      fence = { marker: fenceMarker[0] ?? "", length: fenceMarker.length };
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      finishTask();
      if (trimmed === "## Tasks") {
        if (hasTasks) errors.push("Duplicate ## Tasks section");
        hasTasks = true;
        section = "tasks";
      } else if (trimmed === "## Final gates") {
        if (hasGates) errors.push("Duplicate ## Final gates section");
        hasGates = true;
        section = "gates";
      } else section = undefined;
      continue;
    }
    if (!section) continue;
    if (/^- \[/.test(line)) {
      finishTask();
      const match = ROW.exec(line);
      const mark = match?.[1];
      const id = match?.[2];
      const title = match?.[3];
      if (!mark || !id || !title || (section === "tasks" ? !id.startsWith("T") : !id.startsWith("F"))) {
        errors.push(`Line ${index + 1}: malformed ${section} checklist row`);
        continue;
      }
      const entry: ParsedItem = {
        id,
        title: title.trim(),
        agent: "task",
        acceptance: title.trim(),
        dependsOn: [],
        status: /[xX]/.test(mark) ? "done" : mark === "~" ? "in_progress" : "open",
      };
      if (!entry.title) errors.push(`Line ${index + 1}: checklist title is empty`);
      if (section === "tasks") {
        if (id !== `T${items.length + 1}`) errors.push(`Line ${index + 1}: task ids must be unique and sequential from T1`);
        items.push(entry);
        current = entry;
      } else {
        const expected = GATES[gates.length];
        if (!expected || id !== expected.id || entry.title !== expected.title) {
          errors.push(`Line ${index + 1}: final gates must be F1–F4 with their required titles in order`);
        }
        entry.agent = expected?.agent ?? "task";
        gates.push(entry);
      }
    } else if (current && section === "tasks") {
      body.push(line);
    }
  }
  finishTask();
  if (!hasTasks || items.length === 0) errors.push("Missing ## Tasks or T rows");
  if (!hasGates || gates.length !== 4) errors.push("## Final gates must contain exactly four F rows");
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency) || dependency === item.id) errors.push(`${item.id}: invalid dependency ${dependency}`);
    }
  }
  const pending = new Map(items.map((item) => [item.id, new Set(item.dependsOn)]));
  for (;;) {
    const ready = [...pending].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    if (!ready.length) break;
    for (const id of ready) pending.delete(id);
    for (const dependencies of pending.values()) for (const id of ready) dependencies.delete(id);
  }
  if (pending.size && !errors.length) errors.push(`Dependency cycle: ${[...pending.keys()].join(", ")}`);
  for (const gate of gates) {
    gate.dependsOn = [...ids, ...(gate.id === "F4" ? ["F1", "F2", "F3"] : [])];
  }
  return { items, gates, errors };
}

export function createLedger(planFilePath: string, planContent: string, availableAgents?: readonly string[]): ExecutionLedger {
  const parsed = parsePlanChecklist(planContent, availableAgents);
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
  const now = Date.now();
  const withDispatch = (item: ParsedItem): LedgerItem => ({
    ...item,
    dispatchAgent: resolveAgent(item.agent, availableAgents).dispatchAgent,
    // Plan checkboxes are not receipts. Even checked rows require execution evidence.
    status: "open",
    updatedAt: now,
  });
  return {
    version: 2,
    ledgerId: randomUUID(),
    planFilePath,
    planSha256: planDigest(planContent),
    items: parsed.items.map(withDispatch),
    gates: parsed.gates.map(withDispatch),
    createdAt: now,
  };
}

/** Rebind unfinished rows after the installed roster or spawn policy changes. */
export function refreshDispatchAgents(ledger: ExecutionLedger, availableAgents?: readonly string[]): boolean {
  let changed = false;
  for (const item of [...ledger.items, ...ledger.gates]) {
    if (item.status === "done") continue;
    const dispatchAgent = resolveAgent(item.agent, availableAgents).dispatchAgent;
    if (item.dispatchAgent === dispatchAgent) continue;
    item.dispatchAgent = dispatchAgent;
    changed = true;
  }
  return changed;
}

export function nextDispatchable(ledger: ExecutionLedger): LedgerItem[] {
  const rows = [...ledger.items, ...ledger.gates];
  const done = new Set(rows.filter((item) => item.status === "done").map((item) => item.id));
  return rows.filter((item) => item.status === "open" && item.dependsOn.every((id) => done.has(id)));
}

export function isComplete(ledger: ExecutionLedger): boolean {
  return [...ledger.items, ...ledger.gates].every((item) => item.status === "done" && item.receipt !== undefined);
}

export function renderLedgerSummary(ledger: ExecutionLedger, availableAgents?: readonly string[]): string {
  const cell = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
  const lines = [
    `Plan ledger: ${ledger.planFilePath} (sha256 ${ledger.planSha256})`,
    "| ID | Status | Agent | Depends on | Acceptance | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of [...ledger.items, ...ledger.gates]) {
    const dependsOn = item.dependsOn.join(", ") || "none";
    const dispatch = item.dispatchAgent ?? resolveAgent(item.agent, availableAgents).dispatchAgent;
    const owner = dispatch === item.agent ? item.agent : `${item.agent} -> ${dispatch ?? "unavailable"}`;
    lines.push(
      `| ${item.id}. ${cell(item.title)} | ${item.status} | ${owner} | ${dependsOn} | ${cell(item.acceptance)} | ${cell(item.evidence ?? "—")} |`,
    );
    if (item.status === "in_progress") {
      lines.push(
        `Assignment for ${item.id}: prometheus_assignment: ${JSON.stringify({ planSha256: ledger.planSha256, rows: { [item.id]: item.attempt } })}`,
      );
    }
  }
  const next = nextDispatchable(ledger).map((item) => item.id);
  lines.push(`Next dispatchable: ${next.join(", ") || "none"}`);
  return lines.join("\n");
}

/** Restore structural state only; callers must independently authenticate each completed receipt. */
export function restoreLedger(data: unknown, planFilePath: string, planContent: string, approvedSha256: string): ExecutionLedger {
  if (!data || typeof data !== "object" || !("version" in data)) throw new Error("Execution ledger is not a versioned object");
  const version = data.version;
  if (version !== 1 && version !== 2) throw new Error("Unsupported execution ledger version");
  // Validate the complete persisted shape and its approved definition below before returning it.
  const saved = data as ExecutionLedger;
  if (saved.planFilePath !== planFilePath || saved.planSha256 !== approvedSha256 || planDigest(planContent) !== approvedSha256) {
    throw new Error("Execution ledger or current plan no longer matches the exact approved plan");
  }
  if (!Array.isArray(saved.items) || !Array.isArray(saved.gates) || !Number.isFinite(saved.createdAt)) {
    throw new Error("Malformed execution ledger rows or creation time");
  }
  const expected = createLedger(
    planFilePath,
    planContent,
    saved.items.map((item) => item?.agent),
  );
  if (saved.items.length !== expected.items.length || saved.gates.length !== expected.gates.length) {
    throw new Error("Execution ledger rows differ from the approved plan");
  }
  const rows = [...saved.items, ...saved.gates];
  const definitions = [...expected.items, ...expected.gates];
  for (const [index, row] of rows.entries()) {
    const definition = definitions[index];
    if (
      !row ||
      !definition ||
      row.id !== definition.id ||
      row.title !== definition.title ||
      row.agent !== definition.agent ||
      !Array.isArray(row.dependsOn) ||
      JSON.stringify(row.dependsOn) !== JSON.stringify(version === 1 && row.id.startsWith("F") ? [] : definition.dependsOn) ||
      !["open", "in_progress", "done", "blocked"].includes(row.status) ||
      !Number.isFinite(row.updatedAt) ||
      (row.evidence !== undefined && typeof row.evidence !== "string") ||
      (row.childAgentId !== undefined && typeof row.childAgentId !== "string") ||
      (row.dispatchAgent !== undefined && typeof row.dispatchAgent !== "string") ||
      (version === 2 && row.acceptance !== definition.acceptance)
    ) {
      throw new Error(`Malformed execution ledger row ${definition?.id ?? index}`);
    }
    if (
      version === 2 &&
      (row.status === "in_progress" || row.status === "done") &&
      (typeof row.attempt !== "string" || !row.attempt || !Number.isFinite(row.startedAt))
    ) {
      // Missing historical proof reopens below rather than grandfathering completion.
      if (row.status !== "done") throw new Error(`Missing attempt binding for ${row.id}`);
    }
  }
  if (version === 1) return expected;
  if (typeof saved.ledgerId !== "string" || !saved.ledgerId) throw new Error("Missing execution ledger identity");
  for (const row of rows) {
    if (row.status === "in_progress" || row.status === "done") {
      if (row.dependsOn.some((id) => rows.find((candidate) => candidate.id === id)?.status !== "done")) {
        throw new Error(`${row.id} is active despite unfinished dependencies`);
      }
    }
  }
  return saved;
}

/** Clear stale downstream work, including running attempts, whenever an input is reopened or blocked. */
export function invalidateRows(ledger: ExecutionLedger, id: string, reason?: string): string[] {
  const rows = [...ledger.items, ...ledger.gates];
  const affected = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!affected.has(row.id) && row.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(row.id);
        changed = true;
      }
    }
  }
  for (const row of rows) {
    if (!affected.has(row.id)) continue;
    row.status = "open";
    row.evidence = reason;
    row.childAgentId = undefined;
    row.attempt = undefined;
    row.startedAt = undefined;
    row.receipt = undefined;
    row.updatedAt = Math.max(Date.now(), row.updatedAt + 1);
  }
  return [...affected];
}

export function startRow(ledger: ExecutionLedger, id: string): LedgerItem {
  const rows = [...ledger.items, ...ledger.gates];
  const row = rows.find((item) => item.id === id);
  if (!row) throw new Error(`Unknown ledger row ${id}`);
  if (row.status !== "open") throw new Error(`${id} is ${row.status}; reopen it before starting a fresh attempt`);
  const unfinished = row.dependsOn.filter((dependency) => rows.find((item) => item.id === dependency)?.status !== "done");
  if (unfinished.length) throw new Error(`${id} depends on unfinished rows: ${unfinished.join(", ")}`);
  if (!row.dispatchAgent) throw new Error(`${id} has no available dispatch agent`);
  row.status = "in_progress";
  row.attempt = randomUUID();
  row.startedAt = Date.now();
  row.updatedAt = Math.max(row.startedAt, row.updatedAt + 1);
  row.evidence = undefined;
  return row;
}
