import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { logger } from "@oh-my-pi/pi-utils";

import type { PreviewMode } from "#src/report.ts";

export type UiMenu = "fullscreen" | "half-screen";
export const DEFAULT_UI_MENU: UiMenu = "fullscreen";

/** Manifest-backed terminal layout; missing settings use the same fullscreen default as ADR and roadmap. */
export function parseUiMenu(value: unknown): UiMenu {
  if (value === undefined) return DEFAULT_UI_MENU;
  if (value === "fullscreen" || value === "half-screen") return value;
  throw new Error(`invalid uiMenu ${JSON.stringify(value)}`);
}

/** Read each time results mount: plugin settings are project-scoped and can change without restarting. */
export async function readUiMenu(cwd: string): Promise<UiMenu> {
  try {
    return parseUiMenu((await getPluginSettings("wows-omp-plugin-find-console", cwd)).uiMenu);
  } catch (error) {
    logger.warn("find-console uiMenu setting is invalid or unreadable; using fullscreen", {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_UI_MENU;
  }
}

export function parsePreviewMode(value: unknown): PreviewMode {
  if (value === undefined || value === "full-file") return "full-file";
  if (value === "snippet") return value;
  throw new Error(`invalid previewMode ${JSON.stringify(value)}`);
}

export async function readSearchSettings(cwd: string): Promise<{ autoTranslate: boolean; previewMode: PreviewMode }> {
  try {
    const settings = await getPluginSettings("wows-omp-plugin-find-console", cwd);
    if (settings.autoTranslate !== undefined && typeof settings.autoTranslate !== "boolean")
      throw new Error(`invalid autoTranslate ${JSON.stringify(settings.autoTranslate)}`);
    return { autoTranslate: settings.autoTranslate !== false, previewMode: parsePreviewMode(settings.previewMode) };
  } catch (error) {
    logger.warn("find-console search settings are invalid or unreadable; using defaults", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { autoTranslate: true, previewMode: "full-file" };
  }
}
