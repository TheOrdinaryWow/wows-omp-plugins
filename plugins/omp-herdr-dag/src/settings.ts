import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

import type { LayoutAlign } from "./model.ts";

export interface PluginSettings {
  displayTiming: "never" | "any-todo" | "plan-execution" | "atlas-only";
  finishBehavior: "close-with-omp" | "keep-open";
  landscapePosition: "left" | "right" | "top" | "bottom";
  portraitPosition: "left" | "right" | "top" | "bottom";
  landscapeSize: number;
  portraitSize: number;
  followOrientation: boolean;
  focusPane: boolean;
  stalledAfterSeconds: number;
  todoDependencies: boolean;
  atlasIntegration: boolean;
  followTheme: boolean;
  colorTodo: string;
  colorPlan: string;
  colorAtlas: string;
  retentionDays: number;
  layoutAlign: LayoutAlign;
  viewerRuntime: string;
}

export const DEFAULT_SETTINGS: Readonly<PluginSettings> = {
  displayTiming: "plan-execution",
  finishBehavior: "close-with-omp",
  landscapePosition: "right",
  portraitPosition: "bottom",
  landscapeSize: 0.35,
  portraitSize: 0.4,
  followOrientation: true,
  focusPane: false,
  stalledAfterSeconds: 90,
  todoDependencies: true,
  atlasIntegration: true,
  followTheme: true,
  colorTodo: "#4f8cff",
  colorPlan: "#a371f7",
  colorAtlas: "#3fb950",
  retentionDays: 14,
  layoutAlign: "centered",
  viewerRuntime: "",
};

const validators: Record<keyof PluginSettings, (value: unknown) => boolean> = {
  displayTiming: (value: unknown) => typeof value === "string" && ["never", "any-todo", "plan-execution", "atlas-only"].includes(value),
  finishBehavior: (value: unknown) => typeof value === "string" && ["close-with-omp", "keep-open"].includes(value),
  landscapePosition: (value: unknown) => typeof value === "string" && ["left", "right", "top", "bottom"].includes(value),
  portraitPosition: (value: unknown) => typeof value === "string" && ["left", "right", "top", "bottom"].includes(value),
  landscapeSize: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0.15 && value <= 0.6,
  portraitSize: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0.15 && value <= 0.6,
  followOrientation: (value: unknown) => typeof value === "boolean",
  focusPane: (value: unknown) => typeof value === "boolean",
  stalledAfterSeconds: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 10 && value <= 900,
  todoDependencies: (value: unknown) => typeof value === "boolean",
  atlasIntegration: (value: unknown) => typeof value === "boolean",
  followTheme: (value: unknown) => typeof value === "boolean",
  colorTodo: (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value),
  colorPlan: (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value),
  colorAtlas: (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value),
  retentionDays: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 365,
  layoutAlign: (value: unknown) => value === "centered" || value === "left",
  viewerRuntime: (value: unknown) => typeof value === "string",
};

const warned = new Set<string>();

/** Invalid fields fall back independently; warn only once for each project scope. */
export async function readSettings(cwd: string, warn: (message: string) => void = console.warn): Promise<PluginSettings> {
  const settings = { ...DEFAULT_SETTINGS };
  const invalid: string[] = [];
  try {
    const raw = await getPluginSettings("wows-omp-plugin-omp-herdr-dag", cwd);
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PluginSettings)[]) {
      const value = raw[key];
      if (value === undefined) continue;
      if (validators[key](value)) Object.assign(settings, { [key]: value });
      else invalid.push(key);
    }
  } catch (error) {
    invalid.push(error instanceof Error ? error.message : String(error));
  }
  if (invalid.length > 0 && !warned.has(cwd)) {
    warned.add(cwd);
    warn(`Herdr DAG settings invalid; using defaults for: ${invalid.join(", ")}`);
  }
  return settings;
}
