import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { type AdrDoc, type AdrModel, adrRepo, loadInitialized, loadModel, ordered, STATUSES, toRecord } from "#src/documents.ts";
import { discoverRepo } from "#src/git.ts";
import { initialize, note, setStatus } from "#src/operations.ts";
import type { AdrSession, UiFactory } from "#src/ses.ts";
import { checkReceipt, detailText, failure, type Receipt, requireInitialized, statusReceipt, toolResult, written } from "#src/tools.ts";
import type { MenuAction } from "#src/ui.ts";

export interface AdrCommands {
  refresh(ctx: ExtensionContext): Promise<void>;
}

const USAGE =
  "Usage: /adr [list [status] | show <id> | accept|reject|deprecate <id> | note <id> <text> | new [topic] | supersede <id> [topic] | check [--fix] | init | confirm <token>]";

/** `label` is what the menu shows; actions that take arguments name them so they stay distinguishable from the bare action. */
interface Completion {
  value: string;
  label?: string;
  description: string;
}

const ACTIONS: readonly Completion[] = [
  { value: "list", description: "List ADRs" },
  { value: "list ", label: "list <status>", description: "List ADRs with one status" },
  { value: "show ", label: "show <id>", description: "Show an ADR's full text and supersession chain" },
  { value: "accept ", label: "accept <id>", description: "Accept an ADR" },
  { value: "reject ", label: "reject <id>", description: "Reject an ADR" },
  { value: "deprecate ", label: "deprecate <id>", description: "Deprecate an ADR" },
  { value: "note ", label: "note <id> <text>", description: "Append a dated note under More Information" },
  { value: "new", description: "Ask the agent to interview you for a new decision" },
  { value: "supersede ", label: "supersede <id> [topic]", description: "Ask the agent to interview you for a replacement decision" },
  { value: "check", description: "Check ADR consistency" },
  { value: "check --fix", description: "Check and regenerate the ADR index" },
  { value: "init", description: "Initialize ADR management in this repository" },
  { value: "confirm ", label: "confirm <token>", description: "Apply a held /adr init preview by its token" },
];

const STATUS_FOR: Readonly<Record<string, "accepted" | "rejected" | "deprecated">> = {
  accept: "accepted",
  reject: "rejected",
  deprecate: "deprecated",
};

/** Splits off the first word; the rest keeps its spacing for free text such as notes and topics. */
function head(text: string): [string, string] {
  const trimmed = text.trim();
  const word = /^\S*/.exec(trimmed)?.[0] ?? "";
  return [word, trimmed.slice(word.length).trim()];
}

function newPrompt(topic: string): string {
  return `Use the adr skill to interview me about a new architecture decision${topic ? ` on: ${topic}` : ""}. Read related ADRs with adr_status first and skip questions they already answer. Gather the context and problem, decision drivers, genuine considered options, the chosen outcome and why, consequences, how the decision will be confirmed, and who decided, was consulted or was informed. Show me the draft and any review gaps, then call adr_manage with action "create". Create it as proposed unless I explicitly accept it.`;
}

function supersedePrompt(doc: AdrDoc, topic: string): string {
  return `Use the adr skill to interview me about the decision that replaces ${doc.id} — ${doc.title}${topic ? `; new direction: ${topic}` : ""}. Read ${doc.id} and its supersession chain with adr_status first. Gather what changed, decision drivers, genuine considered options, the new outcome and why, consequences and how it will be confirmed. Show me the draft and wait for my explicit agreement, then call adr_manage with action "supersede" and id "${doc.id}"; the successor is recorded as accepted and ${doc.id} becomes superseded.`;
}

export function registerCommands(
  pi: ExtensionAPI,
  ses: AdrSession,
  uiFor: UiFactory,
  changed: (ctx: ExtensionContext) => void,
): AdrCommands {
  let adrs: Array<Pick<AdrDoc, "id" | "title" | "status">> = [];

  async function refresh(ctx: ExtensionContext): Promise<void> {
    adrs = [];
    if (!discoverRepo(ctx.cwd)) return;
    const model = await loadInitialized(ctx.cwd);
    if (model) adrs = ordered(model.adrs).map((doc) => ({ id: doc.id, title: doc.title, status: doc.status }));
  }

  function show(customType: string, receipt: Receipt, footer?: string): void {
    const text = toolResult(receipt).content.map((part) => part.text);
    pi.sendMessage({ customType, content: [...text, ...(footer ? [footer] : [])].join("\n"), display: true });
  }

  function find(model: AdrModel, id: string): AdrDoc {
    const doc = model.adrs.find((candidate) => candidate.id === id);
    if (!doc) throw new Error(`Unknown ADR ${id}. Run /adr list for ids.`);
    return doc;
  }

  async function init(ctx: ExtensionCommandContext, args: string): Promise<void> {
    const ui = uiFor(ctx);
    if (args) throw new Error("Usage: /adr init");
    const repo = adrRepo(ctx.cwd);
    const preview = await initialize(repo.repoRoot, "main", { dryRun: true });
    if (!preview.files.length) {
      ui.notify(preview.warnings.join(" ") || "ADR management is already initialized.", "info");
      return;
    }
    const title = "Initialize ADR management: docs/adr/README.md becomes the marker and generated index.";
    if (!ui.interactive) {
      const token = ses.holdPreview(ctx, repo.repoRoot, preview.files);
      show("wows-omp-adr.init", {
        ok: false,
        reason: [
          `${title}\nNothing was written: no interactive UI can confirm this preview.`,
          ...preview.files.map((file) => `--- ${file.path}\n${file.content}`),
        ].join("\n\n"),
        hints: [`Write exactly these files with /adr confirm ${token}; any other reply declines it.`],
      });
      return;
    }
    const confirmed = await ui.previewConfirm({ title, files: preview.files });
    if (confirmed !== true) {
      ui.notify(confirmed === false ? "ADR initialization declined." : "ADR initialization: no answer available.", "info");
      return;
    }
    show("wows-omp-adr.init", await apply(repo.repoRoot, preview.files));
  }

  /** Writes the confirmed initialization only if it still produces exactly the previewed files. */
  async function apply(repoRoot: string, files: Array<{ path: string; content: string }>): Promise<Receipt> {
    try {
      const fresh = await initialize(repoRoot, "main", { dryRun: true });
      if (JSON.stringify(fresh.files) !== JSON.stringify(files))
        return { ok: false, reason: "docs/adr/ changed since the preview; run /adr init again for a fresh preview.", hints: [] };
      return written("Initialized ADR management in docs/adr/.", await initialize(repoRoot, "main"));
    } catch (error) {
      return failure(error);
    }
  }

  async function decide(ctx: ExtensionCommandContext, action: MenuAction, id: string, text: string): Promise<void> {
    const repo = await requireInitialized(ctx.cwd, "user");
    const model = await loadModel(repo);
    if (!id) throw new Error(`Usage: /adr ${action} <id>${action === "note" ? " <text>" : action === "supersede" ? " [topic]" : ""}`);
    const doc = find(model, id);
    const status = STATUS_FOR[action];
    if (status) {
      if (text) throw new Error(`Usage: /adr ${action} <id>`);
      let receipt: Receipt;
      try {
        receipt = written(`${doc.id} ${status}.`, await setStatus(repo.repoRoot, "main", doc.id, status));
      } catch (error) {
        receipt = failure(error);
      }
      show("wows-omp-adr.status", receipt);
    } else if (action === "note") {
      if (!text) throw new Error("Usage: /adr note <id> <text>");
      let receipt: Receipt;
      try {
        receipt = written(`${doc.id}: note appended.`, await note(repo.repoRoot, "main", doc.id, text));
      } catch (error) {
        receipt = failure(error);
      }
      show("wows-omp-adr.note", receipt);
    } else if (action === "supersede") {
      if (doc.status !== "accepted" && doc.status !== "deprecated")
        throw new Error(`Only an accepted or deprecated ADR can be superseded; ${doc.id} is ${doc.status}.`);
      pi.sendUserMessage(supersedePrompt(doc, text));
    }
  }

  async function menu(ctx: ExtensionCommandContext): Promise<void> {
    const ui = uiFor(ctx);
    const repo = await requireInitialized(ctx.cwd, "user");
    if (!ui.interactive) {
      show("wows-omp-adr.list", await statusReceipt(repo), USAGE);
      return;
    }
    const model = await loadModel(repo);
    const choice = await ui.menu(ordered(model.adrs).map((doc) => ({ record: toRecord(repo, doc), detail: detailText(model, doc) })));
    if (!choice) return;
    if (choice.action === "check" || choice.action === "check-fix") {
      show("wows-omp-adr.check", await checkReceipt(repo, choice.action === "check-fix"));
    } else if (choice.action === "new") {
      const topic = await ui.text("New decision", "Optional topic; leave empty to start the interview");
      if (topic !== undefined) pi.sendUserMessage(newPrompt(topic.trim()));
    } else if (choice.action === "note" || choice.action === "supersede") {
      const id = choice.id as string;
      const text = await ui.text(
        choice.action === "note" ? `Note for ${id}` : `Supersede ${id}`,
        choice.action === "note"
          ? "Dated note appended under More Information"
          : "Optional new direction; leave empty to start the interview",
      );
      if (text === undefined || (choice.action === "note" && !text.trim())) return;
      await decide(ctx, choice.action, id, text.trim());
    } else await decide(ctx, choice.action, choice.id as string, "");
  }

  async function adrCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const ui = uiFor(ctx);
    try {
      if (ctx.agent.kind !== "main") throw new Error("/adr commands require the main session.");
      const [action, rest] = head(args);
      const [first, remainder] = head(rest);
      if (!action) await menu(ctx);
      else if (action === "init") await init(ctx, rest);
      else if (action === "confirm") {
        if (!first || remainder) throw new Error("Usage: /adr confirm <token>");
        const preview = ses.takePreview(ctx, first);
        if (!preview) throw new Error(`No pending ADR preview ${first} in this session. Run /adr init again for a fresh preview.`);
        show("wows-omp-adr.confirm", await apply(preview.repoRoot, preview.files));
      } else if (action === "list") {
        if (remainder || (first && !STATUSES.includes(first as (typeof STATUSES)[number])))
          throw new Error(`Usage: /adr list [${STATUSES.join("|")}]`);
        show("wows-omp-adr.list", await statusReceipt(await requireInitialized(ctx.cwd, "user"), { status: first || undefined }));
      } else if (action === "show") {
        if (!first || remainder) throw new Error("Usage: /adr show <id>");
        show("wows-omp-adr.show", await statusReceipt(await requireInitialized(ctx.cwd, "user"), { id: first }));
      } else if (action === "check") {
        if (rest && rest !== "--fix") throw new Error("Usage: /adr check [--fix]");
        show("wows-omp-adr.check", await checkReceipt(await requireInitialized(ctx.cwd, "user"), rest === "--fix"));
      } else if (action === "new") {
        await requireInitialized(ctx.cwd, "user");
        pi.sendUserMessage(newPrompt(rest));
      } else if (Object.hasOwn(STATUS_FOR, action) || action === "note" || action === "supersede")
        await decide(ctx, action as MenuAction, first, remainder);
      else throw new Error(USAGE);
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      changed(ctx);
      await refresh(ctx).catch(() => {});
    }
  }

  pi.registerCommand("adr", {
    description: "Browse ADRs, accept, reject or deprecate them, append notes, start new or superseding decisions, check, or initialize",
    getArgumentCompletions(prefix) {
      const prefixed = (word: string, options: readonly Completion[]) =>
        options.map(({ value, description }) => ({ value: `${word} ${value}`, description }));
      const ids = (filter: (status: string) => boolean) =>
        adrs.filter((doc) => filter(doc.status)).map((doc) => ({ value: doc.id, description: `${doc.title} (${doc.status})` }));
      const [word] = head(prefix);
      let options: Completion[] = [...ACTIONS];
      if (/\s/.test(prefix)) {
        if (word === "list")
          options = prefixed(
            word,
            STATUSES.map((status) => ({ value: status, description: `List ${status} ADRs` })),
          );
        else if (word === "check") options = prefixed(word, [{ value: "--fix", description: "Regenerate the ADR index" }]);
        else if (word === "show" || word === "note")
          options = prefixed(
            word,
            ids(() => true),
          );
        else if (Object.hasOwn(STATUS_FOR, word))
          options = prefixed(
            word,
            ids((status) => status !== "superseded" && status !== STATUS_FOR[word]),
          );
        else if (word === "supersede")
          options = prefixed(
            word,
            ids((status) => status === "accepted" || status === "deprecated"),
          );
      }
      const matches = options
        .filter(({ value }) => value.startsWith(prefix))
        .map(({ value, label, description }) => ({ value, label: label ?? value, description }));
      return matches.length ? matches : null;
    },
    handler: adrCommand,
  });
  return { refresh };
}
