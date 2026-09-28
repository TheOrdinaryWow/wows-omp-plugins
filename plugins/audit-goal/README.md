# audit-goal

Adds `/audit <audit-target>`: an OMP goal that loops independent audits and
fixes until the target converges. It behaves like `/goal <audit-target>`, but
the goal carries an audit protocol, a round ledger, and two reserved agents.

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
resumes, or drops it; dropping the goal ends the audit. The footer shows the
round count, the limit, and the intensity.

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

Long audit loops tend to feed themselves: each round's fixes add mechanisms,
and the next round audits those mechanisms. To keep that visible, `/audit`
records the git `HEAD` at start as the loop's baseline. Every finding is
classified as pre-existing or loop-induced (its root cause lies in a commit
after the baseline), and loop-induced findings are resolved by reverting or
simplifying the earlier fix rather than stacking a new one. The ledger flags a
self-feeding loop when every finding of a round is loop-induced while severity
falls, or when loop-induced findings make up at least half of two consecutive
rounds; the agent then stops adding mechanisms and may declare convergence.
Without a round limit, it may also stop after 20 to 30 rounds if only a few
Major findings remain and more rounds no longer pay off.

### Round limit

OMP's `/goal budget` is a token budget; rounds are counted by this plugin. When
the limit runs out before convergence, the agent first reports that the audit
is **not** finished and what remains open, then asks you whether to continue.
The options scale with the current limit: with 10 rounds you can add 5 or 10,
remove the limit, or stop. Stopping completes the goal with that report.
Sessions without an interactive UI stop at the limit.

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
- Commit conventions and project rules come from the audited project's own
  context files; the plugin hardcodes none.
