import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { z } from "zod";

import auditGoal from "../plugins/audit-goal/src/index.ts";
import { type AuditState, createConclusion, type RoundRecord } from "../plugins/audit-goal/src/ledger.ts";

const ENTRY = "wows-omp-audit-goal.state";
const registrations: string[] = [];
const runtimeDir = mkdtempSync(join(tmpdir(), "audit-goal-runtime-"));
const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
process.env.XDG_RUNTIME_DIR = runtimeDir;
let serial = 0;

afterEach(() => {
  const registry = AgentRegistry.global();
  for (const id of registrations.splice(0)) registry.unregister(id);
});

afterAll(() => {
  if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
  rmSync(runtimeDir, { recursive: true, force: true });
});

function finding(round: number, severity: "critical" | "major") {
  return {
    id: `r${round}-${severity}`,
    severity,
    summary: "Checkout loses the order after restart",
    evidence: `checkout.ts:${round} restart scenario fails`,
    origin: "pre-existing" as const,
    status: "open" as const,
  };
}

function round(number: number, major = 0, coverage = `round ${number} checkout chain`): RoundRecord {
  return {
    round: number,
    critical: 0,
    major,
    minor: 0,
    picky: 0,
    rejected: 0,
    loopInduced: 0,
    auditorModels: ["auditor-A"],
    coverage,
    checks: `round ${number}: CI and restart smoke passed except documented finding`,
    findings: major ? [finding(number, "major")] : [],
    resolutions: [],
    rejectedEvidence: [],
  };
}

function initial(overrides: Partial<AuditState> = {}): AuditState {
  return {
    version: 2,
    status: "active",
    goalId: "g1",
    target: "checkout restart path",
    intensity: "standard",
    maxRounds: null,
    laneLimit: 2,
    baseline: "abc123",
    rounds: [],
    capPending: false,
    conclusion: null,
    addedTools: [],
    ...overrides,
  };
}

type ToolResult = { content: { text: string }[]; isError?: boolean };
type Hook = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type Tool = {
  parameters: { parse: (raw: unknown) => Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<ToolResult>;
};

function harness(seed: unknown, uiChoice?: string | null, select?: () => Promise<string | undefined>) {
  const id = `audit-outcomes-${++serial}`;
  const branch: Array<{ type: "custom"; customType: string; data: unknown }> = [
    { type: "custom", customType: ENTRY, data: structuredClone(seed) },
  ];
  let activeTools: string[] = [];
  const sessionManager = { getSessionId: () => id, getBranch: () => branch };
  const goal = { id: "g1", objective: "Audit loop (/audit): checkout restart path", status: "active" };
  const session = { sessionManager, getGoalModeState: () => ({ goal }) } as unknown as AgentSession;
  AgentRegistry.global().register({ id, displayName: id, kind: "main", session });
  registrations.push(id);
  const hooks = new Map<string, Hook>();
  let tool: Tool | undefined;
  let failNextPersist = false;
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const messages: Array<{ customType: string; content: string; display: boolean }> = [];
  const pi = {
    zod: z,
    on: (event: string, callback: Hook) => hooks.set(event, callback),
    registerTool: (registration: Tool) => {
      tool = registration;
    },
    registerCommand: (_name: string, options: { handler: typeof command }) => {
      command = options.handler;
    },
    sendMessage: (message: { customType: string; content: string; display: boolean }) => {
      messages.push(message);
    },
    appendEntry: (customType: string, data: unknown) => {
      if (failNextPersist) {
        failNextPersist = false;
        throw new Error("session entry unavailable");
      }
      branch.push({ type: "custom", customType, data: structuredClone(data) });
    },
    getActiveTools: () => activeTools,
    setActiveTools: async (names: string[]) => {
      activeTools = names;
    },
    logger: { warn: () => {} },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    sessionManager,
    hasUI: uiChoice !== null,
    isIdle: () => true,
    ui: {
      setStatus: () => {},
      notify: () => {},
      select: select ?? (async () => uiChoice),
    },
  } as unknown as ExtensionContext;
  auditGoal(pi);
  if (!tool) throw new Error("audit_round was not registered");
  const registeredTool: Tool = tool;
  const hook = (name: string, event: unknown) => {
    const handler = hooks.get(name);
    if (!handler) throw new Error(`Hook ${name} was not registered`);
    return handler(event, ctx);
  };
  const call = async (params: Record<string, unknown>) => {
    const validated = registeredTool.parameters.parse(params);
    return await registeredTool.execute(`call-${++serial}`, validated, undefined, undefined, ctx);
  };
  const latest = () => branch.at(-1)?.data as AuditState;
  return {
    branch,
    goal,
    call,
    hook,
    latest,
    messages,
    command: (args: string) => command?.(args, ctx),
    sidecar: async () =>
      JSON.parse(await readFile(join(runtimeDir, "wows-omp-plugins", "plugin-state", id, "audit-goal.json"), "utf8")) as Record<
        string,
        unknown
      >,
    sessionId: id,
    active: () => activeTools,
    failNextPersist: () => {
      failNextPersist = true;
    },
  };
}

describe("registered audit_round and goal hooks", () => {
  test("records threshold conclusion with open Major and blocks premature model completion", async () => {
    const runtime = harness(initial());
    await runtime.hook("session_start", {});
    expect(await runtime.hook("tool_call", { toolName: "goal", toolCallId: "early", input: { op: "complete" } })).toMatchObject({
      block: true,
    });
    const rounds = [round(1, 1), round(2), round(3)];
    for (const record of rounds) expect((await runtime.call({ op: "record", ...record })).isError).toBeUndefined();
    expect(await runtime.hook("tool_call", { toolName: "goal", toolCallId: "before-conclusion", input: { op: "complete" } })).toMatchObject(
      { block: true },
    );
    const result = await runtime.call({
      op: "conclude",
      conclusion: "threshold-convergence",
      reason: "Two consecutive checkout checks found no new blocking issues",
      evidence: [{ round: 3, observation: "Checkout and restart audits discovered no new blocking issues" }],
    });
    expect(result.isError).toBeUndefined();
    expect(runtime.latest().conclusion).toMatchObject({
      kind: "threshold-convergence",
      artifactAccepted: false,
      remaining: { counts: { major: 1 } },
    });
    expect((await runtime.call({ op: "status" })).content[0]?.text).toContain("OPEN r1-major [major]");
    expect(
      await runtime.hook("tool_call", { toolName: "goal", toolCallId: "after-conclusion", input: { op: "complete" } }),
    ).toBeUndefined();
    runtime.goal.status = "complete";
    await runtime.hook("goal_updated", { goal: runtime.goal });
    expect(runtime.latest()).toMatchObject({ status: "ended", conclusion: { kind: "threshold-convergence", artifactAccepted: false } });
    await runtime.hook("session_start", {});
    expect(runtime.latest().conclusion?.remaining.counts.major).toBe(1);
  });

  test("keeps saturation distinct from acceptance and closes only with multi-round evidence", async () => {
    const runtime = harness(initial());
    await runtime.hook("session_start", {});
    const rounds = [round(1, 1, "entry and DB"), round(2, 1, "restart and replay"), round(3, 1, "shutdown and recovery")];
    for (const record of rounds) await runtime.call({ op: "record", ...record });
    const early = await runtime.call({
      op: "conclude",
      conclusion: "capability-saturation",
      reason: "Discovery plateau",
      evidence: [{ round: 3, observation: "Repeated finding" }],
    });
    expect(early.isError).toBe(true);
    const outcome = await runtime.call({
      op: "conclude",
      conclusion: "capability-saturation",
      reason: "Comparable same-model audits across alternate paths exhausted credible new discovery axes, but three open repairs remain",
      evidence: rounds.map(({ round: number, coverage }) => ({
        round: number,
        observation: `Inspected ${coverage}; another same-model pass has lower value than repairs`,
      })),
    });
    expect(outcome.isError).toBeUndefined();
    expect(runtime.latest().conclusion).toMatchObject({
      kind: "capability-saturation",
      remaining: { counts: { major: 3 } },
      artifactAccepted: false,
    });
    expect(outcome.content[0]?.text).toContain("OPEN r3-major [major]");
    expect(
      await runtime.hook("tool_call", { toolName: "task", toolCallId: "late", input: { agent: "audit-fixer", task: "fix" } }),
    ).toMatchObject({ block: true });
    expect(await runtime.hook("tool_call", { toolName: "goal", toolCallId: "final", input: { op: "complete" } })).toBeUndefined();
  });

  test("finite cap, explicit user stop, and user drop are recorded as stops", async () => {
    const atCap = initial({ maxRounds: 1, rounds: [round(1, 1)], capPending: true });
    const runtime = harness(atCap, "Stop the audit");
    await runtime.hook("session_start", {});
    expect(await runtime.hook("tool_call", { toolName: "goal", toolCallId: "cap", input: { op: "complete" } })).toMatchObject({
      block: true,
    });
    const stopped = await runtime.call({ op: "extend" });
    expect(stopped.isError).toBeUndefined();
    expect(runtime.latest().conclusion).toMatchObject({
      kind: "stop",
      reason: "User explicitly stopped at the finite round limit.",
      remaining: { counts: { major: 1 } },
    });
    const other = harness(initial());
    await other.hook("session_start", {});
    other.goal.status = "dropped";
    await other.hook("goal_updated", { goal: other.goal });
    expect(other.latest().conclusion).toMatchObject({ kind: "stop", reason: "dropped by the user" });
    const headless = harness(atCap, null);
    await headless.hook("session_start", {});
    await headless.call({ op: "extend" });
    expect(headless.latest().conclusion?.reason).toContain("Noninteractive finite round limit");
    const canceled = harness(atCap);
    await canceled.hook("session_start", {});
    expect((await canceled.call({ op: "extend" })).isError).toBe(true);
    expect(canceled.latest().capPending).toBe(true);
    expect(canceled.latest().conclusion).toBeNull();
  });

  test("a delayed cap choice cannot resurrect an audit after user drop", async () => {
    const atCap = initial({ maxRounds: 1, rounds: [round(1, 1)], capPending: true });
    let choose: ((value: string) => void) | undefined;
    const decision = new Promise<string>((resolve) => {
      choose = resolve;
    });
    const runtime = harness(atCap, "Stop the audit", async () => decision);
    await runtime.hook("session_start", {});
    const pending = runtime.call({ op: "extend" });
    runtime.goal.status = "dropped";
    await runtime.hook("goal_updated", { goal: runtime.goal });
    if (!choose) throw new Error("The round-limit choice was not offered");
    choose("Stop the audit");
    expect((await pending).isError).toBe(true);
    expect(runtime.latest()).toMatchObject({ status: "ended", conclusion: { kind: "stop", reason: "dropped by the user" } });
  });

  test("resume reconciles a completed goal without losing the recorded threshold outcome", async () => {
    const rounds = [round(1, 1), round(2), round(3)];
    const open = initial({ rounds });
    const conclusion = createConclusion(open, "threshold-convergence", "Two clean discovery rounds after the initial Major", [
      { round: 3, observation: "Checkout and restart inspections found no new blocking issues" },
    ]);
    const runtime = harness({ ...open, conclusion });
    runtime.goal.status = "complete";
    await runtime.hook("session_start", {});
    expect(runtime.latest()).toMatchObject({
      status: "ended",
      conclusion: { kind: "threshold-convergence", artifactAccepted: false, remaining: { counts: { major: 1 } } },
    });
    expect(runtime.active()).toEqual([]);
  });

  test("a failed ledger append never authorizes completion from volatile round state", async () => {
    const runtime = harness(initial());
    await runtime.hook("session_start", {});
    runtime.failNextPersist();
    await expect(runtime.call({ op: "record", ...round(1, 1) })).rejects.toThrow("session entry unavailable");
    expect(runtime.latest().rounds).toEqual([]);
    expect((await runtime.call({ op: "status" })).isError).toBe(true);
    expect(await runtime.hook("tool_call", { toolName: "goal", toolCallId: "unsaved", input: { op: "complete" } })).toMatchObject({
      block: true,
    });
  });

  test("resume rejects malformed latest entry and reserved agent constraints remain intact", async () => {
    const runtime = harness(initial({ laneLimit: 1 }));
    await runtime.hook("session_start", {});
    expect(
      await runtime.hook("tool_call", {
        toolName: "task",
        toolCallId: "two",
        input: { tasks: [{ agent: "audit-auditor" }, { agent: "audit-fixer" }] },
      }),
    ).toMatchObject({ block: true });
    expect(await runtime.hook("before_subagent_spawn", { agent: "audit-auditor", invocationKind: "eval" })).toMatchObject({ block: true });
    runtime.branch.push({ type: "custom", customType: ENTRY, data: { ...initial(), rounds: [{ ...round(1, 1), major: 9 }] } });
    await runtime.hook("session_start", {});
    expect((await runtime.call({ op: "status" })).isError).toBe(true);
    expect(await runtime.hook("tool_call", { toolName: "goal", toolCallId: "corrupt", input: { op: "complete" } })).toMatchObject({
      block: true,
    });
    expect(await runtime.hook("tool_call", { toolName: "goal", toolCallId: "corrupt-drop", input: { op: "drop" } })).toMatchObject({
      block: true,
    });
    expect(await runtime.hook("tool_call", { toolName: "task", toolCallId: "reserved", input: { agent: "audit-fixer" } })).toMatchObject({
      block: true,
    });
  });

  test("every ledger save publishes the derived audit payload to the session sidecar", async () => {
    const runtime = harness(initial({ maxRounds: 1 }), null);
    await runtime.hook("session_start", {});
    await runtime.call({ op: "record", ...round(1, 1) });
    await runtime.hook("session_shutdown", {});
    const recorded = await runtime.sidecar();
    expect(recorded).toMatchObject({
      schema: "wows-omp-plugins/plugin-state",
      version: 1,
      plugin: "audit-goal",
      sessionId: runtime.sessionId,
      state: {
        kind: "audit-goal/audit",
        version: 1,
        status: "awaiting-limit-decision",
        ended: false,
        target: "checkout restart path",
        maxRounds: 1,
        rounds: [{ index: 1, counts: { critical: 0, major: 1, minor: 0, picky: 0 }, verdict: "cap-reached" }],
        openFindings: { counts: { major: 1 }, items: [{ id: "r1-major", severity: "major" }] },
        conclusion: null,
        stopReason: null,
        artifactAccepted: false,
      },
    });
    await runtime.hook("session_start", {});
    await runtime.call({ op: "extend" });
    await runtime.hook("session_shutdown", {});
    const stopped = await runtime.sidecar();
    expect(stopped.seq).toBeGreaterThan(recorded.seq as number);
    expect(stopped.state).toMatchObject({
      status: "stopped",
      stopReason: "Noninteractive finite round limit reached; the audit stopped without convergence.",
      openFindings: { counts: { major: 1 } },
    });
  });

  test("headless /audit usage errors are sent as visible messages", async () => {
    const runtime = harness(initial(), null);
    await runtime.command("   ");
    expect(runtime.messages).toEqual([expect.objectContaining({ content: "Usage: /audit <audit-target>", display: true })]);
  });
});
