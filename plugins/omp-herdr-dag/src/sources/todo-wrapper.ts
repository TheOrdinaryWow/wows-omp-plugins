import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";

import { type TodoDependency, type TodoPhase, validateTodoEdges } from "#src/model.ts";

import { TODO_EDGES_ENTRY, type TodoEdgesEntry, todoGeneration } from "./todo.ts";

export interface TodoWrapperOptions {
  onEdges: (data: TodoEdgesEntry, ctx: ExtensionContext) => void;
  enabled: boolean | ((ctx: ExtensionContext) => boolean);
}

/** Same-name delegation preserves native mutations, errors, details, hooks and rendering. */
export function registerTodoWrapper(pi: ExtensionAPI, options: TodoWrapperOptions): void {
  if (options.enabled === false) return;
  const { Type } = pi.typebox;
  const parameters = Type.Object({
    op: Type.Union(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"].map((op) => Type.Literal(op))),
    list: Type.Optional(Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String(), { minItems: 1 }) }))),
    task: Type.Optional(Type.String()),
    phase: Type.Optional(Type.String()),
    items: Type.Optional(Type.Array(Type.String())),
    reason: Type.Optional(Type.String()),
    edges: Type.Optional(Type.Array(Type.Object({ task: Type.String(), after: Type.Array(Type.String()) }))),
  });
  const renderer = toolRenderers.todo;
  if (!renderer?.renderCall || !renderer.renderResult) throw new Error("The native todo renderer is unavailable.");
  // The host's generic renderer interface permits undefined; the native todo renderer always returns a component.
  const renderCall = renderer.renderCall as NonNullable<ToolDefinition<typeof parameters>["renderCall"]>;
  const renderResult = renderer.renderResult as NonNullable<ToolDefinition<typeof parameters>["renderResult"]>;
  let warnedMissingInvoke = false;
  const definition = {
    name: "todo",
    label: "Todo",
    description: `${new TodoTool({} as ToolSession).description}\nOptional edges declare explicit dependencies by verbatim task content; invalid dependencies are dropped with a warning.`,
    parameters,
    approval: "read" as const,
    strict: true,
    lenientArgValidation: true,
    concurrency: "exclusive",
    loadMode: "discoverable" as const,
    renderCall,
    renderResult,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!ctx.invokeTool) {
        const text = "Herdr DAG cannot delegate todo: the native todo tool is not available in this session.";
        if (!warnedMissingInvoke) {
          warnedMissingInvoke = true;
          pi.logger.warn(text);
        }
        return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
      }
      const { edges: inputEdges, ...nativeArgs } = params;
      const result = await ctx.invokeTool(nativeArgs);
      if ((typeof options.enabled === "function" && !options.enabled(ctx)) || result.isError) return result;
      const details = result.details as { op?: string; phases?: TodoPhase[] } | undefined;
      if (details?.op === "view" || !Array.isArray(details?.phases)) return result;
      const branch = ctx.sessionManager.getBranch();
      let generation = todoGeneration(branch);
      if (details.op === "init") generation++;
      else if (!generation && details.phases.some((phase) => phase.tasks.length > 0)) generation = 1;
      if (!generation) return result;
      let previous: TodoDependency[] = [];
      if (details.op !== "init") {
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry?.type !== "custom" || entry.customType !== TODO_EDGES_ENTRY) continue;
          const data = entry.data as TodoEdgesEntry | undefined;
          if (data?.v === 1 && data.generation === generation && Array.isArray(data.edges)) {
            previous = data.edges;
            break;
          }
        }
      }
      const validated = validateTodoEdges(details.phases, inputEdges === undefined ? previous : inputEdges);
      options.onEdges({ v: 1, generation, edges: validated.edges }, ctx);
      // Pruning removed tasks is normal; warnings are for explicit invalid metadata only.
      if (inputEdges === undefined || !validated.warnings.length) return result;
      const warning = `Herdr DAG edges: ${validated.warnings.join(" ")}`;
      const content = [...result.content];
      const index = content.findLastIndex((item) => item.type === "text");
      const last = content[index];
      if (last?.type === "text") content[index] = { ...last, text: `${last.text}\n${warning}` };
      else content.push({ type: "text", text: warning });
      return { ...result, content };
    },
  };
  pi.registerTool(definition);
}
