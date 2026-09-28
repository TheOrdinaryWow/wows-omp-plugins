import { createHash } from "node:crypto";

import { isKnownAgent, resolveAgent } from "./agents.ts";

export type ItemStatus = "open" | "in_progress" | "done" | "blocked";

export interface LedgerItem {
  id: string;
  title: string;
  agent: string;
  /** Resolved against the live spawnable roster; absent on older persisted ledgers. */
  dispatchAgent?: string;
  dependsOn: string[];
  status: ItemStatus;
  evidence?: string;
  childAgentId?: string;
  updatedAt: number;
}

export interface ExecutionLedger {
  version: 1;
  planFilePath: string;
  planSha256: string;
  items: LedgerItem[];
  gates: LedgerItem[];
  createdAt: number;
}

const ROW = /^- \[([ xX~])\] (T\d+|F[1-4])\. (.+)$/;
const AGENT_NAME = /^[A-Za-z0-9_-]+$/;
const GATES = [
  { id: "F1", title: "Plan compliance review", agent: "momus" },
  { id: "F2", title: "Code quality review", agent: "code-reviewer" },
  { id: "F3", title: "Real-surface QA", agent: "qa-executor" },
  { id: "F4", title: "Success-criteria fidelity", agent: "gate-reviewer" },
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
      if (match?.[1] !== undefined && match[2] !== undefined) fields.set(match[1].toLowerCase(), match[2]);
    }
    const agent = fields.get("agent");
    if (!agent || !AGENT_NAME.test(agent) || (!isKnownAgent(agent) && !availableAgents?.includes(agent))) {
      errors.push(`${current.id}: Agent must name an available or known fallback agent`);
    } else current.agent = agent;
    const depends = fields.get("depends on");
    if (!depends || !/^(?:none|T[1-9]\d*(?:\s*,\s*T[1-9]\d*)*)$/i.test(depends)) {
      errors.push(`${current.id}: Depends on must list T-ids or none`);
    } else {
      current.dependsOn = depends.toLowerCase() === "none" ? [] : depends.split(/\s*,\s*/);
    }
    if (!fields.get("acceptance")) errors.push(`${current.id}: Acceptance must describe an observable check`);
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
  return { items, gates, errors };
}

export function createLedger(planFilePath: string, planContent: string, availableAgents?: readonly string[]): ExecutionLedger {
  const parsed = parsePlanChecklist(planContent, availableAgents);
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
  const now = Date.now();
  const withDispatch = (item: ParsedItem): LedgerItem => ({
    ...item,
    dispatchAgent: resolveAgent(item.agent, availableAgents).dispatchAgent,
    updatedAt: now,
  });
  return {
    version: 1,
    planFilePath,
    planSha256: createHash("sha256").update(planContent).digest("hex"),
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
  const done = new Set(ledger.items.filter((item) => item.status === "done").map((item) => item.id));
  return ledger.items.filter((item) => item.status === "open" && item.dependsOn.every((id) => done.has(id)));
}

export function isComplete(ledger: ExecutionLedger): boolean {
  return [...ledger.items, ...ledger.gates].every((item) => item.status === "done");
}

export function renderLedgerSummary(ledger: ExecutionLedger, availableAgents?: readonly string[]): string {
  const cell = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
  const lines = [
    `Plan ledger: ${ledger.planFilePath} (sha256 ${ledger.planSha256})`,
    "| ID | Status | Agent | Depends on | Evidence |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of [...ledger.items, ...ledger.gates]) {
    const dependsOn = item.dependsOn.join(", ") || "none";
    const dispatch = item.dispatchAgent ?? resolveAgent(item.agent, availableAgents).dispatchAgent;
    const owner = dispatch === item.agent ? item.agent : `${item.agent} -> ${dispatch ?? "unavailable"}`;
    lines.push(`| ${item.id}. ${cell(item.title)} | ${item.status} | ${owner} | ${dependsOn} | ${cell(item.evidence ?? "—")} |`);
  }
  const next = nextDispatchable(ledger).map((item) => item.id);
  lines.push(`Next dispatchable: ${next.join(", ") || "none"}`);
  return lines.join("\n");
}
