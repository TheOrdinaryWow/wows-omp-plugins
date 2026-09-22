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
| [`demo`](plugins/demo/) | Placeholder plugin that exercises every plugin surface this marketplace uses |

## Repository layout

```
.omp-plugin/marketplace.json   catalog listing every published plugin
plugins/<name>/                one directory per plugin
src/                           repo tooling (catalog validation)
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
