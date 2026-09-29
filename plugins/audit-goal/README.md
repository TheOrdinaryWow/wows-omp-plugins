# audit-goal

Adds `/audit <audit-target>`, an OMP goal that runs rounds of independent audits
and fixes until the audit reaches a recorded conclusion or you stop it. Each
round is written to a persisted evidence ledger, and the loop uses two reserved
agents.

## Install

```bash
omp plugin install audit-goal@wows-omp-plugins
```

Requires OMP 18.3.1 or newer and goal mode (`goal.enabled`, on by default).
Restart the session after installing.

## Usage

```text
/audit plan local://PLAN.md
/audit the checkout service refactor on this branch
```

The target is free text: a plan, a task, or anything else you want verified.
`/audit` will not start during plan mode or vibe mode, while another goal is
unfinished, or while an audit is already running in the session.

A running audit is an ordinary OMP goal, so `/goal` shows, pauses, resumes, or
drops it, and `/goal drop` stops it at any time. The model cannot complete the
goal (`goal({op:"complete"})`, including through a nested device call) until
`audit_round` has recorded a valid conclusion. The footer shows the round
count, the limit, the intensity, and any pending conclusion.

In each round the main agent:

1. splits the codebase into audit domains (for example server, worker,
   database) and sends read-only `audit-auditor` subagents into them;
2. checks every reported finding against the source and rejects false ones;
3. sends `audit-fixer` subagents to fix the rest, in lanes that never share
   files;
4. runs the project's full checks, confirms a clean tree, and records the round.

Findings are graded Critical, Major, Minor, or Picky at every intensity.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-audit-goal`.

| Setting | Type | Default | Meaning |
| ------- | ---- | ------- | ------- |
| `intensity` | `relaxed` \| `standard` \| `strict` | `standard` | Audit depth, which severities get fixed, and when the audit may converge |
| `maxRounds` | number or empty | empty | Round limit per `/audit`; empty means unlimited |
| `maxParallelLanes` | number or empty | empty | Audit/fix subagents running at once; empty means no plugin limit |

`maxParallelLanes` is capped by OMP's `task.maxConcurrency`: with a setting of
10 and a host limit of 3, three lanes run. The plugin rejects any `task` call
that would exceed the limit.

### Intensity

| | `relaxed` | `standard` | `strict` |
| --- | --- | --- | --- |
| Auditors report | visible problems: wrong behavior under normal use, failing checks, clear plan deviations | findings with a credible production trigger, across the full end-to-end chain | also toolchain, dependency, and host boundaries, and latent bugs with a concrete trigger even when rare |
| Fixed | Critical, Major | Critical, Major, Minor | every level |
| Converges after | one round with no Critical or Major | two consecutive rounds with no Critical or Major | two consecutive rounds with no Critical, Major, or Minor |

### How an audit ends

Every round records the auditor models, the coverage and checks actually run,
verified findings with source evidence, which findings are open or resolved,
repairs of earlier findings, and why rejected claims were rejected. Severity
counts cover new findings only; the ledger lists remaining open findings
separately.

The audit can end in three ways:

- Threshold convergence. Once the intensity's exit gate is met, the agent
  records `threshold-convergence` with its reasoning, reports, and completes the
  goal. The gate only says the audit stopped finding problems. It does not
  prove the code is bug-free, and earlier Critical or Major findings stay open
  until a recorded repair closes them.
- Capability saturation. With unlimited rounds, the agent may record
  `capability-saturation` after at least three comparable rounds by the same
  auditor models, over varied axes, show with cited observations that another
  round is unlikely to find more. Open Critical and Major findings stay open.
  Finding counts or a self-feeding signal alone do not justify saturation.
- Stop. When a finite round limit runs out before convergence, the agent says
  the audit is not finished and asks whether to add rounds, remove the limit, or
  stop. Stopping records `stop` with the reason and the remaining findings.
  Cancelling that question leaves the choice pending and blocks model
  completion. Headless sessions record a separate noninteractive stop.

`/goal budget` limits tokens, not rounds; this plugin counts rounds itself.

Long loops can feed themselves: fixes add new mechanisms, and the next round
audits those. `/audit` records the git `HEAD` at start and tracks
loop-induced findings separately. When that happens, the agent should
simplify or revert the added mechanisms; it does not end the audit by itself.

No outcome accepts the audited work. Recorded results always carry
`artifactAccepted: false`; acceptance is up to you and your project's own
process.

## Reserved agents

`audit-auditor` (read-only) and `audit-fixer` show up in every session's `task`
agent list, because OMP cannot hide plugin agents. The plugin refuses to
dispatch them outside a running `/audit` loop, from subagents, or through
`eval` `agent()`. Both block: the main agent waits for each batch.
`judge-dispatch` from this marketplace never routes to or away from them.

## Behavior notes

- The protocol and the round ledger are injected as a hidden message when the
  audit starts and again after every compaction.
- The plugin enables the `goal` and `audit_round` tools for the loop and
  disables the ones it enabled when the goal completes or is dropped.
- If the latest ledger entry is malformed, the model cannot complete the goal
  or dispatch reserved agents, and the plugin does not fall back to an older
  snapshot. Use `/goal drop` and start a new audit.
- Commit conventions and project rules come from the audited project's own
  context files.
