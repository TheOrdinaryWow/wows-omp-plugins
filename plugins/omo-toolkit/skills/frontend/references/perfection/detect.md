> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes. The detector's rule logic is ported from [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0, Copyright 2025 Paul Bakaus) plus one reflow check from [changeroa/StyleGallery](https://github.com/changeroa/StyleGallery) (MIT); see `../../ATTRIBUTION.md` section 7.

# frontend-detect: the after-build lint

`scripts/detect/` is a dependency-free TypeScript SDK that lints what the browser actually drew: contrast against the painted background, the type scale in use, spacing, overflow, decoration tells, and copy tells. Pages render only in the OMP native browser; the SDK ships no browser engine of its own.

It runs after the draft builds and before `skill://visual-qa`. `check-draft-guard.ts` stays the first lint on source; this one needs a rendered page and catches what source cannot show: a 4.2:1 table header in dark mode, an h1 followed by an h3, a heading that wraps one word onto its last line, a card that overflows at 390.

## Run it from an eval cell

Read `xd://eval/browser` first. In a JavaScript eval cell, import `index.ts` (importing does nothing until you call a function) and hand the eval `browser` global to the native renderer:

```js
const detect = await import("<skill-directory>/scripts/detect/index.ts");
const renderer = detect.createNativeBrowserRenderer(browser);
try {
  const report = await detect.detectPage({ kind: "url", url: "http://localhost:5173/settings" }, {
    renderer,
    reflow: true,
    config: { allowFonts: ["Inter"], designTokens: { radii: [8, 12] } },
  });
  await Bun.write("<evidence-dir>/settings-detect.json", JSON.stringify(detect.toReportJson(report), null, 2));
  console.log(detect.formatReportText(report));
} finally {
  await renderer.close();
}
```

- The renderer opens its own tab for every pass at that pass's viewport, installs the script-error probe as an init script, waits for load, web fonts and three frames, captures, and closes the tab. `createNativeBrowserRenderer(browser, { open: { app: { relay: true } } })` loads the page in an omp-owned background tab of the user's signed-in Chrome; other `browser.open` options (`timeout`, `ignore_https_errors`, `app`) pass through the same way. It refuses `app.target`, a borrowed tab, and sets `name`, `url`, `viewport`, `init_scripts` and `wait_until` itself.
- `detectPage(target, options)`: `target` is `{ kind: "url", url }` or `{ kind: "html", html }` (written to a scratch file that `renderer.close()` removes). Renders at each viewport (default 1440 and 390); `reflow: true` adds StyleGallery's 320, 375, 768, 1024 and 1440 passes with an unbroken stress string appended to the page's text at 320. Returns a `DetectReport`: sorted, de-duplicated `findings`, and one `surfaces` entry per capture with its coverage.
- `detectFiles(paths, options)`: HTML files render as pages through the same renderer; CSS/SCSS/Less, JSX/TSX, Vue, Svelte and Astro files run the source-text rules.
- `lintSnapshot(snapshot, options)` / `lintSources(files, options)`: the pure rule engines. `formatReportText(report)`, `toReportJson(report)` and `limitsOf(surface)` write the report; `hasBlockingFindings(findings)` answers the gate.
- Every finding carries `ruleId`, `severity` (`error`, `warning`, `advisory`), `blocking`, `category`, `message`, `fixHint`, and a `location`: an element (`selector`, `rect`, `viewport`), a source position (`file`, `line`, `column`), or the page.

## A page you already have open

For a page in the user's own tab (`app.target`, an adopted Tern block, a CDP-attached page), capture without loading or changing it:

```js
const tab = await browser.open({ name: "detect", app: { relay: true, target: "Settings" } });
const snapshot = await tab.evaluate(detect.snapshotExpression());
await tab.close(); // releases the borrowed tab; it stays open for the user
const findings = detect.lintSnapshot(snapshot);
```

That capture has no stress pass, so the reflow stress check did not run; and unless the tab got `detect.SCRIPT_ERROR_PROBE` at document start, the report says script errors were not captured. Never run the stress script in a tab the capture does not own. On a backend whose `tab.evaluate` cannot await a promise, wait for the page's ready signal with `tab.waitFor` instead of `SETTLE_EXPRESSION`.

## From a shell

The CLI never renders. It lints snapshot JSON (one snapshot or an array, saved from `JSON.stringify(snapshot)` in the eval cell) and source files:

```bash
bun <skill-directory>/scripts/detect/cli.ts [--json] [--config detect.json] <snapshot.json | source file or dir>...
```

Exit 0: no blocking finding. Exit 1: at least one. Exit 2: usage error, unreadable target, a file that is not a frontend-detect snapshot, an explicit URL or HTML target (it would have to render it), or nothing inspected. HTML pages found inside a target directory are listed as not rendered.

## Config

`--config` (or `options.config`) takes JSON:

| Key | Meaning |
|---|---|
| `rules` | `{ "<rule-id>": "error" \| "warning" \| "advisory" \| "off" }` per rule |
| `allowFonts` | Families the project chose on purpose (Inter on a product that matches its platform); never reported as overused |
| `allowEasings` | Timing functions `DESIGN.md` names on purpose, such as an intentional spring |
| `designTokens` | `{ fonts, colors, radii, fontSizes }`; the `design-system-*` rules report values outside them and stay silent without them |

Waive one element with `data-detect-ignore="<rule-id> <rule-id>"` on it or an ancestor (upstream's `data-impeccable-ignore` is honoured too). A waiver, and a rule set to `advisory` or `off`, needs its reason in `DESIGN.md`.

## Reading the result

- **Blocking** findings are objective defects on a rendered page, wrong under any design direction: `low-contrast`, `script-error`, `broken-image`, `content-hidden-at-rest`, `text-overflow`, `text-occlusion`, `viewport-reflow`, and `skipped-heading`, at error or warning severity. Fix them before `skill://visual-qa`. `low-contrast` is an error here, stricter than upstream, because a contrast failure is never a taste call.
- **Everything else never blocks**: generated-look tells (kicker labels, icon tiles, cream palettes, glows), the craft defaults in `craft-floor.md`, and the `design-system-*` checks. Fix each one or record why it stays (the brief, a chosen route or reference, a `DESIGN.md` decision); never delete a deliberate choice to silence one. Source-text findings never block either: they are heuristics without rendered evidence.
- **Coverage.** Every report names each capture (URL, viewport, whether stress ran) and what the collector could not see: elements past the cap, shadow DOM (open roots are counted, closed ones cannot be detected), `iframe` and `frame` documents, cross-origin stylesheets it could not read, and a missing script-error probe. Each capture is one state at rest; hover, focus, loading, error and the other states need their own captures. Inspect shadow and frame content by hand, or capture a frame's own URL.
- **Zero findings is not a pass of anything else.** It never stands for complete visual or accessibility verification: the `skill://visual-qa` reviewers and the WCAG 2.2 AA table in `SKILL.md` Verify still run.
- A finding you believe is wrong: rerun at the viewport it names and read the computed values it quotes. Waive it with the attribute only when `DESIGN.md` explains why.
