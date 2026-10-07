# wows-omp-plugins

English | [简体中文](README.zh.md)

A personal [omp](https://omp.sh) plugin marketplace.

Requires OMP 18.3.5 or newer.

## Usage

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin discover wows-omp-plugins
omp plugin install <name>@wows-omp-plugins
```

In a session, use `/marketplace add`, `/marketplace discover`, and `/marketplace install` instead.

Plugins install for the current user unless you pass `--scope project`. After installing, run `/reload-plugins` to load new skills and slash commands. New tools, hooks, and extensions need a session restart.

To update:

```bash
omp plugin marketplace update wows-omp-plugins
omp plugin upgrade <name>@wows-omp-plugins
```

## Plugins

| Plugin | Description | Documentation |
| --- | --- | --- |
| `audit-goal` | `/audit`: repeated independent audits and fixes, with a round ledger | [README](plugins/audit-goal/README.md) |
| `judge-dispatch` | Lets OMP's judge role pick the subagent type, thinking effort, and model for `task` calls | [README](plugins/judge-dispatch/README.md) |
| `omp-herdr-dag` | Live todo, plan, Atlas DAG and subagent views in a Herdr side pane | [README](plugins/omp-herdr-dag/README.md) |
| `omo-prometheus` | oh-my-openagent's Prometheus planning and Atlas execution, ported to OMP | [README](plugins/omo-prometheus/README.md) |
| `omo-ultrawork` | Ultrawork mode, mass-ulw, `/hyperplan`, and `/ulw-research` | [README](plugins/omo-ultrawork/README.md) |
| `omo-toolkit` | Category and research agents, skills, and documentation MCP servers | [README](plugins/omo-toolkit/README.md) |
| `roadmap` | Tool-managed project rounds, stages, TODOs and MADR architecture decisions | [README](plugins/roadmap/README.md) |

## Clients without a terminal UI

The plugins also run under `omp --mode rpc`, `rpc-ui`, ACP editors, the SDK, and headless runs. Terminal-only views fall back to plain dialogs, and every interactive action also has a command form. Each plugin's README covers its own fallbacks.

Plugins that hold workflow state also write a JSON snapshot of that state for client programs, at `<runtime dir>/plugin-state/<session id>/<plugin>.json`. The runtime dir is `$XDG_RUNTIME_DIR/wows-omp-plugins`, or `<os tmpdir>/wows-omp-plugins-<uid>` when `XDG_RUNTIME_DIR` is unset. It is private to the current user and lies outside the project and the host session store, so snapshots do not survive a reboot. Each file is replaced atomically on every change and wrapped in the same envelope:

```json
{ "schema": "wows-omp-plugins/plugin-state", "version": 1, "plugin": "audit-goal", "sessionId": "…", "seq": 12, "updatedAt": "…", "state": { "kind": "audit-goal/audit", "version": 1 } }
```

Take the session id from RPC `get_state` (`sessionId`); in-memory sessions (`--no-session`) publish too. When `state` is `null`, the plugin has nothing active in that session. Each plugin README describes its own `state` payload.

## Repository layout

```
.omp-plugin/marketplace.json   catalog listing every published plugin
plugins/<name>/                one directory per plugin, with its own README
src/                           repo tooling and tests
```

Installing a plugin copies its directory and nothing else, so every plugin is self-contained and has no runtime dependencies.

## Development

```bash
bun install

bun run check          # Biome lint + format check
bun run check-types    # tsc
bun run check-catalog  # catalog vs. plugins/ drift check
```

[AGENTS.md](AGENTS.md) covers plugin authoring rules, installation constraints, and local testing.

## License

Code and content written for this repository are MIT unless a plugin says otherwise. The three `omo-*` plugins include modified OmO prompt assets under the Sustainable Use License 1.0; see each plugin's README and license files.
