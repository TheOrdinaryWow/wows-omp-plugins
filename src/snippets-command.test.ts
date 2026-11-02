import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionCommandContext, ExtensionUISelectItem } from "@oh-my-pi/pi-coding-agent";
import { type Component, initTheme, type TUI, theme } from "@oh-my-pi/pi-tui";

import { runSnippetCommand, type SnippetCommandDeps, snippetArgumentCompletions } from "../plugins/snippets/src/command.ts";
import type { SnippetSettings } from "../plugins/snippets/src/settings.ts";
import { formatSnippetSource } from "../plugins/snippets/src/snippet.ts";
import { SnippetStore } from "../plugins/snippets/src/store.ts";

beforeAll(async () => {
  await initTheme();
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const settings: SnippetSettings = { trigger: ".", matching: "closed" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "snippets-command-"));
  dirs.push(root);
  const store = new SnippetStore({ cwd: root, globalDir: join(root, "global"), statePath: join(root, "state.json") });
  await store.write("global", "kyc", formatSnippetSource("Global KYC", "Global questionnaire"));
  await store.write("workspace", "kyc", formatSnippetSource("Workspace KYC", "Workspace questionnaire"));
  await store.write("global", "sig", formatSnippetSource("Email signature", "Best regards,\nLi"));
  return { root, store };
}

interface Script {
  mode?: string;
  hasUI?: boolean;
  supportsEditor?: boolean;
  answers?: Array<RegExp | undefined>;
  inputs?: Array<string | undefined>;
  edits?: Array<string | undefined>;
  keys?: string[][];
}

/** A real store with a scripted host UI. A missing answer cancels, so each test chooses its complete interaction. */
function scripted(store: SnippetStore, script: Script = {}, currentSettings = settings) {
  const { answers = [], inputs = [], edits = [], keys = [] } = script;
  const titles: string[] = [];
  const options: string[][] = [];
  const inputTitles: string[] = [];
  const editorTitles: string[] = [];
  const prefills: string[] = [];
  const pasted: string[] = [];
  const messages: string[] = [];
  const sent: string[] = [];
  const notifications: Array<{ text: string; level: string }> = [];
  const frames: string[] = [];
  const customOptions: unknown[] = [];
  let changes = 0;
  const ui = {
    supportsEditor: script.supportsEditor ?? true,
    async select(title: string, items: ExtensionUISelectItem[]) {
      titles.push(title);
      const labels = items.map((item) => (typeof item === "string" ? item : item.label));
      options.push(labels);
      const answer = answers.shift();
      const picked = answer ? labels.find((label) => answer.test(label)) : undefined;
      if (answer && picked === undefined) throw new Error(`No option matches ${answer}: ${labels.join("; ")}`);
      return picked;
    },
    async input(title: string) {
      inputTitles.push(title);
      return inputs.shift();
    },
    async editor(title: string, prefill: string) {
      editorTitles.push(title);
      prefills.push(prefill);
      return edits.shift();
    },
    pasteToEditor(text: string) {
      pasted.push(text);
    },
    notify(text: string, level: string) {
      notifications.push({ text, level });
    },
    custom(factory: (tui: TUI, th: typeof theme, keybindings: unknown, done: (value: unknown) => void) => Component, opts: unknown) {
      const script = keys.shift();
      if (!script) throw new Error("custom must not be called");
      customOptions.push(opts);
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const tui = { requestRender() {}, terminal: { rows: 30 } } as unknown as TUI;
      const component = factory(tui, theme, undefined, resolve);
      frames.push(Bun.stripANSI(component.render(120).join("\n")));
      for (const key of script) component.handleInput?.(key);
      return promise;
    },
  };
  const ctx = {
    cwd: store.workspaceDir,
    hasUI: script.hasUI ?? true,
    mode: script.mode ?? "tui",
    ui,
  } as unknown as ExtensionCommandContext;
  const deps: SnippetCommandDeps = {
    store,
    settings: async () => currentSettings,
    send: (text) => sent.push(text),
    message: (text) => messages.push(text),
    changed: async () => {
      changes++;
      await store.load();
    },
  };
  return {
    ctx,
    deps,
    titles,
    options,
    inputTitles,
    editorTitles,
    prefills,
    pasted,
    messages,
    sent,
    notifications,
    frames,
    customOptions,
    get changes() {
      return changes;
    },
  };
}

test("command forms insert without sending, send explicitly, count one use, and follow workspace precedence", async () => {
  const { store } = await fixture();
  const run = scripted(store);
  await runSnippetCommand("kyc", run.ctx, run.deps);
  expect(run.pasted).toEqual(["Workspace questionnaire"]);
  expect(run.sent).toEqual([]);
  expect(store.entries.find((entry) => entry.key === "kyc" && entry.scope === "workspace")?.uses).toBe(1);
  expect(store.entries.find((entry) => entry.key === "kyc" && entry.scope === "global")?.uses).toBe(0);
  await runSnippetCommand("send sig", run.ctx, run.deps);
  expect(run.sent).toEqual(["Best regards,\nLi"]);
  expect(store.entries.find((entry) => entry.key === "sig")?.uses).toBe(1);
  expect(run.changes).toBe(2);
  expect(run.notifications).toEqual([]);
});

test("disabled keys, unknown keys, empty bodies and malformed forms never insert or send", async () => {
  const { store } = await fixture();
  const sig = store.entries.find((entry) => entry.key === "sig");
  if (!sig) throw new Error("Missing fixture snippet");
  await store.setEnabled(sig.id, false);
  await store.write("global", "blank", formatSnippetSource("", ""));
  const run = scripted(store);
  for (const form of ["sig", "send sig", "unknown", "send", "send sig extra", "list extra", "kyc extra", "send blank"])
    await runSnippetCommand(form, run.ctx, run.deps);
  expect(run.pasted).toEqual([]);
  expect(run.sent).toEqual([]);
  expect(run.notifications).toHaveLength(8);
  expect(run.notifications.map((notice) => notice.text).join("\n")).toMatch(/disabled/);
  expect(run.notifications.map((notice) => notice.text).join("\n")).toMatch(/Unknown snippet unknown/);
  expect(run.notifications.at(-1)?.text).toMatch(/empty body/);
  expect(run.changes).toBe(0);
});

test("fullscreen re-opens after pinning with filter, query and selection kept, and Enter pastes one use", async () => {
  const { store } = await fixture();
  const run = scripted(store, { keys: [["\t", "s", "i", "g", "P"], ["\r"]] });
  await runSnippetCommand("", run.ctx, run.deps);
  expect(run.frames).toHaveLength(2);
  const after = run.frames[1] ?? "";
  expect(after).toMatch(/Search: sig/);
  expect(after).toMatch(/Pinned sig\./);
  expect(after).toMatch(/State +enabled, pinned/);
  expect(after).not.toMatch(/kyc {2}/);
  expect(run.customOptions).toEqual([
    { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } },
    { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } },
  ]);
  expect(store.entries.find((entry) => entry.key === "sig")).toMatchObject({ pinned: true, uses: 1 });
  expect(run.pasted).toEqual(["Best regards,\nLi"]);
  expect(run.sent).toEqual([]);
  expect(run.changes).toBe(2);
});

/** Keystrokes typing `text` one character at a time. */
const typed = (text: string): string[] => [...text];
const FULLSCREEN = { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } };
const FORM = { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "90%" } };

test("new opens the form, refuses a taken key without writing, then creates the file and re-opens on it", async () => {
  const { store } = await fixture();
  const run = scripted(store, {
    keys: [
      ["N"],
      [
        ...typed("kyc"),
        "\x13",
        ...Array<string>(3).fill("\x7f"),
        ...typed("fresh"),
        "\t",
        "\t",
        ...typed("New description"),
        "\t",
        ...typed("# literal Markdown"),
        "\r",
        ...typed("{{not a template}}"),
        "\x13",
      ],
      ["\x1b"],
    ],
  });
  await runSnippetCommand("", run.ctx, run.deps);
  expect(run.frames[1]).toMatch(/New snippet/);
  expect(run.frames[1]).not.toMatch(/description:/);
  expect(store.entries.find((entry) => entry.key === "kyc" && entry.scope === "workspace")?.body).toBe("Workspace questionnaire");
  const created = store.entries.find((entry) => entry.key === "fresh");
  expect(created).toMatchObject({ scope: "workspace", description: "New description", body: "# literal Markdown\n{{not a template}}" });
  expect(await readFile(created?.path ?? "", "utf8")).toBe(
    formatSnippetSource("New description", "# literal Markdown\n{{not a template}}"),
  );
  expect(run.frames.at(-1)).toMatch(/fresh {2}New description/);
  expect(run.frames.at(-1)).toMatch(/Created workspace snippet fresh/);
  expect(run.customOptions).toEqual([FULLSCREEN, FORM, FULLSCREEN]);
  expect(run.changes).toBe(1);
});

test("edit opens the form prefilled, refuses a rename collision inline, renames with state kept, and selects the new key", async () => {
  const { store } = await fixture();
  const entry = store.entries.find((entry) => entry.key === "sig");
  if (!entry) throw new Error("Missing fixture snippet");
  await store.setPinned(entry.id, true);
  await store.recordUse([entry.id, entry.id]);
  const clear = (count: number) => Array<string>(count).fill("\x7f");
  const run = scripted(store, {
    keys: [
      ["E"],
      [...clear(3), ...typed("kyc"), "\x13", ...clear(3), ...typed("signoff"), "\t", ...clear(15), ...typed("Signature"), "\x13"],
      ["\x1b"],
    ],
  });
  await runSnippetCommand("", run.ctx, run.deps);
  expect(run.frames[1]).toMatch(/Edit sig/);
  expect(run.frames[1]).toMatch(/Email signature/);
  expect(run.frames[1]).toMatch(/Best regards,/);
  expect(run.frames[1]).not.toMatch(/description:/);
  expect(store.entries.some((entry) => entry.key === "sig")).toBe(false);
  expect(store.entries.find((entry) => entry.key === "signoff")).toMatchObject({
    description: "Signature",
    body: "Best regards,\nLi",
    pinned: true,
    uses: 2,
  });
  expect(run.frames[2]).toMatch(/signoff {2}Signature/);
  expect(run.frames[2]).toMatch(/Saved global snippet signoff \(was sig\)/);
  expect(run.changes).toBe(1);
});

test("non-TUI new and edit use step dialogs: key re-prompts, scope, description, then the body alone", async () => {
  const { store } = await fixture();
  const create = scripted(store, {
    mode: "rpc",
    answers: [/^New snippet/, /^Workspace:/, undefined],
    inputs: ["bad key", "kyc", "fresh", "Greeting"],
    edits: ["Hello\n"],
  });
  await runSnippetCommand("", create.ctx, create.deps);
  expect(create.inputTitles[1]).toMatch(/not a valid key/);
  expect(create.inputTitles[2]).toMatch(/workspace snippet named kyc already exists/);
  expect(create.options.filter((labels) => labels.some((label) => label.startsWith("Workspace:")))).toHaveLength(1);
  expect(create.prefills).toEqual([""]);
  expect(store.entries.find((entry) => entry.key === "fresh")).toMatchObject({
    scope: "workspace",
    description: "Greeting",
    body: "Hello",
  });
  expect(create.notifications.at(-1)?.text).toBe("Created workspace snippet fresh.");
  const edit = scripted(store, { mode: "rpc", answers: [/^sig \[/, /^Edit…$/, undefined], inputs: ["", "-"], edits: ["New signoff"] });
  await runSnippetCommand("", edit.ctx, edit.deps);
  expect(edit.prefills).toEqual(["Best regards,\nLi"]);
  expect(edit.inputTitles[1]).toMatch(/keep "Email signature", or enter - to clear it/);
  expect(store.entries.find((entry) => entry.key === "sig")).toMatchObject({ description: "", body: "New signoff" });
  expect(edit.customOptions).toEqual([]);
});

test("enable and disable change expansion eligibility, while deleting requires the named destructive choice", async () => {
  const { store } = await fixture();
  const toggles = scripted(store, { keys: [["s", "i", "g", "D"], ["D"], ["\x1b", "\x1b"]] });
  await runSnippetCommand("", toggles.ctx, toggles.deps);
  expect(toggles.frames[1]).toMatch(/Disabled sig; its shortcut no longer expands/);
  expect(toggles.frames[1]).toMatch(/State +disabled/);
  expect(toggles.frames[2]).toMatch(/Enabled sig/);
  expect(store.active().some((entry) => entry.key === "sig")).toBe(true);
  const keep = scripted(store, { mode: "rpc", answers: [/^kyc \[workspace/, /^Delete/, /^Keep/, undefined] });
  await runSnippetCommand("", keep.ctx, keep.deps);
  expect(store.entries.filter((entry) => entry.key === "kyc")).toHaveLength(2);
  const remove = scripted(store, { mode: "rpc", answers: [/^kyc \[workspace/, /^Delete/, /^Delete /, undefined] });
  await runSnippetCommand("", remove.ctx, remove.deps);
  expect(store.entries.filter((entry) => entry.key === "kyc")).toHaveLength(1);
  expect(store.active().find((entry) => entry.key === "kyc")).toMatchObject({ scope: "global", shadowed: false });
  expect(remove.notifications.at(-1)?.text).toMatch(/The global one takes over/);
});

test("non-TUI uses select dialogs, previews as plain text, and can send without a custom component", async () => {
  const { store } = await fixture();
  const run = scripted(store, { mode: "rpc", answers: [/^sig \[/, /^View the full text$/, /^Send now$/] });
  await runSnippetCommand("", run.ctx, run.deps);
  expect(run.titles[0]).toBe("Snippets: 2 global, 1 workspace");
  expect(run.options[1]).toEqual(["Insert at cursor", "Send now", "View the full text", "Edit…", "Disable", "Pin", "Delete…", "← Back"]);
  expect(run.prefills).toEqual(["Best regards,\nLi"]);
  expect(run.editorTitles[0]).toMatch(/read-only/);
  expect(run.customOptions).toEqual([]);
  expect(run.sent).toEqual(["Best regards,\nLi"]);
  expect(store.entries.find((entry) => entry.key === "sig")?.uses).toBe(1);
});

test("non-TUI clients without a composer omit Insert and command insertion refuses without counting a use", async () => {
  const { store } = await fixture();
  const run = scripted(store, { mode: "rpc", supportsEditor: false, answers: [/^sig \[/, /^← Back$/, undefined] });
  await runSnippetCommand("", run.ctx, run.deps);
  expect(run.options[1]).not.toContain("Insert at cursor");
  await runSnippetCommand("sig", run.ctx, run.deps);
  expect(run.pasted).toEqual([]);
  expect(run.notifications.at(-1)?.text).toMatch(/no editor.*\/snippets send sig/);
  expect(store.entries.find((entry) => entry.key === "sig")?.uses).toBe(0);
});

test("no-UI forms report via displayed messages, include problems, refuse editor insertion, and still send explicitly", async () => {
  const { store } = await fixture();
  await writeFile(join(store.globalDir, "broken.md"), "---\nunknown: true\n---\nBody");
  await store.load();
  const run = scripted(store, { hasUI: false, mode: "rpc" }, { trigger: "", matching: "closed", problem: "Invalid snippet trigger" });
  await runSnippetCommand("", run.ctx, run.deps);
  expect(run.messages[0]).toMatch(/Snippets: 2 global, 1 workspace/);
  expect(run.messages[0]).toMatch(/shortcuts off \(invalid trigger\)/);
  expect(run.messages[0]).toMatch(/broken\.md: Snippet frontmatter supports only/);
  expect(run.messages[0]).toMatch(/Invalid snippet trigger/);
  expect(run.messages[0]).toMatch(/Usage: \/snippets \[/);
  await runSnippetCommand("sig", run.ctx, run.deps);
  expect(run.messages.at(-1)).toMatch(/no editor.*\/snippets send sig/);
  await runSnippetCommand("send kyc", run.ctx, run.deps);
  expect(run.sent).toEqual(["Workspace questionnaire"]);
  await runSnippetCommand("list", run.ctx, run.deps);
  expect(run.messages.at(-1)).toMatch(/kyc.*workspace, 1 use/);
  expect(run.notifications).toEqual([]);
  expect(run.options).toEqual([]);
});

test("completions offer subcommands and only enabled, non-shadowed keys, including send arguments", async () => {
  const { store } = await fixture();
  const sig = store.entries.find((entry) => entry.key === "sig");
  if (!sig) throw new Error("Missing fixture snippet");
  await store.setEnabled(sig.id, false);
  expect(snippetArgumentCompletions("", store.entries)?.map((item) => item.value)).toEqual(["list", "send ", "kyc"]);
  expect(snippetArgumentCompletions("k", store.entries)).toEqual([
    { value: "kyc", label: "kyc", description: "workspace · Workspace KYC" },
  ]);
  expect(snippetArgumentCompletions("send k", store.entries)).toEqual([
    { value: "send kyc", label: "kyc", description: "workspace · Workspace KYC" },
  ]);
  expect(snippetArgumentCompletions("send s", store.entries)).toBeNull();
  expect(snippetArgumentCompletions("send k extra", store.entries)).toBeNull();
  expect(snippetArgumentCompletions("K", store.entries)).toBeNull();
  expect(snippetArgumentCompletions("se", store.entries)?.map((item) => item.value)).toEqual(["send "]);
});
