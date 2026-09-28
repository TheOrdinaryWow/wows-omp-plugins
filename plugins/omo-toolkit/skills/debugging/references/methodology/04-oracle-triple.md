> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Phase 4 — Oracle Triple Consultation

Use this optional reframing when a genuinely open root-cause hunt has repeated inconclusive rounds and parallel analysis is likely to add a decisive observation. It is not a prerequisite for asking an unapproved consequential question, nor a replacement for runtime evidence.

> ⚠️ **Wrong tool for non-debugging tasks.** The Triple is for *stuck root-cause hunts*. If your task is producing an artifact (extraction, reverse engineering, audit, compliance documentation) and you want a skeptical review before declaring it done, use the **Verification Oracle** pattern in [partial-runtime-evidence.md](partial-runtime-evidence.md#verification-oracle-pattern-for-non-debug-tasks). Running the Triple on a finished extraction returns three diverging "what if you tried…" tangents that are not what you need.

---

## When to invoke

| Situation | Use it? |
|---|---|
| One inconclusive round with new distinguishing evidence | Usually no — refine and run the next observation |
| Repeated inconclusive rounds whose hypotheses have converged into variants | Consider it when orthogonal framings are likely to change the next observation |
| The cause is known but the fix is a user-owned trade-off | No — escalate the decision |
| A small or already-localized defect | No — continue inline with focused evidence |

---

## Why three Oracles, and why *orthogonal* framings

A single Oracle call returns a single coherent analysis. Coherent analyses tend to inherit the framing of the prompt, which means they inherit the same blind spots the investigator already has. Three Oracles with *orthogonal framings* force the analyses to diverge, and the places where they agree across frames is where the real signal lives.

The three framings below are chosen to cover distinct bug-cause categories:

- **A (obvious-but-missed)** — embarrassingly simple causes the investigator walked past.
- **B (system-boundary)** — causes living at integration seams, not in the code being read.
- **C (invariant-violation)** — assumptions load-bearing to current hypotheses that may themselves be false.

If used, launch the three framings in one parallel batch as **read-only** analyses. They must not edit, spawn, ask the user, or choose a contract; each returns evidence-linked candidates or falsification queries to the lead.

---

## The three prompts

```
task(agent="deep-high",
     prompt="[CONTEXT: bug description + evidence captured so far, verbatim, with file:line refs]. Read-only analysis: do not edit, spawn, ask the user, or choose a fix/contract.

     Framing A — OBVIOUS-BUT-MISSED.
     What is the most embarrassing, most obvious cause that a senior engineer would spot in 30 seconds and we've overlooked? Consider:
     - typos, off-by-one
     - wrong variable name / wrong constant / wrong import
     - stale cache, wrong file edited, wrong process inspected
     - attached to the wrong instance of the service
     - test harness running different code than the app
     - editing src/ while running dist/

     Give me exactly three candidate causes ranked by likelihood, with one sentence each explaining why our evidence is consistent with each.")

task(agent="deep-high",
     prompt="[CONTEXT: bug description + evidence captured so far]. Read-only analysis: do not edit, spawn, ask the user, or choose a fix/contract.

     Framing B — SYSTEM-BOUNDARY.
     What if the bug is NOT in the code we've been reading, but at a boundary? Consider:
     - third-party SDK behavior that contradicts its docs
     - middleware that mutates the request or response
     - a proxy/gateway/load balancer that rewrites headers or bodies
     - build-time vs runtime env-var resolution
     - module-load-order issue
     - shared-library version mismatch (system lib vs bundled lib)
     - ABI difference (native addons, glibc versions, musl vs glibc)
     - wrong transport (HTTP/1.1 vs HTTP/2, TLS version negotiation)

     Give me three candidate causes, each naming the specific boundary and the specific contract assumption that might be violated.")

task(agent="deep-high",
     prompt="[CONTEXT: bug description + evidence captured so far]. Read-only analysis: do not edit, spawn, ask the user, or choose a fix/contract.

     Framing C — INVARIANT-VIOLATION.
     Which invariants that we've been ASSUMING TRUE might actually be false?
     Enumerate the five assumptions most load-bearing to our current hypotheses, then for each:
     - describe the smallest runtime query that would falsify it
     - predict what the observable would be if the invariant holds vs if it fails

     We want at least one of these queries to be decisive.")
```

---

## Synthesizing across three Oracles

**Do not pick the highest-ranked candidate from a single Oracle.** That defeats the purpose of getting three framings.

Instead, walk the outputs in this order:

### 1. Agreement scan

Note which candidate causes appear in at least two Oracles' outputs. Independent agreement across orthogonal framings is strong signal — when the obvious-but-missed framing and the system-boundary framing both land on the same cause, that's usually the bug.

### 2. Disagreement scan

Note where Oracles disagree. Disagreement is genuine uncertainty that runtime evidence (not more reasoning) must resolve. Each disagreement becomes a candidate for the next round's distinguishing query.

### 3. New falsification queries

Framing C produces concrete "one query that would decide it" suggestions. Pull these verbatim into your new round's evidence-gathering plan — they are designed to be decisive.

### 4. Build the next observation set

Keep only distinct hypotheses that alter the next query or fix. Draw candidates from both agreement and disagreement where that helps one round of evidence discriminate among them.

Record in the journal:

```markdown
## Oracle Triple — Round <N>
- Invoked at: <ISO timestamp>
- Framing A summary: <top 3 candidates, one line each>
- Framing B summary: <top 3 candidates>
- Framing C summary: <5 load-bearing assumptions + falsification queries>

### Cross-framing agreement
- <candidate> appeared in A + B
- <candidate> appeared in B + C

### New hypothesis set
1. <hypothesis> — evidence to gather: <one-liner>
2. ...
```

### 5. Continue from evidence

Return to investigation with the new observations. If the cause becomes clear but choosing a repair requires an unapproved trade-off, escalate that choice immediately (`05-escalate.md`). If evidence remains exhausted, present the full trace, current uncertainty and options instead of guessing a fix; a delegated worker sends that brief to its parent.

If `deep-high` is not listed in the task tool description, use `task` with the same read-only framing.
