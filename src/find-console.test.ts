import { beforeAll, describe, expect, test, vi } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { initTheme, type NativeNode, type TUI, theme, visibleWidth } from "@oh-my-pi/pi-tui";
import type { FindHit } from "@oh-my-pi/pi-tui/tools/find";

import { parseFindArgs } from "../plugins/find-console/src/args.ts";
import { FindConsole } from "../plugins/find-console/src/console.ts";
import { FindProgressController, FindResultsController } from "../plugins/find-console/src/controller.ts";
import { fileMatcher, filterHits } from "../plugins/find-console/src/filters.ts";
import { HISTORY_LIMIT, type HistoryEntry, HistoryStore, historyCommand } from "../plugins/find-console/src/history.ts";
import type { PreviewReader } from "../plugins/find-console/src/preview.ts";
import { FindProgress } from "../plugins/find-console/src/progress-view.ts";
import { decideHitScope } from "../plugins/find-console/src/refinement.ts";
import type { ConsoleHit, ConsoleReport } from "../plugins/find-console/src/report.ts";
import {
  cacheLabel,
  disabledReason,
  formatCost,
  hitMessage,
  previewWindow,
  rankedDigest,
  reference,
  selectedRange,
} from "../plugins/find-console/src/results.ts";
import { parseUiMenu } from "../plugins/find-console/src/settings.ts";
import { needsTranslation } from "../plugins/find-console/src/translation.ts";

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

function report(extra: Partial<ConsoleReport> = {}): ConsoleReport {
  return {
    query: "where versions are bumped",
    keywords: ["versions"],
    threshold: 0.2,
    coverage: "complete",
    hits: [{ ...hit, scope: "ranges", refined: hit.ranges } satisfies ConsoleHit],
    cache: { mode: "on", cached: 0, total: 0 },
    previewMode: "snippet",
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
      noCache: false,
      noTranslate: false,
      history: false,
      globs: [],
      extensions: [],
      minScore: 0.2,
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

  test("repeatable file filters and numeric result limits parse without consuming the query", () => {
    const args = parseFindArgs(
      'version bump --glob "plugins/**/*.ts" --glob "*.json" --ext .TS --ext json --min-score 0.6 --limit 3 --no-cache --no-translate',
    );
    expect(args).toMatchObject({
      query: "version bump",
      globs: ["plugins/**/*.ts", "*.json"],
      extensions: ["ts", "json"],
      minScore: 0.6,
      limit: 3,
      noCache: true,
      noTranslate: true,
    });
    for (const input of [
      "--glob",
      "--ext",
      "--ext '*' query",
      "--min-score 0.1 query",
      "--min-score 1.1 query",
      "--min-score NaN query",
      "--limit 0 query",
      "--limit 1.5 query",
    ])
      expect(() => parseFindArgs(input)).toThrow();
  });
});

describe("result filters", () => {
  test("file filters intersect extension and glob alternatives before judging", () => {
    const matches = fileMatcher({ globs: ["plugins/**/*.ts", "*.json"], extensions: ["ts"] });
    expect(matches("plugins/example/src/index.ts")).toBe(true);
    expect(matches("src/index.ts")).toBe(false);
    expect(matches("package.json")).toBe(false);
  });

  test("min-score removes weak hits and ranges before the hit limit", () => {
    const hits: ConsoleHit[] = [
      { ...hit, contentScore: 0.4, scope: "ranges", refined: hit.ranges },
      { ...hit, rel: "precise.ts", scope: "ranges", refined: hit.ranges },
      { ...hit, rel: "whole.ts", scope: "whole-file", refined: [] },
    ];
    const result = filterHits(hits, { minScore: 0.8, limit: 1 });
    expect(result.map((hit) => hit.rel)).toEqual(["precise.ts"]);
    expect(result[0]?.refined.map((range) => range.p)).toEqual([0.92, 0.92]);
    expect(filterHits(hits, { minScore: 0.8 }).map((hit) => hit.rel)).toEqual(["precise.ts", "whole.ts"]);
  });
});

describe("project search history", () => {
  test("recent searches dedupe, retain the newest flags, stay bounded and survive a new store instance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "find-history-"));
    try {
      const store = new HistoryStore(cwd);
      const entries: HistoryEntry[] = Array.from({ length: HISTORY_LIMIT + 5 }, (_, index) => ({
        args: parseFindArgs(`query ${index}`),
        searchedAt: index,
      }));
      await mkdir(dirname(store.file), { recursive: true });
      await writeFile(store.file, JSON.stringify({ version: 2, entries }));
      const updated = await store.remember({ args: parseFindArgs("--no-cache --ext ts --limit 2 query 54"), searchedAt: 100 });
      expect(updated).toHaveLength(HISTORY_LIMIT);
      expect(updated[0]?.args).toMatchObject({ query: "query 54", noCache: true, extensions: ["ts"], limit: 2 });
      expect(updated.filter((entry) => entry.args.query === "query 54")).toHaveLength(1);
      expect(await new HistoryStore(cwd).load()).toEqual(updated);
      const first = updated[0];
      if (!first) throw new Error("missing saved query");
      expect(parseFindArgs(historyCommand(first))).toEqual(first.args);
      expect(parseFindArgs("--history").history).toBe(true);
      expect(() => parseFindArgs("--history query")).toThrow("on its own");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a previous-version file upgrades on load without losing its original query, scope or keywords", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "find-history-upgrade-"));
    try {
      const store = new HistoryStore(cwd);
      await mkdir(dirname(store.file), { recursive: true });
      await writeFile(
        store.file,
        JSON.stringify({
          version: 1,
          entries: [{ query: "版本号在哪里被提升", path: "plugins", keywords: ["release-please"], searchedAt: 42 }],
        }),
      );
      const loaded = await store.load();
      expect(loaded[0]).toMatchObject({
        args: {
          query: "版本号在哪里被提升",
          path: "plugins",
          keywords: ["release-please"],
          minScore: 0.2,
          noCache: false,
          noTranslate: false,
        },
        searchedAt: 42,
      });
      expect(JSON.parse(await readFile(store.file, "utf8")).version).toBe(2);
      expect(await new HistoryStore(cwd).load()).toEqual(loaded);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("cost and cache accounting labels", () => {
  test("non-zero costs never round to zero", () => {
    expect([0, 0.00004, 0.0005, 0.0123].map(formatCost)).toEqual(["$0", "<$0.0001", "$0.0005", "$0.0123"]);
    expect(parseFindArgs("--no-cache query").noCache).toBe(true);
  });

  test("cache state uses measured question counts, not cost", () => {
    expect(cacheLabel({ mode: "on", cached: 8, total: 8 })).toBe("all cached · answers 8/8");
    expect(cacheLabel({ mode: "on", cached: 2, total: 8 })).toBe("partly cached · answers 2/8");
    expect(cacheLabel({ mode: "on", cached: 0, total: 8 })).toBe("fresh");
    expect(cacheLabel({ mode: "off", cached: 0, total: 8 })).toBe("cache off");
    expect(cacheLabel({ mode: "unavailable", cached: 0, total: 8 })).toBe("cache unavailable");
  });
});

describe("query language detection", () => {
  test("non-Latin letters trigger translation without treating accents or code punctuation as foreign script", () => {
    for (const query of ["版本号在哪里被提升", "где версия", "バージョン更新", "أين الإصدار", "find 中文 identifiers"])
      expect(needsTranslation(query)).toBe(true);
    for (const query of ["where versions change", "café parser déjà vu", "release-please v1.2 #42", "123 --path src", ""])
      expect(needsTranslation(query)).toBe(false);
    expect(parseFindArgs("--no-translate 版本号").noTranslate).toBe(true);
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
  test("only an explicit high-confidence full-file judgment removes line highlights and references", () => {
    expect(decideHitScope(0.95, true)).toBe("whole-file");
    expect(decideHitScope(0.79, true)).toBe("ranges");
    expect(decideHitScope(0.99, false)).toBe("ranges");
    expect(decideHitScope(undefined, true)).toBe("ranges");
    const whole: ConsoleHit = { ...hit, scope: "whole-file", refined: [] };
    expect(reference(whole)).toBe(hit.rel);
    expect(selectedRange(whole, 0)).toBeUndefined();
    const refined: ConsoleHit = { ...hit, scope: "ranges", refined: [{ start: 82, end: 85, p: 0.99, snippet: "precise" }] };
    expect(reference(refined)).toBe(`${hit.rel}:82-85`);
  });

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
    const result = report({ coverage: "partial", hits: [{ ...hit, scope: "ranges", refined: hit.ranges, truncated: true }] });
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

  test("translated and restricted reports preserve the original question in the digest and selected-hit message", () => {
    const result = report({
      query: "version bump location",
      originalQuery: "版本号在哪里被提升",
      translation: { model: "tiny: local/query" },
      within: { query: "release configuration", files: 2 },
    });
    for (const text of [rankedDigest(result), hitMessage(result, result.hits)]) {
      expect(text).toContain("版本号在哪里被提升");
      expect(text).toContain("searched as: version bump location");
      expect(text).toContain("within 2 files of: release configuration");
    }
  });

  test("nothing judged must not become an absence claim", () => {
    const text = rankedDigest(report({ hits: [], coverage: "unavailable" }));
    expect(text).toContain("nothing was judged");
    expect(text).toContain("not evidence of absence");
    expect(text).not.toContain("No hits.");
    expect(rankedDigest(report({ hits: [], coverage: "complete" }))).toContain("No hits.");
  });
});
