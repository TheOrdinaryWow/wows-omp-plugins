import { afterAll, beforeAll, expect, test } from "bun:test";

import { setNativeRenderingForTest, signal, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";

import type { AtlasLive, AtlasLiveRow, AtlasLiveSnapshot, AtlasProgress } from "../plugins/omo-prometheus/src/atlas-live.ts";
import {
  AtlasMenu,
  type AtlasMenuAction,
  AtlasPlanView,
  type AtlasPlanViewAction,
  type AtlasPlanViewMode,
} from "../plugins/omo-prometheus/src/atlas-menu.ts";
import type { AtlasPlanDetail } from "../plugins/omo-prometheus/src/atlas-store.ts";
import { atlasStatusWidget } from "../plugins/omo-prometheus/src/atlas-widget.ts";

// Tern: every view is built while the host renders natively, as a Tern pane does.
beforeAll(() => setNativeRenderingForTest(true));
afterAll(() => setNativeRenderingForTest(false));

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
  timeline: [{ version: 1, at: 0, kind: "verify_passed", row: "T1", sessionId: "session-a", detail: "build is green" }],
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
const busy: AtlasPlanDetail = { ...plan, status: "In use by another session (1/2)", enterable: false, inUse: true };
const south: AtlasPlanDetail = { ...plan, plan: { ...plan.plan, id: "south--00000000-0000-0000-0000-000000000002", name: "South" } };

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
  currentToolArgs: "bun test",
  currentToolStartMs: 50_000,
  lastIntent: "Running tests",
  recentTools: [],
  recentOutput: [],
  toolCount: 5,
  requests: 3,
  tokens: 12_345,
  cost: 0.5,
} as unknown as AtlasProgress;
const child: AtlasLiveRow = { attempt: "attempt-1", childAgentId: "child-1", status: "running", progress };
const reported = new Map([["T1", { ...child, progress: { ...progress, currentTool: "edit" } as AtlasProgress }]]);

/** An observation whose ticks repeat the last state with a later clock unless told otherwise, as AtlasLive's tick does. */
function liveSource(detail: AtlasPlanDetail, rows: Map<string, AtlasLiveRow>) {
  let snapshot: AtlasLiveSnapshot = { detail, rows, at: 60_000, runningChildren: rows.size };
  const listeners = new Set<(next: AtlasLiveSnapshot) => void>();
  const live = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: AtlasLiveSnapshot) => void) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
  } as unknown as AtlasLive;
  const tick = (next: Partial<AtlasLiveSnapshot> = {}): void => {
    snapshot = { ...snapshot, rows: new Map(snapshot.rows), at: snapshot.at + 1_000, ...next };
    for (const listener of listeners) listener(snapshot);
  };
  return { live, tick };
}

/** Every node under `root` (itself included), depth first. */
function nodes(root: UiNode, out: UiNode[] = []): UiNode[] {
  out.push(root);
  for (const child of root.children()) nodes(child, out);
  return out;
}
const find = (root: UiNode, key: string): UiNode | undefined => nodes(root).find((entry) => entry.key() === key);
const kinds = (root: UiNode, kind: string): UiNode[] => nodes(root).filter((entry) => entry.kind === kind);
const props = (node: UiNode | undefined): Record<string, unknown> => (node?.props() ?? {}) as Record<string, unknown>;
/** What a node and its subtree carry, as one string to search. */
const tree = (node: UiNode): unknown => [node.kind, node.key(), node.props(), node.children().map(tree)];
const shown = (node: UiNode | undefined): string => (node ? JSON.stringify(tree(node)) : "null");

function send(node: UiNode, event: UiEvent): void {
  node.handlers.onEvent?.(event);
}
const action = (act: string, value?: string): UiEvent => ({
  type: "action",
  key: `tools/actions/${act}`,
  act,
  mods: [],
  ...(value ? { value } : {}),
});
const key = (id: string, text?: string) => ({ id, kind: "press" as const, raw: text ?? "", ...(text ? { text } : {}) });

function menu(details = [plan]): { root: UiNode; picker: UiNode; actions: AtlasMenuAction[] } {
  const actions: AtlasMenuAction[] = [];
  const root = new AtlasMenu(details, "unfinished", "", (entry) => actions.push(entry)).view();
  return { root, picker: root, actions };
}

function view(detail = plan, mode: AtlasPlanViewMode = "dispatch", size = signal({ columns: 120, rows: 30 }), live?: AtlasLive) {
  const actions: AtlasPlanViewAction[] = [];
  const reads: Promise<string>[] = [];
  const component = new AtlasPlanView(
    detail,
    mode,
    (file) => {
      const read = Promise.resolve(`child says ${file} is green`);
      reads.push(read);
      return read;
    },
    (entry) => actions.push(entry),
    live,
    size,
  );
  const root = component.view();
  return { root, screen: root.children()[0] as UiNode, actions, reads, component };
}

test("Atlas Dispatch is a bare picker root, the sheet Tern draws, with filter tabs, searchable plans and the highlighted plan", () => {
  const { root, picker } = menu();
  expect(root.kind).toBe("picker");
  expect(props(root)).toMatchObject({ title: "Atlas Dispatch", size: "lg" });
  expect(picker.kind).toBe("picker");
  expect(props(picker)).toMatchObject({ tab: "unfinished", selected: plan.plan.id, query: "" });
  expect(props(picker).items).toMatchObject([{ id: plan.plan.id, label: "North", facts: { progress: 0.5, count: "1/2" } }]);
  expect(props(picker).actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "start", keys: ["enter"] })]));
  const preview = find(picker, "preview") as UiNode;
  expect(kinds(preview, "checklist")).toHaveLength(1);
  expect(props(kinds(preview, "progress")[0])).toMatchObject({ value: 0.5 });
  picker.handlers.onKey?.(key("z", "z"));
  expect(props(picker)).toMatchObject({ query: "z", items: [], selected: null, empty: "No plans match the search" });
});

test("Atlas Dispatch tab clicks, plan clicks and buttons run the same actions as the keys", () => {
  const keys = menu([plan, south]);
  const pointer = menu([plan, south]);
  keys.picker.handlers.onKey?.(key("down"));
  send(pointer.picker, { type: "select", key: "picker", item: south.plan.id });
  expect(props(pointer.picker)).toMatchObject({ selected: south.plan.id });
  const kindsInOrder = ["start", "inspect", "resume", "rename", "delete"];
  for (const act of kindsInOrder) send(pointer.picker, action(act));
  for (const id of ["enter", "space", "shift+r", "shift+n", "delete"]) keys.picker.handlers.onKey?.(key(id));
  expect(pointer.actions.map((entry) => [entry.kind, entry.planId])).toEqual(kindsInOrder.map((kind) => [kind, south.plan.id]));
  expect(pointer.actions).toEqual(keys.actions);

  const opened = menu();
  send(opened.picker, { type: "activate", key: "picker", item: plan.plan.id });
  expect(opened.actions).toMatchObject([{ kind: "inspect", planId: plan.plan.id }]);

  const tabbed = menu();
  const clicked = menu();
  tabbed.picker.handlers.onKey?.(key("tab"));
  send(clicked.picker, action("tab", "all"));
  expect(props(clicked.picker)).toMatchObject({ tab: "all" });
  expect(props(clicked.picker)).toEqual(props(tabbed.picker));
  send(clicked.picker, action("start"));
  expect(clicked.actions).toEqual([]);
  // A ready picker in Tern shows its subtitle, not its message.
  expect(JSON.stringify(props(clicked.picker).subtitle)).toMatch(/display-only/);
  send(clicked.picker, action("cancel"));
  expect(clicked.actions).toMatchObject([{ kind: "cancel", filter: "all" }]);

  const searched = menu();
  searched.picker.handlers.onKey?.(key("z", "z"));
  expect(props(searched.picker)).toMatchObject({ query: "z", items: [] });
  send(searched.picker, action("clear"));
  expect(props(searched.picker)).toMatchObject({ query: "", selected: plan.plan.id });
  expect(searched.actions).toEqual([]);
});

test("Atlas plan view is a large sheet titled by the plan with toned rows, progress and the selected row", () => {
  const { root } = view();
  expect(root.kind).toBe("overlay");
  expect(props(root)).toMatchObject({ role: "omp.overlay.omoPrometheus.plan", size: "lg", head: "North" });
  const rows = find(root, "rows");
  expect(props(rows)).toMatchObject({ selected: "r0" });
  expect(rows?.children().map((entry) => props(entry))).toMatchObject([{ tone: "success" }, { tone: "muted" }]);
  expect(props(kinds(root, "progress")[0])).toMatchObject({ value: 0.5 });
  expect(kinds(root, "md").map((entry) => props(entry).text)).toEqual(["build is green", "The build passes"]);
  expect(find(root, "title")).toBeUndefined();
  expect(find(root, "body-scroll")?.kind).toBe("list");
});

test("Atlas plan view keeps the whole body in Tern's scroller and forwards the scroll keys to it", () => {
  const long: AtlasPlanDetail = {
    ...plan,
    rows: plan.rows.map((row) =>
      row.id === "T1" ? { ...row, acceptance: Array.from({ length: 60 }, (_, index) => `- criterion ${index}`).join("\n") } : row,
    ),
    timeline: Array.from({ length: 40 }, (_, index) => ({
      version: 1 as const,
      at: index,
      kind: "started" as const,
      row: `T${index}`,
      sessionId: "s",
    })),
  };
  const { root, screen } = view(long);
  const content = (): UiNode | undefined => find(root, "content");
  expect(content()?.scroll()).toBeUndefined();
  const keys = [
    ["pageDown", "page-down"],
    ["pageUp", "page-up"],
    ["pageDown", "page-down"],
  ] as const;
  for (const [index, [id, by]] of keys.entries()) {
    screen.handlers.onKey?.(key(id));
    // Tern moves the scroller above the node carrying the request, so it rides on the scroller's content.
    expect(content()?.scroll()).toEqual({ by, n: index + 1 });
    // Nothing is cut from the start: the rows above the viewport stay reachable by scrolling back.
    expect(shown(content())).toContain("T1  Build");
    expect(shown(content())).toContain("criterion 59");
  }
  screen.handlers.onKey?.(key("tab"));
  for (const [id, by] of [
    ["end", "end"],
    ["home", "start"],
    ["down", "line-down"],
    ["up", "line-up"],
  ] as const) {
    screen.handlers.onKey?.(key(id));
    expect(content()?.scroll()).toMatchObject({ by });
    expect(shown(content())).toContain("T39");
    expect(shown(content())).toContain('T0"');
  }
});

test("Atlas plan view keeps a fixed sheet extent that follows the terminal height", () => {
  const size = signal({ columns: 120, rows: 30 });
  const { screen } = view(plan, "dispatch", size);
  expect(props(screen).min).toEqual({ h: "22lines" });
  expect(props(screen).max).toEqual(props(screen).min);
  size.set({ columns: 120, rows: 40 });
  expect(props(screen).min).toEqual({ h: "32lines" });
  expect(props(screen).max).toEqual(props(screen).min);
  size.set({ columns: 120, rows: 10 });
  expect(props(screen).min).toEqual({ h: "16lines" });
});

test("Atlas plan view amended row shows the ruling in force with the approved text, and lists every ruling", () => {
  const amended: AtlasPlanDetail = {
    ...plan,
    rulings: [
      { id: "R1", rowId: "T1", acceptance: "The build passes in 120 s", note: "User accepted 120 s", confirmedAt: 0, decidedBy: "user" },
    ],
  };
  const { root } = view(amended);
  expect(shown(find(root, "rulings"))).toContain("R1 T1");
  const body = shown(find(root, "body"));
  expect(body).toContain("amended by R1");
  expect(kinds(root, "md").at(-1)?.props()).toMatchObject({ text: "The build passes in 120 s" });
  expect(body).toContain("User accepted 120 s");
  expect(body).toMatch(/Approved plan.*The build passes"/);
  expect(find(view().root, "rulings")).toBeUndefined();
});

test("Atlas plan view row clicks and view tabs change it exactly as the arrow and Tab keys", () => {
  const keys = view();
  const clicks = view();
  keys.screen.handlers.onKey?.(key("down"));
  send(clicks.screen, { type: "select", key: "split/sidebar/rows", item: "r1" });
  expect(props(find(clicks.root, "rows"))).toMatchObject({ selected: "r1" });
  expect(shown(find(clicks.root, "body"))).toContain("Approved");
  expect(shown(find(clicks.root, "split"))).toEqual(shown(find(keys.root, "split")));

  keys.screen.handlers.onKey?.(key("tab"));
  send(clicks.screen, { type: "select", key: "tools/view", item: "timeline" });
  expect(props(find(clicks.root, "view"))).toMatchObject({ active: "timeline" });
  expect(shown(find(clicks.root, "body"))).toContain("verify passed");
  expect(shown(find(clicks.root, "split"))).toEqual(shown(find(keys.root, "split")));
});

test("Atlas plan view buttons dispatch, refuse and close exactly like their keys", () => {
  const keys = view();
  const buttons = view();
  keys.screen.handlers.onKey?.(key("enter"));
  send(buttons.screen, action("start"));
  expect(buttons.actions).toEqual(["start"]);
  expect(buttons.actions).toEqual(keys.actions);
  expect(props(find(buttons.root, "start"))).toMatchObject({ actions: { click: "start" }, keys: ["enter"] });

  const refused = view(busy);
  send(refused.screen, action("resume"));
  expect(refused.actions).toEqual([]);
  expect(shown(find(refused.root, "notice"))).toMatch(/another session/);

  const back = view();
  send(back.screen, action("exit"));
  send(back.screen, action("back"));
  expect(back.actions).toEqual(["back"]);

  const active = view(plan, "active");
  send(active.screen, action("start"));
  send(active.screen, action("exit"));
  expect(active.actions).toEqual(["exit"]);
});

test("Atlas plan view opens and closes the archived child output from its disclosure as Space does", async () => {
  const { root, screen, reads } = view();
  expect(props(find(root, "output"))).toMatchObject({ collapsed: true });
  send(screen, { type: "toggle", key: "split/body/body-scroll/content/output", collapsed: false });
  expect(reads).toHaveLength(1);
  await reads[0];
  expect(props(find(root, "output"))).toMatchObject({ collapsed: false });
  expect(shown(find(root, "body"))).toContain("child says /bundle/evidence/r1.md is green");
  send(screen, { type: "toggle", key: "split/body/body-scroll/content/output", collapsed: true });
  expect(props(find(root, "output"))).toMatchObject({ collapsed: true });
  screen.handlers.onKey?.(key("space"));
  expect(props(find(root, "output"))).toMatchObject({ collapsed: false });
  expect(reads).toHaveLength(1);
});

test("Atlas plan view leaves clock ticks to the elapsed counters and redraws when the child reports", () => {
  const source = liveSource(running, new Map([["T1", child]]));
  const { root } = view(running, "active", signal({ columns: 120, rows: 40 }), source.live);
  const before = find(root, "body");
  expect(shown(before)).toContain("bash");
  expect(kinds(root, "elapsed").length).toBeGreaterThan(0);
  source.tick();
  expect(find(root, "body")).toBe(before);
  source.tick({ rows: reported });
  const after = find(root, "body");
  expect(after).not.toBe(before);
  expect(shown(after)).toContain("edit");
});

test("Atlas widget shows the plan's progress and the running rows, redrawing only when the snapshot changes", () => {
  const source = liveSource({ ...running, rows: running.rows.slice(0, 2) }, new Map([["T1", child]]));
  const widget = atlasStatusWidget(source.live);
  const first = widget.children()[0] as UiNode;
  expect(props(kinds(first, "progress")[0])).toMatchObject({ value: 0 });
  expect(shown(find(first, "T1"))).toContain("bash");
  expect(find(first, "T2")).toBeDefined();
  source.tick();
  expect(widget.children()[0]).toBe(first);
  source.tick({ rows: reported });
  const next = widget.children()[0] as UiNode;
  expect(next).not.toBe(first);
  expect(shown(find(next, "T1"))).toContain("edit");

  const crowded = atlasStatusWidget(liveSource(running, new Map()).live);
  expect(["T1", "T2", "T3", "T4"].every((id) => find(crowded, id))).toBe(true);
  expect(find(crowded, "T5")).toBeUndefined();
  expect(shown(find(crowded, "more"))).toContain("+3");
});
