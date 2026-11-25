import { type JSXNode, type KeyEvent, nativeRendering, signal, type UiNode, untrack } from "@oh-my-pi/pi-tui";

import type { FindProgressController } from "#src/controller.ts";
import { h, span } from "#src/tsp.ts";

/** A panel over the transcript: the search is a short wait, not a page of its own. */
export const PROGRESS_OVERLAY = { overlay: true } as const;

/** Waits shorter than this keep a static status; longer ones earn an animated indicator. */
const ANIMATE_AFTER_MS = 1000;

/** One progress message a phase recognizes: its capture, after `prefix`, becomes the phase's live fact. */
interface PhaseMessage {
  pattern: RegExp;
  prefix?: string;
  /** The fact reports a fallback the user should notice (an untranslated query). */
  warning?: boolean;
}

interface Phase {
  id: string;
  label: string;
  messages: readonly PhaseMessage[];
  /** A `done/total` fact draws a progress bar while the phase runs; `unit` names what is counted. */
  bar?: { unit: string };
}

/**
 * The search's phases, recognized by the progress messages it reports: query translation, the cascade,
 * then range refinement. A message that matches no phase is shown as is under the list.
 */
const PHASES: readonly Phase[] = [
  { id: "resolve", label: "Resolve scope and judge", messages: [{ pattern: /^Resolving/ }] },
  {
    id: "translate",
    label: "Translate query",
    messages: [
      { pattern: /^checking query language/ },
      { pattern: /^translating with (.+)/, prefix: "with " },
      { pattern: /^searched as: (.+)/, prefix: "searched as: " },
      { pattern: /^Translation skipped: (.+)/, prefix: "not translated: ", warning: true },
    ],
  },
  { id: "scan", label: "Lexical scan", messages: [{ pattern: /^lexical scan/ }] },
  { id: "names", label: "Rank file names", messages: [{ pattern: /^filename ranking (.+)/ }], bar: { unit: " names" } },
  { id: "read", label: "Read candidate files", messages: [{ pattern: /^reading (.+)/ }] },
  { id: "score", label: "Score passage sketches", messages: [{ pattern: /^scoring (.+)/ }] },
  { id: "verify", label: "Verify passages", messages: [{ pattern: /^verifying (.+)/ }] },
  { id: "refine", label: "Refine ranges", messages: [{ pattern: /^refining (.+)/ }], bar: { unit: "" } },
];

type PhaseState = "done" | "active" | "pending" | "skipped";

/** Theme symbols of one width per state, so the phase labels line up. */
const PHASE_ICONS: Readonly<Record<PhaseState, string>> = {
  done: "status.success",
  active: "status.running",
  pending: "status.shadowed",
  skipped: "status.disabled",
};

/** Search progress: the query, the cascade's phases with live counts, elapsed time and cancellation. */
export class FindProgress {
  readonly #started = Date.now();
  readonly #details = new Map<number, string>();
  readonly #warnings = new Set<number>();
  readonly #seen = new Set<number>();
  readonly #revision = signal(0);
  #phase = 0;
  /** Completed share of the running phase, from its `done/total` fact. */
  #fraction: number | undefined;
  #note: string | undefined;
  #animate = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(readonly controller: FindProgressController) {
    for (const message of controller.messages) this.#ingest(message);
    controller.onChange = () => {
      const latest = controller.messages.at(-1);
      if (latest !== undefined && !controller.cancelled) this.#ingest(latest);
      this.#revision.update((revision) => revision + 1);
    };
    // Short searches keep a static status; the spinner and elapsed time then run on the terminal's clock.
    this.#timer = setTimeout(() => {
      this.#animate = true;
      this.#revision.update((revision) => revision + 1);
    }, ANIMATE_AFTER_MS);
  }

  #ingest(message: string): void {
    for (const [index, phase] of PHASES.entries()) {
      for (const { pattern, prefix = "", warning } of phase.messages) {
        const match = pattern.exec(message);
        if (!match) continue;
        this.#note = undefined;
        this.#phase = Math.max(this.#phase, index);
        this.#seen.add(index);
        const captured = match[1];
        if (captured) this.#details.set(index, `${prefix}${captured}`);
        if (warning) this.#warnings.add(index);
        if (index !== this.#phase) return;
        const [done, total] = phase.bar ? (captured ?? "").split(/[/\s]/).map(Number) : [];
        this.#fraction = done !== undefined && total ? done / total : undefined;
        return;
      }
    }
    this.#note = message;
  }

  #state(index: number): PhaseState {
    if (index === this.#phase) return "active";
    if (index > this.#phase) return "pending";
    return this.#seen.has(index) ? "done" : "skipped";
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  key(key: KeyEvent): boolean {
    if (key.kind === "release" || (key.id !== "escape" && key.id !== "ctrl+c")) return false;
    this.controller.cancel();
    return true;
  }

  /** The root node: the panel itself in a terminal, the panel inside its own sheet in Tern. */
  view(): UiNode {
    const native = nativeRendering();
    const panel = h(
      "col",
      {
        gap: native ? "md" : "none",
        onKey: (key) => this.key(key),
        onAction: (act) => {
          if (act === "cancel") this.controller.cancel();
        },
      },
      () => {
        this.#revision();
        return untrack(() => this.#panel());
      },
    );
    if (!native) return panel;
    return h(
      "overlay",
      { size: "md", anchor: "center", modal: true, head: `Find: ${this.controller.query}`, role: "omp.overlay.find-console.search" },
      panel,
    );
  }

  #panel(): JSXNode[] {
    const c = this.controller;
    const current = PHASES[this.#phase];
    const status = c.cancelled ? "Cancelling search…" : (current?.label ?? "Searching");
    return [
      h("rule", { key: "title", label: [span("Find", "strong"), span(c.cancelled ? " · cancelling" : " · searching", "muted")] }),
      h(
        "row",
        { key: "status", gap: "md", align: "center" },
        this.#animate && !c.cancelled
          ? h("spinner", { key: "spinner", style: "dots", label: [span(status, "strong")] })
          : h("text", { key: "label", spans: [span(status, c.cancelled ? "warning" : "strong")] }),
        h("text", { key: "query", spans: [span(c.query, "muted")], grow: 1, shrink: 1, truncate: "end", lines: 1 }),
        h("elapsed", {
          key: "elapsed",
          age: Date.now() - this.#started,
          format: "clock",
          ...(c.cancelled ? { stopped: Date.now() - this.#started } : {}),
        }),
      ),
      h(
        "list",
        { key: "phases", selected: current?.id ?? null },
        PHASES.map((phase, index) => {
          const state = this.#state(index);
          const warned = this.#warnings.has(index);
          const detail = this.#details.get(index);
          return h("item", {
            key: phase.id,
            label: phase.label,
            ...(detail ? { detail: warned ? [span(detail, "warning")] : detail } : {}),
            icon: warned && state === "done" ? "status.warning" : c.cancelled && state === "active" ? "status.aborted" : PHASE_ICONS[state],
            tone: state === "done" ? (warned ? "warning" : "success") : state === "active" ? (c.cancelled ? "warning" : "accent") : "muted",
          });
        }),
      ),
      current?.bar &&
        this.#fraction !== undefined &&
        h("progress", {
          key: "fraction",
          value: this.#fraction,
          tone: "accent",
          label: `${this.#details.get(this.#phase)}${current.bar.unit}`,
        }),
      this.#note && h("text", { key: "note", spans: [span(this.#note, "muted")], wrap: "word" }),
      h("rule", { key: "foot-rule" }),
      c.cancelled
        ? h("text", { key: "cancelling", spans: [span("Waiting for in-flight judge requests to stop.", "warning")], wrap: "word" })
        : h(
            "row",
            { key: "actions", gap: "sm", align: "center" },
            h("button", { key: "cancel", text: "Cancel search", keys: ["escape"], variant: "danger", actions: { click: "cancel" } }),
            h("spacer", { grow: 1, size: "none" }),
            h("text", { spans: [span("No search deadline", "muted")] }),
          ),
    ];
  }
}
