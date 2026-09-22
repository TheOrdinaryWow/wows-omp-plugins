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

Authenticate a native Jev route through OMP (for example, `/login typesafe` or
`TYPESAFE_API_KEY`) and configure OMP's `judge` role as desired. If no native
TypeSafe/Jev candidate can answer, the plugin leaves the requested type alone.

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
cannot observe the host's final spawn preflight, it routes only when both the
matching live session and its exact persisted spawn allowlist are available.
If either cannot be proven, it sends no judgment and preserves the call. Its
candidate inventory is intentionally partial, and the task tool remains
authoritative.

Enhanced mode subscribes to OMP subagent routing API v1. The host supplies the
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
omp plugin config set wows-omp-plugin-jev-dispatch includeSharedContext false
```

| Setting | Type | Default | Effect |
| ------- | ---- | ------- | ------ |
| `integrationMode` | `standard` \| `enhanced` | `standard` | Selects task interception or API v1 lifecycle routing. Restart after changing it. |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Minimum native judgment confidence required to replace the requested type. |
| `includeSharedContext` | boolean | `true` | Includes shared task/subagent context in the routing request. |

OMP merges user settings with project overrides before the plugin reads them.

#### Privacy and fail-open behavior

Each judgment receives only the assignment, optional shared context, originally
requested agent, and compact candidate descriptions plus model/fallback
summaries. The plugin never sends the conversation or system prompt. It uses
OMP's `resolveJudge`, model registry, scoped settings, credential handling, and
usage journal rather than storing TypeSafe credentials itself.

Only a legal choice returned by a native TypeSafe/Jev transport at or above the
configured confidence can change a route. Non-native and native non-Jev judge
candidates are rejected before invocation, so the routing payload is never sent
to them. Invalid configuration, discovery failures, low confidence, illegal
choices, and judge/network errors all preserve the original route. Standard
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
