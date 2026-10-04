import type { PluginSettings } from "./settings.ts";

export interface DisplayTimingState {
  todoActive: boolean;
  planExecuting: boolean;
  atlasBound: boolean;
}

/** Whether an automatic pane evaluation is allowed to open the viewer. */
export function shouldDisplay(timing: PluginSettings["displayTiming"], state: DisplayTimingState): boolean {
  switch (timing) {
    case "never":
      return false;
    case "any-todo":
      return state.todoActive || state.planExecuting || state.atlasBound;
    case "plan-execution":
      return state.planExecuting || state.atlasBound;
    case "atlas-only":
      return state.atlasBound;
  }
}
