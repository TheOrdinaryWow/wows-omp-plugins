import { lstat, readdir } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { check } from "#src/check.ts";
import { loadAll, loadRepo } from "#src/documents.ts";
import { closeRound } from "#src/operations.ts";
import { actor, type RoadmapSession, type UiFactory } from "#src/ses.ts";
import { checkReceipt, requireRepo, statusReceipt, toolResult } from "#src/tools.ts";

export interface RoadmapCommands {
  refresh(ctx: ExtensionContext): Promise<void>;
}

export function registerCommands(pi: ExtensionAPI, ses: RoadmapSession, uiFor: UiFactory): RoadmapCommands {
  let stageIds: string[] = [];

  async function refresh(ctx: ExtensionContext): Promise<void> {
    stageIds = [];
    const repo = await loadRepo(ctx.cwd);
    if (repo) stageIds = (await loadAll(repo)).stages.map((stage) => stage.id);
  }

  pi.registerCommand("init-project", {
    description: "Interview the user, preview and initialize a Roadmap project and its first round",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const ui = uiFor(ctx);
      try {
        if (ctx.agent.kind !== "main") throw new Error("/init-project requires the main session.");
        if (args.trim()) throw new Error("Usage: /init-project");
        const repo = await requireRepo(ctx, true);
        try {
          await lstat(repo.roadmapDir);
          throw new Error("docs/roadmap/ already exists; this plugin does not adopt existing projects.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          if ((await readdir(repo.adrDir)).length) throw new Error("docs/adr/ must be absent or empty before initialization.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        ses.arm(ctx, repo.repoRoot, "init");
        pi.sendUserMessage(
          "Use the roadmap skill's /init-project interview checklist: project identity and description; first-round goal, constraints, non-goals and principles; decisions already made as initial ADRs; stage breakdown with objectives, scope, verifiable done criteria and dependencies. Interview me before drafting. Then call roadmap_init with the complete draft; it will show a preview for my confirmation before writing files.",
        );
      } catch (error) {
        ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  async function roadmapCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const ui = uiFor(ctx);
    try {
      if (ctx.agent.kind !== "main") throw new Error("/roadmap commands require the main session.");
      const repo = await requireRepo(ctx);
      let model = await loadAll(repo);
      stageIds = model.stages.map((stage) => stage.id);
      const words = args.trim().split(/\s+/).filter(Boolean);
      let action = words[0];
      let selectedStage = words[1];
      if (!action) {
        const choice = await ui.statusMenu(model);
        if (!choice) {
          ui.notify("Roadmap status menu: no answer available.", "info");
          return;
        }
        action = choice.action;
        selectedStage = choice.stage;
      }
      if (action === "close") return;
      if (action === "stage") {
        if (!selectedStage || words.length > 2) throw new Error("Usage: /roadmap stage <id>");
        const result = toolResult(await statusReceipt(repo, selectedStage));
        pi.sendMessage({
          customType: "wows-omp-roadmap.status",
          content: result.content.map((part) => part.text).join("\n"),
          display: true,
        });
      } else if (action === "check") {
        if (words.length > 2 || (words[1] && words[1] !== "--fix")) throw new Error("Usage: /roadmap check [--fix]");
        const result = toolResult(await checkReceipt(repo, words[1] === "--fix"));
        pi.sendMessage({
          customType: "wows-omp-roadmap.check",
          content: result.content.map((part) => part.text).join("\n"),
          display: true,
        });
      } else if (action === "new-round") {
        if (words.length > 1) throw new Error("Usage: /roadmap new-round");
        // Re-read after the status menu; its snapshot is only for presentation.
        model = await loadAll(repo);
        if (model.rounds.some((round) => round.status === "active")) throw new Error("Close the active round before opening another.");
        const errors = (await check(model)).filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length) throw new Error(`Roadmap check failed: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
        ses.arm(ctx, repo.repoRoot, "round");
        pi.sendUserMessage(
          "Use the roadmap skill to interview me for the next round's charter: title, goal, constraints, non-goals and principles citing ADRs. Review carried TODOs in frozen rounds and agree which to import as new TODO ids. Then call roadmap_round_open with round and import_todos; show the preview and wait for my confirmation before writing.",
        );
      } else if (action === "close-round") {
        if (words.length > 1) throw new Error("Usage: /roadmap close-round");
        model = await loadAll(repo);
        const round = model.rounds.find((candidate) => candidate.status === "active");
        if (!round) throw new Error("There is no active round to close.");
        if (model.stages.some((stage) => stage.round === round.id && stage.status !== "closed" && stage.status !== "dropped")) {
          throw new Error("Every stage must be closed or dropped before the round can close.");
        }
        const errors = (await check(model)).filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length) throw new Error(`Roadmap check failed: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
        const todos = model.todos
          .filter((doc) => doc.round === round.id)
          .flatMap((doc) => doc.items.filter((item) => item.status === "open"));
        const dispositions = await ui.closeRoundDispositions(todos);
        if (!dispositions) {
          ui.notify("Round close: no answer available.", "info");
          return;
        }
        const receipt = await closeRound(repo, actor(ctx), { dispositions });
        if (receipt.ok) {
          for (const stage of model.stages.filter((stage) => stage.round === round.id)) ses.clearStage(ctx, repo.repoRoot, stage.id);
          ses.disarm(ctx, repo.repoRoot);
        }
        const result = toolResult(receipt);
        pi.sendMessage({
          customType: "wows-omp-roadmap.round-close",
          content: result.content.map((part) => part.text).join("\n"),
          display: true,
        });
      } else throw new Error("Usage: /roadmap [check [--fix] | new-round | close-round | stage <id>]");
      await refresh(ctx);
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  pi.registerCommand("roadmap", {
    description: "View Roadmap status, check documents, open/close a round or view a stage",
    getArgumentCompletions(prefix) {
      const options = ["check", "check --fix", "new-round", "close-round", ...stageIds.map((id) => `stage ${id}`)];
      const matches = options.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: roadmapCommand,
  });
  return { refresh };
}
