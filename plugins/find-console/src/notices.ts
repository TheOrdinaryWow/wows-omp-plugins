import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export function commandNotice(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  content: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(content, level);
  else pi.sendMessage({ customType: "wows-omp-find-console.notice", content, display: true, attribution: "agent" });
}
