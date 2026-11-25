import { describe, expect, test } from "bun:test";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { z } from "zod";

import register from "../plugins/omo-ultrawork/src/omo-ultrawork.ts";

type Renderer = (message: unknown, options: { expanded: boolean }, theme: unknown) => UiNode | undefined;

describe("ultrawork message titles", () => {
  test("command notice renders with the Ultrawork title; hidden messages keep no renderer", () => {
    const renderers = new Map<string, Renderer>();
    const api = {
      logger: { warn: () => {} },
      on: () => {},
      zod: z,
      registerTool: () => {},
      registerCommand: () => {},
      registerMessageRenderer: (customType: string, renderer: Renderer) => renderers.set(customType, renderer),
    } as unknown as ExtensionAPI;
    register(api);
    const customType = "wows-omp-omo-ultrawork.command-status";
    const node = renderers.get(customType)?.(
      { role: "custom", customType, content: "Ultrawork mode on", display: true, timestamp: 0 },
      { expanded: false },
      undefined,
    );
    if (!node) throw new Error("command notice renderer drew nothing");
    const native = describeTree(node, staticEnvironment(PLAIN_THEME)) as { k: string; p?: { head?: unknown } };
    expect(native.k).toBe("card");
    expect(JSON.stringify(native.p?.head)).toContain("Ultrawork");
    expect(JSON.stringify(native)).toContain("Ultrawork mode on");
    expect(JSON.stringify(native)).not.toContain(customType);
    for (const width of [80, 120]) {
      const lines = stripEscapes(renderBlock(node, width, { theme: PLAIN_THEME }).rows.join("\n"));
      expect(lines).toContain("Ultrawork");
      expect(lines).not.toContain(customType);
      expect(lines).toContain("Ultrawork mode on");
    }
    expect(renderers.has("wows-omp-omo-ultrawork.directive")).toBe(false);
    expect(renderers.has("wows-omp-omo-ultrawork.exit")).toBe(false);
  });
});
