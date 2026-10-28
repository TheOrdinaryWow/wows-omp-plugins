import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getEditorCommand } from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import type { TUI } from "@oh-my-pi/pi-tui";

import { insertReference, openExternally, sendHits } from "#src/actions.ts";
import { type ConsoleAction, FindResultsController } from "#src/controller.ts";
import { type HistoryEntry, historyCommand } from "#src/history.ts";
import type { PreviewReader } from "#src/preview.ts";
import type { ConsoleReport } from "#src/report.ts";
import { bestRanges, countLabel, reference } from "#src/results.ts";
import { mountResultsConsole } from "#src/ui.ts";

async function previewDialog(ctx: ExtensionContext, controller: FindResultsController): Promise<void> {
  const hit = controller.selectedHit;
  if (!hit) return;
  const source = await controller.reader.read(hit);
  controller.preview = source;
  const window = controller.previewLines;
  const content = source.error
    ? `Preview unavailable: ${source.error}`
    : window.lines.length
      ? window.lines
          .map((line, index) => {
            const number = window.start + index;
            const marked = window.highlight.some((range) => range.start <= number && range.end >= number);
            return `${marked ? ">" : " "} ${number}: ${line}`;
          })
          .join("\n")
      : "The judged range is no longer present in this file.";
  await ctx.ui.editor(
    `${controller.selectedReference} (read-only preview; edits are discarded)`,
    `${content}${source.truncated ? "\n\nPreview limited to the first 4 MiB." : ""}`,
  );
}

export async function resultDialogAction(
  ctx: ExtensionContext,
  controller: FindResultsController,
): Promise<ConsoleAction | "back" | "send-selected"> {
  const labels = controller.hits.map((hit, index) => ({
    label: `${index + 1}. ${hit.rel} · ${hit.contentScore.toFixed(2)}`,
    description: `${reference(hit)}${hit.scope === "whole-file" ? " · whole-file" : ""}${hit.truncated ? " · partial file" : ""} · ${hit.refineFailed ?? bestRanges(hit)[0]?.snippet.trim() ?? ""}`,
  }));
  const summary = [
    `Find: ${controller.queryLabel}`,
    controller.report.originalQuery ? `searched as: ${controller.report.query}` : undefined,
    controller.report.translation && "skipped" in controller.report.translation
      ? `Translation skipped: ${controller.report.translation.skipped}`
      : undefined,
    controller.report.within
      ? `within ${countLabel(controller.report.within.files, "file")} of: ${controller.report.within.query}`
      : undefined,
    controller.stats,
    controller.warning,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  const picked = await ctx.ui.select(
    summary,
    [
      ...labels,
      {
        label: "Search within results",
        description: `Ask a new question in only ${countLabel(controller.hits.length, "file")}; keep the current flags.`,
      },
      { label: "Recent searches", description: "Rerun a saved query with its original flags." },
    ],
    { initialIndex: controller.state.selected },
  );
  if (picked === "Search within results") return "refine";
  if (picked === "Recent searches") return "history";
  const index = labels.findIndex((label) => label.label === picked);
  if (index < 0) return "close";
  controller.select(index);
  const hit = controller.selectedHit;
  if (!hit) return "close";
  for (;;) {
    const options = [
      {
        label: controller.report.previewMode === "full-file" || hit.scope === "whole-file" ? "Preview full file" : "Preview this range",
        description: controller.selectedReference,
      },
      ...(bestRanges(hit).length > 1
        ? [{ label: "Next judged range", description: `Range ${controller.state.range + 1}/${bestRanges(hit).length}` }]
        : []),
      { label: "Insert reference into composer", description: controller.actionReason("insert") ?? controller.selectedReference },
      {
        label: controller.state.marked.includes(index) ? "Unmark this hit" : "Mark this hit for sending",
        description: `${controller.state.marked.length} marked`,
      },
      { label: "Send selected hit to agent", description: "Sends a user message; queues a follow-up while streaming." },
      ...(controller.state.marked.length
        ? [{ label: "Send marked hits to agent", description: countLabel(controller.state.marked.length, "hit") }]
        : []),
      {
        label: "Open externally",
        description: controller.actionReason("open") ?? "$VISUAL / $EDITOR at the selected line, or the OS opener.",
      },
      { label: "Search within results", description: `Ask a new question in only ${countLabel(controller.hits.length, "file")}.` },
      { label: "Recent searches", description: "Rerun a saved query with its original flags." },
      { label: "Back to results" },
      { label: "Close" },
    ];
    const choice = await ctx.ui.select(`${controller.selectedReference} · ${hit.contentScore.toFixed(2)}`, options);
    if (choice === undefined || choice === "Back to results") return "back";
    if (choice === "Close") return "close";
    if (choice === "Search within results") return "refine";
    if (choice === "Recent searches") return "history";
    if (choice === "Preview this range" || choice === "Preview full file") {
      await previewDialog(ctx, controller);
      continue;
    }
    if (choice === "Next judged range") {
      controller.cycleRange(1);
      continue;
    }
    if (choice === "Mark this hit for sending" || choice === "Unmark this hit") {
      controller.toggleMarked();
      continue;
    }
    if (choice === "Send selected hit to agent") return "send-selected";
    const action = choice === "Insert reference into composer" ? "insert" : choice === "Open externally" ? "open" : "send";
    const reason = controller.actionReason(action);
    if (reason) {
      ctx.ui.notify(reason, "warning");
      continue;
    }
    return action;
  }
}

export async function showResults(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: ExtensionContext,
  report: ConsoleReport,
  reader: PreviewReader,
): Promise<"refine" | "history" | undefined> {
  const controller = new FindResultsController(report, reader, ctx.ui.supportsEditor === true);
  let terminalConsole = ctx.mode === "tui";
  let tui: TUI | undefined;
  for (;;) {
    let action: ConsoleAction | "back" | "send-selected" | undefined;
    if (terminalConsole) {
      const mounted = await mountResultsConsole(ctx, controller);
      if (!mounted) terminalConsole = false;
      else {
        action = mounted.choice.action;
        tui = mounted.tui;
      }
    }
    if (!terminalConsole) action = await resultDialogAction(ctx, controller);
    if (action === "back") continue;
    if (action === "refine" || action === "history") return action;
    if (action === undefined || action === "close") return;
    const hit = controller.selectedHit;
    if (!hit) return;
    if (action === "insert") {
      insertReference(ctx.ui, hit, controller.state.range);
      return;
    }
    if (action === "send" || action === "send-selected") {
      const hits =
        action === "send" && controller.state.marked.length
          ? controller.hits.filter((_hit, index) => controller.state.marked.includes(index))
          : [hit];
      sendHits(pi, ctx, report, hits, { hit, range: controller.state.range });
      return;
    }
    try {
      await openExternally(ctx, hit, controller.state.range, terminalConsole ? tui : undefined);
      reader.invalidate(hit);
      controller.loadPreview();
      controller.message = `Opened ${controller.selectedReference}${getEditorCommand() ? "." : " with the OS opener (line positioning is unavailable)."}`;
      if (!terminalConsole) ctx.ui.notify(controller.message, "info");
    } catch (error) {
      controller.message = error instanceof Error ? error.message : String(error);
      if (!terminalConsole) ctx.ui.notify(controller.message, "error");
    }
  }
}

export async function pickHistory(ctx: ExtensionContext, entries: readonly HistoryEntry[]): Promise<HistoryEntry | undefined> {
  const options = entries.map((entry, index) => ({
    label: `${index + 1}. ${entry.args.query}`,
    description: `${entry.within ? `within ${countLabel(entry.within.files.length, "file")} of: ${entry.within.query} · ` : ""}${historyCommand(entry)}`,
  }));
  const picked = await ctx.ui.select("Recent searches in this project", options);
  return entries[options.findIndex((option) => option.label === picked)];
}
