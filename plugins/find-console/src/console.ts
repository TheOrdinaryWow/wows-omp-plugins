import { basename, dirname } from "node:path";

import {
  type Component,
  code,
  col,
  item,
  keyed,
  matchesKey,
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
import { bottomBorder, divider, dividerSplit, row, splitBodyWidth, splitRow, topBorder } from "@oh-my-pi/pi-tui/chrome";
import { leafKey } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, escCloseButton, hintsRow, selectList } from "@oh-my-pi/pi-tui/native/overlay";
import type { FindHit, FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";

import type { ConsoleState, FindProgressController, FindResultsController } from "#src/controller.ts";
import { externalOpenReason } from "#src/preview.ts";
import { bestRanges, coverageWarning, previewWindow, reference, reportStats, scoreGauge, selectedRange } from "#src/results.ts";

export const FULLSCREEN = {
  overlay: true,
  overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
} as const;

const HINTS = hintsRow([
  { keys: ["up", "down"], label: "hit" },
  { keys: ["left", "right"], label: "range" },
  { keys: ["pageUp", "pageDown"], label: "preview" },
  { keys: ["space"], label: "mark for sending" },
]);

function scoreTone(score: number): "success" | "warning" | "muted" {
  return score >= 0.7 ? "success" : score >= 0.4 ? "warning" : "muted";
}

export class FindConsole implements Component {
  readonly nativeOverlay: NonNullable<Component["nativeOverlay"]> = {
    role: "omp.overlay.find-console.results",
    size: "lg",
    anchor: "center",
    head: "Find · results",
  };
  #state: ConsoleState;
  get #source() {
    return this.controller.preview;
  }
  #scroll = 0;
  #scrollMax = 0;
  #pageRows = 10;
  #revision = 0;
  #native: { revision: number; node: NativeNode } | undefined;
  #nativeScroll: { by: "page-up" | "page-down"; n: number } | undefined;
  get #message() {
    return this.controller.message;
  }

  readonly report: FindToolDetails;
  readonly supportsEditor: boolean;

  constructor(
    readonly controller: FindResultsController,
    readonly theme: Theme,
    readonly tui: TUI,
  ) {
    this.report = controller.report;
    this.supportsEditor = controller.supportsEditor;
    this.#state = controller.state;
    controller.onChange = () => this.#changed();
  }

  #hit(): FindHit | undefined {
    return this.report.hits[this.#state.selected];
  }

  #changed(): void {
    this.#revision++;
    this.tui.requestRender();
  }

  #select(index: number): void {
    this.#scroll = 0;
    this.controller.select(index);
  }

  #range(delta: number): void {
    this.#scroll = 0;
    this.controller.cycleRange(delta);
  }

  #page(delta: number): void {
    this.#scroll = Math.max(0, Math.min(this.#scrollMax, this.#scroll + delta * this.#pageRows));
    this.#nativeScroll = { by: delta > 0 ? "page-down" : "page-up", n: (this.#nativeScroll?.n ?? 0) + 1 };
    this.#changed();
  }

  handleInput(key: string): void {
    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) this.controller.actions.close();
    else if (matchesKey(key, "up")) this.#select(this.#state.selected - 1);
    else if (matchesKey(key, "down")) this.#select(this.#state.selected + 1);
    else if (matchesKey(key, "home")) this.#select(0);
    else if (matchesKey(key, "end")) this.#select(this.report.hits.length - 1);
    else if (matchesKey(key, "left")) this.#range(-1);
    else if (matchesKey(key, "right") || matchesKey(key, "tab")) this.#range(1);
    else if (matchesKey(key, "pageUp")) this.#page(-1);
    else if (matchesKey(key, "pageDown")) this.#page(1);
    else if (matchesKey(key, "space")) this.controller.actions.toggleMarked();
    else if (matchesKey(key, "enter") || key === "i") this.controller.actions.insert();
    else if (key === "s") this.controller.actions.send();
    else if (key === "o") this.controller.actions.open();
  }

  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action") {
      if (event.act === "next-range") this.#range(1);
      else if (event.act === "previous-range") this.#range(-1);
      else if (event.act === "mark") this.controller.actions.toggleMarked();
      else if (event.act === "close" || event.act === "insert" || event.act === "send" || event.act === "open")
        this.controller.requestAction(event.act);
    } else if ((event.type === "select" || event.type === "activate") && leafKey(event.key) === "hits") {
      const index = this.report.hits.findIndex((_hit, index) => `hit-${index}` === event.item);
      if (index >= 0) this.#select(index);
    }
  }

  #preview(): string[] {
    const hit = this.#hit();
    if (!hit) return ["No hit selected."];
    const t = this.theme;
    const range = selectedRange(hit, this.#state.range);
    const head = [t.bold(t.fg("accent", reference(hit, this.#state.range))), t.fg("muted", this.#rangeLabel(hit))];
    if (!this.#source) return [...head, "", "Loading preview…"];
    if (this.#source.error) return [...head, "", t.fg("error", `Preview unavailable: ${this.#source.error}`)];
    const window = previewWindow(this.#source.lines, range);
    const numberWidth = String(window.start + window.lines.length).length;
    const body = window.lines.map((line, index) => {
      const number = window.start + index;
      const judged = hit.ranges.some((candidate) => candidate.start <= number && candidate.end >= number);
      const selected = range !== undefined && range.start <= number && range.end >= number;
      const prefix = `${selected ? "›" : judged ? "·" : " "} ${String(number).padStart(numberWidth)} `;
      const value = `${t.fg(judged ? "accent" : "dim", prefix)}${line.replaceAll("\t", "  ")}`;
      return selected ? t.bg("selectedBg", value) : value;
    });
    if (!body.length) body.push(t.fg("warning", "The judged range is no longer present in this file."));
    if (this.#source.truncated) body.push(t.fg("warning", "Preview limited to the first 4 MiB, matching the host's search read limit."));
    return [...head, "", ...body];
  }

  #rangeLabel(hit: FindHit): string {
    return `Range ${this.#state.range + 1}/${hit.ranges.length} · ${hit.linesSeen} lines judged${hit.truncated ? ", partial file" : ""}`;
  }

  #sidebar(width: number, height: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    const rowsPerHit = 3;
    const count = Math.max(1, Math.floor(height / rowsPerHit));
    const start = Math.max(0, Math.min(this.#state.selected - Math.floor(count / 2), this.report.hits.length - count));
    this.report.hits.slice(start, start + count).forEach((hit, offset) => {
      const index = start + offset;
      const chosen = this.#state.selected === index;
      const marked = this.#state.marked.includes(index);
      const color = scoreTone(hit.contentScore);
      const range = bestRanges(hit)[0];
      lines.push(
        truncateToWidth(
          `${chosen ? t.fg("accent", t.nav.cursor) : " "} ${marked ? "[x]" : "[ ]"} ${t.fg(chosen ? "accent" : "text", hit.rel)}`,
          width,
        ),
        truncateToWidth(
          `  ${t.fg(color, `${scoreGauge(hit.contentScore)} ${hit.contentScore.toFixed(2)}`)} ${t.fg("dim", hit.truncated ? "partial file" : `${hit.linesSeen} lines judged`)}`,
          width,
        ),
        truncateToWidth(t.fg("muted", range ? `  :${range.start}-${range.end} ${range.snippet.trim()}` : "  No judged range"), width),
      );
    });
    return lines;
  }

  render(width: number): readonly string[] {
    const t = this.theme;
    const height = Math.max(12, this.tui.terminal.rows);
    const inner = Math.max(1, width - 4);
    const warning = coverageWarning(this.report);
    const header = `${JSON.stringify(this.report.query)} · ${this.report.scopePath ?? "."}`;
    const hints = "↑↓ hit  ←→ range  PgUp/PgDn preview  Space mark  Enter/i insert  s send  o open  Esc close";
    const fixed = warning ? 8 : 7;
    const bodyRows = Math.max(1, height - fixed);
    const preview = this.#preview();
    const sidebarWidth = Math.max(20, Math.min(56, Math.floor(width * 0.38)));
    const narrow = width < 80;
    const listRows = narrow ? Math.min(6, Math.max(1, Math.floor(bodyRows / 3))) : bodyRows;
    const previewRows = narrow ? Math.max(1, bodyRows - listRows - 1) : bodyRows;
    this.#pageRows = Math.max(1, previewRows - 2);
    this.#scrollMax = Math.max(0, preview.length - previewRows);
    this.#scroll = Math.min(this.#scroll, this.#scrollMax);
    const shown = preview.slice(this.#scroll, this.#scroll + previewRows);
    const sidebar = this.#sidebar(narrow ? inner : sidebarWidth, listRows);
    const body = narrow
      ? [
          ...Array.from({ length: listRows }, (_, i) => row(truncateToWidth(sidebar[i] ?? "", inner), width)),
          divider(width),
          ...Array.from({ length: previewRows }, (_, i) => row(truncateToWidth(shown[i] ?? "", inner), width)),
        ]
      : Array.from({ length: bodyRows }, (_, i) =>
          splitRow(
            sidebar[i] ?? "",
            truncateToWidth(shown[i] ?? "", Math.max(1, splitBodyWidth(width, sidebarWidth))),
            width,
            sidebarWidth,
          ),
        );
    return [
      topBorder(width, `Find · ${this.report.hits.length} ranked hits`),
      row(truncateToWidth(header, inner), width),
      ...(warning ? [row(truncateToWidth(t.fg("warning", warning), inner), width)] : []),
      divider(width),
      ...body,
      ...(narrow ? [divider(width)] : [dividerSplit(width, sidebarWidth)]),
      row(truncateToWidth(this.#message ? t.fg("warning", this.#message) : reportStats(this.report), inner), width),
      row(truncateToWidth(t.fg("muted", hints), inner), width),
      bottomBorder(width),
    ];
  }

  describe(): NativeNode {
    if (this.#native?.revision === this.#revision) return this.#native.node;
    const hit = this.#hit();
    const warning = coverageWarning(this.report);
    const list = selectList(
      "hits",
      this.report.hits.map((candidate, index) =>
        item(`hit-${index}`, {
          label: `${this.#state.marked.includes(index) ? "[x] " : ""}${basename(candidate.rel)} ${scoreGauge(candidate.contentScore)}`,
          detail: `${candidate.contentScore.toFixed(2)} · ${dirname(candidate.rel)}`,
          tone: scoreTone(candidate.contentScore),
          icon: "file",
          title: `${candidate.rel} · ${candidate.contentScore.toFixed(2)} · ${reference(candidate)} · ${candidate.linesSeen} lines judged${candidate.truncated ? ", partial file" : ""}`,
        }),
      ),
      { selected: `hit-${this.#state.selected}`, role: "omp.find-console.hits" },
    );
    const preview: NativeNode[] = [];
    if (hit) {
      preview.push(
        text(reference(hit, this.#state.range), { tone: "accent", wrap: "word" }),
        text(this.#rangeLabel(hit), { tone: "muted" }),
      );
      if (!this.#source) preview.push(text("Loading preview…", { tone: "muted" }));
      else if (this.#source.error) preview.push(text(`Preview unavailable: ${this.#source.error}`, { tone: "error", wrap: "word" }));
      else {
        const range = selectedRange(hit, this.#state.range);
        const window = previewWindow(this.#source.lines, range);
        const marks = window.lines.flatMap((_line, index) => {
          const number = window.start + index;
          return hit.ranges.some((candidate) => candidate.start <= number && candidate.end >= number)
            ? [{ line: number, tone: "accent" as const }]
            : [];
        });
        preview.push(
          keyed(
            code(window.lines.join("\n"), { path: hit.rel, start: window.start, numbers: true, marks, wrap: true }),
            `${hit.rel}:${this.#state.range}`,
          ),
        );
        if (!window.lines.length) preview.push(text("The judged range is no longer present in this file.", { tone: "warning" }));
        if (this.#source.truncated) preview.push(text("Preview limited to the first 4 MiB.", { tone: "warning" }));
      }
    }
    const body: NativeNode = {
      ...node("col", { grow: 1, gap: "sm", role: "omp.find-console.preview" }, preview, "preview"),
      ...(this.#nativeScroll ? { scroll: this.#nativeScroll } : {}),
    };
    const openReason = hit ? externalOpenReason(hit) : undefined;
    const children: NativeNode[] = [
      nativeRow(
        [
          text([span(this.report.query, "strong"), span(` · ${this.report.scopePath ?? "."}`, "muted")], { grow: 1, wrap: "word" }),
          escCloseButton(),
        ],
        { gap: "md", align: "center" },
      ),
    ];
    if (warning) children.push(text(warning, { tone: "warning", wrap: "word" }));
    children.push(nativeRow([node("col", { max: { w: "32ch" }, shrink: 0 }, [list], "sidebar"), body], { gap: "lg", align: "start" }));
    children.push(
      actionBar([
        ...(this.supportsEditor ? [actionButton("Insert reference", "insert", { keys: "enter", tone: "accent" })] : []),
        actionButton(this.#state.marked.length ? `Send ${this.#state.marked.length} marked hits` : "Send selected hit", "send", {
          keys: "s",
        }),
        actionButton(this.#state.marked.includes(this.#state.selected) ? "Unmark" : "Mark for sending", "mark", { keys: "space" }),
        ...(!openReason ? [actionButton("Open externally", "open", { keys: "o" })] : []),
        actionButton("Previous range", "previous-range", { keys: "left" }),
        actionButton("Next range", "next-range", { keys: "right" }),
      ]),
    );
    if (!this.supportsEditor)
      children.push(text("Composer insertion is unavailable in this host; use Send selected hit.", { tone: "muted", wrap: "word" }));
    if (openReason) children.push(text(openReason, { tone: "muted", wrap: "word" }));
    if (this.#message) children.push(text(this.#message, { tone: "warning", wrap: "word" }));
    if (this.report.stats.failures.length) children.push(text(this.report.stats.failures.join("\n"), { tone: "warning", wrap: "word" }));
    children.push(text(reportStats(this.report), { tone: "muted", wrap: "word" }), HINTS);
    const described = col(children, { gap: "md" });
    this.#native = { revision: this.#revision, node: described };
    return described;
  }
}

export class FindProgress implements Component {
  readonly nativeOverlay: NonNullable<Component["nativeOverlay"]> = {
    role: "omp.overlay.find-console.search",
    size: "lg",
    anchor: "center",
    head: "Find · searching",
  };
  #native: NativeNode | undefined;

  constructor(
    readonly controller: FindProgressController,
    readonly tui: TUI,
  ) {
    controller.onChange = () => {
      this.#native = undefined;
      tui.requestRender();
    };
  }

  handleInput(key: string): void {
    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) this.controller.cancel();
  }

  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action" && event.act === "cancel") this.controller.cancel();
  }

  render(width: number): readonly string[] {
    return [
      topBorder(width, "Find · searching"),
      row(truncateToWidth(this.controller.query, Math.max(1, width - 4)), width),
      divider(width),
      ...this.controller.messages.map((message) => row(truncateToWidth(message, Math.max(1, width - 4)), width)),
      row("Esc / Ctrl+C cancels · no search deadline", width),
      bottomBorder(width),
    ];
  }

  describe(): NativeNode {
    this.#native ??= col(
      [
        text([span(this.controller.query, "strong")], { wrap: "word" }),
        ...this.controller.messages.map((message) => text(message, { tone: "muted", wrap: "word" })),
        actionBar([actionButton("Cancel search", "cancel", { keys: "escape" })]),
      ],
      { gap: "md" },
    );
    return this.#native;
  }
}
