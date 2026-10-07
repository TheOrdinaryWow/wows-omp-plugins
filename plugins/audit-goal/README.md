# audit-goal

English | [简体中文](README.zh.md)

Adds `/audit <audit-target>`, an OMP goal that runs rounds of independent audits and fixes until the audit reaches a recorded conclusion or you stop it. Each round is written to a persisted evidence ledger, and the loop uses two reserved agents.

## Install

```bash
omp plugin install audit-goal@wows-omp-plugins
```

Requires OMP 18.3.5 or newer and goal mode (`goal.enabled`, on by default). Restart the session after installing.

## Usage

```text
/audit plan local://PLAN.md
/audit the checkout service refactor on this branch
```

The target is free text: a plan, a task, or anything else you want verified. `/audit` will not start during Plan Mode or vibe mode, while another goal is unfinished, or while an audit is already running in the session.

A running audit is an ordinary OMP goal, so `/goal` shows, pauses, resumes, or drops it, and `/goal drop` stops it at any time. The model cannot complete the goal (`goal({op:"complete"})`, including through a nested device call) until `audit_round` has recorded a valid conclusion. The footer shows the round count, the limit, the intensity, and any pending conclusion.

In each round the main agent:

1. splits the codebase into audit domains (for example server, worker, database) and sends read-only `audit-auditor` subagents into them;
2. checks every reported finding against the source and rejects false ones;
3. sends `audit-fixer` subagents to fix the rest, in lanes that never share files;
4. runs the project's full checks, confirms a clean tree, and records the round.

Findings are graded Critical, Major, Minor, or Picky at every intensity.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-audit-goal`.

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `intensity` | `relaxed` \| `standard` \| `strict` | `standard` | Audit depth, which severities get fixed, and when the audit may converge. |
| `maxRounds` | number or empty | empty | Round limit per `/audit`; empty means unlimited. |
| `maxParallelLanes` | number or empty | empty | Audit/fix subagents running at once; empty means no plugin limit. |

`maxParallelLanes` is capped by OMP's `task.maxConcurrency`: with a setting of 10 and a host limit of 3, three lanes run. The plugin rejects any `task` call that would exceed the limit.

### Intensity

|  | `relaxed` | `standard` | `strict` |
| --- | --- | --- | --- |
| Auditors report | visible problems: wrong behavior under normal use, failing checks, clear plan deviations | findings with a credible production trigger, across the full end-to-end chain | also toolchain, dependency, and host boundaries, and latent bugs with a concrete trigger even when rare |
| Fixed | Critical, Major | Critical, Major, Minor | every level |
| Converges after | one round with no Critical or Major | two consecutive rounds with no Critical or Major | two consecutive rounds with no Critical, Major, or Minor |

### How an audit ends

Each round records the auditor models, coverage, and checks run. It also records verified findings with source evidence, their open or resolved status, repairs of earlier findings, and the reasons for rejecting claims. Severity counts cover new findings only; the ledger lists remaining open findings separately.

The audit can end in three ways:

- Threshold convergence. Once the intensity's exit gate is met, the agent records `threshold-convergence` with its reasoning, reports, and completes the goal. The gate only says the audit stopped finding problems. It does not prove the code is bug-free, and earlier Critical or Major findings stay open until a recorded repair closes them.
- Capability saturation. With unlimited rounds, the agent may record `capability-saturation` when the same auditor models have completed at least three comparable rounds across varied audit axes, and cited observations show that another round is unlikely to find more. Open Critical and Major findings stay open. Finding counts or a self-feeding signal alone do not justify saturation.
- Stop. When a finite round limit runs out before convergence, the agent says the audit is not finished and asks whether to add rounds, remove the limit, or stop. Stopping records `stop` with the reason and the remaining findings. Cancelling that question leaves the choice pending and blocks model completion. Headless sessions record a separate noninteractive stop.

`/goal budget` limits tokens, not rounds; this plugin counts rounds itself.

Fixes can introduce new mechanisms that later rounds must audit, prolonging the loop. `/audit` records the git `HEAD` at start and tracks loop-induced findings separately. If this happens, the agent should simplify or revert the added mechanisms. This pattern does not end the audit by itself.

No outcome accepts the audited work. Recorded results always carry `artifactAccepted: false`; acceptance is up to you and your project's own process.

## Host modes

`/audit <target>` takes the target as its argument, so it works the same in the TUI, RPC (`--mode rpc`), ACP editors, the SDK, and headless runs.

- TUI and RPC show the round count in the status line (`Audit 2/5 · standard`); ACP ignores it.
- At a finite round limit, TUI, RPC, and ACP clients get the add/remove/stop choice as a select dialog. Without a UI, the plugin records the noninteractive stop described above.
- Without a UI, `/audit` usage errors and refusals (no target, goal already set, plan mode, settings errors) appear as visible messages in the session instead of notifications.

## State snapshot

The plugin publishes `audit-goal.json` in the shared snapshot envelope (see the [marketplace README](../../README.md)) whenever it saves the ledger. Sessions that never ran `/audit` get no file. The `state` payload is:

| Field | Meaning |
| --- | --- |
| `kind`, `version` | `"audit-goal/audit"`, `1` |
| `status` | `running`, `awaiting-limit-decision` (finite limit reached, user choice pending), `converged`, `saturated`, `stopped`, or `invalid` (latest ledger entry is malformed or could not be saved; no other fields) |
| `ended` | `true` once the audit goal completed, was dropped, or was replaced |
| `target`, `intensity`, `maxRounds`, `laneLimit`, `baseline` | Audit setup; `maxRounds` and `laneLimit` are `null` when unlimited, `baseline` is `null` outside git |
| `rounds[]` | `index`, `counts` (`critical`, `major`, `minor`, `picky`), `rejected`, `loopInduced`, and `verdict` (`continue`, `threshold-ready`, `cap-reached`; evaluated against the current round limit) |
| `totals` | Sums of the round counts, plus `rejected` and `loopInduced` |
| `openFindings` | `counts` by severity and `items[]` (`id`, `severity`, `summary`, `origin`) for findings still open |
| `conclusion` | `null`, or `kind` (`threshold-convergence`, `capability-saturation`, `stop`), `reason`, and cited `evidence[]` |
| `stopReason` | The conclusion reason when the audit stopped, otherwise `null` |
| `artifactAccepted` | Always `false` |

When a branch switch leaves the session without an audit ledger, the file is rewritten with `state: null`.

## Reserved agents

`audit-auditor` (read-only) and `audit-fixer` appear in every session's `task` agent list because OMP cannot hide plugin agents. The plugin refuses to dispatch them outside a running `/audit` loop, from subagents, or through `eval` `agent()`. Both use blocking calls, so the main agent waits for each batch. `judge-dispatch` from this marketplace never routes to or away from them.

## Behavior notes

- The protocol and the round ledger are injected as a hidden message when the audit starts and again after every compaction.
- The plugin enables the `goal` and `audit_round` tools for the loop and disables the ones it enabled when the goal completes or is dropped.
- If the latest ledger entry is malformed, the model cannot complete the goal or dispatch reserved agents, and the plugin does not fall back to an older snapshot. Use `/goal drop` and start a new audit.
- Commit conventions and project rules come from the audited project's own context files.
