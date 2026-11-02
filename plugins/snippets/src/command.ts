import { join } from "node:path";

import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

import {
  type ConsoleEntry,
  type ConsoleMessage,
  type ConsoleResult,
  type ConsoleState,
  type EntryAction,
  SnippetConsole,
  snippetFields,
} from "#src/console.ts";
import { FORM_OVERLAY, KEY_HINT, type KeyTaken, keyProblem, type SnippetDraft, SnippetForm } from "#src/form.ts";
import { triggerWord } from "#src/matching.ts";
import type { SnippetSettings } from "#src/settings.ts";
import { formatSnippetSource, type SnippetScope } from "#src/snippet.ts";
import type { SnippetEntry, SnippetStore } from "#src/store.ts";

export interface SnippetCommandDeps {
  store: SnippetStore;
  settings: () => Promise<SnippetSettings>;
  send: (text: string) => void;
  /** Posts a displayed session message; the only feedback channel when `hasUI` is false. */
  message: (content: string) => void;
  changed: () => Promise<void>;
}

const USAGE = "Usage: /snippets [<key> | send <key> | list]";
const BACK = "← Back";

const FULLSCREEN = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
} as const;

type Action = EntryAction | "new";
/** Result line of a mutation and the snippet the re-opened menu selects (by scope and key, since ids follow renames). */
interface Step {
  message: ConsoleMessage;
  target?: { scope: SnippetScope; key: string };
}
/** A finished insert or send ends the menu; everything else returns to it with a result line. */
type Outcome = "done" | { message: ConsoleMessage; selectedId?: string };

const info = (text: string): Step => ({ message: { text, level: "info" } });

/** Splits off the first word; the rest is trimmed. */
function head(text: string): [string, string] {
  const trimmed = text.trim();
  const word = /^\S*/.exec(trimmed)?.[0] ?? "";
  return [word, trimmed.slice(word.length).trim()];
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Without a UI `notify` is dropped, so feedback becomes a displayed message. */
function notice(ctx: ExtensionCommandContext, deps: SnippetCommandDeps, text: string, level: ConsoleMessage["level"]): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else deps.message(level === "info" ? text : `Snippets ${level}: ${text}`);
}

function problemLines(store: SnippetStore, settings: SnippetSettings): string[] {
  return [...(settings.problem ? [settings.problem] : []), ...store.problems.map((problem) => `${problem.path}: ${problem.message}`)];
}

/** The console's persistent warning line: the first problem and how many more there are. */
function problemNotice(store: SnippetStore, settings: SnippetSettings): ConsoleMessage | undefined {
  const [first, ...rest] = problemLines(store, settings);
  if (!first) return undefined;
  return { text: rest.length ? `${first} (+${rest.length} more; /snippets list shows all)` : first, level: "warning" };
}

function summary(entries: readonly SnippetEntry[]): string {
  const global = entries.filter((entry) => entry.scope === "global").length;
  return `${global} global, ${entries.length - global} workspace`;
}

function marks(entry: SnippetEntry): string {
  return [entry.scope, entry.pinned ? "pinned" : "", entry.enabled ? "" : "disabled", entry.shadowed ? "shadowed" : ""]
    .filter(Boolean)
    .join(", ");
}

function listText(store: SnippetStore, settings: SnippetSettings): string {
  const shortcuts = settings.problem
    ? "shortcuts off (invalid trigger)"
    : settings.trigger
      ? `shortcuts ${triggerWord(settings, "key")}`
      : "shortcuts off";
  const lines = [`Snippets: ${summary(store.entries)} · ${shortcuts}`];
  for (const entry of store.entries) {
    const trigger = triggerWord(settings, entry.key);
    const uses = `${entry.uses} use${entry.uses === 1 ? "" : "s"}`;
    lines.push(
      `- ${entry.key}${trigger ? ` (${trigger})` : ""} [${marks(entry)}, ${uses}]${entry.description ? ` — ${entry.description}` : ""}`,
    );
  }
  if (!store.entries.length)
    lines.push("No snippets yet. Create one from /snippets, or add <key>.md files:", `- ${store.workspaceDir}`, `- ${store.globalDir}`);
  const problems = problemLines(store, settings);
  if (problems.length) lines.push("Problems:", ...problems.map((problem) => `- ${problem}`));
  lines.push(USAGE);
  return lines.join("\n");
}

function consoleEntries(store: SnippetStore, settings: SnippetSettings): ConsoleEntry[] {
  return store.entries.map((snippet) => ({ snippet, trigger: triggerWord(settings, snippet.key) }));
}

const idOf = (store: SnippetStore, scope: SnippetScope, key: string): string | undefined =>
  store.entries.find((entry) => entry.scope === scope && entry.key === key)?.id;

/** A key is taken by a loaded snippet, or by a file in that scope that failed to load (saving would overwrite it). */
function keyTaken(store: SnippetStore): KeyTaken {
  return (scope, key) => {
    const path = join(scope === "global" ? store.globalDir : store.workspaceDir, `${key}.md`);
    return idOf(store, scope, key) !== undefined || store.problems.some((problem) => problem.path === path);
  };
}

/** The key, re-asked until it is valid and free, and the scope of a new snippet. Undefined when cancelled. */
async function dialogKey(
  ctx: ExtensionCommandContext,
  store: SnippetStore,
  original?: SnippetEntry,
): Promise<{ key: string; scope: SnippetScope } | undefined> {
  const taken = keyTaken(store);
  const ask = original ? `Key for ${original.key}; leave empty to keep it` : "New snippet key";
  let title = ask;
  let scope = original?.scope;
  for (;;) {
    const typed = await ctx.ui.input(title, original?.key ?? KEY_HINT);
    if (typed === undefined) return undefined;
    const key = typed.trim() || original?.key || "";
    // A new snippet's scope is chosen once its key is well-formed; a collision there re-asks only the key.
    const shape = keyProblem(key, "global", () => false);
    if (!shape && !scope) {
      const scopes: Array<readonly [string, SnippetScope]> = [
        [`Workspace: ${store.workspaceDir}`, "workspace"],
        [`Global: ${store.globalDir}`, "global"],
      ];
      const picked = await ctx.ui.select(
        `Where should ${key} live?`,
        scopes.map(([label]) => label),
      );
      scope = scopes.find(([label]) => label === picked)?.[1];
      if (!scope) return undefined;
    }
    const problem = shape ?? (scope ? keyProblem(key, scope, taken, original?.key) : undefined);
    if (!problem && scope) return { key, scope };
    title = `${problem} ${ask}`;
  }
}

/** Host dialogs for clients without the form: key, scope, description, then the body alone. Undefined when any step is cancelled. */
async function dialogDraft(ctx: ExtensionCommandContext, store: SnippetStore, original?: SnippetEntry): Promise<SnippetDraft | undefined> {
  const named = await dialogKey(ctx, store, original);
  if (!named) return undefined;
  const current = original?.description ?? "";
  const typed = await ctx.ui.input(
    current
      ? `Description of ${named.key}; leave empty to keep "${current}", or enter - to clear it`
      : `Description of ${named.key} (optional)`,
    "one line",
  );
  if (typed === undefined) return undefined;
  const description = typed.trim() === "-" ? "" : typed.trim() || current;
  const body = await ctx.ui.editor(`Body of ${named.key}`, original?.body ?? "");
  if (body === undefined) return undefined;
  return { ...named, description, body };
}

/** The new or edited snippet from the form (terminal and Tern) or from host dialogs (RPC, ACP). */
async function snippetDraft(ctx: ExtensionCommandContext, store: SnippetStore, original?: SnippetEntry): Promise<SnippetDraft | undefined> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return dialogDraft(ctx, store, original);
  const options = {
    original,
    scope: "workspace" as const,
    dirs: { global: store.globalDir, workspace: store.workspaceDir },
    taken: keyTaken(store),
  };
  return ctx.ui.custom<SnippetDraft | undefined>((tui, theme, _keys, done) => new SnippetForm(theme, tui, options, done), FORM_OVERLAY);
}

async function createSnippet(ctx: ExtensionCommandContext, store: SnippetStore): Promise<Step> {
  const draft = await snippetDraft(ctx, store);
  if (!draft) return info("No snippet created.");
  await store.write(draft.scope, draft.key, formatSnippetSource(draft.description, draft.body));
  return { ...info(`Created ${draft.scope} snippet ${draft.key}.`), target: { scope: draft.scope, key: draft.key } };
}

/** A changed key renames the file (keeping its state), then changed text is written under the new key. */
async function editSnippet(ctx: ExtensionCommandContext, store: SnippetStore, entry: SnippetEntry): Promise<Step> {
  const draft = await snippetDraft(ctx, store, entry);
  const unchanged = info(`${entry.key} was not changed.`);
  if (!draft) return unchanged;
  const source = formatSnippetSource(draft.description, draft.body);
  const textChanged = source !== formatSnippetSource(entry.description, entry.body);
  if (draft.key === entry.key && !textChanged) return unchanged;
  if (draft.key !== entry.key) await store.rename(entry.scope, entry.key, draft.key);
  if (textChanged) await store.write(entry.scope, draft.key, source);
  return {
    ...info(`Saved ${entry.scope} snippet ${draft.key}${draft.key === entry.key ? "" : ` (was ${entry.key})`}.`),
    target: { scope: entry.scope, key: draft.key },
  };
}

async function deleteSnippet(ctx: ExtensionCommandContext, store: SnippetStore, entry: SnippetEntry): Promise<Step> {
  const remove = `Delete ${entry.path}`;
  const picked = await ctx.ui.select(`Delete the ${entry.scope} snippet ${entry.key}?`, [remove, `Keep ${entry.key}`]);
  if (picked !== remove) return info(`${entry.key} was kept.`);
  await store.remove(entry.scope, entry.key);
  const revealed = entry.scope === "workspace" && idOf(store, "global", entry.key);
  return info(`Deleted ${entry.scope} snippet ${entry.key}.${revealed ? " The global one takes over." : ""}`);
}

/** Inserts or sends the body and counts one use. */
async function use(ctx: ExtensionCommandContext, deps: SnippetCommandDeps, entry: SnippetEntry, how: "insert" | "send"): Promise<void> {
  if (!entry.body) throw new Error(`Snippet ${entry.key} has an empty body.`);
  if (how === "insert") {
    if (!ctx.hasUI || !ctx.ui.supportsEditor)
      throw new Error(`This client has no editor to insert into; use /snippets send ${entry.key} instead.`);
    ctx.ui.pasteToEditor(entry.body);
  } else deps.send(entry.body);
  try {
    await deps.store.recordUse([entry.id]);
  } catch (error) {
    notice(ctx, deps, `Snippet usage could not be saved: ${errorText(error)}`, "warning");
  }
  await deps.changed();
}

/** One state or file change for one snippet. */
async function mutate(
  ctx: ExtensionCommandContext,
  store: SnippetStore,
  action: Exclude<EntryAction, "insert" | "send">,
  entry: SnippetEntry,
): Promise<Step> {
  if (action === "edit") return editSnippet(ctx, store, entry);
  if (action === "delete") return deleteSnippet(ctx, store, entry);
  if (action === "toggle") {
    await store.setEnabled(entry.id, !entry.enabled);
    return info(entry.enabled ? `Disabled ${entry.key}; its shortcut no longer expands.` : `Enabled ${entry.key}.`);
  }
  await store.setPinned(entry.id, !entry.pinned);
  return info(`${entry.pinned ? "Unpinned" : "Pinned"} ${entry.key}.`);
}

/** Runs one menu action. Mutations reload the store and say where the selection belongs; failures become an error line. */
async function act(ctx: ExtensionCommandContext, deps: SnippetCommandDeps, action: Action, entry?: SnippetEntry): Promise<Outcome> {
  try {
    let step: Step;
    if (action === "new") step = await createSnippet(ctx, deps.store);
    else if (!entry) throw new Error("That snippet no longer exists.");
    else if (action === "insert" || action === "send") {
      await use(ctx, deps, entry, action);
      return "done";
    } else step = await mutate(ctx, deps.store, action, entry);
    await deps.changed();
    const target = step.target ?? (entry ? { scope: entry.scope, key: entry.key } : undefined);
    return { message: step.message, selectedId: target ? idOf(deps.store, target.scope, target.key) : undefined };
  } catch (error) {
    let text = errorText(error);
    try {
      await deps.changed();
    } catch (reloadError) {
      text += ` Refresh failed: ${errorText(reloadError)}`;
    }
    return { message: { text, level: "error" } };
  }
}

/** Fullscreen console (terminal and Tern); it re-opens with filter, search and selection after every mutation. */
async function consoleMenu(ctx: ExtensionCommandContext, deps: SnippetCommandDeps): Promise<void> {
  let state: ConsoleState = { query: "" };
  let message: ConsoleMessage | undefined;
  for (;;) {
    const settings = await deps.settings();
    const entries = consoleEntries(deps.store, settings);
    const notice = problemNotice(deps.store, settings);
    const [result, next] = await ctx.ui.custom<[ConsoleResult, ConsoleState]>(
      (tui, theme, _keys, done) =>
        new SnippetConsole(entries, state, theme, tui, (picked, after) => done([picked, after]), { message, notice }),
      FULLSCREEN,
    );
    state = next;
    if (result.kind === "close") return;
    const entry = result.kind === "action" ? deps.store.entries.find((candidate) => candidate.id === result.id) : undefined;
    const outcome = await act(ctx, deps, result.kind === "new" ? "new" : result.action, entry);
    if (outcome === "done") return;
    message = outcome.message;
    if (outcome.selectedId) state = { ...state, selectedId: outcome.selectedId };
  }
}

/** Host dialogs for clients that cannot mount the console (RPC, ACP): a snippet list, then its actions. */
async function dialogMenu(ctx: ExtensionCommandContext, deps: SnippetCommandDeps): Promise<void> {
  const NEW = "New snippet…";
  let selectedId: string | undefined;
  for (;;) {
    const settings = await deps.settings();
    const entries = deps.store.entries;
    const labels = entries.map((entry) => `${entry.key} [${marks(entry)}]${entry.description ? ` — ${entry.description}` : ""}`);
    const problem = problemNotice(deps.store, settings);
    const picked = await ctx.ui.select(`Snippets: ${summary(entries)}${problem ? `\n${problem.text}` : ""}`, [...labels, NEW], {
      initialIndex: Math.max(
        0,
        entries.findIndex((entry) => entry.id === selectedId),
      ),
    });
    if (picked === undefined) return;
    const entry = entries[labels.indexOf(picked)];
    let action: Action | "back" = "new";
    if (entry) {
      selectedId = entry.id;
      action = await chooseAction(ctx, entry, settings);
      if (action === "back") continue;
    }
    const outcome = await act(ctx, deps, action, entry);
    if (outcome === "done") return;
    ctx.ui.notify(outcome.message.text, outcome.message.level);
    selectedId = outcome.selectedId ?? selectedId;
  }
}

/** One snippet's actions; "View" opens its full text read-only and comes back here. */
async function chooseAction(ctx: ExtensionCommandContext, entry: SnippetEntry, settings: SnippetSettings): Promise<Action | "back"> {
  const fields = snippetFields({ snippet: entry, trigger: triggerWord(settings, entry.key) }, []);
  const title = `${entry.key}${entry.description ? ` — ${entry.description}` : ""}\n${fields
    .filter(([label]) => label !== "Path")
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ")}`;
  const options: Array<readonly [string, Action | "view" | "back"]> = [
    ...(ctx.ui.supportsEditor ? [["Insert at cursor", "insert"] as const] : []),
    ["Send now", "send"],
    ["View the full text", "view"],
    ["Edit…", "edit"],
    [entry.enabled ? "Disable" : "Enable", "toggle"],
    [entry.pinned ? "Unpin" : "Pin", "pin"],
    ["Delete…", "delete"],
    [BACK, "back"],
  ];
  for (;;) {
    const picked = await ctx.ui.select(
      title,
      options.map(([label]) => label),
    );
    const action = options.find(([label]) => label === picked)?.[1] ?? "back";
    if (action !== "view") return action;
    await ctx.ui.editor(`${entry.path} (read-only, edits are discarded)`, entry.body);
  }
}

/** Command-form use resolves only snippets whose shortcut is live: enabled and not shadowed. */
function activeEntry(store: SnippetStore, key: string): SnippetEntry {
  const entry = store.active().find((candidate) => candidate.key === key);
  if (entry) return entry;
  if (store.entries.some((candidate) => candidate.key === key)) throw new Error(`Snippet ${key} is disabled; enable it from /snippets.`);
  throw new Error(`Unknown snippet ${key}. Run /snippets list for keys.`);
}

export async function runSnippetCommand(args: string, ctx: ExtensionCommandContext, deps: SnippetCommandDeps): Promise<void> {
  const [word, rest] = head(args);
  try {
    if (!word) {
      if (!ctx.hasUI) deps.message(listText(deps.store, await deps.settings()));
      else if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") await consoleMenu(ctx, deps);
      else await dialogMenu(ctx, deps);
    } else if (word === "list") {
      if (rest) throw new Error(USAGE);
      deps.message(listText(deps.store, await deps.settings()));
    } else if (word === "send") {
      if (!rest || /\s/.test(rest)) throw new Error("Usage: /snippets send <key>");
      await use(ctx, deps, activeEntry(deps.store, rest), "send");
    } else {
      if (rest) throw new Error(USAGE);
      await use(ctx, deps, activeEntry(deps.store, word), "insert");
    }
  } catch (error) {
    notice(ctx, deps, errorText(error), "error");
  }
}

const SUBCOMMANDS: readonly AutocompleteItem[] = [
  { value: "list", label: "list", description: "Post every snippet as a message" },
  { value: "send ", label: "send <key>", description: "Send a snippet as your message now" },
];

export function snippetArgumentCompletions(prefix: string, entries: readonly SnippetEntry[]): AutocompleteItem[] | null {
  const active = entries.filter((entry) => entry.enabled && !entry.shadowed);
  const keys = (typed: string, word: string): AutocompleteItem[] =>
    active
      .filter((entry) => entry.key.startsWith(typed))
      .map((entry) => ({
        value: `${word}${entry.key}`,
        label: entry.key,
        description: `${entry.scope}${entry.description ? ` · ${entry.description}` : ""}`,
      }));
  const send = /^send\s+(\S*)$/.exec(prefix);
  let items: AutocompleteItem[];
  if (send) items = keys(send[1] ?? "", "send ");
  else if (/\s/.test(prefix)) return null;
  else items = [...SUBCOMMANDS.filter((item) => item.value.startsWith(prefix.toLowerCase())), ...keys(prefix, "")];
  return items.length ? items : null;
}
