import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export const TOOLKIT_PACKAGE = "wows-omp-plugin-omo-toolkit";

export interface ToolkitSettings {
  commentChecker: boolean;
  commentCheckerPath: string;
  initDeepAdvisor: boolean;
  fallbackArchitect: boolean;
}

export const DEFAULT_SETTINGS: Readonly<ToolkitSettings> = {
  commentChecker: false,
  commentCheckerPath: "",
  initDeepAdvisor: true,
  fallbackArchitect: false,
};

/** Invalid optional settings disable only the affected feature, not role registration. */
export function parseToolkitSettings(raw: Record<string, unknown>, warn: (message: string) => void): ToolkitSettings {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of ["commentChecker", "initDeepAdvisor", "fallbackArchitect"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === "boolean") settings[key] = value;
    else {
      settings[key] = false;
      warn(`omo-toolkit: invalid ${key} ${JSON.stringify(value)}; feature disabled`);
    }
  }
  if (raw.commentCheckerPath !== undefined) {
    if (typeof raw.commentCheckerPath === "string") settings.commentCheckerPath = raw.commentCheckerPath.trim();
    else {
      settings.commentChecker = false;
      warn(`omo-toolkit: invalid commentCheckerPath ${JSON.stringify(raw.commentCheckerPath)}; comment-checker disabled`);
    }
  }
  return settings;
}

export async function readToolkitSettings(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ToolkitSettings> {
  try {
    return parseToolkitSettings(await getPluginSettings(TOOLKIT_PACKAGE, ctx.cwd), (message) => {
      pi.logger.warn(message);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    });
  } catch (error) {
    pi.logger.warn("omo-toolkit could not load settings; optional runtime features disabled", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_SETTINGS, initDeepAdvisor: false };
  }
}

export type ToolkitSettingsReader = (ctx: ExtensionContext) => Readonly<ToolkitSettings>;
