import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getEditorCommand } from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";

import { insertReference, openExternally, sendHits } from "#src/actions.ts";
import { type ConsoleAction, FindResultsController } from "#src/controller.ts";
import type { PreviewReader } from "#src/preview.ts";
import { bestRanges, reference } from "#src/results.ts";
import { mountResultsConsole } from "#src/ui.ts";

async function previewDialog(ctx: ExtensionContext, controller: FindResultsController): Promise<void> {
  const hit = controller.selectedHit;
  if (!hit) return;
  const source = await controller.reader.read(hit);
  const window = controller.previewLines;
  const content = source.error
    ? `Preview unavailable: ${source.error}`
    : window.lines.length
      ? window.lines
          .map((line, index) => {
            const number = window.start + index;
            const marked = hit.ranges.some((range) => range.start <= number && range.end >= number);
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
    description: `${reference(hit)}${hit.truncated ? " · partial file" : ""} · ${bestRanges(hit)[0]?.snippet.trim() ?? ""}`,
  }));
  const picked = await ctx.ui.select(`Find: ${controller.report.query}\n${controller.warning ?? controller.stats}`, labels, {
    initialIndex: controller.state.selected,
  });
  const index = labels.findIndex((label) => label.label === picked);
  if (index < 0) return "close";
  controller.select(index);
  const hit = controller.selectedHit;
  if (!hit) return "close";
  for (;;) {
    const options = [
      { label: "Preview this range", description: controller.selectedReference },
      ...(hit.ranges.length > 1
        ? [{ label: "Next judged range", description: `Range ${controller.state.range + 1}/${hit.ranges.length}` }]
        : []),
      { label: "Insert reference into composer", description: controller.actionReason("insert") ?? controller.selectedReference },
      {
        label: controller.state.marked.includes(index) ? "Unmark this hit" : "Mark this hit for sending",
        description: `${controller.state.marked.length} marked`,
      },
      { label: "Send selected hit to agent", description: "Sends a user message; queues a follow-up while streaming." },
      ...(controller.state.marked.length
        ? [{ label: "Send marked hits to agent", description: `${controller.state.marked.length} hits` }]
        : []),
      {
        label: "Open externally",
        description: controller.actionReason("open") ?? "$VISUAL / $EDITOR at the selected line, or the OS opener.",
      },
      { label: "Back to results" },
      { label: "Close" },
    ];
    const choice = await ctx.ui.select(`${controller.selectedReference} · ${hit.contentScore.toFixed(2)}`, options);
    if (choice === undefined || choice === "Back to results") return "back";
    if (choice === "Close") return "close";
    if (choice === "Preview this range") {
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
  report: FindToolDetails,
  reader: PreviewReader,
): Promise<void> {
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
