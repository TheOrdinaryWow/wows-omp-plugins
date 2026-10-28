import { describe, expect, test } from "bun:test";

import {
  amendDecision,
  type Decision,
  decide,
  deleteDecision,
  exitEarlyDecision,
  REVIEW_DETAILS,
  releaseDecision,
  retryDecision,
} from "../plugins/omo-prometheus/src/decision-dialog.ts";

type Call = { kind: "select"; title: string; labels: string[]; initialIndex?: number } | { kind: "editor"; title: string; text?: string };

/** A scripted ui: each select answer picks a label (or undefined, as Esc does). */
function scripted(answers: Array<string | undefined>) {
  const calls: Call[] = [];
  const ui = {
    select: async (title: string, options: Array<string | { label: string }>, dialog?: { initialIndex?: number }) => {
      calls.push({
        kind: "select",
        title,
        labels: options.map((option) => (typeof option === "string" ? option : option.label)),
        initialIndex: dialog?.initialIndex,
      });
      return answers.shift();
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
