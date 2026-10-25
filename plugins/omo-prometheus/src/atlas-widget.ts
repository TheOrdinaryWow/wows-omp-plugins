import {
  type Component,
  col,
  compact,
  type DescribeContext,
  elapsed,
  keyed,
  type NativeChild,
  type NativeNode,
  row,
  span,
  type Theme,
  type TUI,
  text,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import { Memo } from "@oh-my-pi/pi-tui/native/memo";
import type { TspSpan } from "@oh-my-pi/pi-tui/native/node";
import { formatNumber } from "@oh-my-pi/pi-utils";

import type { AtlasLive, AtlasLiveSnapshot } from "./atlas-live.ts";
import { formatElapsed, progressBar, progressNode, rowMark, singleLine } from "./atlas-menu.ts";

/** Header plus row lines; the overflow notice takes the last row slot only when it hides two or more rows. */
const MAX_LINES = 6;

/** Plain-text widget lines for hosts that only accept string-array widgets (RPC clients). */
export function atlasWidgetLines({ detail, rows, runningChildren }: AtlasLiveSnapshot): string[] {
  const width = 10;
  const filled = detail.total ? Math.round((detail.done / detail.total) * width) : 0;
  const gates = detail.rows.filter((item) => /^F[1-4]$/.test(item.id));
  const passed = gates.filter((item) => item.status === "done").length;
  const title = `Atlas ${detail.plan.name} [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${detail.done}/${detail.total} · ${runningChildren} running${gates.length ? ` · gates ${passed}/${gates.length}` : ""}`;
  const active = detail.rows.filter((item) => item.status === "in_progress");
  const listed = active.length > MAX_LINES - 1 ? active.slice(0, MAX_LINES - 2) : active;
  const lines = listed.map((item) => {
    const current = rows.get(item.id);
    const child = current?.attempt === item.attempt ? current : undefined;
    const activity =
      item.verification?.status === "pending"
        ? "awaiting verification"
        : !child
          ? "waiting for child"
          : child.progress?.currentTool
            ? child.progress.currentTool
            : child.progress?.lastIntent
              ? singleLine(child.progress.lastIntent)
              : child.status === "started" || child.status === "running"
                ? "running"
                : `child ${child.status}`;
    return `${item.id} ${item.title} (${item.agent}) · ${item.verification?.status === "running" ? "verify: " : ""}${activity}`;
  });
  if (listed.length < active.length) lines.push(`+${active.length - listed.length} more in progress`);
  return [title, ...lines];
}

/** A compact observation above the editor. The editor and the agent retain keyboard focus. */
export class AtlasStatusWidget implements Component {
  #snapshot: AtlasLiveSnapshot;
  #unsubscribe: () => void;
  readonly #native = new Memo();

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
    const t = this.theme;
    const { detail, rows, at, runningChildren } = this.#snapshot;
    const gates = detail.rows.filter((item) => /^F[1-4]$/.test(item.id));
    const passed = gates.filter((item) => item.status === "done").length;
    // Stats first in priority: a long plan name gives way before the progress numbers do.
    const stats = ` ${progressBar(t, detail.done, detail.total)} ${detail.done}/${detail.total} ${t.fg("dim", "·")} ${runningChildren} running${gates.length ? ` ${t.fg("dim", "·")} gates ${passed}/${gates.length}` : ""}`;
    const name = truncateToWidth(detail.plan.name, Math.max(8, width - visibleWidth(stats)));
    const title = `${t.bold(t.fg("accent", name))}${stats}`;

    // Every ledger row in progress is listed, including one whose child has not reported yet.
    const active = detail.rows.filter((item) => item.status === "in_progress");
    const slots = MAX_LINES - 1;
    const listed = active.length > slots ? active.slice(0, slots - 1) : active;
    const idWidth = Math.max(0, ...listed.map((item) => item.id.length));
    const lines = listed.map((item) => {
      const current = rows.get(item.id);
      const child = current?.attempt === item.attempt ? current : undefined;
      const progress = child?.progress;
      const head = `${rowMark(t, item.status)} ${item.id.padEnd(idWidth)} ${t.fg("muted", item.agent)} ${t.fg("dim", formatElapsed(item.startedAt, at))}`;
      const usage = progress ? t.fg("dim", ` · ${formatNumber(progress.tokens)} tok · $${progress.cost.toFixed(2)}`) : "";
      // A HEAVY row's recorded implementation waits for, then runs, its independent verifier.
      const phase = item.verification?.status === "running" ? t.fg("accent", "verify ") : "";
      const activity =
        item.verification?.status === "pending"
          ? t.fg("dim", "awaiting verification")
          : !child
            ? t.fg("dim", "waiting for child")
            : progress?.currentTool
              ? `${progress.currentTool}${progress.currentToolArgs ? t.fg("dim", ` ${singleLine(progress.currentToolArgs)}`) : ""}`
              : progress?.lastIntent
                ? singleLine(progress.lastIntent)
                : t.fg("dim", child.status === "started" || child.status === "running" ? "running" : `child ${child.status}`);
      // Activity is free text; it takes whatever width the fixed fields leave instead of pushing usage off.
      const room = width - visibleWidth(head) - visibleWidth(usage) - visibleWidth(phase) - 3;
      return room >= 8 ? `${head} ${t.fg("dim", "·")} ${phase}${truncateToWidth(activity, room)}${usage}` : `${head}${usage}`;
    });
    if (listed.length < active.length) lines.push(t.fg("dim", `+${active.length - listed.length} more in progress`));
    return [title, ...lines].map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  /**
   * The same summary as native nodes in the dock. Snapshots arrive every second while a row runs; the node changes
   * only when the ledger detail, the running count or a running row's child does, and Tern clocks the timers.
   */
  describe(_cx: DescribeContext): NativeNode {
    const { detail, rows, runningChildren } = this.#snapshot;
    const active = detail.rows.filter((item) => item.status === "in_progress");
    return this.#native.get([detail, runningChildren, ...active.map((item) => rows.get(item.id))], () => {
      const gates = detail.rows.filter((item) => /^F[1-4]$/.test(item.id));
      const passed = gates.filter((item) => item.status === "done").length;
      const head = row(
        compact<NativeChild>([
          text([span(detail.plan.name, "strong accent")], { truncate: "end", lines: 1 }),
          progressNode(detail.done, detail.total, true),
          text([span(`${runningChildren} running`, "muted")]),
          gates.length > 0 && text([span(`gates ${passed}/${gates.length}`, "muted")]),
        ]),
        { gap: "md", align: "center" },
      );
      const now = Date.now();
      const slots = MAX_LINES - 1;
      const listed = active.length > slots ? active.slice(0, slots - 1) : active;
      const lines = listed.map((item) => {
        const current = rows.get(item.id);
        const child = current?.attempt === item.attempt ? current : undefined;
        const progress = child?.progress;
        const activity: TspSpan[] = item.verification?.status === "running" ? [span("verify ", "accent")] : [];
        if (item.verification?.status === "pending") activity.push(span("awaiting verification", "dim"));
        else if (!child) activity.push(span("waiting for child", "dim"));
        else if (progress?.currentTool) {
          activity.push(span(progress.currentTool, "code"));
          if (progress.currentToolArgs) activity.push(span(` ${singleLine(progress.currentToolArgs)}`, "dim"));
        } else if (progress?.lastIntent) activity.push(span(singleLine(progress.lastIntent)));
        else activity.push(span(child.status === "started" || child.status === "running" ? "running" : `child ${child.status}`, "dim"));
        return keyed(
          row(
            compact<NativeChild>([
              text([span(item.id, "accent"), span(` ${item.agent}`, "muted")]),
              item.startedAt !== undefined && elapsed(now - item.startedAt),
              text(activity, { truncate: "end", lines: 1, grow: 1 }),
              progress && text([span(`${formatNumber(progress.tokens)} tok · $${progress.cost.toFixed(2)}`, "dim")]),
            ]),
            { gap: "sm", align: "center" },
          ),
          item.id,
        );
      });
      const hidden = active.length - listed.length;
      return col(
        compact<NativeChild>([
          keyed(head, "head"),
          ...lines,
          hidden > 0 && keyed(text([span(`+${hidden} more in progress`, "dim")]), "more"),
        ]),
        { gap: "xs", role: "omp.atlas.widget" },
      );
    });
  }
}
