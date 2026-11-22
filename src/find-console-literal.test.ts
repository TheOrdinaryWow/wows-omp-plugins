import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { initTheme, type NativeNode, type TUI, theme } from "@oh-my-pi/pi-tui";

import { FindConsole } from "../plugins/find-console/src/console.ts";
import { FindResultsController } from "../plugins/find-console/src/controller.ts";
import type { PreviewReader } from "../plugins/find-console/src/preview.ts";
import type { ConsoleReport } from "../plugins/find-console/src/report.ts";
import { hitMessage, rankedDigest } from "../plugins/find-console/src/results.ts";

interface CommandOutcome {
  judgeCalls: number;
  notices: string[];
  dialogs: { title: string; options: string[] }[];
  uiNotices: string[];
  opened: string;
}

function runFailingJudgeCommand(hasUI: boolean, explicitUrlFile = false): CommandOutcome {
  // Dynamic imports load the host only after the judge transport mock replaces it in this isolated process.
  const script = `
    import { mock } from "bun:test";
    import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const ai = await import("@oh-my-pi/pi-ai");
    let judgeCalls = 0;
    mock.module("@oh-my-pi/pi-ai", () => ({
      ...ai,
      createNativeJudge: (model) => new ai.NativeJudge({
        api: "typesafe", provider: "typesafe", model: model.id, apiKey: "fixture", baseUrl: "http://fixture.invalid",
        fetch: async () => {
          judgeCalls++;
          return new Response("injected judge outage", { status: 400 });
        },
      }),
    }));
    const { Settings, withActiveSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
    const { cfgModelRoles } = await import("@oh-my-pi/pi-coding-agent/config/model-settings");
    const { cfgFindEnabled } = await import("@oh-my-pi/pi-coding-agent/tools/settings");
    const { default: findConsole } = await import("./plugins/find-console/src/index.ts");
    const settings = Settings.isolated();
    cfgFindEnabled.override(settings, "on");
    cfgModelRoles.override(settings, { judge: "typesafe/fixture-judge" });
    const models = [{ api: "typesafe", provider: "typesafe", id: "fixture-judge", name: "Judge", input: ["text"], reasoning: false,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }];
    const modelRegistry = { getAvailable: () => models, getApiKey: async () => "fixture", resolver: () => "fixture",
      resolveModelHeaders: async () => undefined };
    const cwd = await mkdtemp(join(tmpdir(), "find-console-literal-"));
    const explicitUrlFile = ${explicitUrlFile};
    const opened = join(cwd, "opened.txt");
    process.env.VISUAL = "printf '%s %s' > '" + opened + "'";
    const notices = [];
    const uiNotices = [];
    const dialogs = [];
    try {
      await mkdir(join(cwd, "src"));
      await writeFile(join(cwd, "src", "alpha.ts"), "const a = 1;\\nexport function implementation() {\\n  return 'implementation answer';\\n}\\n");
      await writeFile(join(cwd, "src", "beta.ts"), "// unrelated\\nexport const implementation = 2;\\n");
      if (explicitUrlFile) {
        const docs = join(cwd, "local", "docs");
        await mkdir(docs, { recursive: true });
        await writeFile(join(docs, "my file.ts"), "export const implementation = 3;\\n");
      }
      const sessionManager = {
        getSessionId: () => "fixture-session", getSessionDir: () => cwd, getSessionFile: () => undefined,
        getArtifactsDir: () => cwd, getLeafId: () => null, appendModelUsage: () => {},
      };
      const ui = {
        supportsEditor: false,
        setStatus() {},
        notify: (message) => uiNotices.push(message),
        input: async () => undefined,
        select: async (title, options, opts) => {
          const labels = options.map((option) => (typeof option === "string" ? option : option.label));
          dialogs.push({ title, options: labels });
          if (labels[0] === "Cancel search") {
            const { promise, resolve } = Promise.withResolvers();
            opts.signal.addEventListener("abort", () => resolve(undefined));
            return promise;
          }
          if (dialogs.filter((dialog) => dialog.options[0] !== "Cancel search").length === 1)
            return labels.find((label) => label.includes("src/beta.ts:2"));
          if (labels.includes("Open externally") && !uiNotices.some((notice) => notice.startsWith("Opened"))) return "Open externally";
          return undefined;
        },
      };
      const ctx = { cwd, sessionManager, modelRegistry, hasUI: ${hasUI}, mode: "rpc", ui, isIdle: () => true };
      let command;
      findConsole({
        setLabel() {}, on() {}, logger: { warn() {} },
        registerCommand: (_name, value) => { command = value; },
        sendMessage: (message) => notices.push(message.content),
        sendUserMessage() {},
      });
      const scope = explicitUrlFile ? '--path local://docs/my%20file.ts --glob "my *.ts"' : "--path src";
      await withActiveSettings(settings, () => command.handler("--no-cache --no-translate " + scope + " -k implementation implementation", ctx));
      const openedText = await readFile(opened, "utf8").catch(() => "");
      console.log(JSON.stringify({ judgeCalls, notices, dialogs, uiNotices, opened: openedText.replace(cwd, "<cwd>") }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), timeout: 20000 });
  expect({ exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }).toMatchObject({ exitCode: 0 });
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

function literalReport(): ConsoleReport {
  return {
    query: "where versions are bumped",
    keywords: ["versions"],
    threshold: 0.2,
    coverage: "unavailable",
    hits: [],
    lexicalFallback: [
      { rel: "plugins/example/src/index.ts", line: 12, snippet: "const versions = bump(manifest);" },
      { rel: "release-please-config.json", line: 3, snippet: '"versioning": "default"' },
    ],
    cache: { mode: "off", cached: 0, total: 0 },
    previewMode: "snippet",
    elapsedMs: 900,
    cwd: "/project",
    scopePath: ".",
    stats: {
      listed: 20,
      judged: 0,
      requests: 3,
      failed: 3,
      unanswered: 0,
      filesRead: 2,
      fileBytes: 400,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      apiMs: 0,
      windowsJudged: 0,
      windowsPruned: 0,
      mapCards: 0,
      failures: ["naming: injected outage"],
    },
  };
}

const reader = {
  read: async (hit: { rel: string }) => ({
    lines: Array.from({ length: 30 }, (_, index) => `${hit.rel} line ${index + 1}`),
    truncated: false,
  }),
  invalidate() {},
} as unknown as PreviewReader;
const tui = { terminal: { rows: 36 }, requestRender() {} } as unknown as TUI;

function nativeNodes(root: NativeNode): NativeNode[] {
  const nodes = [root];
  for (const child of root.c ?? []) if ("k" in child) nodes.push(...nativeNodes(child));
  return nodes;
}

const plain = (lines: readonly string[]) => lines.map((line) => Bun.stripANSI(line).trimEnd()).join("\n");

beforeAll(async () => {
  await initTheme();
});

describe("literal keyword fallback when every judge request failed", () => {
  test("the headless command reports cwd-relative literal matches under the coverage warning", () => {
    const outcome = runFailingJudgeCommand(false);
    expect(outcome.judgeCalls).toBeGreaterThan(0);
    const notice = outcome.notices.join("\n");
    expect(notice).toContain("Find unavailable: nothing was judged");
    expect(notice).toContain("The literal matches shown are unranked and are not ranked evidence");
    expect(notice).toContain("Literal matches (unranked), not semantically judged:");
    expect(notice).toContain("src/alpha.ts:2 · export function implementation() {");
    expect(notice).toContain("src/beta.ts:2 · export const implementation = 2;");
    expect(notice).not.toContain("try grep");
  });

  test("a glob matches the decoded basename of an explicit URL file and reports its encoded URL", () => {
    const outcome = runFailingJudgeCommand(false, true);
    const notices = outcome.notices.join("\n");
    expect(notices).toContain("local://docs/my%20file.ts");
    expect(notices).toContain("export const implementation = 3;");
  });

  test("a dialog host lists the literal rows as selectable entries and opens the chosen line", () => {
    const outcome = runFailingJudgeCommand(true);
    const results = outcome.dialogs.find((dialog) => dialog.options.includes("Search within results"));
    expect(results?.title).toContain("The literal matches shown are unranked");
    expect(results?.options.filter((label) => label.endsWith("· unranked"))).toEqual(
      expect.arrayContaining([expect.stringContaining("src/alpha.ts:2-2"), expect.stringContaining("src/beta.ts:2-2")]),
    );
    expect(outcome.dialogs.some((dialog) => dialog.title === "src/beta.ts:2-2 · unranked literal match")).toBe(true);
    expect(outcome.opened).toBe("+2 <cwd>/src/beta.ts");
    expect(outcome.uiNotices).toContain("Opened src/beta.ts:2-2.");
  });

  test("the digest and a sent message keep literal rows apart from ranked evidence", () => {
    const report = literalReport();
    const digest = rankedDigest(report);
    expect(digest).toContain("Literal matches (unranked), not semantically judged:\n   plugins/example/src/index.ts:12 · const versions");
    expect(digest).not.toContain("No hits.");
    const controller = new FindResultsController(report, reader, true);
    const [first] = controller.entries;
    if (!first) throw new Error("missing literal entry");
    const message = hitMessage(report, [first]);
    expect(message).toContain("plugins/example/src/index.ts:12-12 (literal keyword match, unranked)");
    expect(message).not.toContain("score");
  });

  test("the terminal console renders a literal group without scores, and keys select and open its rows", async () => {
    const controller = new FindResultsController(literalReport(), reader, true);
    const view = new FindConsole(controller, theme, tui);
    const actions: string[] = [];
    controller.onAction = (result) => actions.push(`${result.action} ${controller.selectedReference}`);
    await Promise.resolve();
    view.handleInput("\x1b[B");
    await Promise.resolve();
    const frame = plain(view.render(120));
    expect(frame).toContain("Find · 0 hits · 2 literal matches");
    expect(frame).toContain("No ranked hits.");
    expect(frame).toContain("Literal matches (unranked)");
    expect(frame).toContain("release-please-config.json:3");
    expect(frame).toContain("unranked literal match");
    expect(frame).toContain("literal 2/2");
    expect(frame).not.toMatch(/0\.00/);
    expect(frame).toContain("release-please-config.json line 3");
    view.handleInput("o");
    view.handleInput("\r");
    expect(actions).toEqual(["open release-please-config.json:3-3", "insert release-please-config.json:3-3"]);
  });

  test("the Tern surface lists literal matches in their own list, and a click selects that row's source", async () => {
    const controller = new FindResultsController(literalReport(), reader, true);
    const view = new FindConsole(controller, theme, tui);
    await Promise.resolve();
    const describe = () => nativeNodes(view.describe());
    const literal = describe().find((node) => node.k === "list" && node.p?.role === "omp.find-console.literal");
    const items = (literal?.c ?? []).filter((child): child is NativeNode => "k" in child && child.k === "item");
    expect(items.map((node) => (node.k === "item" ? [node.p?.label, node.p?.detail, node.p?.tone] : []))).toEqual([
      ["index.ts:12", "const versions = bump(manifest);", "muted"],
      ["release-please-config.json:3", '"versioning": "default"', "muted"],
    ]);
    expect(literal?.k === "list" ? literal.p?.selected : undefined).toBe("literal-0");
    const nodes = describe();
    expect(nodes.some((node) => node.k === "list" && node.p?.role === "omp.find-console.hits")).toBe(false);
    expect(nodes.some((node) => node.k === "list" && node.p?.role === "omp.find-console.ranges")).toBe(false);
    expect(nodes.some((node) => node.k === "progress")).toBe(false);
    expect(nodes.some((node) => node.k === "badge" && node.p?.text === "unranked literal match")).toBe(true);
    view.handleNativeEvent({ type: "select", key: "split/sidebar/literal", item: "literal-1" });
    await Promise.resolve();
    expect(controller.selectedReference).toBe("release-please-config.json:3-3");
    const marks = describe()
      .filter((node) => node.k === "code")
      .flatMap((node) => (node.k === "code" ? (node.p?.marks ?? []) : []));
    expect(marks).toEqual([{ line: 3, tone: "accent" }]);
    const actions: string[] = [];
    controller.onAction = (result) => actions.push(result.action);
    view.handleNativeEvent({ type: "activate", key: "split/sidebar/literal", item: "literal-1" });
    view.handleNativeEvent({ type: "action", key: "actions/open", act: "open", mods: [] });
    expect(actions).toEqual(["insert", "open"]);
  });
});
