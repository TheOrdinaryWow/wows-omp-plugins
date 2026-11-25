import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatModelStringWithRouting, getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import { createRoot, nativeRendering } from "@oh-my-pi/pi-tui";

import { modelPickerView } from "#src/model-picker.ts";
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

/** Keeps prewalk from moving the session model during a run; true when a pending or automatic prewalk was turned off. */
export function disarmPrewalk(session: AgentSession): boolean {
  if (lookup("prewalk.auto")?.get(session.settings) === "off" && !session.getPrewalkState()) return false;
  session.disarmPrewalk();
  return true;
}

export async function pickModel(ctx: ExtensionContext, session: AgentSession): Promise<ModelPick | undefined> {
  if (ctx.mode === "tui") {
    const scoped = session.scopedModels.map(({ model }) => model);
    const mru = createModelBrowserSource(session.settings).mruOrder;
    const rank = (model: Model) => {
      const at = mru.indexOf(`${model.provider}/${model.id}`);
      return at < 0 ? mru.length : at;
    };
    const models = (scoped.length ? scoped : ctx.modelRegistry.getAvailable()).toSorted((a, b) => rank(a) - rank(b));
    if (!models.length) throw new Error("No models are available for /switch-until.");
    let dispose: (() => void) | undefined;
    try {
      return await ctx.ui.custom<ModelPick | undefined>(
        (ui, _theme, _keybindings, done) =>
          createRoot((disposeRoot) => {
            dispose = disposeRoot;
            return modelPickerView({
              models,
              current: ctx.model,
              thinking: session.configuredThinkingLevel(),
              contextTokens: ctx.getContextUsage()?.tokens ?? 0,
              rows: () => ui.size().rows,
              onPick: (model, thinking) => done({ model, thinking }),
              onCancel: () => done(undefined),
            });
          }),
        nativeRendering() ? undefined : { overlay: true },
      );
    } finally {
      dispose?.();
    }
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
