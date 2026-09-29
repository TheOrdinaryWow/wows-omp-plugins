# judge-dispatch

Lets OMP's `judge` model role decide which subagent type a `task` call spawns,
instead of leaving that choice to the parent agent. With `judgeEffort` on, it
also picks the thinking effort. OMP still validates every spawn.

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
```

| Setting | Type | Default | Effect |
| ------- | ---- | ------- | ------ |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Minimum judge confidence needed to replace the requested type. |
| `includeSharedContext` | boolean | `true` | Sends the task call's shared `context` along with the routing request. |
| `judgeEffort` | boolean | `false` | Also lets the judge set each `task` call's thinking effort; see [Thinking effort](#thinking-effort). |

User settings merge with project overrides. The plugin reads them on every
`task` call, so changes apply without a restart.

## Thinking effort

With `judgeEffort` on, the judge also picks the `task` call's `effort` (`lo`,
`med`, or `hi`) based on how open-ended the assignment is. OMP maps it to the
lowest, middle, or highest thinking level the child's model supports, capped at
`task.maxEffort`, so the result is always a level the model has.

An effort judged at or above `minimumConfidence` replaces the parent's choice;
a less confident answer leaves it alone. Effort is judged even when only one
agent type is eligible, and OMP applies it whether or not `task.enableEffort`
shows the field to the parent. The exclusions in
[What gets routed](#what-gets-routed) apply to effort too.

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
`agent`, plus `effort` when `judgeEffort` is on.
