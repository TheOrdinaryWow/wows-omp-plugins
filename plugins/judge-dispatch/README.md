# judge-dispatch

Lets OMP's `judge` model role decide which subagent type a `task` call spawns,
instead of leaving that choice to the parent agent. With `judgeEffort` on, it
also picks the thinking effort; with `modelBudget` on, it also picks the
child's model from its configured chain. OMP still validates every spawn.

## Install

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

Requires OMP 18.3.1 or newer. Restart the session afterwards so the extension
can register. The plugin has no credentials of its own; it judges through OMP's
built-in judgment support (see [Enabling the judge role](#enabling-the-judge-role)).

## What gets routed

The plugin rewrites the `agent` field of ordinary `task` calls, single or
batch. Subagents started through `eval.agent()` or `workpool()` are not routed,
because OMP's `before_subagent_spawn` hook can change a child's model but not
its agent type.

Candidates come from the agent list in the live `task` tool description, which
OMP has already filtered by spawn policy and disabled agents. If that list is
missing, unreadable, or empty, the plugin does not judge. The `task` tool
revalidates any name the plugin writes.

These calls are left exactly as they are, effort included:

- requests for `audit-*`, `metis`, `momus`, or `oracle`; ordinary requests are
  never routed into these workflow roles either;
- requests for an agent the plugin cannot find in the list, since its access
  level is unknown;
- every `task` call while an `omo-prometheus` plan is executing, because the
  approved plan owns agent and effort choices. Routing resumes once that
  workflow returns to idle or planning.

A read-only agent is only ever replaced by another read-only agent, based on
OMP's agent tool metadata.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-judge-dispatch`.

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch minimumConfidence 0.8
omp plugin config set wows-omp-plugin-judge-dispatch includeSharedContext false
omp plugin config set wows-omp-plugin-judge-dispatch judgeEffort true
omp plugin config set wows-omp-plugin-judge-dispatch modelBudget balanced
```

| Setting | Type | Default | Effect |
| ------- | ---- | ------- | ------ |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Minimum judge confidence needed to replace the requested type. |
| `includeSharedContext` | boolean | `true` | Sends the task call's shared `context` along with the routing request. |
| `judgeEffort` | boolean | `false` | Also lets the judge set each `task` call's thinking effort; see [Thinking effort](#thinking-effort). |
| `modelBudget` | `off`, `minimum`, `balanced`, `max` | `off` | Picks each spawn's model by task difficulty, intelligence, and price; see [Model budget](#model-budget). |
| `indicator` | boolean | `true` | Shows routing activity; see [What you see](#what-you-see). Routing works the same either way. |

User settings merge with project overrides. The plugin reads them on every
`task` call, so changes apply without a restart.

## What you see

While the judge runs, the working message reads `judge-dispatch: routing N
tasks…`, and the default message returns once judging finishes, fails, or
times out.

Each routed `task` call then prints one dim status line right away, the same
kind of line Ctrl+O prints, for example:

```text
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · effort med → hi (0.92)
```

Every item appears with the judge's confidence, whether its agent changed or
was kept. An item kept without a usable judgment names the reason instead:
`judge unavailable`, `judge failed`, `timed out`, `no alternatives`, `no
confident choice`, or `workflow-owned or unknown agent`. A call that is not
judged at all, because routing failed, timed out, or the host leaves no time to
judge, still gets a line starting `kept the requested agent:`. Calls made while
Prometheus executes an approved plan are not routed and print nothing.

The line is for you only: it is never sent to the model and is not saved in the
session, so it does not reappear after `/resume`. OMP folds status lines that
arrive back to back into one, so several `task` calls in the same turn can leave
only the last line visible. Model changes from `modelBudget` already appear as
OMP's note next to the child's model and are not repeated.

Set `indicator` to `false` to hide both the working message and the status line.

## Thinking effort

With `judgeEffort` on, the judge classifies how open-ended the assignment is
(`routine`, `standard`, or `demanding`) and the plugin sets the `task` call's
`effort` to `lo`, `med`, or `hi` accordingly. OMP maps it to the lowest,
middle, or highest thinking level the child's model supports, capped at
`task.maxEffort`, so the result is always a level the model has.

A difficulty judged at or above `minimumConfidence` replaces the parent's
effort; a less confident answer leaves it alone. Difficulty is judged even when
only one agent type is eligible, and OMP applies the effort whether or not
`task.enableEffort` shows the field to the parent. The exclusions in
[What gets routed](#what-gets-routed) apply to effort too.

## Model budget

With `modelBudget` on, the same difficulty judgment also picks the child's
model. The candidates are the spawning agent's model selectors: its
`task.agentModelOverrides` entry or frontmatter `model` list, or, for a single
selector, that selector plus the `retry.fallbackChains` entry for its role.

Each candidate is resolved through OMP's model registry, which carries the
model's price (from models.dev) and an intelligence score from OMP's live model
catalog. The registry matches custom and proxy provider ids to the scored
catalog entry, so the plugin keeps no model data of its own. A candidate that
is unavailable (no credentials) or has no score is skipped; if the first
selector has no score, the spawn keeps its configured model.

| Budget | Choice |
| ------ | ------ |
| `max` | The highest-scoring candidate, even when it is not first in the chain. |
| `balanced` | The cheapest candidate scoring at least 80% / 90% / 100% of the best candidate, for routine / standard / demanding work. |
| `minimum` | The cheapest candidate scoring at least 70% / 80% / 95% of the best candidate. |

Price is blended 3:1 input to output. Because eligibility is relative to the
best candidate, a weak model kept only as a last-resort fallback is never
picked to save money. The chosen model moves to the front of the spawn's
selectors; the rest stay behind it as fallbacks, and OMP shows the routing note
next to the resolved model.

OMP's `before_subagent_spawn` event carries no assignment, so the plugin links
the judgment to the spawn through the task item's `name`. When the parent gave
no name, the plugin writes one (`<agent>-<8 hex>`). If two pending calls share
a name, neither is changed. Subagents from `eval.agent()` and `workpool()` keep
their models, and the exclusions in [What gets routed](#what-gets-routed)
apply here too.

## Enabling the judge role

Routing uses OMP's `judge` model role. The simplest setup is a TypeSafe
credential:

```bash
omp            # then run: /login typesafe
# or, before OMP starts:
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

With a TypeSafe credential, the `judge` role resolves to Jev by default
(`providers.judgmentProvider: auto`). OMP supplies the credentials, base URL,
model, request headers, and usage accounting.

The plugin routes only when the first usable model in that role is a native
judgment model, served through a judgment API such as TypeSafe or OpenRouter
decisions. `minimumConfidence` relies on the calibrated confidence those APIs
return. If the role resolves to a chat model or an on-device model, or there
is no credential, the plugin never calls it. It keeps the requested agent and
warns once per session.

## Privacy and failure behavior

A judgment request contains the assignment, the optional shared context, the
originally requested agent, and short candidate descriptions with their model
and fallback summaries. The conversation and system prompt are never sent.
Requests, credentials, and usage journaling go through OMP's `judge` role; the
plugin stores no keys and does not touch the process environment.

The route changes only when the judge returns a legal choice at or above the
configured confidence. Anything else (no native judge, discovery failure, low
confidence, an illegal choice, rejected credentials, network errors) keeps the
original route, and nothing is blocked. Routing gives up after eight seconds
and always finishes at least one second before the session's tool-call handler
timeout; if there is no time left, it skips routing. A rewrite changes only
`agent`, plus `effort` when `judgeEffort` is on and `name` when `modelBudget`
needs one. Budget model selection happens at spawn time; any failure there
keeps the configured model.
