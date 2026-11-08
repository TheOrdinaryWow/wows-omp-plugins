---
name: programming
description: "Use for Python, Rust, TypeScript/JavaScript or Go implementation and requested new-project generators. Also use when writing, reshaping, reviewing or deleting tests: observable contracts, retention rules and junk-test evidence live here. Repository-first practices, not a mandatory style migration."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

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
| Tests in any language | `references/testing/README.md` and `references/testing/junk-classes.md` | authoring gate, retention bar, R/F/C/D classification and candidate/keeper evidence |

The reference examples show optional stacks and stricter configurations for projects that explicitly choose them. A reference's “mandatory”, “never”, or “canonical” language does not override this repository-first scope. Library popularity and performance claims in this pinned snapshot are not current measurements: check installed versions and official documentation before relying on API syntax, availability or a migration recommendation.

## Design and implementation

- Stop at the first adequate solution: no new code, existing repository code, standard library, native platform facility, installed dependency, then the minimum new implementation. Trace the real flow first; a small symptom patch that leaves sibling callers broken is not a complete fix.
- Parse untrusted input at genuine trust boundaries. Preserve useful types inside the system; add branded/newtypes when confusing units or identities is a concrete risk, not for every primitive.
- Represent errors so callers can distinguish expected cases; preserve causes and useful context. Honor existing exception/Result/error conventions rather than wrapping every operation.
- Match variants exhaustively where the language supports it. Use existing narrowing idioms when they already make the contract clear.
- Own cancellation, cleanup and resource lifetime. Pick structured concurrency facilities that fit the runtime; do not replace asyncio, native fetch or a working standard-library client merely to enforce a preferred package.
- Treat file cohesion and parameter clarity as design questions. There is **no 250-LOC ceiling, three-argument gate, required SIZE_OK marker, or automatic refactor**. Extract only for a concrete, in-scope maintenance benefit. `references/code-smells.md` provides review questions, not edit orders.
- Read `references/logging.md` when changing logging or error-boundary observability. Use the project's designated logger; a project that deliberately does not log does not get logging uninvited.
- Run builds, tests, linters, formatters, smoke runs and audits only when the assignment authorizes them. Use repository commands and report exactly what ran; no automatic post-write full-check loop or console self-review ritual applies.

Use `skill://refactor` for requested structural changes, `skill://remove-ai-slops` for requested cleanup, `skill://frontend` for UI work, and `skill://review-work` for implementation handoff review.

## Test authoring and retention

Before adding a test, answer: **what observable contract**, **what credible regression**, **why existing coverage misses it**, and **whether it needs a production seam no real caller needs**. Prefer the existing owner test at the strongest boundary; extend a table or fixture before adding a parallel declaration. Add coverage only where the repository keeps tests for that behavior and a regression would otherwise survive.

Protect API/protocol/configuration, migration/storage, security, platform, generated/cross-language, install-payload, raw shipped-copy equality, issue-regression and machine-consumed-text contracts. Prose wording, headings, source-substring pins and test-only exports are not behavioral coverage. Host-rendered prompt text is not a byte channel: compare raw artifacts only when raw equality is the actual contract.

A baseline-red test is a product finding, never deletion evidence or an excuse to edit an assertion green. A scanner finding is only a candidate. For a behavior-bearing test cut, inventory **every distinct obligation** and name the retained keeper for each; candidate/keeper mutation evidence concerns one exercised behavior, not the whole declaration. Infrastructure, setup, import/compile, crash or unrelated assertion failures are inconclusive, not proof the intended assertion caught the mutation. No compulsory per-change mutation pass or fixed pyramid budget applies.

## Requested new-project generators

Resolve scripts from the physical skill directory shown by the host, not the project cwd or a guessed installation cache. Use them only for an explicitly requested **new target project**, never to initialize an existing checkout. Inspect the chosen stack and effects first. Each project generator refuses an existing destination; `--path` names its parent.

| Helper | Invocation | Effects / prerequisites |
| --- | --- | --- |
| Python project | `bun <skill-dir>/scripts/python/new-project.ts demo --path /tmp` | installed uv; `uv init`, strict config and dev dependency declaration; prints `uv sync`, never runs `uv add` or installs the target's dependencies |
| Python script | `bun <skill-dir>/scripts/python/new-script.ts demo --output /tmp/demo.py` | writes an executable PEP 723 template without fetching its declared dependencies; refuses an existing output; repeat `--deps` for each dependency |
| Rust project | `bun <skill-dir>/scripts/rust/new-project.ts demo --path /tmp` | installed Cargo, Rust >=1.85/edition 2024; source and strict lint configs, no dependency install, checks or rustup-triggering toolchain file |
| TypeScript project | `bun <skill-dir>/scripts/typescript/new-project.ts demo --path /tmp` | Bun/Hono/Zod, TypeScript 5.8+ config and complete OXC local plugin/config/license; prints install/check commands, does not execute them |
| Go project | `bun <skill-dir>/scripts/go/new-project.ts demo --path /tmp --module example.com/demo` | installed Go; real `go mod init`, source/config/CI/templates; real initialization failures stop with their error, never a fabricated fallback go.mod; dependencies/checks are printed, not fetched/run |

All launchers use Bun and built-in APIs; Python, Rust and Go share `scripts/shared/run-tool.ts` for direct argv execution and tool-error classification. Generated dependencies belong only to the requested project, not the plugin. Keep the copied skill tree read-only. No implicit or global installs: use an authorized target-project, temporary environment or explicit user cache. Toolchain installs/upgrades need separate consent.

## Optional evidence and policy helpers

Invoke these only when authorized. They are review inputs, not automatic rejection or refactor gates.

- Junk-test scanner: `bun <skill-dir>/scripts/typescript/check-test-junk.ts [--json] <test files or directories>`. Heuristic, cross-language candidates for source/prose pins, fixed sleeps, focused/skipped tests, self-comparisons and weak cardinality bounds. A documented per-line exception needs the rule and reason. Exit 0 = clean, 1 = findings, 2 = input/read failure. Apply retention exceptions before deciding what to do.
- Mutation evidence: `bun <skill-dir>/scripts/typescript/mutation-proof.ts --help`. Repeat `--test` with a JSON object containing `label`, an `argv` array, and `failure: {exitCode, pattern}` for the exact intended assertion failure. The helper requires passing baselines, one non-no-op exact source edit, and distinguishes `green`, `red` (matching assertion failure) and `command-failed`. Only exclusively owned/disposable work; commands run directly, not through a shell. Inspect the receipt, not just the exit code. Restore is attempted on normal completion, exceptions and SIGINT/SIGTERM, not SIGKILL/machine loss; a concurrent edit is preserved as a conflict, never overwritten.
- Python syntax policy: `python3 -B <skill-dir>/scripts/python/check-no-excuse-rules.py <paths...>` (stdlib AST).
- Rust / Go syntax policy: `bash <skill-dir>/scripts/<rust-or-go>/check-no-excuse-rules.sh <paths...>` (shell text checks).
- TypeScript syntax policy: from the **target project's cwd**, `bun <skill-dir>/scripts/typescript/check-no-excuse-rules.mjs <paths...>`. Resolves the caller's already installed TypeScript stable compiler API (5.8+), never packages from the skill cache. Exit 0 = clean, 1 = findings, 2 = missing/incompatible compiler or invalid input. No TypeScript 7 unstable API or implicit compiler upgrade; this is not a substitute for LSP/compiler or semantic tests.

For an authorized unsafe-code audit, collect both Miri aliasing models on supported paths and report the version, inputs/target, uncovered operations and limitations. Clean runs are not a proof of universal soundness and do not authorize nightly installation or new CI work.

## Dependency changes

Treat a `0.x` minor bump as potentially breaking. Research the installed/target API and all affected version pins, including CI/docs, before changing them. Let the package manager regenerate lockfiles rather than hand-merging them. Run only the checks the assignment authorizes; use `skill://upgrade-dependencies` for a requested upgrade workflow.

Preserve the MIT license at `scripts/typescript/oxc/lint/oxlint-plugin/LICENSE` when generating or redistributing that plugin.
