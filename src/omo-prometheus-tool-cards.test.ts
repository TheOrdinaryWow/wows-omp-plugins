import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { z } from "zod";

import { runAtlasGit } from "../plugins/omo-prometheus/src/atlas-git.ts";
import register from "../plugins/omo-prometheus/src/index.ts";
import {
  addDeferredFinding,
  amendAcceptance,
  createLedger,
  ledgerRows,
  recordReceipt,
  renderLedgerSummary,
  startRow,
} from "../plugins/omo-prometheus/src/ledger.ts";
import { ledgerCardRow, ledgerProgress, rowSummary } from "../plugins/omo-prometheus/src/tool-cards.ts";

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}
interface CardTool {
  name: string;
  renderCall?: (args: unknown, options: RenderOptions, theme: unknown) => UiNode | undefined;
  renderResult?: (result: unknown, options: RenderOptions, theme: unknown, args?: unknown) => UiNode | undefined;
  mergeCallAndResult?: boolean;
}
type MessageRenderer = (message: Record<string, unknown>, options: { expanded: boolean }, theme: unknown) => UiNode | undefined;

const tools = new Map<string, CardTool>();
const renderers = new Map<string, MessageRenderer>();
const theme = loadThemeSync("dark");

beforeAll(() => {
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

const options = (expanded = false): RenderOptions => ({ expanded, isPartial: false });

/** A card as the tests read it: its tone, the head row's target, badges and facts, and every node of its body. */
interface Card {
  root: UiNode;
  tone?: string;
  title?: string;
  target?: string;
  meta?: string;
  badges: { text: string; tone?: string }[];
  body: UiNode[];
}

function nodes(root: UiNode, out: UiNode[] = []): UiNode[] {
  out.push(root);
  for (const child of root.children()) nodes(child, out);
  return out;
}
const props = (node: UiNode | undefined): Record<string, unknown> => (node?.props() ?? {}) as Record<string, unknown>;

function card(root: UiNode | undefined): Card {
  if (!root) throw new Error("no card drawn");
  const [head, ...rest] = root.children();
  const [name, ...facts] = head?.children() ?? [];
  const spans = (props(name).spans ?? []) as TspSpan[];
  const meta = facts.find((node) => node.kind === "text");
  return {
    root,
    tone: props(root).tone as string | undefined,
    title: spans[0]?.t,
    target: spans[1]?.t.trim(),
    meta: ((props(meta).spans ?? []) as TspSpan[]).map((part) => part.t).join(""),
    badges: facts.filter((node) => node.kind === "badge").map((node) => props(node) as { text: string; tone?: string }),
    body: rest.flatMap((node) => nodes(node)),
  };
}
const tree = (node: UiNode): unknown => [node.kind, node.key(), node.props(), node.children().map(tree)];
const shown = (value: UiNode | Card | undefined): string =>
  value === undefined ? "null" : JSON.stringify(tree("root" in value ? value.root : value));
const call = (name: string, args: unknown, expanded = false): Card => card(tool(name).renderCall(args, options(expanded), theme));
const result = (name: string, value: unknown, expanded = false, args?: unknown): Card =>
  card(tool(name).renderResult(value, options(expanded), theme, args));

/** The card's lines as the terminal paints it at `width`. */
function painted(node: UiNode | undefined, width = 100): string {
  if (!node) throw new Error("no card drawn");
  const term = createTestTerminal(() => ({ dock: node }), { columns: width, rows: 40, theme });
  const lines = term.screen().join("\n");
  term.dispose();
  return lines;
}

const tool = (name: string): Required<CardTool> => {
  const found = tools.get(name);
  expect(found?.renderCall).toBeFunction();
  expect(found?.renderResult).toBeFunction();
  return found as Required<CardTool>;
};

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

test("ledger cards offer T dependents after recorded HEAVY implementation without offering gates", () => {
  const content = planContent.replace("  - Depends on: none", "  - Tier: HEAVY\n  - Depends on: none");
  const ledger = createLedger("/plans/plan.md", content, ["task"]);
  const row = startRow(ledger, "T1");
  recordReceipt(
    row,
    {
      receiptId: "implementation",
      ledgerId: ledger.ledgerId,
      planSha256: ledger.planSha256,
      rowId: row.id,
      attempt: row.attempt ?? "",
      childAgentId: "Implementer",
      parentAgentId: "Main",
      sessionId: "session",
      childCreatedAt: Date.now(),
      outputSha256: "a".repeat(64),
      capturedAt: Date.now(),
      nativeFinal: true,
    },
    "implementation evidence",
  );

  expect(ledgerProgress(ledger)).toEqual({ done: 0, total: 6, next: ["T2"] });
  expect(ledgerProgress({ items: ledger.items })).toEqual({ done: 0, total: 2, next: ["T2"] });
  row.status = "blocked";
  expect(ledgerProgress(ledger).next).toEqual([]);
});

test("every tool and displayed message gets a card", () => {
  for (const name of ["atlas_ledger", "atlas_git", "atlas_release", "prometheus_activate"]) {
    expect(tool(name).mergeCallAndResult).toBe(true);
  }
  expect([...renderers.keys()].sort()).toEqual(["wows-omp-omo-prometheus.atlas-start", "wows-omp-omo-prometheus.command-status"]);
});

test("in Tern the hooks draw only the body under the host's own tool head; the terminal gets the head row", () => {
  const diff = { content: [{ type: "text", text: "+added" }], details: { action: "diff" } };
  const refusal = { content: [{ type: "text", text: "Ledger operation refused: proof missing." }], isError: true, details: {} };
  setNativeRenderingForTest(true);
  try {
    expect(tool("atlas_ledger").renderCall({ action: "start", id: "T3" }, options(), theme)).toBeUndefined();
    const body = tool("atlas_git").renderResult(diff, options(), theme, { action: "diff", revision: "HEAD~1" });
    if (!body) throw new Error("no Tern body");
    expect(nodes(body).some((node) => node.key() === "head")).toBe(false);
    const pending = tool("atlas_git").renderCall({ action: "commit", paths: ["a.txt", "b.txt"] }, options(), theme);
    const facts = pending ? nodes(pending).find((node) => node.key() === "head") : undefined;
    expect(shown(facts)).toContain("2 files");
    expect(shown(facts)).not.toContain("Atlas Git");
    expect(shown(body)).not.toContain("Atlas Git");
    expect(props(nodes(body).find((node) => node.kind === "code"))).toMatchObject({ text: "+added", lang: "diff" });
    const refused = tool("atlas_ledger").renderResult(refusal, options(), theme, { action: "done", id: "T2" });
    expect(props(refused).tone).toBe("error");
    expect(shown(refused)).toContain("proof missing");
    expect(shown(refused)).not.toContain("Atlas Ledger");
  } finally {
    setNativeRenderingForTest(false);
  }
  const terminal = result("atlas_git", diff, false, { action: "diff", revision: "HEAD~1" });
  expect(terminal).toMatchObject({ title: "Atlas Git", target: "diff HEAD~1" });
  expect(painted(terminal.root)).toMatch(/Atlas Git diff HEAD~1/);
});

test("atlas_ledger heads read as the action and row, even from partial arguments", () => {
  expect(call("atlas_ledger", { action: "start", id: "T3", i: "Starting row" })).toMatchObject({
    title: "Atlas Ledger",
    target: "start T3",
  });
  expect(call("atlas_ledger", { action: "verify", id: "F2" }).target).toBe("verify F2");
  expect(call("atlas_ledger", { action: "discover", scope: "in", id: "T1" }).target).toBe("discover in T1");
  expect(call("atlas_ledger", { action: "amend", id: "T1", acceptance: "new" }).target).toBe("amend T1");
  for (const partial of [undefined, {}, { action: "" }, { action: "sta" }, { id: 3 }]) {
    expect(() => call("atlas_ledger", partial)).not.toThrow();
  }
  expect(shown(call("atlas_ledger", { action: "start", id: "T3", i: "Starting row" }))).not.toContain("Starting row");
  expect(painted(tool("atlas_ledger").renderCall({ action: "start", id: "T3" }, options(), theme))).toMatch(/Atlas Ledger start T3/);
});

test("atlas_ledger shows the changed row and progress; expanding adds that row's facts and folds the model text", () => {
  const ledger = createLedger("/plans/plan.md", planContent, ["task"]);
  const row = startRow(ledger, "T1", undefined, ["task"]);
  const modelText = [
    "T1 is now in_progress.",
    "",
    "| ID | Status |",
    "| --- | --- |",
    "| T1. Pipe \\| inside | in_progress |",
    "| T2 | open |",
    "T1 acceptance: run `bun test` twice",
    'Assignment for T1: atlas_assignment: {"planSha256":"abc","rows":{"T1":"a1"}}',
    "Next dispatchable: none",
  ].join("\n");
  const value = {
    content: [
      {
        type: "text",
        text: 'Refresh the todo HUD now with the already-synced item: todo({"op":"start","task":"T1"}). Until then dispatch is refused.',
      },
      { type: "text", text: modelText },
    ],
    details: { id: row.id, status: row.status, row: ledgerCardRow(ledger, row), progress: ledgerProgress(ledger) },
  };
  const args = { action: "start", id: "T1" };
  const collapsed = result("atlas_ledger", value, false, args);
  expect(collapsed.target).toBe("start T1");
  expect(collapsed.badges[0]).toMatchObject({ text: "in progress" });
  expect(collapsed.tone).not.toBe("error");
  expect(props(collapsed.body.find((node) => node.kind === "progress"))).toMatchObject({ value: 0 });
  expect(shown(collapsed)).toContain(`0/${ledgerRows(ledger).length}`);
  expect(shown(collapsed)).toContain("Implement the prerequisite");
  expect(shown(collapsed)).not.toContain("prerequisite behavior is observed");
  expect(shown(collapsed)).not.toContain("T1 is now in_progress.");
  const terminal = painted(collapsed.root);
  expect(terminal).toMatch(/Atlas Ledger start T1 \[in progress\] 0\/6 done/);
  expect(terminal).toMatch(/T1 Implement the prerequisite +in progress · task/);

  const expanded = result("atlas_ledger", value, true, args).body;
  expect(shown(expanded.find((node) => node.key() === "acceptance"))).toContain("prerequisite behavior is observed");
  const facts = shown(expanded.find((node) => node.kind === "kv"));
  expect(facts).toContain("4h");
  // T1 is running and T2 waits on it, so nothing else can start.
  expect(facts).toContain("none");
  const raw = expanded.find((node) => node.key() === "model-text");
  expect(props(raw)).toMatchObject({ collapsible: true, collapsed: true });
  // The model's text arrives formatted: its table as a native table, its JSON indented, nothing left as raw pipes or one-line JSON.
  const inside = raw ? nodes(raw).slice(1) : [];
  const table = inside.find((node) => node.kind === "table");
  expect(props(table)).toMatchObject({
    cols: [{ head: "ID" }, { head: "Status" }],
    rows: [{ cells: { 0: "T1. Pipe | inside", 1: "in_progress" } }, { cells: { 0: "T2", 1: "open" } }],
  });
  const json = inside.flatMap((node) => (node.kind === "code" ? [props(node).text] : []));
  expect(json).toEqual([
    JSON.stringify({ op: "start", task: "T1" }, null, 2),
    JSON.stringify({ planSha256: "abc", rows: { T1: "a1" } }, null, 2),
  ]);
  const prose = inside.flatMap((node) => (node.kind === "md" ? [props(node).text] : []));
  expect(prose).toEqual([
    "Refresh the todo HUD now with the already-synced item: todo",
    "Until then dispatch is refused.",
    "T1 is now in_progress.",
  ]);
  // `Label: value` lines read as aligned fields, their backtick runs as code.
  const fields = inside.flatMap((node) => (node.kind === "kv" ? [props(node).items] : []));
  expect(fields).toMatchObject([
    [
      { k: [{ t: "T1 acceptance" }], v: [{ t: "run " }, { t: "bun test", s: "code" }, { t: " twice" }] },
      { k: [{ t: "Assignment for T1" }], v: [{ t: "atlas_assignment:" }] },
    ],
    [{ k: [{ t: "Next dispatchable" }], v: [{ t: "none" }] }],
  ]);
  // The model's plan table reaches the user only inside that folded section.
  const outside = expanded.filter((node) => node !== raw && !inside.includes(node) && node.kind !== "list" && node.kind !== "item");
  expect(outside.some((node) => node.kind !== "col" && shown(node).includes("T2"))).toBe(false);
});

test("atlas_ledger expanded card names a stopped retry window and the amendment behind the acceptance", () => {
  const ledger = createLedger("/plans/plan.md", planContent, ["task"]);
  amendAcceptance(ledger, "T1", "p95 latency stays under 250 ms", "User accepted 250 ms", "user");
  const row = startRow(ledger, "T1", undefined, ["task"]);
  row.retry = {
    windows: [
      { failures: [], timeLimitHours: 4 },
      { failures: [], timeLimitHours: 6, stop: { reason: "elapsed", at: 1 } },
    ],
  } as unknown as typeof row.retry;
  const expanded = result(
    "atlas_ledger",
    {
      content: [{ type: "text", text: "T1 is now in_progress." }],
      details: { id: row.id, status: row.status, row: ledgerCardRow(ledger, row), progress: ledgerProgress(ledger) },
    },
    true,
    { action: "start", id: "T1" },
  ).body;
  const acceptance = expanded.find((node) => node.key() === "acceptance");
  expect(shown(acceptance)).toContain("amended by R1");
  expect(shown(acceptance)).toContain("p95 latency stays under 250 ms");
  const facts = shown(expanded.find((node) => node.kind === "kv"));
  expect(facts).toContain("6h");
  expect(facts).toContain("window 2");
  expect(facts).toContain("stopped: time limit reached");
});

test("atlas_ledger amend shows the ruling, its row, the acceptance now in force and the user's note", () => {
  const ledger = createLedger("/plans/plan.md", planContent, ["task"]);
  const ruling = amendAcceptance(ledger, "T1", "p95 latency stays under 250 ms", "User accepted 250 ms after measuring 230 ms", "user");
  const row = ledgerRows(ledger).find((entry) => entry.id === "T1");
  if (!row) throw new Error("T1 missing");
  const amended = result(
    "atlas_ledger",
    {
      content: [{ type: "text", text: `${ruling.id} records the user-confirmed acceptance of T1.` }],
      details: { id: row.id, status: row.status, ruling, row: ledgerCardRow(ledger, row), progress: ledgerProgress(ledger) },
    },
    false,
    { action: "amend", id: "T1" },
  );
  expect(amended.target).toBe("amend T1");
  expect(amended.badges).toMatchObject([{ text: "R1", tone: "warning" }, { text: "open" }]);
  const section = amended.body.find((node) => node.key() === "ruling");
  expect(JSON.stringify(props(section))).toContain("amends T1 acceptance");
  expect(shown(section)).toContain("p95 latency stays under 250 ms");
  expect(shown(section)).toContain("User accepted 250 ms after measuring 230 ms");
});

test("atlas_ledger status lists every row; a deferred finding shows its triage state", () => {
  const ledger = createLedger("/plans/plan.md", planContent, ["task"]);
  const status = result("atlas_ledger", { content: [{ type: "text", text: "table" }], details: { ledger } }, false, { action: "status" });
  for (const row of ledgerRows(ledger)) expect(shown(status)).toContain(row.title);
  expect(status.body.some((node) => node.kind === "progress")).toBe(true);

  const finding = addDeferredFinding(ledger, { title: "Flaky upstream API", reason: "outside the plan" });
  const deferred = result(
    "atlas_ledger",
    {
      content: [{ type: "text", text: "Deferred" }],
      details: { id: finding.id, finding: { id: finding.id, title: finding.title }, progress: ledgerProgress(ledger) },
    },
    false,
    { action: "discover", scope: "out" },
  );
  expect(deferred.target).toBe("discover out");
  expect(shown(deferred)).toContain("Flaky upstream API");
  expect(shown(deferred)).toContain("needs triage");
});

test("atlas_ledger refusals and pauses read as errors; results without card details fall back to their text", () => {
  const paused = result(
    "atlas_ledger",
    { content: [{ type: "text", text: "Ledger operation refused: Atlas execution paused: proof missing." }], isError: true, details: {} },
    false,
    { action: "done", id: "T2" },
  );
  expect(paused.tone).toBe("error");
  expect(paused.target).toBe("done T2");
  expect(shown(paused)).toContain("proof missing");

  const legacy = result(
    "atlas_ledger",
    { content: [{ type: "text", text: "T2 is now done." }], details: { id: "T2", status: "done" } },
    false,
    {
      action: "done",
      id: "T2",
    },
  );
  expect(legacy.tone).not.toBe("error");
  expect(props(legacy.body.find((node) => node.kind === "md"))).toMatchObject({ text: "T2 is now done." });
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
    const commit = result(
      "atlas_git",
      { content: [{ type: "text", text: committed.text }], details: { action: "commit", commit: committed.commit } },
      false,
      args,
    );
    expect(commit.tone).toBe("success");
    expect(commit.target).toBe(`commit ${committed.commit?.sha.slice(0, 7)}`);
    expect(shown(commit)).toContain("feat: add a");
    expect(shown(commit)).toContain("a.txt");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
  const pending = call("atlas_git", { action: "commit", paths: ["a.txt", "b.txt"], message: "fix: b\n\nbody" });
  expect(pending).toMatchObject({ target: "commit", meta: "2 files" });
  const refused = result(
    "atlas_git",
    { content: [{ type: "text", text: "Commit refused: a bound child task is still running." }], isError: true, details: {} },
    false,
    { action: "commit", paths: ["a.txt"] },
  );
  expect(refused.tone).toBe("error");
  expect(shown(refused)).toContain("still running");
  const diff = result("atlas_git", { content: [{ type: "text", text: "+added" }], details: { action: "diff" } }, false, {
    action: "diff",
    revision: "HEAD~1",
  });
  expect(diff.target).toBe("diff HEAD~1");
  expect(props(diff.body.find((node) => node.kind === "code"))).toMatchObject({ text: "+added", lang: "diff" });
  // `--stat` aligns its columns with leading spaces; the first line keeps its own.
  const stat = " a.txt   | 1 +\n b/c.txt | 2 +-\n 2 files changed\n";
  const statCard = result("atlas_git", { content: [{ type: "text", text: stat }], details: { action: "diff" } }, false, {
    action: "diff",
    stat: true,
  });
  expect(props(statCard.body.find((node) => node.kind === "code"))).toMatchObject({ text: stat.trimEnd() });
});

test("atlas_release and prometheus_activate show their outcome", () => {
  expect(shown(call("atlas_release", { reason: "All rows verified" }))).toContain("All rows verified");
  const refused = result("atlas_release", {
    content: [{ type: "text", text: "Release refused: deferred findings still lack a triage (O1 x)." }],
    isError: true,
    details: { untriaged: ["O1"] },
  });
  expect(refused.tone).toBe("error");
  expect(refused.meta).toBe("1 untriaged");
  expect(result("atlas_release", { content: [{ type: "text", text: "Atlas exited by the user." }], details: {} }).tone).toBe("success");
  expect(call("prometheus_activate", {}).title).toBe("Prometheus Activate");
  expect(result("prometheus_activate", { content: [{ type: "text", text: "no consent" }], isError: true, details: {} }).tone).toBe("error");
});

test("a refused atlas_release names the reason and only the unfinished rows; the ledger it sent the model stays folded", () => {
  const ledger = createLedger("/plans/plan.md", planContent, ["task"]);
  const [first] = ledgerRows(ledger);
  if (!first) throw new Error("T1 missing");
  first.status = "done";
  const unfinished = ledgerRows(ledger).filter((row) => row.status !== "done");
  const text = `Release refused: unfinished ledger rows remain (${unfinished.map((row) => `${row.id} ${row.status}`).join(", ")}). Keep delegating.\n\n${renderLedgerSummary(ledger, ["task"])}`;
  const value = {
    content: [{ type: "text", text }],
    isError: true,
    details: { unfinished: unfinished.map(rowSummary), progress: ledgerProgress(ledger) },
  };
  const collapsed = result("atlas_release", value);
  expect(collapsed.tone).toBe("error");
  expect(collapsed.meta).toBe(`1/${ledgerRows(ledger).length} done`);
  const reason = collapsed.body.find((node) => node.key() === "reason");
  expect(shown(reason)).toContain("Release refused: unfinished ledger rows remain");
  expect(shown(reason)).not.toContain("Keep delegating");
  const listed = collapsed.body.filter((node) => node.kind === "item").map((node) => node.key());
  expect(listed).toEqual(unfinished.map((row) => row.id));
  expect(shown(collapsed)).not.toContain("Plan ledger:");

  const expanded = result("atlas_release", value, true).body;
  const raw = expanded.find((node) => node.key() === "model-text");
  expect(props(raw)).toMatchObject({ collapsible: true, collapsed: true });
  expect(shown(raw)).toContain("/plans/plan.md");
  expect(raw && nodes(raw).some((node) => node.kind === "table")).toBe(true);
});

test("displayed messages carry a product title instead of their customType", () => {
  for (const [customType, title, content] of [
    ["wows-omp-omo-prometheus.command-status", "Prometheus", "No approved plan to resume."],
    ["wows-omp-omo-prometheus.atlas-start", "Atlas", "Execute the approved plan North now."],
  ] as const) {
    const renderer = renderers.get(customType);
    expect(renderer).toBeFunction();
    const message = { role: "custom", customType, content, display: true, timestamp: 0 };
    const node = renderer?.(message, { expanded: false }, theme);
    if (!node) throw new Error("no message card");
    expect(JSON.stringify(props(node).head)).toContain(title);
    expect(shown(node)).not.toContain(customType);
    const lines = painted(node, 80);
    expect(lines).toContain(title);
    expect(lines).toContain(content);
    expect(lines).not.toContain(customType);
    expect(message.customType).toBe(customType);
  }
});
