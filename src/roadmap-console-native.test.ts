import { afterEach, expect, test } from "bun:test";

import { createRoot, signal, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleEvent, keypathOf } from "@oh-my-pi/pi-tui/dispatch";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

import type { AtlasStagePlan } from "../plugins/roadmap/src/atlas.ts";
import { type ConsoleChoice, type ConsoleState, type PreviewRequest, PreviewView, RoadmapConsole } from "../plugins/roadmap/src/console.ts";
import { type Model, renderRound } from "../plugins/roadmap/src/documents.ts";
import type { StageOrder } from "../plugins/roadmap/src/settings.ts";
import { consoleModelFixture, planFixture } from "./roadmap-fixtures.ts";

const theme = loadThemeSync("dark");
const environment = staticEnvironment(theme);
const ON = "2026-10-11";

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

/** A described node, as Tern receives it. */
interface Described {
  k: string;
  key?: string;
  p?: Record<string, unknown>;
  c?: Described[];
  reveal?: unknown;
  scroll?: unknown;
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function props(node: Described | undefined): Record<string, unknown> {
  return node?.p ?? {};
}

function walk(root: Described): Described[] {
  return [root, ...(root.c ?? []).flatMap(walk)];
}

function byKey(root: Described, key: string): Described {
  const found = walk(root).find((node) => node.key === key);
  if (!found) throw new Error(`no node keyed ${key}`);
  return found;
}

/** Plain text of a TspText or any node's spans, props and children. */
function plain(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plain).join("");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.t === "string") return record.t;
    if (typeof record.k === "string") {
      const p = (record.p ?? {}) as Record<string, unknown>;
      const own = [p.text, p.spans, p.label, p.detail, p.value, p.head, p.items].map(plain).join(" ");
      return [own, ...((record.c as unknown[]) ?? []).map(plain)].join(" ");
    }
    return Object.values(record).map(plain).join(" ");
  }
  return "";
}

/** The UiNode path from `root` to the node keyed `key`. */
function pathTo(root: UiNode, key: string): UiNode[] {
  const visit = (node: UiNode, path: UiNode[]): UiNode[] | undefined => {
    const here = [...path, node];
    if (node.key() === key) return here;
    for (const child of node.children()) {
      const found = visit(child, here);
      if (found) return found;
    }
    return undefined;
  };
  const found = visit(root, []);
  if (!found) throw new Error(`no node keyed ${key}`);
  return found;
}

function sheet(make: () => { view(host: { size(): { columns: number; rows: number } }, native: boolean): UiNode }) {
  const size = signal({ columns: 120, rows: 40 });
  const root = createRoot((dispose) => {
    disposers.push(dispose);
    return make().view({ size }, true);
  });
  const deliver = (key: string, event: (keypath: string) => UiEvent) => {
    const path = pathTo(root, key);
    bubbleEvent(path, event(keypathOf(path)));
  };
  return {
    root,
    size,
    describe: () => describeTree(root, environment) as Described,
    select: (list: string, item: string, type: "select" | "activate" = "select") =>
      deliver(list, (keypath) => ({ type, key: keypath, item })),
    act: (act: string) => deliver("actions", (keypath) => ({ type: "action", key: `${keypath}/${act}`, act, mods: [] })),
    key: (id: string, text?: string) =>
      root.children()[0]?.handlers.onKey?.({ id, kind: "press", raw: text ?? "", ...(text ? { text } : {}) }),
  };
}

function items(root: Described): Described[] {
  return byKey(root, "items").c ?? [];
}

function buttons(root: Described): Map<string, Described> {
  return new Map(
    (byKey(root, "actions").c ?? []).flatMap((child) => {
      const act = (props(child).actions as { click?: string } | undefined)?.click;
      return act ? [[act, child] as const] : [];
    }),
  );
}

const selectedLabel = (root: Described): string => {
  const chosen = items(root).find((entry) => entry.key === props(byKey(root, "items")).selected);
  return plain(props(chosen).label);
};

function mount(model: Model = consoleModelFixture(), state: ConsoleState = {}) {
  const choices: Array<ConsoleChoice | undefined> = [];
  const orders: StageOrder[] = [];
  const mounted = sheet(
    () =>
      new RoadmapConsole(
        model,
        { on: ON, ...state },
        theme,
        (choice) => choices.push(choice),
        (stage) => PLANS[stage],
        (order) => orders.push(order),
      ),
  );
  const itemFor = (id: string) => {
    const entry = items(mounted.describe()).find((candidate) => plain(props(candidate).label).includes(id));
    if (!entry?.key) throw new Error(`no item ${id}`);
    return entry.key;
  };
  return {
    ...mounted,
    choices,
    orders,
    pick: (id: string, type: "select" | "activate" = "select") => mounted.select("items", itemFor(id), type),
    tab: (section: string) => mounted.select("sections", section),
  };
}

test("console is a large modal sheet titled by the roadmap", () => {
  const root = mount().describe();
  expect(root.k).toBe("overlay");
  expect(props(root)).toMatchObject({ role: "omp.overlay.roadmap.console", size: "lg", anchor: "center", modal: true });
  expect(plain(props(root).head)).toMatch(/Roadmap · Shop platform/);
});

test("console describes the sections, the toned item list with tooltips and the selected stage's detail", () => {
  const root = mount().describe();
  const tabs = byKey(root, "sections");
  expect(tabs.k).toBe("tabs");
  expect(props(tabs).active).toBe("stages");
  expect((props(tabs).items as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["stages", "rounds", "todos"]);

  const list = items(root);
  expect(list.map((entry) => plain(props(entry).label).match(/S\d\d/)?.[0])).toEqual(["S04", "S05", "S06", "S07", "S08"]);
  expect(selectedLabel(root)).toMatch(/S05/);
  const s05 = list.find((entry) => plain(props(entry).label).includes("S05"));
  expect(props(s05).tone).toBe("accent");
  expect(s05?.reveal).toBe("nearest");
  // Items stay one line: the overdue mark at the end, the rest (coverage, readiness) in the tooltip.
  expect(plain(props(s05).value)).toContain(theme.symbols.symbol("status.warning"));
  expect(props(s05).title).toMatch(/overdue/);
  expect(props(s05).title).toMatch(/1\/2 criteria covered/);
  expect(props(s05).title).toMatch(/drift/);
  const s06 = list.find((entry) => plain(props(entry).label).includes("S06"));
  expect(props(s06).title).toMatch(/blocked by S05/);

  const body = byKey(root, "body");
  expect(plain(body)).toMatch(/S05 — Payment provider integration/);
  expect(plain(body)).toMatch(/ADR-0004/);
  expect(plain(body)).toMatch(/Atlas plans/);
  expect(walk(body).some((node) => node.k === "kv")).toBe(true);
  expect(walk(body).some((node) => node.k === "md")).toBe(true);
  // The detail scrolls in a list: the only plain node Tern scrolls.
  expect(walk(body).find((node) => node.k === "list")?.p?.max).toEqual({ lines: 10_000 });
  // An active stage offers closing it, as Shift+X does.
  expect([...buttons(root).keys()]).toEqual(expect.arrayContaining(["primary", "close-stage", "check", "plan-round", "close"]));
  expect(props(buttons(root).get("close-stage")).keys).toEqual(["shift", "x"]);
});

test("console sheet has a fixed extent that follows terminal resizes", () => {
  const { describe, size } = mount();
  const screen = () => describe().c?.[0] as Described;
  expect(props(screen()).max).toEqual({ h: "32lines" });
  expect(props(screen()).min).toEqual(props(screen()).max);
  size.set({ columns: 120, rows: 60 });
  expect(props(screen()).max).toEqual({ h: "52lines" });
  expect(props(screen()).min).toEqual(props(screen()).max);
});

test("console native selection and tabs mirror the keys, and activation runs Enter", () => {
  const { describe, pick, tab, choices } = mount();
  pick("S07");
  expect(plain(byKey(describe(), "body"))).toMatch(/S07 — Checkout analytics/);
  tab("rounds");
  expect(props(byKey(describe(), "sections")).active).toBe("rounds");
  expect(selectedLabel(describe())).toMatch(/R2/);
  // Double click on a round lists its stages, as Enter does.
  pick("R3", "activate");
  expect(props(byKey(describe(), "sections")).active).toBe("stages");
  expect(plain(byKey(describe(), "sections"))).toMatch(/Stages R3 1/);
  expect(selectedLabel(describe())).toMatch(/S09/);
  tab("todos");
  pick("T012", "activate");
  expect(plain(byKey(describe(), "message"))).toMatch(/T012 waits on a trigger/);
  expect(choices).toEqual([]);
});

test("console buttons answer with the same choices as their keys", () => {
  const keyed = mount();
  keyed.key("shift+x", "X");
  const clicked = mount();
  clicked.act("close-stage");
  expect(clicked.choices).toEqual(keyed.choices);
  expect(clicked.choices).toEqual([{ action: "close", stage: "S05", view: { section: "stages", query: "", selected: "S05" } }]);

  for (const [key, act] of [
    ["c", "check"],
    ["p", "plan-round"],
    ["t", "retarget"],
  ] as const) {
    const byKeys = mount();
    byKeys.key(`shift+${key}`, key.toUpperCase());
    const byButton = mount();
    byButton.act(act);
    expect(byButton.choices).toEqual(byKeys.choices);
    expect(byButton.choices).toHaveLength(1);
  }

  const planned = mount();
  planned.tab("rounds");
  planned.pick("R3");
  expect([...buttons(planned.describe()).keys()]).toEqual(expect.arrayContaining(["revise", "drop"]));
  expect(props(buttons(planned.describe()).get("drop")).variant).toBe("danger");
  planned.act("drop");
  expect(planned.choices).toEqual([{ action: "drop-round", round: "R3", view: { section: "rounds", query: "", selected: "R3" } }]);

  // A refused action explains itself in the message line, as the key does.
  const refused = mount();
  refused.act("new-round");
  expect(refused.choices).toEqual([]);
  expect(plain(byKey(refused.describe(), "message"))).toMatch(/Close R2 before opening another round/);

  const closing = mount();
  closing.act("close");
  expect(closing.choices).toEqual([undefined]);
  closing.act("check");
  expect(closing.choices).toEqual([undefined]);
});

test("console close button clears a search first, like Esc", () => {
  const { describe, act, key, choices } = mount();
  for (const char of "s07") key(char, char);
  expect(items(describe())).toHaveLength(1);
  expect(plain(byKey(describe(), "search"))).toMatch(/Search: s07/);
  expect(plain(buttons(describe()).get("close"))).toMatch(/Clear search/);
  act("close");
  expect(choices).toEqual([]);
  expect(items(describe())).toHaveLength(5);
  act("close");
  expect(choices).toEqual([undefined]);
});

test("console PgDn forwards a page scroll to the detail's scroller", () => {
  const { describe, key } = mount();
  const content = () => walk(byKey(describe(), "body")).find((node) => node.key === "detail-stage-S05");
  expect(content()?.scroll).toBeUndefined();
  key("pageDown");
  expect(content()?.scroll).toEqual({ by: "page-down", n: 1 });
  key("pageUp");
  expect(content()?.scroll).toEqual({ by: "page-up", n: 2 });
});

test("console order button switches the stage order like Shift+O and names the current order", () => {
  const model = consoleModelFixture();
  const laterDependency: Model = {
    ...model,
    stages: model.stages.map((stage) => (stage.id === "S06" ? { ...stage, depends_on: ["S07"] } : stage)),
  };
  const ids = (root: Described) => items(root).flatMap((entry) => /\b(S0\d) /.exec(plain(props(entry).label))?.[1] ?? []);
  const clicked = mount(laterDependency);
  expect(ids(clicked.describe())).toEqual(["S04", "S05", "S07", "S06", "S08"]);
  expect(plain(buttons(clicked.describe()).get("order"))).toMatch(/Order: dependency/);
  clicked.pick("S07");
  clicked.act("order");
  expect(clicked.orders).toEqual(["id"]);
  const root = clicked.describe();
  expect(ids(root)).toEqual(["S04", "S05", "S06", "S07", "S08"]);
  expect(selectedLabel(root)).toMatch(/S07 Checkout analytics/);
  expect(plain(buttons(root).get("order"))).toMatch(/Order: id/);
  expect(plain(byKey(root, "message"))).toMatch(/Stages are listed in id order for the rest of this session/);

  const keyed = mount(laterDependency);
  keyed.pick("S07");
  keyed.key("shift+o", "O");
  expect(keyed.orders).toEqual(clicked.orders);
  expect(ids(keyed.describe())).toEqual(ids(clicked.describe()));

  clicked.tab("rounds");
  expect(plain(byKey(clicked.describe(), "body"))).toMatch(/S06 Order confirmation emails[\s\S]*S07 Checkout analytics/);
  clicked.act("order");
  expect(plain(byKey(clicked.describe(), "body"))).toMatch(/S07 Checkout analytics[\s\S]*S06 Order confirmation emails/);
});

const ROOT = "/work/shop";
function previewRequest(): PreviewRequest {
  const model = consoleModelFixture();
  const round = model.rounds.find((candidate) => candidate.id === "R3");
  if (!round) throw new Error("fixture changed");
  return {
    title: "Plan round R3 Refunds and disputes.\nThe files are rechecked after you confirm.",
    root: ROOT,
    files: [
      { path: `${ROOT}/docs/roadmap/R3/README.md`, content: renderRound(round) },
      { path: `${ROOT}/docs/roadmap/R3/notes.txt`, content: "plain\n  indented line\n" },
    ],
  };
}

function preview() {
  const answers: boolean[] = [];
  const mounted = sheet(() => new PreviewView(previewRequest(), theme, (answer) => answers.push(answer)));
  return {
    ...mounted,
    answers,
    row: (index: number, type: "select" | "activate" = "select") => mounted.select("items", `i${index}`, type),
  };
}

test("preview is a sheet listing repo-relative files between Write and Cancel", () => {
  const { describe, row, act } = preview();
  const root = describe();
  expect(props(root)).toMatchObject({ role: "omp.overlay.roadmap.preview", size: "lg", anchor: "center" });
  const labels = items(root).map((entry) => plain(props(entry).label));
  expect(labels).toHaveLength(4);
  expect(labels[0]).toMatch(/Write 2 files/);
  // The file name leads; the directory follows as detail and the full path is the tooltip.
  expect(labels.slice(1, 3)).toEqual(["README.md", "notes.txt"]);
  const files = items(root).slice(1, 3);
  expect(files.map((entry) => plain(props(entry).detail))).toEqual(["docs/roadmap/R3", "docs/roadmap/R3"]);
  expect(props(files[1]).title).toMatch(/^docs\/roadmap\/R3\/notes\.txt/);
  expect(labels[3]).toMatch(/Cancel/);
  expect(plain(byKey(root, "body"))).toMatch(/docs\/roadmap\/R3\/README\.md/);

  row(1);
  const markdown = byKey(describe(), "body");
  expect(walk(markdown).some((node) => node.k === "md")).toBe(true);
  expect(plain(markdown)).not.toMatch(/Managed by the roadmap OMP plugin/);
  expect(buttons(describe()).has("raw")).toBe(true);
  act("raw");
  const raw = byKey(describe(), "body");
  expect(walk(raw).some((node) => node.k === "md")).toBe(false);
  expect(walk(raw).filter((node) => node.k === "code")).toHaveLength(1);

  row(2);
  expect(buttons(describe()).has("raw")).toBe(false);
  const text = walk(byKey(describe(), "body")).find((node) => node.k === "code");
  expect(props(text)).toMatchObject({ text: "plain\n  indented line", path: `${ROOT}/docs/roadmap/R3/notes.txt` });
});

test("preview native events answer like the keys, once", () => {
  const write = preview();
  write.row(0, "activate");
  write.act("cancel");
  expect(write.answers).toEqual([true]);

  const cancel = preview();
  cancel.row(3, "activate");
  expect(cancel.answers).toEqual([false]);

  const button = preview();
  button.act("write");
  expect(button.answers).toEqual([true]);

  const onFile = preview();
  onFile.row(1, "activate");
  expect(onFile.answers).toEqual([]);
  expect(plain(byKey(onFile.describe(), "message"))).toMatch(/writes every file/);
  onFile.act("cancel");
  expect(onFile.answers).toEqual([false]);
});
