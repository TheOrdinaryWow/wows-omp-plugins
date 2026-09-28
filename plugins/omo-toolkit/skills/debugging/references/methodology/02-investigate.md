> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Phase 2 + 3 — Hypothesis Formation & Parallel Investigation

One hypothesis is a hunch. Three hypotheses is a decision. Investigation is how you turn the decision into runtime evidence.

---

## Phase 2 — Hypothesis Formation (Minimum Three)

### Why three, not one

A single hypothesis creates confirmation bias: you'll read runtime state looking for evidence that confirms it and unconsciously discount contradictions. Three hypotheses force you to design queries that *distinguish* between them, which is the only way runtime evidence becomes decisive.

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

If two hypotheses have identical distinguishing evidence, they aren't actually different — collapse them and find a real alternative. If you can't come up with a third distinct hypothesis, you don't understand the system well enough yet. Go read a little more code before investigating.

---

## Phase 3 — Parallel Investigation

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

### Parallel investigation with one task batch

When there are at least three independent hypotheses, dispatch one `task` batch of named children, one hypothesis per child. Choose `deep-low` for focused runtime/reproduction work (if it is not listed in the task tool description, use `task`); choose `scout` for read-only log and source exploration. Assign the runtime-state inspector, log archaeologist, reproduction engineer and trace correlator only where their evidence source is relevant. Include the bug, hypothesis, scope, exact observable evidence and no-edit boundaries in each prompt. Children coordinate over IRC with `write agent://<name>`; the lead blocks with `wait` only when there is no other work.

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

A "round" is complete when every hypothesis has either confirming or refuting evidence — or when you have exhausted the evidence sources available without a decisive result. If the round ends inconclusively, that counts as a failed round for the counter in the journal. See `04-oracle-triple.md` for what to do at 2 consecutive failed rounds.
