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
| Run tests                     | `bun run test`         |

## CI and releases

- `.github/workflows/ci.yml` runs lint, the catalog check, type check, and tests
  on every push and PR. Types and tests run twice: against the omp version in
  `bun.lock` and against 18.2.7, the oldest host `judge-dispatch` supports. Raise
  that matrix entry only together with the documented floor.
- `.github/workflows/release.yml` runs release-please on `main`. Versions come
  from Conventional Commits scoped by path: a `feat`/`fix` touching
  `plugins/<name>/` bumps that plugin only. The release PR updates the plugin's
  `package.json`, `.omp-plugin/plugin.json`, its catalog entry, and its
  `CHANGELOG.md` together, so never bump versions by hand. Merging the PR tags
  `<name>@<version>` and publishes a GitHub Release.
- The release PR is pushed with `GITHUB_TOKEN`, which triggers no workflows, so
  `release.yml` calls `ci.yml` on the PR branch itself. Check that run in
  Actions before merging; the PR shows no status checks.
- Plugin JSON manifests and `.release-please-manifest.json` are formatted with
  expanded arrays (`biome.json` override) because release-please rewrites them
  that way.

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
   equal to the catalog entry — `bun run check-catalog` fails on drift. Start at
   `0.1.0`.
3. Add content in the conventional directories: `skills/<name>/SKILL.md`,
   `commands/*.md`, `agents/*.md`, `hooks/pre|post/`, `tools/`, `.mcp.json`.
4. Declare a TypeScript extension entry in `package.json` under `omp.extensions`.
5. Write `plugins/<name>/README.md`. It owns that plugin's install steps,
   settings, and behavior; the root README only indexes plugins and links to it.
   The file ships with the plugin, so write it for the installing user.
6. Add the entry to [.omp-plugin/marketplace.json](file:///./.omp-plugin/marketplace.json)
   with `"source": "./<name>"` — `metadata.pluginRoot` already prepends `./plugins`.
7. Add a row to the root README plugin table pointing at the new plugin README.
8. Register the plugin with release-please: a `packages` entry in
   `release-please-config.json` (copy an existing one; its extra-files keep
   `plugin.json` and the catalog entry in step) and its version in
   `.release-please-manifest.json`.
9. Run `bun run check-catalog && bun run check-types && bun run check`.

[plugins/judge-dispatch/](file:///./plugins/judge-dispatch/) is the current example
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

`judge-dispatch` intentionally compiles against the marketplace's current omp
version while feature-detecting a newer lifecycle event. Keep that event's
typing structural inside the plugin; do not raise the repository's minimum omp
version merely to acquire the event overload.

It also derives its legal agent set from the live `task` tool description and
bootstraps per session through `session_start` (never `process.cwd()`), because
plugin settings are project-scoped and several sessions can share one process.

Its runtime floor is omp 18.2.7, older than the dev dependency it compiles
against. Host APIs that changed shape since then go through feature detection,
as `src/host-settings.ts` does for `Settings.get` versus the setting registry.
Before relying on a new host API, type-check a throwaway copy against 18.2.7
(`bun add -d @oh-my-pi/pi-coding-agent@18.2.7`) and keep a fallback.

Judging goes through OMP's `judge` role (`resolveJudge`); the plugin keeps no
credentials or provider settings of its own. It judges only when the chain's
first usable candidate is native (a judgment API, calibrated confidence), never
calls a chat-model fallback, and fails open everywhere: a missing native judge
keeps the requested agent and warns once per session.

## Testing a plugin locally

Two marketplaces, one per purpose:

|Name|Source|Scope|Use|
|---|---|---|---|
|`wows-omp-plugins`|`TheOrdinaryWow/wows-omp-plugins` (GitHub)|user|released versions, same as any installing user|
|`wows-omp-plugins-dev`|`.omp/dev-marketplace/` (local copy)|project|this working tree|

Never register the release marketplace from a local path: `omp plugin upgrade`
then reads the local catalog, which lags GitHub until you pull, and ships
unreleased edits as if they were released.

`bun run dev:plugins [name…]` copies `plugins/` and the catalog into
`.omp/dev-marketplace/`, registers or refreshes `wows-omp-plugins-dev`, and
force-reinstalls the plugins at project scope. Rerun it after every edit and
restart the session. `bun run dev:plugins --remove` uninstalls them and drops the
dev marketplace. Facts behind this design, verified on omp 18.3.5:

- omp rejects plugin sources that resolve outside the marketplace root, so the
  dev marketplace must be a real copy; a symlink to `plugins/` fails to install.
- Two installs sharing a runtime package name cannot live in the same scope.
  Project scope avoids the clash, and an enabled project install shadows the
  user install, so sessions in this repo run the dev copy while every other
  directory keeps the released one.
- Installation caches another copy under `~/.omp/plugins/cache/plugins/`.
  Verify against that cached path, never the source tree. Failures that only
  appear once the plugin has left this repo — an invalid `imports` key, a stray
  runtime dependency — are invisible from here. That is how the `#/*` breakage
  above was found.
- `omp plugin link` is not a substitute: it registers an npm-style plugin at
  user scope, overriding the release install everywhere.

## Linter / formatter (Biome only)

[biome.json](file:///./biome.json): line width **140**, 2-space indent, LF,
double quotes, semicolons always, trailing commas everywhere except JSON.
Import organization is on, grouped bun/node → packages → alias → relative.

## Catalog details worth knowing

- omp reads `.omp-plugin/marketplace.json` first and falls back to
  `.claude-plugin/marketplace.json`. This repo publishes only the former —
  it does not target Claude Code.
- `metadata.pluginRoot` is `./plugins`, so catalog `source` values are relative
  to that (`"./judge-dispatch"`, not `"./plugins/judge-dispatch"`).
- `bun run check-catalog` catches the common drift cases (unlisted directory,
  version mismatch between catalog and manifests, bad `source`) before a user
  hits them.
