import { beforeAll, expect, test } from "bun:test";

import { type DescribeContext, initTheme, type NativeChild, type NativeNode, type NativeUiEvent, type TUI, theme } from "@oh-my-pi/pi-tui";

import type { AtlasLive, AtlasLiveRow, AtlasLiveSnapshot, AtlasProgress } from "../plugins/omo-prometheus/src/atlas-live.ts";
import {
  AtlasMenu,
  type AtlasMenuAction,
  AtlasPlanView,
  type AtlasPlanViewAction,
  type AtlasPlanViewMode,
} from "../plugins/omo-prometheus/src/atlas-menu.ts";
import type { AtlasPlanDetail } from "../plugins/omo-prometheus/src/atlas-store.ts";
import { AtlasStatusWidget } from "../plugins/omo-prometheus/src/atlas-widget.ts";

beforeAll(async () => {
  await initTheme();
});

const cx: DescribeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => false };
const tui = { requestRender() {}, terminal: { rows: 30 } } as unknown as TUI;

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

function menu(details = [plan]): { component: AtlasMenu; actions: AtlasMenuAction[] } {
  const actions: AtlasMenuAction[] = [];
  return { component: new AtlasMenu(details, "unfinished", "", theme, tui, (action) => actions.push(action)), actions };
}

function view(detail = plan, mode: AtlasPlanViewMode = "dispatch") {
  const actions: AtlasPlanViewAction[] = [];
  const reads: Promise<string>[] = [];
  const component = new AtlasPlanView(
    detail,
    mode,
    theme,
    tui,
    (file) => {
      const read = Promise.resolve(`child says ${file} is green`);
      reads.push(read);
      return read;
    },
    (action) => actions.push(action),
  );
  return { component, actions, reads };
}

function nodes(root: NativeChild, out: NativeNode[] = []): NativeNode[] {
  if (!("k" in root)) return out;
  out.push(root);
  for (const entry of root.c ?? []) nodes(entry, out);
  return out;
}

const find = (root: NativeNode, key: string): NativeNode | undefined => nodes(root).find((entry) => entry.key === key);
const kinds = (root: NativeNode, kind: string): NativeNode[] => nodes(root).filter((entry) => entry.k === kind);
const shown = (described: NativeNode | undefined): string => JSON.stringify(described ?? null);
const action = (act: string): NativeUiEvent => ({ type: "action", key: `tools/actions/${act}`, act, mods: [] });

test("Atlas plan view describes a large sheet titled by the plan with toned rows, progress and the selected row", () => {
  const { component } = view();
  expect(component.nativeOverlay).toMatchObject({ role: "omp.overlay.omoPrometheus.plan", size: "lg", head: "North" });
  expect(component.nativeOverlay).toBe(component.nativeOverlay);
  const root = component.describe(cx);
  const rows = find(root, "rows");
  expect(rows?.p).toMatchObject({ selected: "r0" });
  expect(rows?.c?.map((entry) => ("k" in entry ? entry.p : undefined))).toMatchObject([{ tone: "success" }, { tone: "muted" }]);
  expect(kinds(root, "progress")[0]?.p).toMatchObject({ value: 0.5 });
  expect(kinds(root, "md").map((entry) => entry.p)).toMatchObject([{ text: "build is green" }, { text: "The build passes" }]);
  expect(component.describe(cx)).toBe(root);
});

test("Atlas plan view describes an amended row's ruling in force with the approved text, and lists every ruling", () => {
  const amended: AtlasPlanDetail = {
    ...plan,
    rulings: [{ id: "R1", rowId: "T1", acceptance: "The build passes in 120 s", note: "User accepted 120 s", confirmedAt: 0 }],
  };
  const root = view(amended).component.describe(cx);
  expect(shown(find(root, "rulings"))).toContain("R1 T1");
  const acceptance = find(root, "acceptance");
  expect(shown(acceptance)).toContain("amended by R1");
  expect(kinds(root, "md").at(-1)?.p).toMatchObject({ text: "The build passes in 120 s" });
  expect(shown(acceptance)).toContain("User accepted 120 s");
  expect(shown(acceptance)).toMatch(/Approved plan: .*The build passes"/);
  expect(find(view().component.describe(cx), "rulings")).toBeUndefined();
});

test("Atlas plan view row clicks and view tabs change it exactly as the arrow and Tab keys", () => {
  const keys = view();
  const clicks = view();
  const before = clicks.component.describe(cx);
  keys.component.handleInput("\x1b[B");
  clicks.component.handleNativeEvent({ type: "select", key: "split/sidebar/rows", item: "r1" });
  const after = clicks.component.describe(cx);
  expect(after).not.toBe(before);
  expect(find(after, "rows")?.p).toMatchObject({ selected: "r1" });
  expect(shown(find(after, "body"))).toContain("Approved");
  expect(after).toEqual(keys.component.describe(cx));

  keys.component.handleInput("\t");
  clicks.component.handleNativeEvent({ type: "select", key: "tools/view", item: "timeline" });
  const timeline = clicks.component.describe(cx);
  expect(find(timeline, "view")?.p).toMatchObject({ active: "timeline" });
  expect(shown(find(timeline, "body"))).toContain("verify passed");
  expect(timeline).toEqual(keys.component.describe(cx));
});

test("Atlas plan view buttons dispatch, refuse and close exactly like their keys", () => {
  const keys = view();
  const buttons = view();
  keys.component.handleInput("\r");
  buttons.component.handleNativeEvent(action("start"));
  expect(buttons.actions).toEqual(["start"]);
  expect(buttons.actions).toEqual(keys.actions);

  const refused = view(busy);
  refused.component.handleNativeEvent(action("resume"));
  expect(refused.actions).toEqual([]);
  expect(shown(find(refused.component.describe(cx), "notice"))).toMatch(/another session/);

  const back = view();
  back.component.handleNativeEvent(action("exit"));
  back.component.handleNativeEvent(action("back"));
  expect(back.actions).toEqual(["back"]);

  const active = view(plan, "active");
  active.component.handleNativeEvent(action("start"));
  active.component.handleNativeEvent(action("exit"));
  expect(active.actions).toEqual(["exit"]);
});

test("Atlas plan view opens and closes the archived child output from its disclosure as Space does", async () => {
  const { component, reads } = view();
  expect(find(component.describe(cx), "output")?.p).toMatchObject({ collapsed: true });
  component.handleNativeEvent({ type: "toggle", key: "split/body/output", collapsed: false });
  expect(reads).toHaveLength(1);
  await reads[0];
  const open = find(component.describe(cx), "output");
  expect(open?.p).toMatchObject({ collapsed: false });
  expect(shown(open)).toContain("child says /bundle/evidence/r1.md is green");
  component.handleNativeEvent({ type: "toggle", key: "split/body/output", collapsed: true });
  expect(find(component.describe(cx), "output")?.p).toMatchObject({ collapsed: true });
  component.handleInput(" ");
  expect(find(component.describe(cx), "output")?.p).toMatchObject({ collapsed: false });
  expect(reads).toHaveLength(1);
});

test("Atlas plan view keeps its description across clock ticks and rebuilds when the child reports", () => {
  const source = liveSource(running, new Map([["T1", child]]));
  const component = new AtlasPlanView(
    running,
    "active",
    theme,
    tui,
    async () => "",
    () => undefined,
    source.live,
  );
  const first = component.describe(cx);
  expect(shown(find(first, "live"))).toContain("bash");
  expect(kinds(first, "elapsed").length).toBeGreaterThan(0);
  source.tick();
  expect(component.describe(cx)).toBe(first);
  source.tick({ rows: reported });
  const next = component.describe(cx);
  expect(next).not.toBe(first);
  expect(shown(find(next, "live"))).toContain("edit");
});

test("Atlas Dispatch describes a sheet with filter tabs, the searchable plan list and the highlighted plan", () => {
  const { component } = menu();
  expect(component.nativeOverlay).toMatchObject({ role: "omp.overlay.omoPrometheus.dispatch", size: "lg" });
  const root = component.describe(cx);
  expect(find(root, "filter")?.p).toMatchObject({ active: "unfinished" });
  expect(find(root, "plans")?.p).toMatchObject({ selected: plan.plan.id });
  expect(find(root, "plans")?.c).toHaveLength(1);
  const preview = find(root, "preview") as NativeNode;
  expect(kinds(preview, "checklist")).toHaveLength(1);
  expect(kinds(preview, "progress")[0]?.p).toMatchObject({ value: 0.5 });
  expect(component.describe(cx)).toBe(root);
  component.handleInput("z");
  const searched = component.describe(cx);
  expect(searched).not.toBe(root);
  expect(find(searched, "plans")?.c).toHaveLength(0);
});

test("Atlas Dispatch filter tabs, plan clicks and buttons run the same actions as the keys", () => {
  const keys = menu([plan, south]);
  const pointer = menu([plan, south]);
  keys.component.handleInput("\x1b[B");
  pointer.component.handleNativeEvent({ type: "select", key: "plans", item: south.plan.id });
  expect(find(pointer.component.describe(cx), "plans")?.p).toMatchObject({ selected: south.plan.id });
  const kindsInOrder = ["start", "inspect", "resume", "rename", "delete"];
  for (const act of kindsInOrder) pointer.component.handleNativeEvent(action(act));
  for (const key of ["\r", " ", "R", "N", "\x1b[3~"]) keys.component.handleInput(key);
  expect(pointer.actions.map((entry) => [entry.kind, entry.planId])).toEqual(kindsInOrder.map((kind) => [kind, south.plan.id]));
  expect(pointer.actions).toEqual(keys.actions);

  const opened = menu();
  opened.component.handleNativeEvent({ type: "activate", key: "plans", item: plan.plan.id });
  expect(opened.actions).toMatchObject([{ kind: "inspect", planId: plan.plan.id }]);

  const tabbed = menu();
  const clicked = menu();
  tabbed.component.handleInput("\t");
  clicked.component.handleNativeEvent({ type: "select", key: "head/filter", item: "all" });
  expect(find(clicked.component.describe(cx), "filter")?.p).toMatchObject({ active: "all" });
  expect(clicked.component.describe(cx)).toEqual(tabbed.component.describe(cx));
  clicked.component.handleNativeEvent(action("start"));
  expect(clicked.actions).toEqual([]);
  expect(shown(find(clicked.component.describe(cx), "notice"))).toMatch(/display-only/);
  clicked.component.handleNativeEvent(action("cancel"));
  expect(clicked.actions).toMatchObject([{ kind: "cancel", filter: "all" }]);
});

test("Atlas widget describes native progress and the running rows, rebuilding only when the snapshot changes", () => {
  const source = liveSource({ ...running, rows: running.rows.slice(0, 2) }, new Map([["T1", child]]));
  const widget = new AtlasStatusWidget(source.live, tui, theme);
  const first = widget.describe(cx);
  expect(kinds(first, "progress")[0]?.p).toMatchObject({ value: 0 });
  expect(shown(find(first, "T1"))).toContain("bash");
  expect(find(first, "T2")).toBeDefined();
  source.tick();
  expect(widget.describe(cx)).toBe(first);
  source.tick({ rows: reported });
  const next = widget.describe(cx);
  expect(next).not.toBe(first);
  expect(shown(find(next, "T1"))).toContain("edit");

  const crowded = new AtlasStatusWidget(liveSource(running, new Map()).live, tui, theme).describe(cx);
  expect(["T1", "T2", "T3", "T4"].every((id) => find(crowded, id))).toBe(true);
  expect(find(crowded, "T5")).toBeUndefined();
  expect(shown(find(crowded, "more"))).toContain("+3");
});
