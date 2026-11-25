import { onCleanup, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";

import { h, span } from "#src/tsp.ts";

import type { AtlasLive, AtlasLiveSnapshot } from "./atlas-live.ts";
import { progressNode, singleLine } from "./atlas-menu.ts";

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

/** Snapshots arrive every second while a row runs; the widget redraws only when the ledger or a running row's child changes. */
function sameView(a: AtlasLiveSnapshot, b: AtlasLiveSnapshot): boolean {
  if (a.detail !== b.detail || a.runningChildren !== b.runningChildren) return false;
  return a.detail.rows.every((item) => item.status !== "in_progress" || a.rows.get(item.id) === b.rows.get(item.id));
}

/** The summary as nodes: the plan's progress, then each running row; the terminal and Tern clock the timers. */
export function atlasWidgetView({ detail, rows, runningChildren }: AtlasLiveSnapshot): UiNode {
  const gates = detail.rows.filter((item) => /^F[1-4]$/.test(item.id));
  const passed = gates.filter((item) => item.status === "done").length;
  // Stats first in priority: a long plan name gives way before the progress numbers do.
  const head = h(
    "col",
    { key: "head" },
    progressNode(detail.done, detail.total, [
      span(`${detail.done}/${detail.total}`),
      span(` · ${runningChildren} running${gates.length ? ` · gates ${passed}/${gates.length}` : ""}  `, "muted"),
      span(detail.plan.name, "strong accent"),
    ]),
  );
  // Every ledger row in progress is listed, including one whose child has not reported yet.
  const active = detail.rows.filter((item) => item.status === "in_progress");
  const now = Date.now();
  const listed = active.length > MAX_LINES - 1 ? active.slice(0, MAX_LINES - 2) : active;
  const lines = listed.map((item) => {
    const current = rows.get(item.id);
    const child = current?.attempt === item.attempt ? current : undefined;
    const progress = child?.progress;
    // A HEAVY row's recorded implementation waits for, then runs, its independent verifier.
    const activity: TspSpan[] = item.verification?.status === "running" ? [span("verify ", "accent")] : [];
    if (item.verification?.status === "pending") activity.push(span("awaiting verification", "dim"));
    else if (!child) activity.push(span("waiting for child", "dim"));
    else if (progress?.currentTool) {
      activity.push(span(progress.currentTool, "code"));
      if (progress.currentToolArgs) activity.push(span(` ${singleLine(progress.currentToolArgs)}`, "dim"));
    } else if (progress?.lastIntent) activity.push(span(singleLine(progress.lastIntent)));
    else activity.push(span(child.status === "started" || child.status === "running" ? "running" : `child ${child.status}`, "dim"));
    return h(
      "row",
      { key: item.id, gap: "sm", align: "center" },
      h("text", { spans: [span(item.id, "accent"), span(` ${item.agent}`, "muted")], shrink: 0 }),
      item.startedAt !== undefined ? h("elapsed", { age: now - item.startedAt, format: "short", shrink: 0 }) : undefined,
      // Activity is free text; it takes whatever width the fixed fields leave instead of pushing usage off.
      h("text", { spans: activity, truncate: "end", lines: 1, grow: 1, shrink: 1, basis: 0 }),
      progress
        ? h("text", { spans: [span(`${formatNumber(progress.tokens)} tok · $${progress.cost.toFixed(2)}`, "dim")], shrink: 0 })
        : undefined,
    );
  });
  const hidden = active.length - listed.length;
  return h(
    "col",
    {},
    head,
    ...lines,
    hidden > 0 ? h("text", { key: "more", spans: [span(`+${hidden} more in progress`, "dim")] }) : undefined,
  );
}

/**
 * A compact observation above the editor, following the live model until the widget is replaced. The editor and the
 * agent retain keyboard focus.
 */
export function atlasStatusWidget(live: AtlasLive): UiNode {
  const snapshot = signal(live.snapshot, { equals: sameView });
  onCleanup(live.subscribe((next) => snapshot.set(next)));
  return h("col", {}, () => atlasWidgetView(snapshot()));
}
