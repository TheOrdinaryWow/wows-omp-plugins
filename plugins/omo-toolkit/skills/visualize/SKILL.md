---
name: visualize
description: "Use when an answer is clearer as a self-contained HTML chart, table, diagram or small dashboard than as prose. Compute traceable figures, design an offline themed page, lint and inspect dark/light narrow/wide browser captures, then deliver an HTML file path and summary; OMP has no inline-HTML reply surface."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Visualize — an offline HTML answer

Make the finding easier to understand than the paragraph it replaces. This is an answer artifact, not a new application or a marketing page. OMP has no native inline-HTML rendering surface: deliver a real standalone HTML file, browser evidence and a short chat summary. A browser preview is not an inline thread render.

## Compute → design → build → guard → inspect → deliver

1. **Compute.** Read `skill://data-scientist` for quantitative work and its visualization reference for chart selection. Compute figures in native eval with an appropriate available engine; do not invent values or install a stack merely for a qualitative diagram. Keep the input, query/aggregation, units, missing-row policy and calculation evidence. Every displayed number must trace to that computation; distinguish illustrative data explicitly.
2. **Design.** Read `skill://frontend` and its relevant references. Preserve required content and choose the chart/table/diagram that answers the question. For this small standalone answer, define the necessary light/dark tokens inside the HTML rather than creating an application-wide design system. State a short layout contract (primary reading order, responsive behavior, scroll owner) in the work notes. Keep hierarchy and labels, not decorative cards or promotional framing.
3. **Build.** Save one self-contained `.html` file at a real absolute output path outside the installed skill tree. Inline CSS, scripts, SVG, images and any fonts; use system fonts where possible. No CDN, remote library, iframe, external stylesheet/font, fetch, telemetry or network-dependent chart. Prefer semantic markup and inline SVG with a text/table equivalent. Keep the essential answer readable with JavaScript disabled; scripts may enhance interaction but must not supply the only data or figure.
4. **Guard before preview.** Read `skill://frontend/scripts/perfection/check-draft-guard.ts` to resolve the physical frontend skill location supplied by the host. Do not guess a sibling cache path or run a `skill://` URI as a shell filename. Run the dependency-free CLI against the saved artifact:

   ```bash
   bun <physical-frontend-skill>/scripts/perfection/check-draft-guard.ts <page.html> [--json]
   ```

   Exit **0** means clean; **1** means findings (for example decorative accent stripes/outlines, promotional filler, emoji icons, hype badges or vanity-stat forms); **2** means a usage/input failure. Fix the artifact or invocation and rerun until 0. Do not hide/exempt content to force a pass, and do not treat lint as visual approval.
5. **Inspect the real file.** Read `skill://visual-qa` and `xd://eval/browser`. Open the actual HTML with the OMP browser and capture all four states: **light and dark × 390 CSS px and the intended report width** (use 1100 px if none is specified). Set an explicit viewport/scale and theme using the documented browser emulation. Inspect every screenshot, console/errors, top/end content and overflow; exercise any controls with keyboard as well as pointer. Verify with JavaScript disabled that the finding, values and labels remain readable. Check network diagnostics for accidental external requests. Apply the visual-qa evidence/review rules to the relevant states; after a product change rerun guard and recapture affected states. Never deliver a page you have not looked at. If the required browser/capture surface is unavailable, report the exact unverified criterion rather than claiming a pass.
6. **Deliver.** Give a clickable absolute file path or artifact link, what the page establishes, the calculation/source caveat that matters, and representative screenshot paths. Keep all four captures with their dimensions/theme in the evidence packet. Say **HTML artifact**, not “rendered inline”; do not call nonexistent `show_html_page`, `html_preview` or `html_render` tools. State anything that remains unverified.

## Theme and document contract

OMP does not inject CSS tokens into a file. Define a complete local palette for every token used and declare `color-scheme: light dark`, using `@media (prefers-color-scheme: dark)` for the second palette. Useful names are `--background`, `--foreground`, `--muted`, `--muted-foreground`, `--card`, `--border`, `--primary`, `--chart-1` … `--chart-6`, `--font-sans`, `--font-mono` and `--radius`. Use only the tokens you need; make series distinguishable by labels/shapes as well as color. Do not assume host fonts, a dark background, a preview sandbox or injected confirmation behavior.

Include a UTF-8 charset, meaningful title, document language and viewport metadata. Use a fluid readable container, sensible standalone padding and no ornamental outer card/banner. Keep chart heights intentional; do not stretch SVG text with `preserveAspectRatio="none"`. Axis labels include units, numbers use tabular figures and appropriate precision, and long labels wrap at 390 px. A wide data table may use a clearly labeled local horizontal scroller; the whole page must not overflow. Give keyboard focus and reduced-motion behavior to any controls.

Show a small “How this was computed” block with the query or aggregation and provenance. Put caveats beside the figure when they change interpretation: partial windows, missing rows, archived data or small samples. Empty and failed computations have designed explanatory states, not invented figures or a blank frame.

The offline rule is a build requirement, **not a host-enforced sandbox**. A standalone page runs scripts normally and ordinary links can navigate without an OMP confirmation prompt. Do not embed secrets in HTML or link addresses, trigger navigation automatically, or add network behavior. Intentional source links may remain ordinary links with clear destinations; use `rel="noopener noreferrer"` for new-tab links. Open only task-owned browser tabs and release them after capture.
