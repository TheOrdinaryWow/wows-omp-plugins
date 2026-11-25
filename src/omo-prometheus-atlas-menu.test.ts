import { afterEach, expect, test } from "bun:test";

import type { UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

import type { AtlasLive, AtlasLiveRow, AtlasLiveSnapshot, AtlasProgress } from "../plugins/omo-prometheus/src/atlas-live.ts";
import {
  AtlasMenu,
  type AtlasMenuAction,
  AtlasPlanView,
  type AtlasPlanViewAction,
  type AtlasPlanViewMode,
  atlasPlanText,
} from "../plugins/omo-prometheus/src/atlas-menu.ts";
import type { AtlasPlanDetail } from "../plugins/omo-prometheus/src/atlas-store.ts";
import { atlasStatusWidget } from "../plugins/omo-prometheus/src/atlas-widget.ts";

const theme = loadThemeSync("dark");
const terminals: TestTerminal[] = [];

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});

/** The view in a scripted terminal of `columns` × `rows`, focused as the host focuses a custom view. */
function mount(node: UiNode, columns = 100, rows = 30): TestTerminal {
  const term = createTestTerminal(() => ({ dock: node }), { columns, rows, theme });
  term.focus(node);
  terminals.push(term);
  return term;
}

const screen = (term: TestTerminal): string => term.screen().join("\n");

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
const south: AtlasPlanDetail = { ...plan, plan: { ...plan.plan, id: "south--00000000-0000-0000-0000-000000000002", name: "South" } };

function menu(details = [plan]): { term: TestTerminal; actions: AtlasMenuAction[] } {
  const actions: AtlasMenuAction[] = [];
  const term = mount(new AtlasMenu(details, "unfinished", "", (action) => actions.push(action)).view());
  return { term, actions };
}

function view(
  detail = plan,
  mode: AtlasPlanViewMode = "dispatch",
  options: { rows?: number; columns?: number; live?: AtlasLive } = {},
): { term: TestTerminal; actions: AtlasPlanViewAction[]; reads: string[]; component: AtlasPlanView } {
  const actions: AtlasPlanViewAction[] = [];
  const reads: string[] = [];
  const columns = options.columns ?? 100;
  const rows = options.rows ?? 30;
  const component = new AtlasPlanView(
    detail,
    mode,
    async (file) => {
      reads.push(file);
      return "child says the build is green";
    },
    (action) => actions.push(action),
    options.live,
    () => ({ columns, rows }),
  );
  return { term: mount(component.view(), columns, rows), actions, reads, component };
}

test("Atlas Dispatch lists the plans with their status and the highlighted plan's rows", () => {
  const { term } = menu([plan, south]);
  const shown = screen(term);
  expect(shown).toMatch(/Atlas Dispatch/);
  expect(shown).toMatch(/❯ North +1\/2 +In progress/);
  expect(shown).toMatch(/ South +1\/2/);
  expect(shown).toMatch(/T1 Build/);
  expect(shown).toMatch(/⏎ start · ␣ details · ⇧R resume · ⇧N rename · ⌦ delete · ⇥ filter · ⎋ close/);
  term.press("down");
  expect(screen(term)).toMatch(/❯ South/);
  term.type("zz");
  expect(screen(term)).toMatch(/No plans match the search/);
});

test("Atlas Dispatch Backspace searches then deletes only with an empty query", () => {
  const { term, actions } = menu();
  term.type("n");
  term.press("backspace");
  expect(actions).toEqual([]);
  term.press("backspace");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id, query: "" }]);
});

test("Atlas Dispatch Delete removes the highlighted plan even while searching", () => {
  const { term, actions } = menu();
  term.type("n");
  term.press("delete");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id, query: "n" }]);
});

test("Atlas Dispatch uppercase shortcuts act while lowercase letters search", () => {
  const { term, actions } = menu();
  term.type("nri");
  expect(actions).toEqual([]);
  expect(screen(term)).toMatch(/> nri/);
  term.press("backspace");
  term.press("backspace");
  term.type("NRI");
  expect(actions.map((action) => action.kind)).toEqual(["rename", "resume", "inspect"]);
});

test("Atlas Dispatch Enter starts, Space inspects, and Tab makes All display-only", () => {
  const first = menu();
  first.term.press("enter");
  first.term.press("space");
  expect(first.actions.map((action) => [action.kind, action.planId])).toEqual([
    ["start", plan.plan.id],
    ["inspect", plan.plan.id],
  ]);
  const second = menu();
  second.term.press("tab");
  second.term.press("enter");
  second.term.type("R");
  expect(second.actions).toEqual([]);
  expect(screen(second.term)).toMatch(/display-only/);
  second.term.press("space");
  second.term.press("escape");
  expect(second.actions.map((action) => action.kind)).toEqual(["inspect", "cancel"]);
  expect(second.actions.at(-1)).toMatchObject({ filter: "all" });
});

test("Atlas Dispatch refuses resuming an unstarted plan but still starts it", () => {
  const { term, actions } = menu([fresh]);
  term.type("R");
  expect(actions).toEqual([]);
  expect(screen(term)).toMatch(/not started yet/);
  term.press("enter");
  expect(actions).toMatchObject([{ kind: "start" }]);
});

test("Atlas Dispatch refuses starting or resuming a plan held by another session", () => {
  const { term, actions } = menu([busy]);
  term.press("enter");
  term.type("R");
  expect(actions).toEqual([]);
  expect(screen(term)).toMatch(/in use by another session/);
  term.press("delete");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id }]);
});

test("Atlas Dispatch reads at 80 and 120 columns without cutting the plan name or the hints", () => {
  for (const columns of [80, 120]) {
    const term = createTestTerminal(() => ({ dock: new AtlasMenu([plan, south], "unfinished", "", () => {}).view() }), {
      columns,
      rows: 40,
      theme,
    });
    terminals.push(term);
    const lines = term.screen();
    expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
    expect(lines.join("\n")).toMatch(/⎋ close/);
    expect(lines.join("\n")).toMatch(/North/);
  }
});

test("Atlas plan view shows the row and expands the archived child output on demand", async () => {
  const { term, reads } = view();
  expect(screen(term)).toMatch(/Atlas Dispatch · North/);
  expect(screen(term)).toMatch(/The build passes/);
  expect(screen(term)).toMatch(/build is green/);
  expect(screen(term)).not.toMatch(/child says/);
  term.press("space");
  await Promise.resolve();
  term.render();
  expect(reads).toEqual(["/bundle/evidence/r1.md"]);
  expect(screen(term)).toMatch(/child says the build is green/);
  term.press("down");
  expect(screen(term)).toMatch(/Approved/);
  term.press("space");
  expect(reads).toHaveLength(1);
  expect(screen(term)).toMatch(/no archived child output/);
});

const amended: AtlasPlanDetail = {
  ...plan,
  rulings: [
    { id: "R1", rowId: "T1", acceptance: "The build passes in 90 s", note: "First limit", confirmedAt: 0, decidedBy: "user" },
    { id: "R2", rowId: "T1", acceptance: "The build passes in 120 s", note: "User accepted 120 s", confirmedAt: 0, decidedBy: "user" },
  ],
};

test("Atlas plan view shows a row's ruling in force, the approved text below it, and every ruling in the header", () => {
  const shown = screen(view(amended, "dispatch", { rows: 60, columns: 120 }).term);
  expect(shown).toMatch(/Owner rulings 2 {2}R1 T1 · R2 T1/);
  expect(shown).toMatch(/Acceptance {2}amended by R2/);
  expect(shown).toContain("The build passes in 120 s");
  expect(shown).toContain("User accepted 120 s");
  expect(shown).not.toContain("The build passes in 90 s");
  expect(shown).toMatch(/Approved plan\n.*The build passes/);

  const plain = atlasPlanText(amended);
  expect(plain).toContain("    Acceptance: The build passes in 120 s (amended by R2)\n    Approved: The build passes");
  expect(plain).toMatch(/Owner rulings .*: 2\n- R1 T1: The build passes in 90 s — First limit/);
  expect(atlasPlanText(plan)).not.toMatch(/Owner rulings|Approved:/);
});

test("Atlas plan view dispatches like the list and Esc returns", () => {
  const started = view();
  started.term.type("R");
  started.term.press("enter");
  started.term.press("escape");
  expect(started.actions).toEqual(["resume", "start", "back"]);

  const unstarted = view(fresh);
  unstarted.term.type("R");
  expect(unstarted.actions).toEqual([]);
  expect(screen(unstarted.term)).toMatch(/not started yet/);

  const readOnly = view(plan, "display");
  readOnly.term.press("enter");
  readOnly.term.type("R");
  expect(readOnly.actions).toEqual([]);
});

test("Atlas plan view for the running plan only reads and exits", () => {
  const active = view(plan, "active");
  const shown = screen(active.term);
  expect(shown).toMatch(/Active in this session/);
  expect(shown).not.toMatch(/\bStart\b|Resume/);
  expect(shown).toMatch(/Exit Atlas/);
  active.term.press("enter");
  active.term.type("RN");
  expect(active.actions).toEqual([]);
  active.term.type("X");
  active.term.press("escape");
  expect(active.actions).toEqual(["exit", "back"]);
});

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

test("Atlas plan view keeps separate row-body and timeline scroll positions across Tab", () => {
  const { term } = view(long);
  expect(screen(term)).toMatch(/T1 {2}Build/);
  expect(screen(term)).toMatch(/more lines; PgDn to scroll/);
  term.press("pageDown");
  expect(screen(term)).not.toMatch(/T1 {2}Build/);
  expect(screen(term)).toMatch(/criterion/);
  term.press("tab");
  expect(screen(term)).toMatch(/started {2}T39\b/);
  term.press("pageDown");
  expect(screen(term)).not.toMatch(/started {2}T39\b/);
  term.press("tab");
  expect(screen(term)).not.toMatch(/T1 {2}Build/);
  term.press("tab");
  expect(screen(term)).not.toMatch(/started {2}T39\b/);
  term.press("home");
  expect(screen(term)).toMatch(/started {2}T39\b/);
  term.press("end");
  expect(screen(term)).toMatch(/started {2}T0\b/);
});

test("Atlas plan view pages by painted rows, so the last line of a long body and of one long paragraph is reachable", () => {
  const pageUntil = (term: TestTerminal, pattern: RegExp): number => {
    for (let pages = 0; pages < 40; pages++) {
      if (pattern.test(screen(term))) return pages;
      term.press("pageDown");
    }
    return -1;
  };
  const lines = view(long);
  expect(screen(lines.term)).not.toMatch(/criterion 59/);
  expect(pageUntil(lines.term, /criterion 59/)).toBeGreaterThan(1);
  expect(screen(lines.term)).not.toMatch(/more lines; PgDn/);
  // Paging back up puts the rest of the body below the view again.
  lines.term.press("pageUp");
  expect(screen(lines.term)).toMatch(/more lines; PgDn/);

  const words = Array.from({ length: 600 }, (_, index) => `word${index}`).join(" ");
  const paragraph: AtlasPlanDetail = {
    ...plan,
    rows: plan.rows.map((row) => (row.id === "T1" ? { ...row, acceptance: `${words} THE-END` } : row)),
  };
  const single = view(paragraph);
  expect(screen(single.term)).not.toMatch(/THE-END/);
  expect(pageUntil(single.term, /THE-END/)).toBeGreaterThan(1);
  for (let index = 0; index < 600; index += 37) {
    const pages = view(paragraph);
    expect(pageUntil(pages.term, new RegExp(`\\bword${index}\\b`))).toBeGreaterThanOrEqual(0);
  }
});

test("Atlas plan view moves the sidebar selection with the arrows and keeps the selected row in view", () => {
  const many: AtlasPlanDetail = {
    ...plan,
    rows: Array.from({ length: 40 }, (_, index) => ({
      ...(plan.rows[1] as AtlasPlanDetail["rows"][number]),
      id: `T${index + 1}`,
      title: `Work ${index + 1}`,
    })),
  };
  const { term } = view(many);
  for (let step = 0; step < 30; step++) term.press("down");
  const shown = screen(term);
  expect(shown).toMatch(/❯ T31 Work 31/);
  expect(shown).toMatch(/T31 {2}Work 31/);
  expect(shown).not.toMatch(/ T1 Work 1\b/);
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
  const shown = screen(view(running, "active", { rows: 60, columns: 120, live }).term);
  expect(shown).toMatch(/bash \d/);
  expect(shown).toMatch(/bun test --watch/);
  expect(shown).toMatch(/newest x/);
  expect(shown).not.toMatch(/oldest x/);
  expect(shown).toMatch(/5 tools · 3 requests · 12K tokens/);
  expect(shown.indexOf("earlier line")).toBeLessThan(shown.indexOf("final line"));
});

test("Atlas widget lists rows still waiting for a child and stays within six lines and the width", () => {
  const two = { ...running, rows: running.rows.slice(0, 2) };
  const live = observed(two, new Map([["T1", { attempt: "attempt-1", childAgentId: "child-1", status: "running", progress }]]));
  for (const columns of [40, 80, 120]) {
    const term = createTestTerminal(() => ({ dock: atlasStatusWidget(live) }), { columns, rows: 20, theme });
    terminals.push(term);
    const lines = term.screen().filter(Boolean);
    expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
    expect(lines.some((line) => /\bT2\b/.test(line))).toBe(true);
    expect(lines[0]).toMatch(/0\/7 · 1 running/);
  }
  const crowded = createTestTerminal(() => ({ dock: atlasStatusWidget(observed(running, new Map())) }), { columns: 80, rows: 20, theme });
  terminals.push(crowded);
  const lines = crowded.screen().filter(Boolean);
  expect(lines).toHaveLength(6);
  expect(lines[5]).toMatch(/\+3 more/);
});
