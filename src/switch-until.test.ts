import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

import { parseHeadlessArgs } from "../plugins/switch-until/src/args.ts";
import { buildJudgeState, qualifiesForJudgment } from "../plugins/switch-until/src/evidence.ts";
import { registerSwitchUntil, type SwitchUntilDependencies } from "../plugins/switch-until/src/index.ts";
import { DEFAULT_SETTINGS, parseSettings } from "../plugins/switch-until/src/settings.ts";
import {
  decide,
  encodeEntry,
  type ModelSelection,
  resolveRestorePoint,
  restoreUntil,
  startUntil,
  type UntilEntry,
} from "../plugins/switch-until/src/state.ts";
import { needsTranslation, TranslationCache } from "../plugins/switch-until/src/translation-cache.ts";

const original = {
  provider: "original-provider",
  id: "same-model-id",
  selector: "original-provider/same-model-id",
  thinking: "auto",
} satisfies ModelSelection;
const target = {
  provider: "target-provider",
  id: "same-model-id",
  selector: "target-provider/same-model-id",
  thinking: ThinkingLevel.Low,
} satisfies ModelSelection;
const replacement = {
  provider: "another-provider",
  id: "second-model",
  selector: "another-provider/second-model",
  thinking: ThinkingLevel.High,
} satisfies ModelSelection;
const startedAt = Date.UTC(2026, 0, 1);

function begin(id = "first") {
  return startUntil({ id, original, target, goal: "Ship the fix", englishGoal: "Ship the fix", startedAt });
}

function entry(data: UntilEntry, id: string, parentId: string | null = null): SessionEntry {
  return { type: "custom", customType: "switch-until", data: JSON.parse(JSON.stringify(encodeEntry(data))), id, parentId, timestamp: "" };
}

function userEntry(id: string, content: string): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content, timestamp: startedAt } };
}

function toolEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "",
    message: {
      role: "toolResult",
      toolName: "task",
      toolCallId: id,
      content: [{ type: "text", text }],
      isError: true,
      timestamp: startedAt,
    },
  };
}

describe("restore point and persisted branch", () => {
  test("replacement keeps the first provider, model and configured thinking level", () => {
    const active = begin();
    const next = startUntil(
      { id: "second", original: target, target: replacement, goal: "Review it", englishGoal: "Review it", startedAt: startedAt + 123 },
      { ...active, turns: 4, judgedTurns: 2, lastJudgment: { probability: 0.4, at: startedAt + 50, evidenceId: "first-evidence" } },
    );
    expect(next.original).toEqual(original);
    expect(next.target).toEqual(replacement);
    expect(next.startedAt).toBe(startedAt + 123);
    expect(next.turns).toBe(0);
    expect(next.judgedTurns).toBe(0);
    expect(next.lastJudgment).toBeUndefined();
  });

  test("selects the original provider's model and exact thinking selector for restoration after resume", () => {
    const run = restoreUntil([entry({ kind: "start", run: begin() }, "saved")]);
    if (!run) throw new Error("Expected the saved run to be active");
    const model = { provider: original.provider, id: original.id };
    const catalog = new Map([
      [`${target.provider}/${target.id}`, { provider: target.provider, id: target.id }],
      [`${original.provider}/${original.id}`, model],
    ]);
    expect(resolveRestorePoint(run, (selector) => catalog.get(selector))).toEqual({ model, thinking: "auto" });
  });

  test("restores the selected branch's latest run, keeping all turns and the first restore point", () => {
    const first = begin();
    const second = startUntil(
      {
        id: "second",
        original: target,
        target: replacement,
        goal: "修复完成",
        englishGoal: "Fix complete",
        startedAt: startedAt + 10,
        context: "Use the draft",
      },
      first,
    );
    const root = entry({ kind: "start", run: first }, "root");
    const replace = entry({ kind: "start", run: second }, "replace", "root");
    const judgment = { probability: 0.72, at: startedAt + 100, evidenceId: "settled-evidence" };
    const branch = [
      root,
      replace,
      entry({ kind: "judgment", id: second.id, turns: 2, judgedTurns: 1, judgment }, "judged", "replace"),
      entry({ kind: "turn", id: second.id, turns: 3 }, "tool-only", "judged"),
      entry({ kind: "end", id: first.id, reason: "cancel" }, "stale-end", "tool-only"),
    ];
    const sibling = entry({ kind: "end", id: first.id, reason: "foreign-change" }, "sibling", "root");
    expect(restoreUntil([root, sibling])).toBeUndefined();
    expect(restoreUntil(branch)).toEqual({ ...second, turns: 3, judgedTurns: 1, lastJudgment: judgment });
    expect(restoreUntil([...branch, entry({ kind: "end", id: second.id, reason: "met" }, "end", "stale-end")])).toBeUndefined();
  });

  test("regains an active run only from valid entries for this plugin", () => {
    const start = entry({ kind: "start", run: begin() }, "start");
    const malformed: SessionEntry = {
      type: "custom",
      customType: "switch-until",
      id: "bad",
      parentId: "start",
      timestamp: "",
      data: { version: 1, kind: "start", run: { ...begin("bad"), original: { ...original, thinking: "extreme" } } },
    };
    expect(
      restoreUntil([
        start,
        malformed,
        { ...malformed, id: "unknown-version", data: { version: 2, kind: "end", id: "first", reason: "cancel" } },
        { ...malformed, customType: "another-plugin", data: encodeEntry({ kind: "end", id: "first", reason: "cancel" }) },
      ]),
    ).toEqual(begin());
  });
});

describe("decision and qualification", () => {
  test("uses P(met) and accepts the threshold exactly", () => {
    expect(decide(begin(), DEFAULT_SETTINGS, startedAt, 0.79)).toBeUndefined();
    expect(decide(begin(), DEFAULT_SETTINGS, startedAt, 0.01)).toBeUndefined();
    expect(decide(begin(), DEFAULT_SETTINGS, startedAt, 0.8)).toBe("met");
  });

  test("enforces turn limits using every completed turn and fractional wall-clock limits on resume", () => {
    const settings = { ...DEFAULT_SETTINGS, maxTurns: 3, maxHours: 0.25 };
    const run = { ...begin(), turns: 3, judgedTurns: 0 };
    expect(decide({ ...run, turns: 2 }, settings, startedAt)).toBeUndefined();
    expect(decide(run, settings, startedAt)).toBe("turn-limit");
    expect(decide(run, DEFAULT_SETTINGS, startedAt)).toBeUndefined();
    const deadline = startedAt + 15 * 60_000;
    expect(decide(begin(), settings, deadline - 1)).toBeUndefined();
    expect(decide(begin(), settings, deadline)).toBe("time-limit");
  });

  test("judges visible assistant text or a task result, skipping pure calls, thinking and other tool results", () => {
    const content = [
      { type: "toolCall", id: "call", name: "read", arguments: {} },
      { type: "thinking", thinking: "Maybe done" },
    ] as const;
    expect(qualifiesForJudgment({ role: "assistant", content }, [{ toolName: "read" }])).toBe(false);
    expect(qualifiesForJudgment({ role: "assistant", content }, [{ toolName: "task" }])).toBe(true);
    expect(qualifiesForJudgment({ role: "assistant", content: [...content, { type: "text", text: "  " }] }, [])).toBe(false);
    expect(qualifiesForJudgment({ role: "assistant", content: [...content, { type: "text", text: "Done." }] }, [])).toBe(true);
    expect(qualifiesForJudgment({ role: "user", content: "Done." }, [])).toBe(false);
  });
});

describe("judge evidence and translation", () => {
  test("uses recent substantive messages in order, bounds tool output and includes every present sidecar", async () => {
    const calls: string[] = [];
    const cache = new TranslationCache(async (text) => {
      calls.push(text);
      return "The verification passed";
    });
    const messages = [
      userEntry("old", "EVEN OLDER"),
      userEntry("recent", "验证通过"),
      toolEntry("tool", `failed ${"x".repeat(3000)} HIDDEN TAIL`),
    ];
    const sidecars = [
      { plugin: "audit-goal", evidence: "audit is pending" },
      { plugin: "roadmap", evidence: `phase one ${"y".repeat(3000)} HIDDEN SIDECAR TAIL` },
    ];
    const options = { goal: "Ship the verified fix", messages, sidecars, contextMessages: 2, translation: cache };
    const state = await buildJudgeState(options);
    expect(state).toContain("Ship the verified fix");
    expect(state).toContain("The verification passed");
    expect(state).toContain("task (error)");
    expect(state.indexOf("The verification passed")).toBeLessThan(state.indexOf("task (error)"));
    expect(state).toContain("audit-goal");
    expect(state).toContain("audit is pending");
    expect(state).toContain("roadmap");
    expect(state).not.toContain("HIDDEN");
    expect(state).not.toContain("EVEN OLDER");
    expect(state).not.toContain("验证通过");
    await buildJudgeState({ ...options, messages: messages.map((message) => ({ ...message })) });
    expect(calls).toEqual(["验证通过"]);
  });

  test("shares simultaneous work by message id and distinguishes different messages with identical text", async () => {
    const calls: string[] = [];
    const cache = new TranslationCache(async (text) => {
      calls.push(text);
      return "The test passed";
    });
    expect(needsTranslation("café: foo_bar(42) 🚦")).toBe(false);
    expect(needsTranslation("status: готово")).toBe(true);
    expect(needsTranslation("修复完成")).toBe(true);
    expect(await Promise.all([cache.translate("修复完成", "one"), cache.translate("修复完成", "one")])).toEqual([
      "The test passed",
      "The test passed",
    ]);
    await cache.translate("修复完成", "two");
    expect(await cache.translate("café", "three")).toBe("café");
    expect(calls).toEqual(["修复完成", "修复完成"]);
  });
});

describe("settings and no-UI syntax", () => {
  test("warns for each invalid field while preserving valid overrides", () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(parseSettings({ minimumConfidence: 0.49, maxTurns: 3.5, maxHours: 0.125, contextMessages: "8" }, warn)).toEqual({
      minimumConfidence: 0.8,
      maxTurns: 0,
      maxHours: 0.125,
      contextMessages: 6,
    });
    expect(warnings).toHaveLength(3);
    expect(warnings.join(" ")).toContain("minimumConfidence");
    expect(warnings.join(" ")).toContain("maxTurns");
    expect(warnings.join(" ")).toContain("contextMessages");
    expect(parseSettings({ minimumConfidence: 1, maxTurns: 1, maxHours: Infinity, contextMessages: 1 }, warn)).toEqual({
      minimumConfidence: 1,
      maxTurns: 1,
      maxHours: 6,
      contextMessages: 1,
    });
    expect(warnings[3]).toContain("maxHours");
  });

  test("reads the selector suffix and preserves quoted text and multiline context", () => {
    expect(parseHeadlessArgs(`provider/model:high --until "Output \\"PASS\\"" --context 'first line\nsecond line'`)).toEqual({
      selector: "provider/model:high",
      goal: 'Output "PASS"',
      context: "first line\nsecond line",
    });
  });

  test.each([
    "",
    "provider/model",
    'provider/model --until "   "',
    'provider/model --until "two\nlines"',
    'provider/model --until "unclosed',
    "provider/model --until --context details",
    "provider/model --until done --until again",
    "provider/model --until done --typo x",
  ])("refuses malformed or incomplete input %j", (args) => {
    expect(() => parseHeadlessArgs(args)).toThrow();
  });
});

const primarySpec = {
  provider: "openrouter",
  id: "test/primary",
  name: "Test primary",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  contextWindow: 100,
  maxTokens: 20,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;
const mainModel = buildModel({ ...primarySpec, input: [...primarySpec.input] });
const temporaryModel = { ...mainModel, id: "test/temporary", contextWindow: 1_000 };
const backupModel = { ...mainModel, id: "test/backup", contextWindow: 1_000 };
const routedModel = buildModel({ ...primarySpec, input: [...primarySpec.input], compat: { openRouterRouting: { only: ["pin1"] } } });

function hostFixture(
  options: {
    branch?: SessionEntry[];
    model?: Model;
    selected?: Model;
    minimumConfidence?: number;
    maxTurns?: number;
    judge?: (state: string) => Promise<number>;
    canJudge?: (model: Model) => boolean;
    translate?: (text: string) => Promise<string>;
    prewalk?: "off" | "suggest" | "on" | "escalate";
    prewalkArmed?: boolean;
  } = {},
) {
  const branch = options.branch ?? [];
  const notices: string[] = [];
  const status: (string | undefined)[] = [];
  const swaps: { selector: string; thinking: string | undefined }[] = [];
  const requests: string[] = [];
  const compactions: CompactOptions[] = [];
  const host = {
    model: options.model ?? mainModel,
    sessionId: "switch-until-test",
    thinking: ThinkingLevel.Low as string | undefined,
    tokens: 20,
    streaming: false,
    compact: async () => {},
    beforeSettings: async () => {},
    prewalkDisarms: 0,
  };
  const preflight = new Set<(signal?: AbortSignal) => Promise<void> | void>();
  const observers = new Set<(event: AgentEvent) => void>();
  let blocked = false;
  const receipt = (model: Model, role: string, resolvedModelIsFallback?: boolean) => {
    branch.push({
      type: "model_change",
      id: `model-${branch.length}`,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: "",
      role,
      model: role === "temporary" ? `${model.provider}/${model.id}` : formatModelStringWithRouting(model),
      resolvedModelIsFallback,
    });
  };
  if (branch.length === 0) receipt(mainModel, "default");
  const sessionManager = { getSessionId: () => host.sessionId, getBranch: () => branch.slice() };
  const modelRegistry = {
    getAvailable: () => [mainModel, temporaryModel, backupModel],
    find: (provider: string, id: string) =>
      [mainModel, temporaryModel, backupModel].find((model) => model.provider === provider && model.id === id),
  };
  const session = {
    get isStreaming() {
      return host.streaming;
    },
    isSessionTransitioning: false,
    agent: {
      subscribe(observer: (event: AgentEvent) => void) {
        observers.add(observer);
        return () => {
          observers.delete(observer);
        };
      },
      addBeforeModelCallHook(hook: (signal?: AbortSignal) => Promise<void> | void) {
        preflight.add(hook);
        return () => {
          preflight.delete(hook);
        };
      },
      abort() {
        blocked = true;
      },
    },
    settleInFlightMessagePersistence: async () => {},
    compact: async (_instructions: string | undefined, opts: CompactOptions) => {
      compactions.push(opts);
      await host.compact();
    },
    setModelTemporary: async (model: Model, thinking?: string) => {
      swaps.push({ selector: formatModelStringWithRouting(model), thinking });
      host.model = model;
      host.thinking = thinking;
      receipt(model, "temporary");
    },
    configuredThinkingLevel: () => host.thinking,
    setThinkingLevel: (thinking?: string) => {
      host.thinking = thinking;
    },
    settings: Settings.isolated({ "prewalk.auto": options.prewalk ?? "off" }),
    getPrewalkState: () => (options.prewalkArmed ? {} : undefined),
    disarmPrewalk: () => {
      host.prewalkDisarms++;
    },
  } as unknown as AgentSession;
  const ctx = {
    agent: { kind: "main" },
    cwd: "/",
    hasUI: false,
    mode: "print",
    models: { current: () => host.model },
    modelRegistry,
    sessionManager,
    getContextUsage: () => ({ tokens: host.tokens }),
    setTimeout: () => undefined,
    clearTimer: () => {},
    compact: async () => {},
    ui: { setStatus: (_key: string, value: string | undefined) => status.push(value), notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionContext;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  const deps: SwitchUntilDependencies = {
    sessionFor: () => session,
    readSettings: async () => {
      await host.beforeSettings();
      return {
        ...DEFAULT_SETTINGS,
        maxTurns: options.maxTurns ?? DEFAULT_SETTINGS.maxTurns,
        minimumConfidence: options.minimumConfidence ?? DEFAULT_SETTINGS.minimumConfidence,
      };
    },
    hasNativeJudge: (_ctx, model) => options.canJudge?.(model) ?? true,
    resolveSelection: () => ({ model: options.selected ?? temporaryModel, thinking: ThinkingLevel.High }),
    judgeGoal: (_ctx, _session, state) => options.judge?.(state) ?? Promise.resolve(0.2),
    translateToEnglish: (_ctx, _session, text) => options.translate?.(text) ?? Promise.resolve("Translated evidence"),
    readSidecars: async () => [],
  };
  registerSwitchUntil(
    {
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      },
      registerCommand: (_name: string, options: { handler: typeof command }) => {
        command = options.handler;
      },
      appendEntry: (customType: string, data: unknown) => {
        branch.push({
          type: "custom",
          customType,
          data,
          id: `workflow-${branch.length}`,
          parentId: branch.at(-1)?.id ?? null,
          timestamp: "",
        });
      },
      sendMessage: ({ content }: { content: string }) => notices.push(content),
    } as unknown as ExtensionAPI,
    deps,
  );
  let delivery: Promise<unknown> = Promise.resolve();
  function recordTurn(text: string, { tool = false, observed = true } = {}) {
    const id = `assistant-${branch.length}`;
    const assistant: AssistantMessage = {
      role: "assistant",
      api: host.model.api,
      provider: host.model.provider,
      model: host.model.id,
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(tool ? [{ type: "toolCall" as const, name: "read", id, arguments: {} }] : []),
      ],
      timestamp: Date.now(),
      stopReason: tool ? "toolUse" : "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    branch.push({ type: "message", id, parentId: branch.at(-1)?.id ?? null, timestamp: "", message: assistant });
    const result = { role: "toolResult" as const, toolName: "read", toolCallId: id, content: [], isError: false, timestamp: Date.now() };
    if (tool) branch.push({ type: "message", id: `${id}-result`, parentId: id, timestamp: "", message: result });
    const event = { type: "turn_end", message: assistant, toolResults: tool ? [result] : [] } satisfies AgentEvent;
    if (observed) for (const observer of observers) observer(event);
    return event;
  }
  return {
    host,
    branch,
    notices,
    status,
    swaps,
    requests,
    compactions,
    ctx,
    receipt,
    recordTurn,
    emit: (name: string, event: object = {}) => {
      delivery = delivery.then(() => handlers.get(name)?.({ type: name, ...event }, ctx));
      return delivery;
    },
    settle: () => handlers.get("session_stop")?.({ type: "session_stop", signal: new AbortController().signal }, ctx),
    command: (args: string) => command(args, ctx),
    requestModel: async () => {
      blocked = false;
      for (const hook of preflight) await hook(new AbortController().signal);
      if (blocked) return undefined;
      const selector = formatModelStringWithRouting(host.model);
      requests.push(selector);
      return selector;
    },
  };
}

const startCommand = 'openrouter/test/temporary --until "Ship the fix" --context "Check the release"';

describe("registered switch-until lifecycle", () => {
  test.each([backupModel, temporaryModel])("keeps automatic reversion but ends the run on an explicit return to $id", async (selected) => {
    const f = hostFixture();
    await f.command(startCommand);
    f.host.model = backupModel;
    f.receipt(backupModel, "fallback", true);
    await f.emit("retry_fallback_applied", { from: "openrouter/test/temporary:high", to: "openrouter/test/backup:low", role: "default" });
    await f.emit("turn_start");
    expect(JSON.stringify(await f.emit("context", { messages: [] }))).toContain("Check the release");
    f.host.model = temporaryModel;
    f.receipt(temporaryModel, "fallback");
    await f.emit("turn_start");
    expect(JSON.stringify(await f.emit("context", { messages: [] }))).toContain("Check the release");
    f.host.model = backupModel;
    f.receipt(backupModel, "fallback", true);
    await f.emit("turn_start");
    expect(JSON.stringify(await f.emit("context", { messages: [] }))).toContain("Check the release");
    f.host.model = selected;
    f.receipt(selected, "temporary");
    await f.emit("turn_start");
    expect(f.notices.at(-1)).toContain("session model changed");
    expect(f.swaps).toHaveLength(1);
  });

  test("refuses an oversized model after a no-op compaction and surfaces a restore compaction failure", async () => {
    const starting = hostFixture();
    starting.host.tokens = 1_100;
    await starting.command(startCommand);
    expect(starting.compactions).toHaveLength(1);
    expect(starting.swaps).toEqual([]);
    expect(starting.notices.at(-1)).toContain("still exceeds");

    const restoring = hostFixture();
    await restoring.command(startCommand);
    restoring.host.tokens = 150;
    restoring.host.compact = async () => {
      throw new Error("Nothing to compact");
    };
    await restoring.command("cancel");
    expect(restoring.swaps).toHaveLength(1);
    expect(restoring.notices.at(-1)).toContain("Nothing to compact");
    restoring.host.compact = async () => {};
    await restoring.command("cancel");
    expect(restoring.swaps).toHaveLength(1);
    expect(restoring.notices.at(-1)).toContain("still exceeds");
  });

  test("stops further target requests at the turn limit while a tool loop needs compaction", async () => {
    const f = hostFixture({ maxTurns: 1 });
    await f.command(startCommand);
    await f.requestModel();
    f.host.tokens = 150;
    f.host.streaming = true;
    const compacted = Promise.withResolvers<void>();
    const compacting = Promise.withResolvers<void>();
    const settingsLoaded = Promise.withResolvers<void>();
    f.host.beforeSettings = () => settingsLoaded.promise;
    f.host.compact = () => {
      compacting.resolve();
      return compacted.promise;
    };
    const firstTurn = f.recordTurn("", { tool: true, observed: false });
    const nextRequest = f.requestModel();
    settingsLoaded.resolve();
    await compacting.promise;
    expect(f.compactions).toHaveLength(1);
    expect(f.compactions[0]?.suppressContinuation).toBe(false);
    f.host.tokens = 50;
    f.host.streaming = false;
    compacted.resolve();
    await f.emit("turn_end", firstTurn);
    expect(await nextRequest).toBe("openrouter/test/primary");
    expect(f.requests).toEqual(["openrouter/test/temporary", "openrouter/test/primary"]);
    expect(f.swaps.at(-1)).toEqual({ selector: "openrouter/test/primary", thinking: "low" });
  });

  test("keeps provider requests blocked when compaction cannot restore the original at the turn limit", async () => {
    const f = hostFixture({ maxTurns: 1 });
    await f.command(startCommand);
    f.host.tokens = 150;
    f.host.streaming = true;
    f.host.compact = async () => {
      throw new Error("Compaction refused");
    };
    await f.emit("turn_end", f.recordTurn("", { tool: true }));
    expect(await f.requestModel()).toBeUndefined();
    expect(f.swaps).toHaveLength(1);
    expect(f.notices.at(-1)).toContain("Compaction refused");
    await f.command("cancel");
    expect(f.notices.at(-1)).toContain("Compaction refused");
    expect(await f.requestModel()).toBeUndefined();
  });

  test("rejudges newer qualifying evidence before restoring on a stale positive", async () => {
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<number>();
    const states: string[] = [];
    const f = hostFixture({
      judge: async (state) => {
        states.push(state);
        if (states.length > 1) return 0.01;
        started.resolve();
        return first.promise;
      },
    });
    await f.command(startCommand);
    const delivered = f.emit("turn_end", f.recordTurn("The release succeeded", { tool: true }));
    await started.promise;
    await delivered;
    const rollback = f.recordTurn("The release was rolled back", { tool: true });
    first.resolve(0.99);
    await f.settle();
    await f.emit("turn_end", rollback);
    await f.settle();
    expect(states).toHaveLength(2);
    expect(states[1]).toContain("rolled back");
    expect(f.swaps).toHaveLength(1);
    await f.command("status");
    expect(f.notices.at(-1)).toContain("1.0% P(met)");
  });

  test("restores the exact routed model and thinking after a branch rebuild", async () => {
    const initial = hostFixture({ model: routedModel });
    await initial.command(startCommand);
    const resumed = hostFixture({ branch: initial.branch, model: temporaryModel });
    await resumed.emit("session_start");
    await resumed.command("cancel");
    expect(resumed.swaps).toEqual([{ selector: "openrouter/test/primary@pin1", thinking: "low" }]);
  });

  test.each([false, true])("rebuild restores the saved routed target and thinking (fallback before exit: %s)", async (fallback) => {
    const routedTarget = { ...routedModel, id: temporaryModel.id, contextWindow: 1_000 };
    const initial = hostFixture({ selected: routedTarget });
    await initial.command(startCommand);
    if (fallback) initial.receipt(backupModel, "fallback", true);
    const resumed = hostFixture({ branch: initial.branch, model: fallback ? mainModel : temporaryModel });
    await resumed.emit("session_start");
    expect(await resumed.requestModel()).toBe("openrouter/test/temporary@pin1");
    expect(resumed.host.thinking).toBe("high");
    const resumedAgain = hostFixture({ branch: resumed.branch, model: temporaryModel });
    await resumedAgain.emit("session_start");
    expect(await resumedAgain.requestModel()).toBe("openrouter/test/temporary@pin1");
    await resumedAgain.command("cancel");
    expect(resumedAgain.swaps.at(-1)).toEqual({ selector: "openrouter/test/primary", thinking: "low" });
  });

  test("does not re-pin the target over a later explicit selection of the base model", async () => {
    const initial = hostFixture({ selected: { ...routedModel, id: temporaryModel.id, contextWindow: 1_000 } });
    await initial.command(startCommand);
    initial.receipt(temporaryModel, "temporary");
    const resumed = hostFixture({ branch: initial.branch, model: temporaryModel });
    await resumed.emit("session_start");
    expect(resumed.swaps).toEqual([]);
    await resumed.command("status");
    expect(resumed.notices.at(-1)).toContain("Session model changed");
  });

  test("checks native judge eligibility of the selected target before compaction or switching", async () => {
    const f = hostFixture({ canJudge: (model) => model.id === mainModel.id });
    f.host.tokens = 1_100;
    await f.command(startCommand);
    expect(f.compactions).toEqual([]);
    expect(f.swaps).toEqual([]);
    expect(f.notices.at(-1)).toContain("Configure a native judge");
  });

  test("rejudges persisted rollback evidence on resume without rebilling prior translations", async () => {
    const calls: string[] = [];
    const translate = async (text: string) => {
      calls.push(text);
      return "Fix complete";
    };
    const initial = hostFixture({ translate, minimumConfidence: 1, judge: async () => 0.99 });
    await initial.command(startCommand);
    initial.branch.push(userEntry("message-translation", "修复完成"));
    await initial.emit("turn_end", initial.recordTurn("The checks passed"));
    await initial.settle();
    initial.recordTurn("The changes were rolled back", { observed: false });
    const states: string[] = [];
    const resumed = hostFixture({
      branch: JSON.parse(JSON.stringify(initial.branch)),
      model: temporaryModel,
      translate,
      judge: async (state) => {
        states.push(state);
        return 0.01;
      },
    });
    await resumed.emit("session_start");
    await resumed.settle();
    expect(states).toHaveLength(1);
    expect(states[0]).toContain("rolled back");
    expect(states[0]).toContain("Fix complete");
    expect(calls).toEqual(["修复完成"]);
    expect(await resumed.requestModel()).toBe("openrouter/test/temporary");
  });

  test("reports the completed branch's end reason and judgment without reviving the status line", async () => {
    const f = hostFixture({ judge: async () => 0.99 });
    await f.command(startCommand);
    await f.emit("turn_end", f.recordTurn("The goal is met"));
    await f.settle();
    const resumed = hostFixture({ branch: f.branch });
    resumed.ctx.hasUI = true;
    await resumed.emit("session_start");
    await resumed.command("status");
    expect(resumed.status).toEqual([undefined]);
    expect(resumed.notices.at(-1)).toContain("Goal met");
    expect(resumed.notices.at(-1)).toMatch(/99\.0% P\(met\) at \d{4}-\d{2}-\d{2}T.*judge favored met/);
  });

  test("keeps monitoring a run whose start survives a rewind into a new session", async () => {
    const f = hostFixture({ judge: async () => 0.99 });
    await f.command(startCommand);
    f.host.sessionId = "switch-until-branch";
    await f.emit("session_branch", { reason: "branch", previousSessionFile: "/sessions/original.jsonl" });
    expect(await f.requestModel()).toBe("openrouter/test/temporary");
    await f.emit("turn_end", f.recordTurn("The goal is met"));
    await f.settle();
    expect(f.swaps.at(-1)).toEqual({ selector: "openrouter/test/primary", thinking: "low" });
    expect(f.notices.at(-1)).toContain("Restored openrouter/test/primary");
  });

  test("drops the run when a rewind into a new session removes its start", async () => {
    let judged = 0;
    const f = hostFixture({
      judge: async () => {
        judged++;
        return 0.99;
      },
    });
    await f.command(startCommand);
    const start = f.branch.findIndex((entry) => entry.type === "custom");
    f.branch.splice(start);
    f.host.sessionId = "switch-until-branch";
    await f.emit("session_branch", { reason: "branch", previousSessionFile: "/sessions/original.jsonl" });
    await f.emit("turn_end", f.recordTurn("The goal is met"));
    await f.settle();
    expect(judged).toBe(0);
    expect(f.swaps).toHaveLength(1);
    await f.command("status");
    expect(f.notices.at(-1)).toBe("No switch-until is active.");
  });

  test("reapplies the saved target on a branch cut between the start and a finished restore", async () => {
    const verdicts = [0.99, 0.2];
    const f = hostFixture({ judge: async () => verdicts.shift() ?? 0.2 });
    await f.command(startCommand);
    const turn = f.recordTurn("The goal is met");
    const cut = f.branch.length;
    await f.emit("turn_end", turn);
    await f.settle();
    expect(f.host.model).toBe(mainModel);
    f.branch.splice(cut);
    f.host.sessionId = "switch-until-branch";
    await f.emit("session_branch", { reason: "branch", previousSessionFile: "/sessions/original.jsonl" });
    await f.settle();
    expect(f.swaps.at(-1)).toEqual({ selector: "openrouter/test/temporary", thinking: "high" });
    expect(f.branch.some((entry) => entry.type === "custom" && JSON.stringify(entry.data).includes("foreign-change"))).toBe(false);
    expect(await f.requestModel()).toBe("openrouter/test/temporary");
    await f.command("status");
    expect(f.notices.at(-1)).toContain("Temporary model: openrouter/test/temporary");
  });

  test.each([
    [{ prewalk: "escalate" }, 1],
    [{ prewalkArmed: true }, 1],
    [{ prewalk: "off" }, 0],
  ] as const)("turns prewalk off for the run when it could move the model (%j)", async (prewalk, disarms) => {
    const f = hostFixture(prewalk);
    await f.command(startCommand);
    expect(f.swaps).toHaveLength(1);
    expect(f.host.prewalkDisarms).toBe(disarms);
    const started = f.notices.find((text) => text.startsWith("Switched to"));
    if (disarms) expect(started).toEndWith("Auto prewalk is off for this session until /new.");
    else expect(started).not.toContain("prewalk");

    const resumed = hostFixture({ ...prewalk, branch: f.branch, model: temporaryModel });
    await resumed.emit("session_start");
    expect(resumed.host.prewalkDisarms).toBe(disarms);
  });

  test("keeps prewalk available when a saved switch no longer owns the model", async () => {
    const f = hostFixture();
    await f.command(startCommand);
    const resumed = hostFixture({ prewalk: "escalate", branch: f.branch, model: mainModel });
    await resumed.emit("session_start");
    expect(resumed.host.prewalkDisarms).toBe(0);
    await resumed.command("status");
    expect(resumed.notices.at(-1)).toContain("Session model changed");
  });
});
