import { vcsGitRepoInfo } from "#src/host.ts";

export interface GitRepo {
  repoRoot: string;
  commonDir: string;
}

export function discoverRepo(path: string): GitRepo | null {
  const info = vcsGitRepoInfo(path);
  return info ? { repoRoot: info.repoRoot, commonDir: info.commonDir } : null;
}
