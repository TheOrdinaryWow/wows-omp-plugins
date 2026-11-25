import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import type { TodoPhase, TodoStatus, TodoToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { type JSXNode, nativeRendering, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspCardStatus, TspChecklistItem } from "@oh-my-pi/pi-wire";

import { h, span } from "#src/tsp.ts";

interface TodoOp {
  op?: unknown;
  task?: unknown;
  phase?: unknown;
  items?: unknown;
}
type TodoArgs = TodoOp & { ops?: unknown };
interface TodoResult {
  content: readonly { type: string; text?: string }[];
  details?: unknown;
  isError?: boolean;
}

const STATUS: Record<TodoStatus, TspChecklistItem["status"]> = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
  abandoned: "dropped",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `verb [task | N tasks] [phase] [N items]` for each op of streaming, single-op or legacy batch args. */
function callTarget(args: TodoArgs | undefined): string {
  const ops: TodoOp[] = Array.isArray(args?.ops)
    ? args.ops.filter((entry): entry is TodoOp => !!entry && typeof entry === "object")
    : typeof args?.op === "string"
      ? [args]
      : [];
  const described = ops.map((op) => {
    const tasks =
      typeof op.task === "string"
        ? [op.task].filter(Boolean)
        : Array.isArray(op.task)
          ? op.task.filter((t) => typeof t === "string" && t)
          : [];
    return [
      typeof op.op === "string" ? op.op : "update",
      tasks.length === 1 ? String(tasks[0]) : tasks.length > 1 ? plural(tasks.length, "task") : undefined,
      typeof op.phase === "string" && op.phase ? op.phase : undefined,
      Array.isArray(op.items) && op.items.length ? plural(op.items.length, "item") : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  });
  return described.length ? described.join(", ") : "update";
}

function card(target: string | undefined, status: TspCardStatus, body: readonly JSXNode[]): UiNode {
  return h(
    "tool",
    { name: "todo", title: "Todo", frame: "inline", status, ...(target ? { target, targetKind: "text" as const } : {}) },
    ...body,
  );
}

function isClosed(status: TodoStatus): boolean {
  return status === "completed" || status === "abandoned";
}

function resultView(result: TodoResult, expanded: boolean): UiNode {
  const text = result.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
  if (result.isError)
    return card(undefined, "error", [h("text", { spans: [span(text || "Todo operation failed", "error")], wrap: "word" })]);
  const details = (result.details ?? {}) as Partial<TodoToolDetails>;
  const phases: readonly TodoPhase[] = (details.phases ?? []).filter((phase) => phase.tasks.length > 0);
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) return card(undefined, "done", [h("text", { spans: [span(text || "No todos", "muted")], wrap: "word" })]);
  const closed = tasks.filter((task) => isClosed(task.status)).length;
  return card(`${closed}/${tasks.length}`, "done", [
    h("checklist", {
      key: "checklist",
      mode: "full",
      phases: phases.map((phase, p) => ({
        id: `p${p}`,
        title: phase.name,
        items: phase.tasks.map((task, t) => ({ id: `p${p}.${t}`, text: task.content, status: STATUS[task.status] })),
        collapsed: !expanded && phase.tasks.every((task) => isClosed(task.status)),
      })),
    }),
  ]);
}

/**
 * Render hooks of the `todo` override. A same-named extension tool with hooks keeps the built-in todo presenter as its
 * base view and draws its hooks over it, so in Tern both hooks draw nothing and the native todo card shows as is. The
 * terminal paints only what the hooks draw, so there they draw the todo card from the result's phases.
 */
export const todoCard = {
  renderCall(args: TodoArgs): UiNode | undefined {
    return nativeRendering() ? undefined : card(callTarget(args), "running", []);
  },
  renderResult(result: TodoResult, options: ToolRenderResultOptions): UiNode | undefined {
    return nativeRendering() ? undefined : resultView(result, options.expanded);
  },
  mergeCallAndResult: true,
};
