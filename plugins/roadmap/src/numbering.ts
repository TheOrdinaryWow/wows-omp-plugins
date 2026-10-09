import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Repo } from "./documents.ts";
import { withFileLock } from "./host.ts";

export type IdKind = "round" | "stage" | "todo";
/** `adr` stays in the file untouched: older roadmap releases and the adr plugin's legacy seeding still read it. */
interface Counters {
  v: 1;
  round: number;
  stage: number;
  todo: number;
  adr: number;
}

export async function withRepoLock<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
  const directory = join(repo.commonDir, "roadmap");
  await mkdir(directory, { recursive: true });
  return withFileLock(join(directory, "lock"), fn);
}

/** The caller holds withRepoLock for the entire allocation and document mutation. Never nests a lock. */
export async function allocate(repo: Repo, kind: IdKind, onDisk: number): Promise<number> {
  if (!["round", "stage", "todo"].includes(kind)) throw new Error("Unknown roadmap id kind.");
  if (!Number.isSafeInteger(onDisk) || onDisk < 0) throw new Error("Highest on-disk id must be a non-negative safe integer.");
  const directory = join(repo.commonDir, "roadmap");
  const file = join(directory, "counters.json");
  let counters: Counters = { v: 1, round: 0, stage: 0, todo: 0, adr: 0 };
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid roadmap counters; allocation paused.");
    const record = value as Record<string, unknown>;
    if (record.v !== 1) throw new Error("Unsupported roadmap counter version; allocation paused.");
    if (Object.keys(record).sort().join(",") !== "adr,round,stage,todo,v")
      throw new Error("Invalid roadmap counter fields; allocation paused.");
    for (const key of ["round", "stage", "todo", "adr"]) {
      if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0)
        throw new Error("Invalid roadmap counter value; allocation paused.");
    }
    counters = record as unknown as Counters;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = Math.max(counters[kind], onDisk) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Roadmap id counter exhausted.");
  counters[kind] = next;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(counters)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return next;
}
