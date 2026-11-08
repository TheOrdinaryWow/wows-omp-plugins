import { beforeAll, expect, test } from "bun:test";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { initTheme, type NativeChild, type NativeNode } from "@oh-my-pi/pi-tui";
import type { NativeToolView, RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";
import { z } from "zod";

import { registerLoop } from "../plugins/omo-ultrawork/src/ulw-loop.ts";

interface CardTool {
  describeCall(args?: unknown): NativeToolView;
  describeResult(result: unknown, options: RenderResultOptions, args?: unknown): NativeToolView;
}
let tool: CardTool;
beforeAll(async () => {
  await initTheme();
  const known = {
    zod: z,
    registerTool(value: CardTool) {
      tool = value;
    },
  };
  const api = new Proxy(known, { get: (target, key) => (key in target ? target[key as keyof typeof known] : () => undefined) });
  registerLoop(api as unknown as ExtensionAPI, { mainSession: () => undefined, commandNotice() {} });
});

const options = (expanded = false): RenderResultOptions => ({ expanded, isPartial: false });
const shown = (value: unknown): string => JSON.stringify(value);
const nodes = (children?: readonly NativeChild[]): NativeNode[] =>
  (children ?? []).flatMap((child) =>
    child && typeof child === "object" && "k" in child ? [child as NativeNode, ...nodes((child as NativeNode).c)] : [],
  );
function receipt(op: string, result: unknown) {
  const details = { ok: true, op, result, nextActions: ["MODEL_ONLY_NEXT_ACTION"] };
  return { details, content: [{ type: "text", text: JSON.stringify(details) }] };
}
const criterion = {
  id: "C001",
  scenario: "Restart reads retained bytes",
  revision: 1,
  evidenceHistory: [{ criterionRevision: 1, goalAttempt: 1, status: "pass", evidence: "HISTORICAL_CAPTURE" }],
};
const goal = {
  id: "G001",
  title: "Retain CLI bytes",
  status: "in_progress",
  attempt: 1,
  criteria: [criterion, { ...criterion, id: "C002", scenario: "Missing file has a clear error", evidenceHistory: [] }],
};

test("loop call head identifies the operation and goal without requiring complete streamed arguments", () => {
  expect(tool.describeCall({ op: "criteria", goalId: "G001" }).tool?.target).toBe("criteria G001");
  for (const args of [undefined, null, {}, { op: "sta", goalId: 5 }, { op: [] }]) {
    expect(() => tool.describeCall(args)).not.toThrow();
  }
});

test("status focuses current goal, marks recorded pass versus pending, and folds formatted model text only when expanded", () => {
  const result = receipt("status", {
    state: { status: "active", activeGoalId: "G001", goals: [goal, { ...goal, id: "G002", title: "HISTORICAL_GOAL", status: "complete" }] },
    summary: { fresh: 1, stale: 1 },
  });
  const collapsed = tool.describeResult(result, options());
  expect(collapsed.tool?.target).toBe("status G001");
  expect(collapsed.tool?.badges).toContainEqual({ text: "in_progress", tone: "accent" });
  expect(shown(collapsed)).toContain("Retain CLI bytes");
  expect(shown(collapsed)).toContain("pass recorded");
  expect(shown(collapsed)).toContain("pending");
  expect(shown(collapsed)).toContain("1/2 goals complete");
  expect(shown(collapsed)).not.toContain("HISTORICAL_GOAL");
  expect(shown(collapsed)).not.toContain("MODEL_ONLY_NEXT_ACTION");
  expect(shown(collapsed)).not.toContain("HISTORICAL_CAPTURE");
  const expanded = tool.describeResult(result, options(true));
  const raw = nodes(expanded.body).find((node) => node.key === "model-text");
  expect(raw?.p).toMatchObject({ collapsed: true, collapsible: true });
  expect(nodes(raw?.c).find((node) => node.k === "code")?.p).toMatchObject({ text: JSON.stringify(result.details, null, 2), lang: "json" });
});

test("large status bounds criteria and goals even outside the expanded folded model text", () => {
  const criteria = Array.from({ length: 120 }, (_, index) => ({ ...criterion, id: `C${index}`, scenario: `Scenario ${index}` }));
  const goals = Array.from({ length: 80 }, (_, index) => ({ ...goal, id: `G${index}`, title: `Goal ${index}`, criteria }));
  const result = receipt("status", { state: { activeGoalId: "G0", goals } });
  for (const expanded of [false, true]) {
    const view = tool.describeResult(result, options(expanded));
    const body = view.body?.filter((child) => !(child && typeof child === "object" && "key" in child && child.key === "model-text"));
    expect(nodes(body).filter((node) => node.k === "item")).toHaveLength(7);
    expect(shown(body)).toContain("114 more criteria");
    expect(shown(body)).not.toContain("Scenario 6");
    expect(shown(body)).not.toContain("Goal 79");
    expect(shown(body).length).toBeLessThan(4000);
  }
});

test("criteria distinguishes fresh passing evidence, stale evidence and a different attempt", () => {
  const result = receipt("criteria", {
    goal,
    criteria: [
      { ...criterion, fresh: true },
      { ...criterion, id: "C002", fresh: false },
      { ...criterion, id: "C003", evidenceHistory: [{ criterionRevision: 1, goalAttempt: 0, status: "pass" }] },
    ],
  });
  const view = tool.describeResult(result, options(), { goalId: "G001" });
  const items = nodes(view.body).filter((node) => node.k === "item");
  expect(shown(items[1])).toContain('"pass"');
  expect(shown(items[2])).toContain('"stale"');
  expect(shown(items[3])).toContain('"pending"');
});

test("complete_goals describes acquisition rather than acceptance, including empty and already accepted states", () => {
  const acquired = tool.describeResult(receipt("complete_goals", { goal, noEligibleWork: false, aggregateComplete: false }), options());
  expect(acquired.tool?.target).toBe("complete_goals G001");
  expect(shown(acquired)).toContain("Acquired/resumed goal · not acceptance");
  const empty = tool.describeResult(receipt("complete_goals", { noEligibleWork: true, aggregateComplete: false }), options());
  expect(shown(empty)).toContain("No eligible work · loop not accepted");
  const complete = tool.describeResult(receipt("complete_goals", { noEligibleWork: true, aggregateComplete: true }), options());
  expect(shown(complete)).toContain("Loop already accepted");
});

test("checkpoint and evidence show only the change for this goal and criterion", () => {
  for (const aggregateComplete of [false, true]) {
    const view = tool.describeResult(receipt("checkpoint", { goalId: "G001", aggregateComplete }), options(), { status: "complete" });
    expect(view.tool?.target).toBe("checkpoint G001");
    expect(shown(view)).toContain(aggregateComplete ? "loop accepted" : "loop not yet accepted");
  }
  const view = tool.describeResult(
    receipt("record_evidence", {
      id: "capture-1",
      status: "pass",
      evidence: "CLI printed retained bytes",
      artifacts: [{ path: "qa.txt" }],
    }),
    options(),
    { goalId: "G001", criterionId: "C001" },
  );
  expect(view.tool?.target).toBe("record_evidence G001 C001");
  expect(shown(view)).toContain("1 artifacts");
  expect(shown(view)).toContain("CLI printed retained bytes");
  expect(shown(view)).not.toContain("MODEL_ONLY_NEXT_ACTION");
});

test("help is a short operation list with full references only in folded model text", () => {
  const operations = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`operation_${index}`, `Description ${index}`]));
  const result = receipt("help", { operations, references: { fullWorkflow: "LONG_MODEL_WORKFLOW" } });
  const collapsed = tool.describeResult(result, options());
  expect(nodes(collapsed.body).filter((node) => node.k === "item")).toHaveLength(6);
  expect(shown(collapsed)).toContain("13 operations");
  expect(shown(collapsed)).not.toContain("LONG_MODEL_WORKFLOW");
  const raw = nodes(tool.describeResult(result, options(true)).body).find((node) => node.key === "model-text");
  expect(raw?.p).toMatchObject({ collapsed: true });
  expect(shown(raw)).toContain("LONG_MODEL_WORKFLOW");
});

test("error is a bounded one-line reason, with full text folded on expansion", () => {
  const details = {
    ok: false,
    op: "checkpoint",
    error: { code: "ULW_LOOP_EVIDENCE_REQUIRED", message: `Missing current evidence\n${"details ".repeat(200)}` },
  };
  const result = { details, isError: true, content: [{ type: "text", text: JSON.stringify(details) }] };
  const view = tool.describeResult(result, options(), { goalId: "G001" });
  expect(view.tone).toBe("error");
  expect(view.tool?.target).toBe("checkpoint G001");
  const error = nodes(view.body).find((node) => node.k === "text");
  expect(shown(error)).toContain("Missing current evidence");
  expect(shown(error).length).toBeLessThan(350);
  expect(shown(view)).not.toContain("ULW_LOOP_EVIDENCE_REQUIRED");
  const raw = nodes(tool.describeResult(result, options(true)).body).find((node) => node.key === "model-text");
  expect(raw?.p).toMatchObject({ collapsed: true });
  expect(shown(raw)).toContain("ULW_LOOP_EVIDENCE_REQUIRED");
});

test("legacy and unknown details show a short fallback instead of raw JSON and never throw", () => {
  for (const details of [
    undefined,
    null,
    "old result",
    { goals: [goal] },
    { ok: true, op: "status", result: { state: { goals: [null, 5, {}] } } },
  ]) {
    const result = { details, content: [{ type: "text", text: '{"legacy":"MODEL_ONLY_LEGACY"}' }] };
    const view = tool.describeResult(result, options());
    expect(shown(view)).not.toContain("MODEL_ONLY_LEGACY");
    const raw = nodes(tool.describeResult(result, options(true)).body).find((node) => node.key === "model-text");
    expect(raw?.p).toMatchObject({ collapsed: true });
    expect(shown(raw)).toContain("MODEL_ONLY_LEGACY");
  }
});
