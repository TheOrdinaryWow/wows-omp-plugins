import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

import type { ExecutionLedger, LedgerItem } from "./ledger.ts";

const TASKS = "Atlas tasks";
const FIXES = "Atlas fixes";
const GATES = "Atlas final gates";
const ATLAS_PHASES: Record<string, true> = { [TASKS]: true, [FIXES]: true, [GATES]: true };

function todoItem(row: LedgerItem): TodoItem {
  const content = `${row.id}. ${row.title}`;
  if (row.status === "blocked") {
    const blocker = row.evidence?.replace(/\s+/g, " ").trim().slice(0, 240);
    return { content, status: "blocked", ...(blocker ? { blocker } : {}) };
  }
  return {
    content,
    status: row.status === "open" ? "pending" : row.status === "done" ? "completed" : "in_progress",
  };
}

/** The ledger alone determines Atlas phase membership, order and state. */
export function atlasTodoPhases(ledger: ExecutionLedger): TodoPhase[] {
  return [
    { name: TASKS, tasks: ledger.items.map(todoItem) },
    ...(ledger.fixes.length ? [{ name: FIXES, tasks: ledger.fixes.map(todoItem) }] : []),
    { name: GATES, tasks: ledger.gates.map(todoItem) },
  ];
}

/** Retain unrelated phases at their existing positions, replacing only reserved Atlas phases. */
export function mergeAtlasTodos(current: readonly TodoPhase[], ledger: ExecutionLedger): TodoPhase[] | undefined {
  const atlas = atlasTodoPhases(ledger);
  const seen = new Set<string>();
  const next: TodoPhase[] = [];
  for (const phase of current) {
    if (!Object.hasOwn(ATLAS_PHASES, phase.name)) {
      next.push(phase);
      continue;
    }
    const replacement = atlas.find((entry) => entry.name === phase.name);
    if (replacement && !seen.has(phase.name)) {
      next.push(replacement);
      seen.add(phase.name);
    }
  }
  for (const phase of atlas) if (!seen.has(phase.name)) next.push(phase);
  return JSON.stringify(next) === JSON.stringify(current) ? undefined : next;
}

/** Follow the host's /todo commit order; only validated, active ledgers may reach this call. */
export function syncAtlasTodos(
  session: { getTodoPhases(): TodoPhase[]; setTodoPhases(phases: TodoPhase[]): void },
  sessionManager: { appendCustomEntry(type: string, data: { phases: TodoPhase[] }): unknown },
  ledger: ExecutionLedger,
): boolean {
  const next = mergeAtlasTodos(session.getTodoPhases(), ledger);
  if (!next) return false;
  session.setTodoPhases(next);
  sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: next });
  return true;
}

/** Non-view host todo operations succeed when repeated against the already-synced target. */
export function atlasTodoRefreshCall(action: "start" | "done" | "reopen" | "block" | "fix", row: LedgerItem): string {
  const op = action === "start" ? "start" : action === "done" ? "done" : action === "block" ? "block" : "unblock";
  const call = {
    op,
    task: `${row.id}. ${row.title}`,
    ...(op === "block" && row.evidence ? { reason: row.evidence.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
  };
  return `Refresh the todo HUD now with the already-synced item: todo(${JSON.stringify(call)}). Do not edit Atlas phases manually.`;
}
