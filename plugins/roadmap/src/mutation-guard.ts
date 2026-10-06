import type { Model } from "./documents.ts";
import type { Receipt } from "./operations.ts";

export function guardCancellation(
  options: { signal?: AbortSignal },
  changedFiles?: readonly string[],
): Extract<Receipt, { ok: false }> | undefined {
  if (!options.signal?.aborted) return;
  return {
    ok: false,
    reason: "Roadmap operation cancelled.",
    hints: changedFiles?.length
      ? [
          `Files committed by the interrupted operation: ${changedFiles.join(", ")}.`,
          "Run roadmap_check with fix: true to repair stale generated blocks; restore other partial changes with git, then run roadmap_check again.",
        ]
      : [],
  };
}

export function guardMutation(
  model: Model,
  options: { signal?: AbortSignal; guard?: (model: Model) => Receipt | undefined },
): Receipt | undefined {
  return guardCancellation(options) ?? options.guard?.(model);
}
