import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { initTheme } from "@oh-my-pi/pi-tui";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import { z } from "zod";

import type { AdrConnection } from "../plugins/roadmap/src/adr.ts";
import { MESSAGE_TITLES, registerMessageTitles } from "../plugins/roadmap/src/cards.ts";
import { type Actor, todo } from "../plugins/roadmap/src/operations.ts";
import type { RoadmapSession, UiFactory } from "../plugins/roadmap/src/ses.ts";
import { checkReceipt, registerTools, statusReceipt, type ToolReceipt, toolResult } from "../plugins/roadmap/src/tools.ts";
import { cleanupFixtures, diskFixture, planFixture } from "./roadmap-fixtures.ts";

type Result = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean };
type Tool = {
  name: string;
  describeCall: (args: unknown, options: unknown) => NativeToolView;
  describeResult: (result: Result, options: unknown, args?: unknown) => NativeToolView;
  mergeCallAndResult?: boolean;
  renderCall?: unknown;
  renderResult?: unknown;
};
type Renderer = (message: unknown, options: { expanded: boolean }, theme: unknown) => unknown;

const main: Actor = { sessionId: "cards", kind: "main" };
const options = { expanded: false, isPartial: false };

beforeAll(async () => {
  await initTheme();
});
afterEach(cleanupFixtures);

function tools(): Map<string, Tool> {
  const registered = new Map<string, Tool>();
  const pi = { zod: z, events: { on: () => () => {}, emit() {} }, registerTool: (tool: Tool) => registered.set(tool.name, tool) };
  registerTools(
    pi as unknown as ExtensionAPI,
    {} as RoadmapSession,
    (() => undefined) as unknown as UiFactory,
    () => {},
    {} as AdrConnection,
  );
  return registered;
}

function tool(name: string): Tool {
  const found = tools().get(name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

/** Everything a terminal would draw from the view: head facts and body text, as one searchable string. */
function shown(view: NativeToolView): string {
  return JSON.stringify(view);
}

describe("roadmap tool cards", () => {
  test("every tool has native card hooks and keeps the plain-terminal default", () => {
    const registered = tools();
    expect(registered.size).toBe(9);
    for (const definition of registered.values()) {
      expect(typeof definition.describeCall).toBe("function");
      expect(typeof definition.describeResult).toBe("function");
      expect(definition.mergeCallAndResult).toBe(true);
      expect(definition.renderCall).toBeUndefined();
      expect(definition.renderResult).toBeUndefined();
    }
  });

  test("call heads name the action from partial streaming args and omit the intent", () => {
    expect(tool("roadmap_stage").describeCall({ action: "start", id: "S01", i: "Starting stage" }, options).tool).toMatchObject({
      title: "Roadmap",
      target: "stage start S01",
    });
    expect(shown(tool("roadmap_stage").describeCall({ action: "start", id: "S01", i: "Starting stage" }, options))).not.toContain(
      "Starting stage",
    );
    expect(tool("roadmap_stage").describeCall({ action: "sta" }, options).tool?.target).toBe("stage sta");
    expect(tool("roadmap_todo").describeCall({ action: "add" }, options).tool?.target).toBe("todo add");
    expect(tool("roadmap_status").describeCall({ stage: "S03" }, options).tool?.target).toBe("status S03");
    expect(tool("roadmap_check").describeCall({ fix: true }, options).tool?.target).toBe("check fix");
    expect(tool("roadmap_init").describeCall({ project: { name: "Sh" }, stages: [{}] }, options).tool).toMatchObject({
      target: "init Sh",
      meta: ["1 stage"],
    });
    for (const definition of tools().values()) {
      for (const args of [undefined, null, {}, { action: 3, round: "x", project: [] }]) {
        expect(definition.describeCall(args, options).tool?.target).toBeTruthy();
      }
    }
  });

  test("a write receipt shows summary, warnings, handoff and changed files", async () => {
    const { repo } = await diskFixture();
    const written = await todo(repo, main, {
      action: "add",
      title: "Fix flaky payment test",
      severity: "high",
      source: "S01",
      target: "S01",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const receipt: ToolReceipt = { ...written, warnings: ["Target stage is overdue."], handoff: "## Next\n\nShip the payment flow." };
    const view = tool("roadmap_todo").describeResult(toolResult(receipt), options, { action: "add" });
    const text = shown(view);
    expect(view.tool?.target).toBe("todo add");
    expect(view.tone).toBe("warning");
    expect(text).toContain(written.summary);
    expect(text).toContain("Target stage is overdue.");
    expect(text).toContain("Ship the payment flow.");
    expect(text).toContain("Planning handoff");
    for (const file of written.changedFiles) expect(text).toContain(file.split("/").at(-1) as string);
    expect(view.preview).toEqual({ lines: expect.any(Number) });
  });

  test("an error receipt is an error card with the reason and hints", () => {
    const view = tool("roadmap_stage").describeResult(
      toolResult({ ok: false, reason: "Unknown stage S09.", hints: ["Call roadmap_status for stage ids."] }),
      options,
      { action: "start", id: "S09" },
    );
    expect(view.tone).toBe("error");
    expect(view.tool?.target).toBe("stage start S09");
    expect(shown(view)).toContain("Unknown stage S09.");
    expect(shown(view)).toContain("Call roadmap_status for stage ids.");
  });

  test("results without a receipt fall back to their text", () => {
    const view = tool("roadmap_status").describeResult(
      { content: [{ type: "text", text: "Roadmap is not initialized." }], details: undefined, isError: true },
      options,
      {},
    );
    expect(view.tone).toBe("error");
    expect(shown(view)).toContain("Roadmap is not initialized.");
  });

  test("status lists rounds, stages, plans and TODOs as tables with status tones", async () => {
    const { repo, model } = await diskFixture();
    const receipt = await statusReceipt(repo, undefined, () => [planFixture({ stage: model.stages[0]?.id as string })]);
    const view = tool("roadmap_status").describeResult(toolResult(receipt), options, {});
    const tables = (view.body ?? []).flatMap((child) => (typeof child === "object" && child && "c" in child ? (child.c ?? []) : []));
    expect(
      tables.filter((child) => typeof child === "object" && child && "k" in child && child.k === "table").length,
    ).toBeGreaterThanOrEqual(3);
    const text = shown(view);
    for (const round of model.rounds) expect(text).toContain(round.title);
    for (const stage of model.stages) expect(text).toContain(stage.title);
    for (const item of model.todos.flatMap((doc) => doc.items.filter((entry) => entry.status === "open")))
      expect(text).toContain(item.title);
    expect(text).toContain("Atlas plans");
    expect(text).toContain(model.index.title);
    const active = model.stages.find((stage) => stage.status === "active");
    if (active) expect(text).toContain(JSON.stringify({ t: "active", s: "accent" }));
  });

  test("a stage request shows the stage detail with its handoff, without front matter or managed comments", async () => {
    const { repo, model } = await diskFixture();
    const stage = model.stages[0];
    if (!stage) throw new Error("fixture stage");
    const receipt = await statusReceipt(repo, stage.id);
    expect(receipt.ok && receipt.handoff).toBeTruthy();
    const view = tool("roadmap_status").describeResult(toolResult(receipt), options, { stage: stage.id });
    expect(view.tool?.target).toBe(`status ${stage.id}`);
    expect(view.tool?.badges?.[0]?.text).toBe(stage.status);
    const text = shown(view);
    expect(text).toContain(stage.title);
    expect(text).toContain("Planning handoff");
    expect(text).not.toContain("closed_sha256");
    expect(text).not.toContain("<!--");
  });

  test("check shows diagnostics with severity tones", async () => {
    const { repo, model } = await diskFixture();
    const passed = tool("roadmap_check").describeResult(toolResult(await checkReceipt(repo)), options, {});
    expect(passed.tool?.meta).toEqual(["passed"]);
    expect(passed.tone).toBeUndefined();
    const path = model.stages[0]?.path as string;
    await writeFile(path, (await readFile(path, "utf8")).replace("## Objective", "## Wrong"));
    const receipt = await checkReceipt(repo);
    expect(receipt.ok).toBe(false);
    const view = tool("roadmap_check").describeResult(toolResult(receipt), options, {});
    expect(view.tone).toBe("error");
    expect(view.tool?.meta?.[0]).toMatch(/^\d+ errors?$/);
    const rows = (view.body ?? []).filter((child) => typeof child === "object" && child && "p" in child && child.p?.tone === "error");
    expect(rows.length).toBe(receipt.diagnostics?.length ?? -1);
    expect(shown(view)).toContain("structure");
  });

  test("a held preview shows what would be written and how to confirm it", () => {
    const receipt: ToolReceipt = {
      ok: false,
      reason: "Initialize Shop\nNothing was written.",
      hints: [],
      held: {
        summary: "Initialize Shop",
        token: "0123456789ab",
        files: [{ path: "docs/roadmap/README.md", content: "---\nformat: 2\n---\n# Shop\n" }],
      },
    };
    const view = tool("roadmap_init").describeResult(toolResult(receipt), options, { project: { name: "Shop" } });
    expect(view.tone).toBe("warning");
    const text = shown(view);
    expect(text).toContain("/roadmap confirm 0123456789ab");
    expect(text).toContain("docs/roadmap/README.md");
    expect(text).toContain("# Shop");
  });
});

describe("roadmap message titles", () => {
  test("displayed messages render in the host frame under a product title", () => {
    const renderers = new Map<string, Renderer>();
    registerMessageTitles({
      registerMessageRenderer: (customType: string, renderer: Renderer) => renderers.set(customType, renderer),
    } as unknown as ExtensionAPI);
    expect([...renderers.keys()].sort()).toEqual(Object.keys(MESSAGE_TITLES).sort());
    for (const [customType, title] of [
      ["wows-omp-roadmap.status", "Roadmap"],
      ["wows-omp-roadmap.check", "Roadmap check"],
      ["wows-omp-roadmap.upgrade", "Roadmap upgrade"],
    ] as const) {
      const component = renderers.get(customType)?.(
        { role: "custom", customType, content: "Roadmap check passed.", display: true, timestamp: 0 },
        { expanded: true },
        undefined,
      ) as { describe: () => unknown; render: (width: number) => string[] };
      const native = JSON.stringify(component.describe());
      expect(native).toContain(title);
      expect(native).not.toContain(customType);
      const lines = component.render(80).join("\n");
      expect(lines).toContain(title);
      expect(lines).not.toContain(customType);
      expect(lines).toContain("Roadmap check passed.");
    }
  });
});
