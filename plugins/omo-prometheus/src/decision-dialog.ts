/**
 * Atlas decision dialogs. The host's `confirm` paints the whole message in the accent color under a Yes/No pair, so
 * long bodies become an unreadable wall. A decision is instead a `select`: the question plus a short summary, an
 * accept option and a decline option whose labels name what happens, and an optional "Review full details" option
 * that shows the complete text read-only and comes back to the same decision.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

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

/** True only for the accept option; Esc, a dismissed dialog and the decline all decline. */
export async function decide(ui: Pick<ExtensionContext["ui"], "select" | "editor">, decision: Decision): Promise<boolean> {
  const options = [decision.accept, decision.decline, ...(decision.details === undefined ? [] : [REVIEW_DETAILS])];
  const title = [decision.question, ...decision.summary].join("\n");
  const initialIndex = decision.initial === "accept" ? 0 : 1;
  while (true) {
    const choice = await ui.select(title, options, { initialIndex });
    if (choice !== REVIEW_DETAILS.label || decision.details === undefined) return choice === decision.accept.label;
    await ui.editor(`${decision.question} (read-only)`, decision.details);
  }
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
