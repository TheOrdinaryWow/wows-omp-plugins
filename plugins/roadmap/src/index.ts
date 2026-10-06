import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { registerCommands } from "#src/commands.ts";
import { loadAll, loadRepo } from "#src/documents.ts";
import { discoverRepo } from "#src/git.ts";
import { renderInjection } from "#src/handoff.ts";
import { interceptionReason } from "#src/interception.ts";
import { RoadmapSession, type UiFactory } from "#src/ses.ts";
import { registerTools } from "#src/tools.ts";
import { createTuiUi } from "#src/ui.ts";

export { discoverRepo } from "#src/git.ts";

let testUiFactory: UiFactory | undefined;

/** Test-only injection; reset to undefined to restore the host UI. */
export function __setUiFactory(factory?: UiFactory): void {
  testUiFactory = factory;
}

export default function roadmap(pi: ExtensionAPI): void {
  const ses = new RoadmapSession(pi);
  const uiFor: UiFactory = (ctx) => (testUiFactory ?? createTuiUi)(ctx);
  registerTools(pi, ses, uiFor);
  const commands = registerCommands(pi, ses, uiFor);
  // T7 seam: add one import and registerPrometheusContract(pi, ses) here.

  async function rebuild(_event: unknown, ctx: ExtensionContext): Promise<void> {
    ses.rebuild(ctx);
    try {
      await commands.refresh(ctx);
    } catch (error) {
      uiFor(ctx).notify(`Roadmap state could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  pi.on("session_start", rebuild);
  pi.on("session_switch", rebuild);
  pi.on("session_branch", rebuild);
  pi.on("session_tree", rebuild);

  pi.on("tool_call", async (event, ctx) => {
    try {
      ses.ensure(ctx);
      if (event.toolName === "roadmap_init" || event.toolName === "roadmap_round_open") {
        const git = discoverRepo(ctx.cwd);
        const kind = event.toolName === "roadmap_init" ? "init" : "round";
        if (!git || !ses.isArmed(ctx, git.repoRoot, kind)) {
          return {
            block: true,
            reason: `${event.toolName} is unarmed; use ${kind === "init" ? "/init-project" : "/roadmap new-round"} in the main session first.`,
          };
        }
      }
      const reason = await interceptionReason(event.toolName, { ...event.input }, ctx.cwd);
      if (reason) return { block: true, reason };
    } catch (error) {
      return {
        block: true,
        reason: `Roadmap could not validate this mutation and refused it: ${error instanceof Error ? error.message : String(error)}. Run roadmap_check.`,
      };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    ses.ensure(ctx);
    try {
      const repo = await loadRepo(ctx.cwd);
      if (!repo) return;
      const model = await loadAll(repo);
      const notice = ses.validateBinding(ctx, repo.repoRoot, model);
      const block = renderInjection(model, ses.getBinding(repo.repoRoot));
      await commands.refresh(ctx);
      if (!block) return;
      const lines = [block];
      if (notice) lines.push(notice);
      const pending = ses
        .pendingClose(ctx, repo.repoRoot)
        .filter((item) => model.stages.some((stage) => stage.id === item.stage && stage.status === "active"));
      if (pending.length) {
        const latest = pending[pending.length - 1];
        if (latest) {
          lines.push(
            `Plan ${latest.planId.replace(/\s+/g, " ").slice(0, 100)} completed for ${latest.stage}. Call roadmap_stage close with passing done-criterion evidence and TODO/ADR dispositions.`,
          );
          lines.push("Gate results are evidence candidates; map and verify them against the stage's done criteria:");
          lines.push(
            ...latest.gates
              .slice(0, 3)
              .map(
                (gate) =>
                  `- ${gate.gateId.replace(/\s+/g, " ").slice(0, 40)}: ${gate.verdict.replace(/\s+/g, " ").slice(0, 20)} — ${gate.summary.replace(/\s+/g, " ").slice(0, 180)}`,
              ),
          );
          if (latest.gates.length > 3 || pending.length > 1)
            lines.push("Additional pending-close evidence is retained in this session's Roadmap entries.");
        }
      }
      return { systemPrompt: [...event.systemPrompt, lines.join("\n")] };
    } catch (error) {
      uiFor(ctx).notify(`Roadmap context could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });
}

// The host cache-busts the entry and its graph; tests use the actual prepared factory.
roadmap.__setUiFactory = __setUiFactory;
roadmap.discoverRepo = discoverRepo;
