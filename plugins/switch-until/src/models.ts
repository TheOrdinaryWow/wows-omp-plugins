import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatModelStringWithRouting, getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

import type { ModelSelection } from "#src/state.ts";

export interface ModelPick {
  model: Model;
  thinking?: ConfiguredThinkingLevel;
}

export function sessionFor(ctx: ExtensionContext): AgentSession | undefined {
  const session = AgentRegistry.global()
    .list()
    .find((ref) => ref.session?.sessionManager === ctx.sessionManager)?.session;
  return session && isLocalAgentSession(session) ? session : undefined;
}

export { formatModelStringWithRouting as modelLabel };

export function matchesModel(current: Model | undefined, expected: Model): boolean {
  return current !== undefined && formatModelStringWithRouting(current) === formatModelStringWithRouting(expected);
}

export function captureSelection(model: Model, session: AgentSession): ModelSelection {
  return {
    provider: model.provider,
    id: model.id,
    selector: formatModelStringWithRouting(model),
    thinking: session.configuredThinkingLevel(),
  };
}

export function resolveSelection(selector: string, session: AgentSession): ModelPick {
  const scoped = session.scopedModels.map(({ model }) => model);
  const result = resolveCliModel({
    cliModel: selector,
    modelRegistry: session.modelRegistry,
    availableModels: scoped.length ? scoped : undefined,
    settings: session.settings,
    preferences: getModelMatchPreferences(session.settings),
  });
  if (!result.model) throw new Error(`Unknown model: ${selector}`);
  return { model: result.model, thinking: result.thinkingLevel };
}

export async function pickModel(ctx: ExtensionContext, session: AgentSession): Promise<ModelPick | undefined> {
  if (ctx.mode === "tui") {
    return ctx.ui.custom<ModelPick | undefined>(
      (tui, _theme, _keybindings, done) =>
        new ModelPickerComponent(
          tui,
          createModelBrowserSource(session.settings, (model) => session.effectiveServiceTier(model)),
          ctx.modelRegistry,
          session.scopedModels,
          {
            onPick: (model, _selector, { thinkingLevel }) => done({ model, thinking: thinkingLevel }),
            onCancel: () => done(undefined),
          },
          {
            currentSelector: ctx.model && formatModelStringWithRouting(ctx.model),
            currentContextTokens: ctx.getContextUsage()?.tokens ?? 0,
            thinkingLevelFor: () => session.configuredThinkingLevel(),
          },
        ),
      { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 } },
    );
  }
  const choices = new Map<string, Model>();
  for (const model of ctx.modelRegistry.getAvailable()) {
    choices.set(`${formatModelStringWithRouting(model)}${matchesModel(ctx.model, model) ? " (current)" : ""}`, model);
  }
  if (!choices.size) throw new Error("No models are available for /switch-until.");
  const selected = await ctx.ui.select("Temporary session model", [...choices.keys()]);
  const model = selected === undefined ? undefined : choices.get(selected);
  return model ? { model } : undefined;
}

export function needsCompaction(ctx: ExtensionContext, model: Model): boolean {
  const window = model.contextWindow ?? 0;
  return window > 0 && (ctx.getContextUsage()?.tokens ?? 0) > window;
}

export async function compactToFit(
  ctx: ExtensionContext,
  session: AgentSession,
  model: Model,
  options?: { suppressContinuation?: boolean; signal?: AbortSignal },
): Promise<void> {
  if (!needsCompaction(ctx, model)) return;
  await session.compact(undefined, { readerModel: model, ...options });
  if (needsCompaction(ctx, model)) {
    throw new Error(
      `The context still exceeds the ${model.contextWindow}-token window of ${formatModelStringWithRouting(model)} after compaction.`,
    );
  }
}
