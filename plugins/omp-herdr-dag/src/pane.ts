import { rm } from "node:fs/promises";
import { join } from "node:path";

import { type Herdr, isMissingPane, type PaneLayout } from "./herdr.ts";
import { type PaneState, readPane, writePane } from "./persisted.ts";
import type { PluginSettings } from "./settings.ts";

export type PaneSettings = Pick<
  PluginSettings,
  "landscapePosition" | "portraitPosition" | "landscapeSize" | "portraitSize" | "followOrientation" | "focusPane" | "finishBehavior"
>;
export type Orientation = PaneState["orientation"];
export type Position = PaneState["position"];
export interface PaneManagerOptions {
  herdr: Herdr;
  dir: string;
  sessionId: string;
  hostPaneId: string;
  settings: PaneSettings;
  socketPath: string;
  viewerCommand: (paneId: string) => string;
  notify: (message: string) => void;
  log: (message: string) => void;
  cwd?: string;
  sessionName?: string;
}
export interface PaneUpdate {
  dir?: string;
  sessionId?: string;
  sessionName?: string;
  settings?: PaneSettings;
  socketPath?: string;
  viewerCommand?: (paneId: string) => string;
  cwd?: string;
}

export function paneOrientation(cols: number, rows: number, previous?: Orientation): Orientation {
  if (previous === "landscape") return cols < 2 * rows - 4 ? "portrait" : "landscape";
  if (previous === "portrait") return cols > 2 * rows + 4 ? "landscape" : "portrait";
  return cols < 2 * rows ? "portrait" : "landscape";
}

export function unsplitDimensions(layout: PaneLayout, hostPaneId: string, state?: PaneState): { cols: number; rows: number } {
  const host = layout.panes.find((pane) => pane.pane_id === hostPaneId);
  if (!host) throw new Error(`Herdr layout does not contain the OMP pane ${hostPaneId}`);
  const dag = state?.paneId ? layout.panes.find((pane) => pane.pane_id === state.paneId) : undefined;
  const horizontal = state?.position === "left" || state?.position === "right";
  return {
    cols: host.rect.width + (dag && horizontal ? dag.rect.width : 0),
    rows: host.rect.height + (dag && !horizontal ? dag.rect.height : 0),
  };
}

export class PaneManager {
  #options: PaneManagerOptions;
  #state?: PaneState;
  #loaded = false;
  #queue: Promise<void> = Promise.resolve();
  #resizeTimer?: ReturnType<typeof setTimeout>;
  #warned = false;
  #orientation?: Orientation;
  #stopped = false;

  constructor(options: PaneManagerOptions) {
    this.#options = { ...options };
  }

  get state(): Readonly<PaneState> | undefined {
    return this.#state;
  }

  get paneId(): string | undefined {
    return this.#state?.paneId;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#state = await readPane(join(this.#options.dir, "pane.json"));
    this.#loaded = true;
    if (this.#state && this.#state.hostPaneId !== this.#options.hostPaneId) {
      // A record from another host is not proof that we own that pane.
      this.#state = undefined;
      await rm(join(this.#options.dir, "pane.json"), { force: true });
    }
    this.#orientation = this.#state?.orientation;
  }

  async #save(state: PaneState): Promise<void> {
    await writePane(join(this.#options.dir, "pane.json"), state);
    this.#state = state;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.#options.log(`Herdr DAG: ${message}`);
      if (!this.#warned) {
        this.#warned = true;
        this.#options.notify(`Herdr DAG: ${message}`);
      }
      throw error;
    });
  }

  async #open(manual: boolean): Promise<PaneState | undefined> {
    if (this.#stopped) return this.#state;
    await this.#load();
    if (this.#stopped) return this.#state;
    if (manual && this.#state?.dismissed) await this.#save({ ...this.#state, dismissed: false });
    if (this.#stopped) return this.#state;
    if (!manual && this.#state?.dismissed) return this.#state;
    if (this.#state?.phase === "splitting") {
      // Crash between split and recording its id: never locate/adopt/close a pane by title or time.
      await rm(join(this.#options.dir, "pane.json"), { force: true });
      if (this.#stopped) return this.#state;
      this.#state = undefined;
      this.#options.notify("A previous DAG pane may be left open; close it manually");
    }
    if (this.#state?.paneId) {
      try {
        await this.#options.herdr.get(this.#state.paneId);
        if (this.#stopped) return this.#state;
        if (this.#state.socketPath === this.#options.socketPath) return this.#state;
        // A surviving keep-open viewer still retries the old process's socket.
        // Recreate only our recorded pane through the normal launch path.
        await this.#options.herdr.close(this.#state.paneId);
        if (this.#stopped) return this.#state;
        await rm(join(this.#options.dir, "pane.json"), { force: true });
        this.#state = undefined;
      } catch (error) {
        if (!isMissingPane(error)) throw error;
        await rm(join(this.#options.dir, "pane.json"), { force: true });
        this.#state = undefined;
      }
    }
    if (this.#stopped) return this.#state;
    const layout = await this.#options.herdr.layout(this.#options.hostPaneId);
    if (this.#stopped) return this.#state;
    const { cols, rows } = unsplitDimensions(layout, this.#options.hostPaneId);
    const orientation = paneOrientation(cols, rows, this.#orientation);
    const position = orientation === "landscape" ? this.#options.settings.landscapePosition : this.#options.settings.portraitPosition;
    const size = orientation === "landscape" ? this.#options.settings.landscapeSize : this.#options.settings.portraitSize;
    const swapping = position === "left" || position === "top";
    const state: PaneState = {
      version: 2,
      phase: "splitting",
      hostPaneId: this.#options.hostPaneId,
      orientation,
      position,
      launchedAt: Date.now(),
      dismissed: false,
    };
    await this.#save(state);
    if (this.#stopped) return this.#state;
    let ownedId: string | undefined;
    try {
      const pane = await this.#options.herdr.split({
        paneId: this.#options.hostPaneId,
        direction: position === "left" || position === "right" ? "right" : "down",
        // Swap exchanges rects, not split shares: the source must have the desired DAG share first.
        ratio: swapping ? size : 1 - size,
        cwd: this.#options.cwd ?? process.cwd(),
        focus: this.#options.settings.focusPane,
      });
      ownedId = pane.pane_id;
      await this.#save({ ...state, phase: "open", paneId: ownedId, tabId: pane.tab_id });
      if (this.#stopped) return this.#state;
      this.#orientation = orientation;
      if (swapping) {
        // Herdr focuses the swap source. With focusPane=false restore the normal OMP focus;
        // an arbitrary unrelated focused pane cannot be restored by the CLI's direct-swap primitive.
        await this.#options.herdr.swap(
          this.#options.settings.focusPane ? ownedId : this.#options.hostPaneId,
          this.#options.settings.focusPane ? this.#options.hostPaneId : ownedId,
        );
      }
      if (this.#stopped) return this.#state;
      await this.#options.herdr.rename(ownedId, `DAG · ${this.#options.sessionName || this.#options.sessionId.slice(0, 8)}`);
      if (this.#stopped) return this.#state;
      await this.#options.herdr.run(ownedId, this.#options.viewerCommand(ownedId));
      if (this.#stopped) return this.#state;
      await this.#save({ ...state, phase: "open", paneId: ownedId, tabId: pane.tab_id, socketPath: this.#options.socketPath });
      return this.#state;
    } catch (error) {
      if (ownedId) {
        try {
          await this.#options.herdr.close(ownedId);
        } catch (cleanupError) {
          if (!isMissingPane(cleanupError)) {
            this.#options.log(`Herdr DAG cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
            // Keep the recorded id so a later close can still clean it up.
            throw error;
          }
        }
      }
      await rm(join(this.#options.dir, "pane.json"), { force: true });
      this.#state = undefined;
      throw error;
    }
  }

  open(): Promise<PaneState | undefined> {
    return this.#serial(() => this.#open(true));
  }

  ensure(): Promise<PaneState | undefined> {
    return this.#serial(() => this.#open(false));
  }

  onResize(): void {
    if (this.#stopped) return;
    clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = undefined;
      void this.checkOrientation().catch(() => undefined);
    }, 750);
  }

  checkOrientation(): Promise<void> {
    return this.#serial(async () => {
      if (this.#stopped) return;
      await this.#load();
      if (this.#stopped) return;
      const state = this.#state;
      if (!state?.paneId || state.dismissed || !this.#options.settings.followOrientation) return;
      const layout = await this.#options.herdr.layout(this.#options.hostPaneId);
      if (this.#stopped) return;
      const { cols, rows } = unsplitDimensions(layout, this.#options.hostPaneId, state);
      const orientation = paneOrientation(cols, rows, this.#orientation);
      if (orientation === this.#orientation) return;
      // Herdr 0.9.3 returns changed=false/reason=same_tab for same-tab moves, even with --split.
      // Recreate only our recorded pane; the viewer resumes from its persisted view state and socket.
      try {
        await this.#options.herdr.close(state.paneId);
      } catch (error) {
        if (!isMissingPane(error)) throw error;
      }
      await rm(join(this.#options.dir, "pane.json"), { force: true });
      this.#state = undefined;
      this.#orientation = orientation;
      await this.#open(false);
    });
  }

  close(reason: string = "close"): Promise<void> {
    if (reason === "shutdown") this.#stopped = true;
    clearTimeout(this.#resizeTimer);
    this.#resizeTimer = undefined;
    return this.#serial(async () => {
      await this.#load();
      const state = this.#state;
      if (!state) return;
      if (reason === "shutdown" && this.#options.settings.finishBehavior === "keep-open") return;
      if (state.phase === "open" && state.paneId) {
        try {
          await this.#options.herdr.close(state.paneId);
        } catch (error) {
          if (!isMissingPane(error)) throw error;
        }
      }
      if (state.dismissed) {
        const { paneId: _paneId, tabId: _tabId, ...remaining } = state;
        await this.#save({ ...remaining, phase: "open" });
      } else {
        await rm(join(this.#options.dir, "pane.json"), { force: true });
        this.#state = undefined;
      }
    });
  }

  dismiss(): Promise<void> {
    return this.#serial(async () => {
      await this.#load();
      if (this.#state) await this.#save({ ...this.#state, dismissed: true });
      else
        await this.#save({
          version: 2,
          phase: "open",
          hostPaneId: this.#options.hostPaneId,
          orientation: this.#orientation ?? "landscape",
          position: this.#options.settings.landscapePosition,
          launchedAt: Date.now(),
          dismissed: true,
        });
    });
  }

  /** A new run may auto-open even after the user dismissed the previous run. */
  resetDismissal(): Promise<void> {
    return this.#serial(async () => {
      await this.#load();
      if (this.#stopped) return;
      if (this.#state?.dismissed) await this.#save({ ...this.#state, dismissed: false });
    });
  }

  update(options: PaneUpdate): Promise<void> {
    return this.#serial(async () => {
      if (this.#stopped) return;
      await this.#load();
      if (this.#stopped) return;
      const oldFile = join(this.#options.dir, "pane.json");
      this.#options = { ...this.#options, ...options };
      this.#warned = false;
      if (this.#state) {
        await this.#save(this.#state);
        if (oldFile !== join(this.#options.dir, "pane.json")) await rm(oldFile, { force: true });
        if (this.#stopped) return;
        if (this.#state.paneId) {
          try {
            await this.#options.herdr.rename(
              this.#state.paneId,
              `DAG · ${this.#options.sessionName || this.#options.sessionId.slice(0, 8)}`,
            );
          } catch (error) {
            if (!isMissingPane(error)) throw error;
            const { paneId: _paneId, tabId: _tabId, ...remaining } = this.#state;
            await this.#save(remaining);
          }
        }
      }
    });
  }

  idle(): Promise<void> {
    return this.#queue;
  }
}
