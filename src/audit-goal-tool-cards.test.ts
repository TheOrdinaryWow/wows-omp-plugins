import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { initTheme, type NativeChild, type NativeNode } from "@oh-my-pi/pi-tui";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import { z } from "zod";

import auditGoal from "../plugins/audit-goal/src/index.ts";
import type { AuditState } from "../plugins/audit-goal/src/ledger.ts";

const runtimeDir = mkdtempSync(join(tmpdir(), "audit-goal-cards-"));
const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
process.env.XDG_RUNTIME_DIR = runtimeDir;
const registrations: string[] = [];
let serial = 0;

beforeAll(async () => {
  await initTheme();
});
afterEach(() => {
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
  describeCall: (args: unknown, options: unknown) => NativeToolView;
  describeResult: (result: Result, options: unknown, args?: unknown) => NativeToolView;
};
type Renderer = (message: unknown, options: { expanded: boolean }, theme: unknown) => unknown;

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

const nodes = (children: readonly NativeChild[] | undefined): NativeNode[] =>
  (children ?? []).flatMap((child) =>
    typeof child === "object" && child !== null && "k" in child ? [child as NativeNode, ...nodes((child as NativeNode).c)] : [],
  );
const visible = (view: NativeToolView): string =>
  flat(view.body?.filter((child) => !(typeof child === "object" && child !== null && "key" in child && child.key === "model-text")));
const receipt = (view: NativeToolView): NativeNode | undefined => nodes(view.body).find((node) => node.key === "model-text");
describe("audit_round Tern card", () => {
  test("call head names the operation and tolerates partial streaming args", async () => {
    const { tool } = await harness(seed());
    expect(tool.describeCall({ op: "record", round: 3, i: "Recording" }, {}).tool?.target).toBe("record round 3");
    expect(tool.describeCall({ op: "status" }, {}).tool?.target).toBe("status");
    expect(tool.describeCall({ op: "conclude", conclusion: "threshold-convergence" }, {}).tool?.target).toBe(
      "conclude threshold-convergence",
    );
    for (const partial of [{}, undefined, { op: "rec" }, { op: 4, round: "3" }]) {
      const view = tool.describeCall(partial, {});
      expect(view.tool?.title).toBe("Audit Round");
      expect(flat(view)).not.toContain("Recording");
    }
  });

  test("recorded round shows counts collapsed and current round facts expanded, with a folded receipt", async () => {
    const { tool, call } = await harness(seed(3));
    const result = await call(round1);
    expect(result.isError).toBeUndefined();
    const view = tool.describeResult(result, { expanded: false }, round1);
    const shown = flat(view);
    expect(view.tool?.target).toBe("record round 1");
    expect(shown).toContain("1 of 3");
    expect(shown).toContain("auditor-A, auditor-B");
    expect(shown).toContain("major 1");
    expect(shown).not.toContain("Round 1 recorded.");
    expect(shown).not.toContain("Order lost after restart");
    expect(view.preview).toBe("none");
    const expanded = tool.describeResult(result, { expanded: true }, round1);
    expect(visible(expanded)).toContain("Order lost after restart");
    expect(visible(expanded)).toContain("checkout chain");
    expect(visible(expanded)).toContain("CI passed");
    expect(visible(expanded)).not.toContain("Round 1 recorded.");
    expect(receipt(expanded)?.p).toMatchObject({ collapsible: true, collapsed: true });
    expect(flat(receipt(expanded))).toContain("Round 1 recorded.");
    expect(view.tone).not.toBe("error");
  });

  test("cap reached is a warning and conclusion is shown with success tone", async () => {
    const capped = await harness(seed(1));
    const capView = capped.tool.describeResult(await capped.call(round1), { expanded: false }, round1);
    expect(capView.tone).toBe("warning");
    expect(flat(capView)).toContain("round limit reached");

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
    const view = clean.tool.describeResult(concluded, { expanded: false }, args);
    expect(view.tone).toBe("success");
    expect(flat(view)).toContain("threshold-convergence");
    expect(flat(view)).not.toContain("two clean rounds");
    const expanded = clean.tool.describeResult(concluded, { expanded: true }, args);
    expect(visible(expanded)).toContain("two clean rounds");
    expect(visible(expanded)).toContain("Round 2 observation");
    expect(visible(expanded)).not.toContain("call goal");
    expect(receipt(expanded)?.p).toMatchObject({ collapsible: true, collapsed: true });
  });

  test("status result and refusal", async () => {
    const { tool, call } = await harness(seed());
    const status = tool.describeResult(await call({ op: "status" }), { expanded: false }, { op: "status" });
    expect(flat(status)).toContain("0 of ");
    const refused = await call({ op: "extend" });
    expect(refused.isError).toBe(true);
    const view = tool.describeResult(refused, { expanded: false }, { op: "extend" });
    expect(view.tone).toBe("error");
    expect(flat(view)).toContain("op=extend is only valid");
  });

  test("legacy results keep their receipt folded and old structured details still show counts", async () => {
    const { tool } = await harness(undefined);
    const result = { content: [{ type: "text", text: "Legacy operation completed.\nLegacy **receipt**" }], details: {} };
    const view = tool.describeResult(result, { expanded: false });
    expect(flat(view)).toContain("Legacy operation completed.");
    expect(flat(view)).not.toContain("Legacy **receipt**");
    const expanded = tool.describeResult(result, { expanded: true });
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
      const card = tool.describeResult(old, { expanded });
      expect(visible(card)).toContain("8 of unlimited");
      expect(visible(card)).toContain("old-auditor");
      expect(visible(card)).toContain("major 4");
      expect(visible(card)).not.toContain("Legacy **receipt**");
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
      const card = tool.describeResult(result, { expanded }, args);
      expect(visible(card)).toContain("12 of");
      expect(visible(card)).not.toContain("Historic defect");
      expect(visible(card)).not.toContain("Historic coverage");
      expect(visible(card)).not.toContain("Start round 13");
      expect(visible(card)).not.toContain("Remaining findings");
      if (expanded) {
        expect(visible(card)).toContain("Current checkout defect");
        expect(visible(card)).toContain("Current repair verified");
        expect(visible(card)).toContain("Current rejected claim");
        expect(flat(receipt(card))).toContain("Historic defect 11");
      } else expect(receipt(card)).toBeUndefined();
    }
    const status = await call({ op: "status" });
    const card = tool.describeResult(status, { expanded: true }, { op: "status" });
    expect(visible(card)).toContain("major 11");
    expect(visible(card)).not.toContain("Current checkout defect");
    expect(visible(card)).not.toContain("Historic defect");
    expect(flat(receipt(card))).toContain("Historic defect 11");
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
      const card = tool.describeResult(result, { expanded }, { op: "record", round: 12 });
      expect(card.tone).toBe("error");
      expect(card.preview).toBe("none");
      expect(visible(card)).toContain("The round limit is exhausted.");
      expect(visible(card)).not.toContain("Report all old findings");
      expect(visible(card)).not.toContain("historic-1");
      if (expanded) {
        const raw = receipt(card);
        expect(raw?.p).toMatchObject({ collapsible: true, collapsed: true });
        const inside = nodes(raw?.c);
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
    const collapsed = tool.describeResult(result, { expanded: false }, { op: "extend" });
    expect(visible(collapsed)).toContain("stop");
    expect(visible(collapsed)).not.toContain("Order lost after restart");
    const expanded = tool.describeResult(result, { expanded: true }, { op: "extend" });
    expect(visible(expanded)).toContain("Noninteractive finite round limit reached");
    expect(visible(expanded)).not.toContain("Order lost after restart");
    expect(flat(receipt(expanded))).toContain("Order lost after restart");
  });

  test("command notice is titled Audit goal in both terminals", async () => {
    const { renderers } = await harness(undefined);
    const render = renderers.get("wows-omp-audit-goal.command-status");
    expect(render).toBeDefined();
    const component = render?.(
      {
        role: "custom",
        customType: "wows-omp-audit-goal.command-status",
        content: "Audit ledger could not be saved",
        display: true,
        timestamp: 0,
      },
      { expanded: false },
      undefined,
    ) as { describe: () => unknown; render: (width: number) => string[] };
    const head = flat(component.describe());
    expect(head).toContain("Audit goal");
    expect(head).not.toContain("wows-omp-audit-goal.command-status");
    const lines = component.render(80).join("\n");
    expect(lines).toContain("Audit goal");
    expect(lines).toContain("Audit ledger could not be saved");
    expect(renderers.has("wows-omp-audit-goal.protocol")).toBe(false);
  });
});
