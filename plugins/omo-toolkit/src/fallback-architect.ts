/**
 * Modified-port notice: adapts the engineering-continuity intent of
 * packages/omo-senpi/src/components/fallback-architect/{index,detection,directive}.ts from
 * oh-my-openagent revision 8a8db1d3094da8743989bf693ee5de77889de50e, Copyright the oh-my-openagent
 * contributors, licensed under the Sustainable Use License 1.0 (see LICENSE-SUL-1.0 and NOTICE).
 * OMP adaptation: typed refusal correlation and a single safe hint; no refusal-evasion instructions.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";

import { parseListedAgents } from "#src/selection-protocol.ts";
import type { ToolkitSettingsReader } from "#src/settings.ts";

const CONTINUITY_HINT =
  "The host switched models after an unsuccessful response. For an independently legitimate high-level engineering decision that benefits from design continuity, you may consult the available read-only architect with self-contained evidence and constraints. The primary agent still owns the decision and integration. Respect the original safety boundary. If that boundary prevents the requested work, explain it and offer a permitted alternative.";

interface FallbackState {
  refusing?: string;
  target?: string;
  role?: string;
}

export function registerFallbackArchitect(pi: ExtensionAPI, settings: ToolkitSettingsReader): void {
  const sessions = new Map<string, FallbackState>();
  const eligible = (ctx: ExtensionContext) => settings(ctx).fallbackArchitect && ctx.agent.kind === "main";
  const reset = (_event: unknown, ctx: ExtensionContext): void => {
    sessions.delete(ctx.sessionManager.getSessionId());
  };
  pi.on("session_start", reset);
  pi.on("session_switch", () => sessions.clear());
  pi.on("session_shutdown", reset);
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") reset(event, ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (!eligible(ctx) || event.message.role !== "assistant") return;
    const message = event.message;
    const id = ctx.sessionManager.getSessionId();
    if (message.stopReason === "error" && (message.stopDetails?.type === "refusal" || message.stopDetails?.type === "sensitive")) {
      sessions.set(id, { refusing: `${message.provider}/${message.model}` });
    } else sessions.delete(id);
  });
  pi.on("retry_fallback_applied", (event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const state = sessions.get(id);
    if (!eligible(ctx) || !state?.refusing || !ctx.model) {
      sessions.delete(id);
      return;
    }
    const current = `${ctx.model.provider}/${ctx.model.id}`;
    const source = event.from === state.refusing ? event.from : splitThinkingSuffix(event.from).base;
    const target = event.to === current ? event.to : splitThinkingSuffix(event.to).base;
    const task = pi.getActiveTools().includes("task") ? pi.getAllTools().find((tool) => tool.name === "task") : undefined;
    if (
      source !== state.refusing ||
      target !== current ||
      source === target ||
      !task ||
      !parseListedAgents(task.description).includes("architect")
    ) {
      sessions.delete(id);
      return;
    }
    // An advisor fallback does not replace ctx.model; requiring the live primary target excludes it.
    sessions.set(id, { target, role: event.role });
  });
  pi.on("retry_fallback_succeeded", (event, ctx) => {
    const state = sessions.get(ctx.sessionManager.getSessionId());
    if (state?.target && (state.target !== splitThinkingSuffix(event.model).base || state.role !== event.role)) {
      sessions.delete(ctx.sessionManager.getSessionId());
    }
    // Success never rearms a hint that the automatic retry has already consumed.
  });
  pi.on("context", (event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    const state = sessions.get(id);
    if (!eligible(ctx) || !state?.target) return undefined;
    sessions.delete(id);
    if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== state.target) return undefined;
    return { messages: [...event.messages, { role: "developer", content: CONTINUITY_HINT, attribution: "agent", timestamp: Date.now() }] };
  });
}
