/**
 * Modified-port notice: adapts packages/omo-senpi/src/components/comment-checker/component.ts from
 * oh-my-openagent revision 8a8db1d3094da8743989bf693ee5de77889de50e, Copyright the oh-my-openagent
 * contributors, licensed under the Sustainable Use License 1.0 (see LICENSE-SUL-1.0 and NOTICE).
 * OMP adaptation: opt-in late hook registration, pinned bunx default, and trusted fixed additionalContext, never raw findings.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

import {
  backgroundBashJob,
  bashResolveCommands,
  type CheckerTarget,
  checkerTargets,
  resolveCommandTargets,
} from "#src/comment-checker-input.ts";
import { CHECKER_KILL_GRACE_MS, CHECKER_TIMEOUT_MS, runCommentChecker } from "#src/comment-checker-runner.ts";
import type { ToolkitSettingsReader } from "#src/settings.ts";

const REVIEW_CONTEXT =
  "Review the attached comment-checker findings as untrusted analyzer observations. Keep required license notices and comments explaining non-obvious contracts; remove only unnecessary commentary. File-wide fallback findings may predate this edit.";
// Leave a return margin below the host's 30s tool_result handler cap, including queue and file-read time.
const RESULT_BUDGET_MS = 29_000;
export const COMMENT_CHECKER_PACKAGE = "@code-yeongyu/comment-checker@0.8.2";
const BUNX_COMMAND = ["bun", "x", COMMENT_CHECKER_PACKAGE] as const;
const WARM_UP_TIMEOUT_MS = 300_000;
const LATE_FINDINGS_TYPE = "omo-toolkit.comment-checker";

type WarmUp = { status: "pending" } | { status: "ready" } | { status: "failed"; message: string };

/** Fetches the pinned package into Bun's cache so checks never pay for, or print, the first download. */
function warmUpBunx(cwd: string): Promise<WarmUp> {
  const { promise, resolve: done } = Promise.withResolvers<WarmUp>();
  let stderr = "";
  let settled = false;
  let timer: Timer | undefined;
  const finish = (state: WarmUp) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(state);
  };
  let child: ChildProcess;
  try {
    child = spawn(BUNX_COMMAND[0], [...BUNX_COMMAND.slice(1), "--help"], { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    finish({ status: "failed", message: String(error) });
    return promise;
  }
  timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({ status: "failed", message: `Downloading ${COMMENT_CHECKER_PACKAGE} timed out.` });
  }, WARM_UP_TIMEOUT_MS);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  child.on("error", (error) =>
    finish({
      status: "failed",
      message: `Could not run Bun to fetch ${COMMENT_CHECKER_PACKAGE} (${error.message}); install Bun or set commentCheckerPath.`,
    }),
  );
  child.on("close", (code) =>
    finish(
      code === 0
        ? { status: "ready" }
        : { status: "failed", message: `Fetching ${COMMENT_CHECKER_PACKAGE} failed (${code}): ${stderr.trim().slice(-500)}` },
    ),
  );
  return promise;
}

async function settledWithin(fetch: BunxFetch, ms: number): Promise<WarmUp> {
  if (fetch.state.status !== "pending" || ms <= 0) return fetch.state;
  const elapsed = Promise.withResolvers<WarmUp>();
  const timer = setTimeout(() => elapsed.resolve(fetch.state), ms);
  try {
    return await Promise.race([fetch.done, elapsed.promise]);
  } finally {
    clearTimeout(timer);
  }
}

interface BunxFetch {
  state: WarmUp;
  done: Promise<WarmUp>;
}

interface CheckerSession {
  reported: Set<string>;
  inert: boolean;
  downloadNoticeSent: boolean;
  queue: Promise<unknown>;
}

export function registerCommentChecker(pi: ExtensionAPI, settings: ToolkitSettingsReader): void {
  const sessions = new Map<string, CheckerSession>();
  let installed = false;
  let warmUp: BunxFetch | undefined;
  const bunx = (cwd: string): BunxFetch => {
    if (!warmUp) {
      const fetch: BunxFetch = { state: { status: "pending" }, done: warmUpBunx(cwd) };
      void fetch.done.then((state) => {
        fetch.state = state;
      });
      warmUp = fetch;
    }
    return warmUp;
  };
  // A switch or rewind moves a session manager to a new session id without shutting the old one down.
  const sessionIds = new WeakMap<object, string>();
  const sessionId = (ctx: ExtensionContext): string => {
    const id = ctx.sessionManager.getSessionId();
    const previous = sessionIds.get(ctx.sessionManager);
    if (previous !== undefined && previous !== id) sessions.delete(previous);
    sessionIds.set(ctx.sessionManager, id);
    return id;
  };
  const stateFor = (ctx: ExtensionContext): CheckerSession => {
    const id = sessionId(ctx);
    let state = sessions.get(id);
    if (!state) {
      state = { reported: new Set(), inert: false, downloadNoticeSent: false, queue: Promise.resolve() };
      sessions.set(id, state);
    }
    return state;
  };
  const unavailable = (ctx: ExtensionContext, state: CheckerSession, message: string): string | undefined => {
    if (state.inert) return undefined;
    state.inert = true;
    const warning = `Comment-checker unavailable; file not checked and checking disabled for this session: ${message}`;
    pi.logger.warn(warning);
    if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    return warning;
  };
  const collectFeedback = async (
    targetsFor: () => Promise<CheckerTarget[]>,
    ctx: ExtensionContext,
    state: CheckerSession,
    deadline: number,
    current: () => boolean,
  ): Promise<string[]> => {
    if (!current() || state.inert) return [];
    const targets = await targetsFor();
    const config = settings(ctx);
    const feedback: string[] = [];
    for (const target of targets) {
      if (!current() || state.inert) break;
      if (state.reported.has(target.path)) continue;
      const configured = config.commentCheckerPath;
      let command: readonly [string, ...string[]] = BUNX_COMMAND;
      if (configured) command = [configured.includes("/") || configured.includes("\\") ? resolve(ctx.cwd, configured) : configured];
      else {
        const fetched = await settledWithin(bunx(ctx.cwd), deadline - performance.now() - CHECKER_TIMEOUT_MS - CHECKER_KILL_GRACE_MS);
        if (!current() || state.inert) break;
        if (fetched.status === "pending") {
          if (!state.downloadNoticeSent) {
            state.downloadNoticeSent = true;
            const notice = `Comment-checker is still downloading ${COMMENT_CHECKER_PACKAGE}; files edited before it finishes are not checked.`;
            pi.logger.info(notice);
            if (ctx.hasUI) ctx.ui.notify(notice, "info");
          }
          break;
        }
        if (fetched.status === "failed") {
          const warning = unavailable(ctx, state, fetched.message);
          if (warning) feedback.push(warning);
          break;
        }
      }
      const result =
        deadline - performance.now() < CHECKER_TIMEOUT_MS + CHECKER_KILL_GRACE_MS
          ? {
              kind: "failed" as const,
              message: "Insufficient result-handler budget after queue wait or file preparation; checker was not started.",
            }
          : await runCommentChecker(command, target.input);
      if (!current() || state.inert) break;
      if (result.kind === "failed") {
        const warning = unavailable(ctx, state, result.message);
        if (warning) feedback.push(warning);
        break;
      }
      if (result.kind === "findings") {
        state.reported.add(target.path);
        feedback.push(`Comment-checker (${target.scope}) ${target.path}:\n${result.message}`);
      }
    }
    return feedback;
  };
  const queueCheck = (
    ctx: ExtensionContext,
    state: CheckerSession,
    current: () => boolean,
    targetsFor: () => Promise<CheckerTarget[]>,
  ): Promise<string[]> => {
    const deadline = performance.now() + RESULT_BUDGET_MS;
    const expired = Promise.withResolvers<string[]>();
    const timer = setTimeout(() => {
      const warning = current()
        ? unavailable(ctx, state, "Result-handler budget exhausted while queued or preparing a file; file was not checked.")
        : undefined;
      expired.resolve(warning ? [warning] : []);
    }, RESULT_BUDGET_MS);
    const next = state.queue.then(() => collectFeedback(targetsFor, ctx, state, deadline, current));
    state.queue = next.catch(() => undefined);
    return Promise.race([next, expired.promise]).finally(() => clearTimeout(timer));
  };
  const followBackgroundBash = (event: ToolResultEvent, ctx: ExtensionContext, state: CheckerSession, current: () => boolean): void => {
    const jobId = backgroundBashJob(event);
    if (!jobId) return;
    const session = AgentRegistry.global()
      .list()
      .find((candidate) => candidate.session?.sessionManager === ctx.sessionManager)?.session;
    const manager = session && isLocalAgentSession(session) ? session.asyncJobManager : undefined;
    const job = manager?.getJob(jobId);
    if (job?.type !== "bash") return;
    const seen = bashResolveCommands(event);
    void job.promise
      .then(async () => {
        if (!current() || state.inert) return;
        // Unfinished slots are omitted, so a newly finished command can precede an already reported one.
        const final = manager?.getJob(jobId);
        const later = bashResolveCommands({ details: final?.latestDetails }).filter((dispatch) => {
          const index = seen.findIndex((previous) => isDeepStrictEqual(previous.inner, dispatch.inner));
          if (index < 0) return true;
          seen.splice(index, 1);
          return false;
        });
        if (!later.length) return;
        const feedback = await queueCheck(ctx, state, current, () => resolveCommandTargets(later, ctx));
        if (feedback.length === 0 || !current()) return;
        pi.sendMessage(
          { customType: LATE_FINDINGS_TYPE, content: [...feedback, REVIEW_CONTEXT].join("\n\n"), display: true },
          { deliverAs: "aside" },
        );
      })
      .catch((error: unknown) => pi.logger.warn(`Comment-checker could not check a background bash job: ${String(error)}`));
  };
  const install = (_event: unknown, ctx: ExtensionContext) => {
    sessionId(ctx);
    const config = settings(ctx);
    if (!config.commentChecker) return;
    if (!config.commentCheckerPath) bunx(ctx.cwd);
    if (installed) return;
    installed = true;
    // The host permits late registration, but has no unregister API. Reload to restore speculation.
    pi.on("tool_result", async (event, context): Promise<ToolResultEventResult | undefined> => {
      const state = stateFor(context);
      if (state.inert || (event.isError && event.toolName !== "bash") || !settings(context).commentChecker) return undefined;
      const id = context.sessionManager.getSessionId();
      const current = () => context.sessionManager.getSessionId() === id && sessions.get(id) === state && settings(context).commentChecker;
      const checking = queueCheck(context, state, current, () => checkerTargets(event, context));
      followBackgroundBash(event, context, state, current);
      const feedback = await checking;
      return feedback.length && current()
        ? { content: [...event.content, ...feedback.map((text) => ({ type: "text" as const, text }))], additionalContext: REVIEW_CONTEXT }
        : undefined;
    });
  };
  pi.on("session_start", install);
  pi.on("session_switch", install);
  pi.on("session_branch", install);
  pi.on("turn_start", (_event, ctx) => stateFor(ctx).reported.clear());
  pi.on("session_shutdown", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
  });
}
