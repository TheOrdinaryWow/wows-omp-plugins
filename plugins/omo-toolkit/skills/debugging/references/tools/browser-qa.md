> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Browser QA through OMP

A browser-served bug requires a rendered browser, not `curl`. Read `skill://agent-browser` when available; use the OMP `browser` tool to open the real application and navigate its routes. For each failure, record the URL, viewport, actions, observed DOM/screenshot and relevant console or network evidence. Capture before and after an interaction, including the state that triggers the bug. Compare the rendered result with the expected behavior, close the tab, and store evidence where the calling workflow requires it. Do not install a separate browser automation dependency.
