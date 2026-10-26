import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type DescribeContext, initTheme, type NativeChild, type NativeNode, theme } from "@oh-my-pi/pi-tui";
import type { NativeToolView, RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";
import { z } from "zod";

import { runAtlasGit } from "../plugins/omo-prometheus/src/atlas-git.ts";
import register from "../plugins/omo-prometheus/src/index.ts";
import { addDeferredFinding, amendAcceptance, createLedger, ledgerRows, startRow } from "../plugins/omo-prometheus/src/ledger.ts";
import { ledgerCardRow, ledgerProgress } from "../plugins/omo-prometheus/src/tool-cards.ts";

interface CardTool {
  name: string;
  describeCall?: (args: unknown, options: RenderResultOptions) => NativeToolView | undefined;
  describeResult?: (result: unknown, options: RenderResultOptions, args?: unknown) => NativeToolView | undefined;
  mergeCallAndResult?: boolean;
}
type MessageRenderer = (
  message: Record<string, unknown>,
  options: { expanded: boolean },
  theme: unknown,
) => { render(width: number): readonly string[]; describe(cx: DescribeContext): NativeNode };

const tools = new Map<string, CardTool>();
const renderers = new Map<string, MessageRenderer>();

beforeAll(async () => {
  await initTheme();
  // Only registration runs here; every other host surface is a no-op.
  const known: Record<string, unknown> = {
    zod: z,
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    events: { on: () => () => {}, emit() {} },
    registerTool: (tool: CardTool) => tools.set(tool.name, tool),
    registerMessageRenderer: (customType: string, renderer: MessageRenderer) => renderers.set(customType, renderer),
    getActiveTools: () => [],
    getAllTools: () => [],
  };
  const api = new Proxy(known, { get: (target, key) => (typeof key === "string" && key in target ? target[key] : () => undefined) });
  register(api as unknown as ExtensionAPI);
});

const options = (expanded = false): RenderResultOptions => ({ expanded, isPartial: false });
const cx: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => false };
const tool = (name: string): Required<CardTool> => {
  const found = tools.get(name);
  expect(found?.describeCall).toBeFunction();
  expect(found?.describeResult).toBeFunction();
  return found as Required<CardTool>;
};
/** Every node of a view's body, depth first. */
const nodes = (children: readonly NativeChild[] | undefined): NativeNode[] =>
  (children ?? []).flatMap((child) =>
    typeof child === "object" && child !== null && "k" in child ? [child as NativeNode, ...nodes((child as NativeNode).c)] : [],
  );
const shown = (view: unknown): string => JSON.stringify(view);

const planContent = `# Plan

## Tasks
- [ ] T1. Implement the prerequisite
  - Agent: task
  - Depends on: none
  - Acceptance: prerequisite behavior is observed
- [ ] T2. Exercise the dependent behavior
  - Agent: task
  - Depends on: T1
  - Acceptance: dependent behavior is observed

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
`;

test("every tool and displayed message gets a native presentation", () => {
  for (const name of ["atlas_ledger", "atlas_git", "atlas_release", "prometheus_activate"]) {
    expect(tool(name).mergeCallAndResult).toBe(true);
  }
  expect([...renderers.keys()].sort()).toEqual(["wows-omp-omo-prometheus.atlas-start", "wows-omp-omo-prometheus.command-status"]);
});

test("atlas_ledger heads read as the action and row, even from partial arguments", () => {
  const ledger = tool("atlas_ledger");
  expect(ledger.describeCall({ action: "start", id: "T3", i: "Starting row" }, options())?.tool).toMatchObject({ target: "start T3" });
  expect(ledger.describeCall({ action: "verify", id: "F2" }, options())?.tool).toMatchObject({ target: "verify F2" });
  expect(ledger.describeCall({ action: "discover", scope: "in", id: "T1" }, options())?.tool?.target).toBe("discover in T1");
  expect(ledger.describeCall({ action: "amend", id: "T1", acceptance: "new" }, options())?.tool?.target).toBe("amend T1");
  for (const partial of [undefined, {}, { action: "" }, { action: "sta" }, { id: 3 }]) {
    expect(() => ledger.describeCall(partial, options())).not.toThrow();
  }
  expect(shown(ledger.describeCall({ action: "start", id: "T3", i: "Starting row" }, options()))).not.toContain("Starting row");
});

test("atlas_ledger shows the changed row and plan progress, guidance folded until expanded", () => {
  const ledger = createLedger("/plans/plan.md", planContent, ["task"]);
  const row = startRow(ledger, "T1", undefined, ["task"]);
  const result = {
    content: [
      { type: "text", text: "todo refresh" },
      { type: "text", text: "T1 is now in_progress.\n\n| Row | Status |\n|---|---|\n| T1 | in_progress |" },
    ],
    details: { id: row.id, status: row.status, row: ledgerCardRow(row), progress: ledgerProgress(ledger) },
  };
  const args = { action: "start", id: "T1" };
  const collapsed = tool("atlas_ledger").describeResult(result, options(), args);
  expect(collapsed?.tool?.target).toBe("start T1");
  expect(collapsed?.tool?.badges?.[0]).toMatchObject({ text: "in progress" });
  expect(collapsed?.tone).not.toBe("error");
  const body = nodes(collapsed?.body);
  const progress = body.find((node) => node.k === "progress");
  expect(progress?.p).toMatchObject({ value: 0 });
  expect(shown(collapsed)).toContain(`0/${ledgerRows(ledger).length}`);
  expect(shown(collapsed)).toContain("Implement the prerequisite");
  const guidance = body.find((node) => node.k === "section");
  expect(guidance?.p).toMatchObject({ collapsible: true, collapsed: true });
  expect(shown(guidance)).toContain("T1 is now in_progress.");
  const expanded = tool("atlas_ledger").describeResult(result, options(true), args);
  expect(nodes(expanded?.body).find((node) => node.k === "section")?.p).toMatchObject({ collapsed: false });
});

test("atlas_ledger amend shows the ruling, its row, the acceptance now in force and the user's note", () => {
  const ledger = createLedger("/plans/plan.md", planContent, ["task"]);
  const ruling = amendAcceptance(ledger, "T1", "p95 latency stays under 250 ms", "User accepted 250 ms after measuring 230 ms");
  const row = ledgerRows(ledger).find((entry) => entry.id === "T1");
  if (!row) throw new Error("T1 missing");
  const card = tool("atlas_ledger").describeResult(
    {
      content: [{ type: "text", text: `${ruling.id} records the user-confirmed acceptance of T1.` }],
      details: { id: row.id, status: row.status, ruling, row: ledgerCardRow(row), progress: ledgerProgress(ledger) },
    },
    options(),
    { action: "amend", id: "T1" },
  );
  expect(card?.tool?.target).toBe("amend T1");
  expect(card?.tool?.badges).toMatchObject([{ text: "R1", tone: "warning" }, { text: "open" }]);
  const section = nodes(card?.body).find((node) => node.key === "ruling");
  expect(shown(section?.p)).toContain("amends T1 acceptance");
  expect(shown(section)).toContain("p95 latency stays under 250 ms");
  expect(shown(section)).toContain("User accepted 250 ms after measuring 230 ms");
});

test("atlas_ledger status lists every row; a deferred finding shows its triage state", () => {
  const ledger = createLedger("/plans/plan.md", planContent, ["task"]);
  const status = tool("atlas_ledger").describeResult({ content: [{ type: "text", text: "table" }], details: { ledger } }, options(), {
    action: "status",
  });
  for (const row of ledgerRows(ledger)) expect(shown(status)).toContain(row.title);
  expect(nodes(status?.body).some((node) => node.k === "progress")).toBe(true);

  const finding = addDeferredFinding(ledger, { title: "Flaky upstream API", reason: "outside the plan" });
  const deferred = tool("atlas_ledger").describeResult(
    {
      content: [{ type: "text", text: "Deferred" }],
      details: { id: finding.id, finding: { id: finding.id, title: finding.title }, progress: ledgerProgress(ledger) },
    },
    options(),
    { action: "discover", scope: "out" },
  );
  expect(deferred?.tool?.target).toBe("discover out");
  expect(shown(deferred)).toContain("Flaky upstream API");
  expect(shown(deferred)).toContain("needs triage");
});

test("atlas_ledger refusals and pauses read as errors; results without card details fall back to their text", () => {
  const paused = tool("atlas_ledger").describeResult(
    { content: [{ type: "text", text: "Ledger operation refused: Atlas execution paused: proof missing." }], isError: true, details: {} },
    options(),
    { action: "done", id: "T2" },
  );
  expect(paused?.tone).toBe("error");
  expect(paused?.tool?.target).toBe("done T2");
  expect(shown(paused)).toContain("proof missing");

  const legacy = tool("atlas_ledger").describeResult(
    { content: [{ type: "text", text: "T2 is now done." }], details: { id: "T2", status: "done" } },
    options(),
    { action: "done", id: "T2" },
  );
  expect(legacy?.tone).not.toBe("error");
  expect(nodes(legacy?.body).find((node) => node.k === "md")?.p).toMatchObject({ text: "T2 is now done." });
});

test("atlas_git commit card names the commit, its subject and files; failures are errors", async () => {
  const repo = await mkdtemp(join(tmpdir(), "atlas-git-card-"));
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args]);
    git("init", "-q");
    git("config", "user.email", "atlas@example.com");
    git("config", "user.name", "Atlas");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(repo, "a.txt"), "a\n");
    const args = { action: "commit" as const, paths: ["a.txt"], message: "feat: add a" };
    const committed = await runAtlasGit(repo, args);
    expect(committed.ok).toBe(true);
    const card = tool("atlas_git").describeResult(
      { content: [{ type: "text", text: committed.text }], details: { action: "commit", commit: committed.commit } },
      options(),
      args,
    );
    expect(card?.tone).toBe("success");
    expect(card?.tool?.target).toBe(`commit ${committed.commit?.sha.slice(0, 7)}`);
    expect(shown(card)).toContain("feat: add a");
    expect(shown(card)).toContain("a.txt");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
  const pending = tool("atlas_git").describeCall({ action: "commit", paths: ["a.txt", "b.txt"], message: "fix: b\n\nbody" }, options());
  expect(pending?.tool).toMatchObject({ target: "commit", meta: ["2 files"] });
  const refused = tool("atlas_git").describeResult(
    { content: [{ type: "text", text: "Commit refused: a bound child task is still running." }], isError: true, details: {} },
    options(),
    { action: "commit", paths: ["a.txt"] },
  );
  expect(refused?.tone).toBe("error");
  expect(shown(refused)).toContain("still running");
  const diff = tool("atlas_git").describeResult({ content: [{ type: "text", text: "+added" }], details: { action: "diff" } }, options(), {
    action: "diff",
    revision: "HEAD~1",
  });
  expect(diff?.tool?.target).toBe("diff HEAD~1");
  expect(nodes(diff?.body).find((node) => node.k === "code")?.p).toMatchObject({ text: "+added", lang: "diff" });
});

test("atlas_release and prometheus_activate show their outcome", () => {
  const release = tool("atlas_release");
  expect(shown(release.describeCall({ reason: "All rows verified" }, options()))).toContain("All rows verified");
  const refused = release.describeResult(
    {
      content: [{ type: "text", text: "Release refused: deferred findings still lack a triage (O1 x)." }],
      isError: true,
      details: { untriaged: ["O1"] },
    },
    options(),
  );
  expect(refused?.tone).toBe("error");
  expect(refused?.tool?.meta).toEqual(["1 untriaged"]);
  expect(release.describeResult({ content: [{ type: "text", text: "Atlas exited by the user." }], details: {} }, options())?.tone).toBe(
    "success",
  );
  const activate = tool("prometheus_activate");
  expect(activate.describeCall({}, options())?.tool?.title).toBe("Prometheus Activate");
  const denied = activate.describeResult({ content: [{ type: "text", text: "no consent" }], isError: true, details: {} }, options());
  expect(denied?.tone).toBe("error");
});

test("displayed messages carry a product title instead of their customType", () => {
  for (const [customType, title, content] of [
    ["wows-omp-omo-prometheus.command-status", "Prometheus", "No approved plan to resume."],
    ["wows-omp-omo-prometheus.atlas-start", "Atlas", "Execute the approved plan North now."],
  ] as const) {
    const renderer = renderers.get(customType);
    expect(renderer).toBeFunction();
    const message = { role: "custom", customType, content, display: true, timestamp: 0 };
    const component = renderer?.(message, { expanded: false }, theme);
    const head = JSON.stringify(component?.describe(cx));
    expect(head).toContain(title);
    expect(head).not.toContain(customType);
    const lines = Bun.stripANSI(component?.render(80).join("\n") ?? "");
    expect(lines).toContain(title);
    expect(lines).toContain(content.split(" ")[0] ?? content);
    expect(lines).not.toContain(customType);
    expect(message.customType).toBe(customType);
  }
});
