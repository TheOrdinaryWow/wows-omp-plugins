import { type DagEdge, type DagNode, isTerminal, type Run } from "./model.ts";

export interface LayoutNode {
  id: string;
  node?: DagNode;
  dummy: boolean;
  layer: number;
  order: number;
  width: number;
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
  edges: RoutedEdge[];
}
export interface LayoutOptions {
  foldCompleted: boolean;
  width: number;
  now?: number;
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

function minimizeCrossings(layers: LayoutLayer[], edges: RoutedEdge[]): void {
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
      layer.nodes.sort((a, b) => (centers.get(a.id) ?? 0) - (centers.get(b.id) ?? 0) || a.id.localeCompare(b.id));
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
  const layers: LayoutLayer[] = [];
  const placed = new Map<string, LayoutNode>();
  for (const node of [...run.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const layer = levels.get(node.id) as number;
    const item: LayoutNode = {
      id: node.id,
      node,
      layer,
      order: 0,
      dummy: false,
      width: Math.max(1, Math.min(32, options.width)),
      backReferences: [],
    };
    placed.set(node.id, item);
    layers[layer] ??= { index: layer, band: node.band, bandName: node.bandName, nodes: [], folded: false };
    layers[layer].nodes.push(item);
  }
  const dummies: LayoutNode[] = [];
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
        const dummy: LayoutNode = {
          id: `dummy:${edge.kind}:${edge.from}:${edge.to}:${layer}`,
          dummy: true,
          layer,
          order: 0,
          width: 1,
          backReferences: [],
        };
        layers[layer] ??= { index: layer, band: source.node?.band ?? 0, bandName: source.node?.bandName ?? "", nodes: [], folded: false };
        (layers[layer] as LayoutLayer).nodes.push(dummy);
        dummies.push(dummy);
        points.push(dummy.id);
      }
    }
    points.push(target.id);
    edges.push({ edge, points, backward });
  }
  const compact = layers.filter(Boolean);
  minimizeCrossings(compact, edges);
  const folded: FoldedLayer[] = [];
  if (options.foldCompleted) {
    for (const layer of compact) {
      const real = layer.nodes.flatMap((node) => (node.node ? [node.node] : []));
      if (!real.length || !real.every((node) => isTerminal(node.state))) continue;
      layer.folded = true;
      folded.push({
        layer: layer.index,
        band: layer.band,
        bandName: layer.bandName,
        count: real.length,
        nodeIds: real.map((node) => node.id),
      });
    }
  }
  return { layers: compact, dummies, criticalPath: weightedPath(run.nodes, depends, options.now ?? Date.now()), folded, edges };
}
