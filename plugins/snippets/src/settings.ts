import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export type MatchingStrategy = "closed" | "open";

export interface SnippetSettings {
  trigger: string;
  matching: MatchingStrategy;
  problem?: string;
}

/** Read on every use: settings belong to the calling workspace, not the process. */
export async function readSnippetSettings(cwd: string): Promise<SnippetSettings> {
  try {
    const settings = await getPluginSettings("wows-omp-plugin-snippets", cwd);
    const trigger = settings.trigger === undefined ? "." : settings.trigger;
    const matching = settings.matching === undefined ? "closed" : settings.matching;
    if (typeof trigger !== "string" || /[\s/!@^#:$`\\]/u.test(trigger)) {
      return {
        trigger: "",
        matching: matching === "open" ? "open" : "closed",
        problem: "Snippet trigger must be a string without whitespace or / ! @ ^ # : $ ` \\. Shortcut expansion is disabled.",
      };
    }
    if (matching !== "closed" && matching !== "open") {
      return { trigger: "", matching: "closed", problem: "Snippet matching must be closed or open. Shortcut expansion is disabled." };
    }
    return { trigger, matching };
  } catch (error) {
    return {
      trigger: "",
      matching: "closed",
      problem: `Snippet settings could not be read; shortcut expansion is disabled: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
