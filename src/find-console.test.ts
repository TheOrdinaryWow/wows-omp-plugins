import { describe, expect, test } from "bun:test";

import type { FindHit, FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";

import { parseFindArgs } from "../plugins/find-console/src/args.ts";
import { disabledReason, hitMessage, previewWindow, rankedDigest, reference, selectedRange } from "../plugins/find-console/src/results.ts";

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
