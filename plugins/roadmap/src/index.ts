import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { AdrConnection } from "#src/adr.ts";
import { registerCommands } from "#src/commands.ts";
import { loadAll, loadRepo } from "#src/documents.ts";
import { discoverRepo } from "#src/git.ts";
import { renderInjection } from "#src/handoff.ts";
import { interceptionReason } from "#src/interception.ts";
import { PluginStatePublisher } from "#src/plugin-state.ts";
import { registerPrometheusContract } from "#src/prometheus.ts";
import { RoadmapSession, type UiFactory } from "#src/ses.ts";
import { roadmapStatus } from "#src/state.ts";
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
  const uiFor: UiFactory = (ctx) => (testUiFactory ?? ((host) => createTuiUi(host, pi)))(ctx);
  let warned = false;
  const warn = (error: unknown): void => {
    if (warned) return;
    warned = true;
    pi.logger.warn("Roadmap state sidecar could not be published", { error: error instanceof Error ? error.message : String(error) });
  };
  const publisher = new PluginStatePublisher("roadmap", warn);
  let publishing = Promise.resolve();
  /** Re-derives the sidecar from the files on disk; serialized so a slower read never overwrites a newer state. */
  const changed = (ctx: ExtensionContext): void => {
    if (ctx.agent.kind !== "main") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const git = discoverRepo(ctx.cwd);
    const binding = git ? ses.getBinding(git.repoRoot) : undefined;
    publishing = publishing.then(async () => {
      try {
        const repo = git && (await loadRepo(git.repoRoot));
        publisher.publish(sessionId, repo ? roadmapStatus(repo.repoRoot, await loadAll(repo), binding) : null);
      } catch (error) {
        warn(error);
      }
    });
  };
  // Roadmap reads and writes ADRs only through the adr plugin's service, and registers its stage resolver there.
  const adr = new AdrConnection(pi.events);
  registerTools(pi, ses, uiFor, changed, adr);
  const commands = registerCommands(pi, ses, uiFor, changed, adr);
  registerPrometheusContract(pi, ses);

  async function rebuild(_event: unknown, ctx: ExtensionContext): Promise<void> {
    ses.rebuild(ctx);
    // The adr plugin may capture this session after us; a failed connection is retried at the next turn, tool or command.
    adr.release();
    adr.connect(ctx.sessionManager.getSessionId());
    changed(ctx);
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
  pi.on("session_shutdown", async () => {
    adr.release();
    await publishing;
    await publisher.flush();
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      ses.ensure(ctx);
      if (event.toolName === "roadmap_init" || event.toolName === "roadmap_round_open" || event.toolName === "roadmap_round_plan") {
        const git = discoverRepo(ctx.cwd);
        const kind = event.toolName === "roadmap_init" ? "init" : event.toolName === "roadmap_round_plan" ? "plan" : "round";
        if (!git || !ses.isArmed(ctx, git.repoRoot, kind)) {
          return {
            block: true,
            reason: `${event.toolName} is unarmed; use ${kind === "init" ? "/init-project" : kind === "plan" ? "/roadmap plan-round" : "/roadmap new-round"} in the main session first.`,
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
    // Without the adr plugin every roadmap tool and command refuses, so turns get no roadmap context.
    const connected = "api" in adr.connect(ctx.sessionManager.getSessionId());
    try {
      const repo = await loadRepo(ctx.cwd);
      if (!repo) return;
      const model = await loadAll(repo);
      const notice = ses.validateBinding(ctx, repo.repoRoot, model);
      // Subagents and external edits change files without this session's tools; resync once per turn.
      changed(ctx);
      const block = connected ? renderInjection(model, ses.getBinding(repo.repoRoot)) : "";
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
            `Plan ${latest.planId.replace(/\s+/g, " ").slice(0, 100)} completed for ${latest.stage}. Call roadmap_stage close with passing done-criterion evidence and TODO dispositions once the main agent has accepted or rejected the stage's proposed ADRs with adr_manage.`,
          );
          lines.push("Gate results are evidence candidates; map and verify them against the stage's done criteria:");
          lines.push(
            ...latest.gates
              .slice(0, 4)
              .map(
                (gate) =>
                  `- ${gate.gateId.replace(/\s+/g, " ").slice(0, 40)}: ${gate.verdict.replace(/\s+/g, " ").slice(0, 20)} — ${gate.summary.replace(/\s+/g, " ").slice(0, 180)}`,
              ),
          );
          if (latest.delivery)
            lines.push(`Delivery (${latest.delivery.mode}): ${latest.delivery.summary.replace(/\s+/g, " ").slice(0, 180)}`);
          if (latest.gates.length > 4 || pending.length > 1)
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
