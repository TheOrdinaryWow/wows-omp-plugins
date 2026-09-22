# AGENTS.md

High-signal notes for working in this repo.

Official omp mechanics — commands, catalog schema, loader behavior — live in the
bundled docs (`omp://marketplace.md`, `omp://skills/authoring-marketplaces.md`,
`omp://extension-loading.md`) and move with each release. Look them up there.
This file records only what those docs cannot: decisions specific to this repo,
and behavior verified by hand in it.

## What this repo actually is

An **omp marketplace**, not an application. It is a Git repository whose catalog
at [.omp-plugin/marketplace.json](file:///./.omp-plugin/marketplace.json) lists
plugins that users install with `omp plugin install <name>@wows-omp-plugins`.

It is deliberately **not** a monorepo: no workspaces, no shared runtime package.
Plugins are plain directories under [plugins/](file:///./plugins/). The catalog
and the directory layout are the only coupling between them.

```
.omp-plugin/marketplace.json   the catalog — source of truth for what ships
plugins/<name>/                one plugin, copied verbatim to the user's machine
src/                           repo tooling and tests; never shipped to users
```

## Commands

| Want to                       | Run                    |
| ----------------------------- | ---------------------- |
| Install dev dependencies      | `bun install`          |
| Lint + format check           | `bun run check`        |
| Lint + format, writing fixes  | `bun run check:fix`    |
| Type check                    | `bun run check-types`  |
| Verify catalog matches `plugins/` | `bun run check-catalog` |

## The constraint that governs everything

Marketplace installation **copies the plugin directory and symlinks it** into
`~/.omp/plugins/node_modules/` (or the project plugin root). It never runs
`bun install` for the plugin. Consequences, all load-bearing:

- A plugin **must not declare runtime `dependencies`**. Bare imports of
  third-party packages will fail on the user's machine. Only `@oh-my-pi/*` host
  packages resolve, and only because the loader rewrites them.
- A plugin **must not rely on the repo-level `@/*` tsconfig alias**. `tsconfig.json`
  stays here; the copied plugin never sees it.
- Cross-plugin shared code is a trap for the same reason. Duplicate it, or accept
  that a workspace symlink only exists on this machine.

Inside a plugin, alias imports go through its own `package.json` `imports` map,
which travels with the copy:

```json
"imports": { "#src/*": "./src/*" }
```

Node rejects keys that are exactly `#` or start with `#/`, so the alias needs a
name segment — `#src/*`, not `#/*`.

## Path aliases

- `@/*` → `./src/*` — repo tooling only (`src/check-catalog.ts` etc.)
- `#src/*` → `./src/*` — inside each plugin, declared per plugin

## Adding a plugin

1. Create `plugins/<name>/` (lowercase, digits, hyphens, dots; must start and
   end alphanumeric; max 64 chars).
2. Add `.omp-plugin/plugin.json` and `package.json`. Keep the versions in both
   equal to the catalog entry — `bun run check-catalog` fails on drift.
3. Add content in the conventional directories: `skills/<name>/SKILL.md`,
   `commands/*.md`, `agents/*.md`, `hooks/pre|post/`, `tools/`, `.mcp.json`.
4. Declare a TypeScript extension entry in `package.json` under `omp.extensions`.
5. Add the entry to [.omp-plugin/marketplace.json](file:///./.omp-plugin/marketplace.json)
   with `"source": "./<name>"` — `metadata.pluginRoot` already prepends `./plugins`.
6. Run `bun run check-catalog && bun run check-types && bun run check`.

[plugins/jev-dispatch/](file:///./plugins/jev-dispatch/) is the current example
of a dependency-free extension package with manifest-backed settings.

## Extension authoring gotcha

`registerTool` infers `Static<TParams>` as `unknown` for schemas built with the
injected `pi.zod` builder. Declare the schema separately and annotate `execute`:

```ts
const parameters = z.object({ text: z.string().describe("Text to count") });

pi.registerTool({
  // ...
  parameters,
  async execute(_id, params: typeof parameters.infer) { /* ... */ },
});
```

`pi.typebox.Type.Object(...)` infers without the annotation if you prefer it.

`jev-dispatch` intentionally compiles against the marketplace's current omp
version while feature-detecting a newer lifecycle event. Keep that event's
typing structural inside the plugin; do not raise the repository's minimum omp
version merely to acquire the event overload.

## Testing a plugin locally

`omp://marketplace.md` has the current install/uninstall commands. What it will
not tell you, and what makes local testing actually catch bugs:

- Install with `--scope project`. State goes to `<repo>/.omp/`, which is
  gitignored and disposable; user scope leaves residue on the machine.
- Installation caches a **copy** under `~/.omp/plugins/cache/plugins/`.
  Reinstall with `--force` after every edit and verify against the cached path,
  never the source tree. Failures that only appear once the plugin has left this
  repo — an invalid `imports` key, a stray runtime dependency — are invisible
  from here. That is how the `#/*` breakage above was found.
- Clean up when done: uninstall, remove the marketplace registration, delete
  `<repo>/.omp/`.

## Linter / formatter (Biome only)

[biome.json](file:///./biome.json): line width **140**, 2-space indent, LF,
double quotes, semicolons always, trailing commas everywhere except JSON.
Import organization is on, grouped bun/node → packages → alias → relative.

## Catalog details worth knowing

- omp reads `.omp-plugin/marketplace.json` first and falls back to
  `.claude-plugin/marketplace.json`. This repo publishes only the former —
  it does not target Claude Code.
- `metadata.pluginRoot` is `./plugins`, so catalog `source` values are relative
  to that (`"./jev-dispatch"`, not `"./plugins/jev-dispatch"`).
- `bun run check-catalog` catches the common drift cases (unlisted directory,
  version mismatch between catalog and manifests, bad `source`) before a user
  hits them.
