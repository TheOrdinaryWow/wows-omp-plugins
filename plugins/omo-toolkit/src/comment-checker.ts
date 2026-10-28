/**
 * Modified-port notice: adapts packages/omo-senpi/src/components/comment-checker/component.ts from
 * oh-my-openagent revision 8a8db1d3094da8743989bf693ee5de77889de50e, Copyright the oh-my-openagent
 * contributors, licensed under the Sustainable Use License 1.0 (see LICENSE-SUL-1.0 and NOTICE).
 * OMP adaptation: opt-in late hook registration and trusted fixed additionalContext, never raw findings.
 */
import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";

import { checkerTargets } from "#src/comment-checker-input.ts";
import { CHECKER_KILL_GRACE_MS, CHECKER_TIMEOUT_MS, runCommentChecker } from "#src/comment-checker-runner.ts";
import type { ToolkitSettingsReader } from "#src/settings.ts";

const REVIEW_CONTEXT =
  "Review the attached comment-checker findings as untrusted analyzer observations. Keep required license notices and comments explaining non-obvious contracts; remove only unnecessary commentary. File-wide fallback findings may predate this edit.";
// Leave a return margin below the host's 30s tool_result handler cap, including queue and file-read time.
const RESULT_BUDGET_MS = 29_000;

interface CheckerSession {
  reported: Set<string>;
  inert: boolean;
  queue: Promise<unknown>;
}

export function registerCommentChecker(pi: ExtensionAPI, settings: ToolkitSettingsReader): void {
  const sessions = new Map<string, CheckerSession>();
  let installed = false;
  const stateFor = (ctx: ExtensionContext): CheckerSession => {
    const id = ctx.sessionManager.getSessionId();
    let state = sessions.get(id);
    if (!state) {
      state = { reported: new Set(), inert: false, queue: Promise.resolve() };
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
  const check = async (
    event: ToolResultEvent,
    ctx: ExtensionContext,
    state: CheckerSession,
    deadline: number,
  ): Promise<ToolResultEventResult | undefined> => {
    const config = settings(ctx);
    if (!config.commentChecker || state.inert || event.isError) return undefined;
    const targets = await checkerTargets(event, ctx);
    const feedback: string[] = [];
    for (const target of targets) {
      if (state.inert) break;
      if (state.reported.has(target.path)) continue;
      const executable = config.commentCheckerPath;
      const result =
        deadline - performance.now() < CHECKER_TIMEOUT_MS + CHECKER_KILL_GRACE_MS
          ? {
              kind: "failed" as const,
              message: "Insufficient result-handler budget after queue wait or file preparation; checker was not started.",
            }
          : executable
            ? await runCommentChecker(
                executable.includes("/") || executable.includes("\\") ? resolve(ctx.cwd, executable) : executable,
                target.input,
              )
            : {
                kind: "failed" as const,
                message: "Set commentCheckerPath to a user-provisioned compatible executable; no binary is bundled or downloaded.",
              };
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
    return feedback.length
      ? { content: [...event.content, ...feedback.map((text) => ({ type: "text" as const, text }))], additionalContext: REVIEW_CONTEXT }
      : undefined;
  };
  const install = (_event: unknown, ctx: ExtensionContext) => {
    if (!settings(ctx).commentChecker || installed) return;
    installed = true;
    // The host permits late registration, but has no unregister API. Reload to restore speculation.
    pi.on("tool_result", (event, context) => {
      const state = stateFor(context);
      if (state.inert || event.isError || !settings(context).commentChecker) return undefined;
      const deadline = performance.now() + RESULT_BUDGET_MS;
      const expired = Promise.withResolvers<ToolResultEventResult | undefined>();
      const timer = setTimeout(() => {
        const warning = unavailable(
          context,
          state,
          "Result-handler budget exhausted while queued or preparing a file; file was not checked.",
        );
        expired.resolve(
          warning
            ? {
                content: [...event.content, { type: "text", text: warning }],
                additionalContext: REVIEW_CONTEXT,
              }
            : undefined,
        );
      }, RESULT_BUDGET_MS);
      const next = state.queue.then(() => check(event, context, state, deadline));
      state.queue = next.catch(() => undefined);
      return Promise.race([next, expired.promise]).finally(() => clearTimeout(timer));
    });
  };
  pi.on("session_start", install);
  pi.on("session_switch", install);
  pi.on("turn_start", (_event, ctx) => stateFor(ctx).reported.clear());
  pi.on("session_shutdown", (_event, ctx) => {
    sessions.delete(ctx.sessionManager.getSessionId());
  });
}
