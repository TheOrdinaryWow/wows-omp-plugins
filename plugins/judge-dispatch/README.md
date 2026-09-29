# judge-dispatch

Asks OMP's `judge` model role which subagent type OMP should spawn, instead of
leaving that choice to the parent agent.

The plugin picks the type and, with `judgeEffort` on, the thinking effort of
`task` calls. OMP still validates every spawn.

## Install

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

Restart the session afterwards so the extension can register.

Requires OMP 18.3.1 or newer.

The plugin has no credentials of its own. It judges through OMP's built-in
judgment support; see [Enabling the judge role](#enabling-the-judge-role).

## Coverage

The plugin rewrites the `agent` field of ordinary `task` tool calls, flat and
batch. Subagents spawned through `eval.agent()` or `workpool()` are not routed:
OMP's `before_subagent_spawn` hook can replace a child's model but not its
agent type.

The plugin cannot see the host's final spawn preflight, so it takes the legal
candidate set from the live `task` tool's rendered agent list (both heading and
backticked-bullet formats), which OMP has already filtered by the session's
spawn policy and disabled agents. An absent or unrecognized list is unknown;
an explicitly disabled list is empty. Neither permits a judgment. The task
tool remains authoritative and revalidates any name the plugin writes.

Requests for `audit-*`, `metis`, `momus`, and `oracle` agents stay untouched,
including effort; ordinary requests cannot be routed into these workflow-owned
roles. If an explicit requested agent is not discoverable, its access cannot
be established and the call stays untouched. A known read-only agent can only
be replaced with another read-only agent, using OMP's agent-tool metadata to
classify both. During an active `omo-prometheus` execution session, the approved
plan owns all `task` agent and effort choices; judge-dispatch does not rewrite
them. Once that workflow returns to idle/planning, ordinary routing resumes.

## Settings

The installed package name used by `omp plugin config` is
`wows-omp-plugin-judge-dispatch`:

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch minimumConfidence 0.8
omp plugin config set wows-omp-plugin-judge-dispatch includeSharedContext false
omp plugin config set wows-omp-plugin-judge-dispatch judgeEffort true
```

| Setting | Type | Default | Effect |
| ------- | ---- | ------- | ------ |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Minimum native judgment confidence required to replace the requested type. |
| `includeSharedContext` | boolean | `true` | Includes the task call's shared `context` in the routing request. |
| `judgeEffort` | boolean | `false` | Also lets the judge set each `task` call's thinking effort; see [Thinking effort](#thinking-effort). |

OMP merges user settings with project overrides. The plugin reads them on every
`task` call, so changes apply without a restart.

## Thinking effort

With `judgeEffort` on, each routing judgment also asks for the `task` tool's
`effort` field: `lo`, `med`, or `hi`, chosen by how open-ended the assignment
is. OMP maps that onto the lowest, middle, or highest thinking level the child's
resolved model supports and still caps it at `task.maxEffort`, so the judge
never selects a level the model lacks.

An effort judged at or above `minimumConfidence` replaces whatever effort the
parent requested; a less confident answer leaves the call as it was. The effort
is judged even when only one eligible agent type is legal, and OMP applies it
whether or not `task.enableEffort` shows the field to the parent. Protected
workflow roles, unresolved explicit agents, empty legal sets, and active
Prometheus execution remain untouched.

## Enabling the judge role

Routing uses OMP's `judge` model role. The simplest setup is a TypeSafe credential:

```bash
omp            # then run: /login typesafe
# or, before OMP starts:
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

With a TypeSafe credential, OMP's `judge` role resolves to Jev by default
(`providers.judgmentProvider: auto`). Credentials, base URL, model choice,
request headers, and usage accounting all come from OMP.

The plugin routes only when the first usable candidate in that role is a native
judgment model, meaning one served through a judgment API such as TypeSafe or
OpenRouter decisions. Native judges return calibrated confidence, which
`minimumConfidence` depends on. When the role resolves to a chat model or an
on-device model instead, or no credential exists, the plugin never calls that
model: it keeps the requested agent and shows one warning per session.

## Privacy and fail-open behavior

A judgment carries the assignment, the optional shared context, the originally
requested agent, and short candidate descriptions with model and fallback
summaries. The conversation and system prompt are never sent. Requests,
credentials, and usage journaling go through OMP's `judge` role; the plugin
stores no key and does not modify the process environment.

A route changes only when the judge returns a legal choice at or above the configured
confidence. A missing native judge, discovery failures, low confidence, illegal
choices, rejected credentials, and network errors all leave the original route
in place; nothing is blocked. Routing takes at most eight
seconds and keeps a one-second safety margin below the session's configured
tool-call handler timeout; with no useful budget left it does no routing. A
rewrite keeps every unrelated field; `effort` changes only with `judgeEffort` on.
