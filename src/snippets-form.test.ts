import { afterEach, expect, test } from "bun:test";

import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

import { keyProblem, type SnippetDraft, SnippetForm, type SnippetFormOptions } from "../plugins/snippets/src/form.ts";
import type { SnippetScope } from "../plugins/snippets/src/snippet.ts";

const theme = loadThemeSync("dark");
const keys = KeybindingsManager.inMemory();
const existing: Record<string, true> = { "global:sig": true, "workspace:kyc": true };
const taken = (scope: SnippetScope, key: string) => existing[`${scope}:${key}`] === true;

const terminals: TestTerminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

function mount(options: Partial<SnippetFormOptions> = {}, { columns = 80, native = false } = {}) {
  const results: Array<SnippetDraft | undefined> = [];
  const form = new SnippetForm(
    { scope: "workspace", dirs: { global: "/home/.omp/agent/snippets", workspace: "/repo/.omp/snippets" }, taken, ...options },
    { keys, native },
    (draft) => results.push(draft),
  );
  const term = createTestTerminal(() => ({ dock: form.node }), { columns, rows: 40, theme });
  terminals.push(term);
  term.focus(form.node);
  /** Key ids are pressed, `"text"` arguments typed. */
  const press = (...steps: string[]) => {
    for (const step of steps)
      if (/^"/.test(step)) term.type(step.slice(1, -1));
      else term.press(step);
  };
  // Plain rows inside the frame's edges.
  const frame = () =>
    term
      .screen()
      .map((row) => row.replace(/^│ ?/, "").replace(/\s*│$/, "").replaceAll("\u00a0", " "))
      .join("\n");
  return { form, term, results, press, frame };
}

const edit = (text: string, from = 0, len = 0) =>
  ({ type: "edit", key: "", from, to: from, text, cursor: from + text.length, len }) as const;

test("key validation: shape, required, uniqueness within the scope, and the edited snippet's own key", () => {
  expect(keyProblem("", "global", taken)).toBe("Enter a key.");
  expect(keyProblem("bad key", "global", taken)).toMatch(/not a valid key/);
  expect(keyProblem("x".repeat(65), "global", taken)).toMatch(/not a valid key/);
  expect(keyProblem("kyc", "workspace", taken)).toMatch(/workspace snippet named kyc already exists/);
  expect(keyProblem("kyc", "global", taken)).toBeUndefined();
  expect(keyProblem("sig", "global", taken, "sig")).toBeUndefined();
  expect(keyProblem("sig", "global", taken, "old")).toMatch(/global snippet named sig already exists/);
});

test("the framed form fits 80 and 120 columns and names its fields, format hints, buttons and keys", () => {
  for (const columns of [80, 120]) {
    const { term, frame } = mount({}, { columns });
    for (const row of term.rows()) expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
    const shown = frame();
    expect(shown).toMatch(/New snippet/);
    expect(shown).toMatch(/Key {2}letters, digits, _ or -, up to 64/);
    expect(shown).toMatch(/Scope\n.*Global +Workspace +\/repo\/\.omp\/snippets/);
    expect(shown).toMatch(/Description {2}Optional, one line/);
    expect(shown).toMatch(/Body {2}The text the snippet inserts/);
    expect(shown).toMatch(/\[ Cancel ⎋ \] \[ Save \^S \]/);
    expect(shown).toMatch(/Tab\/Shift\+Tab field {2}· {2}Ctrl\+S save {2}· {2}Esc cancel/);
    expect(shown).not.toMatch(/Enter a key/);
  }
});

test("new: typing fills the focused field, Tab walks Key → Scope → Description → Body, Enter in Body breaks the line", () => {
  const { results, press, frame } = mount();
  press('"fresh"', "tab", "left", "tab", '"Greeting"', "enter");
  expect(frame()).toMatch(/Body .*Enter adds a line/);
  press('"Hello"', "enter", '"World"');
  expect(frame()).toMatch(/› Hello\n.*World/);
  press("ctrl+s");
  expect(results).toEqual([{ key: "fresh", scope: "global", description: "Greeting", body: "Hello\nWorld" }]);
});

test("an invalid or taken key shows inline, blocks Save and returns focus to the key", () => {
  const { results, press, frame } = mount();
  press("ctrl+s");
  expect(frame()).toMatch(/Enter a key\./);
  press('"bad key"');
  expect(frame()).toMatch(/"bad key" is not a valid key/);
  press("tab", "tab", '"desc"', "ctrl+s");
  expect(results).toEqual([]);
  // Save moved focus back to the key, so typing continues it.
  press(...Array<string>(7).fill("backspace"), '"kyc"');
  expect(frame()).toMatch(/workspace snippet named kyc already exists/);
  press("tab", "space");
  expect(frame()).not.toMatch(/already exists/);
  press("ctrl+s");
  expect(results).toEqual([{ key: "kyc", scope: "global", description: "desc", body: "" }]);
});

test("edit: prefilled, scope fixed and skipped by Tab, renaming onto a taken key is refused, Esc cancels", () => {
  const original: SnippetDraft = { key: "old", scope: "global", description: "Email", body: "Best regards,\nLi" };
  const { results, press, frame } = mount({ original });
  const shown = frame();
  expect(shown).toMatch(/Edit old/);
  expect(shown).toMatch(/changing it renames the file/);
  expect(shown).toMatch(/Global {2}\/home\/\.omp\/agent\/snippets/);
  expect(shown).toMatch(/Best regards,[^\n]*\n[^\n]*Li/);
  expect(shown).not.toMatch(/description:|---/);
  // Two Tabs from Key reach Body: Scope is skipped; the arrow in Description only moves its caret.
  press("tab", "left", "tab", "ctrl+e", "down", '"!"', "ctrl+s");
  expect(results).toEqual([{ key: "old", scope: "global", description: "Email", body: "Best regards,\nLi!" }]);
  const second = mount({ original });
  second.press("backspace", "backspace", "backspace", '"sig"', "ctrl+s");
  expect(second.frame()).toMatch(/global snippet named sig already exists/);
  expect(second.results).toEqual([]);
  second.press("escape");
  expect(second.results).toEqual([undefined]);
});

test("in a body that starts with a blank line, Home and Ctrl+U at its very start leave the text alone", () => {
  const original: SnippetDraft = { key: "gap", scope: "workspace", description: "", body: "\nsecond" };
  const { results, press } = mount({ original });
  // Key → Description → Body puts the caret at the body's end; Up reaches offset 0 on the empty first line.
  press("tab", "tab", "up", "home", "ctrl+u", "home", '"X"', "ctrl+s");
  expect(results).toEqual([{ key: "gap", scope: "workspace", description: "", body: "X\nsecond" }]);
});

test("moving between body lines never splits a character made of two code units", () => {
  const original: SnippetDraft = { key: "emoji", scope: "workspace", description: "", body: "a\n😀" };
  const { results, press } = mount({ original });
  // From after `a`, Down lands at column 1 of `😀`, which is inside it: the caret snaps to its start.
  press("tab", "tab", "up", "down", '"X"', "ctrl+s");
  expect(results).toEqual([{ key: "emoji", scope: "workspace", description: "", body: "a\nX😀" }]);
});

test("word and line cuts go to a kill ring: Ctrl+Y pastes the newest, Alt+Y right after swaps in the one before", () => {
  const { results, press } = mount();
  press('"one"', "ctrl+w", '"two"', "ctrl+w", "ctrl+y", "alt+y", "tab", "tab", "ctrl+y", "tab");
  press('"hello world"', "home", "ctrl+k", '"Hi "', "ctrl+y", "ctrl+s");
  expect(results).toEqual([{ key: "one", scope: "workspace", description: "two", body: "Hi hello world" }]);
});

test("Save and Cancel take the arrows and Enter; a paste lands in the focused field; undo steps back", () => {
  const { results, press, term, form } = mount();
  term.paste("multi\nline key");
  expect(form.draft.key).toBe("multi line key");
  press("ctrl+-");
  expect(form.draft.key).toBe("");
  press('"ok"', "tab", "tab", "tab");
  term.paste("one\ntwo");
  expect(form.draft.body).toBe("one\ntwo");
  press("tab", "right", "enter");
  expect(results).toEqual([undefined]);
});

test("Tern: a centered sheet whose fields take edits and focus, scope tabs and Save/Cancel clicks", () => {
  const { form, results } = mount({}, { native: true });
  expect(form.node.kind).toBe("overlay");
  expect(form.node.props()).toMatchObject({
    size: "md",
    anchor: "center",
    modal: true,
    head: "New snippet",
    role: "omp.overlay.snippets.form",
  });
  form.edit("key", edit("greet"));
  form.edit("description", edit("Hi"));
  expect(form.draft).toMatchObject({ key: "greet", description: "Hi" });
  form.edit("body", edit("line one\nline two"));
  form.undo("body");
  form.edit("body", edit("Body"));
  // A stale edit (made against other text) is dropped.
  form.edit("body", edit("X", 0, 99));
  form.pickScope("global");
  form.run("save");
  expect(results).toEqual([{ key: "greet", scope: "global", description: "Hi", body: "Body" }]);
  form.run("cancel");
  expect(results).toHaveLength(1);
});
