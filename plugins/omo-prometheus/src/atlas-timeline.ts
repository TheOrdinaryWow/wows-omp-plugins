import type { ExecutionLedger, LedgerItem } from "#src/ledger.ts";
import { ledgerRows } from "#src/ledger.ts";

export type AtlasEventKind =
  | "attached"
  | "released"
  | "started"
  | "done"
  | "reopened"
  | "blocked"
  | "fix_added"
  | "gate_passed"
  | "gate_failed";

/** Observation only: never used to authenticate execution or ownership. */
export interface AtlasEvent {
  version: 1;
  at: number;
  kind: AtlasEventKind;
  row?: string;
  attempt?: string;
  sessionId: string;
  detail?: string;
  derived?: true;
}

const KINDS: Record<AtlasEventKind, true> = {
  attached: true,
  released: true,
  started: true,
  done: true,
  reopened: true,
  blocked: true,
  fix_added: true,
  gate_passed: true,
  gate_failed: true,
};

export function rowSnapshot(ledger: ExecutionLedger): Map<string, LedgerItem> {
  return new Map(ledgerRows(ledger).map((row) => [row.id, { ...row }]));
}

function shortDetail(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim().slice(0, 300) || undefined;
}

/** Diff only published row state; a rejected mutation contributes no events. */
export function ledgerEvents(before: ReadonlyMap<string, LedgerItem>, ledger: ExecutionLedger, sessionId: string): AtlasEvent[] {
  const events: AtlasEvent[] = [];
  const rejectedGates = new Set<string>();
  const add = (kind: AtlasEventKind, row: LedgerItem, at: number, detail?: string, attempt = row.attempt) => {
    events.push({ version: 1, at, kind, row: row.id, attempt, sessionId, detail: shortDetail(detail) });
  };
  for (const row of ledgerRows(ledger)) {
    const previous = before.get(row.id);
    if (!previous && row.origin) {
      add("fix_added", row, row.updatedAt, row.evidence ?? `${row.origin}: ${row.title}`);
      rejectedGates.add(row.origin);
    }
    if (row.attempt && row.startedAt !== undefined && previous?.attempt !== row.attempt) add("started", row, row.startedAt);
    if (row.status === "done" && (previous?.status !== "done" || previous.receipt?.receiptId !== row.receipt?.receiptId)) {
      add("done", row, row.receipt?.capturedAt ?? row.updatedAt, row.evidence);
      if (row.id.startsWith("F")) add("gate_passed", row, row.receipt?.capturedAt ?? row.updatedAt, row.evidence);
    }
    if (row.status === "blocked" && (previous?.status !== "blocked" || previous.evidence !== row.evidence)) {
      add("blocked", row, row.updatedAt, row.evidence);
    }
    if (
      previous &&
      row.status === "open" &&
      (previous.status !== "open" || previous.attempt !== row.attempt || previous.evidence !== row.evidence)
    ) {
      add("reopened", row, row.updatedAt, row.evidence, previous.attempt);
      if (row.id.startsWith("F")) rejectedGates.add(row.id);
    }
  }
  for (const id of rejectedGates) {
    const row = ledger.gates.find((gate) => gate.id === id);
    if (row) add("gate_failed", row, row.updatedAt, row.evidence, before.get(id)?.attempt);
  }
  return events;
}

export function derivedTimeline(ledger: ExecutionLedger, sessionId: string): AtlasEvent[] {
  const events: AtlasEvent[] = [];
  for (const row of ledgerRows(ledger)) {
    const add = (kind: AtlasEventKind, at: number, detail?: string) =>
      events.push({
        version: 1,
        at,
        kind,
        row: row.id,
        attempt: row.attempt,
        sessionId: row.receipt?.sessionId ?? sessionId,
        detail: shortDetail(detail),
        derived: true,
      });
    if (row.origin) add("fix_added", row.startedAt ?? row.updatedAt, row.evidence ?? `${row.origin}: ${row.title}`);
    if (row.startedAt !== undefined) add("started", row.startedAt);
    if (row.status === "done") {
      add("done", row.receipt?.capturedAt ?? row.updatedAt, row.evidence);
      if (row.id.startsWith("F")) add("gate_passed", row.receipt?.capturedAt ?? row.updatedAt, row.evidence);
    } else if (row.status === "blocked") add("blocked", row.updatedAt, row.evidence);
    else if (row.status === "open" && row.evidence) add("reopened", row.updatedAt, row.evidence);
  }
  return events.sort((a, b) => a.at - b.at);
}

/** A crash may leave a partial final line; future versions are display-invisible. */
export function parseTimeline(content: string): AtlasEvent[] {
  const events: AtlasEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Partial<AtlasEvent>;
    if (
      event.version !== 1 ||
      typeof event.at !== "number" ||
      !Number.isFinite(event.at) ||
      event.at < 0 ||
      typeof event.kind !== "string" ||
      !Object.hasOwn(KINDS, event.kind) ||
      typeof event.sessionId !== "string" ||
      !event.sessionId ||
      (event.row !== undefined && typeof event.row !== "string") ||
      (event.attempt !== undefined && typeof event.attempt !== "string") ||
      (event.detail !== undefined && typeof event.detail !== "string")
    )
      continue;
    events.push({
      version: 1,
      at: event.at,
      kind: event.kind as AtlasEventKind,
      row: event.row,
      attempt: event.attempt,
      sessionId: event.sessionId,
      detail: shortDetail(event.detail),
    });
  }
  return events;
}
