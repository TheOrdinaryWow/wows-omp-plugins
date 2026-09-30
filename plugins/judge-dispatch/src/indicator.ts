import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth } from "@oh-my-pi/pi-tui";

import type { ParsedTaskRoute, RouteChoice } from "#src/routing.ts";

const ROUTE_MESSAGE = "wows-omp-judge-dispatch.route";

/** Presentation failures must never affect the task rewrite. */
export function setRoutingWorkingMessage(pi: ExtensionAPI, ctx: ExtensionContext, message?: string): void {
  try {
    if (ctx.hasUI === false || typeof ctx.ui?.setWorkingMessage !== "function") return;
    ctx.ui.setWorkingMessage(message);
  } catch (error) {
    pi.logger.warn("judge-dispatch working message failed", { error: String(error) });
  }
}

function singleLine(value: unknown): string {
  return String(value)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function changedRouteLine(route: ParsedTaskRoute, choice: RouteChoice | undefined, item: Record<string, unknown>): string | undefined {
  const agentChanged = choice?.agent !== undefined && choice.agent !== route.requestedAgent;
  const effortChanged = choice?.effort !== undefined && choice.effort !== item.effort;
  if (!choice || (!agentChanged && !effortChanged)) return undefined;
  const confidence = (value: number | undefined) => (value === undefined ? "" : ` (${value.toFixed(2)})`);
  const requested = singleLine(route.requestedAgent ?? "default");
  const parts = [agentChanged ? `${requested} → ${singleLine(choice.agent)}${confidence(choice.agentConfidence)}` : requested];
  if (effortChanged) parts.push(`effort ${singleLine(item.effort ?? "default")} → ${choice.effort}${confidence(choice.effortConfidence)}`);
  return `${route.index === null ? "" : `#${route.index + 1} `}${parts.join(" · ")}`;
}

/** Install the model-context exclusion before allowing any transcript records. */
export function registerRouteIndicator(
  pi: ExtensionAPI,
): (input: Record<string, unknown>, routes: readonly ParsedTaskRoute[], choices: readonly (RouteChoice | undefined)[]) => void {
  let available = false;
  try {
    if (typeof pi.on === "function") {
      pi.on("context", (event) => ({
        messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== ROUTE_MESSAGE),
      }));
      if (typeof pi.registerMessageRenderer === "function" && typeof pi.sendMessage === "function") {
        pi.registerMessageRenderer(ROUTE_MESSAGE, (message, _options, theme) => ({
          render: (width) => [theme.fg("dim", truncateToWidth(singleLine(message.content), Math.max(0, width)))],
          invalidate() {},
        }));
        available = true;
      }
    }
  } catch (error) {
    pi.logger.warn("judge-dispatch transcript indicator unavailable", { error: String(error) });
  }

  return (input, routes, choices) => {
    if (!available) return;
    try {
      const lines: string[] = [];
      for (const [index, route] of routes.entries()) {
        const item = route.index === null ? input : (input.tasks as Record<string, unknown>[])[route.index];
        if (!item) continue;
        const line = changedRouteLine(route, choices[index], item);
        if (line) lines.push(line);
      }
      if (lines.length === 0) return;
      pi.sendMessage({ customType: ROUTE_MESSAGE, content: `judge-dispatch  ${lines.join(" ; ")}`, display: true }, { deliverAs: "aside" });
    } catch (error) {
      pi.logger.warn("judge-dispatch transcript indicator failed", { error: String(error) });
    }
  };
}
