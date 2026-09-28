> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Phase 6 + 7 — Root Cause Evidence & Verified Fix

Trace the causal chain from observed state to the reported behavior. A user-reported failure is valid before-evidence; do not rerun it solely to reconfirm. A safe toggle can strengthen uncertain diagnosis, but it is not a prerequisite when the mechanism and before/after scenario are already established.

---

## Phase 6 — Root cause evidence

Record the relevant observed value, code path, and failure boundary. Distinguish a proven cause from a plausible inference; if competing mechanisms remain, choose a discriminating observation before editing. Toggle the suspected cause when safe and useful, recording both outcomes, but avoid replaying an already observed failure just to satisfy a ritual. Do not silently choose a fix that changes an unapproved contract: send the evidence, options, and recommendation to the parent when delegated, or ask the user as the lead.

In the journal record the mechanism, before-evidence (including a user observation with its source), the targeted fix, and the after-scenario you will exercise. If full reproduction is inaccessible, name the limit and use the best available narrow runtime evidence rather than claim confirmation from source reading alone.

---

## Phase 7 — Fix and regression

### 1. Regression evidence

Use a failing-before/passing-after test when it captures a plausible consumer-visible bug and the repository keeps such tests. Otherwise retain the observed before-case and exercise the changed real surface after the fix; do not add a mock echo, wording assertion, or tautology merely for a red test. When a new regression test is warranted, make the failure specific to the bug with minimal infrastructure:

- **Test name reads like a bug report.** `test_refinement_turn_returns_empty_content_when_anthropic_returns_401` is good. `test_bug_fix` is not.
- **Failure message clearly shows what the bug looks like.** If someone reads only the failure output, they understand what's broken.
- **Minimum infrastructure.** Don't spin up the whole server if a unit test against the right seam captures the mechanism.

Run the meaningful regression test before the fix if the failure has not already been observed in that test. Capture the exact failure in the journal; skip this step only when the prior observed failure is sufficient and the test would add no behavioral coverage.

### 2. Minimum change

Fix the observed mechanism with the smallest complete change. Judge scope from the actual cause and contracts, not an arbitrary line-count threshold. If the fix grows unexpectedly, revisit the causal chain and ask before changing an unapproved contract.

Signs you're over-fixing:
- Adding "just in case" null checks or try/except around other code
- Refactoring adjacent functions because "while I'm here"
- Adding new configuration options the bug didn't require
- Introducing new abstractions to "make this cleaner"

Resist all of these. Fix the bug. Note the surrounding issues for follow-up. Move on.

### 3. Related cleanup only

Only cleanup directly related to the fix. Do not re-architect.

If the code around the fix is rough, note it in the journal as a follow-up for the user; do not expand scope here. Refactoring during a bugfix is how one-line fixes turn into hundred-line diffs nobody can review.

### 4. Regression — affected checks

Run affected checks and the real-surface scenario after a coherent fix. Run the full affected package suite when it exists and is appropriate; do not reinterpret a relevant failure as permission to weaken the test. Compare the result with the original observed failure rather than repeating the broken operation before editing.

### 5. Preserve useful observability

Keep diagnostics only when they serve an ongoing consumer of the changed behavior and are part of the requested fix; do not add unrelated telemetry while debugging. Remove temporary `print` / `dbg!` / `console.log` artifacts at cleanup.

### Update the journal

```markdown
### Fix evidence (<ISO timestamp>)
Fix: <file:line> — <two-line description of the change>
Before: <user observation or captured failing scenario>
After: <exact real-surface invocation and result>
Affected checks: <commands/results or explicit limitation>
```

---

## The before/after discipline

The before evidence (including a user-reported observation) and the same changed scenario after the fix establish what changed. A permanent regression test must fail without the fix and catch a plausible consumer-visible bug, not simply reassert source wording or incidental implementation. If the real operation is unavailable, disclose that limitation and label any narrower proof accordingly.
