import { fileURLToPath } from "node:url";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

import { DIRECTIVE_ASSET, HYPERPLAN_ASSET, loadPromptAsset, RESEARCH_ASSET } from "#src/assets.ts";
import { detectPointers, detectUltrawork, hasEmbeddedDirective } from "#src/keywords.ts";

const STATE_ENTRY = "wows-omp-omo-ultrawork.state";
const DIRECTIVE_MESSAGE = "wows-omp-omo-ultrawork.directive";
const REMINDER_MESSAGE = "wows-omp-omo-ultrawork.fanout-reminder";
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
  armed: boolean;
  rearmPending: boolean;
  reminderSent: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ultrawork(pi: ExtensionAPI): void {
  const states = new Map<string, ArmingState>();

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
    const created = { armed: false, rearmPending: false, reminderSent: false };
    states.set(sessionId, created);
    return created;
  };

  const persist = (state: ArmingState): void => {
    try {
      pi.appendEntry(STATE_ENTRY, { version: 1, ...state });
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
      const data = entry.data as { version?: unknown; armed?: unknown; rearmPending?: unknown; reminderSent?: unknown } | undefined;
      if (data?.version !== 1) continue;
      states.set(sessionId, {
        armed: typeof data.armed === "boolean" ? data.armed : false,
        rearmPending: typeof data.rearmPending === "boolean" ? data.rearmPending : false,
        reminderSent: typeof data.reminderSent === "boolean" ? data.reminderSent : false,
      });
    }
  };

  pi.on("session_start", (_event, ctx) => rehydrate(ctx));
  pi.on("session_switch", (_event, ctx) => rehydrate(ctx));
  pi.on("session_branch", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    states.delete(ctx.sessionManager.getSessionId());
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

    const keyword = detectUltrawork(event.text);
    const embedded = hasEmbeddedDirective(event.text);
    const pointers = detectPointers(event.text);
    const state = stateFor(ctx.sessionManager.getSessionId());
    if (embedded) {
      state.armed = true;
      state.rearmPending = false;
      persist(state);
      return undefined;
    }
    if (!keyword && pointers.length === 0) return undefined;

    let content = "";
    if (keyword) {
      if (!state.armed || state.rearmPending) {
        try {
          content = `<ultrawork-mode>\n${await loadPromptAsset(DIRECTIVE_ASSET)}\n</ultrawork-mode>`;
        } catch (error) {
          ctx.ui.notify(`Ultrawork directive could not be loaded (${errorMessage(error)}); keyword ignored.`, "error");
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
    if (keyword) {
      state.armed = true;
      state.rearmPending = false;
      persist(state);
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
        pi.sendUserMessage(`<ulw-research-request>\n${request}\n</ulw-research-request>\n\n${body}\n\nResearch assets directory: ${dir}`);
      } catch (error) {
        ctx.ui.notify(`Research procedure could not be loaded (${errorMessage(error)}).`, "error");
      }
    },
  });
}
