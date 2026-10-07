import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const PLUGIN_STATE_SCHEMA = "wows-omp-plugins/plugin-state";

/**
 * Per-user root for state files, kept out of projects and session stores:
 * `$XDG_RUNTIME_DIR/wows-omp-plugins`, or `<os tmpdir>/wows-omp-plugins-<uid>` without one.
 */
export function pluginRuntimeDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) return join(runtime, "wows-omp-plugins");
  return join(tmpdir(), `wows-omp-plugins-${process.getuid?.() ?? userInfo().username}`);
}

export function pluginStatePath(sessionId: string, plugin: string): string {
  return join(pluginRuntimeDir(), "plugin-state", sessionId, `${plugin}.json`);
}

/** A shared temp dir lets another user plant the root first, so only a private directory we own is used. */
async function privateRuntimeDir(): Promise<void> {
  const dir = pluginRuntimeDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
    throw new Error(`${dir} is not a private directory owned by the current user`);
  }
}

/** Coalescing, atomic, best-effort publisher of one plugin's per-session state file. */
export class PluginStatePublisher {
  readonly #plugin: string;
  readonly #onError: (error: unknown, sessionId: string) => void;
  readonly #delayMs: number;
  readonly #pending = new Map<string, { sessionId: string; state: unknown }>();
  readonly #seq = new Map<string, number>();
  #timer?: ReturnType<typeof setTimeout>;
  #writing: Promise<void> = Promise.resolve();

  constructor(plugin: string, onError: (error: unknown, sessionId: string) => void, delayMs = 100) {
    this.#plugin = plugin;
    this.#onError = onError;
    this.#delayMs = delayMs;
  }

  publish(sessionId: string, state: unknown): void {
    this.#pending.set(pluginStatePath(sessionId, this.#plugin), { sessionId, state });
    this.#timer ??= setTimeout(() => void this.flush(), this.#delayMs);
  }

  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = [...this.#pending];
    this.#pending.clear();
    this.#writing = this.#writing.then(async () => {
      for (const [file, { sessionId, state }] of batch) {
        const seq = (this.#seq.get(file) ?? 0) + 1;
        this.#seq.set(file, seq);
        const envelope = {
          schema: PLUGIN_STATE_SCHEMA,
          version: 1,
          plugin: this.#plugin,
          sessionId,
          seq,
          updatedAt: new Date().toISOString(),
          state,
        };
        const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await privateRuntimeDir();
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          await writeFile(temp, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
          await rename(temp, file);
        } catch (error) {
          this.#onError(error, sessionId);
        } finally {
          await rm(temp, { force: true }).catch((error: unknown) => this.#onError(error, sessionId));
        }
      }
    });
    await this.#writing;
  }
}
