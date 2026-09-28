> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Phase 2 + 3 — Hypothesis Formation & Investigation

An observed failure is already evidence; do not rerun a user-reported scenario merely to confirm it. When the cause remains uncertain, write distinct hypotheses and choose observations that discriminate among them. Avoid manufacturing extra hypotheses after one mechanism is already established.

---

## Phase 2 — Hypothesis formation

Compare independent plausible causes only where they change the investigation or fix. Multiple hypotheses reduce confirmation bias, but there is no minimum count for an already bounded defect.

### Generate across orthogonal axes

If your three hypotheses are all variations of "the handler has a bug", you don't actually have three hypotheses. Span the space:

| Axis | Example framing |
|---|---|
| **User-code logic** | "The handler early-returns because condition X is unexpectedly true" |
| **Library/SDK behavior** | "The third-party client swallows the error and returns a stub" |
| **Environment/config** | "The env var is read at module-load time before it gets populated, so it's empty" |
| **Async/timing** | "The promise rejects (or goroutine panics) after the response is already sent" |
| **Silent side-effect** | "An earlier turn mutated shared state that the current turn inherits" |
| **Observability gap** | "The error is raised but suppressed before logging; it only exists as an unawaited rejection / ignored signal" |
| **Binary-level** (when applicable) | "The function we think is running is actually jumped over by a patched thunk / a different version loaded" |
| **Build-vs-runtime** | "The code we're reading is not the code that's running — stale build, wrong symlink, cached wheel, or dist/ ahead of src/" |

### For each hypothesis, write in the journal

1. **Claim** — one sentence.
2. **Distinguishing evidence** — the exact value or state that confirms or refutes it, AND where to read it (file:line, log source, breakpoint location, memory address).
3. **If true, the fix is** — two words. Forces you to think through fix cost before committing to the hunt.

### Collapse rule

If two hypotheses predict the same observable, collapse them. Seek another only when it would change what you inspect or implement.

---

## Phase 3 — Investigation

### State freshness invariant

**A debug session's state is a snapshot with a lifetime, not a fact you can carry forward indefinitely.**
- Before any action that mutates the debuggee, re-observe the session's current state.
- This includes continue, step, side-effecting evaluation, setting or removing breakpoints, and termination.
- Record the current thread state and stop reason; those are the concrete tells for whether the old plan still applies.
- An observation from an earlier turn may already be stale when the next action is issued.
- Turns can be minutes apart while the debuggee runs at full speed, so this failure mode is normal, not exceptional.
- If the thread state or stop reason has moved, re-observe the new state and do not replay the old plan.
- Treat every mutation as conditional on the state you just observed, not on a remembered stop.

### Failure-to-recovery taxonomy

| Failure signature | Most likely cause | Next move |
|---|---|---|
| Adapter or debugger process failed to start | Wrong binary or missing installation | Verify the tool exists, then re-launch; do not retry blindly. |
| Breakpoint accepted but never bound or verified | Source path mismatch, optimized-out code, or missing debug symbols | Check the binary was built with symbols and that the debugger-resolved path matches your file. |
| Attach refused | Permissions, ptrace scope, SIP, or wrong PID | Fix the environment or target identity; a retry will not change it. |
| No stop event within the expected window | Process is running, the breakpoint is unreachable, or the wait was too short | Pause and inspect threads rather than waiting longer. |
| Session terminated unexpectedly | The debuggee crashed or exited | Capture the exit and crash evidence before restarting. |

Branch depending on what's available.

### Investigation and delegation

When multiple independent evidence territories merit parallel work, dispatch one `task` batch with disjoint sources and concrete observables. Choose `deep-low` for focused runtime/reproduction work (fallback `task`), and `scout` for read-only exploration. Include the bug, hypothesis, scope, exact evidence and no-edit boundaries in each prompt. A small already-localized defect stays inline; no fixed roster or minimum child count is required.

The lead maintains the journal, approves source edits and synthesizes findings into statuses. For web bugs use the OMP `browser` tool, not a stand-in HTTP fetch. Preserve exact values, times and source locations; refute or confirm hypotheses against observed state. If parallelism adds no value, investigate sequentially with the same evidence standard.

---

## Evidence capture discipline (both paths)

For every piece of runtime state captured, record in the journal:

```markdown
### <ISO timestamp> — <what you looked at>
- Source: <file:line | log source | curl command | breakpoint address>
- Value: `<verbatim>`
- Interpretation: <one line — why this matters>
- Refutes/Confirms: H<n>
```

**Verbatim values only. No paraphrasing.**

- `messages.length=0` is evidence.
- "messages seemed empty" is not evidence — it's a memory of an observation, and memory of observations is where debug sessions go to die.

If you find yourself about to paraphrase, stop, go back, and copy the raw value.

---

## Round completion

A round is complete when the relevant hypotheses have confirming or refuting evidence, or when available sources cannot distinguish them. On an inconclusive, genuinely open diagnosis, `04-oracle-triple.md` offers an optional way to get orthogonal framings; do not delay a user-owned contract decision for it.
