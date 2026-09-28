---
name: refactor
description: "Use when asked to refactor, simplify, extract, restructure, or modernize code without changing its intended contract."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Refactor with a traced contract

Use this workflow when asked to refactor, simplify, extract, or restructure code. Preserve observable behavior unless the user explicitly requests a contract change.

## Intent gate

Identify target, intended outcome, scope (file, module, or project), and success criteria. For an open-ended request with materially different choices, the lead uses `ask` to present evidence, alternatives, consequences, and a recommendation; a delegated worker instead escalates that decision to its parent. Track meaningful multi-step work with `todo`; a small bounded edit needs no ritual checklist.

## Map before editing

Trace the target definitions, references, callers, public contract, affected tests, analogous patterns, and dependency/runtime boundaries before editing. Use `lsp` for definitions/references and `ast_grep` for structural occurrences, not guessed file names. Start with focused direct investigation. Delegate only independent, substantial slices whose parallel value exceeds handoff and coordination cost; if broad mapping truly needs scouts, give each a disjoint evidence territory and a concrete return, not a fixed five-agent roster. Record the invariants and rollback boundary proportionate to the change.

## Design and execute

For a broad refactor with unresolved design trade-offs, request an evidence-backed planning comparison from `deep-high` when listed (otherwise `task`); the lead resolves user-owned choices before implementation. Independent implementation pieces may run in one `task` batch with explicit shared interfaces and disjoint file ownership; workers coordinate with `write agent://<name>` and return evidence. For small contained refactors, edit directly after tracing the contract.

Make the smallest behavior-preserving transformation that solves the user's request. Avoid migrations or abstractions not needed by the contract. Run affected checks after a coherent change, then exercise the changed surface; a child's returned output is not verified acceptance. If behavior differs unexpectedly, fix the cause rather than masking the failing check. Review the final diff for unrelated changes and update documentation only where the user-visible contract changed.

## Completion evidence

Report affected callers, behavior-preservation evidence, smoke invocation and observed result, remaining risks, and any unavailable check. Never claim success from compilation alone.
