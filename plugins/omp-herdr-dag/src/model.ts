import { createHash } from "node:crypto";

export type Source = "todo" | "plan" | "atlas";
export type NodeState = "pending" | "running" | "done" | "failed" | "blocked" | "abandoned";
export interface DagNode {
  id: string;
  label: string;
  state: NodeState;
  band: number;
  bandName: string;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  agent?: string;
  taskIds: string[];
  stalled?: boolean;
}
export interface DagEdge {
  from: string;
  to: string;
  kind: "depends" | "fix";
}
export interface Run {
  id: string;
  source: Source;
  title: string;
  generation: number;
  nodes: DagNode[];
  edges: DagEdge[];
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  stats: { done: number; total: number; elapsedMs: number; tokens?: number; costUsd?: number };
}
export interface ActivationTotals {
  tokens?: number;
  costUsd?: number;
  durationMs: number;
}
export interface TaskCard {
  id: string;
  parentTaskId?: string;
  nodeId?: string;
  agent: string;
  status: "running" | "completed" | "failed" | "aborted";
  stalled?: boolean;
  description?: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput: string[];
  completed: ActivationTotals;
  current: ActivationTotals;
  activations: number;
  model?: string;
  retry?: { attempt: number; maxAttempts: number; errorMessage: string };
  sessionFile?: string;
  startedAt: number;
  finishedAt?: number;
  detached?: boolean;
  depth: number;
  activityAvailable: boolean;
}
export interface ThemeColors {
  text: string;
  muted: string;
  dim: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  border: string;
  borderAccent: string;
  borderMuted: string;
  background?: string;
}
/** Horizontal placement of the DAG: a tree centred on a common axis, or a compact tree anchored at the left margin. */
export type LayoutAlign = "centered" | "left";
export interface Snapshot {
  version: 2;
  sessionId: string;
  sessionName?: string;
  generation: number;
  connected: boolean;
  at: number;
  runs: Run[];
  tasks: TaskCard[];
  theme: ThemeColors;
  sources: { todo: string; plan: string; atlas: string };
  atlasAvailable: boolean;
  /** Absent in snapshots written before the setting existed; the viewer then centres the graph. */
  layoutAlign?: LayoutAlign;
}

export interface TodoPhase {
  name: string;
  tasks: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked" }>;
}
export interface TodoDependency {
  task: string;
  after: string[];
}
export interface TodoRunOptions {
  sessionId: string;
  generation: number;
  phases: TodoPhase[];
  previous?: Run;
  source?: "todo" | "plan";
  title?: string;
  edges?: TodoDependency[];
  now?: number;
}
export interface AtlasRow {
  id: string;
  title: string;
  status: "open" | "in_progress" | "done" | "blocked";
  kind: "task" | "fix" | "gate";
  agent: string;
  dispatchAgent?: string;
  dependsOn: string[];
  evidence?: string;
  attempt?: string;
  startedAt?: number;
  childAgentId?: string;
  updatedAt: number;
  origin?: string;
}
export interface AtlasRunOptions {
  plan: { id: string; name: string };
  rows: AtlasRow[];
  previous?: Run;
  generation?: number;
  startedAt?: number;
  at?: number;
}

export const isTerminal = (state: NodeState): boolean => state === "done" || state === "abandoned" || state === "failed";

/** User content must not be able to change terminal state, title, or cursor position. */
export function sanitizeText(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally remove OSC control bytes.
      .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally remove control strings.
      .replace(/(?:\x1bP|\x1bX|\x1b\^|\x1b_|\x90|\x98|\x9e|\x9f)[\s\S]*?(?:\x1b\\|\x9c)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally remove CSI control bytes.
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally remove ESC control bytes.
      .replace(/\x1b[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally remove non-printable bytes.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
  );
}

/** Validate incrementally so a bad edge never discards unrelated valid dependencies. */
export function validateTodoEdges(phases: TodoPhase[], input: unknown): { edges: TodoDependency[]; warnings: string[] } {
  const names = new Set(phases.flatMap((phase) => phase.tasks.map((task) => task.content)));
  const outgoing = new Map<string, Set<string>>();
  const accepted = new Map<string, string[]>();
  const warnings: string[] = [];
  if (!Array.isArray(input)) return { edges: [], warnings: input === undefined ? [] : ["Malformed edges were dropped."] };
  const reaches = (start: string, target: string): boolean => {
    const pending = [start];
    const seen = new Set<string>();
    while (pending.length) {
      const node = pending.pop() as string;
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      pending.push(...(outgoing.get(node) ?? []));
    }
    return false;
  };
  for (const entry of input) {
    if (!entry || typeof entry.task !== "string" || !Array.isArray(entry.after)) {
      warnings.push("Malformed edge was dropped.");
      continue;
    }
    for (const after of entry.after) {
      if (typeof after !== "string" || !names.has(entry.task) || !names.has(after)) {
        warnings.push("Unknown or malformed dependency was dropped.");
        continue;
      }
      if (reaches(entry.task, after)) {
        warnings.push(`Cyclic dependency ${after} → ${entry.task} was dropped.`);
        continue;
      }
      const targets = outgoing.get(after) ?? new Set<string>();
      targets.add(entry.task);
      outgoing.set(after, targets);
      const sources = accepted.get(entry.task) ?? [];
      if (!sources.includes(after)) sources.push(after);
      accepted.set(entry.task, sources);
    }
  }
  return { edges: [...accepted].map(([task, after]) => ({ task, after })), warnings };
}

export function todoRun(options: TodoRunOptions): Run {
  const { sessionId, generation, phases, previous } = options;
  const now = options.now ?? Date.now();
  const id = `todo:${sessionId}:${generation}`;
  const prior = previous?.id === id ? previous : undefined;
  const oldNodes = new Map(prior?.nodes.map((node) => [node.id, node]));
  const states = { pending: "pending", in_progress: "running", completed: "done", abandoned: "abandoned", blocked: "blocked" } as const;
  const nodes = phases.flatMap((phase, band) =>
    phase.tasks.map((task): DagNode => {
      const nodeId = `todo:${generation}:${band}:${createHash("sha1").update(task.content).digest("hex").slice(0, 10)}`;
      const old = oldNodes.get(nodeId);
      const state = states[task.status];
      return {
        id: nodeId,
        label: task.content,
        state,
        band,
        bandName: phase.name,
        taskIds: old?.taskIds ?? [],
        startedAt: old?.startedAt ?? (state === "running" ? now : undefined),
        finishedAt: isTerminal(state) ? (old?.finishedAt ?? now) : undefined,
        agent: old?.agent,
        detail: old?.detail,
      };
    }),
  );
  const ids = new Map(nodes.map((node) => [node.label, node.id]));
  const edges: DagEdge[] =
    options.edges === undefined
      ? (prior?.edges ?? []).filter((edge) => nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to))
      : validateTodoEdges(phases, options.edges).edges.flatMap((entry) =>
          entry.after.map((after) => ({
            from: ids.get(after) as string,
            to: ids.get(entry.task) as string,
            kind: "depends" as const,
          })),
        );
  const run: Run = {
    id,
    source: options.source ?? prior?.source ?? "todo",
    title: options.title ?? prior?.title ?? "Todos",
    generation,
    nodes,
    edges,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
    stats: { done: 0, total: nodes.length, elapsedMs: 0 },
    finishedAt: nodes.length && nodes.every((node) => isTerminal(node.state)) ? (prior?.finishedAt ?? now) : undefined,
  };
  run.stats = runStats(run, [], now);
  return run;
}

export function atlasRun(options: AtlasRunOptions): Run {
  const now = options.at ?? Date.now();
  const previous = options.previous?.id === `atlas:${options.plan.id}` ? options.previous : undefined;
  const oldNodes = new Map(previous?.nodes.map((node) => [node.id, node]));
  const states = { open: "pending", in_progress: "running", done: "done", blocked: "blocked" } as const;
  const bands = { task: 0, fix: 1, gate: 2 };
  const names = { task: "Tasks", fix: "Fixes", gate: "Final gates" };
  const nodes = options.rows.map((row): DagNode => {
    const id = `atlas:${row.id}`;
    const old = oldNodes.get(id);
    return {
      id,
      label: `${row.id}. ${row.title}`,
      state: states[row.status],
      band: bands[row.kind],
      bandName: names[row.kind],
      // Completed rows prefix the summary with the absolute evidence receipt path, which is noise in a narrow pane.
      detail: row.evidence?.replace(/^.*?[\\/]evidence[\\/][\w-]+\.md: /, ""),
      agent: row.dispatchAgent ?? row.agent,
      startedAt: row.startedAt ?? old?.startedAt,
      finishedAt: row.status === "done" ? (old?.finishedAt ?? row.updatedAt) : undefined,
      taskIds: [...new Set([...(old?.taskIds ?? []), ...(row.childAgentId ? [row.childAgentId] : [])])],
    };
  });
  const ids = new Set(options.rows.map((row) => row.id));
  const edges = options.rows.flatMap((row): DagEdge[] => [
    ...row.dependsOn.filter((id) => ids.has(id)).map((id): DagEdge => ({ from: `atlas:${id}`, to: `atlas:${row.id}`, kind: "depends" })),
    ...(row.kind === "fix" && row.origin && ids.has(row.origin)
      ? [{ from: `atlas:${row.id}`, to: `atlas:${row.origin}`, kind: "fix" as const }]
      : []),
  ]);
  const run: Run = {
    id: `atlas:${options.plan.id}`,
    source: "atlas",
    title: options.plan.name,
    generation: options.generation ?? 0,
    nodes,
    edges,
    createdAt: options.startedAt ?? previous?.createdAt ?? now,
    updatedAt: now,
    finishedAt: nodes.length && nodes.every((node) => isTerminal(node.state)) ? (previous?.finishedAt ?? now) : undefined,
    stats: { done: 0, total: nodes.length, elapsedMs: 0 },
  };
  run.stats = runStats(run, [], now);
  return run;
}

function sumOptional(a?: number, b?: number): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}
export function taskTotals(task: TaskCard): ActivationTotals {
  return {
    tokens: sumOptional(task.completed.tokens, task.current.tokens),
    costUsd: sumOptional(task.completed.costUsd, task.current.costUsd),
    durationMs: task.completed.durationMs + task.current.durationMs,
  };
}
export interface TaskUpdate {
  id: string;
  status: "started" | "progress" | "completed" | "failed" | "aborted";
  at: number;
  agent?: string;
  detached?: boolean;
  nodeId?: string;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string[];
  model?: string;
  retry?: TaskCard["retry"];
}
/** Each progress counter replaces the current activation, never adds to it. */
export function attachTask(previous: TaskCard | undefined, update: TaskUpdate): TaskCard {
  const task: TaskCard = previous
    ? { ...previous, completed: { ...previous.completed }, current: { ...previous.current } }
    : {
        id: update.id,
        agent: update.agent ?? "agent",
        status: "running",
        recentOutput: [],
        completed: { durationMs: 0 },
        current: { durationMs: 0 },
        activations: 1,
        startedAt: update.at,
        depth: 1,
        activityAvailable: true,
        nodeId: update.nodeId,
      };
  if (update.status === "started" && previous && previous.status !== "running") {
    task.current = { durationMs: 0 };
    task.activations += 1;
    task.startedAt = update.at;
    task.finishedAt = undefined;
    task.currentTool = undefined;
    task.currentToolArgs = undefined;
    task.retry = undefined;
  }
  if (previous && previous.status !== "running" && update.status !== "started") return task;
  task.detached = update.detached ?? task.detached;
  task.agent = update.agent ?? task.agent;
  if (update.tokens !== undefined) task.current.tokens = update.tokens;
  if (update.costUsd !== undefined) task.current.costUsd = update.costUsd;
  if (update.durationMs !== undefined) task.current.durationMs = update.durationMs;
  task.currentTool = update.currentTool ?? task.currentTool;
  task.currentToolArgs = update.currentToolArgs ?? task.currentToolArgs;
  task.recentOutput = update.recentOutput ?? task.recentOutput;
  task.model = update.model ?? task.model;
  task.retry = update.retry ?? task.retry;
  task.status = update.status === "started" || update.status === "progress" ? "running" : update.status;
  if (task.status !== "running") {
    task.completed = taskTotals(task);
    task.current = { durationMs: 0 };
    task.finishedAt = update.at;
  }
  return task;
}

export function runStats(run: Run, tasks: readonly TaskCard[], now = Date.now()): Run["stats"] {
  const linked = new Set(run.nodes.flatMap((node) => node.taskIds));
  const seen = new Set<string>();
  let tokens: number | undefined;
  let costUsd: number | undefined;
  for (const task of tasks) {
    if (!linked.has(task.id) || seen.has(task.id)) continue;
    seen.add(task.id);
    const totals = taskTotals(task);
    tokens = sumOptional(tokens, totals.tokens);
    costUsd = sumOptional(costUsd, totals.costUsd);
  }
  const running = run.nodes.some((node) => node.state === "running");
  const end = running ? now : (run.finishedAt ?? Math.max(run.createdAt, ...run.nodes.map((node) => node.finishedAt ?? run.createdAt)));
  return {
    done: run.nodes.filter((node) => node.state === "done" || node.state === "abandoned").length,
    total: run.nodes.length,
    elapsedMs: Math.max(0, end - run.createdAt),
    tokens,
    costUsd,
  };
}
