# wows-omp-plugins

A personal [omp](https://omp.sh) marketplace.

## Usage

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin discover wows-omp-plugins
omp plugin install <name>@wows-omp-plugins
```

Inside a session, the same operations are available as `/marketplace add`,
`/marketplace discover`, and `/marketplace install`.

Installs are user-scoped by default. Add `--scope project` to limit a plugin to
the current project. After installing, run `/reload-plugins` to pick up skills
and slash commands; restart the session for new tools, hooks, or extensions.

To update later:

```bash
omp plugin marketplace update wows-omp-plugins
omp plugin upgrade <name>@wows-omp-plugins
```

## Plugins

| Plugin | Description |
| ------ | ----------- |
| [`jev-dispatch`](plugins/jev-dispatch/) | Routes subagent types through OMP's native TypeSafe/Jev judgment chain |

### jev-dispatch

Install the plugin, then restart the session so its extension can register:

```bash
omp plugin install jev-dispatch@wows-omp-plugins
```

Configure a TypeSafe API key using `TYPESAFE_API_KEY` or the plugin's `apiKey`
setting (see below). The plugin authenticates directly with TypeSafe using
OMP's native client, independently of the host's `judge` role and login store.

`jev-dispatch` chooses only the subagent **type**. It never changes `effort`;
OMP remains responsible for effort and all final spawn validation.

#### Modes and coverage

| Invocation | `standard` (default) | `enhanced` |
| ---------- | -------------------- | ---------- |
| `task` flat calls | Yes, when the session spawn policy is known | Yes |
| `task` batch calls | Yes, each item independently, when policy is known | Yes |
| `eval.agent()` | No | Yes |
| `workpool()` agent creation | No | Yes |

At `session_start`, the plugin reads effective settings for that session's cwd
and registers exactly one routing surface. Standard sessions never register the
enhanced lifecycle handler. Restart the session after changing modes.

Standard mode rewrites `agent` fields in ordinary `task` tool calls. Because it
cannot observe the host's final spawn preflight, its legal candidate set is
taken from the live `task` tool's own rendered agent list, which OMP already
filtered by the session's spawn policy and disabled agents. When that list
cannot be read, the plugin sends no judgment and preserves the call; it never
treats an unknown policy as unrestricted. The task tool remains authoritative
and revalidates any rewritten name.

Enhanced mode subscribes to OMP subagent routing API v2. The host supplies the
already-filtered candidate set immediately before allocation, so the same route
covers `task`, `eval.agent()`, and `workpool()`. The plugin detects this API
structurally. If enhanced mode is requested on an older host, that session
falls back to standard mode and shows one warning on its first `task` call; it
never patches the host.

#### Settings

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

#### TypeSafe API key

Get a key from the [TypeSafe console](https://console.typesafe.ai/). The plugin
resolves credentials on each invocation in this order:

1. A non-empty `TYPESAFE_API_KEY` environment variable.
2. The effective plugin `apiKey` setting (project settings override user settings).
3. If neither exists, return an explicit configuration error and **block that
   subagent creation**. Installation and session startup do not require a key.

Whitespace-only values count as absent. A configured but rejected environment
key never falls back to the manual key. OMP login credentials, OpenRouter keys,
and the `judge` model chain are not additional credential sources.

Prefer supplying the environment variable before starting OMP:

```bash
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

Alternatively, set `apiKey` in the plugin's settings panel, or use:

```bash
omp plugin config set wows-omp-plugin-jev-dispatch apiKey "your-typesafe-api-key"
```

The settings UI and CLI mask this value, but the underlying plugin configuration
is not encrypted. Do not commit keys or project overrides; command-line values
can also remain in shell history. Manual key changes apply on the next invocation.
The native client retains its `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL`
overrides; the default model is `jev-latest`. Only a Jev model is permitted.

#### Privacy and fail-open behavior

Each judgment receives only the assignment, optional shared context, originally
requested agent, and compact candidate descriptions plus model/fallback
summaries. The plugin never sends the conversation or system prompt. It uses
OMP's native TypeSafe client and usage journal without modifying the process
environment or the host's shared credentials. Request bodies and plugin logs
do not include the API key.

Only a legal choice returned by Jev at or above the configured confidence can
change a route. Missing credentials are the deliberate exception to fail-open:
they block the spawn in either mode. Discovery failures, low confidence, illegal
choices, rejected credentials, and network errors preserve the original route.
API v2 is required in enhanced mode so explicit denials are not swallowed by
the older lifecycle's fail-open handling. Standard
routing uses at most eight seconds and always keeps a one-second safety margin
below the session's configured tool-call handler timeout; if that leaves no
useful budget, it performs no routing. Rewrites retain every unrelated field,
including `effort`.

## Repository layout

```
.omp-plugin/marketplace.json   catalog listing every published plugin
plugins/<name>/                one directory per plugin
src/                           repo tooling and tests
```

Each plugin is self-contained and dependency-free: marketplace installation
copies the directory to the user's machine without installing anything, so a
plugin ships exactly what it needs.

## Development

```bash
bun install

bun run check          # Biome lint + format check
bun run check-types    # tsc
bun run check-catalog  # catalog vs. plugins/ drift check
```

See [AGENTS.md](AGENTS.md) for the plugin authoring rules, the constraints
marketplace installation imposes, and how to test a plugin locally before
publishing.

## License

MIT
