import type { AgentSession, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { DIRECTIVE_ASSET, HYPERPLAN_ASSET, loadPromptAsset } from "#src/assets.ts";
import { readHostSetting } from "#src/host-settings.ts";
import { detectPointers, detectUltrawork, hasEmbeddedDirective } from "#src/keywords.ts";
import { registerMessageTitle } from "#src/message-title.ts";
import { triggersOrchestrate } from "#src/orchestrate.ts";
import { PluginStatePublisher } from "#src/plugin-state.ts";
import { renderPointers } from "#src/pointers.ts";
import { buildResearchPayload, RESEARCH_COMPANIONS } from "#src/research-payload.ts";
import { registerLoop } from "#src/ulw-loop.ts";

const STATE_ENTRY = "wows-omp-omo-ultrawork.state";
const DIRECTIVE_MESSAGE = "wows-omp-omo-ultrawork.directive";
const COMMAND_NOTICE = "wows-omp-omo-ultrawork.command-status";
const EXIT_MESSAGE = "wows-omp-omo-ultrawork.exit";
const STATUS_KEY = "omo-ultrawork";
const PACKAGE_NAME = "wows-omp-plugin-omo-ultrawork";
const EXIT_NOTICE =
  "<omo-ultrawork-exit>Ordinary ultrawork mode is off; its directive no longer applies. An explicitly active ulw-loop or approved Atlas workflow retains ownership. Use /ulw-loop pause|stop to manage a loop.</omo-ultrawork-exit>";
const ARMED_REMINDER =
  "<omo-ultrawork-reminder>ultrawork mode is already armed for this session - the ultrawork directive above remains binding; re-read it and continue.</omo-ultrawork-reminder>";
const ORCHESTRATE_CONFLICT =
  "OMP's orchestrate keyword conflicts with ultrawork. Remove that word, or disable it with `omp config set magicKeywords.orchestrate false`.";
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
  const warnedSessions = new Set<string>();
  const publisher = new PluginStatePublisher("omo-ultrawork", (error, sessionId) => {
    if (warnedSessions.has(sessionId)) return;
    warnedSessions.add(sessionId);
    pi.logger.warn("ultrawork could not publish plugin state", { error: errorMessage(error), sessionId });
  });

  const publish = (ctx: ExtensionContext, state: ArmingState | undefined): void => {
    publisher.publish(
      ctx.sessionManager.getSessionId(),
      state?.mode || state?.armed ? { kind: "omo-ultrawork/mode", version: 1, mode: state.mode, armed: state.armed } : null,
    );
  };

  const commandNotice = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, type);
      return;
    }
    pi.sendMessage({ customType: COMMAND_NOTICE, content: message, display: true, attribution: "agent" });
  };
  registerMessageTitle(pi, COMMAND_NOTICE, "Ultrawork");

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
    ctx.ui.setStatus(STATUS_KEY, state?.mode ? "Ultrawork mode" : state?.armed ? "Ultrawork armed" : undefined);
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

  const loop = registerLoop(pi, { mainSession, commandNotice });
  const researchPayload = async (request: string, ctx: ExtensionContext): Promise<string> => {
    const configured = await settingsFor(ctx);
    return await buildResearchPayload(request, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      cwd: ctx.cwd,
      scratchDir: configured.researchScratchDir,
      loopContext: await loop.researchContext(ctx),
    });
  };

  const stateFor = (sessionId: string): ArmingState => {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const created = { mode: false, armed: false, rearmPending: false, reminderSent: false };
    states.set(sessionId, created);
    return created;
  };

  const persist = (ctx: ExtensionContext, state: ArmingState): void => {
    try {
      pi.appendEntry(STATE_ENTRY, { version: 2, ...state });
    } catch (error) {
      pi.logger.warn("ultrawork could not persist arming state", { error: errorMessage(error) });
    }
    publish(ctx, state);
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
    publish(ctx, states.get(sessionId));
  };

  const startSession = (ctx: ExtensionContext): void => {
    settings.delete(ctx.sessionManager.getSessionId());
    void settingsFor(ctx);
    rehydrate(ctx);
  };

  const orchestrateConflict = (session: AgentSession, text: string): boolean => {
    try {
      return triggersOrchestrate(text, session.getEnabledToolNames(), (id) => readHostSetting(session.settings, id));
    } catch (error) {
      pi.logger.warn("ultrawork could not read the orchestrate keyword settings; assuming the host default", {
        error: errorMessage(error),
      });
      return true;
    }
  };

  pi.on("session_start", (_event, ctx) => startSession(ctx));
  pi.on("session_switch", async (_event, ctx) => {
    await publisher.flush();
    startSession(ctx);
  });
  pi.on("session_branch", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    states.delete(ctx.sessionManager.getSessionId());
    settings.delete(ctx.sessionManager.getSessionId());
    if (mainSession(ctx)) status(ctx, undefined);
    await publisher.flush();
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!mainSession(ctx)) return;
    const state = stateFor(ctx.sessionManager.getSessionId());
    state.rearmPending = true;
    state.reminderSent = false;
    persist(ctx, state);
  });

  pi.on("input", async (event, ctx) => {
    const session = mainSession(ctx);
    if (!session || event.source === "extension" || event.text.trimStart().startsWith("/")) return undefined;

    const state = stateFor(ctx.sessionManager.getSessionId());
    const configured = state.mode ? undefined : await settingsFor(ctx);
    const keyword = !state.mode && configured?.keywordTrigger === true && detectUltrawork(event.text, configured.keywords);
    const embedded = hasEmbeddedDirective(event.text);
    const pointers = detectPointers(event.text);
    if (embedded) {
      state.armed = true;
      state.rearmPending = false;
      persist(ctx, state);
      status(ctx, state);
      if (!pointers.length) return undefined;
    }
    if (!state.mode && !keyword && pointers.length === 0) return undefined;
    if (await orchestrateConflict(session, event.text)) {
      commandNotice(ctx, `Ultrawork skipped for this message: ${ORCHESTRATE_CONFLICT}`, "warning");
      return undefined;
    }

    let content = "";
    if ((state.mode || keyword) && !embedded) {
      if (!state.armed || state.rearmPending) {
        try {
          content = `<ultrawork-mode>\n${loadPromptAsset(DIRECTIVE_ASSET)}\n</ultrawork-mode>`;
        } catch (error) {
          commandNotice(ctx, `Ultrawork directive could not be loaded (${errorMessage(error)}); input ignored.`, "error");
          return undefined;
        }
      } else {
        content = ARMED_REMINDER;
      }
    }
    const pointerContent = renderPointers(pointers, event.text);
    if (pointerContent) content += `${content ? "\n" : ""}${pointerContent}`;
    let text = event.text;
    if (pointers.some((pointer) => pointer.target === "ulw-research" && pointer.intent === "binding")) {
      try {
        text =
          event.text.includes("<omo-ulw-research-mode>") || event.text.includes("<ulw-research-request>")
            ? `${event.text}\n\n${RESEARCH_COMPANIONS}\n\n${await loop.researchContext(ctx)}`
            : await researchPayload(event.text, ctx);
      } catch (error) {
        commandNotice(ctx, `Research procedure could not be loaded (${errorMessage(error)}); request was not activated.`, "error");
        return undefined;
      }
    }
    if (state.mode || keyword) {
      state.armed = true;
      state.rearmPending = false;
      persist(ctx, state);
      status(ctx, state);
    }
    // Transform this input, including queued input, rather than steering the turn already running.
    return content || text !== event.text ? { text: content ? `${text}\n\n${content}` : text, images: event.images } : undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    if (!mainSession(ctx) || event.toolName !== "todo" || event.isError) return undefined;
    if (event.input.op !== "init" && event.input.op !== "append") return undefined;
    const state = stateFor(ctx.sessionManager.getSessionId());
    if (!state.armed || state.reminderSent) return undefined;
    state.reminderSent = true;
    persist(ctx, state);
    return { additionalContext: TODO_FANOUT_REMINDER };
  });

  const toggleCommand = {
    description: "[request]: toggle persistent ultrawork mode for ordinary user input; a request is sent under it",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const session = mainSession(ctx);
      if (!session) {
        commandNotice(ctx, "ultrawork runs in the main session only", "warning");
        return;
      }
      const state = stateFor(ctx.sessionManager.getSessionId());
      if (state.mode) {
        state.mode = false;
        state.armed = false;
        state.rearmPending = false;
        state.reminderSent = false;
        persist(ctx, state);
        status(ctx, state);
        commandNotice(ctx, "Ultrawork mode off");
        pi.sendMessage(
          { customType: EXIT_MESSAGE, content: EXIT_NOTICE, display: false, attribution: "user" },
          { deliverAs: ctx.isIdle() ? "nextTurn" : "aside" },
        );
        return;
      }
      const request = args.trim();
      if (await orchestrateConflict(session, request)) {
        commandNotice(ctx, `Ultrawork mode not enabled: ${ORCHESTRATE_CONFLICT}`, "warning");
        return;
      }
      // With nothing to submit now, leave the directive to the next ordinary input so its orchestrate check applies.
      if (!request && ctx.isIdle()) {
        state.mode = true;
        state.armed = false;
        state.rearmPending = false;
        persist(ctx, state);
        status(ctx, state);
        commandNotice(ctx, "Ultrawork mode on");
        return;
      }

      try {
        const content = `<ultrawork-mode>\n${loadPromptAsset(DIRECTIVE_ASSET)}\n</ultrawork-mode>`;
        state.mode = true;
        state.armed = true;
        state.rearmPending = false;
        persist(ctx, state);
        status(ctx, state);
        commandNotice(ctx, "Ultrawork mode on");
        pi.sendMessage(
          { customType: DIRECTIVE_MESSAGE, content, display: false, attribution: "user" },
          { deliverAs: ctx.isIdle() ? "nextTurn" : "aside" },
        );
        if (request) pi.sendUserMessage(request);
      } catch (error) {
        commandNotice(ctx, `Ultrawork directive could not be loaded (${errorMessage(error)}).`, "error");
      }
    },
  };
  pi.registerCommand("ultrawork", toggleCommand);
  pi.registerCommand("ulw", toggleCommand);

  pi.registerCommand("hyperplan", {
    description: "<request>: adversarial multi-agent planning with five specialist critics, three rounds, then a planner handoff",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        commandNotice(ctx, "Usage: /hyperplan <request>", "warning");
        return;
      }
      if (!mainSession(ctx)) {
        commandNotice(ctx, "hyperplan runs in the main session only", "warning");
        return;
      }
      try {
        const body = loadPromptAsset(HYPERPLAN_ASSET);
        pi.sendUserMessage(`<hyperplan-request>\n${request}\n</hyperplan-request>\n\n${body}`);
      } catch (error) {
        commandNotice(ctx, `Hyperplan procedure could not be loaded (${errorMessage(error)}).`, "error");
      }
    },
  });

  pi.registerCommand("ulw-research", {
    description: "<request>: saturation research with a claim graph, verification gates, and a QA-checked deliverable",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        commandNotice(ctx, "Usage: /ulw-research <request>", "warning");
        return;
      }
      if (!mainSession(ctx)) {
        commandNotice(ctx, "ulw-research runs in the main session only", "warning");
        return;
      }
      try {
        pi.sendUserMessage(await researchPayload(request, ctx));
      } catch (error) {
        commandNotice(ctx, `Research procedure could not be loaded (${errorMessage(error)}).`, "error");
      }
    },
  });
}
