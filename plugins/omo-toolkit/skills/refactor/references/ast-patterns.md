> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent ast-grep/refactor material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# AST pattern pitfalls and preview

Use native `ast_grep` for discovery and native `ast_edit` for structural rewrites. Read each device's live schema before invocation. Symbol references/renames belong to `lsp`, not to a structural or text replacement.

## Patterns are code, not regular expressions

- The pattern must parse in the target language and match **whole nodes**. `$NAME` cannot match an identifier substring such as `prefix$NAME`.
- `$NAME` captures one node; `$_` matches one unbound node; `$$$` matches zero or more nodes; `$$$ARGS` captures that list. Names use uppercase letters, digits and underscores; use `$$$ARGS`, not `$$ARGS` or `$lower`.
- Repeating a metavariable requires equal captured code: `$X === $X` matches `a === a`, not `a === b`.
- Multi-node `$$$` matches are **lazy**, not a regex-style search of every possible split. `foo($$$A, b, $$$C)` on `foo(a, c, b, b, c)` binds `A` to `a, c` and `C` to `b, c`. Add structural constraints if a different split is intended.
- Include the complete syntactic node. For TypeScript use `function $NAME($$$ARGS) { $$$BODY }`, not `function $NAME`. Account for annotations and modifiers present in real code, such as `async function $NAME($$$ARGS): $_ { $$$BODY }`; test representative variants before rewriting.
- A field or pair may not parse by itself. Use a valid enclosing context plus the node selector when the discovery tool supports it, or match a complete enclosing node in the native editor. Do not transplant another tool's YAML/CLI options into its schema.
- A rewrite must parse as a single node; native substitutions are 1:1 and cannot arbitrarily split or merge captured nodes. Use a targeted manual edit for an exceptional one-off rather than broadening the pattern until it hits unrelated code.

## Review before apply

1. Search in the exact language and owned file scope. Inspect captures, including negative/control examples and typed, async or multiline forms actually used by the repository.
2. Stage the transformation with native `ast_edit`. For example, after confirming the call's behavior and scope:

   ```json
   {"ops":[{"pat":"legacy($$$ARGS)","out":"current($$$ARGS)"}],"paths":["src/owned.ts"]}
   ```

3. Inspect the proposed matches and diff. The native editor **stages**, rather than immediately applies, changes; accept the reviewed proposal through `xd://resolve`, or discard it through `xd://reject`, using the live device contract.
4. Parse failures, unexpected captures, zero matches or an unexpected match count require refining the pattern, not claiming completion. Never apply a broad rewrite to discover what it would do.
5. After a coherent change, run only the assignment-authorized checks and compare relevant diagnostics with the baseline. Do not add new dependencies or install the upstream Python AST helper; this skill ships no such helper.

Text-shaped questions (URLs, license headers, comments) belong to `grep`. Structural code questions belong to the AST tools; project-aware symbol identity belongs to `lsp`.

Source syntax reference: [ast-grep pattern syntax](https://ast-grep.github.io/guide/pattern-syntax.html).
