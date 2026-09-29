import { expect, test } from "bun:test";

import type { Theme, TUI } from "@oh-my-pi/pi-tui";

import { AtlasMenu, type AtlasMenuAction } from "../plugins/omo-prometheus/src/atlas-menu.ts";
import type { AtlasPlanDetail } from "../plugins/omo-prometheus/src/atlas-store.ts";

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
  status: "In progress 1/2 (1/2)",
  done: 1,
  total: 2,
  rows: [
    { id: "T1", title: "Build", status: "done" },
    { id: "F1", title: "Review", status: "open" },
  ],
  unfinished: true,
  enterable: true,
};

function menu(): { component: AtlasMenu; actions: AtlasMenuAction[] } {
  const actions: AtlasMenuAction[] = [];
  const theme = { fg: (_color: string, value: string) => value } as Theme;
  const tui = { requestRender() {} } as TUI;
  return { component: new AtlasMenu([plan], "unfinished", "", theme, tui, (action) => actions.push(action)), actions };
}

test("Atlas menu Backspace searches then deletes only with an empty query", () => {
  const { component, actions } = menu();
  component.handleInput("n");
  component.handleInput("\x7f");
  expect(actions).toEqual([]);
  component.handleInput("\x7f");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id, query: "" }]);
});

test("Atlas menu Delete removes the highlighted plan even while searching", () => {
  const { component, actions } = menu();
  component.handleInput("n");
  component.handleInput("\x1b[3~");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id, query: "n" }]);
});

test("Atlas menu Shift+N renames while lowercase n searches", () => {
  const { component, actions } = menu();
  component.handleInput("n");
  expect(actions).toEqual([]);
  component.handleInput("N");
  expect(actions).toMatchObject([{ kind: "rename", planId: plan.plan.id, query: "n" }]);
});

test("Atlas menu Space enters, Tab switches to display-only All, and Esc cancels", () => {
  const first = menu();
  first.component.handleInput(" ");
  expect(first.actions).toMatchObject([{ kind: "enter", planId: plan.plan.id }]);
  const second = menu();
  second.component.handleInput("\t");
  second.component.handleInput("\r");
  second.component.handleInput(" ");
  expect(second.actions).toEqual([]);
  expect(second.component.render(100).join("\n")).toContain("T1 Build");
  second.component.handleInput("\x1b");
  expect(second.actions).toMatchObject([{ kind: "cancel", filter: "all" }]);
});

test("Atlas menu refuses entering a plan that is not enterable instead of pausing the session", () => {
  const actions: AtlasMenuAction[] = [];
  const theme = { fg: (_color: string, value: string) => value } as Theme;
  const tui = { requestRender() {} } as TUI;
  const component = new AtlasMenu(
    [{ ...plan, status: "In use by another session", enterable: false }],
    "unfinished",
    "",
    theme,
    tui,
    (action) => actions.push(action),
  );
  component.handleInput(" ");
  component.handleInput("\r");
  expect(actions).toEqual([]);
  component.handleInput("\x1b[3~");
  expect(actions).toMatchObject([{ kind: "delete", planId: plan.plan.id }]);
});
