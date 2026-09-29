import { beforeAll, expect, test } from "bun:test";

import { initTheme, type TUI, theme, visibleWidth } from "@oh-my-pi/pi-tui";

import type { AtlasPlanViewMode } from "../plugins/omo-prometheus/src/atlas-menu.ts";
import { AtlasMenu, type AtlasMenuAction, AtlasPlanView, type AtlasPlanViewAction } from "../plugins/omo-prometheus/src/atlas-menu.ts";
import type { AtlasPlanDetail } from "../plugins/omo-prometheus/src/atlas-store.ts";

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
