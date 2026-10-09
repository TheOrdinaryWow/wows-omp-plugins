import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "#src/host.ts";

/** Serializes every ADR write across worktrees of one clone: `<git common dir>/adr/lock`. */
export async function withAdrLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
  const directory = join(commonDir, "adr");
  await mkdir(directory, { recursive: true });
  return withFileLock(join(directory, "lock"), fn);
}

async function readCounter(file: string, label: string, exactKeys?: string): Promise<number> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    if (error instanceof SyntaxError) throw new Error(`Invalid ${label} at ${file}; ADR allocation paused.`);
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} at ${file}; ADR allocation paused.`);
  const record = value as Record<string, unknown>;
  if (record.v !== 1) throw new Error(`Unsupported ${label} version at ${file}; ADR allocation paused.`);
  if (exactKeys !== undefined && Object.keys(record).sort().join(",") !== exactKeys)
    throw new Error(`Invalid ${label} fields at ${file}; ADR allocation paused.`);
  if (record.adr === undefined && exactKeys === undefined) return 0;
  if (!Number.isSafeInteger(record.adr) || (record.adr as number) < 0)
    throw new Error(`Invalid ${label} value at ${file}; ADR allocation paused.`);
  return record.adr as number;
}

/**
 * The highest ADR number ever allocated in this clone: this plugin's `<common>/adr/counters.json` and, read-only, the
 * `adr` counter the roadmap plugin kept in `<common>/roadmap/counters.json` before ADRs moved here.
 */
export async function allocatedAdrs(commonDir: string): Promise<number> {
  const [own, legacy] = await Promise.all([
    readCounter(join(commonDir, "adr", "counters.json"), "ADR counters", "adr,v"),
    readCounter(join(commonDir, "roadmap", "counters.json"), "roadmap counters"),
  ]);
  return Math.max(own, legacy);
}

/** The caller holds withAdrLock. The roadmap counter file is never written. */
export async function recordAllocated(commonDir: string, highest: number): Promise<void> {
  if (!Number.isSafeInteger(highest) || highest < 1) throw new Error("ADR id counter exhausted.");
  const file = join(commonDir, "adr", "counters.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ v: 1, adr: highest })}\n`, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class Cancelled extends Error {
  constructor() {
    super("ADR operation cancelled.");
  }
}

/** Temp file plus rename; cancellation is checked before each step so an aborted write leaves no partial file. */
export async function atomicWrite(path: string, content: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Cancelled();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (signal?.aborted) throw new Cancelled();
    await writeFile(temporary, content, { flag: "wx" });
    if (signal?.aborted) throw new Cancelled();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
