/**
 * Atlas decision dialogs. The host's `confirm` paints the whole message in the accent color under a Yes/No pair, so
 * long bodies become an unreadable wall. A decision is instead a `select`: the question plus a short summary, an
 * accept option and a decline option whose labels name what happens, and an optional "Review full details" option
 * that shows the complete text read-only and comes back to the same decision.
 *
 * Decisions Atlas raises on its own (retry grants, acceptance amendments, the completion release) follow a per-decision
 * policy setting, so an unattended run is not held for hours by a dialog nobody sees.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { DecidedBy } from "./ledger.ts";

export interface DecisionOption {
  label: string;
  description: string;
}

export interface Decision {
  /** The question, the dialog's title line. */
  question: string;
  /** At most a few short lines under the question. */
  summary: readonly string[];
  accept: DecisionOption;
  decline: DecisionOption;
  /** The complete text behind the summary, shown read-only on request. */
  details?: string;
  /** Initial cursor: the decline unless the user asked for the action themselves. */
  initial: "accept" | "decline";
}

export const REVIEW_DETAILS: DecisionOption = {
  label: "Review full details",
  description: "Shows the complete text read-only; closing it returns to this choice",
};

type DecisionUI = Pick<ExtensionContext["ui"], "select" | "editor">;

/**
 * With `timeoutMs`, each prompt of the decision waits that long (the TUI restarts the countdown on input) and an
 * unanswered one is `"timeout"`.
 */
async function prompt(ui: DecisionUI, decision: Decision, timeoutMs?: number): Promise<boolean | "timeout"> {
  const options = [decision.accept, decision.decline, ...(decision.details === undefined ? [] : [REVIEW_DETAILS])];
  const title = [decision.question, ...decision.summary].join("\n");
  const initialIndex = decision.initial === "accept" ? 0 : 1;
  while (true) {
    let timedOut = false;
    const choice = await ui.select(
      title,
      options,
      timeoutMs === undefined ? { initialIndex } : { initialIndex, timeout: timeoutMs, onTimeout: () => (timedOut = true) },
    );
    if (timedOut) return "timeout";
    if (choice !== REVIEW_DETAILS.label || decision.details === undefined) return choice === decision.accept.label;
    await ui.editor(`${decision.question} (read-only)`, decision.details);
  }
}

/** True only for the accept option; Esc, a dismissed dialog and the decline all decline. */
export async function decide(ui: DecisionUI, decision: Decision): Promise<boolean> {
  return (await prompt(ui, decision)) === true;
}

/** How one kind of Atlas decision is settled: always ask, ask with a fallback after a timeout, or never ask. */
export type DecisionPolicy = "ask" | "ask-then-approve" | "ask-then-decline" | "approve" | "decline";

const DECISION_POLICIES: readonly DecisionPolicy[] = ["ask", "ask-then-approve", "ask-then-decline", "approve", "decline"];

function parseDecisionPolicy(name: string, value: unknown): DecisionPolicy {
  if (value === undefined) return "ask";
  if (DECISION_POLICIES.includes(value as DecisionPolicy)) return value as DecisionPolicy;
  throw new Error(`invalid ${name} ${JSON.stringify(value)}`);
}

function parseWholeNumber(name: string, value: unknown, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min) return value;
  throw new Error(`invalid ${name} ${JSON.stringify(value)}`);
}

export interface DecisionSettings {
  retry: DecisionPolicy;
  amend: DecisionPolicy;
  release: DecisionPolicy;
  /** How long an `ask-then-*` dialog waits for an answer. */
  timeoutMs: number;
  /** Retry windows per row a setting may grant without the user; 0 means unlimited. */
  autoRetryLimit: number;
}

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  retry: "ask",
  amend: "ask",
  release: "ask",
  timeoutMs: 30 * 60_000,
  autoRetryLimit: 1,
};

/** Reads every decision setting; an invalid one keeps its default and is reported through `warn`. */
export function parseDecisionSettings(settings: Record<string, unknown>, warn: (message: string) => void): DecisionSettings {
  const read = <T>(parse: () => T, fallback: T): T => {
    try {
      return parse();
    } catch (error) {
      warn(`${error instanceof Error ? error.message : String(error)}; using ${JSON.stringify(fallback)}`);
      return fallback;
    }
  };
  const defaults = DEFAULT_DECISION_SETTINGS;
  const timeoutMinutes = defaults.timeoutMs / 60_000;
  return {
    retry: read(() => parseDecisionPolicy("atlasRetry", settings.atlasRetry), defaults.retry),
    amend: read(() => parseDecisionPolicy("atlasAmend", settings.atlasAmend), defaults.amend),
    release: read(() => parseDecisionPolicy("atlasRelease", settings.atlasRelease), defaults.release),
    timeoutMs: read(() => parseWholeNumber("atlasAskTimeout", settings.atlasAskTimeout, timeoutMinutes, 1), timeoutMinutes) * 60_000,
    autoRetryLimit: read(
      () => parseWholeNumber("atlasAutoRetryLimit", settings.atlasAutoRetryLimit, defaults.autoRetryLimit, 0),
      defaults.autoRetryLimit,
    ),
  };
}

/** An `approve` policy that may no longer approve on its own (the automatic retry limit) settles as its decline form. */
export function withoutAutoApproval(policy: DecisionPolicy): DecisionPolicy {
  if (policy === "approve") return "decline";
  if (policy === "ask-then-approve") return "ask-then-decline";
  return policy;
}

export interface Settled {
  accepted: boolean;
  decidedBy: DecidedBy;
  /** For a setting's answer: the policy never asks, the dialog went unanswered, or no dialog exists in this mode. */
  because?: "policy" | "timeout" | "no-dialog";
}

/**
 * Settles `decision` under `policy`. Undefined only for `ask` without a dialog: nothing may be decided. `timeoutMs`
 * applies to the `ask-then-*` policies, whose fallback also becomes the dialog's initial choice.
 */
export async function settle(
  ui: DecisionUI | undefined,
  policy: DecisionPolicy,
  decision: Decision,
  timeoutMs: number,
): Promise<Settled | undefined> {
  if (policy === "approve" || policy === "decline") return { accepted: policy === "approve", decidedBy: "setting", because: "policy" };
  const fallback = policy === "ask-then-approve";
  if (!ui) return policy === "ask" ? undefined : { accepted: fallback, decidedBy: "setting", because: "no-dialog" };
  const initial = policy === "ask" ? decision.initial : fallback ? "accept" : "decline";
  const answer = await prompt(ui, { ...decision, initial }, policy === "ask" ? undefined : timeoutMs);
  return answer === "timeout" ? { accepted: fallback, decidedBy: "setting", because: "timeout" } : { accepted: answer, decidedBy: "user" };
}

/** One sentence for a tool result naming how a setting settled a decision; empty when the user answered. */
export function settledBySetting(setting: string, policy: DecisionPolicy, settled: Settled, timeoutMs: number): string {
  if (settled.decidedBy === "user") return "";
  const verdict = settled.accepted ? "approved" : "declined";
  if (settled.because === "timeout")
    return `The dialog went unanswered for ${Math.round(timeoutMs / 60_000)} minute(s), so the ${setting} setting (${policy}) ${verdict} it.`;
  if (settled.because === "no-dialog") return `No dialog is available in this mode, so the ${setting} setting (${policy}) ${verdict} it.`;
  return `The ${setting} setting (${policy}) ${verdict} it without asking.`;
}

/** One line for a summary: whitespace collapsed, cut with an ellipsis. */
export function oneLine(text: string, max = 96): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const section = (heading: string, body: string): string => `## ${heading}\n\n${body.trim()}`;

export const deleteDecision = (name: string, planId: string): Decision => ({
  question: `Delete Atlas plan ${oneLine(name, 60)}?`,
  summary: [`${planId} and all its evidence are removed permanently.`],
  accept: {
    label: "Delete plan and evidence",
    description: "Removes the bundle, ledger and evidence; cannot be undone",
  },
  decline: { label: "Keep the plan", description: "Nothing is removed" },
  initial: "decline",
});

/** `remaining` undefined: the ledger could not be read, so progress is unknown. */
export const exitEarlyDecision = (plan: string, remaining: number | undefined): Decision => ({
  question: "Exit Atlas early?",
  summary: [remaining === undefined ? `${plan} progress cannot be verified.` : `${plan} still has ${remaining} unfinished item(s).`],
  accept: {
    label: "Exit Atlas, keep progress",
    description:
      remaining === undefined
        ? "Leaves Atlas in this session; shared progress is kept"
        : "Leaves Atlas in this session; shared progress is kept and you can resume later",
  },
  decline: { label: "Keep Atlas running", description: "Atlas stays active in this session" },
  initial: "accept",
});

const RELEASE_EFFECT = "Release restores direct implementation tools and ends Atlas delegation in this session.";

export const releaseDecision = (reason: string): Decision => ({
  question: "Exit Atlas execution?",
  summary: ["Every row is complete and Atlas asks to stop delegating.", `Reason: ${oneLine(reason)}`],
  accept: {
    label: "Release the guard and exit Atlas",
    description: "Restores direct tools and ends delegation; evidence and progress are kept",
  },
  decline: { label: "Keep Atlas delegating", description: "The guard stays and Atlas keeps delegating" },
  details: [section("Reason given by Atlas", reason), section("What releasing does", RELEASE_EFFECT)].join("\n\n"),
  initial: "decline",
});

export interface AmendProposal {
  rowId: string;
  title: string;
  current: string;
  /** The ruling whose acceptance is in force, when it is not the approved plan's. */
  currentRuling?: string;
  acceptance: string;
  note: string;
}

/** The first proposed line the current acceptance lacks, list marker dropped, so the summary shows what changes. */
function firstChange(current: string, proposed: string): string | undefined {
  const before = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  return proposed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !before.has(line))
    ?.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
}

export const amendDecision = (proposal: AmendProposal): Decision => {
  const source = proposal.currentRuling ? `ruling ${proposal.currentRuling}` : "the approved plan";
  const change = firstChange(proposal.current, proposal.acceptance);
  return {
    question: `Amend the acceptance of ${proposal.rowId}?`,
    summary: [
      `${proposal.rowId}. ${oneLine(proposal.title)}`,
      change === undefined ? "Proposed change: drops part of the current acceptance" : `Proposed change: ${oneLine(change)}`,
    ],
    accept: {
      label: `Record owner ruling for ${proposal.rowId}`,
      description: "Judges the row against the proposed acceptance; the final report lists the ruling as a deviation",
    },
    decline: { label: "Keep current acceptance", description: `${proposal.rowId} stays judged against ${source}; nothing is recorded` },
    details: [
      `${proposal.rowId}. ${proposal.title}`,
      section(`Current acceptance (${source})`, proposal.current),
      section("Proposed acceptance", proposal.acceptance),
      section("Why", proposal.note),
      section(
        "What recording does",
        "Recording an owner ruling makes the row judged against the proposed acceptance, and the final report lists it as a deviation from the approved plan.",
      ),
    ].join("\n\n"),
    initial: "decline",
  };
};

export interface RetryProposal {
  rowId: string;
  /** The row's ledger summary and failure history. */
  history: string;
  acceptance: string;
  note: string;
}

export const retryDecision = (proposal: RetryProposal): Decision => ({
  question: `Open a new retry window for ${proposal.rowId}?`,
  summary: [`Reason: ${oneLine(proposal.note)}`, "Acceptance and scope stay unchanged."],
  accept: {
    label: `Open retry window for ${proposal.rowId}`,
    description: "More attempts only; acceptance unchanged, failures kept, no rollback",
  },
  decline: { label: `Keep ${proposal.rowId} blocked`, description: "No window is granted; nothing is recorded" },
  details: [
    section("Row and failure history", proposal.history),
    section("Unchanged acceptance", proposal.acceptance),
    section("Reason / changed hypothesis", proposal.note),
    section(
      "What a new window grants",
      "A new window grants more attempts, not scope or acceptance changes. Prior failures remain in history. Retain and inventory unverified changes; no rollback is authorized.",
    ),
  ].join("\n\n"),
  initial: "decline",
});
