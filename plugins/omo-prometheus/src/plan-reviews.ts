import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { planDigest } from "#src/ledger.ts";
import { withLedgerLock } from "#src/ledger-store.ts";

type ReviewKind = "routine" | "high_accuracy";
type ReviewVerdict = "okay" | "reject" | "inconclusive";

interface ReviewBinding {
  index: number;
  absolute_plan_path: string;
  review_round: string;
  review_kind: ReviewKind;
  requestedAgent: string;
}

interface ReviewDispatch extends ReviewBinding {
  planSha256: string;
  artifactsDir: string;
  dispatchedAt: number;
  returnedAt?: number;
  childId?: string;
  observingJob?: boolean;
}

interface ReviewMetadata extends ReviewBinding {
  version: 1;
  planSha256: string;
  reviewerSession: string;
  verdict: ReviewVerdict;
  recordedAt: string;
  toolCallId: string;
  agent: string;
}

const ARTIFACT = /^\d{3,}-(?:routine|high_accuracy)-(?:okay|reject|inconclusive)\.md$/;
const CHILD_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Read only the explicit contract fields in each task's own text, never a path inferred from review prose. */
export function planReviewBindings(input: unknown): ReviewBinding[] {
  const args = object(input);
  if (!args) return [];
  const tasks = Array.isArray(args.tasks) ? args.tasks : [args];
  return tasks.flatMap((raw, index) => {
    const task = object(raw);
    if (typeof task?.task !== "string" || task.taskFile !== undefined) return [];
    const fields = new Map<string, string>();
    for (const line of task.task.split("\n")) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      if (key !== "absolute_plan_path" && key !== "review_round" && key !== "review_kind") continue;
      const value = line.slice(separator + 1).trim();
      if (!value || fields.has(key)) return [];
      fields.set(key, value);
    }
    const absolute_plan_path = fields.get("absolute_plan_path");
    const review_round = fields.get("review_round");
    const review_kind = fields.get("review_kind");
    if (!absolute_plan_path || !path.isAbsolute(absolute_plan_path) || !review_round) return [];
    if (review_kind !== "routine" && review_kind !== "high_accuracy") return [];
    return [{ index, absolute_plan_path, review_round, review_kind, requestedAgent: typeof task.agent === "string" ? task.agent : "task" }];
  });
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function directory(file: string): Promise<void> {
  if (!(await fs.lstat(file)).isDirectory() || (await fs.realpath(file)) !== file)
    throw new Error("Review storage is not a canonical directory");
}

async function regularFile(file: string): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Review storage is not a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function metadata(content: string): ReviewMetadata | undefined {
  const [heading, json, closing] = content.split("\n", 3);
  if (heading !== "<!-- prometheus-plan-review" || closing !== "-->") return undefined;
  try {
    const value = object(JSON.parse(json ?? ""));
    if (
      value?.version !== 1 ||
      typeof value.absolute_plan_path !== "string" ||
      typeof value.planSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.planSha256) ||
      typeof value.reviewerSession !== "string" ||
      (value.review_kind !== "routine" && value.review_kind !== "high_accuracy") ||
      !["okay", "reject", "inconclusive"].includes(String(value.verdict))
    )
      return undefined;
    return value as unknown as ReviewMetadata;
  } catch {
    return undefined;
  }
}

function verdictOf(output: string): ReviewVerdict | undefined {
  const first = output.trimStart().split("\n", 1)[0]?.trim();
  if (first === "[OKAY]") return "okay";
  if (first === "[REJECT]") return "reject";
  if (first === "[INCONCLUSIVE]") return "inconclusive";
  return undefined;
}

async function archive(review: ReviewMetadata, output: string): Promise<void> {
  const root = `${review.absolute_plan_path}.reviews`;
  await fs.mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await directory(root);
  await withLedgerLock(root, async () => {
    const temp = path.join(root, `.pending-${randomUUID()}`);
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      try {
        await handle.writeFile(
          `<!-- prometheus-plan-review\n${JSON.stringify(review)}\n-->\n\n# ${review.review_kind}: ${review.verdict}\n\nDiagnostic review only; native approval remains required.\n\n${output}`,
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      while (true) {
        await directory(root);
        const files = (await fs.readdir(root)).filter((name) => ARTIFACT.test(name));
        for (const name of files) {
          const prior = metadata(await regularFile(path.join(root, name)));
          if (prior?.reviewerSession === review.reviewerSession) return;
        }
        const number = Math.max(0, ...files.map((name) => Number.parseInt(name, 10))) + 1;
        const target = path.join(root, `${String(number).padStart(3, "0")}-${review.review_kind}-${review.verdict}.md`);
        try {
          await fs.link(temp, target);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
  });
}

/** Best-effort diagnostics: neither capture nor copying participates in approval or row completion. */
export class PlanReviews {
  readonly #dispatches = new Map<string, ReviewDispatch[]>();
  readonly #writes = new Set<Promise<void>>();
  readonly #warn: (error: unknown) => void;

  constructor(warn: (error: unknown) => void) {
    this.#warn = warn;
  }

  async flush(): Promise<void> {
    await Promise.all(this.#writes);
  }

  async remember(sessionId: string, toolCallId: string, input: unknown, artifactsDir: string): Promise<void> {
    const reviews: ReviewDispatch[] = [];
    for (const binding of planReviewBindings(input)) {
      try {
        const local = path.join(artifactsDir, "local");
        await directory(local);
        if (!contained(local, binding.absolute_plan_path) || (await fs.realpath(binding.absolute_plan_path)) !== binding.absolute_plan_path)
          throw new Error("Review plan must be a canonical file inside this session's local artifacts");
        reviews.push({
          ...binding,
          artifactsDir,
          planSha256: planDigest(await regularFile(binding.absolute_plan_path)),
          dispatchedAt: Date.now(),
        });
      } catch (error) {
        this.#warn(error);
      }
    }
    if (reviews.length) this.#dispatches.set(`${sessionId}:${toolCallId}`, reviews);
  }

  async #save(review: ReviewDispatch, toolCallId: string, childId: string, agent?: string, output?: string): Promise<void> {
    if (!CHILD_ID.test(childId)) return;
    try {
      await directory(path.dirname(review.absolute_plan_path));
      if (output === undefined) output = await regularFile(path.join(review.artifactsDir, `${childId}.md`));
      const verdict = verdictOf(output);
      if (!verdict) return;
      await archive(
        {
          index: review.index,
          absolute_plan_path: review.absolute_plan_path,
          review_round: review.review_round,
          review_kind: review.review_kind,
          requestedAgent: review.requestedAgent,
          planSha256: review.planSha256,
          version: 1,
          reviewerSession: path.join(review.artifactsDir, `${childId}.jsonl`),
          verdict,
          recordedAt: new Date().toISOString(),
          toolCallId,
          agent: agent ?? review.requestedAgent,
        },
        output,
      );
    } catch (error) {
      this.#warn(error);
    }
  }

  async observeResult(sessionId: string, toolCallId: string, result: unknown): Promise<void> {
    const reviews = this.#dispatches.get(`${sessionId}:${toolCallId}`);
    if (!reviews) return;
    const details = object(object(result)?.details);
    for (const review of reviews) review.returnedAt = Date.now();
    if (Array.isArray(details?.results)) {
      for (const raw of details.results) {
        const item = object(raw);
        const review = reviews.find((entry) => entry.index === item?.index);
        if (!review || typeof item?.id !== "string" || item.exitCode !== 0 || item.error !== undefined || item.aborted === true) continue;
        await this.#save(
          review,
          toolCallId,
          item.id,
          typeof item.agent === "string" ? item.agent : undefined,
          item.truncated !== true && typeof item.output === "string" ? item.output : undefined,
        );
      }
    }
    if (object(details?.async) && Array.isArray(details?.progress)) {
      for (const raw of details.progress) {
        const progress = object(raw);
        const review = reviews.find((entry) => entry.index === progress?.index);
        if (review && typeof progress?.id === "string") review.childId = progress.id;
      }
    } else this.#dispatches.delete(`${sessionId}:${toolCallId}`);
  }

  observeJobs(sessionId: string, native: { ownerId: string; jobs: readonly unknown[]; getJob: (id: string) => unknown }): void {
    for (const [key, reviews] of this.#dispatches) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      for (const review of reviews) {
        if (!review.childId || review.observingJob || review.returnedAt === undefined) continue;
        const jobs = native.jobs.filter((raw) => {
          const job = object(raw);
          return (
            job?.type === "task" &&
            job.ownerId === native.ownerId &&
            job.agentId === review.childId &&
            typeof job.startTime === "number" &&
            job.startTime >= review.dispatchedAt &&
            job.startTime <= (review.returnedAt as number)
          );
        });
        const job = jobs.length === 1 ? object(jobs[0]) : undefined;
        if (!job || typeof job.id !== "string" || !(job.promise instanceof Promise)) continue;
        review.observingJob = true;
        const id = job.id;
        void job.promise
          .then(async () => {
            const final = object(native.getJob(id)) ?? job;
            if (final.status === "completed" && final.agentOutputPublished !== false) {
              const writing = this.#save(review, key.slice(sessionId.length + 1), review.childId as string);
              this.#writes.add(writing);
              try {
                await writing;
              } finally {
                this.#writes.delete(writing);
              }
            }
            if (reviews.every((entry) => entry.childId === undefined || entry.observingJob)) this.#dispatches.delete(key);
          })
          .catch(this.#warn);
      }
    }
  }
}

export async function readPlanReviews(
  sourcePlanPath: string,
  warn: (error: unknown) => void,
): Promise<{ version: 1; absolute_plan_path: string; artifacts: Array<{ name: string; content: string }> } | undefined> {
  const root = `${sourcePlanPath}.reviews`;
  const artifacts: Array<{ name: string; content: string }> = [];
  try {
    await directory(root);
    for (const name of (await fs.readdir(root)).filter((entry) => ARTIFACT.test(entry))) {
      try {
        const content = await regularFile(path.join(root, name));
        if (metadata(content)?.absolute_plan_path === sourcePlanPath) artifacts.push({ name, content });
      } catch (error) {
        warn(error);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(error);
  }
  return artifacts.length ? { version: 1, absolute_plan_path: sourcePlanPath, artifacts } : undefined;
}

export async function copyPlanReviews(
  sourcePlanPath: string,
  destination: string,
  warn: (error: unknown) => void,
  recordedHistory?: unknown,
): Promise<void> {
  const history = object(recordedHistory ?? (await readPlanReviews(sourcePlanPath, warn)));
  if (history?.version !== 1 || typeof history.absolute_plan_path !== "string" || !Array.isArray(history.artifacts)) return;
  for (const raw of history.artifacts) {
    try {
      const artifact = object(raw);
      if (
        typeof artifact?.name !== "string" ||
        !ARTIFACT.test(artifact.name) ||
        typeof artifact.content !== "string" ||
        metadata(artifact.content)?.absolute_plan_path !== history.absolute_plan_path
      )
        continue;
      await fs.mkdir(destination, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await directory(destination);
      await fs.writeFile(path.join(destination, artifact.name), artifact.content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      warn(error);
    }
  }
}
