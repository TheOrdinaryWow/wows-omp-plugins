import type { Keybinding } from "@oh-my-pi/pi-coding-agent/config/keybindings/app-keybindings";
import type { KeyEvent, TextEdit } from "@oh-my-pi/pi-tui";

/** A text field the program owns: its text and caret (a UTF-16 offset). */
export interface Field {
  readonly text: string;
  readonly cursor: number;
}

/** The keymap the factory receives; only its chord matching is used. */
export interface FieldKeys {
  matches(event: KeyEvent, action: Keybinding): boolean;
}

export const field = (text: string): Field => ({ text, cursor: text.length });

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeBefore(text: string, at: number): number {
  let previous = 0;
  for (const { index } of segmenter.segment(text)) {
    if (index >= at) break;
    previous = index;
  }
  return previous;
}

function graphemeAfter(text: string, at: number): number {
  for (const { index, segment } of segmenter.segment(text)) if (index >= at) return index + segment.length;
  return text.length;
}

/** `at` moved back to the start of the grapheme it falls inside, so the caret never splits one. */
function graphemeFloor(text: string, at: number): number {
  let floor = 0;
  for (const { index } of segmenter.segment(text)) {
    if (index > at) break;
    floor = index;
  }
  return at >= text.length ? text.length : floor;
}

function wordBefore(text: string, at: number): number {
  let i = at;
  while (i > 0 && /\s/.test(text[i - 1] ?? "")) i--;
  while (i > 0 && !/\s/.test(text[i - 1] ?? "")) i--;
  return i;
}

function wordAfter(text: string, at: number): number {
  let i = at;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  while (i < text.length && !/\s/.test(text[i] ?? "")) i++;
  return i;
}

// `lastIndexOf` clamps a negative start to 0, which would find a line break at offset 0 itself.
const lineStart = (text: string, at: number): number => (at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1);

function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end;
}

/** The caret one logical line up or down, at the same column where the line is long enough, on a grapheme boundary. */
function verticalMove(text: string, at: number, delta: -1 | 1): number {
  const start = lineStart(text, at);
  const column = at - start;
  if (delta < 0) {
    if (start === 0) return 0;
    const previous = lineStart(text, start - 1);
    return graphemeFloor(text, Math.min(previous + column, start - 1));
  }
  const end = lineEnd(text, at);
  if (end === text.length) return text.length;
  return graphemeFloor(text, Math.min(end + 1 + column, lineEnd(text, end + 1)));
}

/**
 * Text cut by word and line deletions, newest last. Yank pastes the newest; Yank Pop right after a yank swaps the
 * pasted text for the entry before it, cycling.
 */
export class KillRing {
  readonly #entries: string[] = [];
  /** The last yank: the text it produced, the range it pasted and the entry it used. */
  #yank: { text: string; from: number; to: number; index: number } | undefined;

  kill(text: string): void {
    if (text) this.#entries.push(text);
  }

  yank(state: Field, multiline: boolean): Field | undefined {
    if (!this.#entries.length) return undefined;
    return this.#place(state, state.cursor, state.cursor, this.#entries.length - 1, multiline);
  }

  yankPop(state: Field, multiline: boolean): Field | undefined {
    const last = this.#yank;
    if (!last || last.text !== state.text || last.to !== state.cursor || this.#entries.length < 2) return undefined;
    const index = (last.index - 1 + this.#entries.length) % this.#entries.length;
    return this.#place(state, last.from, last.to, index, multiline);
  }

  #place(state: Field, from: number, to: number, index: number, multiline: boolean): Field {
    const pasted = insertText(
      { text: state.text.slice(0, from) + state.text.slice(to), cursor: from },
      this.#entries[index] ?? "",
      multiline,
    );
    this.#yank = { text: pasted.text, from, to: pasted.cursor, index };
    return pasted;
  }
}

/** `text` typed or pasted at the caret; a one-line field flattens line breaks to spaces. */
export function insertText(state: Field, text: string, multiline = false): Field {
  const typed = multiline ? text.replace(/\r\n?/g, "\n") : text.replace(/[\r\n]+/g, " ");
  return { text: state.text.slice(0, state.cursor) + typed + state.text.slice(state.cursor), cursor: state.cursor + typed.length };
}

/** A Tern edit over the field; undefined when it was made against other text (stale). */
export function applyEdit(state: Field, edit: Pick<TextEdit, "from" | "to" | "text" | "cursor" | "len">): Field | undefined {
  if (edit.len !== state.text.length || edit.from < 0 || edit.to > state.text.length || edit.from > edit.to) return undefined;
  const text = state.text.slice(0, edit.from) + edit.text + state.text.slice(edit.to);
  return { text, cursor: Math.max(0, Math.min(text.length, edit.cursor)) };
}

const EDITS = [
  "tui.editor.cursorLeft",
  "tui.editor.cursorRight",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd",
] as const satisfies readonly Keybinding[];

const LINE_EDITS = ["tui.editor.cursorUp", "tui.editor.cursorDown", "tui.input.newLine"] as const satisfies readonly Keybinding[];

/**
 * `key` applied to the field by the user's `tui.editor.*` bindings, or typed when printable; undefined when the key
 * is not an edit. A multi-line field also moves between lines and takes the new-line chord. With a kill ring, word and
 * line deletions keep what they cut, and the yank bindings paste it back.
 */
export function editField(state: Field, key: KeyEvent, keys: FieldKeys, multiline = false, ring?: KillRing): Field | undefined {
  const { text, cursor } = state;
  const at = (next: number): Field => ({ text, cursor: next });
  const cut = (from: number, to: number): Field => ({ text: text.slice(0, from) + text.slice(to), cursor: from });
  const kill = (from: number, to: number): Field => {
    ring?.kill(text.slice(from, to));
    return cut(from, to);
  };
  if (multiline)
    switch (LINE_EDITS.find((action) => keys.matches(key, action))) {
      case "tui.editor.cursorUp":
        return at(verticalMove(text, cursor, -1));
      case "tui.editor.cursorDown":
        return at(verticalMove(text, cursor, 1));
      case "tui.input.newLine":
        return insertText(state, "\n", true);
    }
  if (ring && keys.matches(key, "tui.editor.yank")) return ring.yank(state, multiline) ?? state;
  if (ring && keys.matches(key, "tui.editor.yankPop")) return ring.yankPop(state, multiline) ?? state;
  const start = multiline ? lineStart(text, cursor) : 0;
  const end = multiline ? lineEnd(text, cursor) : text.length;
  switch (EDITS.find((action) => keys.matches(key, action))) {
    case "tui.editor.cursorLeft":
      return at(graphemeBefore(text, cursor));
    case "tui.editor.cursorRight":
      return at(graphemeAfter(text, cursor));
    case "tui.editor.cursorLineStart":
      return at(start);
    case "tui.editor.cursorLineEnd":
      return at(end);
    case "tui.editor.cursorWordLeft":
      return at(wordBefore(text, cursor));
    case "tui.editor.cursorWordRight":
      return at(wordAfter(text, cursor));
    case "tui.editor.deleteCharBackward":
      return cursor === 0 ? state : cut(graphemeBefore(text, cursor), cursor);
    case "tui.editor.deleteCharForward":
      return cursor >= text.length ? state : cut(cursor, graphemeAfter(text, cursor));
    case "tui.editor.deleteWordBackward":
      return kill(wordBefore(text, cursor), cursor);
    case "tui.editor.deleteWordForward":
      return kill(cursor, wordAfter(text, cursor));
    case "tui.editor.deleteToLineStart":
      // At the line's start the line break before it goes.
      return kill(cursor === start ? Math.max(0, start - 1) : start, cursor);
    case "tui.editor.deleteToLineEnd":
      return kill(cursor, cursor === end ? Math.min(text.length, end + 1) : end);
  }
  const typed = key.text;
  if (key.kind === "release" || typed === undefined || typed === "" || /\p{Cc}/u.test(typed)) return undefined;
  return insertText(state, typed, multiline);
}
