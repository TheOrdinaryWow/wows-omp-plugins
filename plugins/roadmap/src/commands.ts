import { lstat, readdir } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { check } from "#src/check.ts";
import { loadAll, loadRepo, roundFiles, roundSha256 } from "#src/documents.ts";
import { closeRound } from "#src/operations.ts";
import { actor, type RoadmapSession, type UiFactory } from "#src/ses.ts";
import { applyPreview, checkReceipt, requireRepo, resolveOverlap, statusReceipt, type ToolReceipt, toolResult } from "#src/tools.ts";
import type { RoundTodoDispositionChoice } from "#src/ui.ts";

export interface RoadmapCommands {
  refresh(ctx: ExtensionContext): Promise<void>;
}

const CLOSE_ROUND_USAGE =
  'Usage: /roadmap close-round [<todo>=resolved:<reference> | <todo>=wontfix[:<reason>] | <todo>=carried ...]; quote text with spaces, e.g. T03=wontfix:"out of scope".';
const USAGE =
  "Usage: /roadmap [check [--fix] | new-round | close-round [<todo>=<disposition>[:<reference>] ...] | stage <id> | overlap <stage> roadmap|free|unrelated [intent] | confirm <token>]";
const OVERLAP_ANSWERS = ["roadmap", "free", "unrelated"];

/** Splits command arguments on whitespace; double quotes group text with spaces and are removed. */
export function splitArgs(args: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quoted = false;
  for (const char of args) {
    if (char === '"') {
      quoted = !quoted;
      word ??= "";
    } else if (!quoted && /\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + char;
  }
  if (quoted) throw new Error("Unterminated quote in command arguments.");
  if (word !== undefined) words.push(word);
  return words;
}

/** Parses `/roadmap close-round` disposition arguments; closeRound validates ids and completeness. */
export function parseRoundDispositions(words: readonly string[]): RoundTodoDispositionChoice[] {
  return words.map((word) => {
    const match = /^([^=:\s]+)=(resolved|wontfix|carried)(?::([\s\S]*))?$/.exec(word);
    if (!match?.[1] || !match[2]) throw new Error(`Invalid round-close disposition "${word}". ${CLOSE_ROUND_USAGE}`);
    const disposition = match[2] as RoundTodoDispositionChoice["disposition"];
    const reference = match[3]?.trim();
    return reference ? { id: match[1], disposition, reference } : { id: match[1], disposition };
  });
}

export function registerCommands(
  pi: ExtensionAPI,
  ses: RoadmapSession,
  uiFor: UiFactory,
  changed: (ctx: ExtensionContext) => void,
): RoadmapCommands {
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

  function show(customType: string, receipt: ToolReceipt, footer?: string): void {
    const text = toolResult(receipt).content.map((part) => part.text);
    pi.sendMessage({ customType, content: [...text, ...(footer ? [footer] : [])].join("\n"), display: true });
  }

  async function roadmapCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const ui = uiFor(ctx);
    try {
      if (ctx.agent.kind !== "main") throw new Error("/roadmap commands require the main session.");
      const words = splitArgs(args);
      let action = words[0];
      if (action === "confirm") {
        const token = words[1];
        if (!token || words.length > 2) throw new Error("Usage: /roadmap confirm <token>");
        const preview = ses.takePreview(ctx, token);
        if (!preview) {
          throw new Error(
            `No pending Roadmap preview ${token} in this session. Ask the agent to call roadmap_init or roadmap_round_open again for a fresh preview.`,
          );
        }
        show(
          "wows-omp-roadmap.confirm",
          await applyPreview(ses, ctx, preview.kind, preview.repo, actor(ctx), preview.generation, preview.prepared),
        );
        await refresh(ctx);
        return;
      }
      const repo = await requireRepo(ctx);
      let model = await loadAll(repo);
      stageIds = model.stages.map((stage) => stage.id);
      let selectedStage = words[1];
      let reviewedRound: { id: string; sha256: string } | undefined;
      if (!action) {
        if (!ui.interactive) {
          show("wows-omp-roadmap.status", await statusReceipt(repo), USAGE);
          return;
        }
        const round = model.rounds.find((candidate) => candidate.status === "active");
        if (round) reviewedRound = { id: round.id, sha256: roundSha256(roundFiles(model, round)) };
        const choice = await ui.statusMenu(model);
        if (!choice) {
          ui.notify("Roadmap status menu: no answer available.", "info");
          return;
        }
        action = choice.action;
        selectedStage = choice.stage;
        if (action === "close-round" && !reviewedRound) throw new Error("There is no reviewed active round to close.");
      }
      if (action === "close") {
        if (selectedStage) {
          ui.notify(
            `To close ${selectedStage}, call roadmap_stage with action: "close", id: "${selectedStage}", delivered, passing evidence for every done criterion, and TODO/ADR dispositions. This menu does not close the stage.`,
            "info",
          );
        }
        return;
      }
      if (action === "stage") {
        if (!selectedStage || words.length > 2) throw new Error("Usage: /roadmap stage <id>");
        show("wows-omp-roadmap.status", await statusReceipt(repo, selectedStage));
      } else if (action === "check") {
        if (words.length > 2 || (words[1] && words[1] !== "--fix")) throw new Error("Usage: /roadmap check [--fix]");
        show("wows-omp-roadmap.check", await checkReceipt(repo, words[1] === "--fix"));
      } else if (action === "overlap") {
        const [, stageId, answer, ...intent] = words;
        if (!stageId || (answer !== "roadmap" && answer !== "free" && answer !== "unrelated"))
          throw new Error("Usage: /roadmap overlap <stage> roadmap|free|unrelated [intent]");
        const receipt = await resolveOverlap({
          ses,
          ctx,
          repo,
          owner: actor(ctx),
          generation: ses.currentGeneration(ctx),
          stage: stageId,
          intent: intent.join(" "),
          ask: async () => answer,
        });
        show("wows-omp-roadmap.overlap", receipt);
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
        // Typed dispositions answer the per-TODO dialog; the status menu never supplies arguments.
        let dispositions = !reviewedRound && words.length > 1 ? parseRoundDispositions(words.slice(1)) : undefined;
        if (!reviewedRound) model = await loadAll(repo);
        const round = model.rounds.find((candidate) => candidate.status === "active");
        if (!round) throw new Error("There is no active round to close.");
        if (model.stages.some((stage) => stage.round === round.id && stage.status !== "closed" && stage.status !== "dropped")) {
          throw new Error("Every stage must be closed or dropped before the round can close.");
        }
        const errors = (await check(model)).filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length) throw new Error(`Roadmap check failed: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
        const expected = reviewedRound ?? { id: round.id, sha256: roundSha256(roundFiles(model, round)) };
        const todos = model.todos
          .filter((doc) => doc.round === round.id)
          .flatMap((doc) => doc.items.filter((item) => item.status === "open"));
        if (!dispositions) {
          if (ui.interactive) dispositions = await ui.closeRoundDispositions(todos);
          else if (todos.length) {
            throw new Error(
              `Round close needs a disposition for every open TODO: ${todos.map((item) => `${item.id} ${item.title}`).join("; ")}. ${CLOSE_ROUND_USAGE}`,
            );
          } else dispositions = [];
        }
        if (!dispositions) {
          ui.notify("Round close: no answer available.", "info");
          return;
        }
        const receipt = await closeRound(repo, actor(ctx), { expected, dispositions });
        if (receipt.ok) {
          for (const stage of model.stages.filter((stage) => stage.round === round.id)) ses.clearStage(ctx, repo.repoRoot, stage.id);
          ses.disarm(ctx, repo.repoRoot);
        }
        show("wows-omp-roadmap.round-close", receipt);
      } else throw new Error(USAGE);
      await refresh(ctx);
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      changed(ctx);
    }
  }

  pi.registerCommand("roadmap", {
    description: "View Roadmap status, check documents, open/close a round, view a stage, answer an overlap or confirm a preview",
    getArgumentCompletions(prefix) {
      const overlap = /^overlap (\S+) /.exec(prefix);
      let options: string[];
      if (overlap) options = OVERLAP_ANSWERS.map((answer) => `overlap ${overlap[1]} ${answer}`);
      else if (prefix.startsWith("overlap ")) options = stageIds.map((id) => `overlap ${id} `);
      else if (prefix.startsWith("stage ")) options = stageIds.map((id) => `stage ${id}`);
      else options = ["check", "check --fix", "new-round", "close-round", "stage ", "overlap ", "confirm "];
      const matches = options.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: roadmapCommand,
  });
  return { refresh };
}
