/**
 * Modified-port notice: adapts packages/omo-senpi/src/components/init-deep-advisor/{component,runtime}.ts
 * from oh-my-openagent revision 8a8db1d3094da8743989bf693ee5de77889de50e, Copyright the
 * oh-my-openagent contributors, licensed under the Sustainable Use License 1.0 (see LICENSE-SUL-1.0 and NOTICE).
 * OMP adaptation: native selectors, consent-only follow-up, and a deterministic snapshot-record tool.
 */
import { join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";

import {
  COOLDOWN_MS,
  computeProposal,
  type GitRepository,
  git,
  gitRepository,
  projectMetrics,
  type SnapshotFields,
} from "#src/init-deep-metrics.ts";
import { advisorPaths, readAdvisorState, readGlobalState, readSnapshot, updateAdvisorState, writeState } from "#src/init-deep-state.ts";
import type { ToolkitSettingsReader } from "#src/settings.ts";

const CHOICES = ["Run now", "Skip this time", "Never in this project", "Never anywhere"];
const USAGE = "Usage: /init-deep-advisor status|run|skip|never-project|never-global|reset-project|reset-global";

function notice(pi: ExtensionAPI, ctx: ExtensionContext, message: string, error = false): void {
  if (ctx.hasUI) ctx.ui.notify(message, error ? "warning" : "info");
  else pi.sendMessage({ customType: "omo-toolkit.init-deep-advisor.notice", content: message, display: true, attribution: "agent" });
}

async function queueSkill(pi: ExtensionAPI, repo: GitRepository, proposal: object, current: () => boolean): Promise<void> {
  let suggestedMode: "local" | "committed" = "local";
  try {
    await git(repo.root, ["ls-files", "--error-unmatch", "AGENTS.md"]);
    suggestedMode = "committed";
  } catch {
    // The user still chooses delivery mode inside the skill; this is only a suggestion.
  }
  if (!current()) return;
  pi.appendEntry("omo-toolkit.init-deep-advisor.proposed", {
    version: 1,
    root: repo.root,
    commonDir: repo.commonDir,
    ...proposal,
    suggestedMode,
  });
  pi.sendMessage(
    {
      customType: "omo-toolkit.init-deep-advisor.run",
      content:
        "Read skill://init-deep with the read tool and follow it for the current repository. The user approved starting the skill, not a delivery mode or a commit, push, or merge. Ask for the skill's delivery choice as required.",
      display: false,
      attribution: "agent",
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

export function registerInitDeepAdvisor(pi: ExtensionAPI, settings: ToolkitSettingsReader): void {
  let generation = 0;
  let timer: Timer | undefined;
  let timerContext: ExtensionContext | undefined;
  let pending: AbortController | undefined;
  const cancel = () => {
    generation += 1;
    if (timer !== undefined && timerContext) timerContext.clearTimer(timer);
    timer = undefined;
    timerContext = undefined;
    pending?.abort();
    pending = undefined;
  };
  const propose = async (ctx: ExtensionContext, expected: number): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    const current = () => expected === generation && ctx.sessionManager.getSessionId() === sessionId && ctx.cwd === cwd;
    try {
      const global = await readGlobalState(join(getAgentDir(), "omo-toolkit", "init-deep-advisor.json"));
      if (global.declined || !current()) return;
      const repo = await gitRepository(cwd);
      if (!repo || !current()) return;
      const paths = advisorPaths(repo);
      const state = await readAdvisorState(paths.project);
      if (state.declined || Date.now() < state.cooldownUntil || state.lastProposedHead === repo.head || !current()) return;
      const snapshot = await readSnapshot(paths.snapshot);
      const proposal = await computeProposal(repo, snapshot, await projectMetrics(repo.root));
      if (!proposal || !current()) return;
      const identity = await gitRepository(ctx.cwd);
      if (identity?.root !== repo.root || identity.head !== repo.head || !current()) return;
      // Reload declines immediately before publishing; never clear an existing decline with proposal metadata.
      const fresh = await readAdvisorState(paths.project);
      if (fresh.declined || (await readGlobalState(paths.global)).declined || !current()) return;
      await updateAdvisorState(paths.project, { lastProposedHead: repo.head, lastProposedAt: Date.now() });
      if (!current()) return;
      const controller = new AbortController();
      pending = controller;
      const choice = await ctx.ui.select(`Init-deep: ${proposal.trigger} — review repository guidance?`, CHOICES, {
        timeout: 60_000,
        signal: controller.signal,
      });
      if (pending === controller) pending = undefined;
      if (controller.signal.aborted || !current()) return;
      const after = await gitRepository(ctx.cwd);
      if (after?.root !== repo.root || after.commonDir !== repo.commonDir || !current()) return;
      if (choice === "Run now") await queueSkill(pi, repo, proposal, current);
      else if (choice === "Never in this project") await updateAdvisorState(paths.project, { declined: true });
      else if (choice === "Never anywhere") {
        await readGlobalState(paths.global);
        await writeState(paths.global, { version: 1, declined: true, declinedAt: Date.now() });
      } else await updateAdvisorState(paths.project, { cooldownUntil: Date.now() + COOLDOWN_MS });
    } catch (error) {
      if (!current()) return;
      const message = `Init-deep advisor unavailable: ${error instanceof Error ? error.message : String(error)}`;
      pi.logger.warn(message);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    }
  };
  pi.on("session_start", (_event, ctx) => {
    cancel();
    if (!settings(ctx).initDeepAdvisor || ctx.agent.kind !== "main" || !ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
    const expected = generation;
    timerContext = ctx;
    timer = ctx.setTimeout(() => {
      timer = undefined;
      return propose(ctx, expected);
    }, 0);
  });
  pi.on("session_switch", cancel);
  pi.on("session_shutdown", cancel);

  pi.registerCommand("init-deep-advisor", {
    description: "Inspect or reset init-deep advice, or explicitly start the skill",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (ctx.agent.kind !== "main") {
        notice(pi, ctx, "Init-deep advisor commands are available in the main session only.", true);
        return;
      }
      if (!["status", "run", "skip", "never-project", "never-global", "reset-project", "reset-global"].includes(action)) {
        notice(pi, ctx, USAGE, true);
        return;
      }
      cancel();
      try {
        const globalPath = join(getAgentDir(), "omo-toolkit", "init-deep-advisor.json");
        if (action === "never-global" || action === "reset-global") {
          await readGlobalState(globalPath);
          await writeState(globalPath, {
            version: 1,
            declined: action === "never-global",
            declinedAt: action === "never-global" ? Date.now() : null,
          });
          notice(
            pi,
            ctx,
            action === "never-global" ? "Init-deep advisor disabled everywhere." : "Global init-deep advisor suppression cleared.",
          );
          return;
        }
        const repo = await gitRepository(ctx.cwd);
        if (!repo) {
          notice(
            pi,
            ctx,
            "Init-deep advisor requires a Git worktree with a committed HEAD; manual skill://init-deep remains available.",
            true,
          );
          return;
        }
        const paths = advisorPaths(repo);
        if (action === "status") {
          notice(
            pi,
            ctx,
            JSON.stringify(
              {
                enabled: settings(ctx).initDeepAdvisor,
                root: repo.root,
                global: await readGlobalState(paths.global),
                project: await readAdvisorState(paths.project),
                snapshot: await readSnapshot(paths.snapshot),
                paths,
              },
              null,
              2,
            ),
          );
        } else if (action === "run") {
          const sessionId = ctx.sessionManager.getSessionId();
          const expected = generation;
          await queueSkill(
            pi,
            repo,
            { trigger: "manual" },
            () => generation === expected && ctx.sessionManager.getSessionId() === sessionId,
          );
        } else {
          await updateAdvisorState(
            paths.project,
            action === "skip"
              ? { cooldownUntil: Date.now() + COOLDOWN_MS }
              : action === "never-project"
                ? { declined: true }
                : { declined: false, cooldownUntil: 0, lastProposedHead: null, lastProposedAt: 0 },
          );
          notice(
            pi,
            ctx,
            action === "never-project"
              ? "Init-deep advisor disabled in this project (all worktrees)."
              : action === "skip"
                ? "Init-deep advisor skipped for seven days."
                : "Project init-deep advisor suppression cleared.",
          );
        }
      } catch (error) {
        notice(pi, ctx, `Init-deep advisor: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  const parameters = pi.zod.object({ action: pi.zod.enum(["status", "record"]), mode: pi.zod.enum(["local", "committed"]).optional() });
  pi.registerTool({
    name: "toolkit_init_deep",
    label: "Init-deep snapshot",
    description:
      "Read init-deep advisor status, or record the current repository snapshot after init-deep's independent verification PASS and settled delivery. Record derives HEAD/counts/time itself; mode is required. It is not verification evidence.",
    approval: "write",
    parameters,
    async execute(_id, params: { action: "status" | "record"; mode?: "local" | "committed" }, _signal, _update, ctx) {
      try {
        const repo = await gitRepository(ctx.cwd);
        if (!repo) throw new Error("A Git worktree with a committed HEAD is required");
        const paths = advisorPaths(repo);
        const previous = await readSnapshot(paths.snapshot);
        if (params.action === "status") {
          const details = {
            root: repo.root,
            project: await readAdvisorState(paths.project),
            global: await readGlobalState(paths.global),
            snapshot: previous,
          };
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        }
        if (!params.mode) throw new Error("mode is required for record (local or committed)");
        const metrics = await projectMetrics(repo.root);
        const fields: SnapshotFields = {
          commitSha: repo.head,
          fileCount: metrics.tracked.length,
          loc: metrics.loc,
          timestamp: Date.now(),
          mode: params.mode,
        };
        await writeState(paths.snapshot, { version: 1, ...fields });
        return { content: [{ type: "text", text: JSON.stringify(fields) }], details: fields };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Init-deep snapshot not recorded: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  });
}
