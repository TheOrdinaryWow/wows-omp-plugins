import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { initTheme, type NativeChild, type NativeNode, theme } from "@oh-my-pi/pi-tui";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import { z } from "zod";

import { registerMessageTitles } from "../plugins/adr/src/cards.ts";
import { createMany, initialize } from "../plugins/adr/src/operations.ts";
import { registerTools } from "../plugins/adr/src/tools.ts";
import { cleanupFixtures, decision, repoFixture } from "./adr-fixtures.ts";

beforeAll(async () => {
  await initTheme();
});
afterEach(cleanupFixtures);

type Result = { content: { type: string; text: string }[]; details?: unknown; isError?: boolean };
type Tool = {
  name: string;
  execute: (id: string, params: object, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<Result>;
  describeCall: (args: unknown, options: { expanded: boolean }) => NativeToolView;
  describeResult: (result: Result, options: { expanded: boolean }, args?: unknown) => NativeToolView;
  mergeCallAndResult?: boolean;
  renderCall?: unknown;
  renderResult?: unknown;
};
type Renderer = (
  message: { role: "custom"; customType: string; content: string; display: boolean; timestamp: number },
  options: { expanded: boolean },
  t: typeof theme,
) => { describe: () => NativeNode; render: (width: number) => string[] };

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

function walk(children: readonly NativeChild[] | undefined, out: NativeNode[] = []): NativeNode[] {
  for (const child of children ?? []) {
    if (!child || typeof child !== "object" || !("k" in child)) continue;
    out.push(child);
    walk(child.c, out);
  }
  return out;
}

/** Every string a terminal would draw from the view's head and body. */
function visible(view: NativeToolView): string {
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect([view.tool, view.head, view.body]);
  return strings.join("\n");
}

function kinds(view: NativeToolView): string[] {
  return walk(view.body).map((node) => node.k);
}

/** One prop of a node, read through a guard. */
function prop(node: NativeNode | undefined, key: string): unknown {
  const props: unknown = node?.p;
  return props && typeof props === "object" && key in props ? (props as Record<string, unknown>)[key] : undefined;
}

function record(view: NativeToolView): NativeNode | undefined {
  return walk(view.body).find((node) => node.k === "section" && prop(node, "collapsible") === true);
}

const collapsed = { expanded: false };

describe("adr tool cards", () => {
  test("every tool has native views and keeps the plain-terminal default", () => {
    const { tools } = harness();
    expect([...tools.keys()].sort()).toEqual(["adr_check", "adr_manage", "adr_status"]);
    for (const tool of tools.values()) {
      expect(typeof tool.describeCall).toBe("function");
      expect(typeof tool.describeResult).toBe("function");
      expect(tool.mergeCallAndResult).toBe(true);
      expect(tool.renderCall).toBeUndefined();
      expect(tool.renderResult).toBeUndefined();
    }
  });

  test("partial streaming args never throw and give readable targets", () => {
    const { tool } = harness();
    const manage = tool("adr_manage");
    for (const args of [undefined, {}, { action: "set_status" }, { action: "set_status", id: "ADR-00" }, { action: 5, id: null }]) {
      expect(() => manage.describeCall(args, collapsed)).not.toThrow();
      expect(() => tool("adr_status").describeCall(args, collapsed)).not.toThrow();
      expect(() => tool("adr_check").describeCall(args, collapsed)).not.toThrow();
    }
    expect(manage.describeCall({ action: "set_status", status: "accepted", id: "ADR-0004", i: "Accepting" }, collapsed).tool?.target).toBe(
      "accept ADR-0004",
    );
    expect(visible(manage.describeCall({ action: "create", title: "Use Postgres", i: "Creating" }, collapsed))).toContain("Use Postgres");
    expect(visible(manage.describeCall({ action: "note", id: "ADR-0002", i: "Noting intent" }, collapsed))).not.toContain("Noting intent");
    expect(tool("adr_status").describeCall({ id: "ADR-0001" }, collapsed).tool?.target).toBe("ADR-0001");
    expect(tool("adr_check").describeCall({ fix: true }, collapsed).tool?.target).toContain("fix");
  });

  test("adr_status lists ADRs as a table with toned statuses and shows one ADR with a foldable record", async () => {
    const { tool } = harness();
    const status = tool("adr_status");
    const root = await repo();
    const listed = status.describeResult(await run(status, root, {}), collapsed, {});
    expect(kinds(listed)).toContain("table");
    expect(visible(listed)).toContain("ADR-0001");
    expect(visible(listed)).toContain("Keep a read model");
    const table = walk(listed.body).find((node) => node.k === "table");
    expect(JSON.stringify(table)).toContain('"s":"warning"');
    expect(listed.tone).toBeUndefined();

    const args = { id: "ADR-0001" };
    const shown = await run(status, root, args);
    const folded = status.describeResult(shown, collapsed, args);
    expect(folded.tool?.target).toBe("ADR-0001");
    expect(kinds(folded)).toContain("kv");
    expect(visible(folded)).toContain("proposed");
    expect(visible(folded)).toContain("Adopt event sourcing");
    const section = record(folded);
    expect(prop(section, "collapsed")).toBe(true);
    expect(walk(section?.c).some((node) => node.k === "md" && String(prop(node, "text")).includes("event sourcing"))).toBe(true);
    const open = status.describeResult(shown, { expanded: true }, args);
    expect(prop(record(open), "collapsed")).toBe(false);
    expect(status.describeResult(shown, { expanded: true }, args)).toBe(open);
  });

  test("adr_status shows parse warnings and an unknown id as an error", async () => {
    const { tool } = harness();
    const status = tool("adr_status");
    const root = await repo();
    await writeFile(join(root, "docs/adr/0003-broken.md"), "not an adr\n");
    const listed = status.describeResult(await run(status, root, {}), collapsed, {});
    expect(visible(listed)).toContain("0003-broken.md");
    expect(JSON.stringify(listed.body)).toContain("warning");

    const missing = status.describeResult(await run(status, root, { id: "ADR-0099" }), collapsed, { id: "ADR-0099" });
    expect(missing.tone).toBe("error");
    expect(visible(missing)).toContain("ADR-0099 is unknown");
    expect(visible(missing)).toContain("Call adr_status for ADR ids.");
  });

  test("adr_manage shows the action, summary and changed files; refusals show reason and hints", async () => {
    const { tool } = harness();
    const manage = tool("adr_manage");
    const root = await repo();
    const args = { action: "set_status", id: "ADR-0001", status: "accepted" };
    const accepted = manage.describeResult(await run(manage, root, args), collapsed, args);
    expect(accepted.tool?.target).toBe("accept ADR-0001");
    expect(accepted.tone).toBeUndefined();
    expect(visible(accepted)).toContain("ADR-0001: set_status recorded.");
    expect(visible(accepted)).toContain("docs/adr/README.md");
    expect(kinds(accepted)).toContain("list");

    const create = { action: "create", title: "Shard tenants", sections: decision.sections };
    const created = manage.describeResult(await run(manage, root, create), collapsed, create);
    expect(visible(created)).toContain("Created ADR-0003.");
    expect(created.tool?.badges?.map((badge) => badge.text)).toEqual(["ADR-0003"]);

    const refusedArgs = { action: "set_status", id: "ADR-0042", status: "accepted" };
    const refused = await run(manage, root, refusedArgs);
    expect(refused.isError).toBe(true);
    const view = manage.describeResult(refused, collapsed, refusedArgs);
    expect(view.tone).toBe("error");
    expect(visible(view)).toContain("ADR-0042");
  });

  test("adr_check: a clean run is a short success line, failures list diagnostics", async () => {
    const { tool } = harness();
    const check = tool("adr_check");
    const root = await repo();
    const clean = check.describeResult(await run(check, root, {}), collapsed, {});
    expect(clean.tone).toBe("success");
    expect(visible(clean)).toContain("ADR check passed");
    expect(kinds(clean)).not.toContain("list");

    await writeFile(join(root, "docs/adr/0003-broken.md"), "not an adr\n");
    const failed = await run(check, root, {});
    expect(failed.isError).toBe(true);
    const view = check.describeResult(failed, collapsed, {});
    expect(view.tone).toBe("error");
    const rows = walk(view.body).filter((node) => node.k === "item");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => prop(row, "tone") === "error")).toBe(true);
    expect(visible(view)).toContain("0003-broken.md");
    expect(view.tool?.meta?.join(" ")).toMatch(/\d+ errors?/);
  });

  test("results without receipt details fall back to the text as markdown", () => {
    const { tool } = harness();
    for (const name of ["adr_status", "adr_manage", "adr_check"]) {
      const view = tool(name).describeResult({ content: [{ type: "text", text: "Older **result**" }] }, collapsed, {});
      expect(walk(view.body).find((node) => node.k === "md")?.p).toEqual({ text: "Older **result**" });
      const failed = tool(name).describeResult({ content: [{ type: "text", text: "boom" }], isError: true }, collapsed, {});
      expect(failed.tone).toBe("error");
      expect(visible(failed)).toContain("boom");
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
    const component = render(message, collapsed, theme);
    const head = JSON.stringify(prop(component.describe(), "head"));
    expect(head).toContain("ADR check");
    expect(head).not.toContain("wows-omp-adr");
    const lines = component.render(80).join("\n");
    expect(lines).toContain("ADR check");
    expect(lines).toContain("ADR check passed.");
    expect(lines).not.toContain("wows-omp-adr");
    expect(message.customType).toBe("wows-omp-adr.check");
  });
});
