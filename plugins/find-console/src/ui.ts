import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TUI } from "@oh-my-pi/pi-tui";

import { FindConsole, FindProgress, FULLSCREEN } from "#src/console.ts";
import type { ConsoleResult, FindProgressController, FindResultsController } from "#src/controller.ts";

export interface MountedConsoleResult {
  choice: ConsoleResult;
  tui: TUI;
}

export async function mountResultsConsole(
  ctx: Pick<ExtensionContext, "ui">,
  controller: FindResultsController,
): Promise<MountedConsoleResult | undefined> {
  let mounted: TUI | undefined;
  try {
    const choice = await ctx.ui.custom<ConsoleResult | undefined>((tui, theme, _keys, done) => {
      mounted = tui;
      controller.onAction = done;
      return new FindConsole(controller, theme, tui);
    }, FULLSCREEN);
    return choice && mounted ? { choice, tui: mounted } : undefined;
  } finally {
    controller.onChange = undefined;
    controller.onAction = undefined;
  }
}

export async function mountSearchProgress<T>(
  ctx: Pick<ExtensionContext, "ui">,
  controller: FindProgressController,
  settled: Promise<T>,
): Promise<T | undefined> {
  try {
    return await ctx.ui.custom<T | undefined>((tui, _theme, _keys, done) => {
      void settled.then(done);
      return new FindProgress(controller, tui);
    }, FULLSCREEN);
  } finally {
    controller.onChange = undefined;
  }
}
