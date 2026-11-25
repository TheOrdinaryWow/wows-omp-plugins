import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { TspToolProps } from "@oh-my-pi/pi-wire";
import { z } from "zod";

import auditGoal from "../plugins/audit-goal/src/index.ts";
import type { AuditState } from "../plugins/audit-goal/src/ledger.ts";

const runtimeDir = mkdtempSync(join(tmpdir(), "audit-goal-cards-"));
const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
process.env.XDG_RUNTIME_DIR = runtimeDir;
const registrations: string[] = [];
let serial = 0;

afterEach(() => {
  setNativeRenderingForTest(false);
  for (const id of registrations.splice(0)) AgentRegistry.global().unregister(id);
});
afterAll(() => {
  if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
  rmSync(runtimeDir, { recursive: true, force: true });
});

type Result = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean };
type Tool = {
  label: string;
  parameters: { parse: (raw: unknown) => Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>, s: undefined, u: undefined, ctx: ExtensionContext) => Promise<Result>;
  renderCall: (args: unknown, options: unknown, theme: unknown) => UiNode | undefined;
  renderResult: (result: Result, options: unknown, theme: unknown, args?: unknown) => UiNode | undefined;
  mergeCallAndResult?: boolean;
};
type Renderer = (message: unknown, options: { expanded: boolean }, theme: unknown) => UiNode | undefined;

function seed(maxRounds: number | null = null): AuditState {
  return {
    version: 2,
    status: "active",
    goalId: "g1",
    target: "checkout restart path",
    intensity: "standard",
    maxRounds,
    laneLimit: 2,
    baseline: "abc123",
    rounds: [],
    capPending: false,
    conclusion: null,
    addedTools: [],
  };
}

async function harness(state: AuditState | undefined) {
  const id = `audit-cards-${++serial}`;
  const branch: Array<{ type: string; customType: string; data: unknown }> = state
    ? [{ type: "custom", customType: "wows-omp-audit-goal.state", data: structuredClone(state) }]
    : [];
  const sessionManager = { getSessionId: () => id, getBranch: () => branch };
  const goal = { id: "g1", objective: "Audit loop (/audit): checkout restart path", status: "active" };
  const session = {
    sessionManager,
    settings: {},
    getGoalModeState: () => ({ enabled: true, mode: "active", goal }),
  } as unknown as AgentSession;
  AgentRegistry.global().register({ id, displayName: id, kind: "main", session });
  registrations.push(id);
  let tool: Tool | undefined;
  const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const renderers = new Map<string, Renderer>();
  let active: string[] = [];
  const pi = {
    zod: z,
    on: (event: string, hook: (event: unknown, ctx: ExtensionContext) => unknown) => hooks.set(event, hook),
    registerTool: (registration: Tool) => {
      tool = registration;
    },
    registerCommand: () => {},
    registerMessageRenderer: (customType: string, renderer: Renderer) => renderers.set(customType, renderer),
    sendMessage: () => {},
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
    getActiveTools: () => active,
    setActiveTools: async (names: string[]) => {
      active = names;
    },
    logger: { warn: () => {} },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    sessionManager,
    hasUI: false,
    isIdle: () => true,
    ui: { setStatus: () => {}, notify: () => {}, select: async () => undefined },
  } as unknown as ExtensionContext;
  auditGoal(pi);
  if (!tool) throw new Error("audit_round not registered");
  const registered: Tool = tool;
  await hooks.get("session_start")?.({}, ctx);
  const call = (params: Record<string, unknown>) => registered.execute("c", registered.parameters.parse(params), undefined, undefined, ctx);
  return { tool: registered, call, renderers };
}

const round1 = {
  op: "record",
  round: 1,
  critical: 0,
  major: 1,
  minor: 0,
  picky: 0,
  rejected: 0,
  loopInduced: 0,
  auditorModels: ["auditor-A", "auditor-B"],
  coverage: "checkout chain",
  checks: "CI passed",
  findings: [
    {
      id: "r1-major",
      severity: "major",
      summary: "Order lost after restart",
      evidence: "checkout.ts:1",
      origin: "pre-existing",
      status: "open",
    },
  ],
};

const flat = (value: unknown): string => JSON.stringify(value);

/** A node as Tern receives it: `{ k, key?, p?, c? }`. */
type Tree = { k: string; key?: string; p?: Record<string, unknown>; c?: Tree[] };
const ternTree = (node: UiNode | undefined): Tree | undefined =>
  node ? (describeTree(node, staticEnvironment(PLAIN_THEME)) as Tree) : undefined;
const nodes = (tree: Tree | undefined): Tree[] => (tree ? [tree, ...(tree.c ?? []).flatMap(nodes)] : []);
const visible = (tree: Tree | undefined): string => flat((tree?.c ?? []).filter((child) => child.key !== "model-text"));
const receipt = (tree: Tree | undefined): Tree | undefined => nodes(tree).find((node) => node.key === "model-text");
/** The badge of Tern's first body row, which carries the facts the generic tool head lacks. */
const facts = (tree: Tree | undefined) => (tree?.c?.[0]?.key === "facts" ? tree.c[0].c?.[0]?.p : undefined);
const paint = (node: UiNode | undefined, width = 100): string =>
  node ? stripEscapes(renderBlock(node, width, { theme: PLAIN_THEME }).rows.join("\n")) : "";
const head = (node: UiNode | undefined) => (node?.props() ?? {}) as Partial<TspToolProps> & { tone?: string };

/** The card as the terminal draws it (`node`, an inline tool head over the body) and as Tern receives its body (`tree`). */
function card(tool: Tool, result: Result, expanded: boolean, args?: unknown): { node: UiNode | undefined; tree: Tree | undefined } {
  const options = { expanded, isPartial: false };
  setNativeRenderingForTest(true);
  const tree = ternTree(tool.renderResult(result, options, undefined, args));
  setNativeRenderingForTest(false);
  return { node: tool.renderResult(result, options, undefined, args), tree };
}

describe("audit_round card", () => {
  test("call head names the operation and tolerates partial streaming args", async () => {
    const { tool } = await harness(seed());
    expect(tool.mergeCallAndResult).toBe(true);
    expect(head(tool.renderCall({ op: "record", round: 3, i: "Recording" }, {}, undefined)).target).toBe("record round 3");
    expect(head(tool.renderCall({ op: "status" }, {}, undefined)).target).toBe("status");
    expect(head(tool.renderCall({ op: "conclude", conclusion: "threshold-convergence" }, {}, undefined)).target).toBe(
      "conclude threshold-convergence",
    );
    for (const partial of [{}, undefined, { op: "rec" }, { op: 4, round: "3" }]) {
      const call = tool.renderCall(partial, {}, undefined);
      expect(head(call).title).toBe("Audit Round");
      expect(paint(call)).toContain("Audit Round");
      expect(paint(call)).not.toContain("Recording");
    }
    setNativeRenderingForTest(true);
    expect(tool.renderCall({ op: "status" }, {}, undefined)).toBeUndefined();
  });

  test("recorded round shows counts collapsed and current round facts expanded, with a folded receipt", async () => {
    const { tool, call } = await harness(seed(3));
    const result = await call(round1);
    expect(result.isError).toBeUndefined();
    const view = card(tool, result, false, round1);
    const shown = flat(view.tree);
    expect(head(view.node).target).toBe("record round 1");
    expect(shown).toContain("1 of 3");
    expect(shown).toContain("auditor-A, auditor-B");
    expect(shown).toContain("major 1");
    expect(shown).not.toContain("Round 1 recorded.");
    expect(shown).not.toContain("Order lost after restart");
    expect(paint(view.node)).toContain("1 of 3");
    expect(paint(view.node)).not.toContain("Round 1 recorded.");
    const expanded = card(tool, result, true, round1);
    expect(visible(expanded.tree)).toContain("Order lost after restart");
    expect(visible(expanded.tree)).toContain("checkout chain");
    expect(visible(expanded.tree)).toContain("CI passed");
    expect(visible(expanded.tree)).not.toContain("Round 1 recorded.");
    expect(receipt(expanded.tree)?.p).toMatchObject({ collapsible: true, collapsed: true });
    expect(flat(receipt(expanded.tree))).toContain("Round 1 recorded.");
    // The terminal cannot unfold a section, so the expanded card shows the receipt open there.
    expect(paint(expanded.node)).toContain("Order lost after restart");
    expect(paint(expanded.node)).toContain("Round 1 recorded.");
    expect(head(view.node).tone).not.toBe("error");
    expect(head(view.node).status).toBe("done");
  });

  test("cap reached is a warning and conclusion is shown with success tone", async () => {
    const capped = await harness(seed(1));
    const capView = card(capped.tool, await capped.call(round1), false, round1);
    expect(head(capView.node).tone).toBe("warning");
    expect(flat(capView.tree)).toContain("round limit reached");
    // Tern's generic head has no outcome: the first body row carries it in its tone.
    expect(facts(capView.tree)).toMatchObject({ tone: "warning" });

    const clean = await harness(seed(null));
    const record = (n: number) => clean.call({ ...round1, round: n, major: 0, findings: [] });
    await record(1);
    await record(2);
    const args = {
      op: "conclude",
      conclusion: "threshold-convergence",
      reason: "two clean rounds",
      evidence: [
        { round: 1, observation: "clean" },
        { round: 2, observation: "clean" },
      ],
    };
    const concluded = await clean.call(args);
    expect(concluded.isError).toBeUndefined();
    const view = card(clean.tool, concluded, false, args);
    expect(head(view.node).tone).toBe("success");
    expect(facts(view.tree)).toEqual({ text: "threshold-convergence", tone: "success" });
    expect(flat(view.tree)).toContain("threshold-convergence");
    expect(flat(view.tree)).not.toContain("two clean rounds");
    const expanded = card(clean.tool, concluded, true, args).tree;
    expect(visible(expanded)).toContain("two clean rounds");
    expect(visible(expanded)).toContain("Round 2 observation");
    expect(visible(expanded)).not.toContain("call goal");
    expect(receipt(expanded)?.p).toMatchObject({ collapsible: true, collapsed: true });
  });

  test("status result and refusal", async () => {
    const { tool, call } = await harness(seed());
    const status = card(tool, await call({ op: "status" }), false, { op: "status" });
    expect(flat(status.tree)).toContain("0 of ");
    expect(facts(status.tree)).toBeUndefined();
    const refused = await call({ op: "extend" });
    expect(refused.isError).toBe(true);
    const view = card(tool, refused, false, { op: "extend" });
    expect(head(view.node)).toMatchObject({ tone: "error", status: "error", note: "refused" });
    expect(flat(view.tree)).toContain("op=extend is only valid");
    expect(facts(view.tree)).toEqual({ text: "refused", tone: "error" });
  });

  test("legacy results keep their receipt folded and old structured details still show counts", async () => {
    const { tool } = await harness(undefined);
    const result = { content: [{ type: "text", text: "Legacy operation completed.\nLegacy **receipt**" }], details: {} };
    const view = card(tool, result, false).tree;
    expect(flat(view)).toContain("Legacy operation completed.");
    expect(flat(view)).not.toContain("Legacy **receipt**");
    const expanded = card(tool, result, true).tree;
    expect(visible(expanded)).not.toContain("Legacy **receipt**");
    expect(flat(receipt(expanded))).toContain("Legacy **receipt**");
    const old = {
      ...result,
      details: {
        op: "record",
        intensity: "standard",
        rounds: 8,
        roundLimit: "unlimited",
        round: { round: 8, auditorModels: ["old-auditor"], critical: 0, major: 2, minor: 0, picky: 0 },
        open: { critical: 0, major: 4, minor: 1, picky: 0 },
        capPending: false,
        ended: false,
      },
    };
    for (const expanded of [false, true]) {
      const { tree: card_ } = card(tool, old, expanded);
      expect(visible(card_)).toContain("8 of unlimited");
      expect(visible(card_)).toContain("old-auditor");
      expect(visible(card_)).toContain("major 4");
      expect(visible(card_)).not.toContain("Legacy **receipt**");
    }
  });

  test("long audits show only the recorded round, current repairs and rejections outside model text", async () => {
    const { tool, call } = await harness(seed());
    for (let round = 1; round < 12; round++) {
      const result = await call({
        ...round1,
        round,
        coverage: `Historic coverage ${round}`,
        findings: [{ ...round1.findings[0], id: `historic-${round}`, summary: `Historic defect ${round}` }],
      });
      expect(result.isError).toBeUndefined();
    }
    const args = {
      ...round1,
      round: 12,
      rejected: 1,
      coverage: "Current checkout coverage",
      checks: "Current restart regression passed",
      findings: [{ ...round1.findings[0], id: "current-finding", summary: "Current checkout defect" }],
      resolutions: [{ findingId: "historic-1", evidence: "Current repair verified at checkout.ts:84" }],
      rejectedEvidence: ["Current rejected claim contradicted by restart regression"],
    };
    const result = await call(args);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Historic defect 11");
    for (const expanded of [false, true]) {
      const { tree: shown } = card(tool, result, expanded, args);
      expect(visible(shown)).toContain("12 of");
      expect(visible(shown)).not.toContain("Historic defect");
      expect(visible(shown)).not.toContain("Historic coverage");
      expect(visible(shown)).not.toContain("Start round 13");
      expect(visible(shown)).not.toContain("Remaining findings");
      if (expanded) {
        expect(visible(shown)).toContain("Current checkout defect");
        expect(visible(shown)).toContain("Current repair verified");
        expect(visible(shown)).toContain("Current rejected claim");
        expect(flat(receipt(shown))).toContain("Historic defect 11");
      } else expect(receipt(shown)).toBeUndefined();
    }
    const status = await call({ op: "status" });
    const { tree: statusCard } = card(tool, status, true, { op: "status" });
    expect(visible(statusCard)).toContain("major 11");
    expect(visible(statusCard)).not.toContain("Current checkout defect");
    expect(visible(statusCard)).not.toContain("Historic defect");
    expect(flat(receipt(statusCard))).toContain("Historic defect 11");
  });

  test("refusal keeps one reason visible and formats instructions only inside folded model text", async () => {
    const { tool } = await harness(undefined);
    const result = {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            "The round limit is exhausted. Report all old findings before continuing.",
            "Line one",
            "Line two",
            "State: cap-pending",
            "Next: request a decision",
            "| ID | Status |",
            "| --- | --- |",
            "| historic-1 | open |",
            'Then call goal({"op":"complete"}).',
          ].join("\n"),
        },
      ],
    };
    for (const expanded of [false, true]) {
      const view = card(tool, result, expanded, { op: "record", round: 12 });
      expect(head(view.node).tone).toBe("error");
      expect(visible(view.tree)).toContain("The round limit is exhausted.");
      expect(visible(view.tree)).not.toContain("Report all old findings");
      expect(visible(view.tree)).not.toContain("historic-1");
      expect(paint(view.node, 80)).toContain("The round limit is exhausted.");
      if (expanded) {
        const raw = receipt(view.tree);
        expect(raw?.p).toMatchObject({ collapsible: true, collapsed: true });
        const inside = nodes(raw).slice(1);
        expect(inside.find((node) => node.k === "table")?.p).toMatchObject({
          cols: [
            { head: "ID", priority: 2 },
            { head: "Status", priority: 1 },
          ],
          rows: [{ cells: { 0: "historic-1", 1: "open" } }],
        });
        expect(inside.find((node) => node.k === "code")?.p).toMatchObject({
          lang: "json",
          text: JSON.stringify({ op: "complete" }, null, 2),
        });
        expect(inside.some((node) => node.k === "kv")).toBe(true);
        expect(flat(inside)).toContain("Line one\\\\\\nLine two");
      }
    }
  });

  test("finite-cap stop shows this conclusion, not the recorded round's findings", async () => {
    const { tool, call } = await harness(seed(1));
    await call(round1);
    const result = await call({ op: "extend" });
    expect(result.isError).toBeUndefined();
    const collapsed = card(tool, result, false, { op: "extend" }).tree;
    expect(visible(collapsed)).toContain("stop");
    expect(visible(collapsed)).not.toContain("Order lost after restart");
    const expanded = card(tool, result, true, { op: "extend" }).tree;
    expect(visible(expanded)).toContain("Noninteractive finite round limit reached");
    expect(visible(expanded)).not.toContain("Order lost after restart");
    expect(flat(receipt(expanded))).toContain("Order lost after restart");
  });

  test("command notice is titled Audit goal in both terminals", async () => {
    const { renderers } = await harness(undefined);
    const render = renderers.get("wows-omp-audit-goal.command-status");
    expect(render).toBeDefined();
    const node = render?.(
      {
        role: "custom",
        customType: "wows-omp-audit-goal.command-status",
        content: "Audit ledger could not be saved",
        display: true,
        timestamp: 0,
      },
      { expanded: false },
      undefined,
    );
    const tree = ternTree(node);
    expect(tree?.k).toBe("card");
    expect(flat(tree?.p?.head)).toContain("Audit goal");
    expect(flat(tree)).toContain("Audit ledger could not be saved");
    expect(flat(tree)).not.toContain("wows-omp-audit-goal.command-status");
    const lines = paint(node, 80);
    expect(lines).toContain("Audit goal");
    expect(lines).toContain("Audit ledger could not be saved");
    expect(lines).not.toContain("wows-omp-audit-goal.command-status");
    expect(renderers.has("wows-omp-audit-goal.protocol")).toBe(false);
  });
});
