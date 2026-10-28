import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type EvidenceArtifact,
  type EvidenceBinding,
  type EvidenceCapture,
  type LoopCriterion,
  type LoopGoal,
  type LoopState,
  nonempty,
  type QualityGateReceipt,
  requireLoop,
} from "#src/ulw-loop-state.ts";
import type { LoopStore } from "#src/ulw-loop-store.ts";

export type LoopExec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** HEAD alone cannot describe dirty tracked bytes. Never stash/reset or invent a tree id. */
export async function evidenceBinding(cwd: string, exec: LoopExec, requireGit = false): Promise<EvidenceBinding> {
  const repository = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 10_000 });
  if (repository.code !== 0 || repository.stdout.trim() !== "true") {
    requireLoop(
      !requireGit,
      "ULW_LOOP_GIT_REQUIRED",
      "Delivery evidence needs a Git repository with a committed HEAD. Non-Git research may use source/artifact hashes.",
    );
    return { kind: "artifacts" };
  }
  const tracked = await exec("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd, timeout: 10_000 });
  requireLoop(tracked.code === 0, "ULW_LOOP_GIT_FAILED", tracked.stderr || "Cannot inspect tracked Git changes.");
  requireLoop(
    !tracked.stdout.trim(),
    "ULW_LOOP_DIRTY_TRACKED",
    "Tracked files are dirty. Commit the verified work or choose another workspace before capturing/completing evidence. No files were stashed or reset.",
  );
  const tree = await exec("git", ["rev-parse", "--verify", "HEAD^{tree}"], { cwd, timeout: 10_000 });
  requireLoop(
    tree.code === 0 && /^[a-f0-9]{40,64}$/.test(tree.stdout.trim()),
    "ULW_LOOP_GIT_FAILED",
    "Cannot resolve the full HEAD^{tree}; create a committed Git HEAD before capturing evidence.",
  );
  return { kind: "git-tree", treeHash: tree.stdout.trim() };
}

export async function copyEvidence(store: LoopStore, paths: string[], captureId: string): Promise<EvidenceArtifact[]> {
  const records: EvidenceArtifact[] = [];
  const directory = path.join(store.evidenceRoot, captureId);
  const inputs = await Promise.all(
    paths.map(async (input) => {
      const originalPath = path.resolve(store.cwd, input);
      const stat = await fs.stat(originalPath).catch(() => undefined);
      requireLoop(
        stat?.isFile() && stat.size > 0,
        "ULW_LOOP_EVIDENCE_ARTIFACT_MISSING",
        `Evidence artifact must be an existing non-empty file: ${originalPath}`,
      );
      const bytes = await fs.readFile(originalPath);
      requireLoop(bytes.length > 0, "ULW_LOOP_EVIDENCE_ARTIFACT_MISSING", `Evidence artifact is empty: ${originalPath}`);
      return { originalPath, bytes };
    }),
  );
  if (inputs.length) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    for (const [index, input] of inputs.entries()) {
      const file = path.join(directory, `${index + 1}-${path.basename(input.originalPath)}`);
      await fs.writeFile(file, input.bytes, { flag: "wx", mode: 0o600 });
      records.push({
        path: path.relative(store.root, file),
        originalPath: input.originalPath,
        sha256: digest(input.bytes),
        bytes: input.bytes.length,
      });
    }
    return records;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function artifactsFresh(store: LoopStore, artifacts: EvidenceArtifact[]): Promise<boolean> {
  for (const artifact of artifacts) {
    const file = path.resolve(store.root, artifact.path);
    if (!file.startsWith(`${store.evidenceRoot}${path.sep}`)) return false;
    try {
      const [captured, current] = await Promise.all([fs.readFile(file), fs.readFile(artifact.originalPath)]);
      if (captured.length !== artifact.bytes || digest(captured) !== artifact.sha256 || digest(current) !== artifact.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}
export function latestCapture(goal: LoopGoal, criterion: LoopCriterion): EvidenceCapture | undefined {
  return criterion.evidenceHistory.findLast(
    (capture) => capture.goalAttempt === goal.attempt && capture.criterionRevision === criterion.revision,
  );
}
export async function criterionFresh(
  store: LoopStore,
  goal: LoopGoal,
  criterion: LoopCriterion,
  binding: EvidenceBinding,
): Promise<boolean> {
  const capture = latestCapture(goal, criterion);
  return Boolean(
    capture?.status === "pass" &&
      capture.artifacts.length &&
      capture.binding.kind === binding.kind &&
      capture.binding.treeHash === binding.treeHash &&
      (await artifactsFresh(store, capture.artifacts)),
  );
}
export async function requireCriteria(
  store: LoopStore,
  goals: LoopGoal[],
  binding: EvidenceBinding,
  essentialOnly: boolean,
): Promise<string[]> {
  const captureIds: string[] = [];
  for (const goal of goals) {
    for (const criterion of goal.criteria) {
      if (essentialOnly && !criterion.essential) continue;
      requireLoop(
        await criterionFresh(store, goal, criterion, binding),
        "ULW_LOOP_EVIDENCE_REQUIRED",
        `${goal.id}/${criterion.id} needs a current passing capture for this attempt, definition, artifacts and tree.`,
      );
      captureIds.push((latestCapture(goal, criterion) as EvidenceCapture).id);
    }
  }
  return captureIds;
}

interface GateFile {
  version: 1;
  treeHash?: string;
  criteriaCoverage: { goalId: string; criterionId: string; captureId: string }[];
  qa: {
    reportPath: string;
    entries: { goalId: string; criterionId: string; kind: "real-surface" | "research-source"; artifactPath: string; observation: string }[];
  };
  review: { agentId: string; reportPath: string; verdict: "PASS"; blockers: unknown[] };
}
export function qualityGateTemplate(state: LoopState, goals: LoopGoal[], binding: EvidenceBinding): Record<string, unknown> {
  return {
    version: 1,
    treeHash: binding.treeHash,
    criteriaCoverage: goals.flatMap((goal) =>
      goal.criteria.map((criterion) => ({
        goalId: goal.id,
        criterionId: criterion.id,
        captureId: latestCapture(goal, criterion)?.id ?? "<current capture id>",
      })),
    ),
    qa: {
      reportPath: "<non-empty QA report path>",
      entries: goals.flatMap((goal) =>
        goal.criteria.map((criterion) => ({
          goalId: goal.id,
          criterionId: criterion.id,
          kind: goal.shape === "research" ? "research-source" : "real-surface",
          artifactPath: "<observed evidence path>",
          observation: "<actual observation>",
        })),
      ),
    },
    review: {
      agentId: "<distinct child agent id>",
      reportPath: "<non-empty independent review report path>",
      verdict: "PASS",
      blockers: [],
    },
    objective: state.objective,
  };
}
export async function captureQualityGate(
  store: LoopStore,
  goals: LoopGoal[],
  binding: EvidenceBinding,
  input: string,
  independentChild: (id: string) => boolean,
): Promise<QualityGateReceipt> {
  const file = path.resolve(store.cwd, input);
  const bytes = await fs.readFile(file).catch(() => undefined);
  requireLoop(bytes?.length, "ULW_LOOP_QUALITY_GATE_REQUIRED", `Read an existing quality-gate JSON file: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    requireLoop(false, "ULW_LOOP_QUALITY_GATE_INVALID", "Quality gate is not valid JSON.");
  }
  const gate = raw as GateFile | undefined;
  requireLoop(
    gate?.version === 1 &&
      Array.isArray(gate.criteriaCoverage) &&
      Array.isArray(gate.qa?.entries) &&
      gate.qa.entries.length > 0 &&
      nonempty(gate.qa.reportPath),
    "ULW_LOOP_QUALITY_GATE_INVALID",
    "Quality gate needs version 1, criteriaCoverage and concrete QA entries/report.",
  );
  requireLoop(
    gate.treeHash === binding.treeHash,
    "ULW_LOOP_QUALITY_GATE_STALE",
    "Quality gate treeHash must equal the current full HEAD^{tree} (omit it only for non-Git research).",
  );
  requireLoop(
    gate.review?.verdict === "PASS" &&
      Array.isArray(gate.review.blockers) &&
      gate.review.blockers.length === 0 &&
      nonempty(gate.review.reportPath) &&
      nonempty(gate.review.agentId) &&
      independentChild(gate.review.agentId),
    "ULW_LOOP_INDEPENDENT_REVIEW_REQUIRED",
    "Quality gate needs a PASS report from an actual distinct child of this OMP session, with no blockers.",
  );
  const expected = await requireCriteria(store, goals, binding, false);
  const rows = new Set<string>();
  for (const row of gate.criteriaCoverage) {
    requireLoop(
      row && nonempty(row.goalId) && nonempty(row.criterionId) && nonempty(row.captureId),
      "ULW_LOOP_QUALITY_GATE_INVALID",
      "Invalid criterion coverage row.",
    );
    const key = `${row.goalId}/${row.criterionId}`;
    requireLoop(!rows.has(key), "ULW_LOOP_QUALITY_GATE_INVALID", `Duplicate coverage row ${key}.`);
    rows.add(key);
  }
  for (const goal of goals) {
    for (const criterion of goal.criteria) {
      const capture = latestCapture(goal, criterion) as EvidenceCapture;
      requireLoop(
        gate.criteriaCoverage.some((row) => row.goalId === goal.id && row.criterionId === criterion.id && row.captureId === capture.id),
        "ULW_LOOP_QUALITY_GATE_INVALID",
        `Gate does not cover current capture ${goal.id}/${criterion.id}.`,
      );
      requireLoop(
        gate.qa.entries.some(
          (row) =>
            row.goalId === goal.id &&
            row.criterionId === criterion.id &&
            row.kind === (goal.shape === "research" ? "research-source" : "real-surface") &&
            nonempty(row.observation) &&
            nonempty(row.artifactPath),
        ),
        "ULW_LOOP_QA_REQUIRED",
        `Missing shaped, observable QA entry for ${goal.id}/${criterion.id}.`,
      );
    }
  }
  const artifacts = await copyEvidence(
    store,
    [file, gate.qa.reportPath, gate.review.reportPath, ...gate.qa.entries.map((row) => row.artifactPath)],
    `gate-${randomUUID()}`,
  );
  requireLoop(
    artifacts[0]?.sha256 === digest(bytes),
    "ULW_LOOP_QUALITY_GATE_CHANGED",
    "The quality-gate file changed while it was captured; reread and retry the same authoritative file.",
  );
  return {
    path: artifacts[0]?.path as string,
    sha256: digest(bytes),
    binding,
    captureIds: expected,
    artifacts,
    reviewAgentId: gate.review.agentId,
  };
}
export async function gateFresh(
  store: LoopStore,
  receipt: QualityGateReceipt,
  captures: string[],
  binding: EvidenceBinding,
): Promise<boolean> {
  return (
    receipt.binding.kind === binding.kind &&
    receipt.binding.treeHash === binding.treeHash &&
    captures.every((id) => receipt.captureIds.includes(id)) &&
    (await artifactsFresh(store, receipt.artifacts))
  );
}
