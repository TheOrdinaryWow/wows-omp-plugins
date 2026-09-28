# audit-goal

Adds `/audit <audit-target>`: an OMP goal that loops independent audits and
fixes until a recorded audit-process conclusion or explicit stop. The goal
carries an audit protocol, a persisted evidence ledger, and two reserved agents.

## Install

```bash
omp plugin install audit-goal@wows-omp-plugins
```

Requires OMP 18.2.11 or newer. Restart the session after installing. Goal mode
must be enabled (`goal.enabled`, the default).

## Usage

```text
/audit plan local://PLAN.md
/audit the checkout service refactor on this branch
```

The target is free text: a plan, a task, or any goal you want verified. The
command refuses to start while plan mode or vibe mode is active, while another
goal is unfinished, or while an audit is already running in the session.

Once started, the audit is an ordinary OMP goal. `/goal` shows, pauses,
resumes, or drops it; user-issued `/goal drop` stops the audit. Model-issued
`goal({op:"complete"})`, including nested device invocation, is refused until
`audit_round` has recorded a valid conclusion. The footer shows the round
count, limit, intensity, and any pending conclusion.

Each round the main agent:

1. splits the codebase into audit domains by its own structure (for example
   server, worker, database) and dispatches read-only `audit-auditor`
   subagents;
2. verifies every returned finding against the source and rejects false ones;
3. dispatches `audit-fixer` subagents in lanes that never share files;
4. runs the project's full checks, confirms a clean tree, and records the round.

Findings are graded Critical, Major, Minor, or Picky. The grading is the same at
every intensity.

## Settings

The installed package name used by `omp plugin config` is
`wows-omp-plugin-audit-goal`:

| Setting | Type | Default | Meaning |
| ------- | ---- | ------- | ------- |
| `intensity` | `relaxed` \| `standard` \| `strict` | `standard` | Audit depth, which severities get fixed, and the exit gate |
| `maxRounds` | number or empty | empty | Round limit per `/audit`; empty means unlimited |
| `maxParallelLanes` | number or empty | empty | Audit/fix subagents running at once; empty means no plugin limit |

`maxParallelLanes` never exceeds OMP's own `task.maxConcurrency`: a setting of
10 with a host limit of 3 runs 3 lanes. The plugin refuses any `task` call that
would push running audit subagents over the limit.

### Intensity

| | `relaxed` | `standard` | `strict` |
| --- | --- | --- | --- |
| Auditors report | visible problems: wrong behavior under normal use, failing checks, clear plan deviations | findings with a credible production trigger, across the full end-to-end chain | also toolchain, dependency, and host boundaries, and latent bugs with a concrete trigger even when rare |
| Fixed | Critical, Major | Critical, Major, Minor | every level |
| Converges after | one round with no Critical or Major | two consecutive rounds with no Critical or Major | two consecutive rounds with no Critical, Major, or Minor |

Long audit loops can feed themselves: each round's fixes add mechanisms,
and the next round audits those mechanisms. `/audit` records the git `HEAD`
at start and tracks loop-induced findings separately. A self-feeding signal
calls for simplifying or reverting mechanisms; it is not an automatic exit.

`audit_round({op:"record", ...})` persists each round's auditor model set, actual
coverage and checks, verified finding IDs with source evidence, provenance,
open/resolved status, cited repairs of earlier open findings, and reasons for
rejected claims. Severity counts describe new discoveries, not unresolved
issues; the ledger separately lists **remaining open findings** and counts.
At the configured intensity, an exit gate yields `threshold-ready`. The agent
must record `threshold-convergence` with a reason and round observations before
reporting and completing the goal. This is a discovery gate, not proof of
semantic bug absence or acceptance of the audited artifact. Earlier confirmed
Critical/Major findings remain open until a recorded repair closes them.

With unlimited rounds, the orchestrator can record distinct
`capability-saturation` convergence when at least three comparable rounds by
the same auditor model set with varied axes establish, with cited observations,
why another pass has limited expected discovery value. This includes the former optional
20–30-round low-benefit exit; it is now an explicit, reasoned outcome. Open
Critical/Major findings remain open. Saturation is never accepted repair or
artifact acceptance; counts or a self-feeding flag alone are insufficient.

### Round limit

OMP's `/goal budget` is a token budget; rounds are counted by this plugin. When
the finite limit runs out before threshold convergence, the agent reports that
the audit is **not** finished and asks whether to continue. You can add rounds,
remove the limit, or explicitly stop. Stopping records `stop`, with its reason
and remaining findings, not convergence. Canceling the choice leaves the cap
pending and prevents model completion; headless sessions record a distinct
noninteractive cap stop. You can directly use `/goal drop` at any time.

## Reserved agents

`audit-auditor` (read-only) and `audit-fixer` appear in the `task` agent list of
every session, because OMP cannot hide plugin agents. The plugin refuses to
dispatch them outside a running `/audit` loop, from subagents, or through
`eval` `agent()`. Both are blocking: the main agent waits for each batch.
`judge-dispatch` from this marketplace never routes to or away from them.

## Behavior notes

- The protocol is injected as a hidden message when the audit starts and again
  after every compaction, together with the round ledger.
- The plugin activates the `goal` and `audit_round` tools for the loop and
  deactivates the ones it added when the goal completes or is dropped.
- A malformed latest ledger entry blocks model goal completion and reserved
  agent dispatch; it never silently restores an older successful snapshot.
  The user can use `/goal drop` directly and start a new audit.
- Recorded threshold, saturation, and stop outcomes always report
  `artifactAccepted: false`. Only the user and the audited project's separate
  acceptance process can accept the artifact; the plugin never infers that
  unobserved defects are absent.
- Commit conventions and project rules come from the audited project's own
  context files; the plugin hardcodes none.
