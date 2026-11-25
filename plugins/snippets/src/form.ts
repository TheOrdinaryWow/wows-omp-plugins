import { batch, type JSXNode, type KeyEvent, type PasteEvent, type Signal, signal, type TextEdit, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";

import { applyEdit, editField, type Field, type FieldKeys, field, insertText, KillRing } from "#src/field.ts";
import { SNIPPET_KEY, type SnippetScope } from "#src/snippet.ts";
import { h, span } from "#src/tsp.ts";

/** What the form edits: the snippet's file name, where it lives, and its two parts. */
export interface SnippetDraft {
  key: string;
  scope: SnippetScope;
  description: string;
  body: string;
}

/** Whether a snippet file named `key` already exists in `scope`. */
export type KeyTaken = (scope: SnippetScope, key: string) => boolean;

export interface SnippetFormOptions {
  /** The snippet being edited; a new snippet has none. Its scope cannot change. */
  original?: SnippetDraft;
  /** The scope a new snippet starts in. */
  scope: SnippetScope;
  /** Directory of each scope, shown next to the scope choice. */
  dirs: Readonly<Record<SnippetScope, string>>;
  taken: KeyTaken;
}

/** What the form needs from its host. */
export interface FormEnv {
  /** The keymap the factory receives: field edits follow the user's `tui.editor.*` bindings. */
  keys: FieldKeys;
  /** Tern draws the form as a centered sheet of its own; the terminal as a framed card over the transcript. */
  native: boolean;
}

/** Over the transcript: a form is a short task, not a page of its own. */
export const FORM_OVERLAY = { overlay: true } as const;

export const KEY_HINT = "letters, digits, _ or -, up to 64";
const SCOPES: readonly SnippetScope[] = ["global", "workspace"];
const SCOPE_LABEL: Readonly<Record<SnippetScope, string>> = { global: "Global", workspace: "Workspace" };
/** Body rows the editor shows before it scrolls. */
const BODY_ROWS = 8;
const DESCRIPTION_HINT = "Optional, one line";
const BODY_HINT = "The text the snippet inserts";

/** Why `key` cannot name a snippet in `scope`; undefined when it can. `original` is the edited snippet's own key. */
export function keyProblem(key: string, scope: SnippetScope, taken: KeyTaken, original?: string): string | undefined {
  if (!key) return "Enter a key.";
  if (!SNIPPET_KEY.test(key)) return `"${key}" is not a valid key; use ${KEY_HINT}.`;
  if (key !== original && taken(scope, key)) return `A ${scope} snippet named ${key} already exists; choose another key.`;
  return undefined;
}

type TextId = "key" | "description" | "body";
type FieldId = TextId | "scope" | "save" | "cancel";

/**
 * New/edit form for one snippet: Key, Scope, Description and Body stacked, then Save and Cancel. Keys reach the
 * form, which edits the focused field; Tern edits arrive per field. `done` receives the draft on Save, undefined on
 * Cancel.
 */
export class SnippetForm {
  readonly node: UiNode;
  readonly #order: readonly FieldId[];
  readonly #text: Readonly<Record<TextId, Signal<Field>>>;
  /** Earlier states of each text field, newest last, for undo. */
  readonly #history: Record<TextId, Field[]> = { key: [], description: [], body: [] };
  readonly #scope: Signal<SnippetScope>;
  readonly #focus = signal<FieldId>("key");
  /** Save was pressed: an empty key now shows its error too. */
  readonly #attempted = signal(false);
  /** What Ctrl+W, Ctrl+K and Ctrl+U cut in any field, for the yank bindings to paste back. */
  readonly #ring = new KillRing();
  #closed = false;

  constructor(
    readonly options: SnippetFormOptions,
    readonly env: FormEnv,
    readonly done: (draft: SnippetDraft | undefined) => void,
  ) {
    const { original } = options;
    this.#scope = signal(original?.scope ?? options.scope);
    this.#order = original ? ["key", "description", "body", "save", "cancel"] : ["key", "scope", "description", "body", "save", "cancel"];
    this.#text = {
      key: signal(field(original?.key ?? "")),
      description: signal(field(original?.description ?? "")),
      body: signal(field(original?.body ?? "")),
    };
    this.node = this.#view();
  }

  /** The draft as it would be saved: key and description trimmed, the description on one line. */
  get draft(): SnippetDraft {
    return {
      key: this.#text.key().text.trim(),
      scope: this.#scope(),
      description: this.#text
        .description()
        .text.replace(/[\r\n]+/g, " ")
        .trim(),
      body: this.#text.body().text,
    };
  }

  /** The key's problem, once there is something to judge: a typed key, or a Save attempt. */
  #keyError(): string | undefined {
    const key = this.#text.key().text.trim();
    if (!key && !this.#attempted()) return undefined;
    return keyProblem(key, this.#scope(), this.options.taken, this.options.original?.key);
  }

  /** Tab wraps around the fields; arrows stop at the ends. */
  #move(delta: number, wrap: boolean): void {
    const index = this.#order.indexOf(this.#focus()) + delta;
    const count = this.#order.length;
    const next = wrap ? (index + count) % count : Math.max(0, Math.min(count - 1, index));
    this.#focus.set(this.#order[next] ?? "key");
  }

  #finish(draft: SnippetDraft | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(draft);
  }

  /** Saves when the key is valid; otherwise moves to the key and shows why. */
  save(): void {
    this.#attempted.set(true);
    if (this.#keyError()) {
      this.#focus.set("key");
      return;
    }
    this.#finish(this.draft);
  }

  cancel(): void {
    this.#finish(undefined);
  }

  #setText(id: TextId, next: Field | undefined): void {
    const current = this.#text[id]();
    if (!next || (next.text === current.text && next.cursor === current.cursor)) return;
    if (next.text !== current.text) this.#history[id].push(current);
    this.#text[id].set(next);
  }

  #undo(id: TextId): void {
    const previous = this.#history[id].pop();
    if (previous) this.#text[id].set(previous);
  }

  #toggleScope(): void {
    if (!this.options.original) this.#scope.set(this.#scope() === "global" ? "workspace" : "global");
  }

  /** Every key stays in the form: it is modal until Save or Cancel. */
  key(key: KeyEvent): boolean {
    if (this.#closed || key.kind === "release") return true;
    const focus = this.#focus();
    if (key.id === "escape") this.cancel();
    else if (key.id === "ctrl+s") this.save();
    else if (key.id === "tab") this.#move(1, true);
    else if (key.id === "shift+tab") this.#move(-1, true);
    else if (focus === "body") {
      // Enter breaks the line: the body is multi-line, and Save has its own key.
      if (this.env.keys.matches(key, "tui.editor.undo")) this.#undo("body");
      else if (key.id === "enter") this.#setText("body", insertText(this.#text.body(), "\n", true));
      else this.#setText("body", editField(this.#text.body(), key, this.env.keys, true, this.#ring));
    } else if (key.id === "up" || key.id === "down") this.#move(key.id === "up" ? -1 : 1, false);
    else if (focus === "key" || focus === "description") {
      if (key.id === "enter") this.#move(1, false);
      else if (this.env.keys.matches(key, "tui.editor.undo")) this.#undo(focus);
      else this.#setText(focus, editField(this.#text[focus](), key, this.env.keys, false, this.#ring));
    } else if (focus === "scope") {
      if (key.id === "left" || key.id === "right" || key.id === "space") this.#toggleScope();
      else if (key.id === "enter") this.#move(1, false);
    } else if (key.id === "left" || key.id === "right") this.#focus.set(focus === "save" ? "cancel" : "save");
    else if (key.id === "enter" || key.id === "space") {
      if (focus === "save") this.save();
      else this.cancel();
    }
    return true;
  }

  paste(paste: PasteEvent): boolean {
    const focus = this.#focus();
    if (focus === "key" || focus === "description" || focus === "body")
      this.#setText(focus, insertText(this.#text[focus](), paste.text, focus === "body"));
    return true;
  }

  /** A Tern edit lands in its own field, which takes the focus. */
  edit(id: TextId, edit: TextEdit): void {
    if (this.#closed) return;
    batch(() => {
      this.#focus.set(id);
      this.#setText(id, applyEdit(this.#text[id](), edit));
    });
  }

  undo(id: TextId): void {
    this.#focus.set(id);
    this.#undo(id);
  }

  /** A click on a scope tab picks it (a new snippet only) and focuses the choice. */
  pickScope(scope: string): void {
    if (scope !== "global" && scope !== "workspace") return;
    if (!this.options.original) this.#scope.set(scope);
    this.#focus.set("scope");
  }

  run(act: string): void {
    if (act === "save") this.save();
    else if (act === "cancel") this.cancel();
  }

  /** A field's label: accent and strong while it has the focus, with its note beside it. */
  #label(id: FieldId, name: string, note: () => string | undefined): UiNode {
    return h("text", {
      spans: () => {
        const focused = this.#focus() === id;
        const text = note();
        return [span(name, focused ? "strong accent" : "strong"), ...(text ? [span(`  ${text}`, "dim")] : [])];
      },
    });
  }

  /** Props a text field's control shares: the focus pointer as the terminal prompt, no caret while elsewhere. */
  #control(id: TextId) {
    const focused = () => this.#focus() === id;
    return {
      text: () => this.#text[id]().text,
      cursor: () => this.#text[id]().cursor,
      ...(this.env.native ? {} : { prompt: (): TspSpan[] => [span(focused() ? "› " : "  ", "accent")] }),
      term: () => (focused() ? undefined : { caret: "none", caretEnd: "none" }),
      onEdit: (edit: TextEdit) => this.edit(id, edit),
      onUndo: () => this.undo(id),
      onFocus: () => this.#focus.set(id),
    };
  }

  #scopeControl(): UiNode {
    const dir = () => [span(this.options.dirs[this.#scope()], "dim")];
    if (this.options.original) return h("text", { spans: () => [span(`  ${SCOPE_LABEL[this.#scope()]}  `), ...dir()], truncate: "middle" });
    return h(
      "row",
      { gap: "md", align: "center" },
      h("text", { spans: () => [span(this.#focus() === "scope" ? "› " : "  ", "accent")] }),
      h("tabs", {
        items: SCOPES.map((scope) => ({ id: scope, label: SCOPE_LABEL[scope] })),
        active: () => this.#scope(),
        variant: "segmented",
        onSelect: (scope) => this.pickScope(scope),
      }),
      h("text", { spans: dir, truncate: "middle", grow: 1 }),
    );
  }

  #hints(): TspSpan[] {
    const focus = this.#focus();
    const parts: Array<[string, string]> = [
      ["Tab/Shift+Tab", "field"],
      ...(focus === "scope" && !this.options.original ? [["←/→", "switch"] as [string, string]] : []),
      ...(focus === "save" || focus === "cancel" ? [["←/→", "button"] as [string, string]] : []),
      ["Ctrl+S", "save"],
      ["Esc", "cancel"],
    ];
    return parts.flatMap(([keys, label], index) => [
      ...(index ? [span("  ·  ", "dim")] : []),
      span(keys, "key"),
      span(`\u00a0${label}`, "muted"),
    ]);
  }

  #view(): UiNode {
    const { original } = this.options;
    const { native } = this.env;
    const group = (id: FieldId, ...children: JSXNode[]) => h("col", { key: id }, ...children);
    // Tern shows the format hints as placeholders; the terminal beside the labels, where they stay readable.
    const notes = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" · ") || undefined;
    const content = h(
      "col",
      { gap: "sm" },
      group(
        "key",
        this.#label("key", "Key", () => notes(original && "changing it renames the file", !native && KEY_HINT)),
        h("input", { ...this.#control("key"), ...(native ? { placeholder: KEY_HINT } : {}) }),
        () => {
          const error = this.#keyError();
          return error ? h("text", { spans: [span(`  ${error}`, "error")], wrap: "word" }) : undefined;
        },
      ),
      group(
        "scope",
        this.#label("scope", "Scope", () => undefined),
        this.#scopeControl(),
      ),
      group(
        "description",
        this.#label("description", "Description", () => notes(!native && DESCRIPTION_HINT)),
        h("input", { ...this.#control("description"), ...(native ? { placeholder: DESCRIPTION_HINT } : {}) }),
      ),
      group(
        "body",
        this.#label("body", "Body", () => notes(!native && BODY_HINT, this.#focus() === "body" && "Enter adds a line")),
        h("editor", { ...this.#control("body"), ...(native ? { placeholder: BODY_HINT } : {}), maxLines: BODY_ROWS }),
      ),
      h(
        "row",
        { key: "actions", gap: "sm", justify: "end" },
        h("button", { text: "Cancel", keys: ["escape"], on: () => this.#focus() === "cancel", actions: { click: "cancel" } }),
        h("button", {
          text: "Save",
          keys: ["ctrl", "s"],
          variant: "primary",
          on: () => this.#focus() === "save",
          actions: { click: "save" },
        }),
      ),
      h("text", { spans: () => this.#hints(), wrap: "word" }),
    );
    const head = original ? `Edit ${original.key}` : "New snippet";
    const handlers = {
      onKey: (key: KeyEvent) => this.key(key),
      onPaste: (paste: PasteEvent) => this.paste(paste),
      onAction: (act: string) => this.run(act),
    };
    return this.env.native
      ? h("overlay", { size: "md", anchor: "center", modal: true, head, role: "omp.overlay.snippets.form", ...handlers }, content)
      : h("card", { head: [span(head, "strong accent")], ...handlers }, content);
  }
}
