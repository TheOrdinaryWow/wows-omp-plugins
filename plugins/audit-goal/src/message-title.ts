import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";

/** Shows a displayed message in the host's own frame, labelled with a product title instead of its persisted customType. */
export function registerMessageTitle(pi: ExtensionAPI, customType: string, title: string): void {
  pi.registerMessageRenderer(customType, (message, options) => {
    const component = new CustomMessageComponent({ ...message, customType: title });
    component.setExpanded(options.expanded);
    return component;
  });
}
