import type { Run, Snapshot } from "../src/model.ts";
import type { ViewState } from "../src/persisted.ts";
import {
  currentRun,
  type DagFrame,
  layoutOptions,
  nodeOrder,
  nodeTasks,
  runLayout,
  selectedNode,
  selectedTask,
  taskOrder,
  type UiState,
  visibleRuns,
} from "./render.ts";

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
  | "edges"
  | "mode"
  | "previousRun"
  | "nextRun"
  | "open"
  | "escape"
  | "help";

/** Mouse input in 0-based screen cells; the wheel reports one notch per event. */
export type Mouse = { type: "click"; x: number; y: number } | { type: "wheel"; dx: number; dy: number };
export type Input = Key | Mouse;

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
  e: "edges",
  "\t": "mode",
  "[": "previousRun",
  "]": "nextRun",
  o: "open",
  "?": "help",
  "\r": "enter",
  "\n": "enter",
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences are parsed here.
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/y;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences are parsed here.
const UNKNOWN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/y;
/** A CSI or mouse report cut off by the end of a read. A lone ESC is the Escape key and is never held back. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences are parsed here.
const PARTIAL = /\x1b\[<?[\d;]*$/;
const MAX_PARTIAL = 32;

/** Decodes an SGR (1006) report: left press clicks, wheel notches scroll; releases, motion and other buttons are dropped. */
function decodeMouse(button: number, column: number, row: number, press: boolean): Mouse | undefined {
  // Bit 32 marks motion, 128 the extra buttons 8–11.
  if (!press || button & 160) return undefined;
  if (button & 64) {
    const direction = button & 3;
    if (direction >= 2) return { type: "wheel", dx: direction === 2 ? -1 : 1, dy: 0 };
    const step = direction === 0 ? -1 : 1;
    // Shift turns the vertical wheel sideways.
    return button & 4 ? { type: "wheel", dx: step, dy: 0 } : { type: "wheel", dx: 0, dy: step };
  }
  return (button & 3) === 0 ? { type: "click", x: column - 1, y: row - 1 } : undefined;
}

/** Splits a raw stdin chunk into keys and mouse events; unknown escape sequences are swallowed whole. */
export function parseKeys(chunk: string): Input[] {
  const inputs: Input[] = [];
  let index = 0;
  while (index < chunk.length) {
    if (chunk[index] === "\x1b") {
      MOUSE.lastIndex = index;
      const mouse = MOUSE.exec(chunk);
      if (mouse) {
        const event = decodeMouse(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4] === "M");
        if (event) inputs.push(event);
        index = MOUSE.lastIndex;
        continue;
      }
      const sequence = Object.keys(SEQUENCES).find((candidate) => chunk.startsWith(candidate, index));
      if (sequence) {
        inputs.push(SEQUENCES[sequence] as Key);
        index += sequence.length;
        continue;
      }
      UNKNOWN.lastIndex = index;
      if (UNKNOWN.test(chunk)) {
        index = UNKNOWN.lastIndex;
        continue;
      }
      inputs.push("escape");
      index += 1;
      continue;
    }
    const key = CHARS[chunk[index] as string];
    if (key) inputs.push(key);
    index += 1;
  }
  return inputs;
}

/** Parses successive stdin reads; an escape sequence split across two reads is held until its final byte arrives. */
export class InputReader {
  #rest = "";

  feed(chunk: string): Input[] {
    const text = this.#rest + chunk;
    const partial = PARTIAL.exec(text);
    const cut = partial && text.length - partial.index <= MAX_PARTIAL ? partial.index : text.length;
    this.#rest = text.slice(cut);
    return parseKeys(text.slice(0, cut));
  }
}

export type Effect = { type: "quit" } | { type: "persist" } | { type: "transcript"; file?: string };
export interface InputContext {
  snapshot?: Snapshot;
  viewState: ViewState;
  ui: UiState;
  now: number;
}

/** Arrow keys pan a slice of the viewport per press; the wheel moves three rows (six columns) per notch, like most terminals. */
const panRows = (rows: number): number => Math.max(2, Math.round(rows / 8));
const panCols = (cols: number): number => Math.max(4, Math.round(cols / 6));
const WHEEL_ROWS = 3;
const WHEEL_COLS = 6;
/** Two clicks on one node within this window open its transcript. */
export const DOUBLE_CLICK_MS = 400;

function moveSelection(order: string[], current: string | undefined, delta: number): string | undefined {
  if (!order.length) return undefined;
  const index = Math.max(0, current ? order.indexOf(current) : 0);
  return order[Math.max(0, Math.min(order.length - 1, index + delta))];
}

type Direction = "up" | "down" | "left" | "right";

/**
 * The node an arrow key reaches on the drawn graph: up and down take the box nearest by centre in the previous or next
 * row of boxes, left and right the nearest box on that side of the same row. Undefined at the edge of the graph.
 */
export function spatialTarget(boxes: DagFrame["boxes"], from: string, direction: Direction): string | undefined {
  const here = boxes.get(from);
  if (!here) return undefined;
  const middle = here.x + here.w / 2;
  const vertical = direction === "up" || direction === "down";
  let row = here.y;
  if (vertical) {
    let next: number | undefined;
    for (const box of boxes.values()) {
      const beyond = direction === "down" ? box.y > here.y : box.y < here.y;
      if (beyond && (next === undefined || (direction === "down" ? box.y < next : box.y > next))) next = box.y;
    }
    if (next === undefined) return undefined;
    row = next;
  }
  let best: { id: string; distance: number; x: number } | undefined;
  for (const [id, box] of boxes) {
    if (id === from || box.y !== row) continue;
    const offset = box.x + box.w / 2 - middle;
    if (!vertical && (direction === "left" ? offset >= 0 : offset <= 0)) continue;
    const distance = Math.abs(offset);
    // Equal distances go to the left box so walks stay deterministic.
    if (!best || distance < best.distance || (distance === best.distance && box.x < best.x)) best = { id, distance, x: box.x };
  }
  return best?.id;
}

/** Moves the DAG viewport and detaches it from the selection; the last frame's canvas bounds the move. */
function pan(ui: UiState, frame: DagFrame | undefined, dx: number, dy: number): void {
  ui.follow = false;
  const maxX = frame ? Math.max(0, frame.width - frame.cols) : Number.POSITIVE_INFINITY;
  const maxY = frame ? Math.max(0, frame.height - frame.rows) : Number.POSITIVE_INFINITY;
  ui.scrollX = Math.max(0, Math.min(maxX, ui.scrollX + dx));
  ui.scrollY = Math.max(0, Math.min(maxY, ui.scrollY + dy));
}

/** Leaving a view or run starts the next one at its origin, following the selection. */
function resetViewport(ui: UiState): void {
  ui.scrollX = 0;
  ui.scrollY = 0;
  ui.follow = true;
}

/** Applies one key to the view state (persisted) and UI state (in memory); returns side effects for the process. */
export function handleKey(context: InputContext, key: Key): Effect[] {
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
      resetViewport(ui);
      return [{ type: "persist" }];
    }
    if (!view) return [];
    const step = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -page : key === "pagedown" ? page : 0;
    if (step) scrollTranscript(ui, step);
    return [];
  }

  switch (key) {
    case "toggle":
      viewState.view = viewState.view === "dag" ? "tasks" : "dag";
      resetViewport(ui);
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
    if (delta) {
      ui.taskId = moveSelection(ids, current?.id, delta);
      ui.follow = true;
    }
    if (key === "enter" && current) toggle(ui.expanded, current.id);
    if (key === "open" && current) return openTranscript(viewState, ui, current.id, current.sessionFile, "tasks");
    return [];
  }

  // DAG view.
  const run = currentRun(snapshot, viewState, ui);
  switch (key) {
    case "previousRun":
    case "nextRun":
      return switchRun(context, run, key === "previousRun" ? -1 : 1);
    case "mode":
      ui.dagMode = ui.dagMode === "nodes" ? "pan" : "nodes";
      return [];
    case "edges":
      ui.allEdges = !ui.allEdges;
      return [];
  }
  if (!run) return [];
  if (key === "fold") {
    viewState.folded = viewState.folded.includes(run.id) ? viewState.folded.filter((id) => id !== run.id) : [...viewState.folded, run.id];
    return [{ type: "persist" }];
  }
  // Geometry of the last drawn frame, when it shows this run.
  const frame = ui.dagFrame?.runId === run.id ? ui.dagFrame : undefined;
  if (ui.dagMode === "pan") {
    const rows = frame?.rows ?? ui.bodyRows;
    const cols = frame?.cols ?? ui.bodyCols;
    const moves: Partial<Record<Key, [number, number]>> = {
      up: [0, -panRows(rows)],
      down: [0, panRows(rows)],
      left: [-panCols(cols), 0],
      right: [panCols(cols), 0],
      pageup: [0, -page],
      pagedown: [0, page],
    };
    const move = moves[key];
    if (move) {
      pan(ui, frame, ...move);
      return [];
    }
  }
  const layout = runLayout(run, viewState, context.now, ui.bodyCols, layoutOptions(snapshot, ui));
  const selected = selectedNode(run, layout, ui);
  if (key === "up" || key === "down" || key === "left" || key === "right") {
    // Before the first frame (or right after a run switch) there is no drawn geometry; walk the layout order instead.
    const next =
      selected && frame?.boxes.has(selected)
        ? spatialTarget(frame.boxes, selected, key)
        : moveSelection(nodeOrder(layout), selected, key === "up" || key === "left" ? -1 : 1);
    if (next) ui.selected.set(run.id, next);
    ui.follow = true;
    return [];
  }
  if (key === "pageup" || key === "pagedown") {
    const nodePage = Math.max(1, Math.floor(ui.bodyRows / 6));
    const next = moveSelection(nodeOrder(layout), selected, key === "pageup" ? -nodePage : nodePage);
    if (next) ui.selected.set(run.id, next);
    ui.follow = true;
    return [];
  }
  if (key === "enter" && selected) toggle(ui.expanded, selected);
  if (key === "open" && selected) return openNode(context, run, selected);
  return [];
}

/** Wheel scrolls whatever the view shows (the DAG pans in either mode); a click selects a node, a double click opens it. */
export function handleMouse(context: InputContext, mouse: Mouse): Effect[] {
  const { snapshot, viewState, ui } = context;
  if (ui.help) return [];
  if (viewState.view === "transcript") {
    if (mouse.type === "wheel" && mouse.dy) scrollTranscript(ui, mouse.dy * WHEEL_ROWS);
    return [];
  }
  if (viewState.view === "tasks") {
    if (mouse.type === "wheel" && mouse.dy) {
      // The renderer clamps the list and stops pulling the selected card into view until the selection moves.
      ui.follow = false;
      ui.scrollY = Math.max(0, ui.scrollY + mouse.dy * WHEEL_ROWS);
    }
    return [];
  }
  const run = currentRun(snapshot, viewState, ui);
  if (!run) return [];
  const frame = ui.dagFrame?.runId === run.id ? ui.dagFrame : undefined;
  if (mouse.type === "wheel") {
    pan(ui, frame, mouse.dx * WHEEL_COLS, mouse.dy * WHEEL_ROWS);
    return [];
  }
  if (!frame) return [];
  // Map the screen cell through the viewport the last frame was drawn with.
  const row = mouse.y - frame.top;
  if (row < 0 || row >= frame.rows || mouse.x < 0 || mouse.x >= frame.cols) return [];
  const x = mouse.x + frame.scrollX;
  const y = row + frame.scrollY;
  let hit: string | undefined;
  for (const [id, box] of frame.boxes) if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) hit = id;
  if (!hit) return [];
  const double = ui.lastClick?.id === hit && context.now - ui.lastClick.at <= DOUBLE_CLICK_MS;
  ui.lastClick = double ? undefined : { id: hit, at: context.now };
  ui.selected.set(run.id, hit);
  ui.follow = true;
  return double ? openNode(context, run, hit) : [];
}

export function handleInput(context: InputContext, input: Input): Effect[] {
  return typeof input === "string" ? handleKey(context, input) : handleMouse(context, input);
}

function scrollTranscript(ui: UiState, step: number): void {
  const view = ui.transcript;
  if (!view) return;
  view.scroll = Math.max(0, view.scroll + step);
  // The renderer re-enables following once the scroll reaches the end.
  view.follow = false;
}

function switchRun(context: InputContext, run: Run | undefined, delta: number): Effect[] {
  const { snapshot, viewState, ui } = context;
  const runs = visibleRuns(snapshot, ui.history);
  if (!runs.length) return [];
  const index = Math.max(
    0,
    runs.findIndex((item) => item.id === run?.id),
  );
  const next = runs[Math.max(0, Math.min(runs.length - 1, index + delta))];
  if (!next || next.id === run?.id) return [];
  viewState.selectedRun = next.id;
  resetViewport(ui);
  return [{ type: "persist" }];
}

/** Opens the running (else the newest) child transcript attached to a node. */
function openNode(context: InputContext, run: Run, id: string): Effect[] {
  const tasks = context.snapshot?.tasks ?? [];
  const node = run.nodes.find((item) => item.id === id);
  const linked = node ? nodeTasks(node, tasks) : [];
  const task = linked.find((item) => item.status === "running") ?? linked[0];
  return task ? openTranscript(context.viewState, context.ui, task.id, task.sessionFile, "dag") : [];
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
