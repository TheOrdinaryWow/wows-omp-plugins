import {
  type Component,
  col,
  elapsed,
  isNativeRendering,
  item,
  keyed,
  list,
  matchesKey,
  type NativeNode,
  type NativeUiEvent,
  row as nativeRow,
  node,
  padding,
  renderProgressBar,
  span,
  type Theme,
  type TUI,
  text,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import { bottomBorder, divider, rawKeyHint, row, topBorder } from "@oh-my-pi/pi-tui/chrome";
import { actionBar, actionButton } from "@oh-my-pi/pi-tui/native/overlay";

import type { FindProgressController } from "#src/controller.ts";
import { spread } from "#src/view.ts";

/** A centered panel over the transcript: the search is a short wait, not a page of its own. */
export const PROGRESS_OVERLAY = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "80%" },
} as const;

/** Spinner cadence of the host's loaders. */
const FRAME_MS = 80;

/**
 * The cascade's phases, recognized by the progress messages it reports. `detail` turns a message into
 * the phase's live fact; a message that matches no phase is shown as is under the list.
 */
const PHASES = [
  { id: "resolve", label: "Resolve scope and judge", pattern: /^Resolving/ },
  { id: "scan", label: "Lexical scan", pattern: /^lexical scan/ },
  { id: "names", label: "Rank file names", pattern: /^filename ranking (.+)/ },
  { id: "read", label: "Read candidate files", pattern: /^reading (.+)/ },
  { id: "score", label: "Score passage sketches", pattern: /^scoring (.+)/ },
  { id: "verify", label: "Verify passages", pattern: /^verifying (.+)/ },
] as const;

type PhaseState = "done" | "active" | "pending" | "skipped";

const LABEL_WIDTH = Math.max(...PHASES.map((phase) => phase.label.length));

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Search progress: the query, the cascade's phases with live counts, elapsed time and cancellation. */
export class FindProgress implements Component {
  readonly nativeOverlay: NonNullable<Component["nativeOverlay"]>;
  readonly #started = Date.now();
  readonly #details = new Map<number, string>();
  readonly #seen = new Set<number>();
  #phase = 0;
  #names: number | undefined;
  #note: string | undefined;
  #frame = 0;
  #animate = false;
  #timer: NodeJS.Timeout | undefined;
  #memo: { key: string; lines: readonly string[] } | undefined;
  #native: NativeNode | undefined;

  constructor(
    readonly controller: FindProgressController,
    readonly theme: Theme,
    readonly tui: TUI,
  ) {
    this.nativeOverlay = { role: "omp.overlay.find-console.search", size: "md", anchor: "center", head: `Find: ${controller.query}` };
    for (const message of controller.messages) this.#ingest(message);
    controller.onChange = () => {
      const latest = controller.messages.at(-1);
      if (latest !== undefined && !controller.cancelled) this.#ingest(latest);
      this.#native = undefined;
      tui.requestRender();
    };
    // Short searches keep a static status; only a wait lasting a second earns an animated indicator.
    // Native motion is terminal-clocked after this single transition; TUI loaders then advance at host cadence.
    this.#timer = setInterval(() => {
      if (Date.now() - this.#started < 1000) return;
      if (!this.#animate) {
        this.#animate = true;
        this.#native = undefined;
        tui.requestRender();
      }
      if (isNativeRendering()) return;
      this.#frame++;
      tui.requestRender();
    }, FRAME_MS);
  }

  #ingest(message: string): void {
    const index = PHASES.findIndex((phase) => phase.pattern.test(message));
    if (index < 0) {
      this.#note = message;
      return;
    }
    this.#note = undefined;
    this.#phase = Math.max(this.#phase, index);
    this.#seen.add(index);
    const detail = PHASES[index]?.pattern.exec(message)?.[1];
    if (detail) this.#details.set(index, detail);
    if (PHASES[index]?.id === "names") {
      const [done, total] = (detail ?? "").split("/").map(Number);
      this.#names = done !== undefined && total ? done / total : undefined;
    }
  }

  #state(index: number): PhaseState {
    if (index === this.#phase) return "active";
    if (index > this.#phase) return "pending";
    return this.#seen.has(index) ? "done" : "skipped";
  }

  dispose(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  handleInput(key: string): void {
    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) this.controller.cancel();
  }

  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action" && event.act === "cancel") this.controller.cancel();
  }

  invalidate(): void {
    this.#memo = undefined;
    this.#native = undefined;
  }

  render(width: number): readonly string[] {
    const age = Date.now() - this.#started;
    const key = `${width}:${this.#frame}:${clock(age)}:${this.controller.messages.length}:${this.controller.messages.at(-1)}:${this.controller.cancelled}`;
    if (this.#memo?.key !== key) this.#memo = { key, lines: this.#rows(width, age) };
    return this.#memo.lines;
  }

  #rows(width: number, age: number): string[] {
    const t = this.theme;
    const c = this.controller;
    const inner = Math.max(1, width - 4);
    const frames = t.spinnerFrames;
    const spinner = c.cancelled
      ? t.fg("warning", t.status.aborted)
      : t.fg("accent", this.#animate ? (frames[this.#frame % frames.length] ?? "") : "·");
    const glyphs = { done: t.status.success, skipped: "–", pending: "·" };
    const glyphWidth = Math.max(visibleWidth(spinner), ...Object.values(glyphs).map(visibleWidth));
    const phases = PHASES.map((phase, index) => {
      const state = this.#state(index);
      const glyph =
        state === "active"
          ? spinner
          : state === "done"
            ? t.fg("success", glyphs.done)
            : t.fg("dim", state === "skipped" ? glyphs.skipped : glyphs.pending);
      const label = phase.label.padEnd(LABEL_WIDTH);
      const styled = state === "active" ? t.bold(label) : state === "done" ? t.fg("muted", label) : t.fg("dim", label);
      const names = phase.id === "names" && this.#names !== undefined && state === "active";
      const bar = names
        ? `${renderProgressBar(this.#names, 12, {
            style: {
              filled: t.symbol("progress.filled"),
              empty: t.symbol("progress.empty"),
              styleFilled: (cells) => t.fg("accent", cells),
              styleEmpty: (cells) => t.fg("dim", cells),
            },
          })} `
        : "";
      const detail = this.#details.get(index);
      const fact = `${bar}${detail ? t.fg(state === "active" ? "muted" : "dim", detail) : ""}`;
      return row(truncateToWidth(`${glyph}${padding(glyphWidth - visibleWidth(glyph))} ${styled}  ${fact}`, inner), width);
    });
    const footer = c.cancelled
      ? t.fg("warning", "Cancelling; waiting for in-flight judge requests")
      : `${rawKeyHint("escape", "cancel search")}${t.fg("dim", "   no search deadline")}`;
    return [
      topBorder(width, c.cancelled ? "Find · cancelling" : "Find · searching"),
      row(truncateToWidth(`${spinner} ${t.bold(c.query)}`, inner), width),
      divider(width),
      ...phases,
      ...(this.#note ? [row(truncateToWidth(t.fg("muted", this.#note), inner), width)] : []),
      divider(width),
      row(spread(footer, t.fg("muted", `${clock(age)} elapsed`), inner), width),
      bottomBorder(width),
    ];
  }

  describe(): NativeNode {
    if (this.#native) return this.#native;
    const c = this.controller;
    const current = PHASES[this.#phase];
    const phases = list(
      PHASES.map((phase, index) => {
        const state = this.#state(index);
        return item(phase.id, {
          label: phase.label,
          ...(this.#details.has(index) ? { detail: this.#details.get(index) } : {}),
          ...(state === "done" ? { icon: "check" } : state === "active" ? { icon: "pending" } : {}),
          tone: state === "done" ? "success" : state === "active" ? (c.cancelled ? "warning" : "accent") : "muted",
        });
      }),
      { role: "omp.find-console.phases" },
      "phases",
    );
    const children: NativeNode[] = [
      keyed(
        nativeRow(
          [
            this.#animate && !c.cancelled
              ? node("spinner", { style: "dots", label: [span(current?.label ?? "Searching", "strong")] })
              : text([span(c.cancelled ? "Cancelling search…" : (current?.label ?? "Searching"), c.cancelled ? "warning" : "strong")]),
            node("spacer", { grow: 1 }),
            elapsed(Date.now() - this.#started),
          ],
          { gap: "md", align: "center" },
        ),
        "status",
      ),
      phases,
    ];
    if (current?.id === "names" && this.#names !== undefined)
      children.push(
        keyed(node("progress", { value: this.#names, tone: "accent", label: `${this.#details.get(this.#phase)} names` }), "names"),
      );
    if (this.#note) children.push(keyed(text(this.#note, { tone: "muted", wrap: "word" }), "note"));
    children.push(
      c.cancelled
        ? keyed(text("Waiting for in-flight judge requests to stop.", { tone: "warning", wrap: "word" }), "cancelling")
        : actionBar([
            actionButton("Cancel search", "cancel", { keys: "escape", tone: "error" }),
            null,
            text("No search deadline", { tone: "muted" }),
          ]),
    );
    this.#native = col(children, { gap: "md" });
    return this.#native;
  }
}
