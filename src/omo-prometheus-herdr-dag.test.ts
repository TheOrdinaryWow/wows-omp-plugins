import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { AtlasLiveSnapshot, AtlasProgress } from "../plugins/omo-prometheus/src/atlas-live.ts";
import type { AtlasPlanDetail, AtlasRowDetail } from "../plugins/omo-prometheus/src/atlas-store.ts";
import { type AtlasSnapshot, contractRow, HerdrDagContract } from "../plugins/omo-prometheus/src/herdr-dag-contract.ts";
import { addFixRow, ledgerRows, planDigest, startRow } from "../plugins/omo-prometheus/src/ledger.ts";

const CHILD = "PROMETHEUS_DAG_SCENARIO";
const content = `# Contract test

## Tasks
- [ ] T1. Observe input
  - Agent: task
  - Depends on: none
  - Acceptance: input is observed
- [ ] T2. Consume input
  - Agent: task
  - Depends on: T1
  - Acceptance: input is consumed

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

/** Same isolated real-host registry/event-bus boundary as the execution suite. */
async function scenario(name: string, root: string): Promise<void> {
  // Static host imports would initialize HOME-scoped state in the parent rather than the isolated child.
  const { EventBus } = await import("@oh-my-pi/pi-coding-agent/utils/event-bus");
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { z } = await import("zod");
  const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
  const { default: register } = await import("../plugins/omo-prometheus/src/index.ts");
  const dir = join(root, "sessions");
  const artifacts = join(root, "artifacts");
  await mkdir(dir);
  await mkdir(artifacts);
  await mkdir(join(root, ".omp"));
  await writeFile(
    join(root, ".omp", "plugin-overrides.json"),
    JSON.stringify({ settings: { "wows-omp-plugin-omo-prometheus": { herdrDag: name !== "disabled", atlasWidget: false } } }),
  );
  const store = new AtlasStore(dir);
  const plan = await store.create({
    name: "Contract test",
    content,
    cwd: root,
    sourcePlanPath: "local://PLAN.md",
    sourceSessionId: "session-a",
    proposedByToolCallId: "proposal",
    availableAgents: ["task"],
  });
  let sessionId = "session-a";
  const entries: unknown[] = [];
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionDir: () => dir,
    getArtifactsDir: () => artifacts,
    getBranch: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  let reference = "local://PLAN.md";
  const live = {
    settings: Settings.isolated(),
    sessionManager,
    getPlanModeState: () => ({ enabled: false }),
    getPlanReferencePath: () => reference,
    setPlanReferencePath: (next: string) => {
      reference = next;
    },
    getTodoPhases: () => [],
    setTodoPhases() {},
    asyncJobManager: { getAllJobs: () => [] },
  } as unknown as AgentSession;
  AgentRegistry.resetGlobalForTests();
  AgentRegistry.global().register({ id: "Main", kind: "main", displayName: "Main", session: live });
  const bus = new EventBus();
  const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  for (const channel of ["atlas:hello", "atlas:snapshot", "atlas:released"]) {
    bus.on(channel, (payload) => events.push({ channel, payload: payload as Record<string, unknown> }));
  }
  type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
  const hooks = new Map<string, Hook>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const warnings: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: false,
    sessionManager,
    ui: {
      setWidget() {},
      notify(message: string) {
        warnings.push(message);
      },
    },
  } as unknown as ExtensionContext;
  register({
    events: bus,
    zod: z,
    on: (event: string, handler: Hook) => hooks.set(event, handler),
    registerTool() {},
    registerCommand: (command: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      commands.set(command, spec.handler),
    logger: {
      warn(message: string) {
        warnings.push(message);
      },
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [{ name: "task", description: "# Available Agents\n- `task`: worker", sourceInfo: { source: "builtin" } }],
    getActiveTools: () => ["task"],
    setActiveTools: async () => {},
    sendMessage() {},
  } as unknown as ExtensionAPI);
  const hook = async (type: string, event: Record<string, unknown> = {}) => {
    const handler = hooks.get(type);
    assert(handler);
    await handler({ type, ...event }, ctx);
  };
  const hello = (requestId: string, target = sessionId, v = 1) => bus.emit("herdr-dag:hello", { v, sessionId: target, requestId });
  const latest = () => events.filter((event) => event.channel === "atlas:snapshot").at(-1)?.payload as unknown as AtlasSnapshot;
  await hook("session_start");
  assert.equal(events.length, name === "disabled" ? 0 : 1);
  if (name !== "disabled") assert.equal(events[0]?.channel, "atlas:hello");
  hello("unbound");
  if (name !== "disabled") {
    assert.equal(events.at(-1)?.channel, "atlas:hello");
    assert.equal(events.at(-1)?.payload.requestId, "unbound");
    assert.equal(events.at(-1)?.payload.plan, undefined);
  } else assert.equal(events.length, 0);
  const count = events.length;
  hello("foreign", "session-other");
  hello("future", sessionId, 2);
  bus.emit("herdr-dag:hello", { v: 1, sessionId, requestId: 4 });
  assert.equal(events.length, count);
  await commands.get("atlas")?.(plan.id, ctx);
  if (name === "disabled") {
    await hook("session_shutdown");
    assert.equal(events.length, 0, warnings.join("\n"));
    return;
  }
  assert.deepEqual(
    events.slice(-2).map((event) => event.channel),
    ["atlas:hello", "atlas:snapshot"],
  );
  assert.equal(latest().plan.id, plan.id);
  assert.equal(latest().rows[1]?.dependsOn[0], "T1");
  assert.equal(latest().rows.find((row) => row.id === "F1")?.kind, "gate");
  assert.equal(latest().rows[0]?.kind, "task");
  hello("bound");
  assert.equal(events.at(-2)?.payload.requestId, "bound");
  const helloPlan = events.at(-2)?.payload.plan;
  assert(helloPlan && typeof helloPlan === "object" && "id" in helloPlan);
  assert.equal(helloPlan.id, plan.id);
  if (name === "switch") {
    sessionId = "session-b";
    entries.length = 0;
    await hook("session_switch", { reason: "new" });
  } else if (name === "shutdown") {
    await hook("session_shutdown");
  } else {
    await commands.get("atlas")?.("exit", ctx);
  }
  const released = events.find((event) => event.channel === "atlas:released");
  assert(released, warnings.join("\n"));
  assert.equal(released.payload.planId, plan.id);
  assert.equal(released.payload.reason, name === "switch" ? "session-switch" : name === "shutdown" ? "shutdown" : "exit");
  assert.equal(events.at(-1)?.channel, "atlas:hello");
  assert.equal(events.at(-1)?.payload.plan, undefined);
  const releasedCount = events.length;
  hello("after-release", "session-a");
  assert.equal(events.at(-1)?.payload.plan, undefined);
  assert.equal(events.length, name === "switch" || name === "shutdown" ? releasedCount : releasedCount + 1);
  if (name !== "shutdown") await hook("session_shutdown");
}

if (process.env[CHILD]) {
  await scenario(process.env[CHILD] as string, await realpath(process.env.PROMETHEUS_DAG_ROOT as string));
  console.log("PROMETHEUS_DAG_OK");
} else {
  const { describe, expect, test } = await import("bun:test");
  describe("Herdr DAG Atlas producer", () => {
    for (const name of ["exit", "switch", "shutdown", "disabled"]) {
      test(`registered extension: ${name}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "prometheus-dag-"));
        try {
          const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
            env: { ...process.env, [CHILD]: name, PROMETHEUS_DAG_ROOT: root, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect(code, stderr).toBe(0);
          expect(stdout).toContain("PROMETHEUS_DAG_OK");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 30_000);
    }

    test("live ledger notifications publish start, done, fixes and retained progress", async () => {
      // This deliberately exercises AtlasLive's real timer and async filesystem notification boundary.
      const { EventBus } = await import("@oh-my-pi/pi-coding-agent/utils/event-bus");
      const { AtlasStore } = await import("../plugins/omo-prometheus/src/atlas-store.ts");
      const { AtlasLive } = await import("../plugins/omo-prometheus/src/atlas-live.ts");
      const { ChildEvidence } = await import("../plugins/omo-prometheus/src/evidence.ts");
      const root = await realpath(await mkdtemp(join(tmpdir(), "atlas-contract-live-")));
      let live: InstanceType<typeof AtlasLive> | undefined;
      try {
        const store = new AtlasStore(root);
        const plan = await store.create({
          name: "Events",
          content,
          cwd: root,
          sourcePlanPath: "local://PLAN.md",
          sourceSessionId: "a",
          proposedByToolCallId: "p",
        });
        await store.acquire(plan.id, "a");
        const detail = async () => (await store.details(root))[0] as AtlasPlanDetail;
        const bus = new EventBus();
        const producer = new HerdrDagContract(bus);
        const snapshots: AtlasSnapshot[] = [];
        bus.on("atlas:snapshot", (payload) => snapshots.push(payload as AtlasSnapshot));
        producer.configure("a", true);
        producer.bind("a", plan);
        live = new AtlasLive(await detail(), new ChildEvidence(), {
          sessionId: "a",
          subscribeLedger: (listener) => store.subscribe(plan.id, listener),
          reload: detail,
          warn: (error) => {
            throw error;
          },
        });
        live.subscribe((snapshot) => producer.publish("a", snapshot));
        const nextSnapshot = (predicate: (snapshot: AtlasSnapshot) => boolean) =>
          new Promise<void>((resolve) => {
            const unsubscribe = bus.on("atlas:snapshot", (payload) => {
              if (predicate(payload as AtlasSnapshot)) {
                unsubscribe();
                resolve();
              }
            });
          });
        const startedEvent = nextSnapshot((snapshot) => snapshot.rows[0]?.status === "in_progress");
        await store.transaction(plan.id, "a", (ledger) => startRow(ledger, "T1"));
        await startedEvent;
        const started = snapshots.at(-1)?.rows[0];
        assert(started?.attempt);
        const progress = {
          currentTool: "read",
          tokens: 120,
          cost: 0.004,
          durationMs: 500,
          resolvedModel: "model",
          recentOutput: ["output"],
        } as AtlasProgress;
        producer.publish("a", {
          detail: await detail(),
          rows: new Map([["T1", { attempt: started.attempt, childAgentId: "Child", status: "running", progress }]]),
          at: 10,
          runningChildren: 1,
        });
        const output = "Acceptance verified";
        const file = join(root, "output.md");
        await writeFile(file, output);
        const doneEvent = nextSnapshot((snapshot) => snapshot.rows[0]?.status === "done");
        await store.transaction(plan.id, "a", async (ledger, bound) => {
          const row = ledgerRows(ledger)[0];
          assert(row?.attempt && row.startedAt !== undefined);
          const receipt = {
            receiptId: randomUUID(),
            ledgerId: ledger.ledgerId,
            planSha256: ledger.planSha256,
            rowId: "T1",
            attempt: row.attempt,
            childAgentId: "Child",
            parentAgentId: "Main",
            sessionId: "a",
            childCreatedAt: row.startedAt,
            outputSha256: planDigest(output),
            capturedAt: Date.now(),
            nativeFinal: true as const,
          };
          await store.saveReceipt(bound, receipt, file);
          row.status = "done";
          row.receipt = receipt;
          row.childAgentId = "Child";
        });
        await doneEvent;
        expect(snapshots.at(-1)?.live.T1?.progress?.tokens).toBe(120);
        expect(snapshots.at(-1)?.live.T1?.status).toBe("completed");
        const fixEvent = nextSnapshot((snapshot) => snapshot.rows.some((row) => row.kind === "fix"));
        await store.transaction(plan.id, "a", (ledger) =>
          addFixRow(ledger, "F1", { title: "Fix issue", agent: "task", acceptance: "verified", reason: "gate failure" }),
        );
        await fixEvent;
        expect(snapshots.at(-1)?.rows.find((row) => row.kind === "fix")?.origin).toBe("F1");
        expect(snapshots.at(-1)?.timeline.some((event) => event.kind === "fix_added")).toBe(true);
        await store.release(plan.id, "a");
      } finally {
        live?.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });

    test("snapshot allowlist, 50-event tail, new-attempt invalidation, and disabled silence", () => {
      const listeners = new Map<string, (payload: unknown) => void>();
      const emitted: Array<{ channel: string; payload: unknown }> = [];
      const producer = new HerdrDagContract({
        on: (channel, listener) => {
          listeners.set(channel, listener);
          return () => {};
        },
        emit: (channel, payload) => {
          emitted.push({ channel, payload });
        },
      });
      const detail = {
        plan: { id: "p", name: "P", planFilePath: "/plan.md", cwd: "/cwd", directory: "/secret" },
        rows: [
          {
            id: "T1",
            title: "T",
            status: "in_progress",
            agent: "worker",
            originalAgent: "role",
            dispatchAgent: "worker",
            attempt: "one",
            dependsOn: [],
            updatedAt: 1,
            acceptance: "private",
          },
        ],
        status: "Running",
        done: 0,
        total: 1,
        timeline: Array.from({ length: 60 }, (_, at) => ({ version: 1, at, kind: "started", sessionId: "a" })),
      } as unknown as AtlasPlanDetail;
      producer.configure("a", true);
      producer.bind("a", detail.plan);
      const publish = (rows: AtlasLiveSnapshot["rows"]) => producer.publish("a", { detail, rows, at: 1, runningChildren: 0 });
      publish(
        new Map([
          ["T1", { attempt: "one", childAgentId: "C", status: "running", progress: { tokens: 100, recentOutput: ["x"] } as AtlasProgress }],
        ]),
      );
      const snapshot = emitted.at(-1)?.payload as AtlasSnapshot;
      expect(snapshot.timeline).toHaveLength(50);
      expect(snapshot.timeline[0]?.at).toBe(10);
      expect(snapshot.rows[0]?.agent).toBe("role");
      expect(snapshot.rows[0]?.dispatchAgent).toBe("worker");
      expect(JSON.stringify(snapshot)).not.toContain("private");
      expect(JSON.stringify(snapshot)).not.toContain("/secret");
      const firstRow = detail.rows[0];
      assert(firstRow);
      firstRow.attempt = "two";
      publish(new Map());
      const updatedSnapshot = emitted.at(-1)?.payload as AtlasSnapshot;
      expect(updatedSnapshot.live).toEqual({});
      producer.configure("a", false);
      const count = emitted.length;
      listeners.get("herdr-dag:hello")?.({ v: 1, sessionId: "a", requestId: "off" });
      publish(new Map());
      producer.release("a", "exit");
      expect(emitted).toHaveLength(count);
    });

    test("rows carry their kind from the id prefix plus tier and verification state, never verifier summaries", () => {
      const base = { title: "Row", status: "open", agent: "task", updatedAt: 1, acceptance: "check" } as const;
      const rows: AtlasRowDetail[] = [
        { ...base, dependsOn: [], id: "T1", tier: "heavy", verification: { status: "running", summary: "private verdict" } },
        { ...base, dependsOn: [], id: "D1", origin: "T1", reason: "private reason", tier: "light" },
        { ...base, dependsOn: [], id: "X1", origin: "F2", tier: "light" },
        { ...base, dependsOn: [], id: "F2" },
        { ...base, dependsOn: [], id: "P1" },
      ];
      const mapped = rows.map(contractRow);
      expect(mapped.map(({ id, kind, origin, tier }) => ({ id, kind, origin, tier }))).toEqual([
        { id: "T1", kind: "task", origin: undefined, tier: "heavy" },
        { id: "D1", kind: "discovered", origin: "T1", tier: "light" },
        { id: "X1", kind: "fix", origin: "F2", tier: "light" },
        { id: "F2", kind: "gate", origin: undefined, tier: undefined },
        { id: "P1", kind: "delivery", origin: undefined, tier: undefined },
      ]);
      expect(mapped[0]?.verification).toEqual({ status: "running" });
      expect(JSON.stringify(mapped)).not.toContain("private");
    });
  });
}
