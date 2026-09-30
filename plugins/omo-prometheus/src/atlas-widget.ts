import { type Component, type Theme, type TUI, truncateToWidth } from "@oh-my-pi/pi-tui";

import { formatElapsed, progressBar, rowMark } from "./atlas-menu.ts";
import type { AtlasLive, AtlasLiveSnapshot } from "./atlas-live.ts";

/** A compact observation above the editor. The editor and the agent retain keyboard focus. */
export class AtlasStatusWidget implements Component {
  #snapshot: AtlasLiveSnapshot;
  #unsubscribe: () => void;

  constructor(
    readonly live: AtlasLive,
    readonly tui: TUI,
    readonly theme: Theme,
  ) {
    this.#snapshot = live.snapshot;
    this.#unsubscribe = live.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.tui.requestRender();
    });
  }

  dispose(): void {
    this.#unsubscribe();
  }

  render(width: number): readonly string[] {
    const { detail, rows, at, runningChildren } = this.#snapshot;
    const gates = detail.rows.filter((item) => /^F[1-4]$/.test(item.id));
    const passed = gates.filter((item) => item.status === "done").length;
    const title = `${this.theme.bold(detail.plan.name)}  ${progressBar(this.theme, detail.done, detail.total)} ${detail.done}/${detail.total} · ${runningChildren} running · gates ${passed}/${gates.length}`;
    const active = detail.rows.filter((item) => {
      const child = rows.get(item.id);
      return item.status === "in_progress" && child && (child.status === "started" || child.status === "running");
    });
    const shown = active.slice(0, 4).map((item) => {
      const child = rows.get(item.id);
      const progress = child?.progress;
      const activity = progress?.currentTool ?? progress?.lastIntent ?? "running";
      const usage = progress ? `${progress.tokens} tokens · $${progress.cost.toFixed(4)}` : "usage pending";
      return `${rowMark(this.theme, item.status)} ${item.id} ${item.agent} ${formatElapsed(item.startedAt, at)} · ${activity} · ${usage}`;
    });
    const overflow = active.length - shown.length;
    return [title, ...shown, ...(overflow ? [this.theme.fg("dim", `+${overflow} more`)] : [])].map((line) =>
      truncateToWidth(line, Math.max(1, width)),
    );
  }
}
