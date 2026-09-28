---
name: review-work
description: "Use after implementation or before a PR handoff to run real-surface QA and one independent gate review."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Review completed work

Run manual QA on the real surface, then commission exactly one independent gate reviewer. Review passes only when the QA matrix has no failing criterion and the reviewer returns APPROVE.

## Gather evidence

Recover the original user goal, constraints, background and decisions from conversation, plus changed files, diff, nearby conventions, tests and run command. Review PRs and branches in a dedicated review worktree: `git worktree add <path> <branch>` followed by `git worktree lock <path> --reason "review:<pr-or-branch>"`. The main worktree remains untouched. Inspect history and linked issues where relevant; never assume a successful test proves the intended outcome.

## Manual QA

Enumerate every consumer-visible criterion and the real surface that demonstrates it: HTTP requests, browser interactions and screenshots, CLI/TUI sessions, data contracts, or external artifacts. Run each scenario yourself and record command/interaction, input, expected behavior, observed behavior, and evidence path. Include a meaningful adverse case for changed failure behavior. Mark inaccessible surfaces INCONCLUSIVE, not PASS.

## Independent gate

Dispatch one `task` child with `agent: "gate-reviewer"` (if `gate-reviewer` is not listed in the task tool description, use `reviewer`). Give it goal, criteria, constraints, paths, diff, test results and QA matrix. The reviewer independently inspects the evidence and returns APPROVE/REJECT with `reportPath` and criterion-tied blockers. Collect the result from the `task` output or `read agent://<id>`; do not sleep-poll or commission a panel.

On REJECT, repair only evidenced blockers, rerun affected real-surface QA, then dispatch a fresh reviewer with the changed diff and new evidence. On INCONCLUSIVE, identify the missing prerequisite. Summarize the final verdict with citations to observed outputs, not stock confidence language.
