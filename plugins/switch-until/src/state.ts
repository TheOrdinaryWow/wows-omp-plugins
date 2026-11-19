import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { CLI_THINKING_LEVELS, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isRecord } from "@oh-my-pi/pi-utils";

import type { UntilSettings } from "#src/settings.ts";

export const ENTRY_TYPE = "switch-until";
const END_REASONS = ["met", "cancel", "foreign-change", "limit"] as const;
type EndReason = (typeof END_REASONS)[number];
type LimitReason = "turn-limit" | "time-limit";
export type Decision = "met" | LimitReason;

export interface ModelSelection {
  provider: string;
  id: string;
  selector: string;
  thinking?: ConfiguredThinkingLevel;
}

interface UntilStart {
  id: string;
  original: ModelSelection;
  target: ModelSelection;
  goal: string;
  englishGoal: string;
  context?: string;
  startedAt: number;
}

export interface Judgment {
  probability: number;
  at: number;
  evidenceId: string;
}

export interface ActiveUntil extends UntilStart {
  turns: number;
  judgedTurns: number;
  lastJudgment?: Judgment;
}

export type UntilEntry =
  | { kind: "start"; run: UntilStart }
  | { kind: "turn"; id: string; turns: number }
  | { kind: "reconciled"; id: string; modelEntryId: string }
  | { kind: "judgment"; id: string; turns: number; judgedTurns: number; judgment: Judgment }
  | { kind: "translation"; id: string; messageId: string; text: string }
  | { kind: "end"; id: string; reason: EndReason; limit?: LimitReason };

export interface UntilRecord {
  run: ActiveUntil;
  startEntryId: string;
  modelEntryId: string;
  translations: Map<string, string>;
  ended?: EndReason | LimitReason;
}

export function startUntil(start: UntilStart, previous?: ActiveUntil): ActiveUntil {
  return { ...start, original: previous?.original ?? start.original, turns: 0, judgedTurns: 0 };
}

export function resolveRestorePoint<T>(run: ActiveUntil, find: (selector: string) => T | undefined) {
  const model = find(run.original.selector);
  return model === undefined ? undefined : { model, thinking: run.original.thinking };
}

export function deadline(run: ActiveUntil, settings: UntilSettings): number {
  return run.startedAt + settings.maxHours * 3_600_000;
}

export function decide(run: ActiveUntil, settings: UntilSettings, now: number, probability?: number): Decision | undefined {
  if (now >= deadline(run, settings)) return "time-limit";
  if (settings.maxTurns > 0 && run.turns >= settings.maxTurns) return "turn-limit";
  if (probability !== undefined && probability >= settings.minimumConfidence) return "met";
  return undefined;
}

export function encodeEntry(entry: UntilEntry): { version: 1 } & UntilEntry {
  return { version: 1, ...entry };
}

function isSelection(value: unknown): value is ModelSelection {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.id === "string" &&
    typeof value.selector === "string" &&
    (value.thinking === undefined || value.thinking === "inherit" || CLI_THINKING_LEVELS.some((level) => level === value.thinking))
  );
}

function isStart(value: unknown): value is UntilStart {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isSelection(value.original) &&
    isSelection(value.target) &&
    typeof value.goal === "string" &&
    typeof value.englishGoal === "string" &&
    (value.context === undefined || typeof value.context === "string") &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt)
  );
}

export function isProbability(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function isJudgment(value: unknown): value is Judgment {
  return (
    isRecord(value) &&
    isProbability(value.probability) &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    typeof value.evidenceId === "string"
  );
}

function isTurnCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function readWorkflow(branch: readonly SessionEntry[]): UntilRecord | undefined {
  let workflow: UntilRecord | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data) || data.version !== 1) continue;
    if (data.kind === "start" && isStart(data.run)) {
      workflow = { run: startUntil(data.run), startEntryId: entry.id, modelEntryId: entry.id, translations: new Map() };
      continue;
    }
    if (!workflow || workflow.ended || data.id !== workflow.run.id) continue;
    const { run } = workflow;
    if (data.kind === "end") {
      const reason = END_REASONS.find((reason) => reason === data.reason);
      workflow.ended = reason === "limit" && (data.limit === "turn-limit" || data.limit === "time-limit") ? data.limit : reason;
    }
    if (data.kind === "translation" && typeof data.messageId === "string" && typeof data.text === "string") {
      workflow.translations.set(data.messageId, data.text);
    }
    if (data.kind === "reconciled" && typeof data.modelEntryId === "string") workflow.modelEntryId = data.modelEntryId;
    if (!isTurnCount(data.turns) || data.turns < run.turns) continue;
    if (data.kind === "turn") run.turns = data.turns;
    if (data.kind === "judgment" && isTurnCount(data.judgedTurns) && isJudgment(data.judgment)) {
      run.turns = data.turns;
      run.judgedTurns = data.judgedTurns;
      run.lastJudgment = data.judgment;
    }
  }
  return workflow;
}

export function restoreUntil(branch: readonly SessionEntry[]): ActiveUntil | undefined {
  const workflow = readWorkflow(branch);
  return workflow?.ended ? undefined : workflow?.run;
}
