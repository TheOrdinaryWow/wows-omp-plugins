import type { ExtensionContext, ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { createRoot, nativeRendering } from "@oh-my-pi/pi-tui";

import { FindConsole, FULLSCREEN, HALF_SCREEN } from "#src/console.ts";
import type { ConsoleResult, FindProgressController, FindResultsController } from "#src/controller.ts";
import { FindProgress, PROGRESS_OVERLAY } from "#src/progress-view.ts";
import { readUiMenu } from "#src/settings.ts";

export interface MountedConsoleResult {
  choice: ConsoleResult;
  ui: ExtensionUiHost;
}

export async function mountResultsConsole(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
  controller: FindResultsController,
): Promise<MountedConsoleResult | undefined> {
  let mounted: ExtensionUiHost | undefined;
  let dispose: (() => void) | undefined;
  const halfScreen = !nativeRendering() && (await readUiMenu(ctx.cwd)) === "half-screen";
  try {
    const choice = await ctx.ui.custom<ConsoleResult | undefined>(
      (ui, _theme, _keys, done) =>
        // The host builds the view outside any reactive owner; this root's computations end with the console.
        createRoot((release) => {
          dispose = release;
          mounted = ui;
          controller.onAction = done;
          return new FindConsole(controller, ui, halfScreen).view();
        }),
      halfScreen ? HALF_SCREEN : FULLSCREEN,
    );
    return choice && mounted ? { choice, ui: mounted } : undefined;
  } finally {
    dispose?.();
    controller.onChange = undefined;
    controller.onAction = undefined;
  }
}

export async function mountSearchProgress<T>(
  ctx: Pick<ExtensionContext, "ui">,
  controller: FindProgressController,
  settled: Promise<T>,
): Promise<T | undefined> {
  let view: FindProgress | undefined;
  let dispose: (() => void) | undefined;
  try {
    return await ctx.ui.custom<T | undefined>(
      (_ui, _theme, _keys, done) =>
        createRoot((release) => {
          dispose = release;
          void settled.then(done);
          view = new FindProgress(controller);
          return view.view();
        }),
      PROGRESS_OVERLAY,
    );
  } finally {
    dispose?.();
    view?.dispose();
    controller.onChange = undefined;
  }
}
