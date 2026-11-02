import {
  type Component,
  col,
  type DescribeContext,
  Editor,
  getEditorTheme,
  Input,
  keyed,
  matchesKey,
  type NativeChild,
  type NativeNode,
  type NativeUiEvent,
  row as nativeRow,
  node,
  span,
  type Theme,
  type TUI,
  text,
  truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { bottomBorder, divider, rawKeyHint, renderSegmentTrack, row, topBorder } from "@oh-my-pi/pi-tui/chrome";
import { Memo } from "@oh-my-pi/pi-tui/native/memo";
import { leafKey } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, hintsRow } from "@oh-my-pi/pi-tui/native/overlay";
import type { TspProps } from "@oh-my-pi/pi-wire";

import { SNIPPET_KEY, type SnippetScope } from "#src/snippet.ts";

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

/** Centered over the transcript: a form is a short task, not a page of its own. */
export const FORM_OVERLAY = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "90%" },
} as const;

export const KEY_HINT = "letters, digits, _ or -, up to 64";
const SCOPES: readonly SnippetScope[] = ["global", "workspace"];
const SCOPE_LABEL: Readonly<Record<SnippetScope, string>> = { global: "Global", workspace: "Workspace" };
/** Body rows the terminal editor shows before it scrolls. */
const BODY_ROWS = 8;

/** Why `key` cannot name a snippet in `scope`; undefined when it can. `original` is the edited snippet's own key. */
export function keyProblem(key: string, scope: SnippetScope, taken: KeyTaken, original?: string): string | undefined {
  if (!key) return "Enter a key.";
  if (!SNIPPET_KEY.test(key)) return `"${key}" is not a valid key; use ${KEY_HINT}.`;
  if (key !== original && taken(scope, key)) return `A ${scope} snippet named ${key} already exists; choose another key.`;
  return undefined;
}

type FieldId = "key" | "scope" | "description" | "body" | "save" | "cancel";

/** The `editor` node inside an {@link Editor}'s description (the editor itself, or the column holding it). */
function editorNode(described: NativeNode): NativeNode | undefined {
  if (described.k === "editor") return described;
  for (const child of described.c ?? []) if ("k" in child && child.k === "editor") return child;
  return undefined;
}

/** A text field at rest: its value (or placeholder) as text; a click starts editing it. */
function fieldText(value: string, placeholder: string, act: string, role: string): NativeNode {
  return text(value ? value : [span(placeholder, "dim")], { truncate: "end", role, actions: { click: act } });
}

/**
 * New/edit form for one snippet: Key, Scope, Description and Body stacked, then Save and Cancel.
 * The terminal draws it as a framed panel; Tern as a centered sheet where only the focused text field is a live
 * `input`/`editor` node, so the caret follows the keyboard. `done` receives the draft on Save, undefined on Cancel.
 */
export class SnippetForm implements Component {
  readonly nativeOverlay: NonNullable<Component["nativeOverlay"]>;
  readonly #key = new Input();
  readonly #description = new Input();
  readonly #body = new Editor(getEditorTheme());
  readonly #order: readonly FieldId[];
  readonly #native = new Memo();
  #scope: SnippetScope;
  #focus: FieldId = "key";
  #focused = false;
  /** Save was pressed: an empty key now shows its error too. */
  #attempted = false;
  #closed = false;

  constructor(
    readonly theme: Theme,
    readonly tui: TUI,
    readonly options: SnippetFormOptions,
    readonly done: (draft: SnippetDraft | undefined) => void,
  ) {
    const { original } = options;
    this.#scope = original?.scope ?? options.scope;
    this.#order = original ? ["key", "description", "body", "save", "cancel"] : ["key", "scope", "description", "body", "save", "cancel"];
    // The field label stands where the terminal prompt glyph would be.
    this.#key.prompt = "";
    this.#description.prompt = "";
    this.#key.placeholder = KEY_HINT;
    this.#description.placeholder = "Optional, one line";
    this.#body.placeholder = () => "The text the snippet inserts";
    // Borderless and unpadded, so the body lines up with the other fields instead of drawing the composer's frame.
    this.#body.setBorderVisible(false);
    this.#body.setPaddingX(0);
    this.#body.setMaxHeight(BODY_ROWS);
    this.#body.disableSubmit = true;
    if (original) {
      this.#key.setValue(original.key);
      this.#description.setValue(original.description);
      this.#body.setText(original.body);
    }
    const head = original ? `Edit ${original.key}` : "New snippet";
    this.nativeOverlay = { role: "omp.overlay.snippets.form", size: "md", anchor: "center", head };
    this.#syncFocus();
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#syncFocus();
  }

  /** The draft as it would be saved: key and description trimmed, the description on one line. */
  get draft(): SnippetDraft {
    return {
      key: this.#key.getValue().trim(),
      scope: this.#scope,
      description: this.#description
        .getValue()
        .replace(/[\r\n]+/g, " ")
        .trim(),
      body: this.#body.getText(),
    };
  }

  /** The key's problem, once there is something to judge: a typed key, or a Save attempt. */
  #keyError(): string | undefined {
    const key = this.#key.getValue().trim();
    if (!key && !this.#attempted) return undefined;
    return keyProblem(key, this.#scope, this.options.taken, this.options.original?.key);
  }

  #syncFocus(): void {
    this.#key.focused = this.#focused && this.#focus === "key";
    this.#description.focused = this.#focused && this.#focus === "description";
    this.#body.focused = this.#focused && this.#focus === "body";
  }

  #focusOn(field: FieldId): void {
    this.#focus = field;
    this.#syncFocus();
  }

  /** Tab wraps around the fields; arrows stop at the ends. */
  #move(delta: number, wrap: boolean): void {
    const index = this.#order.indexOf(this.#focus) + delta;
    const count = this.#order.length;
    const next = wrap ? (index + count) % count : Math.max(0, Math.min(count - 1, index));
    this.#focusOn(this.#order[next] ?? "key");
  }

  #finish(draft: SnippetDraft | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(draft);
  }

  /** Saves when the key is valid; otherwise moves to the key and shows why. */
  save(): void {
    this.#attempted = true;
    if (this.#keyError()) {
      this.#focusOn("key");
      return;
    }
    this.#finish(this.draft);
  }

  cancel(): void {
    this.#finish(undefined);
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (matchesKey(data, "escape")) {
      this.cancel();
      return;
    }
    if (matchesKey(data, "ctrl+s")) this.save();
    else if (matchesKey(data, "tab")) this.#move(1, true);
    else if (matchesKey(data, "shift+tab")) this.#move(-1, true);
    else this.#fieldInput(data);
    this.tui.requestRender();
  }

  #fieldInput(data: string): void {
    const field = this.#focus;
    if (field === "body") {
      // Enter breaks the line: the body is multi-line, and Save has its own key.
      this.#body.handleInput(matchesKey(data, "enter") ? "\n" : data);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.#move(matchesKey(data, "up") ? -1 : 1, false);
      return;
    }
    if (field === "key" || field === "description") {
      const input = field === "key" ? this.#key : this.#description;
      if (matchesKey(data, "enter")) this.#move(1, false);
      else input.handleInput(data);
    } else if (field === "scope") {
      if ((matchesKey(data, "left") || matchesKey(data, "right") || data === " ") && !this.options.original)
        this.#scope = this.#scope === "global" ? "workspace" : "global";
      else if (matchesKey(data, "enter")) this.#move(1, false);
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      this.#focusOn(field === "save" ? "cancel" : "save");
    } else if (matchesKey(data, "enter") || data === " ") {
      if (field === "save") this.save();
      else this.cancel();
    }
  }

  invalidate(): void {
    this.#key.invalidate();
    this.#description.invalidate();
    this.#body.invalidate();
  }

  // ── terminal ───────────────────────────────────────────────────────────

  render(width: number): readonly string[] {
    const t = this.theme;
    const inner = Math.max(1, width - 4);
    const line = (content: string) => row(truncateToWidth(content, inner), width);
    const label = (field: FieldId, name: string, note = "") =>
      line(
        `${this.#focus === field ? t.fg("accent", t.bold(`› ${name}`)) : t.fg("muted", `  ${name}`)}${note ? t.fg("dim", `  ${note}`) : ""}`,
      );
    const single = (field: "key" | "description", input: Input) =>
      this.#focus === field ? (input.render(inner - 2)[0] ?? "") : input.getValue() || t.fg("dim", input.placeholder ?? "");
    const rows: string[] = [topBorder(width, this.nativeOverlay.head as string)];

    rows.push(label("key", "Key", this.options.original ? "changing it renames the file" : ""), line(`  ${single("key", this.#key)}`));
    const error = this.#keyError();
    if (error) rows.push(line(`  ${t.fg("error", error)}`));
    rows.push(line(""));

    const dir = t.fg("dim", this.options.dirs[this.#scope]);
    if (this.options.original) rows.push(label("scope", "Scope"), line(`  ${SCOPE_LABEL[this.#scope]}  ${dir}`));
    else {
      const track = renderSegmentTrack(
        SCOPES.map((scope) => ({ label: SCOPE_LABEL[scope] })),
        SCOPES.indexOf(this.#scope),
      );
      rows.push(label("scope", "Scope", this.#focus === "scope" ? "←/→ switch" : ""), line(`  ${track}  ${dir}`));
    }
    rows.push(line(""));

    rows.push(label("description", "Description"), line(`  ${single("description", this.#description)}`), line(""));

    rows.push(label("body", "Body", this.#focus === "body" ? "Enter adds a line" : ""));
    if (this.#focus === "body") rows.push(...this.#body.render(inner - 2).map((text) => line(`  ${text}`)));
    else {
      const body = this.#body.getText();
      const lines = body ? body.split("\n") : [];
      const shown = lines.slice(0, BODY_ROWS);
      if (!shown.length) rows.push(line(`  ${t.fg("dim", "The text the snippet inserts")}`));
      for (const text of shown) rows.push(line(`  ${text}`));
      if (lines.length > shown.length) rows.push(line(`  ${t.fg("dim", `+${lines.length - shown.length} more lines`)}`));
    }

    const button = (field: "save" | "cancel", name: string) => {
      const textLabel = ` ${name} `;
      if (this.#focus === field) return t.bg("selectedBg", t.bold(t.fg("accent", textLabel)));
      return field === "save" ? t.fg("accent", `[${name}]`) : t.fg("muted", `[${name}]`);
    };
    rows.push(divider(width), line(`${button("save", "Save")}  ${button("cancel", "Cancel")}`));
    rows.push(
      line(
        [rawKeyHint(["tab", "shift+tab"], "field"), rawKeyHint("ctrl+s", "save"), rawKeyHint("escape", "cancel")].join(t.fg("dim", "   ")),
      ),
      bottomBorder(width),
    );
    return rows;
  }

  // ── native ─────────────────────────────────────────────────────────────

  /** Key, Scope, Description and Body as labelled form fields over the Save/Cancel bar and the key hints. */
  describe(cx: DescribeContext): NativeNode {
    const focus = this.#focus;
    const keyInput = focus === "key" ? this.#key.describe(cx) : undefined;
    const descriptionInput = focus === "description" ? this.#description.describe(cx) : undefined;
    const bodyEditor = focus === "body" ? editorNode(this.#body.describe(cx)) : undefined;
    const error = this.#keyError();
    const { key, description, body } = this.draft;
    return this.#native.get([focus, this.#scope, key, description, body, error, keyInput, descriptionInput, bodyEditor], () => {
      const field = (id: FieldId, name: string, control: NativeNode, extra: NativeChild[] = []) =>
        keyed(
          col([text([span(name, focus === id ? "strong accent" : "strong")]), control, ...extra], { gap: "xs", role: "omp.form.field" }),
          id,
        );
      const keyControl = keyInput
        ? node("input", { ...(keyInput.p as TspProps<"input">), placeholder: KEY_HINT })
        : fieldText(key, KEY_HINT, "focus-key", "omp.app.git.field");
      const keyExtra: NativeChild[] = error
        ? [text([span(error, "error")], { wrap: "word" })]
        : this.options.original
          ? [text([span("Changing the key renames the file.", "muted")])]
          : [];
      const scopeControl = this.options.original
        ? text([span(SCOPE_LABEL[this.#scope]), span(`  ${this.options.dirs[this.#scope]}`, "dim")], { truncate: "middle" })
        : nativeRow(
            [
              node(
                "tabs",
                {
                  items: SCOPES.map((scope) => ({ id: scope, label: SCOPE_LABEL[scope] })),
                  active: this.#scope,
                  role: "omp.app.seg",
                },
                undefined,
                "scope-tabs",
              ),
              text([span(this.options.dirs[this.#scope], "dim")], { truncate: "middle", grow: 1 }),
            ],
            { gap: "md", align: "center", justify: "start" },
          );
      const descriptionControl = descriptionInput
        ? node("input", { ...(descriptionInput.p as TspProps<"input">), placeholder: "Optional, one line" })
        : fieldText(description, "Optional, one line", "focus-description", "omp.app.git.field");
      const bodyControl = bodyEditor
        ? node("editor", { ...(bodyEditor.p as TspProps<"editor">), placeholder: "The text the snippet inserts", maxLines: BODY_ROWS })
        : fieldText(
            body.split("\n", 1)[0] + (body.includes("\n") ? " …" : ""),
            "The text the snippet inserts",
            "focus-body",
            "omp.app.git.body",
          );
      return col(
        [
          field("key", "Key", keyControl, keyExtra),
          field("scope", "Scope", keyed(scopeControl, "scope")),
          field("description", "Description", descriptionControl),
          field("body", "Body", bodyControl),
          actionBar([
            null,
            actionButton("Cancel", "cancel", { keys: "escape", tone: focus === "cancel" ? "accent" : undefined }),
            actionButton("Save", "save", { keys: "ctrl+s", tone: "accent" }),
          ]),
          hintsRow([
            { keys: ["tab", "shift+tab"], label: "next / previous field" },
            { keys: ["ctrl+s"], label: "save" },
            { keys: ["escape"], label: "cancel" },
          ]),
        ],
        { gap: "md" },
      );
    });
  }

  /** Selection edits go to the field being edited; clicks focus a field, pick the scope, or save/cancel. */
  handleNativeEvent(event: NativeUiEvent): void {
    if (this.#closed) return;
    if (event.type === "edit" || event.type === "undo") {
      const field =
        this.#focus === "key"
          ? this.#key
          : this.#focus === "description"
            ? this.#description
            : this.#focus === "body"
              ? this.#body
              : undefined;
      if (!field) return;
      field.handleNativeEvent(event);
    } else if (event.type === "action") {
      if (event.act === "save") this.save();
      else if (event.act === "cancel") this.cancel();
      else {
        const target = /^focus-(key|description|body)$/.exec(event.act)?.[1] as FieldId | undefined;
        if (!target) return;
        this.#focusOn(target);
      }
    } else if ((event.type === "select" || event.type === "activate") && leafKey(event.key) === "scope-tabs") {
      if (event.item !== "global" && event.item !== "workspace") return;
      if (!this.options.original) this.#scope = event.item;
      this.#focusOn("scope");
    } else return;
    this.tui.requestRender();
  }
}
