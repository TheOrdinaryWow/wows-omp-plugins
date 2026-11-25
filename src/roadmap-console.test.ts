import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "@oh-my-pi/pi-coding-agent/ui/styles/overlays/bare-sheet";
import { type KeyEvent, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

import type { AtlasStagePlan } from "../plugins/roadmap/src/atlas.ts";
import { type ConsoleChoice, type ConsoleState, type PreviewRequest, PreviewView, RoadmapConsole } from "../plugins/roadmap/src/console.ts";
import { type Model, renderRound, renderStage } from "../plugins/roadmap/src/documents.ts";
import {
  PACKAGE_NAME,
  parseUiMenu,
  type StageOrder,
  StageOrderPreference,
  type UiMenu,
  uiMenuReader,
} from "../plugins/roadmap/src/settings.ts";
import { h } from "../plugins/roadmap/src/tsp.ts";
import { createTuiUi, HeadlessUi, type RoadmapUiContext } from "../plugins/roadmap/src/ui.ts";
import { consoleModelFixture, planFixture } from "./roadmap-fixtures.ts";

const theme = loadThemeSync("dark");
const ON = "2026-10-11";

/** Atlas answers: two plans for S05 (one drifted), none yet for S06; other stages get no answer, as without omo-prometheus. */
const PLANS: Readonly<Record<string, AtlasStagePlan[]>> = {
  S05: [
    planFixture({ planId: "plan-a", name: "Card payments", stage: "S05", criteria: ["DC1"], status: "complete", done: 6, total: 6 }),
    planFixture({
      planId: "plan-b",
      name: "Webhook hardening",
      stage: "S05",
      criteria: ["DC2"],
      done: 2,
      total: 5,
      revision: "0".repeat(64),
    }),
  ],
  S06: [],
};

const terminals: TestTerminal[] = [];
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});

/** A view mounted fullscreen as the host mounts `ctx.ui.custom` overlays in the terminal, keys going to it. */
function terminal(
  make: () => { view(host: { size(): { columns: number; rows: number } }, native: boolean): UiNode },
  columns: number,
  rows: number,
) {
  const size = signal({ columns, rows });
  let view: UiNode | undefined;
  const term = createTestTerminal(
    () => {
      view = make().view({ size }, false);
      return { layer: h("overlay", { key: "extension", size: "full", role: "omp.sheet.bare" }, view) };
    },
    { columns, rows, theme },
  );
  terminals.push(term);
  term.focus(view ?? null);
  // Hints keep each key beside its label with no-break spaces.
  const shown = () => term.screen().map((line) => line.replace(/\u00a0/g, " "));
  return {
    term,
    screen: () => shown().join("\n"),
    lines: shown,
    press: (...ids: string[]) => {
      for (const id of ids) term.press(id);
    },
    type: (text: string) => term.type(text),
    resize: (nextColumns: number, nextRows: number) => {
      size.set({ columns: nextColumns, rows: nextRows });
      term.resize(nextColumns, nextRows);
    },
  };
}

function mount(model: Model = consoleModelFixture(), state: ConsoleState = {}, columns = 100, rows = 24) {
  const choices: Array<ConsoleChoice | undefined> = [];
  const asked: string[] = [];
  const orders: StageOrder[] = [];
  const mounted = terminal(
    () =>
      new RoadmapConsole(
        model,
        { on: ON, ...state },
        theme,
        (choice) => choices.push(choice),
        (stage) => {
          asked.push(stage);
          return PLANS[stage];
        },
        (order) => orders.push(order),
      ),
    columns,
    rows,
  );
  return { ...mounted, choices, asked, orders };
}

/** The row the sidebar marks as selected. */
const selectedRow = (screen: string): string => screen.split("\n").find((line) => line.startsWith("❯")) ?? "";

const EMPTY: Model = { index: { format: 2, path: "", title: "Fresh", body: "" }, rounds: [], stages: [], todos: [] };

/** R2 with S06 waiting on the later-numbered S07, so dependency order lists S07 before S06. */
function laterDependencyModel(): Model {
  const model = consoleModelFixture();
  return { ...model, stages: model.stages.map((stage) => (stage.id === "S06" ? { ...stage, depends_on: ["S07"] } : stage)) };
}

const stageIds = (rows: readonly string[]): string[] => rows.flatMap((row) => /\b(S0\d) /.exec(row)?.[1] ?? []);

/** The stage ids listed in the sidebar, top to bottom. */
const sidebarIds = (lines: readonly string[], width: number): string[] =>
  stageIds(lines.slice(5).map((line) => line.slice(0, Math.floor(width * 0.36))));

test("console fills 80x24 and 160x48 with the hints on the last rows in every section and item, long titles included", () => {
  for (const [width, rows] of [
    [80, 24],
    [160, 48],
  ] as const) {
    for (const model of [consoleModelFixture(), EMPTY]) {
      const { term, lines, press } = mount(model, {}, width, rows);
      for (let section = 0; section < 3; section++) {
        for (let item = 0; item < 6; item++) {
          const shown = lines();
          expect(shown).toHaveLength(rows);
          expect(shown[0]).toMatch(/^Roadmap · /);
          expect(shown.slice(-2).join(" ")).toMatch(/Esc close/);
          expect(term.rows().filter((line) => visibleWidth(stripEscapes(line)) > width)).toEqual([]);
          press("down", "pageDown");
        }
        press("tab");
      }
    }
  }
});

test("console rows never exceed narrow widths", () => {
  for (const width of [30, 40, 60]) {
    const { term, press } = mount(undefined, {}, width, 12);
    for (let section = 0; section < 3; section++) {
      expect(term.rows().filter((line) => visibleWidth(stripEscapes(line)) > width)).toEqual([]);
      press("tab");
    }
  }
});

test("console opens on the active round's stages with the active stage selected and its detail", () => {
  const { screen } = mount(undefined, {}, 160, 48);
  const shown = screen();
  expect(shown).toMatch(/Roadmap · Shop platform/);
  expect(shown).toMatch(/R2 Checkout and payments · 2\/5 stages settled · 4 open TODOs/);
  expect(shown).toMatch(/1 overdue stage · 2 planned rounds/);
  expect(selectedRow(shown)).toMatch(/S05 Payment provider/);
  expect(selectedRow(shown)).toContain(theme.symbols.symbol("status.warning"));
  expect(shown).toMatch(/S05 — Payment provider integration/);
  expect(shown).toMatch(/Target +2026-10-05 · overdue/);
  expect(shown).toMatch(/ADR-0004 Retry webhooks with exponential backoff · proposed/);
  expect(shown).toMatch(/T010 Handle a provider timeout/);
  // The resolved T013 targets S05 too but is not open.
  expect(shown).not.toMatch(/T013/);
  expect(shown).toMatch(/⇧X close stage/);
});

test("console navigation moves within a section and Tab cycles sections, remembering each selection", () => {
  const { screen, press } = mount();
  press("down");
  expect(screen()).toMatch(/S06 — Order confirmation emails/);
  expect(screen()).toMatch(/blocked by S05/);
  press("down");
  expect(screen()).toMatch(/S07 — Checkout analytics/);
  expect(screen()).toMatch(/ready to start/);
  press("home");
  expect(screen()).toMatch(/S04 — Cart persistence/);
  press("end");
  expect(screen()).toMatch(/S08 — Legacy coupon import/);
  press("end", "down");
  expect(screen()).toMatch(/S08 — Legacy coupon import/);

  press("tab");
  expect(screen()).toMatch(/R2 — Checkout and payments/);
  press("down");
  expect(screen()).toMatch(/R3 — Refunds and disputes/);
  expect(screen()).toMatch(/next to activate/);
  press("tab");
  expect(screen()).toMatch(/T010 — Handle a provider timeout/);
  press("tab");
  expect(screen()).toMatch(/S08 — Legacy coupon import/);
  press("shift+tab");
  expect(screen()).toMatch(/T010 — /);
  press("shift+tab");
  expect(screen()).toMatch(/R3 — Refunds and disputes/);
});

test("console typing searches the section; Esc clears the search first and then closes", () => {
  const { screen, lines, press, type, choices } = mount();
  type("s07");
  expect(screen()).toMatch(/Search: s07 {2}1\/5 match/);
  expect(sidebarIds(lines(), 100)).toEqual(["S07"]);
  expect(screen()).toMatch(/S07 — Checkout analytics/);
  type("x");
  expect(screen()).toMatch(/Nothing matches the search/);
  press("backspace");
  expect(screen()).toMatch(/S07 — Checkout analytics/);
  expect(screen()).toMatch(/Esc clear search/);
  press("escape");
  expect(choices).toEqual([]);
  expect(screen()).toMatch(/Type to search/);
  // The cleared search keeps the item it had found.
  expect(screen()).toMatch(/S07 — Checkout analytics/);
  press("escape");
  expect(choices).toEqual([undefined]);
  press("escape", "enter");
  expect(choices).toEqual([undefined]);
});

test("console Enter navigates without answering: a stage to its round, a round to its stages", () => {
  const { screen, press, type, choices } = mount();
  press("enter");
  expect(screen()).toMatch(/R2 — Checkout and payments/);
  press("down", "enter");
  // Stages now lists R3 and says so; its planned stage is selected.
  expect(screen()).toMatch(/Stages R3 1/);
  expect(screen()).toMatch(/S09 — Refund API/);
  press("enter");
  expect(screen()).toMatch(/R3 — Refunds and disputes/);
  press("up", "up", "enter");
  expect(screen()).toMatch(/Stages R1 2/);
  expect(screen()).toMatch(/S01 — Product catalog/);
  press("tab", "down", "enter");
  expect(screen()).toMatch(/ Stages 5 /);
  expect(choices).toEqual([]);
  // The stage list travels with the view, so a reopened console shows the same round's stages.
  press("tab", "down", "enter");
  type("C");
  expect(choices).toEqual([{ action: "check", view: { section: "stages", query: "", selected: "S09", stageRound: "R3" } }]);
  const reopened = mount(undefined, { view: { section: "stages", query: "", selected: "S09", stageRound: "R3" } });
  expect(reopened.screen()).toMatch(/S09 — Refund API/);
});

test("console Enter on a TODO goes to its target in that round's stages, or explains a trigger", () => {
  const { screen, press, choices } = mount();
  press("tab", "tab", "enter");
  expect(screen()).toMatch(/S05 — Payment provider/);
  expect(screen()).toMatch(/ Stages 5 /);
  press("shift+tab", "down", "down", "enter");
  expect(screen()).toMatch(/T012 waits on a trigger \(Traffic passes 1k orders a day\), not a stage/);
  press("down", "enter");
  expect(screen()).toMatch(/Stages R3 1/);
  expect(screen()).toMatch(/S09 — Refund API/);
  expect(choices).toEqual([]);
});

test("console stage detail shows the Atlas plan coverage the status report lists, asking once per stage", () => {
  const { screen, press, asked } = mount(undefined, {}, 160, 48);
  const shown = screen();
  expect(shown).toMatch(/Atlas plans/);
  expect(shown).toMatch(/Card payments \(plan-a\) · complete · 6\/6 rows · DC1/);
  expect(shown).toMatch(/Webhook hardening \(plan-b\) · unfinished · 2\/5 rows · DC2 · drift/);
  expect(shown).toMatch(/DC1 +covered by complete Card payments \(plan-a\)/);
  expect(shown).toMatch(/DC2 +only by unfinished Webhook hardening \(plan-b\)/);
  expect(shown).toMatch(/Drift: Webhook hardening \(plan-b\) approved before/);
  expect(shown).toMatch(/File +docs\/roadmap\/R2\/stages\/S05\.md/);
  press("down");
  expect(screen()).toMatch(/No Atlas plan is bound to this stage yet/);
  expect(screen()).toMatch(/DC1 +uncovered/);
  press("down");
  // No answer, as without omo-prometheus: no plan section at all.
  expect(screen()).not.toMatch(/Atlas plans/);
  press("up", "up");
  expect(asked).toEqual(["S05", "S06", "S07"]);

  const broken = consoleModelFixture();
  const s05 = broken.stages.find((stage) => stage.id === "S05");
  if (s05) s05.done_criteria = "not a criteria list";
  expect(mount(broken, {}, 160, 48).screen()).toMatch(/Coverage unavailable: /);
});

test("console secondary actions answer only where they apply and explain otherwise", () => {
  const active = mount();
  active.type("X");
  expect(active.choices).toEqual([{ action: "close", stage: "S05", view: { section: "stages", query: "", selected: "S05" } }]);

  const planned = mount();
  planned.press("down");
  planned.type("XRN");
  expect(planned.choices).toEqual([]);
  expect(planned.screen()).toMatch(/Close R2 before opening another round/);
  planned.type("R");
  expect(planned.screen()).toMatch(/Close or drop every stage of R2 before closing the round/);
  planned.type("X");
  expect(planned.screen()).toMatch(/Select an active stage in Stages to close it/);
  planned.type("E");
  expect(planned.screen()).toMatch(/Select an active or planned round in Rounds to revise it/);
  planned.type("D");
  expect(planned.screen()).toMatch(/Select a planned round in Rounds to drop it/);
  planned.type("U");
  expect(planned.screen()).toMatch(/This repository already uses roadmap format 2/);
  // Any key clears the message.
  planned.press("up");
  expect(planned.screen()).not.toMatch(/This repository already/);

  for (const [key, action] of [
    ["shift+c", "check"],
    ["shift+p", "plan-round"],
  ] as const) {
    const run = mount();
    run.press(key);
    expect(run.choices.map((choice) => choice?.action)).toEqual([action]);
  }

  // Target dates: unclosed stages and rounds of a format-2 repository.
  const stageTarget = mount(undefined, {}, 160);
  expect(stageTarget.screen()).toMatch(/⇧T target date/);
  stageTarget.type("T");
  expect(stageTarget.choices).toEqual([{ action: "retarget", stage: "S05", view: { section: "stages", query: "", selected: "S05" } }]);
  const closedStage = mount();
  closedStage.press("home");
  closedStage.type("T");
  expect(closedStage.screen()).toMatch(/Select an unclosed stage or round to change its target date/);
  const roundTarget = mount();
  roundTarget.press("tab");
  roundTarget.type("T");
  expect(roundTarget.choices.map((choice) => [choice?.action, choice?.round])).toEqual([["retarget", "R2"]]);

  const activeRoundRevision = mount(undefined, {}, 160);
  activeRoundRevision.press("tab");
  expect(activeRoundRevision.screen()).toMatch(/⇧E revise R2/);
  activeRoundRevision.type("E");
  expect(activeRoundRevision.choices).toEqual([
    { action: "plan-round", round: "R2", view: { section: "rounds", query: "", selected: "R2" } },
  ]);
  // Revise and drop act on the planned round selected in Rounds.
  for (const [key, action] of [
    ["E", "plan-round"],
    ["D", "drop-round"],
  ] as const) {
    const run = mount(undefined, {}, 160);
    run.press("tab", "down");
    expect(run.screen()).toMatch(/⇧E revise R3 {3}⇧D drop R3/);
    run.type(key);
    expect(run.choices).toEqual([{ action, round: "R3", view: { section: "rounds", query: "", selected: "R3" } }]);
  }

  // Format 1 has no target dates and offers the upgrade.
  const legacy = consoleModelFixture();
  legacy.index.format = 1;
  const old = mount(legacy, {}, 160);
  expect(old.screen()).toMatch(/⇧U upgrade to format 2/);
  expect(old.screen()).not.toMatch(/target date/);
  old.type("T");
  expect(old.screen()).toMatch(/Target dates need roadmap format 2; Shift\+U upgrades the repository/);
  old.type("U");
  expect(old.choices.map((choice) => choice?.action)).toEqual(["upgrade"]);

  const settled = consoleModelFixture();
  for (const stage of settled.stages) if (stage.round === "R2" && stage.status !== "dropped") stage.status = "closed";
  const closing = mount(settled, {}, 160);
  expect(closing.screen()).toMatch(/⇧R close R2/);
  closing.type("R");
  expect(closing.choices.map((choice) => choice?.action)).toEqual(["close-round"]);

  const between = consoleModelFixture();
  for (const round of between.rounds) if (round.status === "active") round.status = "closed";
  const next = mount(between, {}, 160);
  expect(next.screen()).toMatch(/No active round \(last: R2 Checkout and payments, closed\) · 2 planned rounds/);
  expect(next.screen()).toMatch(/⇧N activate R3/);
  // Without an active round the console starts on Rounds at the next planned round.
  expect(next.screen()).toMatch(/R3 — Refunds and disputes/);
  next.type("N");
  expect(next.choices).toEqual([{ action: "new-round", view: { section: "rounds", query: "", selected: "R3" } }]);
});

test("console reopens on the saved view with the last result, and handles an empty roadmap", () => {
  const reopened = mount(undefined, {
    view: { section: "todos", query: "", selected: "T011" },
    message: { text: "Check passed; the report is in the conversation", level: "info" },
  });
  expect(reopened.screen()).toMatch(/T011 — Template review with legal/);
  expect(reopened.screen()).toMatch(/Check passed; the report is in the conversation/);
  // A vanished item falls back to the section's first.
  const vanished = mount(undefined, { view: { section: "stages", query: "", selected: "S99" } });
  expect(vanished.screen()).toMatch(/S04 — Cart persistence/);

  const empty = mount(EMPTY);
  expect(empty.screen()).toMatch(/No rounds yet/);
  empty.press("enter");
  expect(empty.screen()).toMatch(/No rounds yet/);
  empty.press("tab");
  expect(empty.screen()).toMatch(/No open TODOs/);
  empty.press("tab");
  expect(empty.screen()).toMatch(/No active round; Shift\+N opens a new/);
  empty.type("N");
  expect(empty.choices.map((choice) => choice?.action)).toEqual(["new-round"]);
});

test("console lists stages in dependency order; Shift+O switches to id order, keeping the selection and the round detail in step", () => {
  const { screen, lines, press, type, orders } = mount(laterDependencyModel(), {}, 160, 48);
  expect(sidebarIds(lines(), 160)).toEqual(["S04", "S05", "S07", "S06", "S08"]);
  expect(screen()).toMatch(/order: dependency/);
  press("down");
  expect(selectedRow(screen())).toMatch(/S07 Checkout analytics/);

  type("O");
  expect(orders).toEqual(["id"]);
  expect(sidebarIds(lines(), 160)).toEqual(["S04", "S05", "S06", "S07", "S08"]);
  expect(selectedRow(screen())).toMatch(/S07 Checkout analytics/);
  expect(screen()).toMatch(/Stages are listed in id order for the rest of this session/);
  expect(screen()).toMatch(/order: id/);
  const detail = () => lines().map((line) => line.slice(Math.floor(160 * 0.36)));
  press("tab");
  expect(stageIds(detail())).toEqual(["S04", "S05", "S06", "S07", "S08"]);

  type("O");
  expect(orders).toEqual(["id", "dependency"]);
  expect(stageIds(detail())).toEqual(["S04", "S05", "S07", "S06", "S08"]);
});

test("console PgDn pages the detail past one block at a time and PgUp returns; a new item starts at its top", () => {
  const { screen, press } = mount(undefined, {}, 100, 24);
  expect(screen()).toMatch(/Status +⟳ active/);
  const hidden = () => Number(/… (\d+) more lines/.exec(screen())?.[1] ?? 0);
  const before = hidden();
  expect(before).toBeGreaterThan(0);
  press("pageDown");
  expect(screen()).not.toMatch(/Status +⟳ active/);
  expect(hidden()).toBeLessThan(before);
  // The heading stays while the detail scrolls.
  expect(screen()).toMatch(/S05 — Payment provider/);
  press("pageUp");
  expect(screen()).toMatch(/Status +⟳ active/);
  press("pageDown", "pageDown", "down");
  expect(screen()).toMatch(/S06 — Order confirmation emails/);
  expect(screen()).toMatch(/Status +⏳ planned/);
});

test("console PgDn reaches every row of a field list and of a paragraph taller than the pane", () => {
  const model = consoleModelFixture();
  const s05 = model.stages.find((stage) => stage.id === "S05");
  if (!s05) throw new Error("fixture changed");
  const dependencies = Array.from({ length: 40 }, (_, index) => `X${String(index + 1).padStart(2, "0")}`);
  const words = Array.from({ length: 400 }, (_, index) => `w${index}`);
  s05.depends_on = dependencies;
  s05.objective = words.join(" ");
  const { lines, press } = mount(model, {}, 100, 24);
  const seen = new Set<string>();
  const collect = () => {
    for (const line of lines()) for (const token of line.split(/\s+/)) seen.add(token);
  };
  collect();
  expect(seen.has("X40")).toBe(false);
  for (let page = 0; page < 40 && !seen.has(words.at(-1) as string); page++) {
    press("pageDown");
    collect();
  }
  // Every dependency and every word of the one long paragraph showed on some page: paging skips no row.
  expect(dependencies.filter((id) => !seen.has(id))).toEqual([]);
  expect(words.filter((word) => !seen.has(word))).toEqual([]);
  // At the end the pane stops with nothing more below, and PgUp walks back to the top.
  for (let page = 0; page < 40 && /more lines; PgDn scrolls/.test(lines().join("\n")); page++) press("pageDown");
  const end = lines().join("\n");
  expect(end).toMatch(/Outcome|Free-work log|Design constraints/);
  press("pageDown");
  expect(lines().join("\n")).toBe(end);
  for (let page = 0; page < 40; page++) press("pageUp");
  expect(lines().join("\n")).toMatch(/Status +⟳ active/);
});

test("console follows a terminal resize", () => {
  const { term, lines, resize } = mount(undefined, {}, 80, 24);
  resize(120, 40);
  expect(term.screen()).toHaveLength(40);
  expect(lines().slice(-2).join(" ")).toMatch(/Esc close/);
});

const ROOT = "/work/shop";
function previewRequest(): PreviewRequest {
  const model = consoleModelFixture();
  const round = model.rounds.find((candidate) => candidate.id === "R3");
  const stage = model.stages.find((candidate) => candidate.id === "S09");
  if (!round || !stage) throw new Error("fixture changed");
  return {
    title: "Plan round R3 Refunds and disputes.\nThe files are rechecked after you confirm.",
    root: ROOT,
    files: [
      { path: `${ROOT}/docs/roadmap/R3/README.md`, content: renderRound(round) },
      { path: `${ROOT}/docs/roadmap/R3/stages/S09-refund-api.md`, content: renderStage(stage) },
      { path: `${ROOT}/docs/roadmap/R3/notes.txt`, content: "plain\n  indented line\n" },
    ],
  };
}

function preview(columns = 100, rows = 24) {
  const answers: boolean[] = [];
  return { ...terminal(() => new PreviewView(previewRequest(), theme, (answer) => answers.push(answer)), columns, rows), answers };
}

test("preview fills 80x24 and 160x48 on every row and stays within narrow widths", () => {
  for (const [width, rows] of [
    [80, 24],
    [160, 48],
  ] as const) {
    const { term, lines, press } = preview(width, rows);
    for (let row = 0; row < 5; row++) {
      for (const raw of [false, true]) {
        expect(term.screen()).toHaveLength(rows);
        expect(lines().at(-1)).toMatch(/Esc cancel/);
        expect(term.rows().filter((line) => visibleWidth(stripEscapes(line)) > width)).toEqual([]);
        if (raw) press("space");
      }
      press("down");
    }
  }
  for (const width of [30, 40]) {
    const { term } = preview(width, 12);
    expect(term.rows().filter((line) => visibleWidth(stripEscapes(line)) > width)).toEqual([]);
  }
});

test("preview lists repo-relative files between Write and Cancel and shows each file rendered or raw", () => {
  const { screen, lines, press } = preview(120, 40);
  const sidebar = lines()
    .slice(3, 8)
    .map((line) => line.slice(0, 43));
  expect(sidebar).toEqual([
    expect.stringMatching(/Write 3 files/),
    expect.stringMatching(/README\.md {2}docs\/roadmap\/R3/),
    expect.stringMatching(/S09-refund-api\.md {2}docs\/roadmap\/R3\/stages/),
    expect.stringMatching(/notes\.txt {2}docs\/roadmap\/R3/),
    expect.stringMatching(/Cancel/),
  ]);
  expect(screen()).not.toMatch(/\/work\/shop/);
  expect(screen()).toMatch(/The files are rechecked after you confirm/);
  expect(screen()).toMatch(/docs\/roadmap\/R3\/stages\/S09-refund-api\.md · 55 lines/);
  press("down");
  expect(screen()).toMatch(/status: "planned"/);
  expect(screen()).toMatch(/R3 — Refunds and disputes/);
  expect(screen()).not.toMatch(/Managed by the roadmap OMP plugin/);
  press("space");
  expect(screen()).toMatch(/Managed by the roadmap OMP plugin/);
  press("space");
  expect(screen()).not.toMatch(/Managed by the roadmap OMP plugin/);
  press("down", "down");
  expect(screen()).toMatch(/ {2}indented line/);
  expect(screen()).not.toMatch(/Space raw text/);
});

test("preview answers once: Write or Shift+W writes, Cancel or Esc declines, Enter on a file explains", () => {
  const write = preview();
  write.press("enter", "escape");
  expect(write.answers).toEqual([true]);

  const shifted = preview();
  shifted.press("down", "enter");
  expect(shifted.answers).toEqual([]);
  expect(shifted.screen()).toMatch(/Shift\+W or the Write row writes every file; Esc cancels/);
  shifted.type("W");
  expect(shifted.answers).toEqual([true]);

  const cancel = preview();
  cancel.press("end", "enter");
  expect(cancel.answers).toEqual([false]);

  const dismissed = preview();
  dismissed.press("down", "escape");
  expect(dismissed.answers).toEqual([false]);
});

interface Stub {
  ctx: RoadmapUiContext;
  selects: string[];
  options: string[][];
  customs: unknown[];
  reads: string[];
  reader: (cwd: string) => Promise<UiMenu>;
}

/** The key event a terminal sends for one typed character. */
function typed(text: string): KeyEvent {
  return { id: /^[A-Z]$/.test(text) ? `shift+${text.toLowerCase()}` : text, kind: "press", raw: text, text };
}

/** A terminal UI whose custom views receive `keys`; select answers Write so the inline path ends. */
function stub(mode: "tui" | "rpc", setting: UiMenu, keys: string[] = []): Stub {
  const selects: string[] = [];
  const options: string[][] = [];
  const customs: unknown[] = [];
  const reads: string[] = [];
  const ui = {
    select: async (title: string, labels: string[]) => {
      selects.push(title);
      options.push(labels);
      return labels[0];
    },
    editor: async () => undefined,
    input: async () => undefined,
    notify() {},
    custom: <T>(factory: (host: unknown, th: typeof theme, keybindings: unknown, done: (value: T) => void) => UiNode, custom: unknown) => {
      const { promise, resolve } = Promise.withResolvers<T>();
      customs.push(custom);
      const view = factory(
        { size: () => ({ columns: 100, rows: 24 }), requestRender() {}, suspend: (run: () => unknown) => run() },
        theme,
        undefined,
        resolve,
      );
      for (const key of keys) view.handlers.onKey?.(typed(key));
      return promise;
    },
  };
  return {
    ctx: { hasUI: true, mode, cwd: "/work/shop", ui, sessionManager: { getSessionId: () => "session-1" } } as unknown as RoadmapUiContext,
    selects,
    options,
    customs,
    reads,
    reader: async (cwd) => {
      reads.push(cwd);
      return setting;
    },
  };
}

const pi = { sendMessage() {} };

test("uiMenu inline keeps the select preview and the inline status menu, reading the setting on every use", async () => {
  const run = stub("tui", "inline");
  const ui = createTuiUi(run.ctx, pi, run.reader);
  expect(await ui.fullscreenMenu()).toBe(false);
  expect(await ui.previewConfirm(previewRequest())).toBe(true);
  expect(run.selects[0]).toMatch(/Select a file to view it, or write all of them/);
  expect(run.customs).toEqual([]);
  expect(run.reads).toEqual(["/work/shop", "/work/shop"]);
});

test("uiMenu fullscreen mounts the preview and the console as fullscreen overlays", async () => {
  const run = stub("tui", "fullscreen", ["W"]);
  const ui = createTuiUi(run.ctx, pi, run.reader);
  expect(await ui.fullscreenMenu()).toBe(true);
  expect(await ui.previewConfirm(previewRequest())).toBe(true);
  expect(run.selects).toEqual([]);
  expect(run.customs).toEqual([{ overlay: true, fullscreen: true }]);
  const menu = stub("tui", "fullscreen", ["C"]);
  const choice = await createTuiUi(menu.ctx, pi, menu.reader).statusConsole(consoleModelFixture(), {});
  expect(choice).toEqual({ action: "check", view: { section: "stages", query: "", selected: "S05" } });
  // Without a reader the setting's default applies.
  expect(await createTuiUi(stub("tui", "inline").ctx, pi).fullscreenMenu()).toBe(true);
});

test("RPC-style hosts and headless sessions never read the setting and keep their paths", async () => {
  const rpc = stub("rpc", "fullscreen");
  const ui = createTuiUi(rpc.ctx, pi, rpc.reader);
  expect(await ui.fullscreenMenu()).toBe(false);
  expect(await ui.previewConfirm(previewRequest())).toBe(true);
  expect(rpc.selects).toHaveLength(1);
  expect(rpc.customs).toEqual([]);
  expect(rpc.reads).toEqual([]);

  const reads: string[] = [];
  const headless = createTuiUi({ hasUI: false } as RoadmapUiContext, pi, async (cwd) => {
    reads.push(cwd);
    return "fullscreen";
  });
  expect(headless).toBeInstanceOf(HeadlessUi);
  expect(await headless.fullscreenMenu()).toBe(false);
  expect(await headless.statusConsole(EMPTY, {})).toBeUndefined();
  expect(reads).toEqual([]);
});

test("the stage order preference orders the inline menu and the console, and Shift+O sets it for the session", async () => {
  const root = await projectWith({ stageOrder: "id" });
  const preference = new StageOrderPreference({ warn() {} });
  const menu = stub("rpc", "inline");
  const inline = createTuiUi({ ...menu.ctx, cwd: root }, pi, menu.reader, preference);
  await inline.statusMenu(laterDependencyModel(), ON);
  expect(stageIds(menu.options[0] ?? [])).toEqual(["S04", "S05", "S06", "S07", "S08"]);

  // The console opens in the setting's id order, so Shift+O switches it to dependency order for the session.
  const fullscreen = stub("tui", "fullscreen", ["O", "C"]);
  const choice = await createTuiUi({ ...fullscreen.ctx, cwd: root }, pi, fullscreen.reader, preference).statusConsole(
    laterDependencyModel(),
    { on: ON },
  );
  expect(choice?.action).toBe("check");
  expect(await preference.current({ ...menu.ctx, cwd: root })).toBe("dependency");
  await inline.statusMenu(laterDependencyModel(), ON);
  expect(stageIds(menu.options[1] ?? [])).toEqual(["S04", "S05", "S07", "S06", "S08"]);
});

const temporary: string[] = [];
afterAll(async () => {
  for (const path of temporary) await rm(path, { recursive: true, force: true });
});

async function projectWith(settings: Record<string, unknown> | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "roadmap-ui-menu-"));
  temporary.push(root);
  if (settings) {
    await mkdir(join(root, ".omp"));
    await writeFile(join(root, ".omp/plugin-overrides.json"), JSON.stringify({ settings: { [PACKAGE_NAME]: settings } }));
  }
  return root;
}

test("uiMenu reads project settings; a missing value means fullscreen and an invalid one warns and falls back", async () => {
  expect(parseUiMenu(undefined)).toBe("fullscreen");
  expect(parseUiMenu("inline")).toBe("inline");
  expect(() => parseUiMenu("sideways")).toThrow(/invalid uiMenu "sideways"/);
  const warnings: unknown[][] = [];
  const read = uiMenuReader({ warn: (...args: unknown[]) => void warnings.push(args) });
  expect(await read(await projectWith({ uiMenu: "inline" }))).toBe("inline");
  expect(await read(await projectWith(undefined))).toBe("fullscreen");
  expect(warnings).toEqual([]);
  expect(await read(await projectWith({ uiMenu: "sideways" }))).toBe("fullscreen");
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0]?.[0])).toMatch(/uiMenu/);
});
