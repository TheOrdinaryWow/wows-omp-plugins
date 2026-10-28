/**
 * Modified-port notice: adapts comment-checker-core/src/{runner,stdin-delivery,types}.ts from
 * oh-my-openagent revision 8a8db1d3094da8743989bf693ee5de77889de50e, Copyright the oh-my-openagent
 * contributors, licensed under the Sustainable Use License 1.0 (see LICENSE-SUL-1.0 and NOTICE).
 * OMP adaptation: externally supplied executable only, bounded output, and explicit not-checked failures.
 */
import { type ChildProcess, spawn } from "node:child_process";

export interface CheckerInput {
  session_id: string;
  tool_name: "edit" | "write";
  transcript_path: string;
  cwd: string;
  hook_event_name: "PostToolUse";
  tool_input: { file_path: string; content?: string; old_string?: string; new_string?: string };
}

export type CheckerResult = { kind: "clean" } | { kind: "findings"; message: string } | { kind: "failed"; message: string };

export const CHECKER_TIMEOUT_MS = 20_000;
export const CHECKER_KILL_GRACE_MS = 1_000;

/** The native 0.8.0 protocol: `check`, JSON stdin, exit 0 clean or exit 2 with findings on stderr. */
export function runCommentChecker(
  executable: string,
  input: CheckerInput,
  options: { timeoutMs?: number; killGraceMs?: number } = {},
): Promise<CheckerResult> {
  const { promise, resolve } = Promise.withResolvers<CheckerResult>();
  let child: ChildProcess;
  try {
    child = spawn(executable, ["check"], { cwd: input.cwd, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  } catch (error) {
    resolve({ kind: "failed", message: String(error) });
    return promise;
  }
  let stderr = "";
  let truncated = false;
  let delivered = false;
  let deliveryError: string | undefined;
  let timedOut = false;
  let killTimer: Timer | undefined;
  let settled = false;
  const finish = (result: CheckerResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    resolve(result);
  };
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      child.kill(signal);
    } catch {
      // Exit/error handlers own the outcome if the process has already disappeared.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), options.killGraceMs ?? CHECKER_KILL_GRACE_MS);
  }, options.timeoutMs ?? CHECKER_TIMEOUT_MS);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const remaining = 16_384 - stderr.length;
    if (chunk.length > remaining) truncated = true;
    if (remaining > 0) stderr += chunk.slice(0, remaining);
  });
  child.on("error", (error) => finish({ kind: "failed", message: error.message }));
  child.on("close", (code, signal) => {
    if (timedOut) finish({ kind: "failed", message: "Checker timed out; file was not checked." });
    else if (!delivered || deliveryError) {
      finish({ kind: "failed", message: `Checker input was not delivered: ${deliveryError ?? "stdin closed early"}` });
    } else if (code === 0) finish({ kind: "clean" });
    else if (code === 2 && stderr.trim()) {
      finish({ kind: "findings", message: `${stderr.replace(/\r\n/g, "\n").trim()}${truncated ? "\n[checker output truncated]" : ""}` });
    } else {
      finish({ kind: "failed", message: `Checker exited outside the 0/2 protocol (${code ?? signal}): ${stderr.trim().slice(0, 500)}` });
    }
  });
  // Keep this error listener for the stream's lifetime: EPIPE may arrive after end's callback.
  child.stdin?.on("error", (error: Error) => {
    deliveryError = error.message;
    kill("SIGKILL");
  });
  try {
    child.stdin?.end(JSON.stringify(input), (error?: Error | null) => {
      if (error) {
        deliveryError = error.message;
        kill("SIGKILL");
      } else delivered = true;
    });
  } catch (error) {
    deliveryError = String(error);
    kill("SIGKILL");
  }
  return promise;
}
