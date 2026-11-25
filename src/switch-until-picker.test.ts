import { afterEach, describe, expect, test } from "bun:test";

import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ExtensionContext, ExtensionCustomFactory, ExtensionCustomOptions } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/utils/render-utils";
import { setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";

import { modelPickerView, thinkingSlider } from "../plugins/switch-until/src/model-picker.ts";
import { type ModelPick, pickModel } from "../plugins/switch-until/src/models.ts";

const base = buildModel({
  provider: "anthropic",
  id: "claude-sonnet-test",
  name: "Claude Sonnet Test",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  contextWindow: 200_000,
  maxTokens: 8_000,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const reasoning = (model: Model, efforts: string[], defaultLevel?: string) =>
  ({ ...model, reasoning: true, thinking: { ...model.thinking, efforts, defaultLevel } }) as Model;

const sonnet = reasoning(base, ["low", "medium", "high"], "medium");
const opus = reasoning({ ...base, id: "claude-opus-test", name: "Claude Opus Test", contextWindow: 1_000_000 }, [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const mini = { ...base, provider: "openai", id: "gpt-mini-test", name: "GPT Mini Test", contextWindow: 8_000, reasoning: false } as Model;

interface Picked {
  model?: Model;
  thinking?: ConfiguredThinkingLevel;
  cancelled?: boolean;
}

let term: TestTerminal | undefined;
afterEach(() => {
  term?.dispose();
  term = undefined;
});

function open(columns: number, options: { contextTokens?: number; thinking?: ConfiguredThinkingLevel } = {}) {
  const picked: Picked = {};
  const view = modelPickerView({
    models: [sonnet, opus, mini],
    current: sonnet,
    thinking: options.thinking,
    contextTokens: options.contextTokens ?? 1_000,
    rows: () => 40,
    onPick: (model, thinking) => {
      picked.model = model;
      picked.thinking = thinking;
    },
    onCancel: () => {
      picked.cancelled = true;
    },
  });
  term = createTestTerminal(() => ({ layer: view }), { columns, rows: 40 });
  term.focus(view);
  return { term, picked, screen: () => term?.screen().join("\n") ?? "" };
}

describe("switch-until model picker", () => {
  test.each([80, 120])("shows the models, the current one, thinking and key hints at %i columns", (columns) => {
    const { screen } = open(columns);
    const text = screen();
    expect(text).toContain("Temporary session model");
    expect(text).toContain("anthropic/claude-sonnet-test");
    expect(text).toContain("anthropic/claude-opus-test");
    expect(text).toContain("openai/gpt-mini-test");
    expect(text).toMatch(/❯ anthropic\/claude-sonnet-test\s+current/);
    expect(text).toContain("Thinking  Auto  Off  Low  Med  High");
    expect(text).toContain("↑↓ move · ⏎ switch · ←→ thinking · type to search · esc cancel");
    for (const row of term?.screen() ?? []) expect(row.length).toBeLessThanOrEqual(columns);
  });

  test("marks models whose window the conversation exceeds", () => {
    const { screen } = open(120, { contextTokens: 50_000 });
    expect(screen()).toMatch(/openai\/gpt-mini-test\s+GPT Mini Test · 8k ctx · compacts first/);
  });

  test("searches by typing, clears on escape, then cancels", () => {
    const { term, picked, screen } = open(80);
    term.type("gpt");
    expect(screen()).toContain("> gpt");
    expect(screen()).toContain("❯ openai/gpt-mini-test");
    expect(screen()).not.toContain("claude-opus-test");
    expect(screen()).toContain("esc clear search");
    expect(screen()).toContain("does not reason");
    term.press("escape");
    expect(screen()).toContain("claude-opus-test");
    expect(picked.cancelled).toBeUndefined();
    term.press("escape");
    expect(picked.cancelled).toBe(true);
  });

  test("picks the highlighted model without a thinking level unless the slider moved", () => {
    const first = open(80);
    first.term.press("down");
    first.term.press("enter");
    expect(first.picked.model).toBe(opus);
    expect(first.picked.thinking).toBeUndefined();
    term?.dispose();

    const second = open(80, { thinking: ThinkingLevel.Low });
    second.term.press("right");
    expect(second.screen()).toMatch(/Low\s+Med\s+High/);
    second.term.press("down");
    second.term.press("enter");
    expect(second.picked.model).toBe(opus);
    expect(second.picked.thinking).toBe(ThinkingLevel.Medium);
  });

  test.each([
    ["right", ThinkingLevel.High],
    ["left", "auto"],
  ] as const)("returns no thinking level after pressing %s at the slider's end", (arrow, thinking) => {
    const { term, picked, screen } = open(80, { thinking });
    const before = screen();
    term.press(arrow);
    expect(screen()).toBe(before);
    term.press("enter");
    expect(picked.model).toBe(sonnet);
    expect(picked.thinking).toBeUndefined();
  });

  test("clamps the session level to each model's ladder", () => {
    expect(thinkingSlider(sonnet, undefined)).toEqual({
      steps: ["auto", ThinkingLevel.Off, ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.High],
      value: ThinkingLevel.Medium,
    });
    expect(thinkingSlider(sonnet, ThinkingLevel.Max).value).toBe(ThinkingLevel.High);
    expect(thinkingSlider(opus, ThinkingLevel.Inherit).value).toBe(ThinkingLevel.Off);
    expect(thinkingSlider(mini, ThinkingLevel.High)).toMatchObject({ steps: [], disabled: "GPT Mini Test does not reason" });
  });

  test.each([false, true])(
    "mounts the bare picker, as an overlay only in the terminal, and retires it on close (native: %s)",
    async (native) => {
      let mounted: { root: UiNode; options: ExtensionCustomOptions | undefined } | undefined;
      const ctx = {
        mode: "tui",
        model: sonnet,
        modelRegistry: { getAvailable: () => [sonnet, opus, mini] },
        getContextUsage: () => ({ tokens: 0 }),
        ui: {
          custom: (factory: ExtensionCustomFactory<ModelPick | undefined>, options?: ExtensionCustomOptions) => {
            const { promise, resolve } = Promise.withResolvers<ModelPick | undefined>();
            const ui = { size: () => ({ columns: 80, rows: 40 }), requestRender() {}, suspend: async () => {} };
            const root = factory(ui as never, {} as never, {} as never, resolve) as UiNode;
            mounted = { root, options };
            expect(root.disposed).toBe(false);
            root.handlers.onActivate?.("anthropic/claude-opus-test", { type: "activate", key: "", item: "anthropic/claude-opus-test" });
            return promise;
          },
        },
      } as unknown as ExtensionContext;
      const session = {
        scopedModels: [],
        settings: { getStorage: () => undefined },
        configuredThinkingLevel: () => undefined,
      } as unknown as AgentSession;
      setNativeRenderingForTest(native);
      try {
        expect(await pickModel(ctx, session)).toEqual({ model: opus, thinking: undefined });
      } finally {
        setNativeRenderingForTest(false);
      }
      expect(mounted?.root.kind).toBe("picker");
      expect(mounted?.options).toEqual(native ? undefined : { overlay: true });
      expect(mounted?.root.disposed).toBe(true);
    },
  );
});
