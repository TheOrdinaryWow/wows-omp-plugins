// Fixture data ported from oh-my-openagent at 8a8db1d3094da8743989bf693ee5de77889de50e.
// Sustainable Use License 1.0: ../plugins/omo-toolkit/LICENSE-SUL-1.0.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "../plugins/omo-toolkit/skills/frontend/scripts/perfection/check-draft-guard.ts");
const FIXTURES = [
  {
    name: "draft-guard/positive/attribute-edges.html",
    text: '<main>\n  <div class="block hidden md:flex"><p>Seamless sync</p></div>\n  <button title="Show hidden files"><span>Supercharge your team</span></button>\n  <div class="stat"><span>1,000,000+</span></div>\n  <span class="badge" aria-hidden="true">New</span>\n  <template x-if="open"><p>Effortless setup</p></template>\n</main>\n',
    fails: true,
  },
  {
    name: "draft-guard/positive/components.tsx",
    text: 'const cn = (...names: string[]) => names.join(" ")\nexport function Page() {\n  return (\n    <main>\n      <Badge>New</Badge>\n      <span className={cn("badge", "badge--hot")}>Hot</span>\n      <span className="badge">✨ New</span>\n      <p>Launch &#x1F680; today</p>\n      <button type="button" aria-label="🚀 Launch">Go</button>\n      <Stat value="10x" />\n      <StatCard><p>10x</p></StatCard>\n      <div className="metric">{"500+"}</div>\n      <input placeholder="Supercharge your search" />\n    </main>\n  )\n}\n',
    fails: true,
  },
  {
    name: "draft-guard/positive/decorative-badge.vue",
    text: '<template>\n  <div>\n    <span class="badge">New</span>\n    <span class="chip chip--accent">AI-powered</span>\n    <h3>Monthly revenue</h3>\n  </div>\n</template>\n',
    fails: true,
  },
  {
    name: "draft-guard/positive/emoji-icons.tsx",
    text: 'export function Actions() {\n  return (\n    <ul>\n      <li>✅ Fast setup</li>\n      <li>Plain item</li>\n      <button type="button">🚀 Launch</button>\n    </ul>\n  )\n}\n',
    fails: true,
  },
  {
    name: "draft-guard/positive/jsx-edges.tsx",
    text: "export const Beta = () => <p>(beta) Seamless sync</p>\n",
    fails: true,
  },
  {
    name: "draft-guard/positive/promo-copy.html",
    text: '<section class="hero">\n  <h1>Seamlessly manage every report</h1>\n  <p>한눈에 보는 매출 현황</p>\n  <p>Track revenue and refunds.</p>\n  <p>Unlock the power of your data</p>\n</section>\n',
    fails: true,
  },
  {
    name: "draft-guard/positive/promo-copy.tsx",
    text: "export function Hero() {\n  return (\n    <header>\n      <h2>Supercharge your workflow</h2>\n      <p>손쉽게 시작하세요</p>\n    </header>\n  )\n}\n",
    fails: true,
  },
  {
    name: "draft-guard/positive/vanity-stats.html",
    text: '<div class="stats">\n  <div class="stat"><span class="stat-value">10x</span><span>faster</span></div>\n  <div class="metric">$2M+</div>\n  <div class="kpi-card"><strong>24/7</strong></div>\n</div>\n',
    fails: true,
  },
  {
    name: "draft-guard/negative/attr-lookalikes.tsx",
    text: 'export function Bar() {\n  return (\n    <div data-title="Supercharge your team">\n      <StatusBar><span>24/7</span></StatusBar>\n      <span className="badge" aria-current="page">New</span>\n      <div data-x="a title=\'Supercharge your team\'" />\n      <Stat data-value="10x" />\n    </div>\n  )\n}\n',
    fails: false,
  },
  {
    name: "draft-guard/negative/bound-values.tsx",
    text: 'export function Summary({ count, status, uptime }: { count: number; status: string; uptime: string }) {\n  return (\n    <section>\n      <div className="stat"><span className="stat-value">{count}</span><span>open tickets</span></div>\n      <div className="metric">{uptime}</div>\n      <span className="badge" data-status={status}>{status}</span>\n      <span className="badge">3</span>\n      <span className="chip">Failed</span>\n      <p>Seams in the fabric are reinforced.</p>\n    </section>\n  )\n}\n',
    fails: false,
  },
  {
    name: "draft-guard/negative/const-generics.tsx",
    text: 'export const keep = <const T,>(x: T) => x\nexport const label = "Seamless sync"\nexport const Saved = () => <p>saved</p>\n',
    fails: false,
  },
  {
    name: "draft-guard/negative/generics.tsx",
    text: 'export const labels: Array<string> = ["Unlock the power", "🚀 launch"]\nexport const pick = <T,>(xs: T[]): T | undefined => xs[0]\nexport const first = <T extends object>(xs: T[]) => xs[0]\nexport const flag = (a: number, b: number) => (a<b && b>a ? "seamless sync" : "x")\nexport function Saved() {\n  return <p>Saved 3 files</p>\n}\n',
    fails: false,
  },
  {
    name: "draft-guard/negative/measured-stats.html",
    text: '<section class="stats">\n  <div class="stat"><span class="stat-value">42%</span><span>refund rate, Q3</span></div>\n  <div class="metric">99.9%</div>\n  <div class="kpi"><strong>1.2k</strong> open tickets</div>\n  <div class="stat">$2M</div>\n</section>\n',
    fails: false,
  },
  {
    name: "draft-guard/negative/plain-copy.html",
    text: '<main>\n  <h1>Monthly revenue</h1>\n  <p>Revenue rose 4% after the refund fix shipped on 3 June.</p>\n  <pre><code>const seamless = "Supercharge"</code></pre>\n  <footer>© 2026 Example Inc. Next page →</footer>\n  <script>const label = "Unlock the power of your data 🚀"</script>\n  <style>.stat::after { content: "10x"; }</style>\n  <!-- 한눈에 보는 메모 -->\n</main>\n',
    fails: false,
  },
  {
    name: "draft-guard/negative/state-copy.html",
    text: '<main>\n  <p>Unlock your account to continue.</p>\n  <p>최적의 경로를 계산합니다.</p>\n  <p>Docs ↗</p>\n  <p>▶ Play</p>\n  <li>Inbox <span class="badge" data-status="unread">New</span></li>\n  <span class="pill">Pro</span>\n  <div hidden>Seamless onboarding</div>\n  <noscript>Supercharge your browser</noscript>\n  <template><p>Unlock the power of templates</p></template>\n</main>\n',
    fails: false,
  },
  {
    name: "accent-stripes/positive/accent-outlines.css",
    text: ".selected { border-radius: 8px; border: 2px solid #6366f1; }\n.plan { border-radius: 16px; box-shadow: inset 0 0 0 2px #6366f1; }\n.card { border-radius: 12px; }\n.card.is-active { border-width: 2px; border-style: solid; border-color: var(--primary); }\n",
    fails: true,
  },
  {
    name: "accent-stripes/positive/accent-outlines.tsx",
    text: 'export const Plans = () => (\n  <>\n    <div className="rounded-xl border-2 border-indigo-500 p-6">Pro</div>\n    <div className="rounded-2xl p-6 ring-2 ring-primary">Team</div>\n    <div className="rounded-lg focus:ring-2 focus:ring-blue-500">Focused</div>\n    <div style={{ borderRadius: 12, border: "2px solid #6366f1" }}>Inline</div>\n  </>\n)\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/apply.css",
    text: ".tile {\n  @apply rounded-xl border-l-4 border-sky-500 bg-white p-6;\n}\n",
    fails: true,
  },
  {
    name: "accent-stripes/positive/border-top-card.css",
    text: ".feature-card {\n  padding: 24px;\n  border-radius: 12px;\n  border-top: 4px solid #6366f1;\n}\n",
    fails: true,
  },
  {
    name: "accent-stripes/positive/cva-variant.ts",
    text: 'export const card = cva("rounded-xl bg-white p-6 border-l-4 border-rose-500")\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/flat-stripe-side.tsx",
    text: 'const styles = css`\n  .alert { border-left: 4px solid #dc2626; border-radius: 0 6px 6px 0; }\n`\n\nexport const Quotes = () => (\n  <>\n    <blockquote className="rounded-r-lg border-l-4 border-blue-500 pl-4">Square on the stripe side</blockquote>\n    <aside className="rounded-xl rounded-l-none border-l-4 border-sky-500">Left corners squared</aside>\n    <style>{`.note { border-left: 4px solid #16a34a; border-top-right-radius: 8px; border-bottom-right-radius: 8px; }`}</style>\n    <div className="border-l-4 border-blue-500 pl-4">Flat quote, no corners</div>\n    <div className="rounded-none border-l-4 border-blue-500">Square</div>\n  </>\n)\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/gradient-edges.css",
    text: '.hard-stop {\n  border-radius: 12px;\n  background: linear-gradient(to right, #6366f1 4px, #fff 4px);\n}\n\n.image-border {\n  border-radius: 12px;\n  border-left: 4px solid;\n  border-image: linear-gradient(#6366f1, #a855f7) 1;\n}\n\n.glow { position: relative; border-radius: 12px; }\n.glow::before {\n  content: "";\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  left: 0;\n  width: 3px;\n  background: linear-gradient(to bottom, #6366f1, #a855f7);\n}\n\n.end-band {\n  border-radius: 12px;\n  background-image: linear-gradient(to right, #fff calc(100% - 4px), #f43f5e calc(100% - 4px));\n}\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/inline-styles.tsx",
    text: 'export const Tip = () => (\n  <>\n    <div style={{ borderRadius: 12, borderLeft: "4px solid #ef4444" }}>Careful</div>\n    <div className="rounded-lg" style={{ borderTop: \'3px solid var(--brand)\' }}>New</div>\n  </>\n)\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/inset-shadow.css",
    text: ".note {\n  border-radius: 8px;\n  box-shadow: inset 4px 0 0 0 oklch(0.65 0.2 250), 0 1px 2px rgb(0 0 0 / 0.06);\n}\n",
    fails: true,
  },
  {
    name: "accent-stripes/positive/non-visible-focus-and-nested.tsx",
    text: 'const css = css`\n  .card:focus-within { border-radius: 12px; border-left: 3px solid #6366f1; }\n  td .promo-card { border-radius: 8px; border-left: 4px solid #f43f5e; }\n`\n\nexport const Focused = () => <div className="rounded-xl focus:border-l-4 focus:border-indigo-500">Card</div>\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/pseudo-bar.css",
    text: '.stat {\n  position: relative;\n  border-radius: 12px;\n  overflow: hidden;\n}\n\n.stat::before {\n  content: "";\n  position: absolute;\n  inset: 0 auto 0 0;\n  width: 4px;\n  background: #10b981;\n}\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/report-callouts.html",
    text: '<style>\n  h2 { padding-bottom: 4px; border-bottom: 2px solid #1d1d1f; }\n  .cover { border-left: 6px solid #2f7d4f; padding: 6px 0 6px 14px; margin-bottom: 14px; }\n  th, td { border-bottom: 1px solid #e3e3e8; padding: 5px 6px; }\n  .warn { background: #fff6e5; border-left: 4px solid #e0a100; padding: 8px 12px; border-radius: 6px; }\n</style>\n<div class="cover"><h1>Weekly report</h1></div>\n<div class="warn">Two runs need a look.</div>\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/split-rule-and-token.scss",
    text: ".callout {\n  border-radius: 0.75rem;\n  border-left: 3px solid var(--color-accent);\n}\n\n.tile {\n  border-radius: 16px;\n  background: var(--surface);\n  &.is-featured {\n    border-left-width: 4px;\n    border-left-style: solid;\n    border-left-color: hsl(262 83% 58%);\n  }\n}\n",
    fails: true,
  },
  {
    name: "accent-stripes/positive/square-surfaces.css",
    text: '.section { border-top: 4px solid #6366f1; }\n\n.stat { position: relative; padding: 16px; }\n.stat::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: #10b981; }\n\n.note { padding: 12px; box-shadow: inset 4px 0 0 0 #f59e0b; }\n\n.band { padding: 12px; background: linear-gradient(to right, #6366f1 4px, #fff 4px); }\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/styled-components.tsx",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal upstream styled-components fixture; interpolation is source data.
    text: 'import styled, { createGlobalStyle } from "styled-components"\n\nexport const Banner = styled.div`\n  padding: ${({ theme }) => theme.space[4]}px;\n  border-radius: 12px;\n  border-left: 4px solid #2563eb;\n`\n\nexport const Global = createGlobalStyle`\n  .promo-card {\n    border-radius: 8px;\n    border-top: 3px solid var(--color-brand);\n  }\n`\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/tailwind-cards.tsx",
    text: 'export function Cards({ featured }: { featured: boolean }) {\n  return (\n    <section>\n      <div className="rounded-xl border-l-4 border-indigo-500 bg-white p-6">Fast</div>\n      <article className={cn("rounded-2xl p-4", featured && "border-t-4 border-t-primary")}>Plans</article>\n    </section>\n  )\n}\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/tailwind-inset-and-style.vue",
    text: '<template>\n  <div class="rounded-md p-4 shadow-[inset_3px_0_0_0_#f59e0b]">Heads up</div>\n  <div class="quote">Quote</div>\n</template>\n\n<style scoped>\n.quote {\n  border-radius: 10px;\n  border-left: 5px solid rebeccapurple;\n}\n</style>\n',
    fails: true,
  },
  {
    name: "accent-stripes/positive/tailwind-pseudo.html",
    text: '<div class="relative overflow-hidden rounded-lg p-6 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-emerald-500">\n  Uptime 99.99%\n</div>\n',
    fails: true,
  },
  {
    name: "accent-stripes/negative/exempt-states.css",
    text: '.card:focus-visible { border-radius: 12px; border-left: 3px solid var(--accent); }\ninput:invalid { border-radius: 6px; border-bottom: 2px solid #dc2626; }\n.field[aria-invalid="true"] { border-radius: 6px; border-bottom: 2px solid #dc2626; }\ntable td.sorted { border-radius: 4px; border-left: 3px solid #3b82f6; }\n',
    fails: false,
  },
  {
    name: "accent-stripes/negative/full-surface-gradients.css",
    text: ".hero {\n  border-radius: 16px;\n  background: linear-gradient(135deg, #6366f1, #a855f7);\n}\n\n.fade {\n  border-radius: 12px;\n  background-image: linear-gradient(to bottom, rgba(99, 102, 241, 0.12), transparent 60%);\n}\n\n.uniform-image {\n  border-radius: 12px;\n  border: 2px solid;\n  border-image: linear-gradient(#6366f1, #a855f7) 1;\n}\n\n.soft-edge {\n  border-radius: 12px;\n  background: linear-gradient(to right, #6366f1 4px, #fff);\n}\n\n.two-tone {\n  border-radius: 12px;\n  background: linear-gradient(to right, #6366f1 40px, #fff 40px);\n}\n\n.grid-texture {\n  border-radius: 12px;\n  background:\n    linear-gradient(rgba(3, 158, 179, 0.4) 1px, transparent 1px),\n    linear-gradient(90deg, rgba(3, 158, 179, 0.4) 1px, transparent 1px),\n    #0b1220;\n  background-size: 28px 28px, 28px 28px, auto;\n}\n",
    fails: false,
  },
  {
    name: "accent-stripes/negative/inline-ok.tsx",
    text: 'export const Ok = () => (\n  <>\n    <div style={{ borderRadius: 8, border: "1px solid #e5e7eb" }}>Card</div>\n    <div style={{ borderRadius: 8, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.1)" }}>Ring</div>\n    <p>Don\'t stripe {"rounded"} cards.</p>\n    <table><tbody><tr><td style={{ borderLeft: "4px solid #6366f1" }}>Sorted</td></tr></tbody></table>\n  </>\n)\n',
    fails: false,
  },
  {
    name: "accent-stripes/negative/neutral-and-flat.css",
    text: ".list-item { border-bottom: 1px solid #e5e7eb; }\n.panel { border-radius: 12px; border-top: 1px solid rgba(0, 0, 0, 0.08); }\n.quiet { border-radius: 12px; border-left: 4px solid #e5e7eb; }\nblockquote { border-left: 3px solid #d4d4d8; padding-left: 16px; }\n.token { border-radius: 8px; border-left: 2px solid var(--color-border); }\n.ink { border-radius: 8px; border-left: 2px solid var(--text-primary); }\n",
    fails: false,
  },
  {
    name: "accent-stripes/negative/pseudo-overlays.css",
    text: '.card { position: relative; border-radius: 16px; }\n.card::before { content: ""; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(#6366f1, #a855f7); opacity: 0.1; }\n.rule::after { content: ""; display: block; height: 1px; width: 100%; background: #e5e7eb; }\n',
    fails: false,
  },
  {
    name: "accent-stripes/negative/tailwind-ok.tsx",
    text: 'export const Ok = () => (\n  <div>\n    <div className="rounded-lg border border-zinc-200 p-4">Plain</div>\n    <div className="rounded-xl border-l-4 border-l-zinc-300 p-4">Neutral edge</div>\n    <button className="rounded-md focus-visible:ring-2 focus-visible:ring-blue-500">Go</button>\n    <input className="rounded-md border-b-2 aria-invalid:border-b-red-500 invalid:border-red-500" />\n    <blockquote className="border-l-2 border-zinc-300 pl-4">Neutral quote rule</blockquote>\n    <button className="rounded-md border border-indigo-500 px-3">Outline button</button>\n    <div className="rounded-lg bg-blue-50 p-4 text-blue-900">Tonal surface</div>\n    <input className="border-b-2 border-indigo-500" />\n    <select className="rounded-md border-2 border-indigo-500" />\n    <table><tbody><tr><td className="border-l-4 border-indigo-500">Sorted</td></tr></tbody></table>\n  </div>\n)\n',
    fails: false,
  },
  {
    name: "accent-stripes/negative/uniform-and-rings.css",
    text: ".outline-button { border-radius: 6px; border: 1px solid var(--primary); }\n.neutral-frame { border-radius: 8px; border: 2px solid #e5e7eb; }\n.lift { border-radius: 12px; box-shadow: 0 4px 12px rgb(0 0 0 / 0.12); }\n",
    fails: false,
  },
  {
    name: "accent-stripes/negative/wide-blocks-and-hairlines.css",
    text: '.media-card { position: relative; border-radius: 16px; overflow: hidden; }\n.media-card::after { content: ""; position: absolute; top: 0; bottom: 0; right: 0; width: 120px; background: #6366f1; }\n.subtle { border-radius: 8px; border-left: 1px solid #6366f1; }\n',
    fails: false,
  },
];

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "frontend-draft-guard-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function guard(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });
}

describe("frontend bundled draft guard", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.fails ? "rejects" : "accepts"} ${fixture.name}`, () => {
      withDirectory((directory) => {
        const path = join(directory, fixture.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, fixture.text);
        const result = guard(path, "--json");
        expect(result.stderr).toBe("");
        expect(result.status).toBe(fixture.fails ? 1 : 0);
        const findings = JSON.parse(result.stdout);
        if (fixture.fails) {
          expect(findings.length).toBeGreaterThan(0);
          expect(findings[0]).toEqual(
            expect.objectContaining({ file: path, line: expect.any(Number), column: expect.any(Number), rule: expect.any(String) }),
          );
        } else expect(findings).toEqual([]);
      });
    });
  }

  test("reports visible copy and CSS violations with locations in text mode", () => {
    withDirectory((directory) => {
      const path = join(directory, "page.html");
      writeFileSync(path, "<style>.card { border-left: 4px solid #6366f1; }</style>\n<p>Seamless sync</p>\n");
      const result = guard(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/page\.html:1:\d+ {2}edge-stripe/);
      expect(result.stdout).toMatch(/page\.html:2:\d+ {2}promo-copy/);
      expect(result.stdout).toContain("2 finding(s)");
    });
  });

  test("accepts clean directory traversal and skips generated files and dangling links", () => {
    withDirectory((directory) => {
      writeFileSync(join(directory, "page.html"), "<main><h1>Account</h1><button>Save changes</button></main>");
      mkdirSync(join(directory, "node_modules"));
      writeFileSync(join(directory, "node_modules", "vendor.html"), "<p>Seamless sync</p>");
      writeFileSync(join(directory, "generated.d.ts"), 'const x = "Seamless sync";');
      symlinkSync(join(directory, "absent"), join(directory, "dangling"));
      const result = guard(directory);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("1 file(s), clean");
    });
  });

  test("returns usage exit 2 without paths, including JSON-only invocation", () => {
    for (const args of [[], ["--json"]]) {
      const result = guard(...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage:");
    }
  });

  test("returns exit 2 for an unreadable explicit target rather than a false clean", () => {
    withDirectory((directory) => {
      const result = guard(join(directory, "missing.html"));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("cannot read");
    });
  });
});
