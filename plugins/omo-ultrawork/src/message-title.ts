import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { h, span } from "#src/tsp.ts";

type Content = string | readonly { type: string; text?: string }[];

function messageText(content: Content): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

/**
 * Shows a displayed message as a card like the host's default one, labelled with a product title instead of its
 * persisted customType: the host's default card always heads itself with the customType.
 */
export function registerMessageTitle(pi: ExtensionAPI, customType: string, title: string): void {
  pi.registerMessageRenderer(customType, (message) =>
    h("card", { head: [span(title, "customMessageLabel strong")] }, h("md", { text: messageText(message.content) })),
  );
}
