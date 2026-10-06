import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AtlasStore } from "../plugins/omo-prometheus/src/atlas-store.ts";
import { type AtlasCompleted, RoadmapContract } from "../plugins/omo-prometheus/src/roadmap-contract.ts";
import { discoverRepo } from "../plugins/roadmap/src/git.ts";
import { type InitInput, initProject } from "../plugins/roadmap/src/operations.ts";
import type { ToolReceipt } from "../plugins/roadmap/src/tools.ts";

const CHILD = "ROADMAP_PROMETHEUS_SDK";
const THIS_FILE = fileURLToPath(import.meta.url);
const ROADMAP_ENTRY = fileURLToPath(new URL("../plugins/roadmap/src/index.ts", import.meta.url));
const PROMETHEUS_ENTRY = fileURLToPath(new URL("../plugins/omo-prometheus/src/index.ts", import.meta.url));
const draft: InitInput = {
  project: { name: "Contract fixture", description: "A verified roadmap event fixture" },
  round: { title: "Launch", goal: "Verify the integration", constraints: [], non_goals: [], principles: [] },
  stages: [
    {
      title: "Checkout",
      objective: "Customers pay",
      scope_in: ["Payments"],
      scope_out: [],
      done_criteria: [{ id: "DC1", statement: "Checkout works", verify: "Exercise checkout" }],
    },
  ],
  adrs: [],
};
const planContent = `# Integration

## Tasks
- [ ] T1. Verify the stage
  - Agent: task
  - Depends on: none
  - Acceptance: the stage criterion passes

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

async function sdk(root: string, reverse: boolean): Promise<void> {
  // Host state and extension factories must initialize inside the HOME-isolated child.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  await initTheme();
  const git = discoverRepo(root);
  assert(git);
  const initialized = await initProject(
    { ...git, roadmapDir: join(root, "docs/roadmap"), adrDir: join(root, "docs/adr") },
    { sessionId: "fixture-main", kind: "main" },
    draft,
  );
  assert(initialized.ok, JSON.stringify(initialized));
  await mkdir(join(root, ".omp"));
  await writeFile(
    join(root, ".omp/plugin-overrides.json"),
    JSON.stringify({ settings: { "wows-omp-plugin-omo-prometheus": { herdrDag: false, atlasWidget: false } } }),
  );
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  const { session, extensionsResult, eventBus } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager,
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false }),
    toolNames: ["read", "write", "task"],
    additionalExtensionPaths: reverse ? [ROADMAP_ENTRY, PROMETHEUS_ENTRY] : [PROMETHEUS_ENTRY, ROADMAP_ENTRY],
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    cacheWarming: false,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  });
  try {
    await initializeExtensions(session, {
      reportSendError: (_action, error) => {
        throw error;
      },
      reportRuntimeError: (error) => {
        throw new Error(error.error);
      },
    });
    assert.deepEqual(extensionsResult.errors, []);
    assert.equal(extensionsResult.preparedExtensions?.length, 2);
    const runner = session.extensionRunner;
    assert(runner);
    extensionsResult.runtime.sendMessage = () => {};
    await runner.emit({ type: "session_start" });
    const sessionId = sessionManager.getSessionId();
    const consumer = new RoadmapContract(eventBus);
    const unbound = consumer.requestBinding(sessionId);
    assert(unbound);
    assert.equal(unbound.stage, undefined);
    assert.equal(unbound.repoRoot, root);
    assert.equal(unbound.toolSourcePath, ROADMAP_ENTRY);
    assert.equal(consumer.requestBinding("another-session"), undefined);
    const roadmapTool = session.getToolByName("roadmap_stage");
    assert(roadmapTool && session.getToolByName("atlas_ledger"));
    const started = await roadmapTool.execute("sdk-start", { action: "start", id: "S01" });
    const startReceipt = started.details as ToolReceipt;
    assert(startReceipt.ok, JSON.stringify(started));
    const binding = consumer.requestBinding(sessionId);
    assert.deepEqual(binding?.stage, { id: "S01", title: "Checkout", round: "R1" });
    const provenance = extensionsResult.runtime.getAllTools().find((tool) => tool.name === "roadmap_stage")?.sourceInfo;
    assert.equal(provenance?.source, "extension");
    assert.equal(provenance.path, binding?.toolSourcePath);
    const store = new AtlasStore(sessionManager.getSessionDir());
    const plan = await store.create({
      name: "Integration",
      content: planContent,
      cwd: root,
      sourcePlanPath: "local://integration-plan.md",
      sourceSessionId: sessionId,
      proposedByToolCallId: "sdk-proposal",
      roadmapStage: { repoRoot: root, id: "S01" },
    });
    const atlas = runner.getCommand("atlas");
    assert(atlas);
    await atlas.handler(plan.id, runner.createCommandContext());
    assert.equal(session.getPlanReferencePath(), `atlas://${plan.id}/plan.md`);
    const admitted = await runner.emitToolCall({
      type: "tool_call",
      toolName: "roadmap_stage",
      toolCallId: "sdk-roadmap-close",
      input: { action: "close", id: "S01" },
    });
    assert.notEqual(admitted?.block, true, JSON.stringify(admitted));
    const completion: AtlasCompleted = {
      v: 1,
      sessionId,
      planId: plan.id,
      roadmapStage: { repoRoot: root, id: "S01" },
      gates: ["F1", "F2", "F3", "F4"].map((gateId) => ({ gateId, verdict: "PASS", summary: `${gateId} verified the scoped acceptance` })),
      at: new Date().toISOString(),
    };
    eventBus.emit("atlas:completed", completion);
    const pending = () =>
      sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "wows-omp-roadmap.pending-close");
    assert.equal(pending().length, 1);
    const entry = pending()[0];
    assert(entry?.type === "custom");
    assert(entry.data && typeof entry.data === "object" && "at" in entry.data && typeof entry.data.at === "string");
    assert.deepEqual(entry.data, {
      v: 1,
      repoRoot: root,
      stage: "S01",
      planId: plan.id,
      gates: completion.gates,
      at: entry.data.at,
    });
    for (const event of [
      completion,
      { ...completion, sessionId: "another-session" },
      { ...completion, v: 2 },
      { ...completion, planId: "foreign", roadmapStage: { repoRoot: "/another-repository", id: "S01" } },
      { ...completion, planId: "malformed", gates: [{ gateId: "F1", verdict: "PASS", summary: null }] },
    ])
      eventBus.emit("atlas:completed", event);
    assert.equal(pending().length, 1);
    await runner.emit({ type: "session_start" });
    eventBus.emit("atlas:completed", completion);
    assert.equal(pending().length, 1);
    const injection = await runner.emitBeforeAgentStart("Continue", undefined, ["Host policy"]);
    const text = injection?.systemPrompt?.join("\n") ?? "";
    assert.match(text, /completed for S01.*roadmap_stage close/);
    assert.match(text, /Gate results are evidence candidates/);
    for (const gate of completion.gates.slice(0, 3)) assert(text.includes(gate.summary));
    const closed = await roadmapTool.execute("sdk-close", {
      action: "close",
      id: "S01",
      delivered: "Verified checkout fixture",
      deviations: "None",
      evidence: [{ criterion: "DC1", result: "pass", method: "SDK fixture", summary: "Observed the fixture criterion" }],
    });
    const closeReceipt = closed.details as ToolReceipt;
    assert(closeReceipt.ok, JSON.stringify(closed));
    assert.equal(consumer.requestBinding(sessionId)?.stage, undefined);
    const afterClose = await runner.emitBeforeAgentStart("Continue", undefined, ["Host policy"]);
    assert(!(afterClose?.systemPrompt?.join("\n") ?? "").includes("completed for S01"));
    await atlas.handler("exit", runner.createCommandContext());
    console.log(`ROADMAP_PROMETHEUS_OK ${reverse ? "reverse" : "sdk"}`);
  } finally {
    await session.dispose();
  }
}

if (process.env[CHILD]) {
  await sdk(process.env.ROADMAP_PROMETHEUS_ROOT as string, process.env[CHILD] === "reverse");
} else {
  // The plain Bun child exercises module loading; bun:test belongs only to its parent runner.
  const { expect, test } = await import("bun:test");
  for (const name of ["sdk", "reverse"]) {
    test(`real SDK roadmap/Prometheus contract: ${name}`, async () => {
      const home = await realpath(await mkdtemp(join(tmpdir(), "roadmap-prometheus-")));
      try {
        const root = join(home, "repo");
        await mkdir(root);
        const git = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
        const [gitOutput, gitError, gitCode] = await Promise.all([
          new Response(git.stdout).text(),
          new Response(git.stderr).text(),
          git.exited,
        ]);
        assert.equal(gitCode, 0, `${gitOutput}\n${gitError}`);
        const child = Bun.spawn([process.execPath, THIS_FILE], {
          cwd: root,
          env: { ...process.env, [CHILD]: name, ROADMAP_PROMETHEUS_ROOT: root, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        expect(stdout).toContain(`ROADMAP_PROMETHEUS_OK ${name}`);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }, 60_000);
  }
}
