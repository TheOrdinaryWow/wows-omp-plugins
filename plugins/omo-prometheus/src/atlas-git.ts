import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export type AtlasGitAction = "status" | "diff" | "log" | "show" | "commit";

export interface AtlasGitParams {
  action: AtlasGitAction;
  /** `diff`: a revision or `A..B` range; `log`: a revision range; `show`: the revision to show. */
  revision?: string;
  /** Limits `diff` and `log`; for `commit`, the exact files to commit. */
  paths?: string[];
  /** `diff`: compare the index with HEAD instead of the worktree with the index. */
  staged?: boolean;
  /** `diff` and `show`: a diffstat instead of the patch. */
  stat?: boolean;
  /** `log`: how many commits, 1–200. */
  count?: number;
  /** `commit`: the full commit message. */
  message?: string;
}

export interface AtlasGitResult {
  ok: boolean;
  text: string;
}

const OUTPUT_LIMIT = 60_000;
const REVISION = /^[A-Za-z0-9_./@^~{}+:-]+$/;

/**
 * Pinned options for every invocation: no pager, colour, external diff driver, textconv filter, or fsmonitor hook
 * can run, so inspection never executes repository-configured programs. Commit hooks still run, as they would for
 * any commit in this repository.
 */
const BASE = ["--no-pager", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", "diff.external="];
const DIFF_SAFETY = ["--no-ext-diff", "--no-textconv"];

/** Validates the call and returns the git argument lists to run in order, or a refusal. */
export function atlasGitCommands(params: AtlasGitParams): string[][] | string {
  const revision = params.revision?.trim();
  if (revision !== undefined && revision !== "" && (!REVISION.test(revision) || revision.startsWith("-"))) {
    return `"${revision}" is not a plain revision or range`;
  }
  const paths = (params.paths ?? []).map((path) => path.trim());
  if (paths.some((path) => path === "")) return "paths must not be empty strings";
  const rev = revision ? ["--end-of-options", revision] : ["--end-of-options"];
  switch (params.action) {
    case "status":
      return [["status", "--short", "--branch", "--untracked-files=all"]];
    case "diff":
      return [["diff", ...DIFF_SAFETY, ...(params.staged ? ["--cached"] : []), ...(params.stat ? ["--stat"] : []), ...rev, "--", ...paths]];
    case "log": {
      const count = params.count ?? 20;
      if (!Number.isInteger(count) || count < 1 || count > 200) return "count must be a whole number from 1 to 200";
      return [["log", `--max-count=${count}`, "--format=%h %ad %an%d %s", "--date=short", ...rev, "--", ...paths]];
    }
    case "show":
      if (!revision) return "show needs a revision";
      return [["show", ...DIFF_SAFETY, "--format=fuller", ...(params.stat ? ["--stat"] : []), ...rev]];
    case "commit": {
      const message = params.message?.trim();
      if (!message) return "commit needs a message";
      if (paths.length === 0) return "commit needs the exact files to commit in paths";
      if (revision) return "commit takes no revision";
      // Literal pathspecs keep `*`, `:/` and other pathspec magic from widening the commit beyond the named files.
      const literal = ["--literal-pathspecs"];
      return [
        [...literal, "add", "--all", "--", ...paths],
        [...literal, "commit", "--message", message, "--", ...paths],
        ["log", "--max-count=1", "--stat", "--format=%H%n%s"],
      ];
    }
  }
}

async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["git", ...BASE, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal,
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_EXTERNAL_DIFF: "" },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n") };
}

/** Runs one Atlas git action in `cwd`. Commit refuses directories so every committed file is named. */
export async function runAtlasGit(cwd: string, params: AtlasGitParams, signal?: AbortSignal): Promise<AtlasGitResult> {
  const commands = atlasGitCommands(params);
  if (typeof commands === "string") return { ok: false, text: commands };
  if (params.action === "commit") {
    for (const path of params.paths ?? []) {
      const target = await stat(resolve(cwd, path.trim())).catch(() => undefined);
      if (target?.isDirectory()) return { ok: false, text: `${path} is a directory; name each file to commit` };
    }
  }
  const outputs: string[] = [];
  for (const [index, args] of commands.entries()) {
    const { code, output } = await runGit(cwd, args, signal);
    if (output) outputs.push(output);
    if (code !== 0) {
      const staged = params.action === "commit" && index === 1 ? "\nThe named files stay staged; nothing was committed." : "";
      return { ok: false, text: `${truncate(outputs.join("\n"))}\ngit ${args.join(" ")} exited with ${code}.${staged}` };
    }
  }
  return { ok: true, text: truncate(outputs.join("\n")) || "(no output)" };
}

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n… truncated ${text.length - OUTPUT_LIMIT} characters; narrow the paths or use stat.`
    : text;
}
