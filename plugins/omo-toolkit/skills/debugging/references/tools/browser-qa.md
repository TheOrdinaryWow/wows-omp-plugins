> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Browser QA through native browser sessions

A browser UI bug needs the rendered browser, not curl or a source-reading story. Read `skill://agent-browser`, then the native browser documentation it routes to. Use the global `browser` object through OMP `eval`; do not install omowright, Playwright, another browser engine, or a managed browser merely because an upstream example uses it. Run QA only when the assignment authorizes it.

## Match the session to the failure

- Use an owned tab/profile for public pages, deterministic fixtures, viewport changes and deliberately failed requests when the native surface supports them.
- If the bug depends on the user's existing authentication, use the authorized attached session, never a copied profile or exported cookie jar. Do not read credentials through page evaluation, clear the user's data, or close tabs/processes you did not create.
- Record the URL/route, viewport, device scale, relevant input and whether the evidence is headed or headless. A headless result does not prove desktop permissions, window behavior or an attached user's session state.
- Give run-owned evidence and temporary resources unique paths. Journal ownership at creation so cleanup cannot delete another run's outputs.

## Capture the actual failing flow

1. Start from a fresh native DOM/accessibility snapshot. Identify the actual control, role/name/value or selector before acting; refresh the snapshot after navigation or a significant DOM change. Do not guess stale references.
2. Record the action, expected result and observed state. A screenshot is evidence of appearance, not by itself an assertion that an interaction succeeded. Check the resulting visible state, route or value.
3. Capture the relevant screenshot, DOM state, console errors and request/response evidence at the triggering point. Preserve before-evidence already supplied by the user; do not rerun an observed failure merely to reconfirm it.
4. If network state distinguishes causes, subscribe to the exact request/response **before** clicking or submitting. Await that event or the relevant state transition with a bounded failure timeout, not a fixed sleep or generic idleness. If the native session lacks a needed interception/trace facility, disclose the limit rather than invent an API.
5. For an authorized error-path test, inject a failure only in an owned test session. Do not leave route overrides or instrumentation on an attached user page.

Match mobile/touch and pixel scale as well as viewport width when those are causal. Inspect the same changed user scenario after the fix, including the state that triggered the bug. curl can exercise the HTTP boundary separately, but cannot stand in for cookies, localStorage, service workers, client-side JavaScript or viewport-dependent layout.

## Cleanup and handoff

Close only your owned tabs/sessions; remove your temporary profile, request overrides and debug instrumentation, and stop only your own fixture servers. Keep requested screenshots/traces in the workflow's evidence location. Authentication-bearing console/network traces stay private and must not expose cookies, tokens, CSRF fields or upload headers.

Report the exercised URL/surface, actions, exact observed result and evidence paths, plus inaccessible states, unavailable native capabilities and any unexercised modes. Do not claim complete browser, accessibility or platform verification from one successful capture.
