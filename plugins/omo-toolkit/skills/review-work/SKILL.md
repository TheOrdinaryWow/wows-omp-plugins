---
name: review-work
description: "Post-implementation gate review: run real-surface QA, then one independent reviewer audits the goal, constraints, code, security, context and evidence. Use before a PR handoff or when asked to review completed work."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace` (source: `packages/shared-skills/skills/review-work/SKILL.md`). It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Review completed work

Use two lanes: your hands-on QA on the real surface, and **one independent gate reviewer**, never a panel. A passing review requires every applicable QA criterion to be proven and the reviewer to return APPROVE. A finished child is not necessarily an approving child.

## 1. Gather the context

Recover the original request, goal, background, constraints and confirmed decisions from the conversation first. Ask only for consequential information that the conversation, repository and tools cannot supply. Gather:

- Changed files and the diff against the appropriate branch point or commit, not blindly `HEAD~1`.
- Paths to changed source, neighboring conventions, importers, tests, relevant configuration and documentation.
- The run command from repository scripts or other actual project instructions.
- Relevant history, linked issues/PRs, earlier review decisions and outstanding warnings. Record each as source → finding → significance; do not invent access to trackers.
- Existing executor summaries, check results and QA artifacts, including what tree and inputs they exercised.

Review PRs and branches in a dedicated review worktree. Create or attach it before collecting branch evidence or running checks: `git worktree add <path> <branch>`, then `git worktree lock <path> --reason "review:<pr-or-branch>"`. The main worktree is read-only context; never checkout, test or edit the review branch there. Record the owned worktree path for recovery. Do not disturb another worker's branch or tree.

Pass authoritative file paths to the reviewer rather than copying files into prompts. Host-rendered assignment text is not a byte channel; reviewers must read the files themselves. If a path is session-local, resolve a physical path the child can actually read.

## 2. Run manual QA

You own the hands-on QA lane. An enclosing execution workflow that forbids coordinator QA may assign it to its authorized QA child; preserve that workflow's ownership and evidence rules rather than creating a competing gate.

**Reuse relevant current evidence first.** Record what each check exercised: source/commit or working-tree state, targets, dependency versions, configuration, generated inputs and relevant environment. Relevant source (including importers), dependency, configuration, generated-input or environment changes invalidate the corresponding check claim. Rerun affected rows; retain unaffected observations. A new HEAD alone neither invalidates every check nor proves freshness. Apply this rule by reasoning about inputs, not by adding a text/regex classifier.

Choose the channel that actually exercises the changed surface:

| Surface | Evidence |
| --- | --- |
| HTTP/API | Real request, status, headers and body |
| CLI/TUI | Real PTY interaction and transcript; rendered capture for layout/color claims |
| Web | Native browser actions and screenshots; read `skill://agent-browser` first, use the authenticated attached session when required, never clone a live profile |
| Desktop/GUI | Available native automation against the running app, with action log and screenshot |
| Library/SDK | Public API or schema-boundary exercise with observed output |
| Migration/config/generated artifact | Actual resulting artifact and its relevant diff or inspection |

Cover every stated consumer-visible acceptance criterion, its named happy path, a relevant risky edge and adjacent regression where applicable. Include a meaningful adverse case when failure/rejection behavior changed; do not invent an obligatory failure handler where none is required. A test at a real library, schema or build-time boundary can be the real surface.

| Scenario | Exact command/action and input | Expected | Observed | Verdict | Artifact |
| --- | --- | --- | --- | --- | --- |

A row without evidence is not PASS. Inaccessible surfaces or missing prerequisites are INCONCLUSIVE. An application that is expected to start but fails to start is FAIL. Any FAIL stops the gate dispatch: report the failing rows and fix first when repair is authorized, then return with the delta and affected fresh evidence. Do not send known-failing work to a reviewer merely to collect approval.

## 3. Dispatch one independent gate reviewer

Use one fresh native `task` child with `agent: "deep-high"` when listed in the live task roster; otherwise omit `agent` and use `effort: "hi"`. Do not invent a roster entry. Keep doing independent work while it runs; use native automatic result delivery and `wait` only when blocked, never polling.

The assignment is self-contained and names:

- Original request and clarifications, goal, background, constraints and expected user-visible result.
- Owned review worktree, changed files, diff/base, source paths and context-mining findings.
- Executor summary, exact check commands and their results, current QA matrix and accessible evidence paths.
- Explicit authority to run the relevant named checks; this is a read-only verifier, except for its report artifact. It must not implement fixes or spawn sub-reviewers.
- Report output at a unique `local://reviews/<goal-slug>-gate-<attempt>.md`, with a returned readable artifact path. Preserve completed reports immediately.

Require independent inspection rather than trust in executor conclusions. The reviewer checks:

1. **Goal completeness:** each requested or evidenced existing obligation is ACHIEVED, MISSED or PARTIAL, with source/artifact evidence. Do not turn an imagined ideal state into a new requirement.
2. **Constraint compliance:** each actual constraint, including compatibility and authorization boundaries.
3. **Correctness:** representative and relevant edge/failure scenarios, leaks, races and error paths supported by the changed behavior, not a fixed scenario quota.
4. **Quality:** established patterns, meaningful tests (not tautologies or overfit implementation mirrors), error handling, types, relevant performance and API compatibility. No arbitrary file-size gate or compulsory refactor.
5. **Security:** applicable input, authorization, secret, data-exposure, dependency and file/network boundaries; no speculative hardening without a concrete supported failure.
6. **Missed context:** reasons in history/issues/docs and affected consumers/importers/configuration.
7. **QA evidence:** inspect each referenced artifact, check freshness and what it actually demonstrates, and name uncovered criteria.
8. **Scope and proportionality:** distinguish substantiated over-build that violates an obligation from optional style/design preferences. A new mechanism needs a supported failure condition, obligation and explanation of why existing facilities are insufficient; a demanded cut must preserve the actual obligations.

Approve unless evidence ties a blocker to a goal item, constraint or required QA row. Missing required proof is a blocker to approval; an inaccessible prerequisite can make the verdict INCONCLUSIVE rather than fabricate a failure or approval. Alternatives, taste and hypothetical future requirements are non-blocking notes. Notes do not authorize scope expansion.

Require this report shape:

```text
Verdict: APPROVE | REJECT | INCONCLUSIVE
Confidence: HIGH | MEDIUM | LOW
Summary: assessment from the user's perspective
Goal breakdown: ACHIEVED / MISSED / PARTIAL, with evidence
Constraint compliance: obligation and evidence
QA audit: VERIFIED / UNPROVEN per row, freshness and limits
Blocking issues: obligation → observation → file:line/artifact → minimal fix
Missing prerequisites: evidence/access needed, if any
Notes: short non-blocking findings
```

## 4. Collect a terminal outcome

Keep manual QA and gate results separate: QA PASS/FAIL/INCONCLUSIVE; gate pending/APPROVE/REJECT/INCONCLUSIVE.

A **still-running reviewer is alive**, not silent. A wait timeout or queued follow-up is neither a verdict nor cancellation. Use the native final result to distinguish active work from a terminal completed, failed, aborted or blocked review; lifecycle/progress alone is not final success.

A terminal reviewer that returns only an acknowledgement, reports a blocking prerequisite, or ends without a usable verdict makes the lane **INCONCLUSIVE**. Dispatch **at most one smaller replacement reviewer for the same inputs**, explicitly naming the missing deliverable. Do not start that replacement while the original reviewer is still active or treat a message as proof it stopped. If the replacement also terminates without a verdict, keep INCONCLUSIVE and issue the final result naming the unresolved lane. No repeated wait/follow-up/replacement loop, and no missing verdict counts as approval.

On REJECT, repair only evidenced blockers when authorized, rerun affected QA, and dispatch a **new reviewer** scoped to the delta, earlier blockers and current evidence. This is a re-review after changed work, not a retry of a missing verdict; never keep a long-lived reviewer via follow-up to bless its own stale context.

### Worktree lifetime and recovery

Only after every reviewer using the tree reaches a **terminal state**, and any replacement or required re-review is finished, run `git worktree unlock <path>` followed by `git worktree remove <path>` before delivery. Do not remove a live reviewer's working directory. Do not force-remove dirty work or discard report/evidence files: preserve them outside the tree first, or retain the tree and report the cleanup blocker. If QA fails before any reviewer starts, the same preservation rule applies before cleanup.

A review/orchestrator crash leaves the locked tree as a recoverable marker. On recovery, inspect native child status and preserved evidence before cleanup; when a reviewer is still running or its state is unknown, leave the tree locked and report its path. Never infer termination from elapsed time.

## 5. Deliver the verdict

- **REVIEW PASSED:** every applicable QA row is PASS and the gate returned APPROVE.
- **REVIEW FAILED — criteria not met:** any QA row is FAIL or the gate returned REJECT.
- **REVIEW INCONCLUSIVE — not approved:** no failure is proven, but any required QA row or the gate remains INCONCLUSIVE.

Report the overall verdict, separate lane results, failing/unproven criteria with artifact pointers, minimal authorized fixes or missing prerequisites, relevant non-blocking notes and any retained worktree. Cite observed outputs rather than stock confidence language. A passing review is short; an inconclusive review is not a passing one.
