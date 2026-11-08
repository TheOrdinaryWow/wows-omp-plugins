> **Modified-port notice and license.** This file adapts oh-my-openagent lsp-setup methodology at revision `adddd17004076e799c2de18ccfdee29e12525ace` to OMP. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Native LSP troubleshooting

Use this when native diagnostics/navigation/refactoring reports no server, a startup failure, or an unanswered request. The method is detect → establish prerequisites → configure only if needed → verify a real roundtrip. **Upstream Codex, OpenCode and Senpi configuration paths, server tables and JSON schemas are not OMP configuration contracts.** Do not copy them into this repository.

## 1. Detect the actual failure

Read the repository's guidance, manifest and compiler configuration. Identify the language, project/workspace root and a real source file with a known symbol. Read `xd://lsp` for its current schema, then use native `status` and `capabilities` for that file. Distinguish an absent executable, invalid project configuration, indexing delay, unsupported operation and genuine source diagnostics; do not treat every empty response as a missing installation.

```json
{"action":"status","file":"src/owned.ts"}
```

Record the server and exact error. A configured but not-yet-started server is not inherently broken: a real language request starts it. Use the tool's bounded timeout for cold indexing rather than a sleep/poll loop.

## 2. Establish prerequisites

Check the required installed executable and project dependency using the active host's diagnostics and current official server documentation. An executable on PATH is only a prerequisite, not proof the server answers. Preserve the project's existing TypeScript/Python/Rust/Go versions and package manager; do not install a different toolchain merely to satisfy a sample.

If provisioning is authorized, use a project-local, temporary or explicitly requested user-cache location. Global installation or a toolchain upgrade requires separate consent. Loading this reference is not permission to install anything.

## 3. Configure only when necessary

If native discovery already works, add no configuration. If an override is actually required, inspect the **installed OMP version's** configuration guidance and active project/user settings, then change only the relevant server selection, command or initialization option. Do not invent a settings path, import a foreign harness table, or write guessed environment/extension/priority keys. Prefer the repository's existing convention when valid for the installed host.

After an authorized configuration change, native `reload` for the file restarts its server; `reload` with `file: "*"` re-reads the full configuration. Avoid a workspace-wide restart when a single-server reload suffices.

## 4. Prove the native roundtrip

With assignment authorization for diagnostics/checks, request diagnostics on the real source file, then a definition, references or hover lookup for its known symbol:

```json
{"action":"diagnostics","file":"src/owned.ts"}
```

```json
{"action":"definition","file":"src/owned.ts","line":12,"symbol":"KnownSymbol"}
```

Use the actual file/line/symbol, not those illustrative values. Confirm the returned source location/type belongs to the expected project. An answered request with code errors proves connectivity, not a clean type check; zero diagnostics alone is not an end-to-end application pass. Compare diagnostics with the relevant pre-existing baseline.

If the server still cannot answer, report the exact operation, file/root, startup/error details and missing prerequisite. Do not present grep results as language-server references or claim LSP verification from `command -v` alone. A worker sends unresolved configuration/installation decisions to its parent.
