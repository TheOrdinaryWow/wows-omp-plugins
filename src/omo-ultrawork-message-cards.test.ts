import { beforeAll, describe, expect, test } from "bun:test";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { initTheme } from "@oh-my-pi/pi-tui";

import register from "../plugins/omo-ultrawork/src/index.ts";

type Renderer = (message: unknown, options: { expanded: boolean }, theme: unknown) => unknown;

beforeAll(async () => {
  await initTheme();
});

describe("ultrawork message titles", () => {
  test("command notice renders with the Ultrawork title; hidden messages keep no renderer", () => {
    const renderers = new Map<string, Renderer>();
    const api = {
      logger: { warn: () => {} },
      on: () => {},
      registerCommand: () => {},
      registerMessageRenderer: (customType: string, renderer: Renderer) => renderers.set(customType, renderer),
    } as unknown as ExtensionAPI;
    register(api);
    const customType = "wows-omp-omo-ultrawork.command-status";
    const component = renderers.get(customType)?.(
      { role: "custom", customType, content: "Ultrawork mode on", display: true, timestamp: 0 },
      { expanded: false },
      undefined,
    ) as { describe: () => unknown; render: (width: number) => string[] };
    const native = JSON.stringify(component.describe());
    expect(native).toContain("Ultrawork");
    expect(native).not.toContain(customType);
    const lines = component.render(80).join("\n");
    expect(lines).toContain("Ultrawork");
    expect(lines).not.toContain(customType);
    expect(lines).toContain("Ultrawork mode on");
    expect(renderers.has("wows-omp-omo-ultrawork.directive")).toBe(false);
    expect(renderers.has("wows-omp-omo-ultrawork.exit")).toBe(false);
  });
});
