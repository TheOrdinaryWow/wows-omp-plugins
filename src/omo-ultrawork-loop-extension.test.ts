import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionRunner } from "@oh-my-pi/pi-coding-agent";

import type { EvidenceCapture, GoalSeed, LoopState } from "../plugins/omo-ultrawork/src/ulw-loop-state.ts";
import { LoopStore } from "../plugins/omo-ultrawork/src/ulw-loop-store.ts";

const CHILD_ENV = "ULW_LOOP_SDK_SCENARIO";
const THIS_FILE = fileURLToPath(import.meta.url);
const ENTRY = fileURLToPath(new URL("../plugins/omo-ultrawork/src/index.ts", import.meta.url));
const AUDIT_ENTRY = fileURLToPath(new URL("../plugins/audit-goal/src/index.ts", import.meta.url));
interface Envelope {
  ok: boolean;
  op: string;
  result?: unknown;
  error?: { code: string; message: string };
  warnings?: string[];
}
interface Harness {
  session: AgentSession;
  runner: ExtensionRunner;
  requests: string[];
  messages: string[];
  completions: unknown[];
}
async function sdkHarness(cwd: string, inMemory = false, audit = false): Promise<Harness> {
  // The executable child must set HOME/agent paths before these host loading boundaries initialize.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
  const { initTheme } = await import("@oh-my-pi/pi-tui");
  await initTheme();
  const { session, extensionsResult, eventBus } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "..", "agent"),
    sessionManager: inMemory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(cwd, "..", "sessions")),
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false, "edit.mode": "hashline" }),
    toolNames: ["read", "write", "bash", "goal"],
    additionalExtensionPaths: audit ? [ENTRY, AUDIT_ENTRY] : [ENTRY],
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
  await initializeExtensions(session, {
    reportSendError: (_action, error) => {
      throw error;
    },
    reportRuntimeError: (error) => {
      throw new Error(error.error);
    },
  });
  assert.deepEqual(extensionsResult.errors, []);
  const requests: string[] = [];
  const messages: string[] = [];
  const completions: unknown[] = [];
  // Exercise real command/tool dispatch without making a provider request.
  extensionsResult.runtime.sendUserMessage = (content) => {
    assert.equal(typeof content, "string");
    if (typeof content === "string") requests.push(content);
  };
  extensionsResult.runtime.sendMessage = (message) => {
    const text = typeof message === "string" ? message : message.content;
    if (typeof text === "string") messages.push(text);
  };
  eventBus.on("ulw-loop:completed", (payload) => completions.push(payload));
  const runner = session.extensionRunner;
  assert(runner);
  await runner.emit({ type: "session_start" });
  return { session, runner, requests, messages, completions };
}
async function command(h: Harness, args = "", name = "ulw-loop"): Promise<void> {
  const spec = h.runner.getCommand(name);
  assert(spec, `Missing real command ${name}`);
  await spec.handler(args, h.runner.createCommandContext());
}
async function call(h: Harness, input: object): Promise<Envelope> {
  const tool = h.session.getToolByName("ulw_loop");
  assert(tool, "Real loader must register ulw_loop");
  const output = await tool.execute(`loop-sdk-${crypto.randomUUID()}`, input);
  assert(output.details && typeof output.details === "object" && "ok" in output.details);
  const envelope = output.details as Envelope;
  assert.equal(Boolean(output.isError), !envelope.ok);
  return envelope;
}
async function good(h: Harness, input: object): Promise<Envelope> {
  const result = await call(h, input);
  assert(result.ok, JSON.stringify(result));
  return result;
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, stderr);
  return stdout.trim();
}
async function runProduct(cwd: string): Promise<void> {
  const product = Bun.spawn([process.execPath, join(cwd, "app.mjs")], { cwd, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(product.stdout).text();
  assert.equal(await product.exited, 0);
  assert.equal(output, "persisted-product-bytes\n");
  await writeFile(join(cwd, "qa-output.txt"), output);
}
async function recordCapture(h: Harness, goalId: string): Promise<EvidenceCapture> {
  const envelope = await good(h, {
    op: "record_evidence",
    goalId,
    criterionId: "C001",
    status: "pass",
    evidence: "A fresh CLI process printed persisted-product-bytes",
    artifacts: ["qa-output.txt"],
  });
  const value = envelope.result;
  assert(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      "binding" in value &&
      "artifacts" in value &&
      Array.isArray(value.artifacts),
  );
  // The SDK erased this in-process extension result type; the discriminator and receipt fields are checked above.
  return value as EvidenceCapture;
}
const seed: GoalSeed = {
  title: "CLI restart",
  objective: "A process can read retained product bytes",
  shape: "delivery",
  tier: "LIGHT",
  criteria: [
    { scenario: "Run the delivered CLI after restart", expectedEvidence: "The CLI prints retained bytes, captured from a real process" },
  ],
};
async function createGoals(h: Harness, cwd: string, goals: GoalSeed[] = [seed], validationBatches?: unknown[]): Promise<void> {
  await writeFile(join(cwd, "brief.md"), "# Retained bytes\nDeliver a CLI that reads the persisted fixture after restart.\n");
  await good(h, {
    op: "create_goals",
    briefPath: "brief.md",
    objective: "Retain CLI bytes across restart",
    goals,
    ...(validationBatches ? { validationBatches } : {}),
  });
}
function store(h: Harness, cwd: string): LoopStore {
  return new LoopStore(h.session.sessionManager.getSessionDir(), h.session.sessionManager.getSessionId(), cwd);
}
async function qualityGate(
  _h: Harness,
  cwd: string,
  captures: { goalId: string; capture: EvidenceCapture }[],
  reviewer = "sdk-reviewer",
  filename = "quality-gate.json",
): Promise<string> {
  await writeFile(join(cwd, "qa.txt"), "Executed the delivered CLI in a fresh process; observed persisted-product-bytes.\n");
  await writeFile(
    join(cwd, "review.txt"),
    "Independent criterion and goal review: PASS. Every declared criterion is covered; no blockers.\n",
  );
  const value = {
    version: 1,
    treeHash: await git(cwd, "rev-parse", "--verify", "HEAD^{tree}"),
    criteriaCoverage: captures.map(({ goalId, capture }) => ({ goalId, criterionId: "C001", captureId: capture.id })),
    qa: {
      reportPath: "qa.txt",
      entries: captures.map(({ goalId }) => ({
        goalId,
        criterionId: "C001",
        kind: "real-surface",
        artifactPath: "qa-output.txt",
        observation: "A fresh CLI process printed persisted-product-bytes",
      })),
    },
    review: { agentId: reviewer, reportPath: "review.txt", verdict: "PASS", blockers: [] },
  };
  const file = join(cwd, filename);
  await writeFile(file, JSON.stringify(value));
  return file;
}
async function registerReviewChild(h: Harness, cwd: string): Promise<AgentSession> {
  // A real SDK child proves the registry/main-parent boundary; no fabricated main-agent identity is admitted.
  const { createAgentSession, SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
  const parent = AgentRegistry.global()
    .list()
    .find((ref) => ref.session === h.session);
  assert(parent);
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "..", "agent"),
    sessionManager: SessionManager.inMemory(cwd),
    settings: Settings.isolated({ "tools.approvalMode": "yolo", "autolearn.enabled": false }),
    toolNames: ["read", "write"],
    additionalExtensionPaths: [],
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
    taskDepth: 1,
    agentId: "sdk-reviewer",
    parentAgentId: parent.id,
    parentTaskPrefix: "sdk-reviewer",
  });
  const read = session.getToolByName("read");
  assert(read);
  const actual = await read.execute("review-proof", { path: join(cwd, "qa-output.txt") });
  assert(actual.content.some((block) => block.type === "text" && block.text.includes("persisted-product-bytes")));
  return session;
}
async function scenario(name: string, root: string): Promise<void> {
  const cwd = join(root, "project");
  await mkdir(cwd);
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.name", "Fixture");
  await git(cwd, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(cwd, "app.mjs"), "console.log('persisted-product-bytes');\n");
  await git(cwd, "add", "app.mjs");
  await git(cwd, "commit", "-qm", "fixture");
  const h = await sdkHarness(cwd, name === "in-memory", name === "ownership" || name === "corrupt");
  let reviewer: AgentSession | undefined;
  try {
    if (name === "in-memory") {
      assert.equal(h.session.sessionManager.getSessionDir(), "");
      await command(h, "Retain bytes");
      assert(
        h.messages.some((message) => message.includes("ULW_LOOP_PERSISTENCE_REQUIRED")),
        h.messages.join("\n"),
      );
      assert.equal(h.session.getGoalModeState()?.goal, undefined);
      assert.equal(await Bun.file(join(cwd, "ulw-loop", "state.json")).exists(), false);
      await command(h, "Compare static source versions", "ulw-research");
      assert(h.requests.at(-1)?.includes("ephemeral no-session snapshot (not durable)"));
      return;
    }
    if (name === "ownership") {
      h.session.setPlanModeState({ enabled: true, planFilePath: join(cwd, "plan.md") });
      await command(h, "Retain bytes");
      assert(h.messages.at(-1)?.includes("ULW_LOOP_PLAN_MODE"));
      assert.equal(await store(h, cwd).load(), undefined);
      h.session.setPlanModeState(undefined);
      await command(h, "Audit the CLI", "audit");
      const auditId = h.session.getGoalModeState()?.goal.id;
      assert(auditId);
      await command(h, "Retain bytes");
      assert(h.messages.at(-1)?.includes("ULW_LOOP_FOREIGN_GOAL"));
      assert.equal(h.session.getGoalModeState()?.goal.id, auditId);
      assert.equal(await store(h, cwd).load(), undefined);
      await h.session.goalRuntime.dropGoal();
      await command(h, "Retain bytes");
      const ownId = h.session.getGoalModeState()?.goal.id;
      assert(ownId && ownId !== auditId);
      await command(h, "Audit the CLI", "audit");
      assert.equal(h.session.getGoalModeState()?.goal.id, ownId, "audit cannot acquire the loop's native driver");
      await h.session.goalRuntime.pauseGoal();
      assert.equal((await store(h, cwd).load())?.status, "paused");
      await command(h, "resume");
      assert.equal(h.session.getGoalModeState()?.goal.status, "active");
      h.session.setPlanModeState({ enabled: true, planFilePath: join(cwd, "plan.md") });
      await h.runner.emitBeforeAgentStart("Continue", undefined, ["Host policy"]);
      assert.equal(h.session.getGoalModeState()?.goal.status, "paused");
      assert.equal((await store(h, cwd).load())?.status, "paused");
      await command(h, "resume");
      assert(h.messages.at(-1)?.includes("ULW_LOOP_PLAN_MODE"));
      h.session.setPlanModeState(undefined);
      await command(h, "resume");
      const budget = h.session.getGoalModeState();
      assert(budget);
      const limited = { ...budget, enabled: false, goal: { ...budget.goal, status: "budget-limited" as const } };
      h.session.setGoalModeState(limited);
      await h.runner.emit({ type: "goal_updated", goal: limited.goal, state: limited });
      assert.equal((await store(h, cwd).load())?.status, "paused");
      assert.equal(h.session.getGoalModeState()?.goal.status, "budget-limited", "loop must not auto-resume a native budget limit");
      await command(h, "resume");
      await h.session.goalRuntime.completeGoalFromTool();
      assert.equal((await store(h, cwd).load())?.status, "paused");
      const modelResume = await call(h, { op: "resume" });
      assert.equal(modelResume.error?.code, "ULW_LOOP_USER_RESUME_REQUIRED");
      await command(h, "resume");
      assert.notEqual(h.session.getGoalModeState()?.goal.id, ownId);
      await command(h, "stop");
      assert.equal((await store(h, cwd).load())?.status, "stopped");
      assert.equal(h.session.getGoalModeState()?.goal, undefined);
      await command(h, "Audit the CLI", "audit");
      const foreignId = h.session.getGoalModeState()?.goal.id;
      assert(foreignId);
      await command(h, "resume");
      assert(h.messages.at(-1)?.includes("ULW_LOOP_FOREIGN_GOAL"));
      assert.equal(h.session.getGoalModeState()?.goal.id, foreignId);
      return;
    }
    await command(h, "Retain bytes across CLI restart");
    assert(h.requests[0]?.includes("<ulw-loop-request>"), h.messages.join("\n"));
    const nativeId = h.session.getGoalModeState()?.goal.id;
    assert(nativeId);
    if (name === "corrupt") {
      const file = store(h, cwd).file;
      const original = await readFile(file, "utf8");
      await writeFile(file, "{corrupt");
      await h.runner.emit({ type: "session_start" });
      assert.equal(h.session.getGoalModeState()?.goal.id, nativeId);
      assert.equal(
        h.session.getGoalModeState()?.goal.status,
        "paused",
        "saved exact binding pauses the owned native driver despite corrupt criteria state",
      );
      assert.equal(await readFile(file, "utf8"), "{corrupt");
      await h.session.goalRuntime.dropGoal();
      await command(h, "Audit an unrelated objective", "audit");
      const foreign = h.session.getGoalModeState()?.goal.id;
      assert(foreign && foreign !== nativeId);
      await h.runner.emit({ type: "session_start" });
      assert.equal(h.session.getGoalModeState()?.goal.id, foreign);
      assert.equal(h.session.getGoalModeState()?.goal.status, "active", "corrupt loop recovery must not pause a foreign audit driver");
      await h.session.goalRuntime.dropGoal();
      await writeFile(file, original);
      await command(h, "resume");
      await rm(file);
      await h.runner.emit({ type: "session_start" });
      assert.equal(h.session.getGoalModeState()?.goal.status, "paused", "missing initialized state also pauses only its bound driver");
      return;
    }
    if (name === "batches" || name === "review-blockers") {
      await runProduct(cwd);
      await createGoals(
        h,
        cwd,
        name === "batches" ? [seed, { ...seed, title: "Batch review" }, { ...seed, title: "Delivery closer" }] : [seed],
        name === "batches" ? [{ id: "B1", goalIds: ["G001", "G002"], finalGoalId: "G002" }] : undefined,
      );
      await good(h, { op: "complete_goals" });
      const first = await recordCapture(h, "G001");
      if (name === "review-blockers") {
        await good(h, {
          op: "record_review_blockers",
          goalId: "G001",
          title: "Repair restart observation",
          objective: "Resolve independent review blocker",
          evidence: "Review found the restart path needed one more observed run",
          artifacts: ["qa-output.txt"],
        });
        assert.equal((await store(h, cwd).load())?.goals[0]?.status, "blocked");
      } else await good(h, { op: "checkpoint", goalId: "G001", status: "complete", evidence: "Essential restart proof observed" });
      await good(h, { op: "complete_goals" });
      const second = await recordCapture(h, "G002");
      reviewer = await registerReviewChild(h, cwd);
      let finalId: string;
      let captures: { goalId: string; capture: EvidenceCapture }[];
      if (name === "batches") {
        assert.equal(
          (await call(h, { op: "checkpoint", goalId: "G002", status: "complete", evidence: "Batch QA observed" })).error?.code,
          "ULW_LOOP_QUALITY_GATE_REQUIRED",
        );
        const batchGate = await qualityGate(
          h,
          cwd,
          [
            { goalId: "G001", capture: first },
            { goalId: "G002", capture: second },
          ],
          "sdk-reviewer",
          "batch-gate.json",
        );
        await good(h, {
          op: "checkpoint",
          goalId: "G002",
          status: "complete",
          evidence: "Batch criterion review passed",
          qualityGatePath: batchGate,
        });
        await good(h, { op: "complete_goals" });
        const third = await recordCapture(h, "G003");
        finalId = "G003";
        captures = [
          { goalId: "G001", capture: first },
          { goalId: "G002", capture: second },
          { goalId: "G003", capture: third },
        ];
        const template = await good(h, { op: "checkpoint", printTemplate: true, goalId: finalId });
        assert(
          template.result &&
            typeof template.result === "object" &&
            "criteriaCoverage" in template.result &&
            Array.isArray(template.result.criteriaCoverage),
        );
        assert.equal(template.result.criteriaCoverage.length, 3, "final template covers earlier goals as well as the closer");
      } else {
        await good(h, { op: "checkpoint", goalId: "G002", status: "complete", evidence: "Fresh repair QA passed" });
        assert.equal(
          (await store(h, cwd).load())?.goals[0]?.status,
          "pending",
          "repair completion reopens, rather than accepts, the blocked target",
        );
        await good(h, { op: "complete_goals" });
        const freshTarget = await recordCapture(h, "G001");
        assert.equal(freshTarget.goalAttempt, 2);
        finalId = "G001";
        captures = [
          { goalId: "G001", capture: freshTarget },
          { goalId: "G002", capture: second },
        ];
      }
      const finalGate = await qualityGate(h, cwd, captures);
      await good(h, {
        op: "checkpoint",
        goalId: finalId,
        status: "complete",
        evidence: "All current criteria, batch gates and independent review passed",
        qualityGatePath: finalGate,
      });
      assert.equal((await store(h, cwd).load())?.status, "complete");
      assert.equal(h.session.getGoalModeState()?.goal.status, "complete");
      return;
    }
    await createGoals(h, cwd);
    const acquired = await good(h, { op: "complete_goals" });
    assert(acquired.result && typeof acquired.result === "object" && "goal" in acquired.result);
    const acquiredGoal = acquired.result.goal;
    assert(acquiredGoal && typeof acquiredGoal === "object" && "id" in acquiredGoal);
    assert.equal(acquiredGoal.id, "G001");
    const secondAcquire = await good(h, { op: "complete_goals" });
    assert(secondAcquire.result && typeof secondAcquire.result === "object" && "goal" in secondAcquire.result);
    const resumedGoal = secondAcquire.result.goal;
    assert(resumedGoal && typeof resumedGoal === "object" && "attempt" in resumedGoal);
    assert.equal(resumedGoal.attempt, 1);
    await runProduct(cwd);
    if (name === "recovery") {
      const before = await store(h, cwd).load();
      assert(before);
      const pending = structuredClone(before);
      pending.driver.goalId = undefined;
      pending.status = "paused";
      await writeFile(store(h, cwd).file, JSON.stringify(pending));
      await h.runner.emit({ type: "session_start" });
      assert.equal((await store(h, cwd).load())?.driver.goalId, nativeId, "only exact intent-marked native goal is recovered");
      await h.runner.emit({ type: "session_compact", compactionEntry: {} } as Parameters<ExtensionRunner["emit"]>[0]);
      const injected = await h.runner.emitBeforeAgentStart("Continue", undefined, ["Host policy"]);
      assert(
        injected?.messages?.some(
          (message) => typeof message === "object" && typeof message.content === "string" && message.content.includes("ulw_loop status"),
        ),
      );
      await command(h, "reset");
      assert.equal(await store(h, cwd).load(), undefined);
      assert(h.messages.at(-1)?.includes("archived"));
      return;
    }
    const blocked = await h.runner.emitToolCall({
      type: "tool_call",
      toolCallId: "premature",
      toolName: "goal",
      input: { op: "complete" },
    });
    assert.equal(blocked?.block, true);
    await writeFile(join(cwd, "app.mjs"), "console.log('dirty');\n");
    const dirty = await call(h, {
      op: "record_evidence",
      goalId: "G001",
      criterionId: "C001",
      status: "pass",
      evidence: "Observed output",
      artifacts: ["qa-output.txt"],
    });
    assert.equal(dirty.error?.code, "ULW_LOOP_DIRTY_TRACKED");
    await writeFile(join(cwd, "app.mjs"), "console.log('persisted-product-bytes');\n");
    const captureEnvelope = await good(h, {
      op: "record_evidence",
      goalId: "G001",
      criterionId: "C001",
      status: "pass",
      evidence: "A real fresh CLI process printed persisted-product-bytes",
      artifacts: ["qa-output.txt"],
    });
    const capture = captureEnvelope.result as EvidenceCapture;
    assert.equal(capture.binding.treeHash, await git(cwd, "rev-parse", "--verify", "HEAD^{tree}"));
    assert.equal(
      (await call(h, { op: "checkpoint", goalId: "G001", status: "complete", evidence: "Actual CLI output" })).error?.code,
      "ULW_LOOP_QUALITY_GATE_REQUIRED",
    );
    reviewer = await registerReviewChild(h, cwd);
    const gate = await qualityGate(h, cwd, [{ goalId: "G001", capture }]);
    const nativeComplete = h.session.goalRuntime.completeGoalFromTool.bind(h.session.goalRuntime);
    if (name === "completion-recovery")
      h.session.goalRuntime.completeGoalFromTool = async () => {
        throw new Error("simulated native notification failure");
      };
    const accepted = await good(h, {
      op: "checkpoint",
      goalId: "G001",
      status: "complete",
      evidence: "CLI restart QA and independent criterion review passed",
      qualityGatePath: gate,
    });
    assert(accepted.result && typeof accepted.result === "object" && "aggregateComplete" in accepted.result);
    assert.equal(accepted.result.aggregateComplete, true);
    if (name === "completion-recovery") {
      assert.equal((await store(h, cwd).load())?.completion?.nativeNotified, false);
      assert.equal(h.session.getGoalModeState()?.goal.status, "active");
      assert(accepted.warnings?.some((warning) => warning.includes("notification failure")));
      h.session.goalRuntime.completeGoalFromTool = nativeComplete;
      await h.runner.emit({ type: "session_start" });
    }
    const complete = (await store(h, cwd).load()) as LoopState;
    assert.equal(complete.version, 1);
    assert.equal(complete.status, "complete");
    assert.equal(complete.completion?.nativeNotified, true);
    assert.equal(h.session.getGoalModeState()?.goal.status, "complete");
    assert.equal(h.session.getGoalModeState()?.goal.id, nativeId);
    assert.equal(h.completions.length, 1);
    await h.runner.emit({ type: "session_start" });
    await h.runner.emit({ type: "session_tree" } as Parameters<ExtensionRunner["emit"]>[0]);
    assert.equal(h.completions.length, 1, "historic completion never re-emits");
    const completed = await good(h, { op: "complete_goals" });
    assert.deepEqual(completed.result, { noEligibleWork: true, aggregateComplete: true });
    assert.equal((await call(h, { op: "add_goal", ...seed })).error?.code, "ULW_LOOP_DRIVER_NOT_ACTIVE");
    console.log(
      JSON.stringify({
        scenario: name,
        loopStatus: complete.status,
        nativeGoalStatus: h.session.getGoalModeState()?.goal.status,
        version: complete.version,
        treeHash: capture.binding.treeHash,
        capturedArtifactBytes: capture.artifacts[0]?.bytes,
        completionEvents: h.completions.length,
      }),
    );
  } finally {
    await reviewer?.dispose();
    await h.session.dispose();
  }
}

if (process.env[CHILD_ENV]) {
  await scenario(process.env[CHILD_ENV] as string, process.env.ULW_LOOP_SDK_ROOT as string);
  console.log("ULW_LOOP_SDK_OK");
} else {
  // bun:test is loaded only in the parent; each SDK child isolates native host globals.
  const { describe, expect, test } = await import("bun:test");
  describe("ulw-loop real SDK command/tool/native-goal boundary", () => {
    for (const name of [
      "lifecycle",
      "ownership",
      "in-memory",
      "recovery",
      "corrupt",
      "batches",
      "review-blockers",
      "completion-recovery",
    ]) {
      test(name, async () => {
        const root = await mkdtemp(join(tmpdir(), "ulw-loop-sdk-"));
        try {
          const child = Bun.spawn([process.execPath, THIS_FILE], {
            env: {
              ...process.env,
              [CHILD_ENV]: name,
              ULW_LOOP_SDK_ROOT: root,
              HOME: root,
              PI_CODING_AGENT_DIR: join(root, "agent"),
              XDG_RUNTIME_DIR: join(root, "run"),
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code, stderr).toBe(0);
          expect(stdout).toContain("ULW_LOOP_SDK_OK");
          if (name === "lifecycle") console.log(stdout.trim());
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  });
}
