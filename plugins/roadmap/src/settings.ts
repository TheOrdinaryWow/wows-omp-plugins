import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export const PACKAGE_NAME = "wows-omp-plugin-roadmap";

/** `inline` keeps the select/editor dialogs; `fullscreen` opens the console and the fullscreen preview. */
export type UiMenu = "inline" | "fullscreen";
export type UiMenuReader = (cwd: string) => Promise<UiMenu>;

const DEFAULT_UI_MENU: UiMenu = "fullscreen";

export function parseUiMenu(value: unknown): UiMenu {
  if (value === undefined) return DEFAULT_UI_MENU;
  if (value === "inline" || value === "fullscreen") return value;
  throw new Error(`invalid uiMenu ${JSON.stringify(value)}`);
}

/** Reads `uiMenu` from the project-scoped plugin settings on every call; unreadable or invalid values fall back to fullscreen. */
export function uiMenuReader(logger: Pick<ExtensionAPI["logger"], "warn">): UiMenuReader {
  return async (cwd) => {
    try {
      return parseUiMenu((await getPluginSettings(PACKAGE_NAME, cwd)).uiMenu);
    } catch (error) {
      logger.warn("roadmap uiMenu setting is invalid or unreadable; using fullscreen", {
        error: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_UI_MENU;
    }
  };
}

/** `dependency` lists stages in execution order (dependencies first, ties by id); `id` lists them by stage number. */
export type StageOrder = "dependency" | "id";

const DEFAULT_STAGE_ORDER: StageOrder = "dependency";

export function parseStageOrder(value: unknown): StageOrder {
  if (value === undefined) return DEFAULT_STAGE_ORDER;
  if (value === "dependency" || value === "id") return value;
  throw new Error(`invalid stageOrder ${JSON.stringify(value)}`);
}

interface StageOrderContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

/**
 * The stage order every on-screen and agent-facing list uses: a console toggle overrides the project setting for the rest of
 * the session, and the setting is read on every call otherwise. Committed Markdown never depends on it.
 */
export class StageOrderPreference {
  #session: string | undefined;
  #override: StageOrder | undefined;

  constructor(private readonly logger: Pick<ExtensionAPI["logger"], "warn">) {}

  async current(ctx: StageOrderContext): Promise<StageOrder> {
    if (this.#override && this.#session === ctx.sessionManager.getSessionId()) return this.#override;
    try {
      return parseStageOrder((await getPluginSettings(PACKAGE_NAME, ctx.cwd)).stageOrder);
    } catch (error) {
      this.logger.warn("roadmap stageOrder setting is invalid or unreadable; using dependency", {
        error: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_STAGE_ORDER;
    }
  }

  /** Session-only; never written back to the settings. */
  set(ctx: StageOrderContext, order: StageOrder): void {
    this.#session = ctx.sessionManager.getSessionId();
    this.#override = order;
  }
}
