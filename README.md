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

Each plugin has its own README covering installation, settings, and behavior.

| Plugin | Description | Documentation |
| ------ | ----------- | ------------- |
| `audit-goal` | Runs `/audit`: a goal-driven loop of independent audits and fixes with a round ledger | [Documentation](plugins/audit-goal/README.md) |
| `judge-dispatch` | Routes subagent types through OMP judge-role judgments | [Documentation](plugins/judge-dispatch/README.md) |
| `omo-prometheus` | Ports oh-my-openagent Prometheus planning and Atlas orchestration to OMP | [Documentation](plugins/omo-prometheus/README.md) |
| `omo-ultrawork` | Ports ultrawork mode, mass-ulw, hyperplan, and ulw-research to OMP | [Documentation](plugins/omo-ultrawork/README.md) |
| `omo-toolkit` | Ports category and reviewer agents, skills, and documentation MCPs to OMP | [Documentation](plugins/omo-toolkit/README.md) |

## Repository layout

```
.omp-plugin/marketplace.json   catalog listing every published plugin
plugins/<name>/                one directory per plugin, with its own README
src/                           repo tooling and tests
```

Marketplace installation copies a plugin directory to the user's machine and
installs nothing else, so each plugin is self-contained, dependency-free, and
carries its own documentation.

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

Repository-original code and content are MIT unless a plugin says otherwise.
The three `omo-*` plugins carry modified OmO prompt assets under Sustainable
Use License 1.0; see their linked README files and license notes.
