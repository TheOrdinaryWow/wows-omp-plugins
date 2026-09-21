# demo

Placeholder plugin for the `wows-omp-plugins` marketplace. It exists so the
catalog has a working entry and so every surface a real plugin may use is
present as a reference.

```
demo/
  .omp-plugin/plugin.json   plugin manifest (name, version, metadata)
  package.json              version + `omp.extensions` entry + `#src/*` subpath imports
  skills/demo/SKILL.md      skill
  commands/demo.md          slash command
  src/index.ts              extension: registers /demo-hello and demo_word_count
  src/constants.ts          imported as `#src/constants.ts`
```

## Install

```
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install demo@wows-omp-plugins
```

## Notes

- Imports inside `src/` use the package's own `imports` map (`#src/*`), which is
  resolved from `package.json` and therefore still works after the plugin is
  copied to a user's machine. Do not use the repo-level `@/*` tsconfig alias
  here — it does not travel with the installed plugin. Node forbids `#/*` as an
  imports key, so the alias needs a name segment after `#`.
- The plugin declares no runtime `dependencies`. Marketplace installation copies
  the directory and symlinks it; it never runs `bun install` for the plugin, so
  third-party imports would fail on the user's machine.
