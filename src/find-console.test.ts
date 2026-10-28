import { beforeAll, describe, expect, test, vi } from "bun:test";

import { initTheme, type NativeNode, type TUI, theme, visibleWidth } from "@oh-my-pi/pi-tui";
import type { FindHit, FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";

import { parseFindArgs } from "../plugins/find-console/src/args.ts";
import { FindConsole } from "../plugins/find-console/src/console.ts";
import { FindProgressController, FindResultsController } from "../plugins/find-console/src/controller.ts";
import type { PreviewReader } from "../plugins/find-console/src/preview.ts";
import { FindProgress } from "../plugins/find-console/src/progress-view.ts";
import { disabledReason, hitMessage, previewWindow, rankedDigest, reference, selectedRange } from "../plugins/find-console/src/results.ts";
import { parseUiMenu } from "../plugins/find-console/src/settings.ts";

const hit: FindHit = {
  rel: "plugins/example/src/index.ts",
  contentScore: 0.92,
  linesSeen: 120,
  truncated: false,
  ranges: [
    { start: 4, end: 7, p: 0.65, snippet: "early context" },
    { start: 80, end: 88, p: 0.92, snippet: "the implementation" },
    { start: 40, end: 40, p: 0.92, snippet: "same score, earlier line" },
  ],
};

function report(extra: Partial<FindToolDetails> = {}): FindToolDetails {
  return {
    query: "where versions are bumped",
    keywords: ["versions"],
    threshold: 0.2,
    coverage: "complete",
    hits: [hit],
    elapsedMs: 2000,
    cwd: "/project",
    scopePath: "plugins/",
    stats: {
      listed: 200,
      judged: 128,
      requests: 12,
      failed: 0,
      unanswered: 1,
      filesRead: 20,
      fileBytes: 1000,
      inputTokens: 2000,
      outputTokens: 100,
      cost: 0.0123,
      apiMs: 4000,
      windowsJudged: 30,
      windowsPruned: 5,
      mapCards: 30,
      failures: [],
    },
    ...extra,
  };
}

beforeAll(async () => {
  await initTheme();
});

function nativeNodes(root: NativeNode): NativeNode[] {
  const nodes = [root];
  for (const child of root.c ?? []) {
    if ("k" in child) nodes.push(...nativeNodes(child));
  }
  return nodes;
}

describe("loading presentation", () => {
  const tui = { terminal: { rows: 36 }, requestRender() {} } as unknown as TUI;

  test("source loading reserves the same native code rows and terminal frame height as loaded content", async () => {
    const reader = {
      read: async () => ({ lines: Array.from({ length: 120 }, (_, index) => `line ${index + 1} ${"x".repeat(200)}`), truncated: false }),
    } as unknown as PreviewReader;
    const controller = new FindResultsController(report(), reader, true);
    const view = new FindConsole(controller, theme, tui);
    const loading = nativeNodes(view.describe()).find((node) => node.k === "code");
    const loadingHeight = view.render(120).length;
    const half = new FindConsole(new FindResultsController(report(), reader, true), theme, tui, true);
    const halfLoadingHeight = half.render(80).length;
    await Promise.resolve();
    const loaded = nativeNodes(view.describe()).find((node) => node.k === "code");
    expect(loading?.k).toBe("code");
    expect(loaded?.k).toBe("code");
    if (loading?.k !== "code" || loaded?.k !== "code") throw new Error("source code block missing");
    expect(loading.p?.text?.split("\n")).toHaveLength(12);
    expect(loaded.p?.text?.split("\n")).toHaveLength(12);
    expect(loading.p?.path).toBe(loaded.p?.path);
    expect(loading.p?.numbers).toBe(loaded.p?.numbers);
    for (const line of loaded.p?.text?.split("\n") ?? []) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(64);
      expect(line.endsWith("…")).toBe(true);
    }
    expect(view.render(120)).toHaveLength(loadingHeight);
    expect(half.render(80)).toHaveLength(halfLoadingHeight);
  });

  test("fast searches stay static, while a still-pending search animates after a second in both renderers", () => {
    vi.useFakeTimers();
    const controller = new FindProgressController("where versions are bumped", () => {});
    const view = new FindProgress(controller, theme, tui);
    try {
      const initial = view.render(80);
      expect(nativeNodes(view.describe()).some((node) => node.k === "spinner")).toBe(false);
      vi.advanceTimersByTime(160);
      expect(view.render(80)).toEqual(initial);
      expect(nativeNodes(view.describe()).some((node) => node.k === "spinner")).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(nativeNodes(view.describe()).some((node) => node.k === "spinner")).toBe(true);
      expect(view.render(80)).not.toEqual(initial);
    } finally {
      view.dispose();
      vi.useRealTimers();
    }
  });
});

describe("find arguments", () => {
  test("unquoted queries remain natural language while explicit scopes and repeated keywords stay separate", () => {
    expect(parseFindArgs('where release versions are bumped --path "plugins/with spaces" -k release-please -k "package version"')).toEqual({
      query: "where release versions are bumped",
      path: "plugins/with spaces",
      keywords: ["release-please", "package version"],
      help: false,
      cancel: false,
    });
  });

  test("quotes, escaped whitespace, internal URLs and literal dash-leading queries survive parsing", () => {
    expect(parseFindArgs('--path omp://extensions.md -k "sendUserMessage" -- -how "commands work"').query).toBe("-how commands work");
    expect(parseFindArgs('--path omp://extensions.md "judge role"').path).toBe("omp://extensions.md");
    expect(parseFindArgs("-p path\\ with\\ spaces 'how \\\\ paths work'").path).toBe("path with spaces");
    expect(parseFindArgs('-p "C:\\source\\project" windows paths').path).toBe("C:\\source\\project");
  });

  test("an empty invocation can prompt, and cancellation cannot silently discard a query", () => {
    expect(parseFindArgs(" ").query).toBe("");
    expect(parseFindArgs("--cancel").cancel).toBe(true);
    expect(() => parseFindArgs("--cancel where versions change")).toThrow("on its own");
    expect(() => parseFindArgs("--cancel --path src")).toThrow("on its own");
  });

  test("missing values and ambiguous scopes refuse instead of searching the wrong project area", () => {
    for (const input of [
      "-k",
      "--path",
      "-k --path src query",
      '--path "" query',
      "--path src -p lib query",
      '"unfinished',
      "--unknown query",
    ]) {
      expect(() => parseFindArgs(input)).toThrow();
    }
  });
});

describe("find enablement", () => {
  test("off always refuses, auto needs a native primary, and on follows the host gate", () => {
    expect(disabledReason("off", true)).toContain("find.enabled is off");
    expect(disabledReason("off", false)).toContain("find.enabled is off");
    expect(disabledReason("auto", false)).toContain("judge role");
    expect(disabledReason("auto", false)).toContain("no chat model");
    expect(disabledReason("auto", true)).toBeUndefined();
    expect(disabledReason("on", false)).toBeUndefined();
    expect(disabledReason("on", true)).toBeUndefined();
  });
});

describe("terminal layout setting", () => {
  test("explicit fullscreen and half-screen choices survive parsing while unsupported layouts are rejected", () => {
    expect(parseUiMenu("fullscreen")).toBe("fullscreen");
    expect(parseUiMenu("half-screen")).toBe("half-screen");
    for (const value of ["inline", "half", "", null, true, 50, { mode: "half-screen" }]) {
      expect(() => parseUiMenu(value)).toThrow("invalid uiMenu");
    }
  });
});

describe("judged references and previews", () => {
  test("the strongest range wins and ties use the earlier line without changing cascade data", () => {
    expect(reference(hit)).toBe("plugins/example/src/index.ts:40-40");
    expect(reference(hit, 1)).toBe("plugins/example/src/index.ts:80-88");
    expect(selectedRange(hit, -1)?.start).toBe(4);
    expect(selectedRange(hit, 3)?.start).toBe(40);
    expect(hit.ranges[0]?.start).toBe(4);
  });

  test("references preserve internal URLs, spaces and a hit with no range", () => {
    expect(reference({ ...hit, rel: "omp://extensions.md" }, 1)).toBe("omp://extensions.md:80-88");
    expect(reference({ ...hit, rel: "a directory/file.ts" })).toBe("a directory/file.ts:40-40");
    expect(reference({ ...hit, rel: "skill://example/SKILL.md", ranges: [] })).toBe("skill://example/SKILL.md");
  });

  test("preview context keeps original line coordinates at either end of a short file", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    expect(previewWindow(lines, { start: 2, end: 3, p: 1, snippet: "" })).toEqual({ start: 1, lines: lines.slice(0, 8) });
    expect(previewWindow(lines, { start: 10, end: 12, p: 1, snippet: "" })).toEqual({ start: 5, lines: lines.slice(4) });
  });

  test("sending a selected non-default range retains that reference and partial coverage", () => {
    const result = report({ coverage: "partial" });
    const message = hitMessage(result, [hit], { hit, range: 1 });
    expect(message).toContain("\nplugins/example/src/index.ts:80-88 (score 0.92)");
    expect(message).toContain("Partial coverage");
  });
});

describe("headless ranked digest", () => {
  test("the digest includes ranked references, partial-file coverage, accounting and failed requests", () => {
    const result = report({ coverage: "partial", hits: [{ ...hit, truncated: true }] });
    result.stats.failed = 2;
    result.stats.failures = ["verification: unavailable"];
    const text = rankedDigest(result);
    expect(text).toContain("1. ━━━━━━ 0.92 plugins/example/src/index.ts");
    expect(text).toContain("plugins/example/src/index.ts:40-40");
    expect(text).toContain("partial file");
    expect(text).toContain("2 of 12 judge requests failed");
    expect(text).toContain("unjudged files may still match");
    expect(text).toContain("$0.0123");
    expect(text).toContain("1 unanswered");
    expect(text).toContain("verification: unavailable");
  });

  test("nothing judged must not become an absence claim", () => {
    const text = rankedDigest(report({ hits: [], coverage: "unavailable" }));
    expect(text).toContain("nothing was judged");
    expect(text).toContain("not evidence of absence");
    expect(text).not.toContain("No hits.");
    expect(rankedDigest(report({ hits: [], coverage: "complete" }))).toContain("No hits.");
  });
});
