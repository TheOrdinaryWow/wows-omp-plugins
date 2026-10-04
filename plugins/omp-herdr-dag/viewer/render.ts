import { type LayoutLayer, layoutRun, type RoutedEdge, type RunLayout } from "../src/layout.ts";
import { type DagNode, isTerminal, type Run, runStats, type Snapshot, sanitizeText, type TaskCard, taskTotals } from "../src/model.ts";
import type { ViewState } from "../src/persisted.ts";
import {
  BOXES,
  type BoxGlyphs,
  type ColorMode,
  connectorGlyph,
  DOWN,
  GLYPHS,
  LEFT,
  LINE_RANK,
  type LineKind,
  type Palette,
  palette,
  RESET,
  RIGHT,
  SOURCE_LABELS,
  SPACING,
  SPINNER,
  STATE_ICONS,
  STATE_TOKENS,
  type Style,
  sameStyle,
  sgr,
  UP,
} from "./theme.ts";
import type { TranscriptLine } from "./transcript.ts";

// ── Text primitives ───────────────────────────────────────────────────────────

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const textWidth = (text: string): number => Bun.stringWidth(text);
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);

/** Every piece of user or host text goes through here before it reaches the terminal. */
export function clean(text: string | undefined): string {
  return text === undefined ? "" : sanitizeText(text).replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (textWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const part of graphemes(text)) {
    const width = textWidth(part);
    if (used + width > max - 1) break;
    out += part;
    used += width;
  }
  return `${out}${GLYPHS.ellipsis}`;
}

/** Greedy word wrap; words wider than a line (and CJK runs) break between graphemes. */
export function wrap(text: string, max: number, limit = Number.POSITIVE_INFINITY): string[] {
  if (max <= 0) return [];
  const lines: string[] = [];
  let current: string[] = [];
  let used = 0;
  const flush = (parts: string[]): void => {
    lines.push(parts.join("").trimEnd());
  };
  for (const part of graphemes(text)) {
    const width = textWidth(part);
    if (!current.length && part === " ") continue;
    if (used + width > max) {
      if (part === " ") {
        flush(current);
        current = [];
        used = 0;
        continue;
      }
      const space = current.lastIndexOf(" ");
      if (space > 0) {
        flush(current.slice(0, space));
        current = current.slice(space + 1);
      } else {
        flush(current);
        current = [];
      }
      used = current.reduce((sum, item) => sum + textWidth(item), 0);
    }
    current.push(part);
    used += width;
  }
  if (current.length) flush(current);
  if (lines.length > limit) {
    const kept = lines.slice(0, limit);
    const last = kept[limit - 1] ?? "";
    kept[limit - 1] =
      textWidth(last) + 1 <= max ? `${last}${GLYPHS.ellipsis}` : truncate(`${last}${GLYPHS.ellipsis}${GLYPHS.ellipsis}`, max);
    return kept;
  }
  return lines;
}

// ── Lines ─────────────────────────────────────────────────────────────────────

export interface Segment {
  text: string;
  style?: Style;
}
export type Line = Segment[];

export const lineWidth = (line: Line): number => line.reduce((sum, segment) => sum + textWidth(segment.text), 0);

/** Clips a styled line to the terminal width; the last visible segment receives the ellipsis. */
export function clip(line: Line, cols: number): Line {
  const out: Line = [];
  let used = 0;
  for (const segment of line) {
    const width = textWidth(segment.text);
    if (used + width <= cols) {
      out.push(segment);
      used += width;
      continue;
    }
    const rest = truncate(segment.text, cols - used);
    if (rest) out.push({ text: rest, style: segment.style });
    break;
  }
  return out;
}

export function serialize(line: Line, cols: number, mode: ColorMode): string {
  let out = "";
  for (const segment of clip(line, cols)) {
    const code = sgr(segment.style, mode);
    out += code ? `${code}${segment.text}${RESET}` : segment.text;
  }
  return out;
}

const pad = (line: Line, cols: number, style?: Style): Line => {
  const fill = cols - lineWidth(line);
  return fill > 0 ? [...line, { text: " ".repeat(fill), style }] : line;
};

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return GLYPHS.missing;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return GLYPHS.missing;
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}
export function formatCost(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost)) return GLYPHS.missing;
  return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

// ── UI state ──────────────────────────────────────────────────────────────────

export interface TranscriptView {
  taskId: string;
  file?: string;
  lines: TranscriptLine[];
  scroll: number;
  follow: boolean;
}
export interface UiState {
  history: boolean;
  help: boolean;
  /** Selected node per run id. */
  selected: Map<string, string>;
  taskId?: string;
  expanded: Set<string>;
  scrollY: number;
  scrollX: number;
  /** Body height of the last frame; paging keys move by it. */
  bodyRows: number;
  transcript?: TranscriptView;
  returnView: "dag" | "tasks";
}
export const createUi = (): UiState => ({
  history: false,
  help: false,
  selected: new Map(),
  expanded: new Set(),
  scrollY: 0,
  scrollX: 0,
  bodyRows: 10,
  returnView: "dag",
});

export type LinkState = "live" | "connecting" | "lost";
export interface RenderInput {
  snapshot?: Snapshot;
  viewState: ViewState;
  ui: UiState;
  cols: number;
  rows: number;
  now: number;
  tick: number;
  mode: ColorMode;
  link: LinkState;
  finish: "close-with-omp" | "keep-open";
  ignored: number;
}

/** Runs shown as tabs: Atlas plus the current todo generation; history adds superseded generations. */
export function visibleRuns(snapshot: Snapshot | undefined, history: boolean): Run[] {
  const runs = [...(snapshot?.runs ?? [])].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (history) return runs;
  const latest = Math.max(-1, ...runs.filter((run) => run.source !== "atlas").map((run) => run.generation));
  return runs.filter((run) => run.source === "atlas" || run.generation === latest);
}

export function currentRun(snapshot: Snapshot | undefined, viewState: ViewState, ui: UiState): Run | undefined {
  const runs = visibleRuns(snapshot, ui.history);
  const chosen = runs.find((run) => run.id === viewState.selectedRun);
  if (chosen) return chosen;
  const active = runs.filter((run) => run.finishedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt);
  return active[0] ?? runs[runs.length - 1];
}

export function runLayout(run: Run, viewState: ViewState, now: number, width = SPACING.maxNode): RunLayout {
  return layoutRun(run, { foldCompleted: viewState.folded.includes(run.id), width, now });
}

/** Selection order: layers top-down, nodes left-right; folded layers are not selectable. */
export function nodeOrder(layout: RunLayout): string[] {
  return layout.layers.filter((layer) => !layer.folded).flatMap((layer) => layer.nodes.flatMap((item) => (item.node ? [item.id] : [])));
}

export function selectedNode(run: Run, layout: RunLayout, ui: UiState): string | undefined {
  const order = nodeOrder(layout);
  const current = ui.selected.get(run.id);
  if (current && order.includes(current)) return current;
  const byId = new Map(run.nodes.map((node) => [node.id, node]));
  const fallback =
    order.find((id) => byId.get(id)?.state === "running") ?? order.find((id) => !isTerminal(byId.get(id)?.state ?? "done")) ?? order[0];
  if (fallback) ui.selected.set(run.id, fallback);
  return fallback;
}

/** Parents first, each followed by its nested children. */
export function taskOrder(tasks: readonly TaskCard[]): TaskCard[] {
  const ids = new Set(tasks.map((task) => task.id));
  const byStart = (a: TaskCard, b: TaskCard): number => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
  const children = new Map<string, TaskCard[]>();
  for (const task of tasks) {
    if (!task.parentTaskId || !ids.has(task.parentTaskId) || task.parentTaskId === task.id) continue;
    const group = children.get(task.parentTaskId) ?? [];
    group.push(task);
    children.set(task.parentTaskId, group);
  }
  const ordered: TaskCard[] = [];
  const seen = new Set<string>();
  const visit = (task: TaskCard): void => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    ordered.push(task);
    for (const child of (children.get(task.id) ?? []).sort(byStart)) visit(child);
  };
  for (const task of tasks.filter((item) => !item.parentTaskId || !ids.has(item.parentTaskId)).sort(byStart)) visit(task);
  for (const task of [...tasks].sort(byStart)) visit(task);
  return ordered;
}

export function selectedTask(tasks: readonly TaskCard[], ui: UiState): TaskCard | undefined {
  const ordered = taskOrder(tasks);
  const current = ordered.find((task) => task.id === ui.taskId);
  if (current) return current;
  const fallback = ordered.find((task) => task.status === "running") ?? ordered[0];
  ui.taskId = fallback?.id;
  return fallback;
}

/** Tasks linked to a node, newest activation first. */
export function nodeTasks(node: DagNode, tasks: readonly TaskCard[]): TaskCard[] {
  return tasks.filter((task) => node.taskIds.includes(task.id) || task.nodeId === node.id).sort((a, b) => b.startedAt - a.startedAt);
}

// ── Canvas ────────────────────────────────────────────────────────────────────

interface Cell {
  ch: string;
  style?: Style;
}
interface Link {
  bits: number;
  kind: LineKind;
  style?: Style;
}

/** A character grid with box-drawing connector merging; wide graphemes occupy a lead cell plus an empty continuation. */
class Canvas {
  readonly rows: Cell[][] = [];
  readonly #links = new Map<number, Link>();
  constructor(readonly width: number) {}

  #row(y: number): Cell[] {
    while (this.rows.length <= y) this.rows.push(Array.from({ length: this.width }, () => ({ ch: " " })));
    return this.rows[y] as Cell[];
  }
  set(x: number, y: number, ch: string, style?: Style, width = 1): void {
    if (x < 0 || y < 0 || x + width > this.width) return;
    const row = this.#row(y);
    if (row[x]?.ch === "" && x > 0) row[x - 1] = { ch: " " };
    const end = x + width - 1;
    if (row[end + 1]?.ch === "") row[end + 1] = { ch: " " };
    row[x] = { ch, style };
    if (width === 2) row[x + 1] = { ch: "", style };
  }
  text(x: number, y: number, text: string, style?: Style): number {
    let column = x;
    for (const part of graphemes(text)) {
      const width = textWidth(part);
      if (width === 0) continue;
      if (column + width > this.width) break;
      this.set(column, y, part, style, width);
      column += width;
    }
    return column;
  }
  line(x: number, y: number, line: Line): number {
    let column = x;
    for (const segment of line) column = this.text(column, y, segment.text, segment.style);
    return column;
  }
  touch(y: number): void {
    this.#row(y);
  }
  link(x: number, y: number, bits: number, kind: LineKind, style?: Style): void {
    if (x < 0 || y < 0 || x >= this.width) return;
    const key = y * this.width + x;
    const old = this.#links.get(key);
    if (!old) {
      this.#links.set(key, { bits, kind, style });
      return;
    }
    old.bits |= bits;
    if (LINE_RANK[kind] > LINE_RANK[old.kind]) {
      old.kind = kind;
      old.style = style;
    }
  }
  linkColumns(y: number): Set<number> {
    const columns = new Set<number>();
    for (const key of this.#links.keys()) if (Math.floor(key / this.width) === y) columns.add(key % this.width);
    return columns;
  }
  /** Axis-aligned polyline; `cap` connects the first cell upward into a box border tee. */
  path(points: Array<[number, number]>, kind: LineKind, style: Style | undefined, cap = false): void {
    const first = points[0];
    if (first && cap) this.link(first[0], first[1], UP, kind, style);
    for (let index = 1; index < points.length; index += 1) {
      let [x, y] = points[index - 1] as [number, number];
      const [tx, ty] = points[index] as [number, number];
      while (x !== tx || y !== ty) {
        const dx = Math.sign(tx - x);
        const dy = dx === 0 ? Math.sign(ty - y) : 0;
        this.link(x, y, dx > 0 ? RIGHT : dx < 0 ? LEFT : dy > 0 ? DOWN : UP, kind, style);
        x += dx;
        y += dy;
        this.link(x, y, dx > 0 ? LEFT : dx < 0 ? RIGHT : dy > 0 ? UP : DOWN, kind, style);
      }
    }
  }
  flush(): void {
    for (const [key, link] of this.#links) {
      this.set(key % this.width, Math.floor(key / this.width), connectorGlyph(link.bits, link.kind), link.style);
    }
    this.#links.clear();
  }
  slice(x0: number, cols: number, y0: number, height: number): Line[] {
    const lines: Line[] = [];
    for (let y = y0; y < Math.min(this.rows.length, y0 + height); y += 1) {
      const row = this.rows[y] as Cell[];
      const line: Line = [];
      for (let x = x0; x < Math.min(this.width, x0 + cols); x += 1) {
        const cell = row[x] as Cell;
        let ch = cell.ch;
        if (ch === "") ch = x === x0 ? " " : "";
        else if (textWidth(ch) === 2 && x + 1 >= x0 + cols) ch = " ";
        if (!ch) continue;
        const last = line[line.length - 1];
        if (last && sameStyle(last.style, cell.style)) last.text += ch;
        else line.push({ text: ch, style: cell.style });
      }
      lines.push(line);
    }
    return lines;
  }
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

interface Ctx {
  pal: Palette;
  now: number;
  tick: number;
}
const fg = (pal: Palette, token: keyof Palette["theme"], extra: Style = {}): Style => ({ fg: pal.theme[token], ...extra });
const ruleLine = (ctx: Ctx, cols: number): Line => [{ text: GLYPHS.rule.repeat(cols), style: fg(ctx.pal, "borderMuted") }];

function stateIcon(node: DagNode, ctx: Ctx): Segment {
  if (node.state === "running" && node.stalled) return { text: STATE_ICONS.running, style: fg(ctx.pal, "warning", { bold: true }) };
  return { text: STATE_ICONS[node.state], style: fg(ctx.pal, STATE_TOKENS[node.state], { bold: node.state === "running" }) };
}

function legend(ctx: Ctx, cols: number): Line[] {
  const items: Line = [];
  for (const state of ["pending", "running", "done", "failed", "blocked", "abandoned"] as const) {
    items.push({ text: STATE_ICONS[state], style: fg(ctx.pal, STATE_TOKENS[state]) }, { text: ` ${state}`, style: fg(ctx.pal, "dim") });
  }
  const lines: Line[] = [[]];
  for (let index = 0; index < items.length; index += 2) {
    const pair = [items[index] as Segment, items[index + 1] as Segment];
    const current = lines[lines.length - 1] as Line;
    const gap: Segment[] = current.length ? [{ text: "  " }] : [];
    if (current.length && lineWidth(current) + lineWidth([...gap, ...pair]) > cols) lines.push([...pair]);
    else current.push(...gap, ...pair);
  }
  return lines.slice(0, 2);
}

function banners(input: RenderInput, ctx: Ctx): Line[] {
  const lines: Line[] = [];
  const { cols } = input;
  if (input.link === "lost") {
    const text =
      input.finish === "keep-open"
        ? `${GLYPHS.warning} disconnected from OMP · retrying every 1 s`
        : `${GLYPHS.warning} disconnected from OMP`;
    lines.push(
      pad(
        [{ text: ` ${text}`, style: fg(ctx.pal, "warning", { inverse: true, bold: true }) }],
        cols,
        fg(ctx.pal, "warning", { inverse: true }),
      ),
    );
  } else if (input.link === "connecting") {
    lines.push([{ text: "connecting to OMP…", style: fg(ctx.pal, "dim") }]);
  }
  if (input.ignored > 0) {
    const text = ` ${STATE_ICONS.failed} ${input.ignored} unparsable frame${input.ignored === 1 ? "" : "s"} ignored`;
    lines.push(pad([{ text, style: fg(ctx.pal, "error", { inverse: true, bold: true }) }], cols, fg(ctx.pal, "error", { inverse: true })));
  }
  return lines;
}

function hints(ctx: Ctx, text: string): Line {
  return [{ text, style: fg(ctx.pal, "dim") }];
}

function progressBar(done: number, total: number, width: number, color: string, ctx: Ctx): Line {
  const full = total ? Math.round((done / total) * width) : 0;
  return [
    { text: GLYPHS.barFull.repeat(full), style: { fg: color } },
    { text: GLYPHS.barEmpty.repeat(width - full), style: fg(ctx.pal, "borderMuted") },
  ];
}

// ── DAG view ──────────────────────────────────────────────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface DagScene {
  canvas: Canvas;
  boxes: Map<string, Box>;
  headers: BandHeader[];
}
interface BandHeader {
  y: number;
  title: string;
  crossings: Set<number>;
}
interface DagOptions {
  run: Run;
  layout: RunLayout;
  tasks: readonly TaskCard[];
  selected?: string;
  expanded: Set<string>;
  critical: boolean;
  cols: number;
}

function nodeContent(node: DagNode, options: DagOptions, inner: number, layoutBack: Array<{ label: string }>, ctx: Ctx): Line[] {
  const lines: Line[] = [];
  const expanded = options.expanded.has(node.id);
  const selected = options.selected === node.id;
  const labelStyle = fg(ctx.pal, node.state === "abandoned" ? "dim" : "text", { bold: selected });
  const label = wrap(clean(node.label) || GLYPHS.missing, inner - 2, expanded ? 8 : SPACING.labelLines);
  label.forEach((text, index) => {
    lines.push([index === 0 ? stateIcon(node, ctx) : { text: " " }, { text: ` ${text}`, style: labelStyle }]);
  });
  const linked = nodeTasks(node, options.tasks);
  const running = linked.find((task) => task.status === "running");
  const agent = clean(node.agent) || clean(linked[0]?.agent);
  if (agent || linked.length) {
    const line: Line = [{ text: `${GLYPHS.attached} ${agent || "agent"}`, style: fg(ctx.pal, "muted") }];
    if (linked.length > 1) line.push({ text: ` ×${linked.length}`, style: fg(ctx.pal, "dim") });
    if (running?.currentTool) line.push({ text: `${GLYPHS.separator}${clean(running.currentTool)}`, style: fg(ctx.pal, "accent") });
    lines.push(clip(line, inner));
  }
  if (node.state === "running" && node.stalled) lines.push([{ text: `${GLYPHS.warning} stalled`, style: fg(ctx.pal, "warning") }]);
  for (const reference of layoutBack) {
    lines.push(
      clip([{ text: `${GLYPHS.backReference} after ${clean(reference.label)}`, style: fg(ctx.pal, "muted", { italic: true }) }], inner),
    );
  }
  if (expanded) {
    for (const text of wrap(clean(node.detail), inner, SPACING.detailLines)) lines.push([{ text, style: fg(ctx.pal, "muted") }]);
    const elapsed = node.startedAt === undefined ? undefined : (node.finishedAt ?? ctx.now) - node.startedAt;
    lines.push([{ text: `${node.state} · ${formatDuration(elapsed)}`, style: fg(ctx.pal, "dim") }]);
  }
  return lines;
}

function drawBox(canvas: Canvas, box: Box, content: Line[], glyphs: BoxGlyphs, border: Style): void {
  const inner = box.w - 4;
  canvas.text(box.x, box.y, `${glyphs.tl}${glyphs.h.repeat(box.w - 2)}${glyphs.tr}`, border);
  for (let row = 1; row < box.h - 1; row += 1) {
    canvas.text(box.x, box.y + row, glyphs.v, border);
    canvas.line(box.x + 2, box.y + row, clip(content[row - 1] ?? [], inner));
    canvas.text(box.x + box.w - 1, box.y + row, glyphs.v, border);
  }
  canvas.text(box.x, box.y + box.h - 1, `${glyphs.bl}${glyphs.h.repeat(box.w - 2)}${glyphs.br}`, border);
}

function chooseNodeWidth(layout: RunLayout, cols: number, margin: number): number {
  let width: number = SPACING.maxNode;
  for (const layer of layout.layers) {
    if (layer.folded) continue;
    const real = layer.nodes.filter((item) => !item.dummy).length;
    const dummies = layer.nodes.length - real;
    if (!real) continue;
    const fixed = (real - 1) * SPACING.nodeGap + dummies * (1 + SPACING.dummyGap);
    width = Math.min(width, Math.floor((cols - margin - fixed) / real));
  }
  return Math.max(Math.min(SPACING.minNode, cols - margin), Math.min(SPACING.maxNode, width), 8);
}

function foldedSummary(layer: LayoutLayer, ctx: Ctx): Line {
  const count = layer.nodes.filter((item) => item.node).length;
  return [
    { text: `${STATE_ICONS.done} ${count} done`, style: fg(ctx.pal, "success") },
    { text: ` (${clean(layer.bandName) || "band"})`, style: fg(ctx.pal, "dim") },
  ];
}

/** Lays boxes, band headers and routed connectors onto a canvas (see the Layering rule in the plan). */
function buildDag(options: DagOptions, ctx: Ctx): DagScene {
  const { run, layout } = options;
  const layers = layout.layers;
  const position = new Map<string, number>();
  layers.forEach((layer, index) => {
    for (const item of layer.nodes) position.set(item.id, index);
  });
  const back = layout.edges
    .filter((route) => route.backward && position.has(route.edge.from) && position.has(route.edge.to))
    .map((route) => ({ route, span: (position.get(route.edge.from) as number) - (position.get(route.edge.to) as number) }))
    .sort(
      (a, b) => b.span - a.span || a.route.edge.from.localeCompare(b.route.edge.from) || a.route.edge.to.localeCompare(b.route.edge.to),
    );
  const margin = back.length ? back.length * SPACING.laneGap + 1 : 0;
  const width = chooseNodeWidth(layout, options.cols, margin);
  const source = run.source;
  const sourceColor = ctx.pal.sources[source];
  const critical = new Set(options.critical ? layout.criticalPath : []);
  const criticalPairs = new Set<string>();
  if (options.critical) {
    for (let index = 1; index < layout.criticalPath.length; index += 1) {
      criticalPairs.add(`${layout.criticalPath[index - 1]}\n${layout.criticalPath[index]}`);
    }
  }
  const edgeStyle = (route: RoutedEdge): { kind: LineKind; style: Style } => {
    if (criticalPairs.has(`${route.edge.from}\n${route.edge.to}`) && route.edge.kind === "depends")
      return { kind: "heavy", style: fg(ctx.pal, "accent", { bold: true }) };
    if (route.edge.kind === "fix") return { kind: "dotted", style: fg(ctx.pal, "warning") };
    if (route.backward) return { kind: "dotted", style: fg(ctx.pal, "muted") };
    return { kind: "solid", style: fg(ctx.pal, "border") };
  };
  const dummyRoutes = new Map(layout.edges.flatMap((route) => route.points.slice(1, -1).map((id) => [id, route] as const)));
  // Connectors are queued: plain strokes first, critical last so heavy strokes win shared cells.
  const draws: Array<{ heavy: boolean; draw: () => void }> = [];
  const arrows: Array<{ x: number; y: number; style: Style }> = [];

  // Horizontal placement, centred per layer.
  interface Item {
    id: string;
    x: number;
    w: number;
    kind: "node" | "dummy" | "summary";
  }
  const layerItems: Item[][] = layers.map((layer) => {
    const items: Item[] = [];
    let x = 0;
    if (layer.folded) {
      const summaryWidth = lineWidth(foldedSummary(layer, ctx));
      items.push({ id: `summary:${layer.index}`, x, w: summaryWidth, kind: "summary" });
      x += summaryWidth + SPACING.dummyGap;
      for (const item of layer.nodes.filter((entry) => entry.dummy)) {
        items.push({ id: item.id, x, w: 1, kind: "dummy" });
        x += 1 + SPACING.dummyGap;
      }
      return items;
    }
    layer.nodes.forEach((item, index) => {
      const previous = layer.nodes[index - 1];
      if (previous) x += previous.dummy || item.dummy ? SPACING.dummyGap : SPACING.nodeGap;
      items.push({ id: item.id, x, w: item.dummy ? 1 : width, kind: item.dummy ? "dummy" : "node" });
      x += item.dummy ? 1 : width;
    });
    return items;
  });
  const layerWidths = layerItems.map((items) => Math.max(0, ...items.map((item) => item.x + item.w)));
  const content = Math.max(0, ...layerWidths);
  const area = Math.max(content, options.cols - margin);
  const areaEnd = margin + area;
  const predecessors = new Map<string, string[]>();
  for (const route of layout.edges) {
    if (route.backward) continue;
    for (let index = 1; index < route.points.length; index += 1) {
      const target = route.points[index] as string;
      predecessors.set(target, [...(predecessors.get(target) ?? []), route.points[index - 1] as string]);
    }
  }
  const spacing = (left: Item, right: Item): number => (left.kind === "node" && right.kind === "node" ? SPACING.nodeGap : SPACING.dummyGap);
  // Centre each layer, then pull items under the median of their predecessors so chains run straight.
  const anchor = new Map<string, number>();
  layerItems.forEach((items, index) => {
    const layer = layers[index] as LayoutLayer;
    const offset = margin + Math.floor((area - (layerWidths[index] as number)) / 2);
    for (const item of items) item.x += offset;
    for (const item of items) {
      const sources =
        item.kind === "summary"
          ? layer.nodes.flatMap((entry) => (entry.node ? (predecessors.get(entry.id) ?? []) : []))
          : (predecessors.get(item.id) ?? []);
      const above = sources.flatMap((id) => (anchor.has(id) ? [anchor.get(id) as number] : [])).sort((a, b) => a - b);
      const median = above[Math.floor((above.length - 1) / 2)];
      if (median !== undefined) item.x = median - (item.kind === "node" ? Math.floor(item.w / 2) : 0);
    }
    let min = margin;
    items.forEach((item, position) => {
      item.x = Math.max(item.x, min);
      const next = items[position + 1];
      if (next) min = item.x + item.w + spacing(item, next);
    });
    let max = areaEnd;
    for (let position = items.length - 1; position >= 0; position -= 1) {
      const item = items[position] as Item;
      item.x = Math.max(margin, Math.min(item.x, max - item.w));
      const previous = items[position - 1];
      if (previous) max = item.x - spacing(previous, item);
    }
    for (const item of items) {
      if (item.kind === "summary") {
        for (const entry of layer.nodes) if (entry.node) anchor.set(entry.id, item.x);
      } else anchor.set(item.id, item.kind === "dummy" ? item.x : item.x + Math.floor(item.w / 2));
    }
  });
  const canvas = new Canvas(Math.max(options.cols, areaEnd, ...layerItems.flat().map((item) => item.x + item.w)));

  // Vertical extents.
  const contents = new Map<string, Line[]>();
  const layerHeights = layers.map((layer) => {
    if (layer.folded) return 1;
    let height = 1;
    for (const item of layer.nodes) {
      if (!item.node) continue;
      const lines = nodeContent(item.node, options, width - 4, item.backReferences, ctx);
      contents.set(item.id, lines);
      height = Math.max(height, lines.length + 2);
    }
    return height;
  });

  interface Segment2 {
    from: string;
    to: string;
    x1: number;
    x2: number;
    route: RoutedEdge;
    track?: number;
  }
  const gaps = Array.from({ length: layers.length + 1 }, () => ({
    backOut: [] as number[],
    backIn: [] as number[],
    segments: [] as Segment2[],
    tracks: 0,
    header: false,
    y: 0,
    trackY: 0,
    backInY: 0,
    headerY: -1,
    arrowY: -1,
  }));
  back.forEach(({ route }, index) => {
    gaps[(position.get(route.edge.from) as number) + 1]?.backOut.push(index);
    gaps[position.get(route.edge.to) as number]?.backIn.push(index);
  });
  for (const route of layout.edges) {
    if (route.backward) continue;
    for (let index = 1; index < route.points.length; index += 1) {
      const from = route.points[index - 1] as string;
      const to = route.points[index] as string;
      const target = position.get(to);
      if (target === undefined || position.get(from) !== target - 1) continue;
      gaps[target]?.segments.push({ from, to, x1: anchor.get(from) as number, x2: anchor.get(to) as number, route });
    }
  }
  for (const gap of gaps) {
    const tracks: Array<Array<{ min: number; max: number; x1: number; x2: number; kind: LineKind }>> = [];
    for (const segment of gap.segments
      .filter((item) => item.x1 !== item.x2)
      .sort((a, b) => Math.min(a.x1, a.x2) - Math.min(b.x1, b.x2) || a.x1 - b.x1 || a.x2 - b.x2)) {
      const min = Math.min(segment.x1, segment.x2);
      const max = Math.max(segment.x1, segment.x2);
      const { kind } = edgeStyle(segment.route);
      // Fan-in and fan-out may share a track only when the strokes look the same.
      let track = tracks.findIndex((used) =>
        used.every(
          (other) =>
            other.max + 1 < min || max + 1 < other.min || (other.kind === kind && (other.x1 === segment.x1 || other.x2 === segment.x2)),
        ),
      );
      if (track < 0) {
        track = tracks.length;
        tracks.push([]);
      }
      tracks[track]?.push({ min, max, x1: segment.x1, x2: segment.x2, kind });
      segment.track = track;
    }
    gap.tracks = tracks.length;
  }
  layers.forEach((layer, index) => {
    const previous = layers[index - 1];
    (gaps[index] as (typeof gaps)[number]).header = !previous || previous.band !== layer.band;
  });

  // Assign rows.
  let y = 0;
  const layerY: number[] = [];
  gaps.forEach((gap, index) => {
    gap.y = y;
    y += gap.backOut.length;
    gap.trackY = y;
    y += gap.tracks;
    gap.backInY = y;
    y += gap.backIn.length;
    if (gap.header) gap.headerY = y++;
    const between = index > 0 && index < layers.length;
    if (index < layers.length && (gap.backIn.length || gap.segments.length || (between && !gap.header))) gap.arrowY = y++;
    if (index < layers.length) {
      layerY.push(y);
      y += layerHeights[index] as number;
    }
  });
  canvas.touch(Math.max(0, y - 1));

  // Boxes, folded summaries and pass-through dummies.
  const boxes = new Map<string, Box>();
  const exitY = new Map<string, number>();
  const entryY = new Map<string, number>();
  const outgoing = new Set(layout.edges.map((route) => route.edge.from));
  layerItems.forEach((items, index) => {
    const layer = layers[index] as LayoutLayer;
    const top = layerY[index] as number;
    const height = layerHeights[index] as number;
    const arrow = (gaps[index] as (typeof gaps)[number]).arrowY;
    for (const item of items) {
      if (item.kind === "summary") {
        canvas.line(item.x, top, foldedSummary(layer, ctx));
        for (const entry of layer.nodes) {
          if (!entry.node) continue;
          exitY.set(entry.id, top + 1);
          entryY.set(entry.id, arrow);
        }
        continue;
      }
      if (item.kind === "dummy") {
        const route = dummyRoutes.get(item.id);
        const { kind, style } = route ? edgeStyle(route) : { kind: "solid" as const, style: fg(ctx.pal, "border") };
        const points: Array<[number, number]> = [
          [item.x, top],
          [item.x, top + height - 1],
        ];
        draws.push({ heavy: kind === "heavy", draw: () => canvas.path(points, kind, style) });
        exitY.set(item.id, top + height - 1);
        entryY.set(item.id, top);
        continue;
      }
      const lines = contents.get(item.id) ?? [];
      const box = { x: item.x, y: top, w: item.w, h: lines.length + 2 };
      boxes.set(item.id, box);
      const isCritical = critical.has(item.id);
      const isSelected = options.selected === item.id;
      const glyphs = BOXES[isSelected ? "double" : isCritical ? "heavy" : "rounded"];
      const border: Style = isCritical ? fg(ctx.pal, "accent", { bold: true }) : { fg: sourceColor, bold: isSelected };
      drawBox(canvas, box, lines, glyphs, border);
      if (outgoing.has(item.id)) canvas.set(anchor.get(item.id) as number, box.y + box.h - 1, glyphs.tee, border);
      exitY.set(item.id, box.y + box.h);
      entryY.set(item.id, arrow);
    }
  });

  gaps.forEach((gap) => {
    for (const segment of gap.segments) {
      const { kind, style } = edgeStyle(segment.route);
      const start = exitY.get(segment.from) as number;
      const end = entryY.get(segment.to) as number;
      const isDummyTarget = segment.to.startsWith("dummy:");
      const isDummySource = segment.from.startsWith("dummy:");
      const points: Array<[number, number]> = [[segment.x1, start]];
      if (segment.track !== undefined) {
        const trackY = gap.trackY + segment.track;
        points.push([segment.x1, trackY], [segment.x2, trackY]);
      }
      points.push([segment.x2, end]);
      draws.push({
        heavy: kind === "heavy",
        draw: () => {
          canvas.path(points, kind, style, !isDummySource);
          if (!isDummyTarget) arrows.push({ x: segment.x2, y: end, style });
        },
      });
    }
  });
  back.forEach(({ route }, index) => {
    const out = gaps[(position.get(route.edge.from) as number) + 1];
    const into = gaps[position.get(route.edge.to) as number];
    if (!out || !into) return;
    const lane = index * SPACING.laneGap;
    const outY = out.y + out.backOut.indexOf(index);
    const inY = into.backInY + into.backIn.indexOf(index);
    const xs = anchor.get(route.edge.from) as number;
    const xt = anchor.get(route.edge.to) as number;
    const end = entryY.get(route.edge.to) as number;
    const { kind, style } = edgeStyle(route);
    draws.push({
      heavy: kind === "heavy",
      draw: () => {
        canvas.path(
          [
            [xs, exitY.get(route.edge.from) as number],
            [xs, outY],
            [lane, outY],
            [lane, inY],
            [xt, inY],
            [xt, end],
          ],
          kind,
          style,
          true,
        );
        arrows.push({ x: xt, y: end, style });
      },
    });
  });
  for (const item of draws.filter((entry) => !entry.heavy)) item.draw();
  for (const item of draws.filter((entry) => entry.heavy)) item.draw();

  // Band rules skip the columns connectors cross; titles are placed once the viewport is known.
  const headers: BandHeader[] = [];
  layers.forEach((layer, index) => {
    const gap = gaps[index] as (typeof gaps)[number];
    if (gap.headerY < 0) return;
    const crossings = canvas.linkColumns(gap.headerY);
    for (let x = 0; x < canvas.width; x += 1) {
      if (!crossings.has(x)) canvas.set(x, gap.headerY, GLYPHS.bandRule, fg(ctx.pal, "borderMuted"));
    }
    headers.push({ y: gap.headerY, title: clean(layer.bandName) || `Band ${layer.band + 1}`, crossings });
  });

  canvas.flush();
  for (const arrow of arrows) canvas.set(arrow.x, arrow.y, GLYPHS.arrow, arrow.style);
  return { canvas, boxes, headers };
}

/** Puts each band title in the first viewport span no connector crosses, so titles stay readable while scrolled. */
function placeBandTitles(scene: DagScene, left: number, cols: number, ctx: Ctx): void {
  for (const header of scene.headers) {
    const title = ` ${truncate(header.title, Math.max(1, cols - 6))} `;
    const width = textWidth(title);
    for (let x = left + 2; x + width <= Math.min(scene.canvas.width, left + cols); x += 1) {
      let free = true;
      for (let column = x - 1; column <= x + width && free; column += 1) if (header.crossings.has(column)) free = false;
      if (!free) continue;
      scene.canvas.text(x, header.y, title, fg(ctx.pal, "muted", { bold: true }));
      break;
    }
  }
}

function runHeader(run: Run, runs: Run[], input: RenderInput, ctx: Ctx): Line[] {
  const { cols } = input;
  const lines: Line[] = [];
  // Tabs.
  const tabs = runs.map((item) => {
    const color = ctx.pal.sources[item.source];
    const selected = item.id === run.id;
    const marker = input.ui.history && item.finishedAt !== undefined && item.source !== "atlas" ? `${GLYPHS.history} ` : "";
    const text = `${marker}${truncate(clean(item.title) || SOURCE_LABELS[item.source], 18)} ${item.stats.done}/${item.stats.total}`;
    return [
      { text: GLYPHS.tabMark, style: { fg: color } },
      { text: ` ${text} `, style: selected ? { fg: color, inverse: true, bold: true } : { fg: color } },
    ] as Line;
  });
  const selectedIndex = Math.max(
    0,
    runs.findIndex((item) => item.id === run.id),
  );
  let first = selectedIndex;
  let used = lineWidth(tabs[selectedIndex] ?? []);
  while (first > 0 && used + 1 + lineWidth(tabs[first - 1] as Line) <= cols - 4) {
    first -= 1;
    used += 1 + lineWidth(tabs[first] as Line);
  }
  let last = selectedIndex;
  while (last + 1 < tabs.length && used + 1 + lineWidth(tabs[last + 1] as Line) <= cols - 4) {
    last += 1;
    used += 1 + lineWidth(tabs[last] as Line);
  }
  const tabLine: Line = [];
  if (first > 0) tabLine.push({ text: `${GLYPHS.overflowLeft} `, style: fg(ctx.pal, "dim") });
  tabs.slice(first, last + 1).forEach((tab, index) => {
    if (index) tabLine.push({ text: " " });
    tabLine.push(...tab);
  });
  if (last + 1 < tabs.length) tabLine.push({ text: ` ${GLYPHS.overflowRight}`, style: fg(ctx.pal, "dim") });
  lines.push(tabLine);

  // Source badge + title.
  const color = ctx.pal.sources[run.source];
  const title: Line = [
    { text: ` ${SOURCE_LABELS[run.source]} `, style: { fg: color, inverse: true, bold: true } },
    { text: ` ${clean(run.title) || SOURCE_LABELS[run.source]}`, style: { fg: color, bold: true } },
  ];
  if (run.finishedAt !== undefined) title.push({ text: " · finished", style: fg(ctx.pal, "dim") });
  if (input.ui.history) title.push({ text: ` · gen ${run.generation}`, style: fg(ctx.pal, "dim") });
  lines.push(title);

  // Stats.
  const stats = runStats(run, input.snapshot?.tasks ?? [], ctx.now);
  const progress: Line = [
    ...progressBar(stats.done, stats.total, Math.min(10, Math.max(4, cols - 40)), color, ctx),
    { text: ` ${stats.done}/${stats.total}`, style: fg(ctx.pal, "text", { bold: true }) },
    { text: `${GLYPHS.separator}${formatDuration(stats.elapsedMs)}`, style: fg(ctx.pal, "muted") },
  ];
  const usage = `tok ${formatTokens(stats.tokens)}${GLYPHS.separator}${formatCost(stats.costUsd)}`;
  if (lineWidth(progress) + textWidth(GLYPHS.separator) + textWidth(usage) <= cols) {
    lines.push([...progress, { text: `${GLYPHS.separator}${usage}`, style: fg(ctx.pal, "muted") }]);
  } else lines.push(progress, [{ text: usage, style: fg(ctx.pal, "muted") }]);
  if (input.rows >= 24) lines.push(...legend(ctx, cols));
  lines.push(ruleLine(ctx, cols));
  return lines;
}

function dagFooter(run: Run, node: DagNode | undefined, layout: RunLayout, input: RenderInput, ctx: Ctx): Line[] {
  const { cols } = input;
  const lines: Line[] = [ruleLine(ctx, cols)];
  if (node) {
    lines.push([stateIcon(node, ctx), { text: ` ${clean(node.label)}`, style: fg(ctx.pal, "text", { bold: true }) }]);
    const elapsed = node.startedAt === undefined ? undefined : (node.finishedAt ?? ctx.now) - node.startedAt;
    const meta = [
      node.state + (node.stalled && node.state === "running" ? " (stalled)" : ""),
      clean(node.bandName),
      formatDuration(elapsed),
    ];
    const agent = clean(node.agent);
    if (agent) meta.push(agent);
    if (layout.criticalPath.includes(node.id) && input.viewState.criticalPath) meta.push("critical path");
    lines.push([{ text: meta.filter(Boolean).join(GLYPHS.separator), style: fg(ctx.pal, "muted") }]);
    for (const text of wrap(clean(node.detail), cols, SPACING.footerDetailLines)) lines.push([{ text, style: fg(ctx.pal, "text") }]);
  }
  const fold = input.viewState.folded.includes(run.id) ? "c unfold" : "c fold";
  const path = layout.criticalPath.length ? (input.viewState.criticalPath ? " · p hide path" : " · p path") : "";
  lines.push(hints(ctx, `? help · t tasks · ←→ runs · ${fold}${path}`));
  return lines;
}

function renderDag(input: RenderInput, ctx: Ctx, top: Line[]): Line[] {
  const { snapshot, viewState, ui, cols, rows } = input;
  const run = currentRun(snapshot, viewState, ui);
  if (!run) {
    const body: Line[] = [[], [{ text: "waiting for todos or Atlas", style: fg(ctx.pal, "muted", { italic: true }) }]];
    if (snapshot && !snapshot.atlasAvailable) body.push([{ text: "Atlas integration: not available", style: fg(ctx.pal, "dim") }]);
    if (snapshot?.tasks.length) body.push([{ text: `${snapshot.tasks.length} subagent task(s) · press t`, style: fg(ctx.pal, "dim") }]);
    return compose(top, body, [ruleLine(ctx, cols), hints(ctx, "? help · t tasks · q quit")], rows, ui, 0);
  }
  const runs = visibleRuns(snapshot, ui.history);
  if (!runs.some((item) => item.id === run.id)) runs.push(run);
  const layout = runLayout(run, viewState, ctx.now);
  const selected = selectedNode(run, layout, ui);
  const node = run.nodes.find((item) => item.id === selected);
  const header = [...top, ...runHeader(run, runs, input, ctx)];
  const footer = dagFooter(run, node, layout, input, ctx);
  const scene = buildDag(
    {
      run,
      layout,
      tasks: snapshot?.tasks ?? [],
      selected,
      expanded: ui.expanded,
      critical: viewState.criticalPath && layout.criticalPath.length > 0,
      cols,
    },
    ctx,
  );
  const height = Math.max(1, rows - header.length - footer.length);
  const box = selected ? scene.boxes.get(selected) : undefined;
  const total = scene.canvas.rows.length;
  if (box) {
    if (box.y < ui.scrollY) ui.scrollY = Math.max(0, box.y - 1);
    if (box.y + box.h > ui.scrollY + height) ui.scrollY = Math.min(box.y, box.y + box.h - height + 1);
    // Centre the selection horizontally when it leaves the viewport, keeping context on both sides.
    if (box.x < ui.scrollX || box.x + box.w > ui.scrollX + cols) ui.scrollX = box.x + Math.floor(box.w / 2) - Math.floor(cols / 2);
  }
  ui.scrollY = Math.max(0, Math.min(ui.scrollY, total - height));
  ui.scrollX = Math.max(0, Math.min(ui.scrollX, scene.canvas.width - cols));
  placeBandTitles(scene, ui.scrollX, cols, ctx);
  const body = scene.canvas.slice(ui.scrollX, cols, ui.scrollY, height);
  return compose(header, body, footer, rows, ui, 0);
}

/** Header and footer are kept; the body fills (and is clipped to) the remaining rows. */
function compose(header: Line[], body: Line[], footer: Line[], rows: number, ui: UiState, bodyTop: number): Line[] {
  let foot = footer;
  let head = header;
  while (head.length + foot.length + 1 > rows && foot.length > 1) foot = [...foot.slice(0, 1), ...foot.slice(2)];
  while (head.length + foot.length + 1 > rows && foot.length) foot = foot.slice(1);
  if (head.length + 1 > rows) head = head.slice(0, Math.max(0, rows - 1));
  const height = Math.max(0, rows - head.length - foot.length);
  ui.bodyRows = height;
  const visible = body.slice(bodyTop, bodyTop + height);
  while (visible.length < height) visible.push([]);
  return [...head, ...visible, ...foot].slice(0, rows);
}

// ── Tasks view ────────────────────────────────────────────────────────────────

function taskIcon(task: TaskCard, ctx: Ctx): Segment {
  switch (task.status) {
    case "running":
      return {
        text: SPINNER[ctx.tick % SPINNER.length] as string,
        style: fg(ctx.pal, task.stalled ? "warning" : "accent", { bold: true }),
      };
    case "completed":
      return { text: STATE_ICONS.done, style: fg(ctx.pal, "success") };
    case "failed":
      return { text: STATE_ICONS.failed, style: fg(ctx.pal, "error", { bold: true }) };
    default:
      return { text: STATE_ICONS.abandoned, style: fg(ctx.pal, "warning") };
  }
}

function taskElapsed(task: TaskCard, now: number): number {
  const totals = taskTotals(task);
  if (task.status === "running") return task.completed.durationMs + Math.max(task.current.durationMs, now - task.startedAt);
  return totals.durationMs || Math.max(0, (task.finishedAt ?? now) - task.startedAt);
}

function nodeLabel(snapshot: Snapshot | undefined, nodeId: string | undefined): string | undefined {
  if (!nodeId) return undefined;
  for (const run of snapshot?.runs ?? []) {
    const node = run.nodes.find((item) => item.id === nodeId);
    if (node) return clean(node.label);
  }
  return undefined;
}

function taskCard(task: TaskCard, input: RenderInput, ctx: Ctx, width: number, selected: boolean): Line[] {
  const glyphs = BOXES[selected ? "double" : "rounded"];
  const stalled = task.status === "running" && task.stalled;
  const borderToken = task.status === "failed" ? "error" : stalled ? "warning" : task.status === "running" ? "borderAccent" : "borderMuted";
  const border = fg(ctx.pal, borderToken, { bold: selected });
  const inner = width - 4;
  const content: Line[] = [];
  const expanded = input.ui.expanded.has(task.id);
  const description = clean(task.description);
  for (const text of wrap(description, inner, expanded ? 4 : 2)) content.push([{ text, style: fg(ctx.pal, "text") }]);
  const label = nodeLabel(input.snapshot, task.nodeId);
  if (label) content.push(clip([{ text: `${GLYPHS.attached} ${label}`, style: fg(ctx.pal, "muted") }], inner));
  if (!task.activityAvailable) {
    content.push([{ text: "activity unavailable", style: fg(ctx.pal, "dim", { italic: true }) }]);
  } else {
    if (task.status === "running" && task.currentTool) {
      const args = clean(task.currentToolArgs);
      content.push(
        clip(
          [
            { text: `${GLYPHS.tool} `, style: fg(ctx.pal, "accent") },
            { text: clean(task.currentTool), style: fg(ctx.pal, "accent", { bold: true }) },
            {
              text: `(${args ? truncate(args, Math.max(1, inner - textWidth(clean(task.currentTool)) - 4)) : ""})`,
              style: fg(ctx.pal, "muted"),
            },
          ],
          inner,
        ),
      );
    }
    const output = task.recentOutput
      .slice(0, expanded ? 8 : SPACING.outputLines)
      .reverse()
      .map(clean)
      .filter(Boolean);
    for (const text of output) content.push([{ text: truncate(text, inner), style: fg(ctx.pal, "muted") }]);
    const totals = taskTotals(task);
    const metrics = [`tok ${formatTokens(totals.tokens)}`, `cost ${formatCost(totals.costUsd)}`];
    if (task.activations > 1) metrics.push(`×${task.activations} activations`);
    metrics.push(clean(task.model) || `model ${GLYPHS.missing}`);
    content.push(...wrap(metrics.join(GLYPHS.separator), inner, 2).map((text): Line => [{ text, style: fg(ctx.pal, "dim") }]));
    if (task.retry) {
      const text = `${GLYPHS.retry} retry ${task.retry.attempt}/${task.retry.maxAttempts} · ${clean(task.retry.errorMessage)}`;
      content.push(...wrap(text, inner, 2).map((line): Line => [{ text: line, style: fg(ctx.pal, "warning") }]));
    }
  }
  // Title embedded in the top border.
  const status = task.status === "running" ? (stalled ? " stalled" : "") : ` ${task.status}`;
  const statusStyle = fg(ctx.pal, task.status === "failed" ? "error" : stalled || task.status === "aborted" ? "warning" : "dim", {
    bold: stalled || task.status === "failed",
  });
  const elapsed = ` ${formatDuration(taskElapsed(task, ctx.now))} `;
  const fixed = 3 + 2 + textWidth(status) + 1 + textWidth(elapsed) + 2;
  const agentText = truncate(clean(task.agent) || "agent", Math.max(1, width - fixed - 1));
  const fill = Math.max(1, width - (3 + 2 + textWidth(agentText) + textWidth(status) + 1 + textWidth(elapsed) + 2));
  const topLine: Line = [
    { text: `${glyphs.tl}${glyphs.h} `, style: border },
    taskIcon(task, ctx),
    { text: ` ${agentText}`, style: fg(ctx.pal, "text", { bold: true }) },
    { text: status, style: statusStyle },
    { text: ` ${glyphs.h.repeat(fill)}`, style: border },
    { text: elapsed, style: fg(ctx.pal, "muted") },
    { text: `${glyphs.h}${glyphs.tr}`, style: border },
  ];
  const lines: Line[] = [clip(topLine, width)];
  for (const line of content) {
    const body = clip(line, inner);
    lines.push([
      { text: `${glyphs.v} `, style: border },
      ...body,
      { text: " ".repeat(Math.max(0, inner - lineWidth(body))) },
      { text: ` ${glyphs.v}`, style: border },
    ]);
  }
  lines.push([{ text: `${glyphs.bl}${glyphs.h.repeat(width - 2)}${glyphs.br}`, style: border }]);
  return lines;
}

function renderTasks(input: RenderInput, ctx: Ctx, top: Line[]): Line[] {
  const { snapshot, ui, cols, rows } = input;
  const tasks = snapshot?.tasks ?? [];
  const ordered = taskOrder(tasks);
  const selected = selectedTask(tasks, ui);
  const count = (status: TaskCard["status"]): number => tasks.filter((task) => task.status === status).length;
  const summary = [`${count("running")} running`, `${count("completed")} done`];
  if (count("failed")) summary.push(`${count("failed")} failed`);
  if (count("aborted")) summary.push(`${count("aborted")} aborted`);
  let tokens: number | undefined;
  let cost: number | undefined;
  for (const task of tasks) {
    const totals = taskTotals(task);
    if (totals.tokens !== undefined) tokens = (tokens ?? 0) + totals.tokens;
    if (totals.costUsd !== undefined) cost = (cost ?? 0) + totals.costUsd;
  }
  const header: Line[] = [
    ...top,
    [
      { text: " TASKS ", style: fg(ctx.pal, "accent", { inverse: true, bold: true }) },
      { text: ` ${summary.join(GLYPHS.separator)}`, style: fg(ctx.pal, "text") },
    ],
    [{ text: `tok ${formatTokens(tokens)}${GLYPHS.separator}${formatCost(cost)}`, style: fg(ctx.pal, "muted") }],
    ruleLine(ctx, cols),
  ];
  const footer: Line[] = [ruleLine(ctx, cols), hints(ctx, "? help · t dag · o transcript · enter expand")];
  if (!ordered.length) {
    return compose(header, [[], [{ text: "no subagent tasks yet", style: fg(ctx.pal, "muted", { italic: true }) }]], footer, rows, ui, 0);
  }
  const body: Line[] = [];
  let selectedStart = 0;
  let selectedEnd = 0;
  for (const task of ordered) {
    const indent = Math.min(6, Math.max(0, task.depth - 1) * 2);
    const width = Math.max(12, cols - indent);
    const isSelected = task.id === selected?.id;
    if (isSelected) selectedStart = body.length;
    for (const line of taskCard(task, input, ctx, width, isSelected)) body.push(indent ? [{ text: " ".repeat(indent) }, ...line] : line);
    if (isSelected) selectedEnd = body.length;
  }
  const height = Math.max(1, rows - header.length - footer.length);
  if (selectedStart < ui.scrollY) ui.scrollY = selectedStart;
  if (selectedEnd > ui.scrollY + height) ui.scrollY = Math.min(selectedStart, selectedEnd - height);
  ui.scrollY = Math.max(0, Math.min(ui.scrollY, body.length - height));
  return compose(header, body, footer, rows, ui, ui.scrollY);
}

// ── Transcript view ───────────────────────────────────────────────────────────

function renderTranscript(input: RenderInput, ctx: Ctx, top: Line[]): Line[] {
  const { snapshot, ui, cols, rows } = input;
  const view = ui.transcript;
  const task = snapshot?.tasks.find((item) => item.id === view?.taskId);
  const header: Line[] = [
    ...top,
    [
      { text: " TRANSCRIPT ", style: fg(ctx.pal, "accent", { inverse: true, bold: true }) },
      { text: ` ${clean(task?.agent) || "agent"}`, style: fg(ctx.pal, "text", { bold: true }) },
      { text: ` · ${clean(view?.taskId).slice(0, 12)}`, style: fg(ctx.pal, "dim") },
    ],
    [{ text: view?.follow === false ? "paused · scroll to the end to follow" : "following", style: fg(ctx.pal, "muted") }],
    ruleLine(ctx, cols),
  ];
  const footer: Line[] = [ruleLine(ctx, cols), hints(ctx, "esc back · j/k scroll · PgUp/PgDn page")];
  const body: Line[] = [];
  if (!view?.file) body.push([{ text: "transcript unavailable for this task", style: fg(ctx.pal, "muted", { italic: true }) }]);
  else if (!view.lines.length) body.push([{ text: "waiting for transcript entries…", style: fg(ctx.pal, "muted", { italic: true }) }]);
  for (const line of view?.lines ?? []) {
    const token = line.tone === "error" ? "error" : line.tone === "tool" ? "accent" : line.tone === "result" ? "muted" : "text";
    if (line.tone === "text" || line.tone === "error") {
      for (const text of wrap(line.text, cols)) body.push([{ text, style: fg(ctx.pal, token) }]);
    } else body.push([{ text: truncate(line.text, cols), style: fg(ctx.pal, token) }]);
  }
  const height = Math.max(1, rows - header.length - footer.length);
  const maxScroll = Math.max(0, body.length - height);
  if (view) {
    if (view.follow) view.scroll = maxScroll;
    view.scroll = Math.max(0, Math.min(view.scroll, maxScroll));
    view.follow = view.scroll >= maxScroll;
  }
  return compose(header, body, footer, rows, ui, view?.scroll ?? 0);
}

// ── Help ──────────────────────────────────────────────────────────────────────

const HELP: Array<[string, string]> = [
  ["q", "quit and close this pane"],
  ["t", "toggle DAG / Tasks"],
  ["h", "show previous todo generations"],
  ["← →", "previous / next run"],
  ["j k ↑ ↓", "move selection"],
  ["PgUp PgDn", "page"],
  ["enter", "expand / collapse details"],
  ["c", "fold / unfold completed layers"],
  ["p", "toggle critical-path highlight"],
  ["o", "open the selected child's transcript"],
  ["esc", "back"],
  ["?", "this help"],
];

function renderHelp(input: RenderInput, ctx: Ctx, top: Line[]): Line[] {
  const header: Line[] = [
    ...top,
    [{ text: " KEYS ", style: fg(ctx.pal, "accent", { inverse: true, bold: true }) }],
    ruleLine(ctx, input.cols),
  ];
  const body: Line[] = HELP.map(([key, text]) => [
    { text: key.padEnd(11), style: fg(ctx.pal, "accent", { bold: true }) },
    { text, style: fg(ctx.pal, "text") },
  ]);
  body.push([]);
  for (const state of ["pending", "running", "done", "failed", "blocked", "abandoned"] as const) {
    body.push([
      { text: STATE_ICONS[state].padEnd(11), style: fg(ctx.pal, STATE_TOKENS[state]) },
      { text: state, style: fg(ctx.pal, "muted") },
    ]);
  }
  body.push([]);
  for (const source of ["todo", "plan", "atlas"] as const) {
    body.push([{ text: `${GLYPHS.tabMark} ${SOURCE_LABELS[source]}`.padEnd(11), style: { fg: ctx.pal.sources[source], bold: true } }]);
  }
  return compose(header, body, [ruleLine(ctx, input.cols), hints(ctx, "esc / ? close")], input.rows, input.ui, 0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

/** Returns at most `rows` ANSI lines, none wider than `cols`. */
export function render(input: RenderInput): string[] {
  const cols = Math.max(1, Math.floor(input.cols));
  const rows = Math.max(1, Math.floor(input.rows));
  const normalized = { ...input, cols, rows };
  const ctx: Ctx = { pal: palette(input.snapshot, input.mode), now: input.now, tick: input.tick };
  const top = banners(normalized, ctx);
  let lines: Line[];
  if (input.ui.help) lines = renderHelp(normalized, ctx, top);
  else if (input.viewState.view === "transcript" && input.ui.transcript) lines = renderTranscript(normalized, ctx, top);
  else if (input.viewState.view === "tasks") lines = renderTasks(normalized, ctx, top);
  else lines = renderDag(normalized, ctx, top);
  return lines.map((line) => serialize(line, cols, input.mode));
}
