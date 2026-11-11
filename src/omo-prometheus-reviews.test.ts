import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { planDigest } from "../plugins/omo-prometheus/src/ledger.ts";
import { copyPlanReviews, PlanReviews, planReviewBindings } from "../plugins/omo-prometheus/src/plan-reviews.ts";

async function fixture(
  run: (value: { root: string; local: string; plan: string; warnings: unknown[]; reviews: PlanReviews }) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "prometheus-reviews-")));
  const local = path.join(root, "local");
  await fs.mkdir(local);
  const plan = path.join(local, "change-plan.md");
  await fs.writeFile(plan, "# Original plan\n");
  const warnings: unknown[] = [];
  try {
    await run({ root, local, plan, warnings, reviews: new PlanReviews((error) => warnings.push(error)) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function reviewTask(plan: string, kind = "routine", agent = "momus", round = "r1") {
  return { agent, task: `absolute_plan_path: ${plan}\nreview_round: ${round}\nreview_kind: ${kind}\nReview the bound file.` };
}

function result(id: string, output: string, fields: Record<string, unknown> = {}) {
  return { details: { results: [{ index: 0, id, exitCode: 0, output, ...fields }] } };
}

describe("Prometheus pre-approval review diagnostics", () => {
  test("reads only explicit review contracts in each task's own text without inferring a path from prose", () => {
    expect(planReviewBindings(reviewTask("/plans/current.md"))).toMatchObject([
      { index: 0, absolute_plan_path: "/plans/current.md", review_round: "r1", review_kind: "routine", requestedAgent: "momus" },
    ]);
    expect(
      planReviewBindings({
        context: "Shared review constraints",
        tasks: [
          reviewTask("/plans/current.md", "high_accuracy", "momus", "pair-1"),
          reviewTask("/plans/current.md", "high_accuracy", "oracle", "pair-1"),
        ],
      }).map((binding) => [binding.index, binding.requestedAgent]),
    ).toEqual([
      [0, "momus"],
      [1, "oracle"],
    ]);
    expect(
      planReviewBindings({
        context: "absolute_plan_path: /plans/current.md\nreview_round: pair-1\nreview_kind: high_accuracy",
        tasks: [{ agent: "momus", task: "Audit independently" }],
      }),
    ).toEqual([]);
    for (const task of [
      "Review /plans/current.md; review_kind: routine; review_round: r1",
      "absolute_plan_path: local://current.md\nreview_kind: routine\nreview_round: r1",
      "absolute_plan_path: /plans/current.md\nreview_kind: compliance\nreview_round: r1",
      "absolute_plan_path: /plans/current.md\nreview_kind: routine",
      "absolute_plan_path: /plans/first.md\nabsolute_plan_path: /plans/second.md\nreview_kind: routine\nreview_round: r1",
    ])
      expect(planReviewBindings({ agent: "momus", task })).toEqual([]);
    expect(planReviewBindings({ ...reviewTask("/plans/current.md"), taskFile: "review.md" })).toEqual([]);
  });

  test("archives both review lanes against dispatch-time bytes, with exclusive numbering and durable session deduplication", async () => {
    await fixture(async ({ root, plan, reviews, warnings }) => {
      await reviews.remember("parent", "momus-call", reviewTask(plan, "high_accuracy"), root);
      await reviews.remember("parent", "oracle-call", reviewTask(plan, "high_accuracy", "oracle"), root);
      await fs.writeFile(plan, "# A later revision\n");
      await Promise.all([
        reviews.observeResult("parent", "momus-call", result("MomusOne", "[REJECT]\nBinding: current plan\nMissing the required CLI.")),
        reviews.observeResult("parent", "oracle-call", result("OracleOne", "[OKAY]\nBinding: current plan\nNo blockers.")),
      ]);
      const directory = `${plan}.reviews`;
      const files = (await fs.readdir(directory)).sort();
      expect(files).toHaveLength(2);
      expect(files.map((name) => name.slice(0, 3))).toEqual(["001", "002"]);
      const artifacts = await Promise.all(files.map((name) => fs.readFile(path.join(directory, name), "utf8")));
      const identities = artifacts.map((content) => JSON.parse(content.split("\n")[1] ?? ""));
      expect(identities.map((entry) => entry.agent).sort()).toEqual(["momus", "oracle"]);
      expect(identities.every((entry) => entry.planSha256 === planDigest("# Original plan\n") && entry.absolute_plan_path === plan)).toBe(
        true,
      );
      expect(identities.map((entry) => entry.verdict).sort()).toEqual(["okay", "reject"]);
      expect(artifacts.some((content) => content.endsWith("Missing the required CLI."))).toBe(true);
      const restored = new PlanReviews((error) => warnings.push(error));
      await restored.remember("parent", "duplicate", reviewTask(plan), root);
      await restored.observeResult(
        "parent",
        "duplicate",
        result("MomusOne", "[OKAY]\nChanged verdict must not replace the session's original."),
      );
      expect((await fs.readdir(directory)).sort()).toEqual(files);
      expect(await Promise.all(files.map((name) => fs.readFile(path.join(directory, name), "utf8")))).toEqual(artifacts);
      expect(warnings).toEqual([]);
    });
  });

  test("keeps verdict-looking prose, failed native runs, and unbound results out of the archive", async () => {
    await fixture(async ({ root, plan, reviews, warnings }) => {
      await reviews.observeResult("parent", "unbound", result("Foreign", "[OKAY]\nUnbound"));
      for (const [id, output, fields] of [
        ["Failed", "[OKAY]\nA verdict before integration failed", { error: "native integration failed" }],
        ["Aborted", "[OKAY]\nCancelled", { aborted: true }],
        ["Crash", "[REJECT]\nA crashed result", { exitCode: 1 }],
        ["Prose", "The old reviewer said [OKAY], but this is not a verdict.", {}],
      ] as const) {
        await reviews.remember("parent", id, reviewTask(plan), root);
        await reviews.observeResult("parent", id, result(id, output, fields));
      }
      expect(await fs.exists(`${plan}.reviews`)).toBe(false);
      await reviews.remember("parent", "inconclusive", reviewTask(plan), root);
      await reviews.observeResult("parent", "inconclusive", result("NoEvidence", "[INCONCLUSIVE]\nA required reference was unreadable."));
      expect(await fs.readdir(`${plan}.reviews`)).toEqual(["001-routine-inconclusive.md"]);
      expect(warnings).toEqual([]);
    });
  });

  test("requires containment before reading plans and refuses symlinked archive storage without changing task results", async () => {
    await fixture(async ({ root, local, plan, reviews, warnings }) => {
      const outside = path.join(root, "outside.md");
      await fs.writeFile(outside, "# Outside\n");
      const linked = path.join(local, "linked.md");
      await fs.symlink(outside, linked);
      for (const [index, target] of [outside, linked, path.join(local, "..", "outside.md")].entries()) {
        await reviews.remember("parent", `outside-${index}`, reviewTask(target), root);
        await reviews.observeResult("parent", `outside-${index}`, result("Escape", "[OKAY]\nDo not archive"));
      }
      expect(await fs.exists(`${outside}.reviews`)).toBe(false);
      const foreign = path.join(root, "foreign-reviews");
      await fs.mkdir(foreign);
      await fs.symlink(foreign, `${plan}.reviews`, "dir");
      await reviews.remember("parent", "linked-archive", reviewTask(plan), root);
      const native = result("LinkedArchive", "[OKAY]\nNo write may escape");
      const original = structuredClone(native);
      await reviews.observeResult("parent", "linked-archive", native);
      expect(native).toEqual(original);
      expect(await fs.readdir(foreign)).toEqual([]);
      expect(warnings.length).toBeGreaterThanOrEqual(4);
    });
  });

  test("waits for the exact owned native async job to settle before capturing its output", async () => {
    await fixture(async ({ root, plan, reviews, warnings }) => {
      await reviews.remember("parent", "background", reviewTask(plan, "high_accuracy", "oracle"), root);
      const terminal = Promise.withResolvers<void>();
      const job = {
        id: "job-oracle",
        type: "task",
        agentId: "AsyncOracle",
        ownerId: "Main",
        status: "running",
        startTime: Date.now(),
        promise: terminal.promise,
      };
      await fs.writeFile(path.join(root, "AsyncOracle.md"), "[OKAY]\nFinal native artifact");
      await reviews.observeResult("parent", "background", {
        details: { async: {}, progress: [{ id: "AsyncOracle", index: 0, status: "completed" }] },
      });
      reviews.observeJobs("parent", { ownerId: "Foreign", jobs: [job], getJob: () => job });
      expect(await fs.exists(`${plan}.reviews`)).toBe(false);
      reviews.observeJobs("parent", { ownerId: "Main", jobs: [job], getJob: () => job });
      job.status = "completed";
      expect(await fs.exists(`${plan}.reviews`)).toBe(false);
      terminal.resolve();
      await terminal.promise;
      await reviews.flush();
      expect(await fs.readdir(`${plan}.reviews`)).toEqual(["001-high_accuracy-okay.md"]);
      expect(await fs.readFile(path.join(`${plan}.reviews`, "001-high_accuracy-okay.md"), "utf8")).toContain("Final native artifact");
      expect(warnings).toEqual([]);
    });
  });

  test("copies diagnostic history only, skips invalid files, and fails open when copying cannot write", async () => {
    await fixture(async ({ root, plan, reviews, warnings }) => {
      await reviews.remember("parent", "initial", reviewTask(plan), root);
      await reviews.observeResult("parent", "initial", result("First", "[REJECT]\nAn earlier plan revision"));
      await fs.writeFile(plan, "# Revised\n");
      await reviews.remember("parent", "revised", reviewTask(plan), root);
      await reviews.observeResult("parent", "revised", result("Second", "[OKAY]\nCurrent plan revision"));
      await fs.writeFile(path.join(`${plan}.reviews`, "003-routine-okay.md"), "[OKAY]\nNot a recorded review");
      await fs.writeFile(path.join(`${plan}.reviews`, "approval.json"), "not approval");
      await fs.symlink(plan, path.join(`${plan}.reviews`, "004-routine-okay.md"));
      const bundle = path.join(root, "bundle");
      await fs.mkdir(bundle);
      const destination = path.join(bundle, "reviews");
      await copyPlanReviews(plan, destination, (error) => warnings.push(error));
      expect((await fs.readdir(destination)).sort()).toEqual(["001-routine-reject.md", "002-routine-okay.md"]);
      const files = await Promise.all((await fs.readdir(destination)).map((name) => fs.readFile(path.join(destination, name), "utf8")));
      expect(files.map((content) => JSON.parse(content.split("\n")[1] ?? "").planSha256).sort()).toEqual(
        [planDigest("# Original plan\n"), planDigest("# Revised\n")].sort(),
      );
      const blocked = path.join(root, "not-a-directory");
      await fs.writeFile(blocked, "keep");
      await expect(copyPlanReviews(plan, blocked, (error) => warnings.push(error))).resolves.toBeUndefined();
      expect(await fs.readFile(blocked, "utf8")).toBe("keep");
      expect(warnings.length).toBeGreaterThan(0);
    });
  });
});
