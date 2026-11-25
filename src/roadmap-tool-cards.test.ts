import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { z } from "zod";

import type { AdrConnection } from "../plugins/roadmap/src/adr.ts";
import { MESSAGE_TITLES, registerMessageTitles } from "../plugins/roadmap/src/cards.ts";
import { registerCommands } from "../plugins/roadmap/src/commands.ts";
import { renderRound, renderStage } from "../plugins/roadmap/src/documents.ts";
import { type Actor, todo } from "../plugins/roadmap/src/operations.ts";
import type { PlanningGate } from "../plugins/roadmap/src/planning-gate.ts";
import type { RoadmapSession, UiFactory } from "../plugins/roadmap/src/ses.ts";
import { StageOrderPreference } from "../plugins/roadmap/src/settings.ts";
import { checkReceipt, registerTools, statusReceipt, type ToolReceipt, toolResult } from "../plugins/roadmap/src/tools.ts";
import { HeadlessUi } from "../plugins/roadmap/src/ui.ts";
import { cleanupFixtures, diskFixture, planFixture } from "./roadmap-fixtures.ts";

type Result = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean };
type Tool = {
  name: string;
  renderCall: (args: unknown, options: unknown, theme: unknown) => UiNode | undefined;
  renderResult: (result: Result, options: unknown, theme: unknown, args?: unknown) => UiNode;
  mergeCallAndResult?: boolean;
  describeCall?: unknown;
  describeResult?: unknown;
};
type Renderer = (message: unknown, options: { expanded: boolean }, theme: unknown) => UiNode | undefined;

/** A described node, as Tern receives it. */
interface Described {
  k: string;
  key?: string;
  p?: Record<string, unknown>;
  c?: Described[];
}

const theme = loadThemeSync("dark");
const environment = staticEnvironment(theme);
const main: Actor = { sessionId: "cards", kind: "main" };
const options = { expanded: false, isPartial: false };

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
    new StageOrderPreference({ warn() {} }),
    {} as PlanningGate,
  );
  return registered;
}

function tool(name: string): Tool {
  const found = tools().get(name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

function described(node: UiNode): Described {
  return describeTree(node, environment) as Described;
}

function walk(root: Described): Described[] {
  return [root, ...(root.c ?? []).flatMap(walk)];
}

/** Everything Tern receives for the card, as one searchable string. */
function shown(node: UiNode): string {
  return JSON.stringify(described(node));
}

/** The plain text of the head line the card draws first. */
function head(node: UiNode): string {
  const line = walk(described(node)).find((child) => child.key === "head");
  return ((line?.p?.spans as { t: string }[] | undefined) ?? []).map((part) => part.t).join("");
}

function tone(node: UiNode): unknown {
  return described(node).p?.tone;
}

function call(name: string, args: unknown): UiNode {
  const node = tool(name).renderCall(args, options, theme);
  if (!node) throw new Error(`${name} drew no call`);
  return node;
}
const result = (name: string, value: Result, args: unknown, expanded = false) =>
  tool(name).renderResult(value, { ...options, expanded }, theme, args);

describe("roadmap tool cards", () => {
  test("every tool draws its call and result as nodes, merged into one card", () => {
    const registered = tools();
    expect(registered.size).toBe(9);
    for (const definition of registered.values()) {
      expect(typeof definition.renderCall).toBe("function");
      expect(typeof definition.renderResult).toBe("function");
      expect(definition.mergeCallAndResult).toBe(true);
      expect(definition.describeCall).toBeUndefined();
      expect(definition.describeResult).toBeUndefined();
    }
  });

  test("call heads name the action from partial streaming args and omit the intent", () => {
    expect(head(call("roadmap_stage", { action: "start", id: "S01", i: "Starting stage" }))).toBe("Roadmap stage start S01");
    expect(shown(call("roadmap_stage", { action: "start", id: "S01", i: "Starting stage" }))).not.toContain("Starting stage");
    expect(head(call("roadmap_stage", { action: "sta" }))).toBe("Roadmap stage sta");
    expect(head(call("roadmap_todo", { action: "add" }))).toBe("Roadmap todo add");
    expect(head(call("roadmap_status", { stage: "S03" }))).toBe("Roadmap status S03");
    expect(head(call("roadmap_check", { fix: true }))).toBe("Roadmap check fix");
    expect(head(call("roadmap_init", { project: { name: "Sh" }, stages: [{}] }))).toBe("Roadmap init Sh · 1 stage");
    for (const [name] of tools()) {
      for (const args of [undefined, null, {}, { action: 3, round: "x", project: [] }]) {
        expect(head(call(name, args)).replace(/^Roadmap /, "")).toBeTruthy();
      }
    }
  });

  test("a write receipt keeps model instructions folded while showing operation facts", async () => {
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
    const card = result("roadmap_todo", toolResult(receipt), { action: "add" });
    const text = shown(card);
    expect(head(card)).toMatch(/^Roadmap todo add/);
    expect(tone(card)).toBe("warning");
    expect(text).toContain(written.summary);
    expect(text).toContain("Target stage is overdue.");
    expect(text).not.toContain("Ship the payment flow.");
    expect(text).not.toContain("Model text");
    for (const file of written.changedFiles) expect(text).toContain(file.split("/").at(-1) as string);
    const expanded = described(result("roadmap_todo", toolResult(receipt), { action: "add" }, true));
    const folded = walk(expanded).find((child) => child.key === "model-text");
    expect(folded).toMatchObject({ p: { collapsible: true, collapsed: true } });
    expect(JSON.stringify(folded)).toContain("Ship the payment flow.");
  });

  test("an error receipt is an error card with the reason and hints", () => {
    const card = result(
      "roadmap_stage",
      toolResult({ ok: false, reason: "Unknown stage S09.", hints: ["Call roadmap_status for stage ids."] }),
      { action: "start", id: "S09" },
    );
    expect(tone(card)).toBe("error");
    expect(head(card)).toBe("Roadmap stage start S09");
    expect(shown(card)).toContain("Unknown stage S09.");
    expect(shown(card)).toContain("Call roadmap_status for stage ids.");
  });

  test("results without a receipt keep model text folded and formatted", () => {
    const card = result("roadmap_status", { content: [{ type: "text", text: "Roadmap is not initialized." }], isError: true }, {});
    expect(tone(card)).toBe("error");
    expect(shown(card)).not.toContain("Roadmap is not initialized.");
    const expanded = result(
      "roadmap_status",
      {
        content: [
          {
            type: "text",
            text: 'Roadmap is not initialized.\nCall: {"stage":"S01"}\n| Stage | Status |\n| --- | --- |\n| S01 | planned |',
          },
        ],
        isError: true,
      },
      {},
      true,
    );
    expect(shown(expanded)).toContain("Roadmap is not initialized.");
    expect(shown(expanded)).toContain('"k":"code"');
    expect(shown(expanded)).toContain('"k":"table"');
    expect(shown(expanded)).toContain('"collapsed":true');
  });

  test("status lists rounds, stages, plans and TODOs as tables with status tones, clamped while collapsed", async () => {
    const { repo, model } = await diskFixture();
    const receipt = await statusReceipt(repo, undefined, () => [planFixture({ stage: model.stages[0]?.id as string })]);
    const card = result("roadmap_status", toolResult(receipt), {});
    const tree = described(card);
    expect(walk(tree).find((child) => child.key === "body")?.p).toMatchObject({ collapsed: true, preview: { lines: 12 } });
    const statusTables = walk(tree).filter((child) => child.k === "table");
    expect(statusTables).toHaveLength(4);
    for (const table of statusTables) {
      const columns = (table.p?.cols ?? []) as { id: string; priority?: number; truncate?: string; grow?: number }[];
      const essential = columns.filter((column) => ["id", "stage", "title", "label", "status"].includes(column.id));
      const secondary = columns.filter((column) => !essential.includes(column));
      for (const column of essential) {
        for (const other of secondary) expect(column.priority ?? 0).toBeGreaterThan(other.priority ?? 0);
      }
      for (const column of columns) expect(column.truncate).toBe("end");
      expect(columns.find((column) => column.id === "title" || column.id === "label")?.grow).toBeGreaterThan(0);
    }
    const text = shown(card);
    for (const round of model.rounds) expect(text).toContain(round.title);
    for (const stage of model.stages) expect(text).toContain(stage.title);
    for (const item of model.todos.flatMap((doc) => doc.items.filter((entry) => entry.status === "open")))
      expect(text).toContain(item.title);
    expect(text).toContain("Atlas plans");
    expect(head(card)).toContain(model.index.title);
    const active = model.stages.find((stage) => stage.status === "active");
    if (active) expect(text).toContain(JSON.stringify({ s: "accent", t: "active" }));
    expect(walk(described(result("roadmap_status", toolResult(receipt), {}, true))).some((child) => child.key === "body")).toBe(false);
  });

  test("a stage request shows only structured facts, with the full model handoff folded on expansion", async () => {
    const { repo, model } = await diskFixture();
    const stage = model.stages[0];
    if (!stage) throw new Error("fixture stage");
    const receipt = await statusReceipt(repo, stage.id);
    expect(receipt.ok && receipt.handoff).toBeTruthy();
    const card = result("roadmap_status", toolResult(receipt), { stage: stage.id });
    expect(head(card)).toMatch(new RegExp(`^Roadmap status ${stage.id} · ${stage.id} · .* \\[${stage.status}\\]`));
    const text = shown(card);
    expect(text).toContain(stage.title);
    expect(text).toContain("Criteria");
    expect(text).toContain("DC1");
    expect(text).toContain("T001");
    expect(text).toContain("ADR-0001");
    expect(text).not.toContain("Planning handoff");
    expect(text).not.toContain(stage.objective);
    const expanded = described(result("roadmap_status", toolResult(receipt), { stage: stage.id }, true));
    const folded = walk(expanded).find((child) => child.key === "model-text");
    expect(folded).toMatchObject({ p: { collapsible: true, collapsed: true } });
    expect(JSON.stringify(folded)).toContain("Planning handoff");
    const outside = (expanded.c ?? []).filter((child) => child !== folded);
    expect(JSON.stringify(outside)).not.toContain("Closing guidance");
    if (!receipt.ok || !receipt.focus) throw new Error("missing focus");
    const old = {
      ...receipt,
      focus: { kind: receipt.focus.kind, id: stage.id, title: stage.title, status: stage.status, target: null, overdue: false },
    };
    const oldCard = result("roadmap_status", toolResult(old), { stage: stage.id });
    expect(shown(oldCard)).toContain(stage.title);
    expect(shown(oldCard)).not.toContain("Planning handoff");
  });

  test("check shows diagnostics with severity tones", async () => {
    const { repo, model } = await diskFixture();
    const passed = result("roadmap_check", toolResult(await checkReceipt(repo)), {});
    expect(head(passed)).toBe("Roadmap check · passed");
    expect(tone(passed)).toBeUndefined();
    const path = model.stages[0]?.path as string;
    await writeFile(path, (await readFile(path, "utf8")).replace("## Objective", "## Wrong"));
    const receipt = await checkReceipt(repo);
    expect(receipt.ok).toBe(false);
    const card = result("roadmap_check", toolResult(receipt), {});
    expect(tone(card)).toBe("error");
    expect(head(card)).toMatch(/^Roadmap check · \d+ errors?/);
    const rows = walk(described(card)).filter((child) => child.k === "text" && child.p?.tone === "error");
    expect(rows.length).toBe(receipt.diagnostics?.length ?? -1);
    expect(shown(card)).toContain("structure");
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
    const card = result("roadmap_init", toolResult(receipt), { project: { name: "Shop" } });
    expect(tone(card)).toBe("warning");
    expect(head(card)).toBe("Roadmap init Shop [not written]");
    const text = shown(card);
    expect(text).toContain("/roadmap confirm 0123456789ab");
    expect(text).toContain("docs/roadmap/README.md");
    expect(text).toContain("# Shop");
    expect(walk(described(card)).filter((child) => child.k === "section")).toEqual([
      expect.objectContaining({ p: expect.objectContaining({ collapsed: true }) }),
    ]);
  });

  test("cards paint in the terminal within the width", async () => {
    const { repo } = await diskFixture();
    const card = result("roadmap_status", toolResult(await statusReceipt(repo)), {});
    for (const width of [60, 100]) {
      const rows = renderBlock(card, width, { theme }).rows.map(stripEscapes);
      expect(rows[0]).toMatch(/^Roadmap status/);
      expect(rows.join("\n")).toMatch(/… \d+ more lines/);
    }
  });

  test("in Tern the host heads the card, so the hooks keep only the facts its generic head lacks", async () => {
    const { repo } = await diskFixture();
    const status = toolResult(await statusReceipt(repo));
    const held = toolResult({
      ok: false,
      reason: "Initialize Shop\nNothing was written.",
      hints: [],
      held: { summary: "Initialize Shop", token: "0123456789ab", files: [] },
    });
    setNativeRenderingForTest(true);
    try {
      expect(tool("roadmap_stage").renderCall({ action: "start", id: "S01" }, options, theme)).toBeUndefined();
      expect(head(call("roadmap_init", { project: { name: "Sh" }, stages: [{}] }))).toBe("1 stage");
      const card = result("roadmap_status", status, {});
      expect(head(card)).toMatch(/^Example project · R1 Launchable v1/);
      expect(head(card)).not.toMatch(/Roadmap status/);
      expect(shown(card)).toContain('"k":"table"');
      const refused = result("roadmap_init", held, { project: { name: "Shop" } });
      expect(tone(refused)).toBe("warning");
      expect(head(refused)).toBe("[not written]");
      expect(shown(refused)).toContain("/roadmap confirm 0123456789ab");
    } finally {
      setNativeRenderingForTest(false);
    }
    expect(head(call("roadmap_stage", { action: "start", id: "S01" }))).toBe("Roadmap stage start S01");
    expect(head(result("roadmap_status", status, {}))).toMatch(/^Roadmap status/);
  });
});

describe("roadmap message titles", () => {
  function renderers(): Map<string, Renderer> {
    const registered = new Map<string, Renderer>();
    registerMessageTitles({
      registerMessageRenderer: (customType: string, renderer: Renderer) => registered.set(customType, renderer),
    } as unknown as ExtensionAPI);
    return registered;
  }

  test("displayed messages render as cards under a product title", () => {
    const registered = renderers();
    expect([...registered.keys()].sort()).toEqual(Object.keys(MESSAGE_TITLES).sort());
    for (const [customType, title] of [
      ["wows-omp-roadmap.status", "Roadmap"],
      ["wows-omp-roadmap.check", "Roadmap check"],
      ["wows-omp-roadmap.upgrade", "Roadmap upgrade"],
    ] as const) {
      const node = registered.get(customType)?.(
        { role: "custom", customType, content: "Roadmap check passed.", display: true, timestamp: 0 },
        { expanded: true },
        theme,
      );
      if (!node) throw new Error("no node");
      const native = shown(node);
      expect(native).toContain(title);
      expect(native).not.toContain(customType);
      const lines = renderBlock(node, 80, { theme }).rows.map(stripEscapes).join("\n");
      expect(lines).toContain(title);
      expect(lines).not.toContain(customType);
      expect(lines).toContain("Roadmap check passed.");
    }
  });

  test("legacy displayed handoffs stay folded and formatted", () => {
    const content = `# Planning handoff: S01\n\n${"Large charter paragraph.\n".repeat(50)}\nCall: {"stage":"S01"}`;
    for (const expanded of [false, true]) {
      const node = renderers().get("wows-omp-roadmap.status")?.(
        { role: "custom", customType: "wows-omp-roadmap.status", content, display: true, timestamp: 0 },
        { expanded },
        theme,
      );
      if (!node) throw new Error("no node");
      const native = shown(node);
      expect(native.includes("Large charter paragraph")).toBe(expanded);
      if (expanded) {
        expect(native).toContain('"collapsed":true');
        expect(native).toContain('"k":"code"');
      }
      expect(renderBlock(node, 80, { theme }).rows.map(stripEscapes).join("\n")).not.toContain("Large charter paragraph");
    }
  });

  test("RPC and headless commands display receipt facts and preserve the exact full model message", async () => {
    const { repo, model } = await diskFixture();
    const stage = model.stages[0];
    const round = model.rounds[0];
    if (!stage || !round) throw new Error("missing fixture");
    stage.objective = "Large stage objective.\n".repeat(100);
    round.goal = "Large round charter.\n".repeat(100);
    await writeFile(stage.path, renderStage(stage));
    await writeFile(round.path, renderRound(round));
    const expected = toolResult(await statusReceipt(repo, stage.id)).content[0]?.text;
    for (const hasUI of [true, false]) {
      const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
      const messages: Array<{ content: string; display: boolean; details?: unknown }> = [];
      const pi = {
        events: { on: () => () => {}, emit() {} },
        registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) =>
          commands.set(name, definition),
        sendMessage: (message: { content: string; display: boolean; details?: unknown }) => messages.push(message),
      };
      const ctx = {
        cwd: repo.repoRoot,
        mode: "rpc",
        hasUI,
        agent: { kind: "main" },
        sessionManager: { getSessionId: () => "cards" },
      } as unknown as ExtensionCommandContext;
      registerCommands(
        pi as unknown as ExtensionAPI,
        {} as RoadmapSession,
        () => new HeadlessUi(pi as unknown as ExtensionAPI),
        () => {},
        { require: () => repo.adr } as unknown as AdrConnection,
        new StageOrderPreference({ warn() {} }),
        {} as PlanningGate,
      );
      await commands.get("roadmap")?.handler(`stage ${stage.id}`, ctx);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ content: expected, display: false });
      const displayed = messages[1];
      expect(displayed?.display).toBe(true);
      expect(displayed?.content).toContain(stage.id);
      expect(displayed?.content).toContain("DC1");
      expect(displayed?.content).toContain("T001");
      expect(displayed?.content.length).toBeLessThan(500);
      expect(displayed?.content).not.toContain("Large round charter");
      expect(displayed?.content).not.toContain("Large stage objective");
    }
  });
});
