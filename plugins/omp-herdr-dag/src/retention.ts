import type { Stats } from "node:fs";
import { readdir, lstat, rm } from "node:fs/promises";
import { join } from "node:path";

export interface RetentionOptions {
  root: string;
  currentSessionId: string;
  retentionDays: number;
  now?: number;
}

/** Remove old session directories while preserving the active session. */
export async function pruneRetention(options: RetentionOptions): Promise<string[]> {
  const cutoff = (options.now ?? Date.now()) - options.retentionDays * 24 * 60 * 60 * 1_000;
  let names: string[];
  try {
    names = await readdir(options.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (name === options.currentSessionId) continue;
    const path = join(options.root, name);
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
    const pending = [path];
    let newest = info.mtimeMs;
    while (pending.length && newest < cutoff) {
      const directory = pending.pop() as string;
      for (const child of await readdir(directory)) {
        const childPath = join(directory, child);
        const childInfo = await lstat(childPath);
        newest = Math.max(newest, childInfo.mtimeMs);
        if (childInfo.isDirectory()) pending.push(childPath);
      }
    }
    if (newest >= cutoff) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
