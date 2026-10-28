---
name: programming
description: "Use for Python, Rust, TypeScript/JavaScript or Go implementation when language-specific design, error handling, concurrency, toolchain references, or a requested new-project generator would help. Applies repository-first practices, not a mandatory style migration."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Programming: repository first

Read the repository's guidance, manifests, nearby implementation and relevant tests before choosing a recipe. Existing architecture, language versions, dependencies, formatters, package managers and established error contracts take precedence over this reference pack. Do not impose OXC on a Biome project, replace an HTTP client to match an example, or install packages on skill load.

## Progressive language routing

Read the matching index, then only references relevant to the change:

| Language | Start here | Additional routing |
| --- | --- | --- |
| Python | `references/python/README.md` | data models, errors, async/resources, project configuration or the chosen framework |
| Rust | `references/rust/README.md` | ownership, errors, concurrency, API design; read `references/rust-ub/README.md` for unsafe/FFI/raw pointers/custom synchronization and the relevant soundness recipe |
| TypeScript / JavaScript | `references/typescript/README.md` | typed boundaries, errors, current repository compiler/configuration, selected runtime/framework |
| Go | `references/go/README.md` | errors, contexts/goroutine shutdown, data models, existing module/framework |

The reference examples show optional stacks and stricter configurations for projects that explicitly choose them. A reference's “mandatory”, “never”, or “canonical” language does not override this repository-first scope. Library popularity and performance claims in this pinned snapshot are not current measurements: check installed versions and official documentation before relying on API syntax, availability or a migration recommendation.

## Design and implementation

- Reuse existing code or standard/platform facilities before adding a dependency or abstraction. Fix the actual contract at its boundary and migrate affected callers.
- Parse untrusted input at genuine trust boundaries. Preserve useful types inside the system; add branded/newtypes only when confusing units or identities is a concrete risk, not for every primitive.
- Represent errors so callers can distinguish expected cases; preserve causes and useful context. Honor the repository's exception/Result/error conventions rather than wrapping every operation.
- Match variants exhaustively where the language supports it. Use existing narrowing idioms when they already make the contract clear.
- Own cancellation, cleanup and resource lifetime. Pick structured concurrency facilities that fit the current runtime; do not replace asyncio, native fetch or a working standard-library client merely to enforce a preferred package.
- Treat file cohesion and parameter clarity as design questions. There is **no 250-LOC ceiling, three-argument gate, required SIZE_OK marker, or automatic refactor**. Extract only when a concrete maintenance benefit belongs in scope. `references/code-smells.md` provides review questions, not edit orders.
- Test externally observable behavior at the cheapest existing boundary where a plausible regression would otherwise survive. No prompt-prose substring tests or speculative robustness machinery.
- Run builds, tests, linters and formatters only when the assignment authorizes them. Use repository commands and report exactly what ran; do not introduce a post-write full-check loop or an unrelated console self-review requirement.

Use `skill://refactor` for a requested structural change, `skill://remove-ai-slops` for requested cleanup, `skill://frontend` for UI work, and `skill://review-work` for implementation handoff review.

## Requested new-project generators

Resolve scripts from the physical skill directory shown by the host, not the project cwd or a guessed installation cache. Generators are for an explicitly requested **new target project**, never “initialization” of an existing checkout. Inspect their chosen stack and effects before invocation. Each refuses an existing destination; supply the parent with `--path`.

| Helper | Invocation | Effects / prerequisites |
| --- | --- | --- |
| Python project | `uv run <skill-dir>/scripts/python/new-project.py demo --path /tmp` | `uv init`, project-local strict config and dev dependency declaration; prints `uv sync`, does not install the target's packages |
| Python script | `uv run <skill-dir>/scripts/python/new-script.py demo` | PEP 723 script; inspect `--help` for explicit output/dependency options |
| Rust project | `uv run <skill-dir>/scripts/rust/new-project.py demo --path /tmp` | locally installed Cargo, Rust >=1.85/edition 2024; creates source and strict lint configs, no dependency install or rustup-triggering toolchain file |
| TypeScript project | `bun <skill-dir>/scripts/typescript/new-project.ts demo --path /tmp` | writes Bun/Hono/Zod project, TypeScript 5.8+ config, complete OXC local plugin/config/license; prints install/check commands, does not run them |
| Go project | `uv run <skill-dir>/scripts/go/new-project.py demo --path /tmp --module example.com/demo` | runs local `go mod init`, writes source/config/CI/templates; prints the project dependency and check commands, does not fetch them |

Python helpers use isolated uv environments with PEP 723 `typer`/`rich` dependencies; first use can download packages. Generated dependencies belong only to the requested target, not the plugin. Keep the copied skill tree read-only. No global installs: managed eval, uv, project-local installs, or explicitly invoked temporary/user-cache provisioning only. A toolchain install/upgrade still requires separate consent.

## Optional policy checkers

These checkers implement an **opt-in stricter policy**, not the compiler's definition of valid code. Their findings are review input unless the user/project adopts that policy. Do not run them automatically or refactor to appease them without an actual obligation.

- Python: `python3 -B <skill-dir>/scripts/python/check-no-excuse-rules.py <paths...>` (stdlib AST).
- Rust: `bash <skill-dir>/scripts/rust/check-no-excuse-rules.sh <paths...>` (shell text checks).
- Go: `bash <skill-dir>/scripts/go/check-no-excuse-rules.sh <paths...>` (shell text checks).
- TypeScript: from the **target project's cwd**, `bun <skill-dir>/scripts/typescript/check-no-excuse-rules.mjs <paths...>`. This standalone helper resolves the caller's installed `typescript` stable compiler API (5.8+), never packages from the skill cache. The scaffold and checker therefore use the same compiler family; there is no TypeScript 7 unstable-API requirement or implicit compiler upgrade. Exit 0 = clean, 1 = policy findings, 2 = missing/incompatible compiler or invalid input. It is a syntax-policy pass, not a substitute for `tsc`/LSP or semantic tests.

Additional recipes: `references/logging.md`, `references/code-smells.md`. Preserve the MIT license at `scripts/typescript/oxc/lint/oxlint-plugin/LICENSE` when generating or redistributing that plugin.
