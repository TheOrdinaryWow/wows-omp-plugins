import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { initTheme } from "@oh-my-pi/pi-tui";
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
  const session = { sessionManager, settings: {}, getGoalModeState: () => ({ goal }) } as unknown as AgentSession;
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

  test("recorded round shows round number, auditors, open findings and receipt", async () => {
    const { tool, call } = await harness(seed(3));
    const result = await call(round1);
    expect(result.isError).toBeUndefined();
    const view = tool.describeResult(result, { expanded: false }, round1);
    const shown = flat(view);
    expect(view.tool?.target).toBe("record round 1");
    expect(shown).toContain("1 of 3");
    expect(shown).toContain("auditor-A, auditor-B");
    expect(shown).toContain("major 1");
    expect(shown).toContain("Round 1 recorded.");
    expect(view.preview).toBeDefined();
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
    expect(flat(view)).toContain("two clean rounds");
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

  test("results without details fall back to markdown text", async () => {
    const { tool } = await harness(undefined);
    const view = tool.describeResult({ content: [{ type: "text", text: "Legacy **receipt**" }], details: {} }, { expanded: false });
    expect(flat(view)).toContain("Legacy **receipt**");
    expect(view.tone).toBeUndefined();
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
