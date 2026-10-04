import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Snapshot } from "./model.ts";

export interface PaneState {
  version: 1;
  phase: "splitting" | "open";
  paneId?: string;
  tabId?: string;
  hostPaneId: string;
  orientation: "landscape" | "portrait";
  position: "left" | "right" | "top" | "bottom";
  launchedAt: number;
  socketPath?: string;
  dismissed: boolean;
}
export interface ViewState {
  version: 1;
  folded: string[];
  view: "dag" | "tasks" | "transcript";
  selectedRun?: string;
  criticalPath: boolean;
}
export const DEFAULT_VIEW_STATE: ViewState = { version: 1, folded: [], view: "dag", criticalPath: false };

/** Only missing, invalid JSON and unknown versions reset; real I/O errors remain visible. */
export async function readVersioned<T extends { version: 1 }>(file: string, fallback?: T): Promise<T | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value && value.version === 1) return value as T;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (fallback) await writeVersioned(file, fallback);
  return fallback;
}

export async function writeVersioned<T extends { version: 1 }>(file: string, value: T): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

// Typed entry points keep persisted contracts identical in the host and standalone viewer.
export const readPane = (file: string): Promise<PaneState | undefined> => readVersioned<PaneState>(file);
export const writePane = (file: string, value: PaneState): Promise<void> => writeVersioned(file, value);
export const readSnapshot = (file: string): Promise<Snapshot | undefined> => readVersioned<Snapshot>(file);
export const writeSnapshot = (file: string, value: Snapshot): Promise<void> => writeVersioned(file, value);
export const readViewState = (file: string): Promise<ViewState | undefined> => readVersioned<ViewState>(file);
export const writeViewState = (file: string, value: ViewState): Promise<void> => writeVersioned(file, value);
