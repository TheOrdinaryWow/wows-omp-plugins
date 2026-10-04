import type { Snapshot } from "../src/model.ts";
import type { ViewState } from "../src/persisted.ts";
import { currentRun, nodeOrder, nodeTasks, runLayout, selectedNode, selectedTask, taskOrder, type UiState, visibleRuns } from "./render.ts";

export type Key =
  | "quit"
  | "toggle"
  | "history"
  | "left"
  | "right"
  | "up"
  | "down"
  | "pageup"
  | "pagedown"
  | "enter"
  | "fold"
  | "critical"
  | "open"
  | "escape"
  | "help";

const SEQUENCES: Record<string, Key> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
};
const CHARS: Record<string, Key> = {
  q: "quit",
  "\x03": "quit",
  t: "toggle",
  h: "history",
  j: "down",
  k: "up",
  c: "fold",
  p: "critical",
  o: "open",
  "?": "help",
  "\r": "enter",
  "\n": "enter",
};

/** Splits a raw stdin chunk into keys; unknown escape sequences are swallowed whole. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] === "\x1b") {
      const sequence = Object.keys(SEQUENCES).find((candidate) => chunk.startsWith(candidate, index));
      if (sequence) {
        keys.push(SEQUENCES[sequence] as Key);
        index += sequence.length;
        continue;
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences are parsed here.
      const unknown = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/.exec(chunk.slice(index));
      if (unknown) {
        index += unknown[0].length;
        continue;
      }
      keys.push("escape");
      index += 1;
      continue;
    }
    const key = CHARS[chunk[index] as string];
    if (key) keys.push(key);
    index += 1;
  }
  return keys;
}

export type Effect = { type: "quit" } | { type: "persist" } | { type: "transcript"; file?: string };
export interface KeyContext {
  snapshot?: Snapshot;
  viewState: ViewState;
  ui: UiState;
  now: number;
}

function moveSelection(order: string[], current: string | undefined, delta: number): string | undefined {
  if (!order.length) return undefined;
  const index = Math.max(0, current ? order.indexOf(current) : 0);
  return order[Math.max(0, Math.min(order.length - 1, index + delta))];
}

/** Applies one key to the view state (persisted) and UI state (in memory); returns side effects for the process. */
export function handleKey(context: KeyContext, key: Key): Effect[] {
  const { snapshot, viewState, ui } = context;
  if (key === "quit") return [{ type: "quit" }];
  if (key === "help") {
    ui.help = !ui.help;
    return [];
  }
  if (ui.help) {
    if (key === "escape") ui.help = false;
    return [];
  }
  const page = Math.max(1, Math.floor(ui.bodyRows / 2));

  if (viewState.view === "transcript") {
    const view = ui.transcript;
    if (key === "escape" || key === "toggle") {
      viewState.view = key === "toggle" ? (ui.returnView === "dag" ? "tasks" : "dag") : ui.returnView;
      ui.transcript = undefined;
      ui.scrollY = 0;
      return [{ type: "persist" }];
    }
    if (!view) return [];
    const step = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -page : key === "pagedown" ? page : 0;
    if (step) {
      view.scroll = Math.max(0, view.scroll + step);
      // The renderer re-enables following once the scroll reaches the end.
      view.follow = false;
    }
    return [];
  }

  switch (key) {
    case "toggle":
      viewState.view = viewState.view === "dag" ? "tasks" : "dag";
      ui.scrollY = 0;
      ui.scrollX = 0;
      return [{ type: "persist" }];
    case "history":
      ui.history = !ui.history;
      return [];
    case "critical":
      viewState.criticalPath = !viewState.criticalPath;
      return [{ type: "persist" }];
    case "escape":
      return [];
  }

  if (viewState.view === "tasks") {
    const tasks = taskOrder(snapshot?.tasks ?? []);
    const current = selectedTask(snapshot?.tasks ?? [], ui);
    const ids = tasks.map((task) => task.id);
    const cardPage = Math.max(1, Math.floor(ui.bodyRows / 8));
    const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -cardPage : key === "pagedown" ? cardPage : 0;
    if (delta) ui.taskId = moveSelection(ids, current?.id, delta);
    if (key === "enter" && current) toggle(ui.expanded, current.id);
    if (key === "open" && current) return openTranscript(viewState, ui, current.id, current.sessionFile, "tasks");
    return [];
  }

  // DAG view.
  const runs = visibleRuns(snapshot, ui.history);
  const run = currentRun(snapshot, viewState, ui);
  if (key === "left" || key === "right") {
    if (!runs.length) return [];
    const index = Math.max(
      0,
      runs.findIndex((item) => item.id === run?.id),
    );
    const next = runs[Math.max(0, Math.min(runs.length - 1, index + (key === "left" ? -1 : 1)))];
    if (!next || next.id === run?.id) return [];
    viewState.selectedRun = next.id;
    ui.scrollX = 0;
    ui.scrollY = 0;
    return [{ type: "persist" }];
  }
  if (!run) return [];
  if (key === "fold") {
    viewState.folded = viewState.folded.includes(run.id) ? viewState.folded.filter((id) => id !== run.id) : [...viewState.folded, run.id];
    return [{ type: "persist" }];
  }
  const layout = runLayout(run, viewState, context.now);
  const selected = selectedNode(run, layout, ui);
  const nodePage = Math.max(1, Math.floor(ui.bodyRows / 6));
  const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -nodePage : key === "pagedown" ? nodePage : 0;
  if (delta) {
    const next = moveSelection(nodeOrder(layout), selected, delta);
    if (next) ui.selected.set(run.id, next);
    return [];
  }
  if (key === "enter" && selected) toggle(ui.expanded, selected);
  if (key === "open" && selected) {
    const node = run.nodes.find((item) => item.id === selected);
    const task = node
      ? (nodeTasks(node, snapshot?.tasks ?? []).find((item) => item.status === "running") ?? nodeTasks(node, snapshot?.tasks ?? [])[0])
      : undefined;
    if (task) return openTranscript(viewState, ui, task.id, task.sessionFile, "dag");
  }
  return [];
}

function toggle(set: Set<string>, id: string): void {
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

function openTranscript(viewState: ViewState, ui: UiState, taskId: string, file: string | undefined, from: "dag" | "tasks"): Effect[] {
  ui.returnView = from;
  ui.transcript = { taskId, file, lines: [], scroll: 0, follow: true };
  viewState.view = "transcript";
  return [{ type: "persist" }, { type: "transcript", file }];
}
