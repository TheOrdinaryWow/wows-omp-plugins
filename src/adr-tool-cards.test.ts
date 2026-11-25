import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isUiNode, setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { z } from "zod";

import { registerMessageTitles } from "../plugins/adr/src/cards.ts";
import { createMany, initialize } from "../plugins/adr/src/operations.ts";
import { registerTools } from "../plugins/adr/src/tools.ts";
import { cleanupFixtures, decision, repoFixture } from "./adr-fixtures.ts";

afterEach(cleanupFixtures);

type Result = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean };
type Tool = {
  name: string;
  execute: (id: string, params: object, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<Result>;
  renderCall: (args: unknown, options: { expanded: boolean }, theme: unknown) => unknown;
  renderResult: (result: Result, options: { expanded: boolean }, theme: unknown, args?: unknown) => unknown;
  mergeCallAndResult?: boolean;
};
type Renderer = (
  message: { role: "custom"; customType: string; content: string; display: boolean; timestamp: number },
  options: { expanded: boolean },
  theme: unknown,
) => unknown;

function harness() {
  const tools = new Map<string, Tool>();
  const renderers = new Map<string, Renderer>();
  const pi = {
    zod: z,
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerMessageRenderer: (customType: string, renderer: Renderer) => renderers.set(customType, renderer),
  } as unknown as ExtensionAPI;
  registerTools(
    pi,
    () => {},
    () => undefined,
  );
  registerMessageTitles(pi);
  const tool = (name: string): Tool => {
    const found = tools.get(name);
    if (!found) throw new Error(`missing ${name}`);
    return found;
  };
  return { tools, renderers, tool };
}

async function repo(): Promise<string> {
  const root = await repoFixture();
  await initialize(root, "main");
  await createMany(root, "main", [decision, { ...decision, title: "Keep a read model" }]);
  return root;
}

async function run(tool: Tool, root: string, params: object): Promise<Result> {
  const ctx = { cwd: root, agent: { kind: "main" } } as unknown as ExtensionContext;
  return tool.execute("call", params, undefined, undefined, ctx);
}

function node(output: unknown): UiNode {
  if (!isUiNode(output)) throw new Error("renderer returned no node");
  return output;
}

function walk(root: UiNode): UiNode[] {
  return [root, ...root.children().flatMap(walk)];
}

/** What a plain terminal paints, without escapes. */
function painted(output: unknown, width = 100): string {
  return renderBlock(node(output), width, { theme: PLAIN_THEME })
    .rows.map((row) => stripEscapes(row).trimEnd())
    .join("\n");
}

const kinds = (output: unknown) => walk(node(output)).map((child) => child.kind);
const prop = (child: UiNode | undefined, key: string) => (child?.props() as Record<string, unknown> | undefined)?.[key];
const record = (output: unknown) => walk(node(output)).find((child) => child.kind === "section" && prop(child, "collapsible") === true);
/** The style of the head's title span: the card's tone. */
const tone = (output: unknown) =>
  (
    prop(
      walk(node(output)).find((child) => child.key() === "target"),
      "spans",
    ) as { s?: string }[]
  )[0]?.s;

const collapsed = { expanded: false };

describe("adr tool cards", () => {
  test("every tool draws its call and result as nodes, merged into one card", () => {
    const { tools } = harness();
    expect([...tools.keys()].sort()).toEqual(["adr_check", "adr_manage", "adr_status"]);
    for (const tool of tools.values()) {
      expect(tool.mergeCallAndResult).toBe(true);
      expect(isUiNode(tool.renderCall({}, collapsed, PLAIN_THEME))).toBe(true);
      expect(isUiNode(tool.renderResult({ content: [] }, collapsed, PLAIN_THEME, {}))).toBe(true);
    }
  });

  test("partial streaming args never throw and give readable heads", () => {
    const { tool } = harness();
    const manage = tool("adr_manage");
    for (const args of [undefined, {}, { action: "set_status" }, { action: "set_status", id: "ADR-00" }, { action: 5, id: null }]) {
      expect(() => painted(manage.renderCall(args, collapsed, PLAIN_THEME))).not.toThrow();
      expect(() => painted(tool("adr_status").renderCall(args, collapsed, PLAIN_THEME))).not.toThrow();
      expect(() => painted(tool("adr_check").renderCall(args, collapsed, PLAIN_THEME))).not.toThrow();
    }
    expect(
      painted(manage.renderCall({ action: "set_status", status: "accepted", id: "ADR-0004", i: "Accepting" }, collapsed, PLAIN_THEME)),
    ).toBe("ADR accept ADR-0004");
    expect(painted(manage.renderCall({ action: "create", title: "Use Postgres", i: "Creating" }, collapsed, PLAIN_THEME))).toContain(
      "Use Postgres",
    );
    expect(painted(manage.renderCall({ action: "note", id: "ADR-0002", i: "Noting intent" }, collapsed, PLAIN_THEME))).not.toContain(
      "Noting intent",
    );
    expect(painted(tool("adr_status").renderCall({ id: "ADR-0001" }, collapsed, PLAIN_THEME))).toBe("ADR ADR-0001");
    expect(painted(tool("adr_check").renderCall({ fix: true }, collapsed, PLAIN_THEME))).toContain("fix");
  });

  test("adr_status lists ADRs as a table with toned statuses and shows one ADR with a foldable record", async () => {
    const { tool } = harness();
    const status = tool("adr_status");
    const root = await repo();
    const listed = status.renderResult(await run(status, root, {}), collapsed, PLAIN_THEME, {});
    expect(kinds(listed)).toContain("table");
    expect(painted(listed)).toMatch(/^ADR list +2 proposed/);
    expect(painted(listed)).toContain("ADR-0001");
    expect(painted(listed)).toContain("Keep a read model");
    expect(
      JSON.stringify(
        walk(node(listed))
          .find((child) => child.kind === "table")
          ?.props(),
      ),
    ).toContain('"s":"warning"');
    expect(tone(listed)).toBe("toolTitle strong");

    const args = { id: "ADR-0001" };
    const shown = await run(status, root, args);
    const folded = status.renderResult(shown, collapsed, PLAIN_THEME, args);
    expect(painted(folded)).toMatch(/^ADR ADR-0001 \[proposed\]/);
    expect(kinds(folded)).toContain("kv");
    expect(painted(folded)).toContain("Adopt event sourcing");
    const section = record(folded);
    expect(prop(section, "collapsed")).toBe(true);
    expect(section?.children().some((child) => child.kind === "md" && String(prop(child, "text")).includes("event sourcing"))).toBe(true);
    expect(painted(folded)).not.toContain("event sourcing, because");
    expect(JSON.stringify(walk(node(folded)).map((child) => child.props()))).not.toContain("<!--");
    const open = status.renderResult(shown, { expanded: true }, PLAIN_THEME, args);
    expect(prop(record(open), "collapsed")).toBe(false);
    expect(painted(open)).toContain("audits replay history");
  });

  test("adr_status shows parse warnings and an unknown id as an error", async () => {
    const { tool } = harness();
    const status = tool("adr_status");
    const root = await repo();
    await writeFile(join(root, "docs/adr/0003-broken.md"), "not an adr\n");
    const listed = painted(status.renderResult(await run(status, root, {}), collapsed, PLAIN_THEME, {}));
    expect(listed).toContain("0003-broken.md");
    expect(listed).toMatch(/Warning/);

    const missing = status.renderResult(await run(status, root, { id: "ADR-0099" }), collapsed, PLAIN_THEME, { id: "ADR-0099" });
    expect(tone(missing)).toBe("error strong");
    expect(painted(missing)).toContain("ADR-0099 is unknown");
    expect(painted(missing)).toContain("Call adr_status for ADR ids.");
  });

  test("adr_manage shows the action, summary and changed files; refusals show reason and hints", async () => {
    const { tool } = harness();
    const manage = tool("adr_manage");
    const root = await repo();
    const args = { action: "set_status", id: "ADR-0001", status: "accepted" };
    const accepted = manage.renderResult(await run(manage, root, args), collapsed, PLAIN_THEME, args);
    expect(painted(accepted)).toMatch(/^ADR accept ADR-0001 \[ADR-0001\] \d+ files?/);
    expect(tone(accepted)).toBe("toolTitle strong");
    expect(painted(accepted)).toContain("ADR-0001: set_status recorded.");
    expect(painted(accepted)).toContain("README.md  docs/adr");
    expect(kinds(accepted)).toContain("list");

    const create = { action: "create", title: "Shard tenants", sections: decision.sections };
    const created = manage.renderResult(await run(manage, root, create), collapsed, PLAIN_THEME, create);
    expect(painted(created)).toContain("Created ADR-0003.");
    expect(
      walk(node(created))
        .filter((child) => child.kind === "badge")
        .map((badge) => prop(badge, "text")),
    ).toEqual(["ADR-0003"]);

    const refusedArgs = { action: "set_status", id: "ADR-0042", status: "accepted" };
    const refused = await run(manage, root, refusedArgs);
    expect(refused.isError).toBe(true);
    const view = manage.renderResult(refused, collapsed, PLAIN_THEME, refusedArgs);
    expect(tone(view)).toBe("error strong");
    expect(painted(view)).toContain("ADR-0042");
  });

  test("adr_check: a clean run is a short success line, failures list diagnostics", async () => {
    const { tool } = harness();
    const check = tool("adr_check");
    const root = await repo();
    const clean = check.renderResult(await run(check, root, {}), collapsed, PLAIN_THEME, {});
    expect(tone(clean)).toBe("success strong");
    expect(painted(clean)).toContain("ADR check passed");
    expect(kinds(clean)).not.toContain("list");

    await writeFile(join(root, "docs/adr/0003-broken.md"), "not an adr\n");
    const failed = await run(check, root, {});
    expect(failed.isError).toBe(true);
    const view = check.renderResult(failed, collapsed, PLAIN_THEME, {});
    expect(tone(view)).toBe("error strong");
    const rows = walk(node(view)).filter((child) => child.kind === "item");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => prop(row, "tone") === "error")).toBe(true);
    expect(painted(view)).toContain("0003-broken.md");
    expect(painted(view)).toMatch(/^ADR check +\d+ errors?/);
  });

  test("in Tern the host draws the title and target, so the hooks lead with the facts it lacks", async () => {
    const { tool } = harness();
    const status = tool("adr_status");
    const root = await repo();
    const args = { id: "ADR-0001" };
    const shown = await run(status, root, args);
    const listed = await run(status, root, {});
    await writeFile(join(root, "docs/adr/0003-broken.md"), "not an adr\n");
    const failed = await run(tool("adr_check"), root, {});
    setNativeRenderingForTest(true);
    try {
      // A call carries nothing beyond the host's head: the label and the args summary.
      for (const name of ["adr_status", "adr_manage", "adr_check"])
        expect(tool(name).renderCall({ id: "ADR-0001", action: "note" }, collapsed, PLAIN_THEME)).toBeUndefined();
      const folded = node(status.renderResult(shown, collapsed, PLAIN_THEME, args));
      expect(walk(folded).some((child) => child.key() === "head" || child.key() === "target")).toBe(false);
      const badge = walk(folded).find((child) => child.kind === "badge");
      expect(badge?.props()).toMatchObject({ text: "proposed", tone: "warning" });
      expect(folded.children()[0]?.key()).toBe("facts");
      expect(kinds(folded)).toContain("kv");
      expect(prop(record(folded), "collapsed")).toBe(true);
      expect(painted(folded)).toMatch(/^\[proposed\]/);

      const list = status.renderResult(listed, collapsed, PLAIN_THEME, {});
      expect(kinds(list)).toContain("table");
      expect(painted(list)).toMatch(/^2 proposed/);

      const check = node(tool("adr_check").renderResult(failed, collapsed, PLAIN_THEME, {}));
      const meta = walk(check).find((child) => child.key() === "meta");
      expect(prop(meta, "spans")).toEqual([expect.objectContaining({ s: "error" })]);
      expect(painted(check)).toMatch(/^\d+ errors?/);

      // A failure without facts still says it failed.
      const boom = status.renderResult({ content: [{ type: "text", text: "boom" }], isError: true }, collapsed, PLAIN_THEME, {});
      expect(painted(boom)).toBe("[error]\n\nboom");
    } finally {
      setNativeRenderingForTest(false);
    }
    expect(painted(status.renderResult(shown, collapsed, PLAIN_THEME, args))).toMatch(/^ADR ADR-0001 \[proposed\]/);
  });

  test("results without receipt details fall back to the text as markdown", () => {
    const { tool } = harness();
    for (const name of ["adr_status", "adr_manage", "adr_check"]) {
      const view = tool(name).renderResult({ content: [{ type: "text", text: "Older **result**" }] }, collapsed, PLAIN_THEME, {});
      expect(
        walk(node(view))
          .find((child) => child.kind === "md")
          ?.props(),
      ).toEqual({ text: "Older **result**" });
      const failed = tool(name).renderResult({ content: [{ type: "text", text: "boom" }], isError: true }, collapsed, PLAIN_THEME, {});
      expect(tone(failed)).toBe("error strong");
      expect(painted(failed)).toContain("boom");
    }
  });
});

describe("adr message titles", () => {
  test("every displayed customType gets a readable title in Tern and plain terminals", () => {
    const { renderers } = harness();
    expect([...renderers.keys()].sort()).toEqual(
      ["check", "confirm", "init", "list", "note", "notice", "show", "status"].map((name) => `wows-omp-adr.${name}`),
    );
    const render = renderers.get("wows-omp-adr.check");
    if (!render) throw new Error("missing renderer");
    const message = {
      role: "custom" as const,
      customType: "wows-omp-adr.check",
      content: "ADR check passed.",
      display: true,
      timestamp: 0,
    };
    const card = node(render(message, collapsed, PLAIN_THEME));
    expect(card.kind).toBe("card");
    expect(JSON.stringify(prop(card, "head"))).toContain("ADR check");
    const lines = painted(card, 80);
    expect(lines).toMatch(/ADR check/);
    expect(lines).toContain("ADR check passed.");
    expect(lines).not.toContain("wows-omp-adr");
    expect(message.customType).toBe("wows-omp-adr.check");
  });
});
