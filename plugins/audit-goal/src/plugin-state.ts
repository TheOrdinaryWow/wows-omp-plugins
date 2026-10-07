import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_STATE_SCHEMA = "wows-omp-plugins/plugin-state";

export interface PluginStateTarget {
  sessionDir: string;
  sessionId: string;
}

export function pluginStatePath(target: PluginStateTarget, plugin: string): string {
  return join(target.sessionDir, "plugin-state", target.sessionId, `${plugin}.json`);
}

/** Coalescing, atomic, best-effort publisher of one plugin's per-session state file. */
export class PluginStatePublisher {
  readonly #plugin: string;
  readonly #onError: (error: unknown) => void;
  readonly #delayMs: number;
  readonly #pending = new Map<string, { target: PluginStateTarget; state: unknown }>();
  readonly #seq = new Map<string, number>();
  #timer?: NodeJS.Timeout;
  #writing: Promise<void> = Promise.resolve();

  constructor(plugin: string, onError: (error: unknown) => void, delayMs = 100) {
    this.#plugin = plugin;
    this.#onError = onError;
    this.#delayMs = delayMs;
  }

  publish(target: PluginStateTarget, state: unknown): void {
    this.#pending.set(pluginStatePath(target, this.#plugin), { target, state });
    this.#timer ??= setTimeout(() => void this.flush(), this.#delayMs);
  }

  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = [...this.#pending];
    this.#pending.clear();
    this.#writing = this.#writing.then(async () => {
      for (const [file, { target, state }] of batch) {
        const seq = (this.#seq.get(file) ?? 0) + 1;
        this.#seq.set(file, seq);
        const envelope = {
          schema: PLUGIN_STATE_SCHEMA,
          version: 1,
          plugin: this.#plugin,
          sessionId: target.sessionId,
          seq,
          updatedAt: new Date().toISOString(),
          state,
        };
        const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await mkdir(join(target.sessionDir, "plugin-state", target.sessionId), { recursive: true, mode: 0o700 });
          await writeFile(temp, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
          await rename(temp, file);
        } catch (error) {
          this.#onError(error);
        } finally {
          await rm(temp, { force: true });
        }
      }
    });
    await this.#writing;
  }
}
