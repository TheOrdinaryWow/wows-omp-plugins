---
name: refactor
description: "Use when asked to refactor, simplify, extract, restructure, or modernize code without changing its intended contract."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Refactor with a traced contract

Preserve observable behavior unless the owner explicitly requests a contract change. Repository guidance, established architecture, dependencies, language/tool versions and check commands take precedence. File length, parameter counts and estimated coverage percentages are not gates or permission to add unrelated mechanisms.

## Intent and scope

Identify the target, intended outcome, scope and success criteria from the request and repository. Do not ask for facts tools can supply. When materially different designs remain, the lead presents evidence, alternatives, consequences and a recommendation through the native decision surface; a delegated worker sends that brief to its parent. Keep small contained refactors direct. Track meaningful multi-step work proportionately, not with a fixed checklist or staffing ritual.

## Map before editing

Trace definitions, references, callers, public contracts, affected tests, analogous patterns and runtime boundaries. Use native `lsp` for definitions, references, implementations, renames and code actions; use `ast_grep` for structural occurrences and `grep` for text. Record relevant baseline diagnostics so pre-existing errors are not relabeled as new regressions. If the server cannot answer, read `../debugging/references/tools/lsp-setup.md` and establish a real native roundtrip rather than guessing a foreign configuration.

A useful codemap names the owner, imported dependencies, importing callers, invariants, likely impact and rollback boundary. Delegate only substantial independent evidence territories after focused inline scoping; no fixed five-scout roster. For an API migration, map all affected callers and remove the obsolete path rather than leaving aliases or shims.

## Choose a verification strategy

Read the owner tests and project commands before changing structure. Prefer extending an existing behavioral case over adding source-substring or prose pins. Apply `skill://programming` and its testing references when adding, reshaping or deleting tests. Missing coverage is a risk to discuss when it prevents the requested transformation from being justified, not an automatic percentage threshold or a reason to invent test-only production seams.

Name the authorized tests, type checks, linter/build and real-surface scenario that distinguish preservation. Workers run checks only if their assignment explicitly instructs them; otherwise they return the commands for the coordinator. Do not introduce a full-suite or after-every-edit loop merely because this skill was loaded.

## Design and execute

Make the smallest behavior-preserving transformation solving the request. Define coherent steps with explicit invariants, affected callers and a rollback boundary. For unresolved broad design work, a read-only `deep-high` comparison can help when listed (otherwise use the available `task` lane); the lead still resolves user-owned choices before implementation.

Independent implementation pieces may share one native `task` batch with disjoint ownership and explicit shared interfaces. Workers coordinate through `write agent://<name>`; do not create a second team runtime. A small contained refactor stays inline.

- **Symbol rename/move:** native `lsp` preview and project-aware rename/rename_file, not text substitution. Inspect server code actions before manually rebuilding a server-known refactor or import change.
- **Structural rewrite:** read `references/ast-patterns.md`. Search the precise language and scope, stage a native `ast_edit` proposal, inspect every proposed match and diff, then apply only the reviewed proposal. A parse error or zero matches is not success.
- **One-off structural edit:** use the surgical editor after reading the exact affected block; do not hide a cross-file rename inside manual edits.

Run the agreed checks after coherent authorized checkpoints, compare diagnostics with the baseline, and exercise the real changed boundary. A child's returned result is not independently verified acceptance. If a check fails, isolate and fix the cause; undo only your own failing transformation when appropriate, never a whole file containing unrelated work. Do not delete a test or weaken an assertion merely to unblock the refactor.

Commit only when the assignment authorizes it and the slice is working; never commit broken code. A delegated worker follows its coordinator's commit ownership.

## Completion evidence

Report the transformed ownership/boundaries, migrated callers, behavior-preservation evidence, exact exercised commands/results, unavailable checks and remaining risks. Update existing documentation where the actual user-visible contract changed. Neither compilation alone nor an unexercised coverage claim proves behavior preservation.
