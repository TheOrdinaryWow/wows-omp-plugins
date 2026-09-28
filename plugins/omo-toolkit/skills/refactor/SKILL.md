---
name: refactor
description: "Use when asked to refactor, simplify, extract, restructure, or modernize code without changing its intended contract."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Refactor with a traced contract

Use this workflow when asked to refactor, simplify, extract, or restructure code. Preserve observable behavior unless the user explicitly requests a contract change.

## Intent gate

Identify the target, desired outcome, scope (file, module, or project), and success criteria. For an open-ended request with materially different choices, use `ask` to surface the alternatives and recommend one. Use `todo` `init` for analysis, impact map, coverage, plan, edit, and verification; `start` and `done` each item as it changes state.

## Map before editing

Dispatch one `task` batch of five independent `scout` children to inspect: target definitions and usages; callers and public API; tests and coverage; analogous patterns and style; and dependency/runtime boundaries. Give each child a self-contained brief and concrete evidence to return. Use `lsp` for definitions/references and `ast_grep` for structural occurrences, not guessed file names. Synthesize an impact map with direct and indirect callers, invariants, affected tests, and rollback boundaries.

## Design and execute

For a broad refactor, ask one `deep-high` child to produce a stepwise plan with interfaces, sequencing and risk (if `deep-high` is not listed in the task tool description, use `task`). Independent implementation pieces may run in one `task` batch; workers coordinate with `write agent://<name>` and return evidence through their outputs. Keep ownership of shared interfaces explicit; do not create a persistent team spec. For small contained refactors, edit directly after tracing the contract.

Make the smallest behavior-preserving transformation that solves the user's request. Avoid migrations or abstractions not needed by the contract. Run affected checks after a coherent change, then exercise the changed surface. If behavior differs unexpectedly, fix the cause rather than masking the failing check. Review the final diff for unrelated changes and update documentation only where the user-visible contract changed.

## Completion evidence

Report affected callers, behavior-preservation evidence, smoke invocation and observed result, remaining risks, and any unavailable check. Never claim success from compilation alone.
