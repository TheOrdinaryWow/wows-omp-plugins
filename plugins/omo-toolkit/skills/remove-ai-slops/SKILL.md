---
name: remove-ai-slops
description: "Use when asked to clean up, deslop, or simplify recent changes while preserving behavior with regression evidence."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Remove AI Slops Skill

## Inputs

- **Default scope**: branch diff vs `merge-base main` (no arguments needed)
- **Optional scope**: explicit file list passed by the caller (e.g., a Ralph workflow's changed-files set)

## What this skill does

Cleans AI-generated slop from a bounded set of changed files while strictly preserving behavior. Locks behavior with regression tests first, then runs a categorized multi-pass cleanup, then verifies with quality gates and a critical review. Reverts and direct-edits when verification fails.

The core safety invariant: **behavior is locked by green tests before a single line is removed**. A checklist alone is not safety; a passing regression test is.

---

## Categories (what counts as slop)

The agent looks for these nine categories. The first three are stylistic, the next three are structural, the next two are about hidden cost, and the last is about behavior coverage.

### Stylistic
1. **Obvious comments** — comments restating code, trivial docstrings, section dividers, commented-out code, vague TODOs/Notes.
   - KEEP: comments explaining WHY (business logic, edge cases, workarounds), ticket links, regex/algorithm explanations.
   - KEEP: BDD markers (`# given`, `# when`, `# then`, `# when/then`).

2. **Over-defensive code** — null checks for guaranteed values, try/except around code that cannot raise, isinstance checks for statically typed params, default values for required params, backward-compat shims, redundant validation duplicated at multiple layers, **broad exception catching** (`except Exception`/`except BaseException` in Python, empty `catch {}` or `catch (e) { console.error(e) }` without narrowing in TypeScript/JavaScript).
   - KEEP: validation at system boundaries (user input, external APIs), I/O error handling, nullable DB fields. Top-level boundary catch-all (CLI `main()`, HTTP handler) with explicit logging + re-raise is acceptable.
   - REFACTOR: `except Exception` → catch the specific exception you expect. Empty `catch {}` → add `instanceof` narrowing or re-throw. `catch (e) { log(e) }` → narrow with `instanceof`, handle known cases, re-throw unknown.
   - PROOF REQUIRED: before deleting any validation or error handling at a trust boundary, Phase 2 must include an **adversarial** regression (malformed or hostile input) that fails if the guard is removed. No adversarial test → the guard stays. Redundant defense to remove is a duplicate of a check that already runs *inside* the boundary; a guard with no proof of redundancy is load-bearing.

3. **Excessive complexity** — deep nesting (>3 levels), nested ternaries, complex boolean expressions (combine 4+ predicates), long parameter lists (>5 args without a struct/dataclass/object), god functions (>50 lines doing many things), overly clever one-liners that sacrifice readability, `if/elif/else` chains for type/enum/literal discrimination (must be `match/case` + `assert_never`), `object` used as a type annotation (must be `Protocol`, `TypeVar`, or explicit union).
   - KEEP: established complexity patterns in this codebase, performance-critical hot paths that intentionally use a complex idiom. `if/else` for boolean conditions and range checks (not variant discrimination).
   - REFACTOR: nested if-chains → guard clauses / early returns. Complex ternaries → explicit if/else. isinstance/enum if/elif chains → `match/case` with `assert_never` on the wildcard. `object` annotations → `Protocol` (structural), `TypeVar` (generic), or union (known variants).

### Structural
4. **Needless abstraction** — pass-through wrappers, single-use helpers, speculative indirection ("we might need this later"), interfaces with one implementer where the interface adds no testability win, factory functions that just call a constructor.
   - KEEP: abstractions that provide a real seam (testability, multiple implementers, framework-required boundaries).

5. **Boundary violations** — wrong-layer imports (UI importing DB driver), leaky responsibilities (handler doing business logic that belongs in a service), hidden coupling (module A reads module B's private state), side effects in pure-named functions.
   - KEEP: pragmatic short-circuits already established as a pattern in this codebase. Flag for human judgment if unsure.

6. **Dead code** — unused imports, unused private functions/methods, unreachable branches, stale feature flags, debug leftovers (`console.log`, `print(...)`, `dbg!`), removed-but-still-referenced code.
   - KEEP: code referenced via reflection, dynamic dispatch, or string lookup. Code intentionally kept as a feature flag rollback path (verify with the user).

### Hidden cost
7. **Duplication** — copy-pasted branches with trivial differences, redundant helpers that do the same thing in two places, repeated literal/magic-number sequences.
   - KEEP: incidental duplication (two pieces of code that look similar but serve different intents that could diverge). Prefer leaving them separate over forcing a premature shared abstraction.

8. **Performance equivalences (behavior-preserving optimizations)** — changes that are provably equivalent in semantics but cheaper in time/space:
   - O(n²) → O(n) when correctness preserved (e.g., set lookup vs list scan)
   - Repeated computation inside a loop → hoist outside
   - Unnecessary intermediate collections (eager `list(...)` when only iterated once → generator)
   - String concatenation in loop → `join`
   - Redundant DB/API calls in a loop → batch
   - Redundant deep copies / clones
   - `.length` / `len()` recomputed inside loop → cache

   **Hard rule**: only apply when behavior equivalence is obvious. Do NOT change algorithms with subtle correctness implications. Do NOT micro-optimize hot paths without a benchmark. If in doubt, SKIP.

### Behavior coverage
9. **Missing tests** — behavior present in changed files that is not locked by any regression test. The fix is not to remove code but to ADD the narrowest test that pins the behavior. EXCEPTION: a PROSE file (prompt, `SKILL.md`, rule, markdown) has no behavioral seam — do NOT add a text/word-count/phrase pin for it; that guards a diff, not behavior. Cover only a machine-consumed value (parsed field, sentinel a runtime greps, a doc JSON sample through its real validator) or leave it to review.

## Process

1. Inventory changed files and the relevant branch diff; identify real consumers and tests.
2. Lock existing behavior with relevant tests before deleting logic. For trust-boundary validation, add an adversarial case that would fail if the guard vanished; otherwise preserve it.
3. Delegate independent review of up to five distinct portions in one `task` batch of `deep-low` children (if `deep-low` is not listed in the task tool description, use `task`). Each prompt begins: "Read `skill://remove-ai-slops`" and includes the portion, unchanged behavior, and specific evidence to return.
4. Apply only justified simplifications. Do not delete valuable comments, context, or tests to satisfy an arbitrary metric. Revert a proposed cleanup if it changes behavior or fails its proof.
5. Run the affected tests, linter, typecheck and real-surface smoke as applicable. Review the final diff for accidental changes and report what ran and what did not.

No source-text lint convention or special exemption comment is required.
