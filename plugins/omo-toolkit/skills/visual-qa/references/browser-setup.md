> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Browser setup for web capture

Use the OMP `browser` tool. Open a dedicated tab for unauthenticated pages, set a fixed viewport, navigate to the exact URL, wait for a concrete ready signal (visible element, URL or network completion), then capture PNG evidence. Record viewport, device scale factor, URL, interactions and output path. Close every tab and any fixture server, including after a failed capture.

For authenticated pages attach to the browser session the user is already signed into, rather than copying or launching against their live profile. Never clear cookies, cache or site data from that profile. If no authenticated browser is available, report the missing prerequisite instead of substituting an anonymous page.

Match the CSS viewport and PNG dimensions. Do not resize a screenshot to force a pass. Compare evidence with:

```sh
node <skill-directory>/scripts/visual-qa.mjs image-diff reference.png actual.png
```

Inspect `dimensionsMatch`, `diffRatio` and the images themselves before handing evidence to reviewers.
