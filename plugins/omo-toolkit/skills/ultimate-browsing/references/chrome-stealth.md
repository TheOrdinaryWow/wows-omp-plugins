> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Native browser escalation and account boundary

The historical filename does not indicate a stealth installer. This port uses the host's browser and ships no browser runtime, fingerprint scripts or credential utilities. Read `xd://eval/browser` for the live facade contract before browser automation. Use native `read` for static material.

## Choose the correct session

For a public rendered page, open a dedicated named browser tab. Managed Chromium is appropriate when true Chromium emulation is required; native Tern/cmux webviews do not expose every CDP feature. Select the actual backend through documented host options, not a copied Playwright/OmOWright launcher. A successful browser launch is not proof that a blocked host became accessible.

For account-dependent reading, use the user's attached signed-in profile. With the OMP Chrome relay this is `app: { relay: true }`; a new unique name without `app.target` opens a task-owned tab while retaining the attached account session. Use only a configured, authorized attachment. If attachment/login is unavailable, ask the user to connect/sign in and name the missing prerequisite. Do not quietly replace it with a managed, unauthenticated profile.

```javascript
// In native eval, after reading xd://eval/browser.
const tab = await browser.open({
  name: "platform-read-case-unique",
  url: "https://platform.example/the-requested-item",
  app: { relay: true },
});
try {
  const observation = await tab.observe();
  print(observation);
  // Use freshly observed references if expansion/navigation is needed.
  print(await tab.text());
  // Capture only if visual/rendered evidence is relevant; redact private content.
} finally {
  await tab.close();
}
```

The example URL is illustrative, not a platform endpoint. Do not reuse someone else's tab name. Borrowing an existing tab requires explicit authorization; do not navigate the user's visible tab as a shortcut. Never launch against, clone, clear or alter the user's browser profile/cookies/site data. No cookie-store read, decryption, `saveState` export, `setCookies` import or `--cookies-from-browser` is part of this workflow.

## Observe, validate, release

- Inspect fresh `observe()`/`text()`/`extract()` results after navigation and expansion. Wait for the expected selector/text instead of arbitrary sleeps. Stop at a persistent challenge; do not automate CAPTCHA solving.
- Validate requested item identity and actual body. An accessible shell, consent prompt or missing-media banner is not success. Separate what was rendered from what was inferred.
- Inspect `requests()` only when needed to understand loaded content, not to harvest auth. Use the platform's observed legitimate public data or rendered page; do not replay private endpoints to widen access. Redact cookies, authorization values and signed URLs from saved evidence.
- Use `screenshot()` for visual evidence; it returns a saved path and does not take an output filename. Keep private screenshots out of shared artifacts unless the user authorized that scope.
- Reading does not authorize likes, follows, comments, purchases, downloads or messages. Pause before an account-changing action.
- Close only your named tabs/handles in `finally`; never `close({ all: true })` during shared work. Do not terminate an attached user browser.

If the site remains blocked, hand back the observed denial, route and time, plus any clearly labeled partial or archived evidence. Do not promise universal WAF bypass, account access or platform availability.
