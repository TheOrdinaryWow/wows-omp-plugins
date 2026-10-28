import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { FindProgressController } from "#src/controller.ts";
import { mountSearchProgress } from "#src/ui.ts";

type Outcome<T> = { value: T } | { error: unknown };

export async function searchWithProgress<T>(
  ctx: ExtensionContext,
  query: string,
  controller: AbortController,
  run: (progress: (message: string) => void) => Promise<T>,
): Promise<T> {
  const progress = new FindProgressController(query, () => controller.abort());
  const work: Promise<Outcome<T>> = run((message) => {
    progress.update(message);
    if (ctx.hasUI && !progress.onChange) ctx.ui.setStatus("find-console", `Find: ${message}`);
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let outcome: Outcome<T> | undefined;
  try {
    if (ctx.hasUI && ctx.mode === "tui") outcome = await mountSearchProgress(ctx, progress, work);
    if (outcome === undefined) {
      if (!ctx.hasUI) outcome = await work;
      else {
        const dismiss = new AbortController();
        try {
          const cancel = ctx.ui
            .select(`Find: ${query}\nSearching; progress is shown in the status line.`, ["Cancel search"], { signal: dismiss.signal })
            .then(async () => {
              if (!dismiss.signal.aborted) progress.cancel();
              return work;
            });
          outcome = await Promise.race([work, cancel]);
        } finally {
          dismiss.abort();
        }
      }
    }
  } catch (error) {
    controller.abort();
    await work;
    throw error;
  } finally {
    if (ctx.hasUI) ctx.ui.setStatus("find-console", undefined);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
