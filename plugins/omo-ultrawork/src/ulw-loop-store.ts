import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout } from "node:timers/promises";

import { LoopError, type LoopState, requireLoop, upgradeLoopState } from "#src/ulw-loop-state.ts";

const queues = new Map<string, Promise<void>>();

async function atomicJson(file: string, state: LoopState): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** One session-bound authority; sidecars and project-local directories are never inputs. */
export class LoopStore {
  readonly root: string;
  readonly file: string;
  readonly evidenceRoot: string;
  readonly cwd: string;

  constructor(
    sessionDir: string,
    readonly sessionId: string,
    cwd: string,
  ) {
    requireLoop(
      path.isAbsolute(sessionDir),
      "ULW_LOOP_PERSISTENCE_REQUIRED",
      "ulw-loop requires a persisted session. Open a file-backed session; --no-session cannot hold a durable loop.",
    );
    requireLoop(/^[A-Za-z0-9_-]+$/.test(sessionId), "ULW_LOOP_SESSION_INVALID", "Invalid host session id.");
    this.cwd = path.resolve(cwd);
    this.root = path.join(sessionDir, "ulw-loop", sessionId);
    this.file = path.join(this.root, "state.json");
    this.evidenceRoot = path.join(this.root, "evidence");
  }

  async load(): Promise<LoopState | undefined> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.file, "utf8"));
      return upgradeLoopState(raw, this.sessionId, this.cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const initialized = await fs.stat(this.evidenceRoot).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        requireLoop(
          !initialized,
          "ULW_LOOP_STATE_MISSING",
          `The initialized loop has lost ${this.file}. Preserve its evidence and repair the state; do not create a new aggregate over it.`,
        );
        return undefined;
      }
      if (error instanceof LoopError && error.code.startsWith("ULW_LOOP_STATE_")) throw error;
      throw new LoopError(
        "ULW_LOOP_STATE_INVALID",
        `Cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}. Preserve the file; the loop is paused until repaired.`,
      );
    }
  }

  private async lock<T>(run: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.file) ?? Promise.resolve();
    const { promise: queued, resolve: release } = Promise.withResolvers<void>();
    queues.set(this.file, queued);
    await previous;
    const lockFile = path.join(this.root, ".state.lock");
    const token = randomUUID();
    let held = false;
    try {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 10_000;
      while (!held) {
        try {
          const handle = await fs.open(lockFile, "wx", 0o600);
          held = true;
          try {
            await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
          } finally {
            await handle.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const content = await fs.readFile(lockFile, "utf8");
            const owner: unknown = JSON.parse(content);
            if (
              owner &&
              typeof owner === "object" &&
              "pid" in owner &&
              typeof owner.pid === "number" &&
              Number.isInteger(owner.pid) &&
              owner.pid > 0
            ) {
              try {
                process.kill(owner.pid, 0);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH" && (await fs.readFile(lockFile, "utf8")) === content) {
                  await fs.unlink(lockFile);
                  continue;
                }
              }
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            // A partially written lock may belong to a live writer. Never steal it by age alone.
          }
          requireLoop(
            Date.now() < deadline,
            "ULW_LOOP_STORE_BUSY",
            `Another process owns ${lockFile}. Retry after it settles; inspect an abandoned unreadable lock before removing it.`,
          );
          await setTimeout(20);
        }
      }
      return await run();
    } finally {
      if (held) await fs.rm(lockFile, { force: true });
      release();
      if (queues.get(this.file) === queued) queues.delete(this.file);
    }
  }

  /** Includes load, validation, evidence/journal mutation, and one atomic publication. */
  async update<T>(
    mutate: (state: LoopState | undefined) => Promise<{ state: LoopState; result: T }> | { state: LoopState; result: T },
  ): Promise<T> {
    return await this.lock(async () => {
      const previous = await this.load();
      const revision = previous?.revision;
      const { state, result } = await mutate(previous);
      upgradeLoopState(state, this.sessionId, this.cwd);
      if (!previous || state.revision !== revision) {
        await fs.mkdir(this.evidenceRoot, { recursive: true, mode: 0o700 });
        await atomicJson(this.file, state);
      }
      return result;
    });
  }

  async archive(): Promise<string | undefined> {
    return await this.lock(async () => {
      const state = await this.load();
      if (!state) return undefined;
      const destination = path.join(this.root, "archive", `${state.runId}-${Date.now()}`);
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      try {
        await fs.rename(this.evidenceRoot, path.join(destination, "evidence"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.rename(this.file, path.join(destination, "state.json"));
      return destination;
    });
  }
}
