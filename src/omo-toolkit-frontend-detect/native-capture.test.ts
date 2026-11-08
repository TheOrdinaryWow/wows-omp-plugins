// Repository-only tests for the OMP adaptation of the frontend detect SDK (oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace).
// Licenses: Sustainable Use License 1.0 (../../plugins/omo-toolkit/LICENSE-SUL-1.0) and Apache-2.0 (../../plugins/omo-toolkit/skills/frontend/ATTRIBUTION.md section 7).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createNativeBrowserRenderer,
  detectPage,
  isPageSnapshot,
  lintSnapshot,
  lintSources,
  type NativeBrowser,
  type PageSnapshot,
  RenderError,
  SCRIPT_ERROR_PROBE,
  SETTLE_EXPRESSION,
  type Viewport,
} from "../../plugins/omo-toolkit/skills/frontend/scripts/detect/index";
import { CONTENT_STRESS_SCRIPT } from "../../plugins/omo-toolkit/skills/frontend/scripts/detect/render/renderer";

const CLI = join(import.meta.dir, "../../plugins/omo-toolkit/skills/frontend/scripts/detect/cli.ts");
// Captured from fixtures/native-page.html by the OMP native browser: managed Chromium, 1440x900, SCRIPT_ERROR_PROBE as init script,
// SETTLE_EXPRESSION, then snapshotExpression().
const NATIVE_SNAPSHOT = join(import.meta.dir, "fixtures/native-snapshot.json");
const nativeSnapshot = (): PageSnapshot => JSON.parse(readFileSync(NATIVE_SNAPSHOT, "utf8"));

function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 30_000 });
}

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "frontend-detect-test-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("blocking policy", () => {
  test("only objective rendered defects block; a generated-look warning is reported without blocking", () => {
    const findings = lintSnapshot(nativeSnapshot());
    expect(findings.map((f) => [f.ruleId, f.severity, f.blocking])).toEqual([
      ["low-contrast", "error", true],
      ["kicker-above-heading", "warning", false],
      ["skipped-heading", "warning", true],
    ]);
  });

  test("a project override to advisory unblocks an objective rule, and source-text findings never block", () => {
    const relaxed = lintSnapshot(nativeSnapshot(), { config: { rules: { "low-contrast": "advisory" } } });
    expect(relaxed.find((f) => f.ruleId === "low-contrast")?.blocking).toBe(false);
    const source = lintSources([{ path: "card.css", text: ".card { border-radius: 12px; border-left: 4px solid #6366f1; }" }]);
    expect(source.length).toBeGreaterThan(0);
    expect(source.every((f) => !f.blocking)).toBe(true);
  });
});

describe("cli over native-browser snapshots", () => {
  test("lints the captured snapshot, fails on blocking findings, and names the surface and its limits", () => {
    const result = cli(NATIVE_SNAPSHOT);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("error blocking  low-contrast");
    expect(result.stdout).toContain("warning  kicker-above-heading");
    expect(result.stdout).toContain("3 finding(s): 1 error, 2 warning, 0 advisory; 2 blocking");
    expect(result.stdout).toContain("inspected file:///fixtures/native-page.html @1440x900");
    expect(result.stdout).toContain("shadow DOM not inspected (1 open shadow root(s)");
    expect(result.stdout).toContain("frame documents not inspected (1 iframe/frame element(s))");
    expect(result.stdout).toContain("zero findings is not a complete visual or accessibility verification");
  });

  test("JSON output carries the summary, per-surface limits and scope", () => {
    const result = cli("--json", NATIVE_SNAPSHOT);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.summary).toEqual({ error: 1, warning: 2, advisory: 0, blocking: 2 });
    expect(report.surfaces[0].coverage).toMatchObject({ elementCount: 8, shadowRoots: 1, frames: 1, contentStress: false });
    expect(report.surfaces[0].limits).toContain("all 8 elements inspected (cap 20000)");
    expect(report.scope).toContain("zero findings");
  });

  test("non-blocking warnings alone exit 0", () => {
    withDirectory((directory) => {
      const config = join(directory, "detect.json");
      writeFileSync(config, JSON.stringify({ rules: { "low-contrast": "advisory", "skipped-heading": "advisory" } }));
      const result = cli("--config", config, NATIVE_SNAPSHOT);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("0 blocking");
      expect(result.stdout).toContain("kicker-above-heading");
    });
  });

  test("refuses targets it would have to render, and invalid snapshots, with exit 2", () => {
    withDirectory((directory) => {
      const page = join(directory, "page.html");
      writeFileSync(page, "<p>x</p>");
      const stale = join(directory, "stale.json");
      const { coverage: _coverage, ...withoutCoverage } = nativeSnapshot();
      writeFileSync(stale, JSON.stringify(withoutCoverage));
      for (const [target, message] of [
        ["http://localhost:5173/", "cannot render http://localhost:5173/"],
        [page, `cannot render ${page}`],
        [stale, "not a frontend-detect page snapshot"],
        [directory, "nothing inspected; capture"],
      ] as const) {
        const result = cli(target);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(message);
      }
    });
  });

  test("lists discovered pages as not rendered while linting the directory's source files", () => {
    withDirectory((directory) => {
      writeFileSync(join(directory, "page.html"), "<p>x</p>");
      writeFileSync(join(directory, "app.css"), "body { color: #111; }");
      const result = cli(directory);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("source text only: 1 file(s)");
      expect(result.stdout).toContain(`not rendered (capture in the native browser): ${join(directory, "page.html")}`);
    });
  });
});

type Opened = { options: Readonly<Record<string, unknown>>; evaluated: string[]; closed: boolean };

function viewportOf(options: Readonly<Record<string, unknown>>): Viewport {
  const v = options.viewport;
  if (typeof v === "object" && v !== null && "width" in v && "height" in v && typeof v.width === "number" && typeof v.height === "number") {
    return { width: v.width, height: v.height };
  }
  throw new Error("browser.open was called without a viewport");
}

function fakeBrowser(failOn?: string): { browser: NativeBrowser; opened: Opened[] } {
  const opened: Opened[] = [];
  const browser: NativeBrowser = {
    async open(options) {
      const record: Opened = { options, evaluated: [], closed: false };
      opened.push(record);
      const viewport = viewportOf(options);
      return {
        async evaluate(expression: string) {
          record.evaluated.push(expression === SETTLE_EXPRESSION ? "settle" : expression === CONTENT_STRESS_SCRIPT ? "stress" : "snapshot");
          if (expression === failOn) throw new Error("page crashed");
          if (expression === SETTLE_EXPRESSION || expression === CONTENT_STRESS_SCRIPT) return true;
          const base = nativeSnapshot();
          return { ...base, viewport, coverage: { ...base.coverage, contentStress: record.evaluated.includes("stress") } };
        },
        async close() {
          record.closed = true;
        },
      };
    },
  };
  return { browser, opened };
}

describe("native-browser renderer", () => {
  test("opens one owned tab per pass with the probe, stresses only the 320 reflow pass, and closes every tab", async () => {
    const { browser, opened } = fakeBrowser();
    const renderer = createNativeBrowserRenderer(browser, { open: { app: { relay: true }, timeout: 60 } });
    const report = await detectPage({ kind: "url", url: "http://localhost:5173/settings" }, { renderer, reflow: true });
    await renderer.close();
    expect(opened.map((o) => viewportOf(o.options).width)).toEqual([1440, 390, 320, 375, 768, 1024, 1440]);
    expect(opened.every((o) => o.closed)).toBe(true);
    expect(new Set(opened.map((o) => o.options.name)).size).toBe(opened.length);
    expect(opened[0]?.options).toMatchObject({
      url: "http://localhost:5173/settings",
      init_scripts: [SCRIPT_ERROR_PROBE],
      wait_until: "load",
      app: { relay: true },
      timeout: 60,
    });
    expect(opened.map((o) => o.evaluated.join(","))).toEqual([
      "settle,snapshot",
      "settle,snapshot",
      "settle,stress,snapshot",
      "settle,snapshot",
      "settle,snapshot",
      "settle,snapshot",
      "settle,snapshot",
    ]);
    expect(report.surfaces.map((s) => s.coverage.contentStress)).toEqual([false, false, true, false, false, false, false]);
    expect(isPageSnapshot(nativeSnapshot())).toBe(true);
  });

  test("wraps a page failure in RenderError and still closes the tab", async () => {
    const { browser, opened } = fakeBrowser(SETTLE_EXPRESSION);
    const renderer = createNativeBrowserRenderer(browser);
    const render = renderer.render({ target: { kind: "url", url: "http://localhost/" }, viewport: { width: 390, height: 844 } });
    await expect(render).rejects.toBeInstanceOf(RenderError);
    expect(opened[0]?.closed).toBe(true);
  });

  test("renders inline HTML from a scratch file that close() removes", async () => {
    const { browser, opened } = fakeBrowser();
    const renderer = createNativeBrowserRenderer(browser);
    await renderer.render({ target: { kind: "html", html: "<p>x</p>" }, viewport: { width: 390, height: 844 } });
    const file = fileURLToPath(String(opened[0]?.options.url));
    expect(readFileSync(file, "utf8")).toBe("<p>x</p>");
    await renderer.close();
    expect(existsSync(file)).toBe(false);
  });

  test("refuses a borrowed tab and the open options it owns", () => {
    const { browser } = fakeBrowser();
    expect(() => createNativeBrowserRenderer(browser, { open: { app: { relay: true, target: "Settings" } } })).toThrow("app.target");
    expect(() => createNativeBrowserRenderer(browser, { open: { viewport: { width: 1, height: 1 } } })).toThrow("viewport");
  });
});
