import { describe, expect, test } from "bun:test";
import { join } from "node:path";

interface GateOutcome {
  remoteCalls: number;
  localCalls: number;
  judgeCalls: number;
  spent: number;
  journal: { purpose: string; cost: number }[];
  notices: string[];
  translated?: { query: string; cost: number; translation?: { skipped?: string } };
}

function exerciseCostGate(mode: "capped-main" | "capped-sub" | "no-session" | "remote" | "remote-error" | "local"): GateOutcome {
  // Load host consumers after transport mocks so each isolated process tests the real command without network requests.
  const script = `
    import { mock } from "bun:test";
    import { mkdtemp, rm, writeFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const ai = await import("@oh-my-pi/pi-ai");
    const mode = ${JSON.stringify(mode)};
    let remoteCalls = 0;
    let localCalls = 0;
    let judgeCalls = 0;
    mock.module("@oh-my-pi/pi-ai", () => ({
      ...ai,
      completeSimple: async (model) => {
        if (model.api === "local-inference") {
          localCalls++;
          return {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [{ type: "text", text: "find implementation" }], stopReason: "stop",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            timestamp: Date.now(),
          };
        }
        remoteCalls++;
        return {
          role: "assistant", api: "openai-completions", provider: "openai", model: "fixture-remote",
          content: [{ type: "text", text: "find implementation" }],
          stopReason: mode === "remote-error" ? "error" : "stop",
          errorMessage: mode === "remote-error" ? "injected translation failure" : undefined,
          usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
            cost: { input: 0.04, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.05 } },
          timestamp: Date.now(),
        };
      },
      createNativeJudge: (model) => new ai.NativeJudge({
        api: "typesafe", provider: "typesafe", model: model.id, apiKey: "fixture", baseUrl: "http://fixture.invalid",
        fetch: async (_url, init) => {
          judgeCalls++;
          const payload = JSON.parse(init.body);
          return Response.json({
            model: model.id,
            answers: Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { type: "noul", noul: 0.95 }])),
            usage: { input_tokens: 17, output_tokens: 3 },
          });
        },
      }),
    }));
    const { Settings, withActiveSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const { cfgModelRoles } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
    const { cfgSessionMaxCost } = await import("@oh-my-pi/pi-coding-agent/session/settings");
    const { cfgFindEnabled } = await import("@oh-my-pi/pi-coding-agent/tools/settings");
    const { CostGate } = await import("@oh-my-pi/pi-coding-agent/session/cost-gate");
    const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
    const { translateQuery } = await import("./plugins/find-console/src/translation.ts");
    const { default: findConsole } = await import("./plugins/find-console/src/index.ts");
    const settings = Settings.isolated();
    cfgSessionMaxCost.override(settings, mode === "remote-error" ? 0.05 : 1);
    cfgFindEnabled.override(settings, "on");
    const capped = mode.startsWith("capped") || mode === "local" || mode === "no-session";
    const costGate = new CostGate(settings, capped ? 1 : 0, () => {});
    cfgModelRoles.override(settings, {
      tiny: mode === "local" ? "local/fixture-tiny" : "openai/fixture-remote",
      smol: "openai/fixture-remote", judge: "typesafe/fixture-judge",
    });
    const common = { input: ["text"], reasoning: false, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768, maxTokens: 4096 };
    const models = [
      { ...common, api: "openai-completions", provider: "openai", id: "fixture-remote", name: "Remote" },
      { ...common, api: "local-inference", provider: "local", id: "fixture-tiny", name: "Local" },
      { ...common, api: "typesafe", provider: "typesafe", id: "fixture-judge", name: "Judge" },
    ];
    const modelRegistry = { getAvailable: () => models, getApiKey: async () => "fixture", resolver: () => "fixture",
      resolveModelHeaders: async () => undefined };
    const journal = [];
    const notices = [];
    const cwd = await mkdtemp(join(tmpdir(), "find-console-cost-gate-"));
    try {
      const file = join(cwd, "fixture.ts");
      await writeFile(file, "export const implementation = 'find implementation';\\n");
      const sessionManager = {
        getSessionId: () => "fixture-session", getSessionDir: () => cwd, getSessionFile: () => undefined,
        getArtifactsDir: () => cwd, getLeafId: () => null, appendModelUsage: (entry) => journal.push(entry),
      };
      const ctx = { cwd, sessionManager, modelRegistry, hasUI: false, mode: "rpc" };
      let translated;
      if (mode === "remote" || mode === "remote-error" || mode === "local") {
        translated = await translateQuery({ query: "查找实现", enabled: true, settings, ctx, costGate,
          signal: new AbortController().signal, onUsage: (entry) => journal.push(entry) });
      } else {
        if (mode !== "no-session") AgentRegistry.global().register({
          id: "fixture-agent", displayName: "Fixture", kind: mode === "capped-sub" ? "sub" : "main",
          session: { sessionManager, costGate },
        });
        let command;
        findConsole({
          setLabel() {}, on() {}, logger: { warn() {} },
          registerCommand: (_name, value) => { command = value; },
          sendMessage: (message) => notices.push(message.content),
        });
        await withActiveSettings(settings, () => command.handler('--no-cache --path ' + file + ' 查找实现', ctx));
      }
      console.log(JSON.stringify({ remoteCalls, localCalls, judgeCalls, spent: costGate.spent, translated, notices,
        journal: journal.map((entry) => ({ purpose: entry.purpose, cost: entry.usage.cost.total })) }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), timeout: 10000 });
  expect({ exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }).toMatchObject({ exitCode: 0 });
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

describe("find console session cost gate", () => {
  test("a capped main or agent session sends neither remote translation nor judge requests and reports both refusals", () => {
    for (const mode of ["capped-main", "capped-sub"] as const) {
      const result = exerciseCostGate(mode);
      expect(result).toMatchObject({ remoteCalls: 0, localCalls: 0, judgeCalls: 0, spent: 1, journal: [] });
      const notice = result.notices.join("\n");
      expect(notice).toContain("Translation skipped: tiny: Cost cap reached:");
      expect(notice).toContain("smol: Cost cap reached:");
      expect(notice).toContain("Find unavailable:");
      expect(notice.match(/Cost cap reached:/g)?.length).toBeGreaterThan(2);
    }
  });

  test("remote translation records its cost on the session gate and preserves usage journaling", () => {
    const result = exerciseCostGate("remote");
    expect(result).toMatchObject({
      remoteCalls: 1,
      localCalls: 0,
      spent: 0.05,
      translated: { query: "find implementation", cost: 0.05 },
      journal: [{ purpose: "find-translate", cost: 0.05 }],
    });
  });

  test("a billed failed translation is recorded before the gate refuses its fallback", () => {
    const result = exerciseCostGate("remote-error");
    expect(result).toMatchObject({
      remoteCalls: 1,
      spent: 0.05,
      translated: { query: "查找实现", cost: 0.05 },
      journal: [{ purpose: "find-translate", cost: 0.05 }],
    });
    expect(result.translated?.translation?.skipped).toContain("tiny: injected translation failure");
    expect(result.translated?.translation?.skipped).toContain("smol: Cost cap reached:");
  });

  test("local tiny translation remains available at the cap and incurs no gate or journal charge", () => {
    expect(exerciseCostGate("local")).toMatchObject({
      remoteCalls: 0,
      localCalls: 1,
      spent: 1,
      journal: [],
      translated: { query: "find implementation", cost: 0 },
    });
  });

  test("without a matching live session translation and judgments retain their existing behavior", () => {
    const result = exerciseCostGate("no-session");
    expect(result.remoteCalls).toBe(1);
    expect(result.judgeCalls).toBeGreaterThan(0);
    expect(result.spent).toBe(1);
    expect(result.notices.join("\n")).not.toContain("Cost cap reached:");
    expect(result.journal).toContainEqual({ purpose: "find-translate", cost: 0.05 });
  });
});
