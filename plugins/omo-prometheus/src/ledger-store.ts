import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const queues = new Map<string, Promise<void>>();

/** Serialize a complete read/validate/update transaction, including resume, in this host process. */
export async function withLedgerLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, next);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (queues.get(key) === next) queues.delete(key);
  }
}

/** A failed write never exposes a partial JSON document or destroys the previous ledger. */
export async function writeLedgerAtomic(file: string, data: unknown, createDirectory = true): Promise<void> {
  if (createDirectory) await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const parent = await fs.open(path.dirname(file), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
