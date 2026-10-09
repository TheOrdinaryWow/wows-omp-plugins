# Contributing

This repository is an omp plugin marketplace. Each plugin is a plain directory under `plugins/`, and `.omp-plugin/marketplace.json` lists what ships.

```text
.omp-plugin/marketplace.json   catalog listing every published plugin
plugins/<name>/                one directory per plugin, copied as is to the user's machine
src/                           repository tooling and tests, never shipped
REFERENCE.md                   plugin-state snapshot envelope shared by several plugins
```

Installing a plugin copies its directory and nothing else. A plugin therefore cannot declare runtime dependencies or import code from outside its own directory.

## Setup and checks

```bash
bun install

bun run check          # Biome lint + format check
bun run check-types    # tsc
bun run check-catalog  # catalog matches plugins/
bun run test           # test suite
```

To try your working tree in OMP, run `bun run dev:plugins [name…]` and restart the session. It installs the plugins from a local copy at project scope, so other directories keep the released versions. `bun run dev:plugins --remove` undoes it.

## Documentation

Each plugin's `README.md` covers installing, using and configuring it. Snapshot schemas, event contracts, storage formats and other internals go in a `REFERENCE.md` next to it. Both have a `.zh.md` counterpart with the same sections; the English file is the source.

## Commits and releases

Commits follow Conventional Commits. release-please bumps a plugin's version from `feat` and `fix` commits that touch `plugins/<name>/`, so never edit versions by hand.

[AGENTS.md](AGENTS.md) has the full rules: adding a plugin, host compatibility, persisted state, and local testing details.
