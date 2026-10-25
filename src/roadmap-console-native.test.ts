import { beforeAll, expect, test } from "bun:test";

import { initTheme, type NativeChild, type NativeNode, type NativeUiEvent, type TUI, theme } from "@oh-my-pi/pi-tui";

import type { AtlasStagePlan } from "../plugins/roadmap/src/atlas.ts";
import { type ConsoleChoice, type ConsoleState, type PreviewRequest, PreviewView, RoadmapConsole } from "../plugins/roadmap/src/console.ts";
import { type Model, renderRound } from "../plugins/roadmap/src/documents.ts";
import { consoleModelFixture, planFixture } from "./roadmap-fixtures.ts";

beforeAll(async () => {
  await initTheme();
});

const ON = "2026-10-11";
const TUI_STUB = { requestRender() {}, terminal: { rows: 24 } } as unknown as TUI;

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

type Props = Record<string, unknown>;

function isNode(child: NativeChild): child is NativeNode {
  return typeof child === "object" && child !== null && "k" in child;
}

function props(described: NativeNode): Props {
  return (described.p ?? {}) as Props;
}

/** Every node of the tree, depth first, with its keypath. */
function walk(root: NativeNode, path = ""): Array<{ node: NativeNode; path: string }> {
  const out = [{ node: root, path }];
  for (const child of root.c ?? []) {
    if (!isNode(child)) continue;
    out.push(...walk(child, child.key ? (path ? `${path}/${child.key}` : child.key) : path));
  }
  return out;
}

function byKey(root: NativeNode, key: string): { node: NativeNode; path: string } {
  const found = walk(root).find((entry) => entry.node.key === key);
  if (!found) throw new Error(`no node keyed ${key}`);
  return found;
}

/** Plain text of a TspText or any node's spans and children. */
function plain(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plain).join("");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.t === "string") return record.t;
    if (typeof record.k === "string") {
      const p = (record.p ?? {}) as Props;
      const own = [p.text, p.spans, p.label, p.detail, p.value, p.head, p.items].map(plain).join(" ");
      return [own, ...((record.c as unknown[]) ?? []).map(plain)].join(" ");
    }
    return Object.values(record).map(plain).join(" ");
  }
  return "";
}

function items(root: NativeNode): NativeNode[] {
  return (byKey(root, "items").node.c ?? []).filter(isNode);
}

function buttons(root: NativeNode): Map<string, NativeNode> {
  const bar = byKey(root, "actions").node;
  return new Map(
    (bar.c ?? []).filter(isNode).flatMap((child) => {
      const act = (props(child).actions as { click?: string } | undefined)?.click;
      return act ? [[act, child] as const] : [];
    }),
  );
}

function mount(model: Model = consoleModelFixture(), state: ConsoleState = {}) {
  const choices: Array<ConsoleChoice | undefined> = [];
  const component = new RoadmapConsole(
    model,
    { on: ON, ...state },
    theme,
    TUI_STUB,
    (choice) => choices.push(choice),
    (stage) => PLANS[stage],
  );
  const describe = () => component.describe();
  const itemsPath = () => byKey(describe(), "items").path;
  return {
    component,
    choices,
    describe,
    select: (id: string, type: "select" | "activate" = "select") => {
      const index = items(describe()).findIndex((entry) => plain(props(entry).label).includes(id));
      if (index < 0) throw new Error(`no item ${id}`);
      component.handleNativeEvent({ type, key: itemsPath(), item: `i${index}` });
    },
    act: (act: string) => component.handleNativeEvent({ type: "action", key: `actions/${act}`, act, mods: [] }),
    tab: (section: string) =>
      component.handleNativeEvent({ type: "select", key: byKey(describe(), "sections").path, item: section } satisfies NativeUiEvent),
  };
}

const selectedLabel = (root: NativeNode): string => {
  const list = byKey(root, "items").node;
  const chosen = items(root).find((entry) => entry.key === props(list).selected);
  return plain(props(chosen as NativeNode).label);
};

test("console describes a large glass sheet titled by the roadmap", () => {
  const { component } = mount();
  expect(component.nativeOverlay).toMatchObject({ role: "omp.overlay.roadmap.console", size: "lg", anchor: "center" });
  expect(plain(component.nativeOverlay.head)).toMatch(/Shop platform/);
  // The same object while the title stays.
  expect(component.nativeOverlay).toBe(component.nativeOverlay);
});

test("console describes the sections, the toned item list with badges and the selected stage's detail", () => {
  const { component } = mount();
  const root = component.describe();
  const tabs = byKey(root, "sections").node;
  expect(tabs.k).toBe("tabs");
  expect(props(tabs).active).toBe("stages");
  expect((props(tabs).items as Array<{ id: string }>).map((entry) => entry.id)).toEqual(["stages", "rounds", "todos"]);

  const list = items(root);
  expect(list.map((entry) => plain(props(entry).label).match(/S\d\d/)?.[0])).toEqual(["S04", "S05", "S06", "S07", "S08"]);
  expect(selectedLabel(root)).toMatch(/S05/);
  const s05 = list.find((entry) => plain(props(entry).label).includes("S05")) as NativeNode;
  expect(props(s05).tone).toBe("accent");
  // Overdue and the Atlas coverage of its criteria, which one plan covers incompletely and one drifted.
  expect(plain(props(s05).value)).toMatch(/overdue/);
  expect(plain(props(s05).value)).toMatch(/1\/2 covered/);
  expect(plain(props(s05).value)).toMatch(/drift/);
  const s04 = list.find((entry) => plain(props(entry).label).includes("S04")) as NativeNode;
  expect(props(s04).tone).toBe("success");
  const s06 = list.find((entry) => plain(props(entry).label).includes("S06")) as NativeNode;
  expect(plain(props(s06).detail)).toMatch(/blocked by S05/);

  const body = plain(byKey(root, "body").node);
  expect(body).toMatch(/S05 — Payment provider integration/);
  expect(body).toMatch(/ADR-0004/);
  expect(body).toMatch(/Atlas plans/);
  expect(walk(byKey(root, "body").node).some(({ node }) => node.k === "kv")).toBe(true);
  expect(walk(byKey(root, "body").node).some(({ node }) => node.k === "md")).toBe(true);
  // An active stage offers closing it, as Shift+X does.
  expect([...buttons(root).keys()]).toEqual(expect.arrayContaining(["primary", "close-stage", "check", "plan-round", "close"]));
});

test("console describe returns the same node until the state changes", () => {
  const { component, select } = mount();
  const first = component.describe();
  expect(component.describe()).toBe(first);
  select("S06");
  const second = component.describe();
  expect(second).not.toBe(first);
  expect(selectedLabel(second)).toMatch(/S06/);
  expect(component.describe()).toBe(second);
});

test("console native selection and tabs mirror the keys, and activation runs Enter", () => {
  const { describe, select, tab, choices } = mount();
  select("S07");
  expect(plain(byKey(describe(), "body").node)).toMatch(/S07 — Checkout analytics/);
  tab("rounds");
  expect(props(byKey(describe(), "sections").node).active).toBe("rounds");
  expect(selectedLabel(describe())).toMatch(/R2/);
  // Double click on a round lists its stages, as Enter does.
  select("R3", "activate");
  expect(props(byKey(describe(), "sections").node).active).toBe("stages");
  expect(plain(byKey(describe(), "sections").node)).toMatch(/Stages R3 1/);
  expect(selectedLabel(describe())).toMatch(/S09/);
  // Tab returns to the remembered TODO selection like the Tab key.
  tab("todos");
  select("T012", "activate");
  expect(plain(byKey(describe(), "message").node)).toMatch(/T012 waits on a trigger/);
  expect(choices).toEqual([]);
});

test("console buttons answer with the same choices as their keys", () => {
  const keyed = mount();
  keyed.component.handleInput("X");
  const clicked = mount();
  clicked.act("close-stage");
  expect(clicked.choices).toEqual(keyed.choices);
  expect(clicked.choices).toEqual([{ action: "close", stage: "S05", view: { section: "stages", query: "", selected: "S05" } }]);

  for (const [key, act] of [
    ["C", "check"],
    ["P", "plan-round"],
    ["T", "retarget"],
  ] as const) {
    const byKey = mount();
    byKey.component.handleInput(key);
    const byButton = mount();
    byButton.act(act);
    expect(byButton.choices).toEqual(byKey.choices);
    expect(byButton.choices).toHaveLength(1);
  }

  const planned = mount();
  planned.tab("rounds");
  planned.select("R3");
  expect([...buttons(planned.describe()).keys()]).toEqual(expect.arrayContaining(["revise", "drop"]));
  planned.act("drop");
  expect(planned.choices).toEqual([{ action: "drop-round", round: "R3", view: { section: "rounds", query: "", selected: "R3" } }]);

  // A refused action explains itself in the message line, as the key does.
  const refused = mount();
  refused.act("new-round");
  expect(refused.choices).toEqual([]);
  const message = byKey(refused.describe(), "message").node;
  expect(plain(message)).toMatch(/Close R2 before opening another round/);

  const closing = mount();
  closing.act("close");
  expect(closing.choices).toEqual([undefined]);
  closing.act("check");
  expect(closing.choices).toEqual([undefined]);
});

test("console close button clears a search first, like Esc", () => {
  const { component, describe, act, choices } = mount();
  for (const key of "s07") component.handleInput(key);
  expect(items(describe())).toHaveLength(1);
  expect(plain(byKey(describe(), "search").node)).toMatch(/Search: s07/);
  act("close");
  expect(choices).toEqual([]);
  expect(items(describe())).toHaveLength(5);
  act("close");
  expect(choices).toEqual([undefined]);
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
      { path: `${ROOT}/docs/roadmap/R3/notes.txt`, content: "plain\n  indented line\n" },
    ],
  };
}

function preview() {
  const answers: boolean[] = [];
  const component = new PreviewView(previewRequest(), theme, TUI_STUB, (answer) => answers.push(answer));
  const path = () => byKey(component.describe(), "items").path;
  return {
    component,
    answers,
    select: (index: number, type: "select" | "activate" = "select") =>
      component.handleNativeEvent({ type, key: path(), item: `i${index}` }),
    act: (act: string) => component.handleNativeEvent({ type: "action", key: `actions/${act}`, act, mods: [] }),
  };
}

test("preview describes a glass sheet listing repo-relative files between Write and Cancel", () => {
  const { component, select } = preview();
  expect(component.nativeOverlay).toMatchObject({ role: "omp.overlay.roadmap.preview", size: "lg", anchor: "center" });
  const root = component.describe();
  const labels = items(root).map((entry) => plain(props(entry).label));
  expect(labels).toHaveLength(4);
  expect(labels[0]).toMatch(/Write 2 files/);
  expect(labels.slice(1, 3)).toEqual(["docs/roadmap/R3/README.md", "docs/roadmap/R3/notes.txt"]);
  expect(labels[3]).toMatch(/Cancel/);
  expect(plain(byKey(root, "body").node)).toMatch(/docs\/roadmap\/R3\/README\.md/);

  select(1);
  const markdown = byKey(component.describe(), "body").node;
  expect(walk(markdown).some(({ node }) => node.k === "md")).toBe(true);
  expect(buttons(component.describe()).has("raw")).toBe(true);
  component.handleNativeEvent({ type: "action", key: "actions/raw", act: "raw", mods: [] });
  const raw = byKey(component.describe(), "body").node;
  expect(walk(raw).some(({ node }) => node.k === "md")).toBe(false);
  expect(walk(raw).some(({ node }) => node.k === "code")).toBe(true);

  select(2);
  const text = walk(byKey(component.describe(), "body").node).find(({ node }) => node.k === "code")?.node;
  expect(props(text as NativeNode)).toMatchObject({ text: "plain\n  indented line", path: `${ROOT}/docs/roadmap/R3/notes.txt` });
});

test("preview native events answer like the keys, once", () => {
  const write = preview();
  write.select(0, "activate");
  write.act("cancel");
  expect(write.answers).toEqual([true]);

  const cancel = preview();
  cancel.select(3, "activate");
  expect(cancel.answers).toEqual([false]);

  const button = preview();
  button.act("write");
  expect(button.answers).toEqual([true]);

  const onFile = preview();
  onFile.select(1, "activate");
  expect(onFile.answers).toEqual([]);
  expect(plain(byKey(onFile.component.describe(), "message").node)).toMatch(/writes every file/);
  onFile.act("cancel");
  expect(onFile.answers).toEqual([false]);
});

test("preview describe returns the same node until the selection or view changes", () => {
  const { component, select } = preview();
  const first = component.describe();
  expect(component.describe()).toBe(first);
  select(1);
  const second = component.describe();
  expect(second).not.toBe(first);
  expect(component.describe()).toBe(second);
  select(1);
  expect(component.describe()).toBe(second);
});
