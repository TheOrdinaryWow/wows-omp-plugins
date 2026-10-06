import type { Model } from "./documents.ts";
import type { Receipt } from "./operations.ts";

export function guardMutation(
  model: Model,
  options: { signal?: AbortSignal; guard?: (model: Model) => Receipt | undefined },
): Receipt | undefined {
  if (options.signal?.aborted) return { ok: false, reason: "Roadmap operation cancelled.", hints: [] };
  return options.guard?.(model);
}
