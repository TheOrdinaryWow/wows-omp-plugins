import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureQualityGate,
  copyEvidence,
  criterionFresh,
  evidenceBinding,
  type LoopExec,
  requireCriteria,
} from "../plugins/omo-ultrawork/src/ulw-loop-evidence.ts";
import { acquireGoal, appendGoal, createLoop, type EvidenceCapture } from "../plugins/omo-ultrawork/src/ulw-loop-state.ts";
import { LoopStore } from "../plugins/omo-ultrawork/src/ulw-loop-store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const exec: LoopExec = async (command, args, options) => {
  const process = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
};
async function fixture(git = true) {
  const root = await mkdtemp(join(tmpdir(), "ulw-loop-evidence-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  const gitCommand = async (...args: string[]) => {
    const result = await exec("git", args, { cwd, timeout: 10_000 });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  if (git) {
    await gitCommand("init", "-q");
    await gitCommand("config", "user.name", "Fixture");
    await gitCommand("config", "user.email", "fixture@example.invalid");
    await writeFile(join(cwd, "app.txt"), "verified product bytes\n");
    await gitCommand("add", "app.txt");
    await gitCommand("commit", "-qm", "fixture");
  }
  const store = new LoopStore(join(root, "sessions"), "evidence-session", cwd);
  const state = createLoop(store.sessionId, cwd, "Observe restart behavior");
  state.status = "active";
  const goal = appendGoal(state, {
    title: "Restart",
    objective: "Retain bytes",
    shape: git ? "delivery" : "research",
    tier: "LIGHT",
    criteria: [
      { scenario: "Restart and inspect persisted bytes", expectedEvidence: "Actual transcript and checksum" },
      { scenario: "Optional edge condition", expectedEvidence: "Edge observation", essential: false },
    ],
  });
  acquireGoal(state);
  const criterion = goal.criteria[0];
  if (!criterion) throw new Error("missing criterion");
  const proof = join(cwd, "proof.txt");
  await writeFile(proof, "restart: persisted bytes matched\n");
  const binding = await evidenceBinding(cwd, exec, git);
  const capture: EvidenceCapture = {
    id: "capture-1",
    goalAttempt: 1,
    criterionRevision: 1,
    status: "pass",
    capturedAt: new Date().toISOString(),
    evidence: "Observed a restart retaining persisted bytes",
    artifacts: await copyEvidence(store, [proof], "capture-1"),
    binding,
  };
  criterion.evidenceHistory.push(capture);
  return { root, cwd, gitCommand, store, state, goal, criterion, binding, capture, proof };
}

describe("ulw-loop evidence freshness", () => {
  test("same-tree commit/amend retains proof, changed tree stales it, dirty tracked capture refuses without mutation", async () => {
    const f = await fixture();
    const head = await f.gitCommand("rev-parse", "HEAD");
    await f.gitCommand("commit", "--allow-empty", "-qm", "same tree");
    expect(await f.gitCommand("rev-parse", "HEAD")).not.toBe(head);
    expect(await evidenceBinding(f.cwd, exec)).toEqual(f.binding);
    expect(await criterionFresh(f.store, f.goal, f.criterion, await evidenceBinding(f.cwd, exec))).toBe(true);
    await writeFile(join(f.cwd, "app.txt"), "changed verified bytes\n");
    await expect(evidenceBinding(f.cwd, exec)).rejects.toThrow("dirty");
    expect(await readFile(join(f.cwd, "app.txt"), "utf8")).toBe("changed verified bytes\n");
    await f.gitCommand("add", "app.txt");
    await expect(evidenceBinding(f.cwd, exec)).rejects.toThrow("dirty");
    await f.gitCommand("commit", "-qm", "new tree");
    expect(await criterionFresh(f.store, f.goal, f.criterion, await evidenceBinding(f.cwd, exec))).toBe(false);
    expect(f.capture.binding).toEqual(f.binding);
  });

  test("essential-only checkpoint differs from full/final coverage; revisions, attempts and changed proof cannot inherit a pass", async () => {
    const f = await fixture();
    expect(await requireCriteria(f.store, [f.goal], f.binding, true)).toEqual(["capture-1"]);
    await expect(requireCriteria(f.store, [f.goal], f.binding, false)).rejects.toThrow("C002");
    f.criterion.revision++;
    expect(await criterionFresh(f.store, f.goal, f.criterion, f.binding)).toBe(false);
    f.criterion.revision--;
    f.goal.attempt++;
    expect(await criterionFresh(f.store, f.goal, f.criterion, f.binding)).toBe(false);
    f.goal.attempt--;
    await writeFile(f.proof, "different observation\n");
    expect(await criterionFresh(f.store, f.goal, f.criterion, f.binding)).toBe(false);
    await expect(copyEvidence(f.store, ["missing.txt"], "bad-capture")).rejects.toThrow("existing non-empty");
    await writeFile(join(f.cwd, "empty.txt"), "");
    await expect(copyEvidence(f.store, ["empty.txt"], "empty-capture")).rejects.toThrow("existing non-empty");
  });

  test("non-Git research uses source/report artifact hashes without inventing a Git id", async () => {
    const f = await fixture(false);
    expect(f.binding).toEqual({ kind: "artifacts" });
    expect(await criterionFresh(f.store, f.goal, f.criterion, f.binding)).toBe(true);
    await expect(evidenceBinding(f.cwd, exec, true)).rejects.toThrow("Git repository");
    await writeFile(f.proof, "source/report changed\n");
    expect(await criterionFresh(f.store, f.goal, f.criterion, f.binding)).toBe(false);
  });

  test("quality gates require shaped QA, current full coverage and a distinct actual child", async () => {
    const f = await fixture();
    f.goal.criteria = [f.criterion];
    await writeFile(join(f.cwd, "qa.txt"), "Restarted the CLI and observed the retained bytes.\n");
    await writeFile(join(f.cwd, "review.txt"), "Independent criterion/goal review: PASS, no blockers.\n");
    const file = join(f.cwd, "quality-gate.json");
    const gate = {
      version: 1,
      treeHash: f.binding.treeHash,
      criteriaCoverage: [{ goalId: f.goal.id, criterionId: f.criterion.id, captureId: f.capture.id }],
      qa: {
        reportPath: "qa.txt",
        entries: [
          {
            goalId: f.goal.id,
            criterionId: f.criterion.id,
            kind: "real-surface",
            artifactPath: "proof.txt",
            observation: "Restart retained bytes",
          },
        ],
      },
      review: { agentId: "child-review", reportPath: "review.txt", verdict: "PASS", blockers: [] },
    };
    await writeFile(file, JSON.stringify(gate));
    await expect(captureQualityGate(f.store, [f.goal], f.binding, file, () => false)).rejects.toThrow("actual distinct child");
    const saved = await captureQualityGate(f.store, [f.goal], f.binding, file, (id) => id === "child-review");
    expect(saved.captureIds).toEqual([f.capture.id]);
    expect(saved.artifacts).toHaveLength(4);
    const qaEntry = gate.qa.entries[0];
    const coverage = gate.criteriaCoverage[0];
    if (!qaEntry || !coverage) throw new Error("missing gate fixture rows");
    qaEntry.kind = "research-source";
    await writeFile(file, JSON.stringify(gate));
    await expect(captureQualityGate(f.store, [f.goal], f.binding, file, () => true)).rejects.toThrow("Missing shaped");
    qaEntry.kind = "real-surface";
    coverage.captureId = "old-capture";
    await writeFile(file, JSON.stringify(gate));
    await expect(captureQualityGate(f.store, [f.goal], f.binding, file, () => true)).rejects.toThrow("current capture");
  });
});
