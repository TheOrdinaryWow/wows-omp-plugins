import { describe, expect, test } from "bun:test";

import {
  amendDecision,
  DEFAULT_DECISION_SETTINGS,
  type Decision,
  decide,
  deleteDecision,
  exitEarlyDecision,
  parseDecisionSettings,
  REVIEW_DETAILS,
  releaseDecision,
  retryDecision,
  settle,
  withoutAutoApproval,
} from "../plugins/omo-prometheus/src/decision-dialog.ts";

type Call =
  | { kind: "select"; title: string; labels: string[]; initialIndex?: number; timeout?: number }
  | { kind: "editor"; title: string; text?: string };

/** The scripted answer for a dialog that runs out its timeout. */
const TIMEOUT = Symbol("timeout");

/** A scripted ui: each select answer picks a label (or undefined, as Esc does), or lets the dialog time out. */
function scripted(answers: Array<string | undefined | typeof TIMEOUT>) {
  const calls: Call[] = [];
  const ui = {
    select: async (
      title: string,
      options: Array<string | { label: string }>,
      dialog?: { initialIndex?: number; timeout?: number; onTimeout?: () => void },
    ) => {
      calls.push({
        kind: "select",
        title,
        labels: options.map((option) => (typeof option === "string" ? option : option.label)),
        initialIndex: dialog?.initialIndex,
        ...(dialog?.timeout === undefined ? {} : { timeout: dialog.timeout }),
      });
      const answer = answers.shift();
      if (answer !== TIMEOUT) return answer;
      dialog?.onTimeout?.();
      return undefined;
    },
    editor: async (title: string, text?: string) => {
      calls.push({ kind: "editor", title, text });
      return text;
    },
  };
  return { ui: ui as unknown as Parameters<typeof decide>[0], calls };
}

const amend = amendDecision({
  rowId: "T11",
  title: "Batch import",
  current: "- streams rows\n- p95 under 200 ms",
  acceptance: "- streams rows\n- p95 under 250 ms",
  note: "Three attempts measured 230–240 ms",
});

describe("Atlas decision dialogs", () => {
  test("Esc, a dismissed dialog and the decline all decline", async () => {
    for (const answer of [undefined, amend.decline.label]) {
      const { ui } = scripted([answer]);
      expect(await decide(ui, amend)).toBe(false);
    }
    const { ui } = scripted([amend.accept.label]);
    expect(await decide(ui, amend)).toBe(true);
  });

  test("the cursor starts on the safe answer; only a user-requested exit starts on accept", async () => {
    const cases: Array<[Decision, number]> = [
      [deleteDecision("CSV import", "csv--1"), 1],
      [releaseDecision("all rows done"), 1],
      [amend, 1],
      [retryDecision({ rowId: "T7", history: "T7 blocked", acceptance: "a", note: "new hypothesis" }), 1],
      [exitEarlyDecision("CSV import", 3), 0],
    ];
    for (const [decision, index] of cases) {
      const { ui, calls } = scripted([undefined]);
      await decide(ui, decision);
      expect(calls[0]).toMatchObject({ kind: "select", initialIndex: index });
    }
  });

  test("reviewing details shows the full text read-only and returns to the same decision", async () => {
    const { ui, calls } = scripted([REVIEW_DETAILS.label, amend.accept.label]);
    expect(await decide(ui, amend)).toBe(true);
    expect(calls.map((call) => call.kind)).toEqual(["select", "editor", "select"]);
    expect(calls[2]).toEqual(calls[0]);
    const editor = calls[1] as Extract<Call, { kind: "editor" }>;
    expect(editor.title).toBe("Amend the acceptance of T11? (read-only)");
    expect(editor.text).toContain("## Current acceptance (the approved plan)\n\n- streams rows\n- p95 under 200 ms");
    expect(editor.text).toContain("## Proposed acceptance\n\n- streams rows\n- p95 under 250 ms");
    expect(editor.text).toContain("## Why\n\nThree attempts measured 230–240 ms");
  });

  test("the summary stays short and shows what the amendment changes", async () => {
    const { ui, calls } = scripted([undefined]);
    await decide(ui, amend);
    expect(calls[0]).toMatchObject({
      title: "Amend the acceptance of T11?\nT11. Batch import\nProposed change: p95 under 250 ms",
      labels: ["Record owner ruling for T11", "Keep current acceptance", "Review full details"],
    });
  });

  test("short decisions offer no details option", async () => {
    const { ui, calls } = scripted([undefined]);
    await decide(ui, deleteDecision("CSV import", "csv--1"));
    expect(calls[0]).toMatchObject({ labels: ["Delete plan and evidence", "Keep the plan"] });
  });
});

describe("Atlas decision settings", () => {
  const minute = 60_000;

  test("approve and decline settle at once without a dialog", async () => {
    for (const policy of ["approve", "decline"] as const) {
      const { ui, calls } = scripted([]);
      expect(await settle(ui, policy, amend, minute)).toEqual({ accepted: policy === "approve", decidedBy: "setting", because: "policy" });
      expect(calls).toEqual([]);
    }
  });

  test("ask-then-* applies its fallback only when the dialog times out; an answer in time is the user's", async () => {
    for (const policy of ["ask-then-approve", "ask-then-decline"] as const) {
      const { ui, calls } = scripted([TIMEOUT]);
      expect(await settle(ui, policy, amend, 5 * minute)).toEqual({
        accepted: policy === "ask-then-approve",
        decidedBy: "setting",
        because: "timeout",
      });
      expect(calls[0]).toMatchObject({ kind: "select", timeout: 5 * minute });
    }
    // Esc within the timeout is the user declining, not a timeout that approves.
    expect(await settle(scripted([undefined]).ui, "ask-then-approve", amend, minute)).toEqual({ accepted: false, decidedBy: "user" });
    expect(await settle(scripted([amend.accept.label]).ui, "ask-then-decline", amend, minute)).toEqual({
      accepted: true,
      decidedBy: "user",
    });
    // Reviewing the details and timing out on the return trip still applies the fallback.
    const { ui, calls } = scripted([REVIEW_DETAILS.label, TIMEOUT]);
    expect(await settle(ui, "ask-then-decline", amend, minute)).toMatchObject({ accepted: false, because: "timeout" });
    expect(calls.map((call) => call.kind)).toEqual(["select", "editor", "select"]);
  });

  test("ask waits without a timeout and cannot settle without a dialog; ask-then-* falls back at once", async () => {
    const { ui, calls } = scripted([amend.accept.label]);
    expect(await settle(ui, "ask", amend, minute)).toEqual({ accepted: true, decidedBy: "user" });
    expect(calls[0]).not.toHaveProperty("timeout");
    expect(await settle(undefined, "ask", amend, minute)).toBeUndefined();
    expect(await settle(undefined, "ask-then-approve", amend, minute)).toEqual({
      accepted: true,
      decidedBy: "setting",
      because: "no-dialog",
    });
    expect(await settle(undefined, "ask-then-decline", amend, minute)).toEqual({
      accepted: false,
      decidedBy: "setting",
      because: "no-dialog",
    });
  });

  test("past the automatic limit an approving policy declines, and asking stays asking", () => {
    expect(withoutAutoApproval("approve")).toBe("decline");
    expect(withoutAutoApproval("ask-then-approve")).toBe("ask-then-decline");
    for (const policy of ["ask", "ask-then-decline", "decline"] as const) expect(withoutAutoApproval(policy)).toBe(policy);
  });

  test("settings default to asking, and an invalid value keeps its default with a warning", () => {
    expect(parseDecisionSettings({}, () => {})).toEqual(DEFAULT_DECISION_SETTINGS);
    const warnings: string[] = [];
    const parsed = parseDecisionSettings(
      { atlasRetry: "approve", atlasAmend: "sometimes", atlasRelease: "ask-then-approve", atlasAskTimeout: 0, atlasAutoRetryLimit: 0 },
      (message) => warnings.push(message),
    );
    expect(parsed).toEqual({ retry: "approve", amend: "ask", release: "ask-then-approve", timeoutMs: 30 * minute, autoRetryLimit: 0 });
    expect(warnings).toEqual(['invalid atlasAmend "sometimes"; using "ask"', "invalid atlasAskTimeout 0; using 30"]);
  });
});
