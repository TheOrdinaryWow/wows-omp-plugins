import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getThemeEpoch } from "@oh-my-pi/pi-tui/theme";

import { shouldDisplay } from "./display-timing.ts";
import { createHerdr, type HerdrExec, type HerdrExecResult } from "./herdr.ts";
import { runStats, type Snapshot, type ThemeColors } from "./model.ts";
import { PaneManager } from "./pane.ts";
import type { Op, SessionPaths } from "./protocol.ts";
import { pruneRetention } from "./retention.ts";
import { buildViewerCommand, resolveViewerRuntime } from "./runtime.ts";
import { DEFAULT_SETTINGS, type PluginSettings, readSettings } from "./settings.ts";
import { AtlasSource } from "./sources/atlas.ts";
import { PLAN_EXECUTION_ENTRY, PlanExecutionTracker } from "./sources/plan-execution.ts";
import { TaskSource } from "./sources/tasks.ts";
import { TODO_EDGES_ENTRY, type TodoEdgesEntry, TodoSource } from "./sources/todo.ts";
import { registerTodoWrapper } from "./sources/todo-wrapper.ts";
import { herdrSocketPath, SnapshotServer, type SnapshotTimer, SnapshotWriter } from "./transport.ts";

// Internal seams: production uses the host environment, platform, exec and timers.
interface Dependencies {
  exec?: HerdrExec;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timer?: SnapshotTimer;
}

const THEME_KEYS = ["text", "muted", "dim", "accent", "success", "error", "warning", "border", "borderAccent", "borderMuted"] as const;
const FALLBACK_THEME: ThemeColors = {
  text: "#e5e5e7",
  muted: "#909090",
  dim: "#666666",
  accent: "#4f8cff",
  success: "#3fb950",
  error: "#f85149",
  warning: "#d29922",
  border: "#555555",
  borderAccent: "#4f8cff",
  borderMuted: "#333333",
};

class DagExtension {
  readonly #pi: ExtensionAPI;
  readonly #deps: Dependencies;
  readonly #controllers = new Set<AbortController>();
  readonly #seenRuns = new Set<string>();
  readonly #plan: PlanExecutionTracker;
  #ctx?: ExtensionContext;
  #settings: PluginSettings = { ...DEFAULT_SETTINGS };
  #todo?: TodoSource;
  #tasks?: TaskSource;
  #atlas?: AtlasSource;
  #pane?: PaneManager;
  #server?: SnapshotServer;
  #writer?: SnapshotWriter;
  #snapshot?: Snapshot;
  #sessionId = "";
  #paths: SessionPaths = { snapshot: "", state: "" };
  #generation = 0;
  #themeEpoch = -1;
  #theme: ThemeColors = { ...FALLBACK_THEME };
  #queue: Promise<void> = Promise.resolve();
  #commandsRegistered = false;
  #stopping = false;
  #noticeShown = false;
  #runtimeNoticeSession?: string;
  #restoring = false;

  constructor(pi: ExtensionAPI, deps: Dependencies) {
    this.#pi = pi;
    this.#deps = deps;
    this.#plan = new PlanExecutionTracker({ persist: (data) => pi.appendEntry(PLAN_EXECUTION_ENTRY, data) });
  }

  run(operation: () => void | Promise<void>): Promise<void> {
    const result = this.#queue.then(async () => {
      if (!this.#stopping) await operation();
    });
    this.#queue = result.catch((error: unknown) => this.#report(error));
    return this.#queue;
  }

  #report(error: unknown): void {
    this.#pi.logger.warn(`Herdr DAG: ${error instanceof Error ? error.message : String(error)}`);
  }

  #supported(ctx: ExtensionContext): boolean {
    if (ctx.hasUI !== true) return false;
    const platform = this.#deps.platform ?? process.platform;
    if (platform === "win32" && !this.#noticeShown) {
      this.#noticeShown = true;
      ctx.ui.notify("Herdr DAG is not supported on Windows", "info");
    }
    const env = this.#deps.env ?? process.env;
    return (platform === "linux" || platform === "darwin") && env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
  }

  async #readSettings(ctx: ExtensionContext): Promise<void> {
    const previous = this.#settings;
    this.#settings = await readSettings(ctx.cwd, (message) => ctx.ui.notify(message, "warning"));
    if (this.#pane && JSON.stringify(previous) !== JSON.stringify(this.#settings)) await this.#pane.update({ settings: this.#settings });
    if (!previous.followTheme && this.#settings.followTheme) this.#sampleTheme(true);
    if (!this.#settings.atlasIntegration) {
      this.#atlas?.dispose();
      this.#atlas = undefined;
      this.#todo?.setAtlasBound(false);
    } else if (!previous.atlasIntegration && this.#server) {
      this.#installAtlas();
    }
  }

  #installAtlas(): AtlasSource | undefined {
    if (this.#atlas || !this.#settings.atlasIntegration) return this.#atlas;
    this.#atlas = new AtlasSource({ events: this.#pi.events, sessionId: this.#sessionId, generation: this.#generation });
    this.#atlas.subscribe(() => {
      if (this.#restoring) return;
      void this.run(async () => {
        this.#todo?.setAtlasBound(!!this.#atlas?.state.snapshot);
        this.#publish();
        await this.#evaluate();
      });
    });
    return this.#atlas;
  }

  #sampleTheme(force = false): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#settings.followTheme) return;
    const epoch = getThemeEpoch();
    if (!force && epoch === this.#themeEpoch) return;
    this.#themeEpoch = epoch;
    const theme = { ...FALLBACK_THEME };
    for (const key of THEME_KEYS) theme[key] = ctx.ui.theme.getColorHex(key);
    this.#theme = theme;
  }

  #buildSnapshot(): Snapshot {
    const tasks = this.#tasks?.tasks ?? [];
    const stalled = this.#tasks?.stalledTaskIds ?? new Set<string>();
    const runs = [...(this.#todo?.runs ?? []), ...(this.#atlas?.run ? [this.#atlas.run] : [])].map((original) => {
      const run = structuredClone(original);
      for (const node of run.nodes) {
        const linked = tasks.filter((task) => task.nodeId === node.id || node.taskIds.includes(task.id));
        node.taskIds = [...new Set([...node.taskIds, ...linked.map((task) => task.id)])];
        node.stalled = linked.some((task) => stalled.has(task.id));
      }
      run.stats = runStats(run, tasks);
      return run;
    });
    return {
      version: 1,
      sessionId: this.#sessionId,
      sessionName: this.#ctx?.sessionManager.getSessionName(),
      generation: this.#generation,
      connected: true,
      at: Date.now(),
      runs,
      tasks: structuredClone(tasks),
      theme: this.#theme,
      sources: { todo: this.#settings.colorTodo, plan: this.#settings.colorPlan, atlas: this.#settings.colorAtlas },
      atlasAvailable: this.#atlas?.state.available === true,
    };
  }

  #publish(): void {
    if (!this.#server || this.#restoring || this.#stopping) return;
    const next = this.#buildSnapshot();
    const previous = this.#snapshot;
    const ops: Op[] = [];
    if (previous) {
      for (const run of next.runs)
        if (JSON.stringify(previous.runs.find((old) => old.id === run.id)) !== JSON.stringify(run)) ops.push({ op: "run", run });
      for (const run of previous.runs) if (!next.runs.some((current) => current.id === run.id)) ops.push({ op: "removeRun", id: run.id });
      for (const task of next.tasks)
        if (JSON.stringify(previous.tasks.find((old) => old.id === task.id)) !== JSON.stringify(task)) ops.push({ op: "task", task });
      for (const task of previous.tasks)
        if (!next.tasks.some((current) => current.id === task.id)) ops.push({ op: "removeTask", id: task.id });
      if (JSON.stringify(previous.theme) !== JSON.stringify(next.theme)) ops.push({ op: "theme", theme: next.theme });
      if (previous.atlasAvailable !== next.atlasAvailable) ops.push({ op: "atlas", available: next.atlasAvailable });
    }
    this.#snapshot = next;
    const colorsChanged = !previous || JSON.stringify(previous.sources) !== JSON.stringify(next.sources);
    if (colorsChanged || ops.length) this.#server.publish(next, colorsChanged ? [] : ops);
    this.#writer?.schedule(next);
  }

  async #evaluate(): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx || !this.#server || !this.#pane || this.#stopping) return;
    await this.#readSettings(ctx);
    this.#publish();
    const runs = this.#snapshot?.runs ?? [];
    const newRun = runs.some((run) => !this.#seenRuns.has(run.id));
    for (const run of runs) this.#seenRuns.add(run.id);
    if (newRun) await this.#pane.resetDismissal();
    if (
      !shouldDisplay(this.#settings.displayTiming, {
        todoActive: !!this.#todo?.current,
        planExecuting: this.#plan.state.state === "executing",
        atlasBound: this.#atlas?.state.bound === true,
      })
    )
      return;
    const wasOpen = !!this.#pane.paneId;
    await this.#pane.ensure();
    if (!wasOpen && this.#pane.paneId) this.#atlas?.activate();
  }

  async restore(ctx: ExtensionContext, options: { start?: boolean; preserveProposal?: boolean } = {}): Promise<void> {
    if (ctx.hasUI !== true) await this.#readSettings(ctx);
    if (ctx.hasUI !== true) return;
    this.#ctx = ctx;
    if (!this.#commandsRegistered) {
      this.#commandsRegistered = true;
      this.#pi.registerCommand("dag-pane", {
        description: "Open, close or toggle the Herdr DAG pane",
        getArgumentCompletions: (prefix) =>
          ["open", "close", "toggle"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
        handler: (args, commandCtx) => this.run(() => this.command(args, commandCtx)),
      });
    }
    if (!this.#supported(ctx)) return;
    const previousId = this.#sessionId;
    const sessionId = ctx.sessionManager.getSessionId();
    this.#restoring = true;
    try {
      await this.#readSettings(ctx);
      if (this.#stopping) return;
      const runtime = resolveViewerRuntime(this.#settings.viewerRuntime);
      if (!runtime) {
        if (this.#runtimeNoticeSession !== sessionId)
          ctx.ui.notify("Herdr DAG needs a Bun viewer runtime; set viewerRuntime or install Bun", "warning");
        this.#runtimeNoticeSession = sessionId;
        return;
      }
      const root = join(ctx.sessionManager.getSessionDir(), "herdr-dag");
      const dir = join(root, sessionId);
      if (options.start) await pruneRetention({ root, currentSessionId: sessionId, retentionDays: this.#settings.retentionDays });
      if (this.#writer) await this.#writer.flush();
      if (this.#stopping) return;
      this.#sessionId = sessionId;
      this.#paths = { snapshot: join(dir, "snapshot.json"), state: join(dir, "view-state.json") };
      this.#generation += 1;
      this.#writer = new SnapshotWriter({ file: this.#paths.snapshot, timer: this.#deps.timer, onError: (error) => this.#report(error) });
      this.#atlas?.dispose();
      this.#atlas = undefined;
      this.#todo = new TodoSource({ sessionId, plan: this.#plan });
      this.#todo.replay(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId(), options.preserveProposal);
      if (!this.#tasks || previousId !== sessionId) {
        this.#tasks?.dispose();
        this.#tasks = new TaskSource({
          events: this.#pi.events,
          registry: AgentRegistry.global(),
          inProgressNode: () => this.#todo?.current?.nodes.find((node) => node.state === "running"),
          stalledAfterSeconds: this.#settings.stalledAfterSeconds,
          scheduleInterval: () => () => {}, // Sample together with the transport heartbeat.
        });
        this.#tasks.subscribe(() => {
          if (!this.#restoring) void this.run(() => this.#publish());
        });
      }
      const atlas = this.#installAtlas();
      this.#todo.setAtlasBound(!!atlas?.state.snapshot);
      this.#sampleTheme(true);
      const snapshot = this.#buildSnapshot();
      this.#snapshot = snapshot;
      const env = this.#deps.env ?? process.env;
      const socketPath = herdrSocketPath(env.HERDR_PANE_ID as string, process.pid);
      const viewerCommand = (paneId: string) =>
        buildViewerCommand({
          runtime: resolveViewerRuntime(this.#settings.viewerRuntime) ?? runtime,
          viewer: fileURLToPath(new URL("../viewer/main.ts", import.meta.url)),
          socket: socketPath,
          snapshot: this.#paths.snapshot,
          state: this.#paths.state,
          pane: paneId,
          finish: this.#settings.finishBehavior,
        });
      if (!this.#pane) {
        const exec: HerdrExec = async (args, options) => {
          const controller = new AbortController();
          this.#controllers.add(controller);
          const abort = () => controller.abort(options.signal.reason);
          options.signal.addEventListener("abort", abort, { once: true });
          try {
            const callOptions = { ...options, signal: controller.signal };
            if (this.#deps.exec) return await this.#deps.exec(args, callOptions);
            return await new Promise<HerdrExecResult>((resolve, reject) => {
              execFile(
                "herdr",
                [...args],
                { encoding: "utf8", timeout: options.timeoutMs, signal: controller.signal },
                (error, stdout, stderr) => {
                  if (error && typeof error.code !== "number") reject(error);
                  else resolve({ stdout, stderr, exitCode: error && typeof error.code === "number" ? error.code : 0 });
                },
              );
            });
          } finally {
            options.signal.removeEventListener("abort", abort);
            this.#controllers.delete(controller);
          }
        };
        this.#pane = new PaneManager({
          herdr: createHerdr(exec),
          dir,
          sessionId,
          hostPaneId: env.HERDR_PANE_ID as string,
          settings: this.#settings,
          viewerCommand,
          cwd: ctx.cwd,
          sessionName: ctx.sessionManager.getSessionName(),
          notify: (message) => ctx.ui.notify(message, "warning"),
          log: (message) => this.#pi.logger.warn(message),
        });
      } else {
        await this.#pane.update({
          dir,
          sessionId,
          sessionName: ctx.sessionManager.getSessionName(),
          settings: this.#settings,
          viewerCommand,
          cwd: ctx.cwd,
        });
      }
      if (this.#stopping) return;
      if (!this.#server) {
        this.#server = new SnapshotServer({
          socketPath,
          sessionId,
          paths: this.#paths,
          snapshot,
          timer: this.#deps.timer,
          onClosed: () =>
            this.run(async () => {
              await this.#pane?.dismiss();
            }),
          onReady: () => this.#pane?.onResize(),
          onHeartbeat: () =>
            this.run(async () => {
              const todoGeneration = this.#todo?.generation;
              if (this.#ctx) this.#todo?.poll(this.#ctx.sessionManager);
              if (this.#todo?.generation !== todoGeneration) this.#generation += 1;
              this.#tasks?.sample();
              this.#sampleTheme();
              this.#publish();
              await this.#evaluate();
              this.#pane?.onResize();
            }),
          onError: (error) => this.#report(error),
        });
        await this.#server.start();
      } else {
        this.#server.updateSession(sessionId, this.#paths, snapshot);
      }
      this.#writer.schedule(snapshot);
      if (previousId !== sessionId) {
        this.#seenRuns.clear();
        for (const run of snapshot.runs) this.#seenRuns.add(run.id);
      }
    } finally {
      this.#restoring = false;
    }
    await this.#evaluate();
  }

  async command(args: string, ctx: ExtensionContext): Promise<void> {
    this.#ctx = ctx;
    await this.#readSettings(ctx);
    if (!this.#supported(ctx) || !this.#server || !this.#pane) {
      if ((this.#deps.platform ?? process.platform) !== "win32")
        ctx.ui.notify("Herdr DAG is available in an interactive Herdr session", "info");
      return;
    }
    const action = args.trim() || "toggle";
    if (!["open", "close", "toggle"].includes(action)) {
      ctx.ui.notify("Usage: /dag-pane [open|close|toggle]", "warning");
      return;
    }
    if (action === "close" || (action === "toggle" && this.#pane.paneId)) {
      await this.#pane.dismiss();
      await this.#pane.close();
    } else {
      await this.#pane.open();
      this.#atlas?.activate();
    }
    this.#publish();
  }

  async toolResult(event: { toolName: string; details?: unknown; isError?: boolean }): Promise<void> {
    if (!this.#server) return;
    this.#plan.observeResult(event);
    const todoGeneration = this.#todo?.generation;
    this.#todo?.observeResult(event);
    if (this.#todo?.generation !== todoGeneration) this.#generation += 1;
    this.#publish();
    await this.#evaluate();
  }

  async beforeAgentStart(prompt: string, ctx: ExtensionContext): Promise<void> {
    if (!this.#server) return;
    this.#ctx = ctx;
    const live = AgentRegistry.global()
      .list()
      .find((ref) => ref.kind === "main" && ref.session?.sessionManager === ctx.sessionManager)?.session;
    this.#plan.beforeAgentStart(prompt, live?.getPlanReferencePath());
    this.#publish();
    await this.#evaluate();
  }

  async agentEnd(willContinue?: boolean): Promise<void> {
    if (!this.#server) return;
    this.#plan.agentEnd(this.#todo?.current, willContinue);
    this.#publish();
    await this.#evaluate();
  }

  edges(data: TodoEdgesEntry, ctx: ExtensionContext): void {
    this.#pi.appendEntry(TODO_EDGES_ENTRY, data);
    if (ctx.hasUI !== true || !this.#server) return;
    this.#todo?.setEdges(data);
    this.#publish();
  }

  dependenciesEnabled(): boolean {
    return this.#settings.todoDependencies;
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#atlas?.dispose();
    this.#tasks?.dispose();
    this.#server?.sendBye("shutdown");
    for (const controller of this.#controllers) controller.abort();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        for (const controller of this.#controllers) controller.abort();
        resolve();
      }, 1_400);
    });
    try {
      await Promise.race([this.#pane?.close("shutdown").catch((error: unknown) => this.#report(error)), deadline]);
    } finally {
      clearTimeout(timer);
      await this.#server?.stop();
      await this.#writer?.flush();
    }
  }
}

export default function herdrDag(pi: ExtensionAPI, deps: Dependencies = {}): void {
  const extension = new DagExtension(pi, deps);
  registerTodoWrapper(pi, {
    enabled: () => extension.dependenciesEnabled(),
    onEdges: (data, ctx) => {
      extension.edges(data, ctx);
    },
  });
  pi.on("session_start", (_event, ctx) => extension.run(() => extension.restore(ctx, { start: true })));
  pi.on("session_switch", (event, ctx) => extension.run(() => extension.restore(ctx, { preserveProposal: event.reason === "new" })));
  pi.on("session_branch", (_event, ctx) => extension.run(() => extension.restore(ctx)));
  pi.on("session_tree", (_event, ctx) => extension.run(() => extension.restore(ctx)));
  pi.on("session_compact", (_event, ctx) => extension.run(() => extension.restore(ctx, { preserveProposal: true })));
  pi.on("before_agent_start", (event, ctx) => extension.run(() => extension.beforeAgentStart(event.prompt, ctx)));
  pi.on("context", (event, ctx) =>
    extension.run(async () => {
      for (const message of event.messages) {
        if (message.role !== "developer" || message.attribution !== "agent" || message.synthetic !== true) continue;
        const prompt =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        await extension.beforeAgentStart(prompt, ctx);
      }
    }),
  );
  pi.on("agent_end", (event) => extension.run(() => extension.agentEnd(event.willContinue)));
  pi.on("tool_result", (event) => extension.run(() => extension.toolResult(event)));
  pi.on("session_shutdown", () => extension.shutdown());
}
