import { vcsGitRepoInfo } from "#src/host.ts";

export interface GitRepo {
  repoRoot: string;
  commonDir: string;
}

export function discoverRepo(path: string): GitRepo | null {
  const info = vcsGitRepoInfo(path);
  return info ? { repoRoot: info.repoRoot, commonDir: info.commonDir } : null;
}

/** A repository-relative file at HEAD; absent for an unborn HEAD or an untracked file. */
export function committedFile(repoRoot: string, path: string): string | undefined {
  const result = Bun.spawnSync(
    ["git", "--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "cat-file", "blob", `HEAD:${path}`],
    { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}
