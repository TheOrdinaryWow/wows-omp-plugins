import { beforeAll, expect, test } from "bun:test";

import { type DescribeContext, initTheme, type NativeChild, type NativeNode, type TUI, theme } from "@oh-my-pi/pi-tui";

import { keyProblem, type SnippetDraft, SnippetForm, type SnippetFormOptions } from "../plugins/snippets/src/form.ts";
import type { SnippetScope } from "../plugins/snippets/src/snippet.ts";

beforeAll(async () => {
  await initTheme();
});

const existing = new Set(["global:sig", "workspace:kyc"]);
const taken = (scope: SnippetScope, key: string) => existing.has(`${scope}:${key}`);
const TAB = "\t";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const CTRL_S = "\x13";
const cx = { cols: 80, rows: 30, supports: () => true, feature: () => false } as unknown as DescribeContext;

function mount(options: Partial<SnippetFormOptions> = {}) {
  const results: Array<SnippetDraft | undefined> = [];
  const form = new SnippetForm(
    theme,
    { requestRender() {} } as unknown as TUI,
    { scope: "workspace", dirs: { global: "/home/.omp/agent/snippets", workspace: "/repo/.omp/snippets" }, taken, ...options },
    (draft) => results.push(draft),
  );
  form.focused = true;
  const type = (...keys: string[]) => {
    for (const key of keys) for (const part of key.length > 1 && !key.startsWith("\x1b") ? [...key] : [key]) form.handleInput(part);
  };
  const frame = () => Bun.stripANSI(form.render(80).join("\n"));
  return { form, results, type, frame };
}

/** Every node of a described tree, depth first. */
function nodes(root: NativeNode): NativeNode[] {
  const out: NativeNode[] = [root];
  for (const child of (root.c ?? []) as NativeChild[]) if (typeof child === "object" && child && "k" in child) out.push(...nodes(child));
  return out;
}

const live = (form: SnippetForm) => nodes(form.describe(cx)).filter((node) => node.k === "input" || node.k === "editor");

test("key validation: shape, required, uniqueness within the scope, and the edited snippet's own key", () => {
  expect(keyProblem("", "global", taken)).toBe("Enter a key.");
  expect(keyProblem("bad key", "global", taken)).toMatch(/not a valid key/);
  expect(keyProblem("x".repeat(65), "global", taken)).toMatch(/not a valid key/);
  expect(keyProblem("kyc", "workspace", taken)).toMatch(/workspace snippet named kyc already exists/);
  expect(keyProblem("kyc", "global", taken)).toBeUndefined();
  expect(keyProblem("sig", "global", taken, "sig")).toBeUndefined();
  expect(keyProblem("sig", "global", taken, "old")).toMatch(/global snippet named sig already exists/);
});

test("new: typing fills the focused field, Tab walks Key → Scope → Description → Body, Enter in Body breaks the line", () => {
  const { results, type, frame } = mount();
  expect(frame()).toMatch(/New snippet/);
  expect(frame()).not.toMatch(/Enter a key/);
  type("fresh", TAB, "\x1b[D", TAB, "Greeting", ENTER, "Hello", ENTER, "World", CTRL_S);
  expect(results).toEqual([{ key: "fresh", scope: "global", description: "Greeting", body: "Hello\nWorld" }]);
});

test("an invalid or taken key shows inline, blocks Save and returns focus to the key", () => {
  const { results, type, frame } = mount();
  type(CTRL_S);
  expect(frame()).toMatch(/Enter a key\./);
  type("bad key");
  expect(frame()).toMatch(/"bad key" is not a valid key/);
  type(TAB, TAB, "desc", CTRL_S);
  expect(results).toEqual([]);
  // Save moved focus back to the key, so typing continues it.
  type(...Array(7).fill(BACKSPACE), "kyc");
  expect(frame()).toMatch(/workspace snippet named kyc already exists/);
  type(TAB, " ");
  expect(frame()).not.toMatch(/already exists/);
  type(CTRL_S);
  expect(results).toEqual([{ key: "kyc", scope: "global", description: "desc", body: "" }]);
});

test("edit: prefilled, scope fixed and skipped by Tab, renaming onto a taken key is refused, Esc cancels", () => {
  const original: SnippetDraft = { key: "old", scope: "global", description: "Email", body: "Best regards,\nLi" };
  const { results, type, frame } = mount({ original });
  const shown = frame();
  expect(shown).toMatch(/Edit old/);
  expect(shown).toMatch(/Best regards,[^\n]*\n[^\n]*Li/);
  expect(shown).not.toMatch(/description:|---/);
  // Two Tabs from Key reach Body: Scope is skipped; the arrow in Description only moves its caret.
  type(TAB, "\x1b[D", TAB, "!", CTRL_S);
  expect(results).toEqual([{ key: "old", scope: "global", description: "Email", body: "Best regards,\nLi!" }]);
  const second = mount({ original });
  second.type(BACKSPACE, BACKSPACE, BACKSPACE, "sig", CTRL_S);
  expect(second.frame()).toMatch(/global snippet named sig already exists/);
  expect(second.results).toEqual([]);
  second.type("\x1b");
  expect(second.results).toEqual([undefined]);
});

test("Tern: only the focused field is live, edits go to it, clicks focus fields, pick the scope and save", () => {
  const { form, results } = mount();
  expect(live(form).map((node) => node.k)).toEqual(["input"]);
  form.handleNativeEvent({ type: "edit", key: "key/input", from: 0, to: 0, text: "greet", cursor: 5, len: 0 });
  expect(form.draft.key).toBe("greet");
  form.handleNativeEvent({ type: "action", key: "description", act: "focus-description", mods: [] });
  form.handleNativeEvent({ type: "edit", key: "description/input", from: 0, to: 0, text: "Hi", cursor: 2, len: 0 });
  expect(form.draft).toMatchObject({ key: "greet", description: "Hi" });
  form.handleNativeEvent({ type: "action", key: "body", act: "focus-body", mods: [] });
  expect(live(form).map((node) => node.k)).toEqual(["editor"]);
  form.handleNativeEvent({ type: "edit", key: "body/input", from: 0, to: 0, text: "line one\nline two", cursor: 17, len: 0 });
  form.handleNativeEvent({ type: "undo", key: "body/input" });
  form.handleNativeEvent({ type: "edit", key: "body/input", from: 0, to: 0, text: "Body", cursor: 4, len: 0 });
  // The key path Tern 0.9.8 reported for a click on the Global tab.
  form.handleNativeEvent({ type: "select", key: "scope/scope/scope-tabs", item: "global" });
  expect(live(form)).toEqual([]);
  form.handleNativeEvent({ type: "action", key: "actions", act: "save", mods: [] });
  expect(results).toEqual([{ key: "greet", scope: "global", description: "Hi", body: "Body" }]);
});
