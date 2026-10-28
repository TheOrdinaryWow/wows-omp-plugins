import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { getEditorCommand } from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { FindHit, FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";

import { externalOpenReason } from "#src/preview.ts";
import { hitMessage, reference, selectedRange } from "#src/results.ts";

export function insertReference(
  ui: Pick<ExtensionUIContext, "supportsEditor" | "getEditorText" | "pasteToEditor">,
  hit: FindHit,
  range = 0,
): void {
  if (ui.supportsEditor !== true) throw new Error("This host does not support composer insertion. Use Send to agent instead.");
  const existing = ui.getEditorText();
  ui.pasteToEditor(`${existing && !/\s$/.test(existing) ? " " : ""}${reference(hit, range)} `);
}

export function sendHits(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: Pick<ExtensionContext, "isIdle">,
  report: FindToolDetails,
  hits: readonly FindHit[],
  current?: { hit: FindHit; range: number },
): void {
  pi.sendUserMessage(hitMessage(report, hits, current), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

export async function openExternally(ctx: Pick<ExtensionContext, "cwd">, hit: FindHit, range = 0, tui?: TUI): Promise<void> {
  const reason = externalOpenReason(hit);
  if (reason) throw new Error(reason);
  const file = resolve(ctx.cwd, hit.rel);
  const line = selectedRange(hit, range)?.start ?? 1;
  const editor = getEditorCommand();
  const command = editor
    ? process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", `${editor} +${line} "${file}"`]
      : ["sh", "-c", `${editor} "$1" "$2"`, "sh", `+${line}`, file]
    : process.platform === "darwin"
      ? ["open", file]
      : process.platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "start", "", file]
        : ["xdg-open", file];
  const terminalEditor = editor !== undefined && tui !== undefined;
  if (terminalEditor) tui.stop();
  try {
    const child = Bun.spawn(command, {
      cwd: ctx.cwd,
      stdin: terminalEditor ? "inherit" : "ignore",
      stdout: terminalEditor ? "inherit" : "ignore",
      stderr: terminalEditor ? "inherit" : "pipe",
    });
    const errors = child.stderr && typeof child.stderr !== "number" ? new Response(child.stderr).text() : Promise.resolve("");
    const [exitCode, stderr] = await Promise.all([child.exited, errors]);
    if (exitCode !== 0) throw new Error(`External opener exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : "."}`);
  } finally {
    if (terminalEditor) {
      tui.start();
      tui.requestRender(true);
    }
  }
}
