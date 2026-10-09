import { expect, test } from "bun:test";

import type { AdrRecord } from "../plugins/adr/src/documents.ts";
import { type AdrUiContext, createTuiUi, HeadlessUi, type MenuEntry } from "../plugins/adr/src/ui.ts";

function entry(id: string, status: AdrRecord["status"], extra: Partial<AdrRecord> = {}): MenuEntry {
  return {
    record: {
      id,
      title: `Decision ${id}`,
      status,
      date: "2026-10-01",
      supersedes: [],
      decision_makers: [],
      consulted: [],
      informed: [],
      path: `docs/adr/${id.slice(4)}-decision.md`,
      body: "## Context and Problem Statement\nWhy.\n",
      legacy: false,
      ...extra,
    },
    detail: `${id} detail`,
  };
}

/** Answers each select with the first option matching the next pattern; undefined answers act like Escape. */
function scripted(answers: Array<RegExp | undefined>) {
  const titles: string[] = [];
  const options: string[][] = [];
  const viewed: string[] = [];
  const ui = {
    async select(title: string, labels: string[]) {
      titles.push(title);
      options.push(labels);
      const answer = answers.shift();
      return answer ? labels.find((label) => answer.test(label)) : undefined;
    },
    async editor(_title: string, content: string) {
      viewed.push(content);
      return undefined;
    },
    async input() {
      return "typed";
    },
    notify() {},
  };
  return { ctx: { hasUI: true, ui } as unknown as AdrUiContext, titles, options, viewed };
}

const pi = { sendMessage() {} };
const entries = [
  entry("ADR-0001", "accepted"),
  entry("ADR-0002", "proposed"),
  entry("ADR-0003", "superseded", { superseded_by: "ADR-0004" }),
];

test("the menu filters by status, opens a detail view and returns the chosen decision", async () => {
  const run = scripted([/^Proposed \(1\)$/, /ADR-0002/, /^View the decision$/, /^Accept$/]);
  expect(await createTuiUi(run.ctx, pi).menu(entries)).toEqual({ action: "accept", id: "ADR-0002" });
  expect(run.titles[0]).toBe("ADRs: 1 proposed, 1 accepted, 1 superseded");
  expect(run.options[0]).toEqual([
    "All ADRs (3)",
    "Proposed (1)",
    "Accepted (1)",
    "Superseded (1)",
    "New decision…",
    "Run check",
    "Run check and regenerate the index",
  ]);
  expect(run.options[1]).toEqual(["○ ADR-0002 Decision ADR-0002 [proposed]", "← Back"]);
  expect(run.options[2]).toEqual(["View the decision", "Accept", "Reject", "Deprecate", "Append a dated note", "← Back"]);
  expect(run.viewed).toEqual(["ADR-0002 detail"]);
});

test("accepted ADRs offer supersede, superseded ones only notes, and Escape climbs back up", async () => {
  const accepted = scripted([/^All ADRs/, /ADR-0001/, /^Supersede/]);
  expect(await createTuiUi(accepted.ctx, pi).menu(entries)).toEqual({ action: "supersede", id: "ADR-0001" });
  expect(accepted.options[2]).toEqual([
    "View the decision",
    "Reject",
    "Deprecate",
    "Append a dated note",
    "Supersede with a new decision…",
    "← Back",
  ]);
  const superseded = scripted([/^All ADRs/, /ADR-0003/, undefined, /^← Back$/, /^Run check$/]);
  expect(await createTuiUi(superseded.ctx, pi).menu(entries)).toEqual({ action: "check" });
  expect(superseded.options[2]).toEqual(["View the decision", "Append a dated note", "← Back"]);
  expect(superseded.titles[2]).toBe("ADR-0003 Decision ADR-0003 [superseded] · 2026-10-01 · superseded by ADR-0004");
  expect(await createTuiUi(scripted([undefined]).ctx, pi).menu(entries)).toBeUndefined();
  expect(await createTuiUi(scripted([/^New decision/]).ctx, pi).menu([])).toEqual({ action: "new" });
});

test("without a UI there are no dialogs and notices become displayed messages", async () => {
  const sent: unknown[] = [];
  const ui = createTuiUi({ hasUI: false } as AdrUiContext, { sendMessage: (message: unknown) => sent.push(message) });
  expect(ui).toBeInstanceOf(HeadlessUi);
  expect(ui.interactive).toBe(false);
  expect(await ui.menu(entries)).toBeUndefined();
  expect(await ui.previewConfirm({ title: "x", files: [] })).toBeUndefined();
  ui.notify("Nothing to do", "warning");
  expect(sent).toEqual([{ customType: "wows-omp-adr.notice", content: "ADR warning: Nothing to do", display: true, attribution: "agent" }]);
});
