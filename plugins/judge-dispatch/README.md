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

Requires OMP 18.2.11 or newer.

The plugin has no credentials of its own. It judges through OMP's built-in
judgment support; see [Enabling the judge role](#enabling-the-judge-role).

## Modes and coverage

| Invocation | `standard` (default) | `enhanced` |
| ---------- | -------------------- | ---------- |
| `task` (flat and batch) | routed | routed |
| `eval.agent()` | not routed | routed |
| `workpool()` fresh workers | not routed | routed |
| Host requirement | stock OMP | OMP with subagent routing API v2 |

At `session_start` the plugin reads the effective settings for that session's
cwd and registers one routing surface. A standard session never registers the
enhanced lifecycle handler. Restart the session after changing modes.

Standard mode rewrites the `agent` field in ordinary `task` tool calls. It
cannot see the host's final spawn preflight, so it takes the legal candidate
set from the live `task` tool's rendered agent list, which OMP has already
filtered by the session's spawn policy and disabled agents. If that list cannot
be read, the plugin sends no judgment and leaves the call alone; an unknown
policy is never treated as unrestricted. The task tool stays authoritative and
revalidates any name the plugin writes.

Enhanced mode subscribes to OMP subagent routing API v2. The host hands over
the filtered candidate set right before allocation, so one route covers `task`,
`eval.agent()`, and `workpool()`. The plugin checks the host's routing API
version at startup. Ask for enhanced mode on an older host and that session
falls back to standard mode and warns once on its first `task` call; the plugin
never patches the host.

Both modes leave agents named `audit-*` alone. The `audit-goal` plugin reserves
them for its `/audit` loop, so a request for one is never rerouted and no other
request is ever routed to one.

## Settings

The installed package name used by `omp plugin config` is
`wows-omp-plugin-judge-dispatch`:

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch integrationMode enhanced
omp plugin config set wows-omp-plugin-judge-dispatch minimumConfidence 0.8
omp plugin config set wows-omp-plugin-judge-dispatch includeSharedContext false
omp plugin config set wows-omp-plugin-judge-dispatch judgeEffort true
```

| Setting | Type | Default | Effect |
| ------- | ---- | ------- | ------ |
| `integrationMode` | `standard` \| `enhanced` | `standard` | Selects task interception or API v2 lifecycle routing. Restart after changing it. |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Minimum native judgment confidence required to replace the requested type. |
| `includeSharedContext` | boolean | `true` | Includes shared task/subagent context in the routing request. |
| `judgeEffort` | boolean | `false` | Also lets the judge set each `task` call's thinking effort. Standard mode only; see [Thinking effort](#thinking-effort). |

OMP merges user settings with project overrides before the plugin reads them.

## Thinking effort

With `judgeEffort` on, each routing judgment also asks for the `task` tool's
`effort` field: `lo`, `med`, or `hi`, chosen by how open-ended the assignment
is. OMP maps that onto the lowest, middle, or highest thinking level the child's
resolved model supports and still caps it at `task.maxEffort`, so the judge
never selects a level the model lacks.

An effort judged at or above `minimumConfidence` replaces whatever effort the
parent requested; a less confident answer leaves the call as it was. The effort
is judged even when only one agent type is legal, and OMP applies it whether or
not `task.enableEffort` shows the field to the parent. Requests for `audit-*`
agents stay untouched.

Only standard mode can apply the effort, because the routing API v2 spawn result
carries just the agent type. Enhanced sessions never ask the judge for effort.

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
in place; nothing is blocked. Standard routing takes at most eight
seconds and keeps a one-second safety margin below the session's configured
tool-call handler timeout; with no useful budget left it does no routing. A
rewrite keeps every unrelated field; `effort` changes only with `judgeEffort` on.
