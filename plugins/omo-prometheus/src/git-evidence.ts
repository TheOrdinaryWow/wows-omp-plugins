/** Read-only Git evidence for the F1 compliance gate. Every failure degrades to a plain "unavailable" note. */
import { type ChildProcess, spawn } from "node:child_process";

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SECTION_LINES = 200;
const SECTION_BYTES = 16 * 1024;
const TIMEOUT_MS = 5_000;

interface GitRun {
  ok: boolean;
  stdout: string;
  /** Output exceeded the section byte cap and the process was stopped early. */
  truncated: boolean;
  error?: string;
}

function runGit(cwd: string, args: readonly string[], timeoutMs = TIMEOUT_MS): Promise<GitRun> {
  const { promise, resolve } = Promise.withResolvers<GitRun>();
  let child: ChildProcess;
  try {
    child = spawn("git", ["-C", cwd, "-c", "core.quotepath=off", "-c", "color.ui=never", ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    resolve({ ok: false, stdout: "", truncated: false, error: error instanceof Error ? error.message : String(error) });
    return promise;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let timedOut = false;
  let stderr = "";
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.stdout?.on("data", (chunk: Buffer) => {
    if (truncated) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size > SECTION_BYTES) {
      truncated = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 2_000) stderr += chunk.toString("utf8");
  });
  // A promise settles once, so a late "close" after "error" is harmless.
  child.on("error", (error) => {
    clearTimeout(timer);
    resolve({ ok: false, stdout: "", truncated: false, error: error.message });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    const stdout = Buffer.concat(chunks).toString("utf8");
    if (truncated) resolve({ ok: true, stdout, truncated: true });
    else if (timedOut) resolve({ ok: false, stdout, truncated: false, error: `timed out after ${timeoutMs / 1000}s` });
    else if (code !== 0) resolve({ ok: false, stdout, truncated: false, error: stderr.trim().split("\n")[0] || `exit code ${code}` });
    else resolve({ ok: true, stdout, truncated: false });
  });
  return promise;
}

/** `HEAD` of the workspace, or undefined when it is not a Git work tree, has no commits, or Git is unavailable. */
export async function gitHead(cwd: string): Promise<string | undefined> {
  const run = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], 3_000);
  const sha = run.stdout.trim();
  return run.ok && GIT_SHA.test(sha) ? sha : undefined;
}

function section(command: string, run: GitRun): string {
  if (!run.ok) return `$ ${command}\n(unavailable: ${run.error ?? "unknown error"})`;
  let lines = run.stdout.replace(/\n$/, "").split("\n");
  let truncated = run.truncated;
  if (lines.length > SECTION_LINES) {
    lines = lines.slice(0, SECTION_LINES);
    truncated = true;
  }
  let body = lines.join("\n");
  if (Buffer.byteLength(body) > SECTION_BYTES) {
    body = Buffer.from(body).subarray(0, SECTION_BYTES).toString("utf8");
    body = body.slice(0, Math.max(0, body.lastIndexOf("\n")));
    truncated = true;
  } else if (truncated && run.truncated) {
    // The process was stopped mid-stream; drop the partial last line.
    body = body.slice(0, Math.max(0, body.lastIndexOf("\n")));
  }
  const note = truncated ? `\n[truncated: output exceeds ${SECTION_LINES} lines or ${SECTION_BYTES / 1024} KB]` : "";
  return `$ ${command}\n${body || "(empty)"}${note}`;
}

export interface ComplianceEvidence {
  cwd: string;
  /** Commit the diff and log are measured from. */
  baseline?: string;
  /** `recorded`: HEAD stored at approval; `derived`: last commit before execution started; `none`: no usable baseline. */
  baselineSource: "recorded" | "derived" | "none";
  text: string;
}

/**
 * Collect `git diff --stat`, `git log --oneline`, and `git status --short` for the F1 gate.
 * `since` (ms) dates the derived baseline when the ledger recorded none. Never rejects: Git failures are reported in the text.
 */
export async function collectComplianceEvidence(options: { cwd: string; baseline?: string; since: number }): Promise<ComplianceEvidence> {
  const { cwd } = options;
  const header = `F1 compliance evidence, collected read-only by the plugin in ${cwd}. Pass this block to the F1 child verbatim as \`diff_stat\`.`;
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      cwd,
      baselineSource: "none",
      text: `${header}\nGit evidence unavailable: the plan workspace is not a Git work tree (${inside.error ?? inside.stdout.trim()}). There is no diff_stat; F1 must not invent one.`,
    };
  }
  const notes: string[] = [];
  let baseline: string | undefined;
  let baselineSource: ComplianceEvidence["baselineSource"] = "none";
  if (options.baseline) {
    if ((await runGit(cwd, ["cat-file", "-e", `${options.baseline}^{commit}`])).ok) {
      baseline = options.baseline;
      baselineSource = "recorded";
      notes.push(`Baseline: ${baseline} (HEAD recorded when the plan was approved).`);
    } else {
      notes.push(`The recorded baseline ${options.baseline} is no longer in this repository.`);
    }
  }
  if (!baseline) {
    const before = new Date(options.since).toISOString();
    const derived = await runGit(cwd, ["rev-list", "-1", `--before=@${Math.floor(options.since / 1000)}`, "HEAD"]);
    const sha = derived.stdout.trim();
    if (derived.ok && GIT_SHA.test(sha)) {
      baseline = sha;
      baselineSource = "derived";
      notes.push(
        `Baseline: ${sha} (derived from timestamps: the last commit on HEAD dated before ${before}, when execution started; the ledger recorded no baseline).`,
      );
    } else {
      notes.push(`No Git baseline: HEAD has no commit dated before ${before}, when execution started, so no diff or log can be measured.`);
    }
  }
  const sections: string[] = [];
  if (baseline) {
    sections.push(section(`git diff --stat ${baseline}`, await runGit(cwd, ["diff", "--no-color", "--stat", baseline, "--"])));
    sections.push(
      section(`git log --oneline ${baseline}..HEAD`, await runGit(cwd, ["log", "--no-color", "--oneline", `${baseline}..HEAD`, "--"])),
    );
  }
  sections.push(section("git status --short", await runGit(cwd, ["status", "--short"])));
  const scope = baseline
    ? "The diff covers committed and uncommitted tracked changes since the baseline; status lists untracked files."
    : "";
  return {
    cwd,
    baseline,
    baselineSource,
    text: [header, ...notes, scope, ...sections].filter(Boolean).join("\n\n"),
  };
}
