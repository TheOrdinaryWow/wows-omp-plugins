import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { DIRECTIVE_ASSET, HYPERPLAN_ASSET, loadPromptAsset, RESEARCH_ASSET } from "#src/assets.ts";
import { detectPointers, detectUltrawork, hasEmbeddedDirective } from "#src/keywords.ts";

const STATE_ENTRY = "wows-omp-omo-ultrawork.state";
const DIRECTIVE_MESSAGE = "wows-omp-omo-ultrawork.directive";
const REMINDER_MESSAGE = "wows-omp-omo-ultrawork.fanout-reminder";
const EXIT_MESSAGE = "wows-omp-omo-ultrawork.exit";
const STATUS_KEY = "omo-ultrawork";
const PACKAGE_NAME = "wows-omp-plugin-omo-ultrawork";
const EXIT_NOTICE =
  "<omo-ultrawork-exit>ultrawork mode is off; the ultrawork directive no longer applies. Resume normal operation.</omo-ultrawork-exit>";
const ARMED_REMINDER =
  "<omo-ultrawork-reminder>ultrawork mode is already armed for this session - the ultrawork directive above remains binding; re-read it and continue.</omo-ultrawork-reminder>";
const MASS_ULW_POINTER =
  "<omo-mass-ulw-pointer>The request names mass-ulw. Read skill://mass-ulw before decomposing the work and follow its wave and verification protocol.</omo-mass-ulw-pointer>";
const TODO_FANOUT_REMINDER = [
  "<system-reminder>",
  "ultrawork mode is active and this session just started its todo list. Before working any todo:",
  "1. SIZE the work: weigh the todo count, each task's scope, and the total effort.",
  "2. COMPUTE the fan-out decision: delegate to parallel subagents only when the parallelism gain beats spawn and coordination overhead - independent parts with disjoint write scopes fan out, interdependent or trivial parts do not.",
  "3. TELL the user the decision either way: which parts route to which agents and why fan-out pays off, or why you are working directly. Never delegate silently and never grind through a fan-out-shaped task silently.",
  "4. KEEP the todo list fresh: mark start/done the instant each task transitions, append newly discovered steps the moment they surface, drop abandoned ones. A stale todo list is a defect.",
  "</system-reminder>",
].join("\n");

interface ArmingState {
  mode: boolean;
  armed: boolean;
  rearmPending: boolean;
  reminderSent: boolean;
}

interface UltraworkSettings {
  keywordTrigger: boolean;
  keywords: string[];
  researchScratchDir: string;
}

const DEFAULT_SETTINGS: UltraworkSettings = {
  keywordTrigger: true,
  keywords: ["ulw", "ultrawork"],
  researchScratchDir: "",
};

function parseSettings(raw: Record<string, unknown>): UltraworkSettings {
  const keywordTrigger = raw.keywordTrigger ?? DEFAULT_SETTINGS.keywordTrigger;
  const keywords = raw.keywords ?? "ulw,ultrawork";
  const researchScratchDir = raw.researchScratchDir ?? DEFAULT_SETTINGS.researchScratchDir;
  if (typeof keywordTrigger !== "boolean" || typeof keywords !== "string" || typeof researchScratchDir !== "string") {
    throw new Error("invalid ultrawork plugin settings");
  }
  return {
    keywordTrigger,
    keywords: keywords
      .split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
    researchScratchDir,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ultrawork(pi: ExtensionAPI): void {
  const states = new Map<string, ArmingState>();
  const settings = new Map<string, Promise<UltraworkSettings>>();

  const settingsFor = (ctx: ExtensionContext): Promise<UltraworkSettings> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const existing = settings.get(sessionId);
    if (existing) return existing;
    const loading = getPluginSettings(PACKAGE_NAME, ctx.cwd)
      .then(parseSettings)
      .catch((error: unknown) => {
        pi.logger.warn("ultrawork could not load plugin settings; using defaults", { error: errorMessage(error) });
        return DEFAULT_SETTINGS;
      });
    settings.set(sessionId, loading);
    return loading;
  };

  const status = (ctx: ExtensionContext, state: ArmingState | undefined): void => {
    ctx.ui.setStatus?.(STATUS_KEY, state?.mode ? "Ultrawork mode" : state?.armed ? "Ultrawork armed" : undefined);
  };

  const mainSession = (ctx: ExtensionContext): AgentSession | undefined => {
    try {
      return (
        AgentRegistry.global()
          .list()
          .find((candidate) => candidate.kind === "main" && candidate.session?.sessionManager === ctx.sessionManager)?.session ?? undefined
      );
    } catch (error) {
      pi.logger.warn("ultrawork could not resolve the main session", { error: errorMessage(error) });
      return undefined;
    }
  };

  const stateFor = (sessionId: string): ArmingState => {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const created = { mode: false, armed: false, rearmPending: false, reminderSent: false };
    states.set(sessionId, created);
    return created;
  };

  const persist = (state: ArmingState): void => {
    try {
      pi.appendEntry(STATE_ENTRY, { version: 2, ...state });
    } catch (error) {
      pi.logger.warn("ultrawork could not persist arming state", { error: errorMessage(error) });
    }
  };

  const rehydrate = (ctx: ExtensionContext): void => {
    if (!mainSession(ctx)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    states.delete(sessionId);
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const data = entry.data as
        | { version?: unknown; mode?: unknown; armed?: unknown; rearmPending?: unknown; reminderSent?: unknown }
        | undefined;
      if (data?.version !== 1 && data?.version !== 2) continue;
      states.set(sessionId, {
        mode: data.version === 2 && data.mode === true,
        armed: typeof data.armed === "boolean" ? data.armed : false,
        rearmPending: typeof data.rearmPending === "boolean" ? data.rearmPending : false,
        reminderSent: typeof data.reminderSent === "boolean" ? data.reminderSent : false,
      });
    }
    status(ctx, states.get(sessionId));
  };

  pi.on("session_start", (_event, ctx) => {
    settings.delete(ctx.sessionManager.getSessionId());
    void settingsFor(ctx);
    rehydrate(ctx);
  });
  pi.on("session_switch", (_event, ctx) => {
    settings.delete(ctx.sessionManager.getSessionId());
    void settingsFor(ctx);
    rehydrate(ctx);
  });
  pi.on("session_branch", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    states.delete(ctx.sessionManager.getSessionId());
    settings.delete(ctx.sessionManager.getSessionId());
    if (mainSession(ctx)) status(ctx, undefined);
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!mainSession(ctx)) return;
    const state = stateFor(ctx.sessionManager.getSessionId());
    state.rearmPending = true;
    state.reminderSent = false;
    persist(state);
  });

  pi.on("input", async (event, ctx) => {
    if (!mainSession(ctx) || event.source === "extension" || event.text.trimStart().startsWith("/")) return undefined;

    const state = stateFor(ctx.sessionManager.getSessionId());
    const configured = state.mode ? undefined : await settingsFor(ctx);
    const keyword = !state.mode && configured?.keywordTrigger === true && detectUltrawork(event.text, configured.keywords);
    const embedded = hasEmbeddedDirective(event.text);
    const pointers = detectPointers(event.text);
    if (embedded) {
      state.armed = true;
      state.rearmPending = false;
      persist(state);
      status(ctx, state);
      return undefined;
    }
    if (!state.mode && !keyword && pointers.length === 0) return undefined;

    let content = "";
    if (state.mode || keyword) {
      if (!state.armed || state.rearmPending) {
        try {
          content = `<ultrawork-mode>\n${await loadPromptAsset(DIRECTIVE_ASSET)}\n</ultrawork-mode>`;
        } catch (error) {
          ctx.ui.notify(`Ultrawork directive could not be loaded (${errorMessage(error)}); input ignored.`, "error");
          return undefined;
        }
      } else {
        content = ARMED_REMINDER;
      }
    }
    if (pointers.includes("mass-ulw")) content += `${content ? "\n" : ""}${MASS_ULW_POINTER}`;

    pi.sendMessage(
      { customType: DIRECTIVE_MESSAGE, content, display: false, attribution: "user" },
      { deliverAs: ctx.isIdle() ? "nextTurn" : "aside" },
    );
    if (state.mode || keyword) {
      state.armed = true;
      state.rearmPending = false;
      persist(state);
      status(ctx, state);
    }
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    if (!mainSession(ctx) || event.toolName !== "todo" || event.isError) return undefined;
    if (event.input.op !== "init" && event.input.op !== "append") return undefined;
    const state = stateFor(ctx.sessionManager.getSessionId());
    if (!state.armed || state.reminderSent) return undefined;
    pi.sendMessage(
      { customType: REMINDER_MESSAGE, content: TODO_FANOUT_REMINDER, display: false, attribution: "user" },
      { deliverAs: "aside" },
    );
    state.reminderSent = true;
    persist(state);
    return undefined;
  });

  const toggleCommand = {
    description: "Toggle persistent ultrawork mode for ordinary user input",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (!mainSession(ctx)) {
        ctx.ui.notify("ultrawork runs in the main session only", "warning");
        return;
      }
      const state = stateFor(ctx.sessionManager.getSessionId());
      if (state.mode) {
        state.mode = false;
        state.armed = false;
        state.rearmPending = false;
        state.reminderSent = false;
        persist(state);
        status(ctx, state);
        ctx.ui.notify("Ultrawork mode off", "info");
        pi.sendMessage(
          { customType: EXIT_MESSAGE, content: EXIT_NOTICE, display: false, attribution: "user" },
          { deliverAs: ctx.isIdle() ? "nextTurn" : "aside" },
        );
        return;
      }

      try {
        const content = `<ultrawork-mode>\n${await loadPromptAsset(DIRECTIVE_ASSET)}\n</ultrawork-mode>`;
        state.mode = true;
        state.armed = true;
        state.rearmPending = false;
        persist(state);
        status(ctx, state);
        ctx.ui.notify("Ultrawork mode on", "info");
        pi.sendMessage(
          { customType: DIRECTIVE_MESSAGE, content, display: false, attribution: "user" },
          { deliverAs: ctx.isIdle() ? "nextTurn" : "aside" },
        );
        if (args.trim()) pi.sendUserMessage(args.trim());
      } catch (error) {
        ctx.ui.notify(`Ultrawork directive could not be loaded (${errorMessage(error)}).`, "error");
      }
    },
  };
  pi.registerCommand("ultrawork", toggleCommand);
  pi.registerCommand("ulw", toggleCommand);

  pi.registerCommand("hyperplan", {
    description: "Adversarial multi-agent planning: five specialist critics, three rounds, then a planner handoff",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /hyperplan <request>", "warning");
        return;
      }
      if (!mainSession(ctx)) {
        ctx.ui.notify("hyperplan runs in the main session only", "warning");
        return;
      }
      try {
        const body = await loadPromptAsset(HYPERPLAN_ASSET);
        pi.sendUserMessage(`<hyperplan-request>\n${request}\n</hyperplan-request>\n\n${body}`);
      } catch (error) {
        ctx.ui.notify(`Hyperplan procedure could not be loaded (${errorMessage(error)}).`, "error");
      }
    },
  });

  pi.registerCommand("ulw-research", {
    description: "Saturation research with a claim graph, verification gates, and a QA-checked deliverable",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /ulw-research <request>", "warning");
        return;
      }
      if (!mainSession(ctx)) {
        ctx.ui.notify("ulw-research runs in the main session only", "warning");
        return;
      }
      try {
        const body = await loadPromptAsset(RESEARCH_ASSET);
        const dir = fileURLToPath(new URL("../assets/ulw-research", import.meta.url));
        const configured = await settingsFor(ctx);
        const scratchRoot = configured.researchScratchDir.trim()
          ? path.resolve(ctx.cwd, configured.researchScratchDir)
          : path.join(tmpdir(), "ulw-research");
        pi.sendUserMessage(
          `<ulw-research-request>\n${request}\n</ulw-research-request>\n\n${body}\n\nResearch assets directory: ${dir}\nResearch scratch root: ${scratchRoot}`,
        );
      } catch (error) {
        ctx.ui.notify(`Research procedure could not be loaded (${errorMessage(error)}).`, "error");
      }
    },
  });
}
