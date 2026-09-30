import { beforeAll, expect, test } from "bun:test";

import { initTheme, type TUI, theme } from "@oh-my-pi/pi-tui";

import { AtlasLive } from "../plugins/omo-prometheus/src/atlas-live.ts";
import { AtlasPlanView } from "../plugins/omo-prometheus/src/atlas-menu.ts";
import type { AtlasPlanDetail } from "../plugins/omo-prometheus/src/atlas-store.ts";
import { ChildEvidence } from "../plugins/omo-prometheus/src/evidence.ts";
import { createLedger, startRow } from "../plugins/omo-prometheus/src/ledger.ts";

beforeAll(async () => {
  await initTheme();
});

const content = `# A plan

## Tasks
- [ ] T1. Produce result
  - Agent: deep-low
  - Depends on: none
  - Acceptance: output is verified

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

function setup() {
  const ledger = createLedger("/bundle/plan.md", content, ["deep-low", "task"]);
  const started = startRow(ledger, "T1");
  const attempt = started.attempt;
  if (!attempt) throw new Error("Missing started attempt");
  const detail: AtlasPlanDetail = {
    plan: {
      id: "test--00000000-0000-0000-0000-000000000001",
      name: "A plan",
      originalName: "A plan",
      cwd: "/workspace",
      directory: "/bundle",
      planFilePath: "/bundle/plan.md",
      ledgerPath: "/bundle/ledger.json",
      planSha256: ledger.planSha256,
      sourcePlanPath: "local://PLAN.md",
      sourceSessionId: "session-a",
      proposedByToolCallId: "proposal",
    },
    status: "In progress 0/5",
    done: 0,
    total: 5,
    rows: [
      {
        id: "T1",
        title: started.title,
        status: "in_progress",
        agent: "deep-low",
        acceptance: started.acceptance,
        dependsOn: [],
        attempt,
        startedAt: started.startedAt,
        updatedAt: started.updatedAt,
      },
      ...ledger.gates.map((gate) => ({
        id: gate.id,
        title: gate.title,
        status: gate.status,
        agent: gate.agent,
        acceptance: gate.acceptance,
        dependsOn: gate.dependsOn,
        updatedAt: gate.updatedAt,
      })),
    ],
    timeline: [],
    startedAt: started.startedAt,
    unfinished: true,
    enterable: false,
    started: true,
    inUse: true,
  };
  const evidence = new ChildEvidence();
  evidence.rememberDispatch(
    "call-a",
    "session-a",
    ledger,
    { agent: "deep-low", task: `Implement\natlas_assignment: ${JSON.stringify({ planSha256: ledger.planSha256, rows: { T1: attempt } })}` },
    "/tmp/atlas-artifacts",
  );
  let notification: (() => void) | undefined;
  let loads = 0;
  const live = new AtlasLive(detail, evidence, {
    sessionId: "session-a",
    subscribeLedger: (listener) => {
      notification = listener;
      return () => {
        notification = undefined;
      };
    },
    reload: async () => {
      loads++;
      return detail;
    },
    warn: (error) => {
      throw error;
    },
  });
  const progress = {
    index: 0,
    id: "child-one",
    agent: "deep-low",
    agentSource: "project" as const,
    status: "running" as const,
    task: "Implement",
    recentTools: [],
    recentOutput: ["Current output"],
    toolCount: 1,
    requests: 2,
    tokens: 140,
    cost: 0.001,
    durationMs: 3_000,
    lastIntent: "Checking files",
  };
  const frame = {
    index: 0,
    agent: "deep-low",
    agentSource: "project",
    task: "Implement",
    parentToolCallId: "call-a",
    sessionFile: "/tmp/atlas-artifacts/child-one.jsonl",
    progress,
  };
  return { live, detail, frame, attempt, notify: () => notification?.(), loads: () => loads, evidence };
}

test("only an exact owned dispatch and artifact contribute live progress; changed attempts invalidate it", () => {
  const { live, detail, frame, evidence } = setup();
  live.observeProgress({ ...frame, parentToolCallId: "unknown" });
  live.observeProgress({ ...frame, index: 1 });
  live.observeProgress({ ...frame, sessionFile: "/tmp/foreign/child-one.jsonl" });
  live.observeProgress({ ...frame, progress: { ...frame.progress, id: "another-child" } });
  live.updateDetail(detail);
  expect(live.snapshot.rows.size).toBe(0);
  live.observeProgress(frame);
  live.updateDetail(detail);
  expect(live.snapshot.runningChildren).toBe(1);
  expect(live.snapshot.rows.get("T1")?.progress?.tokens).toBe(140);
  const changed = { ...detail, rows: detail.rows.map((row) => (row.id === "T1" ? { ...row, attempt: "another-attempt" } : row)) };
  live.updateDetail(changed);
  expect(live.snapshot.rows.has("T1")).toBe(false);
  live.observeProgress(frame);
  live.updateDetail(changed);
  expect(live.snapshot.runningChildren).toBe(0);
  expect(live.snapshot.rows.size).toBe(0);
  evidence.discardUnstartedDispatch("session-a", "call-a");
  live.dispose();
});

test("terminal child lifecycle clears progress without claiming row completion", () => {
  const { live, detail, frame, evidence } = setup();
  live.observeProgress(frame);
  live.updateDetail(detail);
  const terminal = { id: "child-one", index: 0, parentToolCallId: "call-a", sessionFile: frame.sessionFile, status: "completed" };
  evidence.observe(terminal);
  live.observeLifecycle(terminal);
  live.updateDetail(detail);
  expect(live.snapshot.rows.get("T1")?.progress).toBeUndefined();
  expect(live.snapshot.runningChildren).toBe(0);
  expect(live.snapshot.detail.rows[0]?.status).toBe("in_progress");
  live.observeProgress(frame);
  live.updateDetail(detail);
  expect(live.snapshot.rows.get("T1")?.progress).toBeUndefined();
  live.dispose();
});

test("plan inspector retains the selected row id and body scroll on live refresh and switches to derived activity", () => {
  const { detail, live } = setup();
  const tui = { requestRender() {}, terminal: { rows: 30 } } as unknown as TUI;
  const view = new AtlasPlanView(
    detail,
    "active",
    theme,
    tui,
    async () => "",
    () => {},
    live,
  );
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[6~");
  const reordered = {
    ...detail,
    rows: [detail.rows[1], detail.rows[0], ...detail.rows.slice(2)].filter((row): row is NonNullable<typeof row> => row !== undefined),
    timeline: [{ version: 1 as const, at: Date.now(), kind: "done" as const, row: "T1", sessionId: "session-a", derived: true as const }],
  };
  live.updateDetail(reordered);
  view.updateDetail(reordered);
  const text = Bun.stripANSI(view.render(100).join("\n"));
  expect(text).toContain("F1  Plan compliance review");
  expect(text).not.toContain("T1  Produce result\n\n");
  view.handleInput("\t");
  expect(Bun.stripANSI(view.render(100).join("\n"))).toContain("[derived]");
  view.dispose();
  live.dispose();
});
