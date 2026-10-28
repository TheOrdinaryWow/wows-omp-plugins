import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isNativeRendering, type TUI } from "@oh-my-pi/pi-tui";

import { FindConsole, FULLSCREEN } from "#src/console.ts";
import type { ConsoleResult, FindProgressController, FindResultsController } from "#src/controller.ts";
import { FindProgress, PROGRESS_OVERLAY } from "#src/progress-view.ts";
import { readUiMenu } from "#src/settings.ts";

export interface MountedConsoleResult {
  choice: ConsoleResult;
  tui: TUI;
}

export async function mountResultsConsole(
  ctx: Pick<ExtensionContext, "ui" | "cwd">,
  controller: FindResultsController,
): Promise<MountedConsoleResult | undefined> {
  let mounted: TUI | undefined;
  const halfScreen = !isNativeRendering() && (await readUiMenu(ctx.cwd)) === "half-screen";
  try {
    const choice = await ctx.ui.custom<ConsoleResult | undefined>(
      (tui, theme, _keys, done) => {
        mounted = tui;
        controller.onAction = done;
        return new FindConsole(controller, theme, tui, halfScreen);
      },
      halfScreen ? { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "50%", margin: 0 } } : FULLSCREEN,
    );
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
    return await ctx.ui.custom<T | undefined>((tui, theme, _keys, done) => {
      void settled.then(done);
      return new FindProgress(controller, theme, tui);
    }, PROGRESS_OVERLAY);
  } finally {
    controller.onChange = undefined;
  }
}
