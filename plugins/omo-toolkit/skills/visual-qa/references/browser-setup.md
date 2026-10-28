> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Browser setup for web capture

Use the OMP `browser` tool. Open a dedicated tab for unauthenticated pages, set a fixed viewport, navigate to the exact URL, wait for a concrete ready signal (visible element, URL or network completion), then capture PNG evidence. Record viewport, device scale factor, URL, interactions and output path. Close every tab and any fixture server, including after a failed capture.

For authenticated pages attach to the browser session the user is already signed into, rather than copying or launching against their live profile. Never clear cookies, cache or site data from that profile. If no authenticated browser is available, report the missing prerequisite instead of substituting an anonymous page.

Match the CSS viewport and PNG dimensions. Do not resize a screenshot to force a pass. Compare evidence with:

```sh
node <skill-directory>/scripts/visual-qa.mjs image-diff reference.png actual.png
```

Inspect `dimensionsMatch`, `diffRatio` and the images themselves before handing evidence to reviewers.

## Required capture matrix

For every enumerated route/state use 390 CSS px phone, 1440 desktop, plus 1920 for page layouts, with paired light/dark captures. Record mobile/touch settings and DPR rather than treating a narrow desktop window as full mobile emulation. Keep CSS width and raster dimensions distinct when DPR is not 1. Use native browser capability documentation for viewport, theme and reduced-motion configuration; a missing emulation capability is an evidence limitation to report, never silently PASS.

Capture each scroll owner's end position in a viewport image (including sticky bars), and attach the DOM scroll-owner probe from `SKILL.md`. Capture rest/mid/settled motion and the reduced-motion/interruption alternatives. Full-page screenshots supplement, not replace, these cases.

For existing UI, freeze states x widths x themes before the first edit, capture before, then capture after with identical data, tooling, theme, density and scroll. Compose same-scale before-left/after-right pairs; keep original images and image-diff JSON. Cases discovered later are added to both sides; never reconstruct a pre-edit baseline from edited code.
