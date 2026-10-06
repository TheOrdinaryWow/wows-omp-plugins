import { type DagEdge, type DagNode, isTerminal, type LayoutAlign, type Run } from "./model.ts";

/** Character-grid geometry of node boxes and connectors, shared by the wrap decision and the viewer. */
export const GRID = { nodeGap: 2, dummyGap: 2, laneGap: 2, minNode: 20, maxNode: 30 } as const;

/**
 * How far a layer may outgrow the pane before it wraps. The viewer pans and follows the selection, so a layer up to
 * twice the pane's width (or 120 columns, whichever is wider) stays one readable row, with boxes shrunk no further than
 * `GRID.minNode`: four 20-column boxes need 86 columns, so a 50-column pane keeps them in one row, and a 30-column pane
 * keeps three. Only a wider layer wraps, which keeps every row's sideways scroll to about one pane.
 */
export const OVERFLOW = { factor: 2, minimum: 120 } as const;
/** Columns a single row of the graph may span in a pane `width` columns wide. */
export const rowBudget = (width: number): number => Math.max(width * OVERFLOW.factor, OVERFLOW.minimum);

/** Columns a row of `nodes` boxes `nodeWidth` wide plus `dummies` pass-through connectors needs. */
export function rowSpan(nodes: number, dummies: number, nodeWidth: number): number {
  return nodes * nodeWidth + (nodes - 1) * GRID.nodeGap + dummies * (1 + GRID.dummyGap);
}

/** Left margin taken by the vertical lanes of backward edges. */
export function laneMargin(lanes: number): number {
  return lanes ? lanes * GRID.laneGap + 1 : 0;
}

export interface LayoutNode {
  id: string;
  node?: DagNode;
  dummy: boolean;
  layer: number;
  order: number;
  backReferences: Array<{ from: string; label: string }>;
}
export interface LayoutLayer {
  index: number;
  band: number;
  bandName: string;
  nodes: LayoutNode[];
  folded: boolean;
}
export interface FoldedLayer {
  layer: number;
  band: number;
  bandName: string;
  count: number;
  nodeIds: string[];
}
export interface RoutedEdge {
  edge: DagEdge;
  points: string[];
  backward: boolean;
}
export interface RunLayout {
  layers: LayoutLayer[];
  dummies: LayoutNode[];
  criticalPath: string[];
  folded: FoldedLayer[];
  /** Drawn edges: every edge with `allEdges`, otherwise dependencies implied by a longer forward path are left out. */
  edges: RoutedEdge[];
  /** Horizontal placement the renderer applies to the layers. */
  align: LayoutAlign;
}
export interface LayoutOptions {
  foldCompleted: boolean;
  /** Pane columns; a layer that does not fit `rowBudget(width)` at `GRID.minNode` wraps onto extra rows in its band. */
  width: number;
  now?: number;
  /** Draw every dependency instead of the transitive reduction; the critical path always uses every dependency. */
  allEdges?: boolean;
  align?: LayoutAlign;
}

/** Stable Kahn ordering deliberately leaves invalid cyclic nodes for a finite fallback. */
function topological(ids: string[], edges: DagEdge[]): string[] {
  const degree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!degree.has(edge.from) || !degree.has(edge.to)) continue;
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const queue = ids.filter((id) => degree.get(id) === 0).sort();
  const result: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    result.push(id);
    for (const target of outgoing.get(id) ?? []) {
      const count = (degree.get(target) ?? 0) - 1;
      degree.set(target, count);
      if (count === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  return result;
}

function weightedPath(nodes: DagNode[], edges: DagEdge[], now: number): string[] {
  if (!edges.length) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const parents = incoming.get(edge.to) ?? [];
    parents.push(edge.from);
    incoming.set(edge.to, parents);
  }
  const weights = new Map<string, number>();
  const paths = new Map<string, string[]>();
  for (const id of topological(
    nodes.map((node) => node.id),
    edges,
  )) {
    const node = byId.get(id) as DagNode;
    let parent: string | undefined;
    for (const candidate of (incoming.get(id) ?? []).sort()) {
      if (!weights.has(candidate)) continue;
      if (!parent || (weights.get(candidate) as number) > (weights.get(parent) as number)) parent = candidate;
    }
    const weight = node.startedAt === undefined ? 1 : Math.max(0, (node.finishedAt ?? now) - node.startedAt);
    weights.set(id, weight + (parent ? (weights.get(parent) ?? 0) : 0));
    paths.set(id, [...(parent ? (paths.get(parent) ?? []) : []), id]);
  }
  let end: string | undefined;
  for (const id of [...weights.keys()].sort()) {
    if (!end || (weights.get(id) as number) > (weights.get(end) as number)) end = id;
  }
  return end ? (paths.get(end) ?? []) : [];
}

/** Counts inversions between neighboring layers, including dummy segments. */
export function crossingCount(layers: LayoutLayer[], edges: RoutedEdge[]): number {
  const positions = new Map(layers.flatMap((layer) => layer.nodes.map((node, order) => [node.id, { layer: layer.index, order }] as const)));
  const segments = new Map<number, Array<{ from: number; to: number }>>();
  for (const route of edges) {
    if (route.backward) continue;
    for (let index = 1; index < route.points.length; index += 1) {
      const from = positions.get(route.points[index - 1] as string);
      const to = positions.get(route.points[index] as string);
      if (!from || !to || to.layer !== from.layer + 1) continue;
      const group = segments.get(from.layer) ?? [];
      group.push({ from: from.order, to: to.order });
      segments.set(from.layer, group);
    }
  }
  let count = 0;
  for (const group of segments.values()) {
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const first = group[a] as { from: number; to: number };
        const second = group[b] as { from: number; to: number };
        if ((first.from - second.from) * (first.to - second.to) < 0) count += 1;
      }
    }
  }
  return count;
}

/** With `pinned`, real nodes keep their relative order and only dummies move (rows of a wrapped layer). */
function minimizeCrossings(layers: LayoutLayer[], edges: RoutedEdge[], pinned = false): void {
  const neighbors = new Map<string, { before: string[]; after: string[] }>();
  for (const route of edges) {
    if (route.backward) continue;
    for (let index = 1; index < route.points.length; index += 1) {
      const from = route.points[index - 1] as string;
      const to = route.points[index] as string;
      const source = neighbors.get(from) ?? { before: [], after: [] };
      source.after.push(to);
      neighbors.set(from, source);
      const target = neighbors.get(to) ?? { before: [], after: [] };
      target.before.push(from);
      neighbors.set(to, target);
    }
  }
  let best = layers.map((layer) => [...layer.nodes]);
  let bestCount = crossingCount(layers, edges);
  for (let sweep = 0; sweep < 8; sweep += 1) {
    const down = sweep % 2 === 0;
    const orderedLayers = down ? layers : [...layers].reverse();
    for (const layer of orderedLayers) {
      const positions = new Map(layers.flatMap((current) => current.nodes.map((node, order) => [node.id, order] as const)));
      const center = (node: LayoutNode): number => {
        const adjacent = neighbors.get(node.id)?.[down ? "before" : "after"] ?? [];
        return adjacent.length
          ? adjacent.reduce((sum, id) => sum + (positions.get(id) ?? 0), 0) / adjacent.length
          : (positions.get(node.id) ?? 0);
      };
      const centers = new Map(layer.nodes.map((node) => [node.id, center(node)]));
      const real = layer.nodes.filter((node) => !node.dummy);
      layer.nodes.sort((a, b) => (centers.get(a.id) ?? 0) - (centers.get(b.id) ?? 0) || a.id.localeCompare(b.id));
      if (pinned) {
        let next = 0;
        layer.nodes = layer.nodes.map((node) => (node.dummy ? node : (real[next++] as LayoutNode)));
      }
    }
    const count = crossingCount(layers, edges);
    if (count < bestCount) {
      bestCount = count;
      best = layers.map((layer) => [...layer.nodes]);
    }
  }
  layers.forEach((layer, index) => {
    layer.nodes = best[index] as LayoutNode[];
    layer.nodes.forEach((node, order) => {
      node.order = order;
    });
  });
}

interface Placement {
  layers: LayoutLayer[];
  dummies: LayoutNode[];
  edges: RoutedEdge[];
}

/** Puts nodes on their levels and routes forward edges through one dummy per skipped level; equal dummy keys share a dummy. */
function place(run: Run, levels: Map<string, number>, dummyKey: (edge: DagEdge, level: number) => string): Placement {
  const layers: LayoutLayer[] = [];
  const placed = new Map<string, LayoutNode>();
  for (const node of [...run.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const layer = levels.get(node.id) as number;
    const item: LayoutNode = { id: node.id, node, layer, order: 0, dummy: false, backReferences: [] };
    placed.set(node.id, item);
    layers[layer] ??= { index: layer, band: node.band, bandName: node.bandName, nodes: [], folded: false };
    layers[layer].nodes.push(item);
  }
  const dummies = new Map<string, LayoutNode>();
  const edges: RoutedEdge[] = [];
  for (const edge of [...run.edges].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  )) {
    const source = placed.get(edge.from);
    const target = placed.get(edge.to);
    if (!source || !target) continue;
    const backward = target.layer <= source.layer;
    if (backward && edge.kind === "depends") target.backReferences.push({ from: source.id, label: source.node?.label ?? source.id });
    const points = [source.id];
    if (!backward) {
      for (let layer = source.layer + 1; layer < target.layer; layer += 1) {
        const id = `dummy:${dummyKey(edge, layer)}:${layer}`;
        if (!dummies.has(id)) {
          const dummy: LayoutNode = { id, dummy: true, layer, order: 0, backReferences: [] };
          dummies.set(id, dummy);
          layers[layer] ??= { index: layer, band: source.node?.band ?? 0, bandName: source.node?.bandName ?? "", nodes: [], folded: false };
          (layers[layer] as LayoutLayer).nodes.push(dummy);
        }
        points.push(id);
      }
    }
    points.push(target.id);
    edges.push({ edge, points, backward });
  }
  return { layers: layers.filter(Boolean), dummies: [...dummies.values()], edges };
}

/** Long edges of one source share a single trunk: one pass-through connector per layer, branching off at each target. */
const trunkKey = (edge: DagEdge): string => `${edge.kind}:${edge.from}:*`;

/** Wide layer of every node, its row inside that layer, and the row count of every wide layer. */
interface Rows {
  layer: Map<string, number>;
  row: Map<string, number>;
  count: Map<number, number>;
}

/**
 * Connector key of a forward edge on row `at` of wide layer `layer`; undefined when the edge does not pass that row.
 * Nodes without a row yet sit on a later row. An edge leaving a row that is not its layer's last joins the fan-in trunk
 * of its target until it arrives; any other edge joins its source's trunk. A fan-in trunk never feeds a fan-out trunk,
 * so every drawn path between two boxes is one of the run's edges.
 */
function rowKey(edge: DagEdge, layer: number, at: number, rows: Rows): string | undefined {
  const from = rows.layer.get(edge.from) as number;
  const to = rows.layer.get(edge.to) as number;
  const fromRow = rows.row.get(edge.from) ?? Number.POSITIVE_INFINITY;
  const toRow = rows.row.get(edge.to) ?? Number.POSITIVE_INFINITY;
  if (from === to) return layer === from && fromRow < at && at < toRow ? trunkKey(edge) : undefined;
  if (layer < from || layer > to || (layer === from && at <= fromRow) || (layer === to && at >= toRow)) return undefined;
  if (layer === from || fromRow < (rows.count.get(from) ?? 1) - 1) return `${edge.kind}:*:${edge.to}`;
  return trunkKey(edge);
}

/** Splits every unfolded layer wider than the row budget at `GRID.minNode` into rows; undefined when every layer fits. */
function wrapRows(wide: Placement, width: number): Rows | undefined {
  const available = rowBudget(width) - laneMargin(wide.edges.filter((route) => route.backward).length);
  const rows: Rows = { layer: new Map(), row: new Map(), count: new Map() };
  for (const layer of wide.layers) for (const item of layer.nodes) if (item.node) rows.layer.set(item.id, layer.index);
  const edges = wide.edges.map((route) => route.edge);
  let wrapped = false;
  for (const layer of wide.layers) {
    const nodes = layer.nodes.filter((item) => !item.dummy);
    // Greedy rows of consecutive nodes, at most `cap` per row, counting the connectors each row must let through;
    // a node too wide for the budget still gets a row of its own.
    const fill = (cap: number): LayoutNode[][] => {
      for (const item of nodes) rows.row.delete(item.id);
      const result: LayoutNode[][] = [];
      let start = 0;
      while (start < nodes.length) {
        const at = result.length;
        let take = 1;
        for (let count = 2; count <= Math.min(cap, nodes.length - start); count += 1) {
          const candidate = nodes.slice(start, start + count);
          for (const item of candidate) rows.row.set(item.id, at);
          const dummies = new Set(edges.flatMap((edge) => rowKey(edge, layer.index, at, rows) ?? []));
          if (rowSpan(count, dummies.size, GRID.minNode) <= available) take = count;
          for (const item of candidate) rows.row.delete(item.id);
        }
        const row = nodes.slice(start, start + take);
        for (const item of row) rows.row.set(item.id, at);
        result.push(row);
        start += take;
      }
      return result;
    };
    let chosen = layer.folded ? [nodes] : fill(Number.POSITIVE_INFINITY);
    if (chosen.length > 1) {
      wrapped = true;
      // Same number of rows, spread as evenly as possible, so the widest row (and with it the node width) is the smallest.
      for (let cap = Math.ceil(nodes.length / chosen.length); cap < Math.max(...chosen.map((row) => row.length)); cap += 1) {
        const even = fill(cap);
        if (even.length === chosen.length) {
          chosen = even;
          break;
        }
      }
    }
    chosen.forEach((row, at) => {
      for (const item of row) rows.row.set(item.id, at);
    });
    rows.count.set(layer.index, chosen.length);
  }
  return wrapped ? rows : undefined;
}

/**
 * Re-places the run with every wide layer split into its rows; wrapping reorders no node, only connectors. A connector
 * that passes a row runs through the middle of it, so later rows are fed down the centre rather than around the sides.
 */
function wrap(run: Run, wide: Placement, rows: Rows): Placement {
  const levels = new Map<string, number>();
  const rowAt: Array<{ layer: number; at: number }> = [];
  for (const layer of wide.layers) {
    for (const item of layer.nodes) if (item.node) levels.set(item.id, rowAt.length + (rows.row.get(item.id) as number));
    for (let at = 0; at < (rows.count.get(layer.index) as number); at += 1) rowAt.push({ layer: layer.index, at });
  }
  // Every level strictly between the ends of a forward edge is a row that edge passes, so a key always exists.
  const wrapped = place(run, levels, (edge, level) => {
    const { layer, at } = rowAt[level] as { layer: number; at: number };
    return rowKey(edge, layer, at, rows) as string;
  });
  const rank = new Map(
    wide.layers.flatMap((layer) => layer.nodes.filter((item) => !item.dummy)).map((item, index) => [item.id, index] as const),
  );
  const folded = new Set(wide.layers.filter((layer) => layer.folded).flatMap((layer) => layer.nodes.map((item) => item.id)));
  for (const layer of wrapped.layers) {
    const real = layer.nodes.filter((item) => !item.dummy).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const dummies = layer.nodes.filter((item) => item.dummy);
    const middle = Math.ceil(real.length / 2);
    layer.nodes = [...real.slice(0, middle), ...dummies, ...real.slice(middle)];
    layer.folded = layer.nodes.some((item) => folded.has(item.id));
  }
  minimizeCrossings(wrapped.layers, wrapped.edges, true);
  return wrapped;
}

/** Forward dependencies another forward path already implies; drawing them adds lines without adding information. */
function impliedEdges(forward: DagEdge[]): Set<DagEdge> {
  const next = new Map<string, string[]>();
  for (const edge of forward) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const implied = new Set<DagEdge>();
  for (const edge of forward) {
    const stack = (next.get(edge.from) ?? []).filter((id) => id !== edge.to);
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop() as string;
      if (id === edge.to) {
        implied.add(edge);
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
  }
  return implied;
}

/** Bands constrain placement; backward dependencies remain semantic edges, never phase order. */
export function layoutRun(run: Run, options: LayoutOptions): RunLayout {
  const byId = new Map(run.nodes.map((node) => [node.id, node]));
  const depends = run.edges.filter((edge) => edge.kind === "depends" && byId.has(edge.from) && byId.has(edge.to));
  const forward = depends.filter((edge) => (byId.get(edge.to) as DagNode).band >= (byId.get(edge.from) as DagNode).band);
  const levels = new Map<string, number>();
  const bands = [...new Set(run.nodes.map((node) => node.band))].sort((a, b) => a - b);
  let base = 0;
  for (const band of bands) {
    const members = run.nodes
      .filter((node) => node.band === band)
      .map((node) => node.id)
      .sort();
    const within = forward.filter((edge) => byId.get(edge.from)?.band === band && byId.get(edge.to)?.band === band);
    const order = topological(members, within);
    const ordered = new Set(order);
    order.push(...members.filter((id) => !ordered.has(id)));
    for (const id of order) {
      let level = base;
      for (const edge of forward) {
        if (edge.to === id && levels.has(edge.from)) level = Math.max(level, (levels.get(edge.from) as number) + 1);
      }
      levels.set(id, level);
    }
    base = Math.max(...members.map((id) => levels.get(id) as number)) + 1;
  }
  // Drawn edges: dependencies implied by a longer path are dropped unless every edge is requested; the critical path
  // below still weighs every dependency.
  const implied = options.allEdges
    ? new Set<DagEdge>()
    : impliedEdges(forward.filter((edge) => (levels.get(edge.to) as number) > (levels.get(edge.from) as number)));
  const drawn: Run = { ...run, edges: run.edges.filter((edge) => !implied.has(edge)) };
  const wide = place(drawn, levels, trunkKey);
  minimizeCrossings(wide.layers, wide.edges);
  for (const layer of wide.layers) {
    const real = layer.nodes.flatMap((node) => (node.node ? [node.node] : []));
    layer.folded = options.foldCompleted && real.length > 0 && real.every((node) => isTerminal(node.state));
  }
  const rows = wrapRows(wide, options.width);
  const { layers, dummies, edges } = rows ? wrap(drawn, wide, rows) : wide;
  const folded: FoldedLayer[] = layers
    .filter((layer) => layer.folded)
    .map((layer) => {
      const real = layer.nodes.flatMap((node) => (node.node ? [node.node] : []));
      return { layer: layer.index, band: layer.band, bandName: layer.bandName, count: real.length, nodeIds: real.map((node) => node.id) };
    });
  const criticalPath = weightedPath(run.nodes, depends, options.now ?? Date.now());
  return { layers, dummies, criticalPath, folded, edges, align: options.align ?? "centered" };
}
