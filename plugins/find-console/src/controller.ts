import type { FindHit, FindRange, FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";

import { externalOpenReason, type PreviewReader, type PreviewSource } from "#src/preview.ts";
import { coverageWarning, previewWindow, reference, reportStats, selectedRange } from "#src/results.ts";

export interface ConsoleState {
  selected: number;
  range: number;
  marked: number[];
}

export type ConsoleAction = "close" | "insert" | "send" | "open";
export interface ConsoleResult {
  action: ConsoleAction;
  state: ConsoleState;
}

export class FindResultsController {
  readonly state: ConsoleState = { selected: 0, range: 0, marked: [] };
  preview: PreviewSource | undefined;
  message: string | undefined;
  onChange: (() => void) | undefined;
  onAction: ((result: ConsoleResult) => void) | undefined;
  readonly actions = {
    close: () => this.requestAction("close"),
    insert: () => this.requestAction("insert"),
    send: () => this.requestAction("send"),
    open: () => this.requestAction("open"),
    nextRange: () => this.cycleRange(1),
    previousRange: () => this.cycleRange(-1),
    toggleMarked: () => this.toggleMarked(),
  };

  constructor(
    readonly report: FindToolDetails,
    readonly reader: PreviewReader,
    readonly supportsEditor: boolean,
  ) {
    this.loadPreview();
  }

  get hits(): readonly FindHit[] {
    return this.report.hits;
  }

  get selectedHit(): FindHit | undefined {
    return this.hits[this.state.selected];
  }

  get activeRange(): FindRange | undefined {
    const hit = this.selectedHit;
    return hit ? selectedRange(hit, this.state.range) : undefined;
  }

  get selectedReference(): string {
    const hit = this.selectedHit;
    return hit ? reference(hit, this.state.range) : "";
  }

  get previewLines(): { start: number; lines: string[] } {
    return previewWindow(this.preview?.lines ?? [], this.activeRange);
  }

  get coverage(): FindToolDetails["coverage"] {
    return this.report.coverage;
  }

  get warning(): string | undefined {
    return coverageWarning(this.report);
  }

  get stats(): string {
    return reportStats(this.report);
  }

  select(index: number): void {
    const selected = Math.max(0, Math.min(this.hits.length - 1, index));
    if (selected === this.state.selected) return;
    this.state.selected = selected;
    this.state.range = 0;
    this.message = undefined;
    this.loadPreview();
    this.onChange?.();
  }

  cycleRange(delta: number): void {
    const count = this.selectedHit?.ranges.length ?? 0;
    if (!count) return;
    this.state.range = (((this.state.range + delta) % count) + count) % count;
    this.onChange?.();
  }

  toggleMarked(): void {
    const index = this.state.marked.indexOf(this.state.selected);
    if (index < 0) this.state.marked.push(this.state.selected);
    else this.state.marked.splice(index, 1);
    this.onChange?.();
  }

  loadPreview(): void {
    const hit = this.selectedHit;
    this.preview = undefined;
    if (!hit) return;
    void this.reader.read(hit).then((source) => {
      if (this.selectedHit !== hit) return;
      this.preview = source;
      this.onChange?.();
    });
  }

  actionReason(action: ConsoleAction): string | undefined {
    if (action === "insert" && !this.supportsEditor) return "This host does not support composer insertion. Use Send to agent instead.";
    if (action === "open" && this.selectedHit) return externalOpenReason(this.selectedHit);
    return undefined;
  }

  requestAction(action: ConsoleAction): void {
    const reason = this.actionReason(action);
    if (reason) {
      this.message = reason;
      this.onChange?.();
      return;
    }
    this.onAction?.({ action, state: { ...this.state, marked: [...this.state.marked] } });
  }
}

export class FindProgressController {
  readonly messages = ["Resolving search scope and judge…"];
  cancelled = false;
  onChange: (() => void) | undefined;

  constructor(
    readonly query: string,
    readonly abort: () => void,
  ) {}

  update(message: string): void {
    this.messages.push(message);
    if (this.messages.length > 6) this.messages.shift();
    this.onChange?.();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.update("Cancelling search…");
    this.abort();
  }
}
