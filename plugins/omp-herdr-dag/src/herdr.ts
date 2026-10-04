import { execFile } from "node:child_process";

export interface HerdrExecResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

export type HerdrExec = (args: readonly string[], options: { timeoutMs: number; signal: AbortSignal }) => Promise<HerdrExecResult>;
export type SplitDirection = "right" | "down";
export type Direction = "left" | "right" | "up" | "down";
export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id?: string;
  terminal_title?: string;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PaneLayout {
  area: Rect;
  panes: Array<{ pane_id: string; rect: Rect; focused?: boolean }>;
  splits?: unknown[];
  focused_pane_id?: string;
  tab_id: string;
}
export interface SplitOptions {
  paneId: string;
  direction: SplitDirection;
  ratio: number;
  cwd: string;
  focus: boolean;
}

export class HerdrError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export function isMissingPane(error: unknown): boolean {
  return error instanceof HerdrError && error.code === "pane_not_found";
}

const defaultExec: HerdrExec = (args, options) => {
  const { promise, resolve, reject } = Promise.withResolvers<HerdrExecResult>();
  execFile("herdr", [...args], { encoding: "utf8", timeout: options.timeoutMs, signal: options.signal }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") reject(error);
    else resolve({ stdout, stderr, exitCode: error && typeof error.code === "number" ? error.code : 0 });
  });
  return promise;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function paneInfo(value: unknown): PaneInfo {
  const pane = record(value);
  if (!pane || typeof pane.pane_id !== "string" || typeof pane.tab_id !== "string") {
    throw new HerdrError("Herdr did not return a pane id and tab id");
  }
  return pane as unknown as PaneInfo;
}

export interface Herdr {
  split(options: SplitOptions): Promise<PaneInfo>;
  swap(sourcePaneId: string, targetPaneId: string): Promise<void>;
  resize(paneId: string, direction: Direction, amount: number): Promise<void>;
  rename(paneId: string, title: string): Promise<void>;
  run(paneId: string, command: string): Promise<void>;
  close(paneId: string): Promise<void>;
  get(paneId: string): Promise<PaneInfo>;
  layout(paneId: string): Promise<PaneLayout>;
  current(): Promise<PaneInfo>;
}

export function createHerdr(exec: HerdrExec = defaultExec): Herdr {
  async function call(args: string[], allowEmpty = false): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      const error = new HerdrError(`herdr ${args.join(" ")} timed out after 5000ms`, "timeout");
      timeout.reject(error);
      controller.abort(error);
    }, 5_000);
    try {
      const response = await Promise.race([exec(args, { timeoutMs: 5_000, signal: controller.signal }), timeout.promise]);
      const text = response.stdout.trim();
      if (!text && response.exitCode === 0 && allowEmpty) return {};
      let envelope: Record<string, unknown> | undefined;
      try {
        envelope = record(JSON.parse(text || response.stderr?.trim() || "null"));
      } catch {
        throw new HerdrError(`herdr ${args.join(" ")}: ${response.stderr?.trim() || text || "invalid JSON response"}`);
      }
      const error = record(envelope?.error);
      if (error) {
        throw new HerdrError(typeof error.message === "string" ? error.message : "Herdr command failed", String(error.code));
      }
      if (response.exitCode !== 0) throw new HerdrError(`herdr ${args.join(" ")} exited ${response.exitCode}: ${response.stderr || text}`);
      const result = record(envelope?.result);
      if (!result) throw new HerdrError(`herdr ${args.join(" ")} returned no result`);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async split(options: SplitOptions): Promise<PaneInfo> {
      const result = await call([
        "pane",
        "split",
        "--pane",
        options.paneId,
        "--direction",
        options.direction,
        "--ratio",
        String(options.ratio),
        "--cwd",
        options.cwd,
        options.focus ? "--focus" : "--no-focus",
      ]);
      return paneInfo(result.pane);
    },
    async swap(sourcePaneId: string, targetPaneId: string): Promise<void> {
      await call(["pane", "swap", "--source-pane", sourcePaneId, "--target-pane", targetPaneId]);
    },
    async resize(paneId: string, direction: Direction, amount: number): Promise<void> {
      await call(["pane", "resize", "--direction", direction, "--amount", String(amount), "--pane", paneId]);
    },
    async rename(paneId: string, title: string): Promise<void> {
      await call(["pane", "rename", paneId, title]);
    },
    async run(paneId: string, command: string): Promise<void> {
      await call(["pane", "run", paneId, command], true);
    },
    async close(paneId: string): Promise<void> {
      await call(["pane", "close", paneId]);
    },
    async get(paneId: string): Promise<PaneInfo> {
      return paneInfo((await call(["pane", "get", paneId])).pane);
    },
    async layout(paneId: string): Promise<PaneLayout> {
      const result = (await call(["pane", "layout", "--pane", paneId])).layout;
      const layout = record(result);
      if (!layout || !Array.isArray(layout.panes) || typeof layout.tab_id !== "string")
        throw new HerdrError("Herdr returned no pane layout");
      return layout as unknown as PaneLayout;
    },
    async current(): Promise<PaneInfo> {
      return paneInfo((await call(["pane", "current", "--current"])).pane);
    },
  };
}
