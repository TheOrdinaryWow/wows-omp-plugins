# jev-dispatch

Asks TypeSafe's Jev model which subagent type OMP should spawn, instead of
leaving that choice to the parent agent.

The plugin picks the type and nothing else. OMP still decides `effort` and
still validates every spawn.

## Install

```bash
omp plugin install jev-dispatch@wows-omp-plugins
```

Restart the session afterwards so the extension can register.

Requires OMP 18.2.7 or newer.

The plugin needs a TypeSafe API key before it can route anything; see
[TypeSafe API key](#typesafe-api-key). It authenticates directly with TypeSafe
through OMP's native client, separately from the host's `judge` role and login
store.

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

## Settings

The installed package name used by `omp plugin config` is
`wows-omp-plugin-jev-dispatch`:

```bash
omp plugin config list wows-omp-plugin-jev-dispatch
omp plugin config set wows-omp-plugin-jev-dispatch integrationMode enhanced
omp plugin config set wows-omp-plugin-jev-dispatch minimumConfidence 0.8
omp plugin config set wows-omp-plugin-jev-dispatch apiKey "your-typesafe-api-key"
omp plugin config set wows-omp-plugin-jev-dispatch includeSharedContext false
```

| Setting | Type | Default | Effect |
| ------- | ---- | ------- | ------ |
| `integrationMode` | `standard` \| `enhanced` | `standard` | Selects task interception or API v2 lifecycle routing. Restart after changing it. |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Minimum native judgment confidence required to replace the requested type. |
| `includeSharedContext` | boolean | `true` | Includes shared task/subagent context in the routing request. |
| `apiKey` | secret string | unset | Manual TypeSafe API key, used only when `TYPESAFE_API_KEY` is absent or blank. |

OMP merges user settings with project overrides before the plugin reads them.

## TypeSafe API key

Get a key from the [TypeSafe console](https://console.typesafe.ai/). On every
invocation the plugin resolves credentials in this order:

1. A non-empty `TYPESAFE_API_KEY` environment variable.
2. The effective plugin `apiKey` setting (project settings override user settings).
3. Neither one: the plugin returns a configuration error and blocks that
   subagent creation. Installation and session startup do not require a key.

A whitespace-only value counts as absent. If the environment key is set but
rejected, the plugin does not fall back to the manual key. OMP login
credentials, OpenRouter keys, and the `judge` model chain are not credential
sources.

Prefer the environment variable, set before OMP starts:

```bash
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

You can also set `apiKey` in the plugin's settings panel or on the command line:

```bash
omp plugin config set wows-omp-plugin-jev-dispatch apiKey "your-typesafe-api-key"
```

The settings UI and CLI mask the value, but the underlying plugin configuration
is not encrypted. Do not commit keys or project overrides, and remember that
command-line values can stay in shell history. A manual key change applies on
the next invocation. The native client keeps its `TYPESAFE_BASE_URL` and
`TYPESAFE_DEFAULT_MODEL` overrides, with `jev-latest` as the default model;
only a Jev model is allowed.

## Privacy and fail-open behavior

A judgment carries the assignment, the optional shared context, the originally
requested agent, and short candidate descriptions with model and fallback
summaries. The conversation and system prompt are never sent. The plugin uses
OMP's native TypeSafe client and usage journal, and it does not modify the
process environment or the host's shared credentials. Neither request bodies
nor plugin logs contain the API key.

A route changes only when Jev returns a legal choice at or above the configured
confidence. Discovery failures, low confidence, illegal choices, rejected
credentials, and network errors all leave the original route in place. Missing
credentials are the one exception: they block the spawn in either mode.
Enhanced mode requires API v2 so that an explicit denial is not swallowed by
the older lifecycle's fail-open handling. Standard routing takes at most eight
seconds and keeps a one-second safety margin below the session's configured
tool-call handler timeout; with no useful budget left it does no routing. A
rewrite keeps every unrelated field, including `effort`.
