import type { JudgmentRequest } from "@oh-my-pi/pi-ai";
import type { JudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";

import type { CacheState } from "#src/report.ts";

/** Wrap this search's cache reference, never the process-wide instance's methods. */
export function accountCache(shared: JudgmentCache | undefined, disabled: boolean) {
  const state: CacheState = { mode: disabled ? "off" : shared ? "on" : "unavailable", cached: 0, total: 0 };
  const cache =
    !disabled && shared
      ? new Proxy(shared, {
          get(target, key) {
            if (key === "lookup") {
              return (model: string, request: JudgmentRequest) => {
                const result = target.lookup(model, request);
                const ids = Object.keys(request.questions);
                state.total += ids.length;
                state.cached += ids.filter((id) => result.answers[id] !== undefined).length;
                return result;
              };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : undefined;
  return {
    state,
    cache,
    requested(request: JudgmentRequest): void {
      if (state.mode !== "on") state.total += Object.keys(request.questions).length;
    },
  };
}
