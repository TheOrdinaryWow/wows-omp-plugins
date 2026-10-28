/**
 * Modified-port notice: adapts packages/omo-senpi/src/components/init-deep-advisor/
 * {constants,coverage,drift,eligibility,git-helpers}.ts from oh-my-openagent revision
 * 8a8db1d3094da8743989bf693ee5de77889de50e, Copyright the oh-my-openagent contributors,
 * licensed under the Sustainable Use License 1.0 (see LICENSE-SUL-1.0 and NOTICE).
 * OMP adaptation: asynchronous bounded Git probes and one shared inventory/content cache.
 */
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

export const MS_PER_DAY = 86_400_000;
export const COOLDOWN_MS = 7 * MS_PER_DAY;
const SOURCE_EXTENSIONS: Readonly<Record<string, true>> = {
  ".ts": true,
  ".tsx": true,
  ".js": true,
  ".jsx": true,
  ".py": true,
  ".go": true,
  ".rs": true,
  ".java": true,
  ".kt": true,
  ".swift": true,
  ".rb": true,
  ".php": true,
  ".c": true,
  ".cpp": true,
  ".cs": true,
  ".scala": true,
  ".lua": true,
  ".ex": true,
  ".exs": true,
  ".zig": true,
  ".dart": true,
};
const EXCLUDED_DIRS: Readonly<Record<string, true>> = {
  node_modules: true,
  ".git": true,
  dist: true,
  build: true,
  vendor: true,
  ".next": true,
  __pycache__: true,
  ".venv": true,
  target: true,
  coverage: true,
  third_party: true,
};
const DRIFT_EXCLUDES = [":(exclude)AGENTS.md", ":(exclude,glob)**/AGENTS.md", ":(exclude).omo/init-deep.json"];

export interface GitRepository {
  root: string;
  commonDir: string;
  head: string;
}

export interface SnapshotFields {
  commitSha: string;
  fileCount: number;
  loc: number;
  timestamp: number;
  mode: "local" | "committed";
}

export interface Coverage {
  missingRatio: number;
  candidateDirs: number;
  coveredDirs: number;
}

export interface Drift {
  commitsSince: number;
  touchedRatio: number;
  churnLocRatio: number;
  daysSince: number;
}

export interface AdvisorProposal {
  trigger: "coverage-gap" | "snapshot-invalid" | "commit-and-touch" | "loc-churn" | "snapshot-age";
  coverage?: Coverage;
  drift?: Drift | { stale: true };
}

export function git(root: string, args: readonly string[]): Promise<string> {
  const { promise, resolve: done, reject } = Promise.withResolvers<string>();
  execFile(
    "git",
    [...args],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => {
      if (error) reject(error);
      else done(stdout);
    },
  );
  return promise;
}

export async function gitRepository(cwd: string): Promise<GitRepository | null> {
  let root: string;
  try {
    root = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return null;
  }
  const [common, head] = await Promise.all([git(root, ["rev-parse", "--git-common-dir"]), git(root, ["rev-parse", "HEAD"])]);
  return { root, commonDir: await realpath(resolve(root, common.trim())), head: head.trim() };
}

/** Binary numstat entries and NUL-delimited rename source/destination records are not LOC. */
export function parseChurn(output: string): number {
  const tokens = output.split("\0");
  let churn = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry) continue;
    const first = entry.indexOf("\t");
    const second = entry.indexOf("\t", first + 1);
    const added = entry.slice(0, first);
    const deleted = entry.slice(first + 1, second);
    if (second === entry.length - 1) index += 2;
    if (added !== "-" && deleted !== "-") churn += Number(added) + Number(deleted);
  }
  return churn;
}

export function driftProposal(drift: Drift): AdvisorProposal | null {
  if (drift.commitsSince >= 30 && drift.touchedRatio >= 0.15) return { trigger: "commit-and-touch", drift };
  if (drift.churnLocRatio >= 0.25) return { trigger: "loc-churn", drift };
  if (drift.daysSince >= 90) return { trigger: "snapshot-age", drift };
  return null;
}

export interface ProjectMetrics {
  tracked: string[];
  loc: number;
  coverage: () => Promise<Coverage | null>;
}

export async function projectMetrics(root: string): Promise<ProjectMetrics> {
  const tracked = (await git(root, ["ls-files", "-z"])).split("\0").filter(Boolean);
  const cache = new Map<string, Promise<string>>();
  const content = (path: string): Promise<string> => {
    let pending = cache.get(path);
    if (!pending) {
      pending = (async () => {
        try {
          if (!(await lstat(path)).isFile()) return "";
          return await readFile(path, "utf8");
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
          throw error;
        }
      })();
      cache.set(path, pending);
    }
    return pending;
  };
  let loc = 0;
  for (const file of tracked) {
    if (!Object.hasOwn(SOURCE_EXTENSIONS, extname(file))) continue;
    for (const char of await content(join(root, file))) if (char === "\n") loc += 1;
  }
  const coverage = async (): Promise<Coverage | null> => {
    let candidateDirs = 0;
    let coveredDirs = 0;
    const covered = new Map<string, boolean>();
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      let hasGuide = false;
      try {
        hasGuide = (await lstat(join(dir, "AGENTS.md"))).isFile();
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      hasGuide ||= covered.get(dirname(dir)) ?? false;
      covered.set(dir, hasGuide);
      if (depth >= 1) {
        const sources = entries.filter(
          (entry) => entry.isFile() && !entry.isSymbolicLink() && Object.hasOwn(SOURCE_EXTENSIONS, extname(entry.name)),
        );
        let directLoc = 0;
        for (const entry of sources) directLoc += (await content(join(dir, entry.name))).split("\n").length;
        if (sources.length >= 8 || directLoc >= 500) {
          candidateDirs += 1;
          if (hasGuide) coveredDirs += 1;
        }
      }
      if (depth < 3) {
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && !Object.hasOwn(EXCLUDED_DIRS, entry.name))
            await walk(join(dir, entry.name), depth + 1);
        }
      }
    };
    await walk(root, 0);
    return candidateDirs ? { candidateDirs, coveredDirs, missingRatio: 1 - coveredDirs / candidateDirs } : null;
  };
  return { tracked, loc, coverage };
}

export async function computeProposal(
  repo: GitRepository,
  snapshot: SnapshotFields | "invalid" | null,
  metrics: ProjectMetrics,
  now = Date.now(),
): Promise<AdvisorProposal | null> {
  if (snapshot === null) {
    const coverage = await metrics.coverage();
    return coverage && coverage.missingRatio >= 0.5 ? { trigger: "coverage-gap", coverage } : null;
  }
  if (snapshot === "invalid") return { trigger: "snapshot-invalid", drift: { stale: true } };
  try {
    if ((await git(repo.root, ["cat-file", "-t", snapshot.commitSha])).trim() !== "commit") {
      return { trigger: "snapshot-invalid", drift: { stale: true } };
    }
  } catch {
    return { trigger: "snapshot-invalid", drift: { stale: true } };
  }
  const [commits, touched, numstat] = await Promise.all([
    git(repo.root, ["rev-list", "--count", `${snapshot.commitSha}..HEAD`]),
    git(repo.root, ["diff", "--name-only", "-z", "--find-renames", snapshot.commitSha, "HEAD", "--", ".", ...DRIFT_EXCLUDES]),
    git(repo.root, ["diff", "--numstat", "-z", "--find-renames", snapshot.commitSha, "HEAD", "--", ".", ...DRIFT_EXCLUDES]),
  ]);
  return driftProposal({
    commitsSince: Number(commits.trim()),
    touchedRatio: touched.split("\0").filter(Boolean).length / Math.max(metrics.tracked.length, 1),
    churnLocRatio: parseChurn(numstat) / Math.max(metrics.loc, 1),
    daysSince: (now - snapshot.timestamp) / MS_PER_DAY,
  });
}
