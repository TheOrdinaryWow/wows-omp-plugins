import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { ADR_INSTALL_HINT, AdrConnection } from "#src/adr.ts";
import { requestPlans } from "#src/atlas.ts";
import { registerMessageTitles } from "#src/cards.ts";
import { registerCommands } from "#src/commands.ts";
import { loadAll, loadRepo, today } from "#src/documents.ts";
import { committedFile, discoverRepo, gitSync } from "#src/git.ts";
import { renderCloseReminder, renderInjection } from "#src/handoff.ts";
import { interceptionReason } from "#src/interception.ts";
import { applyPrepared, atomicWrite, prepareUpgrade } from "#src/operations.ts";
import { PluginStatePublisher } from "#src/plugin-state.ts";
import { registerPrometheusContract } from "#src/prometheus.ts";
import { RoadmapSession, type UiFactory } from "#src/ses.ts";
import { StageOrderPreference, uiMenuReader } from "#src/settings.ts";
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
  const uiMenu = uiMenuReader(pi.logger);
  const stageOrder = new StageOrderPreference(pi.logger);
  const uiFor: UiFactory = (ctx) => (testUiFactory ?? ((host) => createTuiUi(host, pi, uiMenu, stageOrder)))(ctx);
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
  registerTools(pi, ses, uiFor, changed, adr, stageOrder);
  const commands = registerCommands(pi, ses, uiFor, changed, adr, stageOrder);
  registerPrometheusContract(pi, ses);
  registerMessageTitles(pi);

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

  let upgradeWarningShown = false;
  async function offerUpgrade(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    const generation = ses.currentGeneration(ctx);
    const git = discoverRepo(ctx.cwd);
    const repo = git && (await loadRepo(git.repoRoot));
    if (!repo || signal.aborted || !ses.isCurrent(ctx, generation)) return;
    const model = await loadAll(repo);
    if (model.index.format !== 1 || model.parseErrors?.some((issue) => issue.path === model.index.path)) return;
    const path = relative(repo.repoRoot, model.index.path);
    const directory = relative(repo.repoRoot, repo.roadmapDir);
    const clean = (): boolean => {
      const status = gitSync(repo.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", directory]);
      return status.code === 0 && status.stdout === "";
    };
    if (!clean() || committedFile(repo.repoRoot, path) === undefined) return;
    const owner = { sessionId: ctx.sessionManager.getSessionId(), kind: "main" as const };
    const preview = await prepareUpgrade(repo, owner);
    if (!preview.ok || preview.files.length !== 1 || preview.files[0]?.path !== model.index.path) return;
    if (signal.aborted || !ses.isCurrent(ctx, generation) || !clean()) return;
    const original = await readFile(model.index.path);
    let written = false;
    const receipt = await applyPrepared(repo, owner, preview.prepared, {
      signal,
      async writeFile(path, content, options) {
        await atomicWrite(path, content, options);
        written = true;
      },
      guard: () =>
        ses.isCurrent(ctx, generation) && clean()
          ? undefined
          : { ok: false, reason: "The session or roadmap files changed before the automatic upgrade.", hints: [] },
    });
    if (!receipt.ok) {
      if (written) await writeFile(model.index.path, original);
      return;
    }
    if (signal.aborted || !ses.isCurrent(ctx, generation)) {
      await writeFile(model.index.path, original);
      return;
    }
    try {
      const commit = gitSync(repo.repoRoot, ["commit", "-m", "chore(roadmap): upgrade roadmap to format 2", "--", path], 30_000);
      if (commit.code !== 0) throw new Error(`git commit exited with status ${commit.code}`);
    } catch (error) {
      await writeFile(model.index.path, original);
      if (!upgradeWarningShown) {
        upgradeWarningShown = true;
        pi.logger.warn("Roadmap automatic format-2 upgrade was skipped", { error: String(error) });
      }
      uiFor(ctx).notify("Automatic roadmap upgrade was skipped. Run /roadmap upgrade to upgrade manually.", "warning");
      return;
    }
    const sha = gitSync(repo.repoRoot, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    pi.sendMessage({
      customType: "wows-omp-roadmap.upgrade",
      content: `Upgraded the repository to roadmap format 2 and committed ${path} (${sha}).`,
      display: true,
    });
    changed(ctx);
    await commands.refresh(ctx);
  }

  let offering: AbortController | undefined;
  /** Runs after the host's awaited session-start handlers, with cancellation on the next entry or shutdown. */
  function scheduleUpgradeOffer(ctx: ExtensionContext): void {
    offering?.abort();
    offering = undefined;
    if (ctx.agent.kind !== "main") return;
    const controller = new AbortController();
    offering = controller;
    setTimeout(() => {
      offerUpgrade(ctx, controller.signal)
        .catch((error) => pi.logger.warn("roadmap could not automatically upgrade to format 2", { error: String(error) }))
        .finally(() => {
          if (offering === controller) offering = undefined;
        });
    }, 0);
  }

  pi.on("session_start", async (event, ctx) => {
    await rebuild(event, ctx);
    scheduleUpgradeOffer(ctx);
  });
  pi.on("session_switch", async (event, ctx) => {
    await rebuild(event, ctx);
    scheduleUpgradeOffer(ctx);
  });
  pi.on("session_branch", rebuild);
  pi.on("session_tree", rebuild);
  pi.on("session_shutdown", async () => {
    offering?.abort();
    offering = undefined;
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

  /** The session whose user was already told that roadmap needs the adr plugin. */
  let adrHintSession: string | undefined;
  pi.on("before_agent_start", async (event, ctx) => {
    ses.ensure(ctx);
    // Without the adr plugin every roadmap tool and command refuses, so turns get only a note saying why.
    const sessionId = ctx.sessionManager.getSessionId();
    const connection = adr.connect(sessionId);
    try {
      const repo = await loadRepo(ctx.cwd);
      if (!repo) return;
      const model = await loadAll(repo);
      const notice = ses.validateBinding(ctx, repo.repoRoot, model);
      // Subagents and external edits change files without this session's tools; resync once per turn.
      changed(ctx);
      await commands.refresh(ctx);
      if (!("api" in connection)) {
        if (ctx.agent.kind === "main" && adrHintSession !== sessionId) {
          adrHintSession = sessionId;
          uiFor(ctx).notify(`${connection.reason} ${ADR_INSTALL_HINT}`, "warning");
        }
        const unavailable = `[Roadmap status] ${connection.reason} Roadmap tools and context are unavailable in this session. ${ADR_INSTALL_HINT}`;
        return { systemPrompt: [...event.systemPrompt, unavailable] };
      }
      const block = renderInjection(model, ses.getBinding(repo.repoRoot), today(), await stageOrder.current(ctx));
      if (!block) return;
      const lines = [block];
      if (notice) lines.push(notice);
      const pending = ses
        .pendingClose(ctx, repo.repoRoot)
        .filter((item) => model.stages.some((stage) => stage.id === item.stage && stage.status === "active"));
      const stage = model.stages.find((candidate) => candidate.id === pending.at(-1)?.stage);
      if (stage) {
        // Coverage, drift and triage come from a fresh atlas:plans answer; without omo-prometheus only the completion shows.
        const plans = requestPlans(pi.events, { sessionId: ctx.sessionManager.getSessionId(), repoRoot: repo.repoRoot, stage: stage.id });
        lines.push(...renderCloseReminder(stage, pending, plans));
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
