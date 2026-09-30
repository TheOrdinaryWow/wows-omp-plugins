import { beforeAll, expect, test } from "bun:test";

import { initTheme, type TUI, theme, visibleWidth } from "@oh-my-pi/pi-tui";

import type { AtlasLive, AtlasLiveRow, AtlasLiveSnapshot, AtlasProgress } from "../plugins/omo-prometheus/src/atlas-live.ts";
import type { AtlasPlanViewMode } from "../plugins/omo-prometheus/src/atlas-menu.ts";
import { AtlasMenu, type AtlasMenuAction, AtlasPlanView, type AtlasPlanViewAction } from "../plugins/omo-prometheus/src/atlas-menu.ts";
import type { AtlasPlanDetail } from "../plugins/omo-prometheus/src/atlas-store.ts";
import { AtlasStatusWidget } from "../plugins/omo-prometheus/src/atlas-widget.ts";

beforeAll(async () => {
  await initTheme();
});

const plan: AtlasPlanDetail = {
  plan: {
    id: "north--00000000-0000-0000-0000-000000000001",
    name: "North",
    originalName: "North",
    cwd: "/workspace",
    directory: "/bundle",
    planFilePath: "/bundle/plan.md",
    ledgerPath: "/bundle/ledger.json",
    planSha256: "a".repeat(64),
    sourcePlanPath: "local://PLAN.md",
    sourceSessionId: "session-a",
    proposedByToolCallId: "call-a",
  },
  status: "In progress 1/2",
  done: 1,
  total: 2,
  timeline: [],
  rows: [
    {
      id: "T1",
      title: "Build",
      status: "done",
      agent: "task",
      acceptance: "The build passes",
      dependsOn: [],
      evidence: "/bundle/evidence/r1.md: build is green",
      updatedAt: 0,
      receipt: { receiptId: "r1", childAgentId: "child-1", sessionId: "session-a", capturedAt: 0 },
      outputPath: "/bundle/evidence/r1.md",
    },
    { id: "F1", title: "Review", status: "open", agent: "reviewer", acceptance: "Approved", dependsOn: ["T1"], updatedAt: 0 },
  ],
  unfinished: true,
  enterable: true,
  started: true,
  inUse: false,
};
const fresh: AtlasPlanDetail = { ...plan, status: "Not started (0/2)", done: 0, started: false };
const busy: AtlasPlanDetail = { ...plan, status: "In use by another session (1/2)", enterable: false, inUse: true };

const tui = { requestRender() {}, terminal: { rows: 30 } } as unknown as TUI;

function menu(detail = plan): { component: AtlasMenu; actions: AtlasMenuAction[] } {
  const actions: AtlasMenuAction[] = [];
  return { component: new AtlasMenu([detail], "unfinished", "", theme, tui, (action) => actions.push(action)), actions };
}

function view(
  detail = plan,
  mode: AtlasPlanViewMode = "dispatch",
): { component: AtlasPlanView; actions: AtlasPlanViewAction[]; reads: string[] } {
  const actions: AtlasPlanViewAction[] = [];
  const reads: string[] = [];
  const component = new AtlasPlanView(
    detail,
    mode,
    theme,
    tui,
    async (file) => {
      reads.push(file);
      return "child says the build is green";
    },
    (action) => actions.push(action),
  );
  return { component, actions, reads };
}

const text = (lines: readonly string[]): string => Bun.stripANSI(lines.join("\n"));

test("Atlas Dispatch Backspace searches then deletes only with an empty query", () => {
  const { component, actions } = menu();
  component.handleInput("n");
  component.handleInput("\x7f");
  expect(actions).toEqual([]);
  component.handleInput("\x7f");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id, query: "" }]);
});

test("Atlas Dispatch Delete removes the highlighted plan even while searching", () => {
  const { component, actions } = menu();
  component.handleInput("n");
  component.handleInput("\x1b[3~");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id, query: "n" }]);
});

test("Atlas Dispatch uppercase shortcuts act while lowercase letters search", () => {
  const { component, actions } = menu();
  component.handleInput("n");
  component.handleInput("r");
  component.handleInput("i");
  expect(actions).toEqual([]);
  component.handleInput("\x7f");
  component.handleInput("\x7f");
  component.handleInput("N");
  component.handleInput("R");
  component.handleInput("I");
  expect(actions.map((action) => action.kind)).toEqual(["rename", "resume", "inspect"]);
});

test("Atlas Dispatch Enter starts, Space inspects, and Tab makes All display-only", () => {
  const first = menu();
  first.component.handleInput("\r");
  first.component.handleInput(" ");
  expect(first.actions.map((action) => [action.kind, action.planId])).toEqual([
    ["start", plan.plan.id],
    ["inspect", plan.plan.id],
  ]);
  const second = menu();
  second.component.handleInput("\t");
  second.component.handleInput("\r");
  second.component.handleInput("R");
  expect(second.actions).toEqual([]);
  expect(text(second.component.render(100))).toMatch(/display-only/);
  second.component.handleInput(" ");
  second.component.handleInput("\x1b");
  expect(second.actions.map((action) => action.kind)).toEqual(["inspect", "cancel"]);
  expect(second.actions.at(-1)).toMatchObject({ filter: "all" });
});

test("Atlas Dispatch refuses resuming an unstarted plan but still starts it", () => {
  const { component, actions } = menu(fresh);
  component.handleInput("R");
  expect(actions).toEqual([]);
  expect(text(component.render(100))).toMatch(/not started yet/);
  component.handleInput("\r");
  expect(actions).toMatchObject([{ kind: "start" }]);
});

test("Atlas Dispatch refuses starting or resuming a plan held by another session", () => {
  const { component, actions } = menu(busy);
  component.handleInput("\r");
  component.handleInput("R");
  expect(actions).toEqual([]);
  expect(text(component.render(100))).toMatch(/in use by another session/);
  component.handleInput("\x1b[3~");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id }]);
});

test("Atlas plan view fills the terminal and expands the archived child output on demand", async () => {
  const { component, reads } = view();
  const lines = component.render(100);
  expect(lines).toHaveLength(30);
  expect(lines.every((line) => visibleWidth(line) === 100)).toBe(true);
  expect(text(lines)).toMatch(/The build passes/);
  expect(text(lines)).toMatch(/build is green/);
  expect(text(lines)).not.toMatch(/child says/);
  component.handleInput(" ");
  await Promise.resolve();
  expect(reads).toEqual(["/bundle/evidence/r1.md"]);
  expect(text(component.render(100))).toMatch(/child says the build is green/);
  component.handleInput("\x1b[B");
  expect(text(component.render(100))).toMatch(/Approved/);
  component.handleInput(" ");
  expect(reads).toHaveLength(1);
  expect(text(component.render(100))).toMatch(/no archived child output/);
});

test("Atlas plan view dispatches like the list and Esc returns", () => {
  const started = view();
  started.component.handleInput("R");
  started.component.handleInput("\r");
  started.component.handleInput("\x1b");
  expect(started.actions).toEqual(["resume", "start", "back"]);

  const unstarted = view(fresh);
  unstarted.component.handleInput("R");
  expect(unstarted.actions).toEqual([]);
  expect(text(unstarted.component.render(100))).toMatch(/not started yet/);

  const readOnly = view(plan, "display");
  readOnly.component.handleInput("\r");
  readOnly.component.handleInput("R");
  expect(readOnly.actions).toEqual([]);
});

test("Atlas plan view for the running plan only reads and exits", () => {
  const active = view(plan, "active");
  const screen = text(active.component.render(100));
  expect(screen).toMatch(/Active in this session/);
  expect(screen).not.toMatch(/\bstart\b|resume/);
  active.component.handleInput("\r");
  active.component.handleInput("R");
  active.component.handleInput("N");
  expect(active.actions).toEqual([]);
  active.component.handleInput("X");
  active.component.handleInput("\x1b");
  expect(active.actions).toEqual(["exit", "back"]);
});

test("Atlas plan view keeps separate row-body and timeline scroll positions across Tab", () => {
  const long: AtlasPlanDetail = {
    ...plan,
    rows: plan.rows.map((row) =>
      row.id === "T1" ? { ...row, acceptance: Array.from({ length: 60 }, (_, index) => `- criterion ${index}`).join("\n") } : row,
    ),
    timeline: Array.from({ length: 40 }, (_, index) => ({
      version: 1 as const,
      at: index * 60_000,
      kind: "started" as const,
      row: `T${index}`,
      sessionId: "session-a",
    })),
  };
  const { component } = view(long);
  const screen = (): string => text(component.render(100));
  component.handleInput("\x1b[6~");
  expect(screen()).not.toMatch(/T1 {2}Build/);
  component.handleInput("\t");
  expect(screen()).toMatch(/started {2}T39\b/);
  component.handleInput("\x1b[6~");
  expect(screen()).not.toMatch(/started {2}T39\b/);
  component.handleInput("\t");
  expect(screen()).not.toMatch(/T1 {2}Build/);
  component.handleInput("\t");
  expect(screen()).not.toMatch(/started {2}T39\b/);
});

const running: AtlasPlanDetail = {
  ...plan,
  done: 0,
  total: 7,
  rows: Array.from({ length: 7 }, (_, index) => ({
    id: `T${index + 1}`,
    title: `Work ${index + 1}`,
    status: "in_progress" as const,
    agent: "task",
    acceptance: "Done",
    dependsOn: [],
    updatedAt: 0,
    attempt: `attempt-${index + 1}`,
    startedAt: 0,
  })),
};

const progress = {
  status: "running",
  currentTool: "bash",
  currentToolArgs: "bun test\n--watch",
  currentToolStartMs: 50_000,
  lastIntent: "Running tests",
  recentTools: ["newest", "second", "third", "fourth", "oldest"].map((tool) => ({ tool, args: "x", endMs: 0 })),
  recentOutput: ["final line", "earlier line"],
  toolCount: 5,
  requests: 3,
  tokens: 12_345,
  cost: 0.5,
} as unknown as AtlasProgress;

function observed(detail: AtlasPlanDetail, rows: Map<string, AtlasLiveRow>): AtlasLive {
  const snapshot: AtlasLiveSnapshot = { detail, rows, at: 60_000, runningChildren: rows.size };
  return {
    snapshot,
    subscribe: (listener: (next: AtlasLiveSnapshot) => void) => {
      listener(snapshot);
      return () => undefined;
    },
  } as unknown as AtlasLive;
}

test("Atlas plan view shows the newest recent tools and the output tail in reading order", () => {
  const live = observed(running, new Map([["T1", { attempt: "attempt-1", childAgentId: "child-1", status: "running", progress }]]));
  const component = new AtlasPlanView(
    running,
    "active",
    theme,
    { requestRender() {}, terminal: { rows: 60 } } as unknown as TUI,
    async () => "",
    () => undefined,
    live,
  );
  const screen = text(component.render(120));
  expect(screen).toMatch(/newest x/);
  expect(screen).not.toMatch(/oldest x/);
  expect(screen.indexOf("earlier line")).toBeLessThan(screen.indexOf("final line"));
});

test("Atlas widget lists rows still waiting for a child and stays within six lines and the width", () => {
  const two = { ...running, rows: running.rows.slice(0, 2) };
  const live = observed(two, new Map([["T1", { attempt: "attempt-1", childAgentId: "child-1", status: "running", progress }]]));
  const widget = new AtlasStatusWidget(live, tui, theme);
  for (const width of [40, 60, 100]) {
    const lines = widget.render(width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.some((line) => /\bT2\b/.test(Bun.stripANSI(line)))).toBe(true);
  }
  const crowded = new AtlasStatusWidget(observed(running, new Map()), tui, theme).render(80);
  expect(crowded).toHaveLength(6);
  expect(Bun.stripANSI(crowded[5] ?? "")).toMatch(/\+3 more/);
});
