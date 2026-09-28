---
name: visual-qa
description: "Use to verify rendered web, terminal, or paginated surfaces with captured evidence and independent visual review."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Visual QA for rendered surfaces

Use for web UI, TUI and paginated documents when the appearance, fidelity or interaction is part of success. An objective image/terminal check focuses attention; a human-visible review makes the verdict. Do not treat a scalar similarity score as approval.

The skill directory shown by the host contains `scripts/visual-qa.mjs` (requires `node`) and `references/browser-setup.md` for browser capture guidance. Read `references/maintainers.md` when maintaining the CLI.

## Capture every relevant state

Enumerate routes, pages, slide/page count, tabs, modal states, breakpoints and scroll positions before capture. Redact secrets from reference packets. A 40-slide deliverable needs 40 page captures, not a sample. Check file signature, dimensions and full compositing before dispatching reviewers. Captures must be newer than the rendered source; repeat captures after a change.

For web surfaces, use the OMP `browser` tool, navigate the actual URL, set the matching viewport, interact and capture screenshots. Use an attached browser for login-dependent pages. Observe hover, focus, keyboard, error and loading states where relevant. For animations capture rest, mid-transition and settled frames; compare settled states separately from motion. Close tabs when done. Follow `references/browser-setup.md`.

For terminal UIs launch the real program in a pty and capture the interaction and rendered terminal; check width, ANSI, wide characters, borders and clipping. For paginated documents render every page to an image. A clean text extraction cannot prove layout.

Run the standalone bundled CLI when objective comparison applies:

```bash
node <skill-directory>/scripts/visual-qa.mjs image-diff <reference.png> <actual.png>
node <skill-directory>/scripts/visual-qa.mjs tui-check <terminal-capture.txt> --cols <N>
```

Keep the JSON fields (dimensions, diff ratio, hotspots; or width, overflow, border and wide-char diagnostics) with screenshots and the exact capture steps. Save evidence under `local://visual-qa/<slug>/...` where supported. Files needed by external image tools must be placed at a real filesystem path and linked in the report.

## Two independent passes

In one `task` batch dispatch two `task` reviewers with `effort: "hi"` and different charters. Pass A checks design-system integrity, real implementation and functional states; pass B examines each captured page and source for composition, clipping, typography, contrast, responsive behavior and CJK issues. Include the complete enumerated set and evidence paths in both prompts. Reviewers do not edit product files. Each returns PASS/REVISE/FAIL and locates `[product]` versus `[evidence]` defects.

Repair an evidence defect by fixing the capture and repeating the review; repair a product defect by changing the product, recapturing affected states, and repeating independent review. Final approval requires fresh complete captures, no blocking findings, and a direct observation of the actual surface. Report scenarios, exact invocations, artifacts, observed output, and unverified surfaces.
