import type { Snapshot } from "../src/model.ts";
import type { ViewState } from "../src/persisted.ts";
import { currentRun, type FollowTarget, taskOrder, type UiState, visibleRuns } from "./render.ts";

const sameTarget = (a: FollowTarget, b: FollowTarget): boolean =>
  a.view === "dag" ? b.view === "dag" && a.runId === b.runId && a.nodeId === b.nodeId : b.view === "tasks" && a.taskId === b.taskId;

const taskIdsOf = (target: FollowTarget): readonly string[] => (target.view === "dag" ? target.taskIds : [target.taskId]);

/**
 * The running work to follow. The previous target stays while it runs, then work continuing its task, then the first
 * running node (runs in tab order) or ordinary task, so parallel arrivals and streamed output never move the view.
 */
export function runningTarget(
  snapshot: Snapshot | undefined,
  history: boolean,
  previous: FollowTarget | undefined,
): FollowTarget | undefined {
  const targets: FollowTarget[] = [];
  const claimed = new Set((snapshot?.runs ?? []).flatMap((run) => run.nodes.flatMap((node) => node.taskIds)));
  for (const run of visibleRuns(snapshot, history)) {
    for (const node of run.nodes) {
      if (node.state === "running") targets.push({ view: "dag", runId: run.id, nodeId: node.id, taskIds: node.taskIds });
    }
  }
  for (const task of taskOrder(snapshot?.tasks ?? [])) {
    if (task.status === "running" && !task.nodeId && !claimed.has(task.id)) targets.push({ view: "tasks", taskId: task.id });
  }
  if (!previous) return targets[0];
  const previousTasks = new Set(taskIdsOf(previous));
  return (
    targets.find((target) => sameTarget(previous, target)) ??
    targets.find((target) => taskIdsOf(target).some((id) => previousTasks.has(id))) ??
    targets[0]
  );
}

/**
 * Updates the followed target on a live connection and, while automatic follow is on, switches to its view and run.
 * Selection, folds and the critical-path toggle stay untouched; the renderer only scrolls the target into view. View and
 * run changes are not persisted here: a later user action saves whatever is on screen.
 */
export function followRunning(snapshot: Snapshot | undefined, viewState: ViewState, ui: UiState, live: boolean): void {
  if (!live) return;
  ui.followTarget = runningTarget(snapshot, ui.history, ui.followTarget);
  const target = ui.followTarget;
  if (!ui.autoFollow || !target || viewState.view === "transcript") return;
  if (target.view === "tasks") {
    if (viewState.view !== "tasks") {
      viewState.view = "tasks";
      ui.scrollY = 0;
    }
    return;
  }
  if (viewState.view !== "dag" || currentRun(snapshot, viewState, ui)?.id !== target.runId) {
    viewState.view = "dag";
    viewState.selectedRun = target.runId;
    ui.scrollX = 0;
    ui.scrollY = 0;
  }
}
