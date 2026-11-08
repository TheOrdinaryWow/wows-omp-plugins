---
name: remove-ai-slops
description: "Use when asked to clean up, deslop or simplify bounded changes while preserving behavior. Includes junk-test classification, retention exceptions and candidate/keeper evidence before test cuts."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Remove AI slops without changing the contract

## Inputs and scope

Use the explicit file list or the caller's workflow-owned changed-file set. Otherwise inspect the branch diff against its actual merge base; do not assume a `main` branch when the repository says otherwise. Exclude deleted/binary files, generated/vendor trees and lockfiles unless their contract is the request itself. Respect unrelated edits.

Repository conventions win. The categories below are review questions, not forced style migrations. No 250-LOC/argument-count gate, SIZE_OK marker, mandatory refactor, fixed agent roster or implicit installation applies. Run builds, tests, linters, formatters, audits and smoke checks only when the assignment authorizes them; name the exact checks in any child assignment that needs to run them.

## Categories

### Stylistic
1. **Obvious comments** — comments restating code, trivial docstrings, section dividers, commented-out code, vague TODOs/Notes.
   - KEEP: comments explaining WHY (business logic, edge cases, workarounds), ticket links, regex/algorithm explanations.
   - KEEP: BDD markers (`# given`, `# when`, `# then`, `# when/then`).

2. **Over-defensive code** — null checks for guaranteed values, try/except around code that cannot raise, isinstance checks for statically typed params, default values for required params, backward-compat shims, redundant validation duplicated at multiple layers, **broad exception catching** (`except Exception`/`except BaseException` in Python, empty `catch {}` or `catch (e) { console.error(e) }` without narrowing in TypeScript/JavaScript).
   - KEEP: validation at system boundaries (user input, external APIs), I/O error handling, nullable DB fields. Top-level boundary catch-all (CLI `main()`, HTTP handler) with explicit logging + re-raise is acceptable.
   - REFACTOR: `except Exception` → catch the specific exception you expect. Empty `catch {}` → add `instanceof` narrowing or re-throw. `catch (e) { log(e) }` → narrow with `instanceof`, handle known cases, re-throw unknown.
   - PROOF REQUIRED: before deleting any validation or error handling at a trust boundary, the behavior-lock step must include an **adversarial** regression (malformed or hostile input) that fails if the guard is removed. No adversarial test → the guard stays. Redundant defense to remove is a duplicate of a check that already runs *inside* the boundary; a guard with no proof of redundancy is load-bearing.

3. **Excessive complexity** — deep nesting that obscures control flow, nested ternaries, opaque boolean expressions, parameter lists that obscure the domain contract, functions mixing unrelated responsibilities, overly clever one-liners that sacrifice readability, `if/elif/else` chains for type/enum/literal discrimination where exhaustiveness is lost, `object` used as a type annotation where the contract can be expressed precisely.
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

### Tests

9. **Missing or junk coverage** — use the single authoring/retention contract in `skill://programming`, `references/testing/README.md` and `references/testing/junk-classes.md`.
   - **Missing:** where the repository keeps tests for the affected behavior and a credible regression would otherwise survive, extend the existing owner test or add the narrowest real-boundary case passing the four authoring questions. A prompt/skill/markdown file has no prose behavioral seam: assert only actual machine-consumed fields, runtime sentinels, validated examples or a genuine raw shipped-copy contract, never wording/heading/length pins.
   - **Classify:** mark every in-scope test declaration (or distinct table row) `R` retain, `F` fix, `C` consolidate or `D` delete. A scanner match is only a candidate. Static or slow does not mean worthless.
   - **Retain:** independently useful API/protocol/configuration, migration/storage, security, platform, generated/cross-language, installation/release, raw shipped-copy and architecture invariants, issue regressions and machine-consumed text. Host-rendered prompt text is not a byte channel; an inline assignment cannot be a byte-equality oracle.
   - **Baseline red:** a failure on the unchanged base is a product finding, excluded from mutation proof and never a deletion/edited-green opportunity. Unrelated baseline failures stay recorded; a broken runner prevents evidence-dependent cleanup, not silent acceptance.

## Process

### 1. Establish behavior and the relevant baseline

Trace real consumers and owner tests before deleting logic. A user-observed failure is already evidence; never replay it only to confirm the report. When authorized, use the relevant baseline check to identify unrelated red tests and runner/setup failures. For uncovered behavior, add only the justified owner-boundary case, not tests that restate the cleanup mechanism.

Before removing a trust-boundary guard or error handler, require an adversarial regression demonstrating its supposed redundancy at the real boundary. Without it, the guard stays. Do not invent a green test suite around a broken runtime or import/setup failure.

The optional scanner is `bun <programming-skill-dir>/scripts/typescript/check-test-junk.ts [--json] <test paths>`. Source/prose grep, focused/skipped tests, fixed sleeps, self-comparisons and cardinality lower bounds require review against the retention bar; the scanner never authorizes a cut. Documented intentional exceptions remain valid.

### 2. Decide whether the code needs to exist

For each unit, try the deletion ladder: **delete unneeded behavior → reuse existing repository code → standard/platform/native/installed facility → simplify in place**. Understand the end-to-end flow first. For a bug fix, follow all callers of the shared owner through native `lsp` references so a symptom patch does not leave a sibling broken.

Present a proportionate plan naming each file's contract, replacement or simplification, category, risk and proof. Prefer obvious comments → dead code → duplicate defense → duplication → complexity → abstraction/boundary → measured equivalent performance. File length alone is not a defect or permission to split.

### 3. Apply independent cleanup where it helps

Small bounded work stays inline. Substantial disjoint slices may run in one native `task` batch with the live agent roster, explicit ownership and shared contracts; use native IRC for genuine blockers. No foreign team runtime, background polling or fixed five-file batches.

A test-file worker may repair justified `F` rows but returns proposed `C`/`D` rows **uncut**, with every distinct obligation, named keeper(s), proof kind and proposed owner mutation. It must not mutate a shared production file while other workers can edit or verify it. The coordinator serializes evidence after all relevant writers have settled.

### 4. Prove proposed test cuts before applying them

Use the junk-class table's appropriate proof: a prose pin needs its assertion plus the prose-test rule; a copied inventory needs its real generator/consumer; a test-only seam needs native references showing no production caller; a change certificate needs the revert demonstrating its lack of an independent contract. Retention exceptions still win.

For behavior-bearing cuts (cannot-fail, mock echo, source grep, duplicate/layer replay, implementation mirror, fabricated postcondition, input transcript), establish passing candidate and keeper baselines on the **unmodified test tree**. On an exclusively owned/disposable checkout, mutate the actual production owner, run both, inspect the intended assertion messages, then restore bytes before the next proof. Only an intended assertion failure is red; command/setup/import/compile/crash/signal/unrelated failures are inconclusive. An equivalent mutation proves nothing.

| Candidate | Keeper | Evidence for this mutated case |
| --- | --- | --- |
| green | red | Candidate misses this mutation; keeper guards this case. |
| red | red | Both discriminate this particular behavior. |
| red | green | Candidate provides distinct protection; retain it or move that obligation into the keeper and prove it again. |
| green | green | Mutation missed the behavior; refine it, not the assertions. |

**One mutant never proves a whole test redundant.** Before `D` or `C`, cover **every distinct obligation** elsewhere or show that it has no real contract. If any obligation or proof remains unresolved, retain the candidate. Consolidation preserves every distinct input/assertion as a table row or equivalent keeper case.

The opt-in `bun <programming-skill-dir>/scripts/typescript/mutation-proof.ts --help` describes repeatable JSON `--test` specifications (`label`, direct `argv`, `failure: {exitCode, pattern}`). It checks baselines, rejects no-op/non-unique edits, separates intended assertion failures from command failures, and emits restoration hashes. Never treat its receipt as automatic deletion approval. Cleanup is bounded to normal completion, exceptions and SIGINT/SIGTERM; SIGKILL/machine loss and arbitrary concurrent writers require independent recovery. Never commit a mutant.

### 5. Verify and recover

After coherent authorized edits, run the assigned tests, native diagnostics/project type check, linter/build, configured security check and real-surface scenario as relevant. Report unrequested or unavailable checks explicitly rather than adding new scanners. Compare diagnostics with the recorded baseline. A worker's completed status is not acceptance.

If a cleanup changes behavior or fails its proof, fix the cause or undo only your own bad hunk. Do not use a destructive whole-file checkout that erases someone else's work. Repeated unresolved failures go to the owner with evidence, options and a recommendation; never mask an exception or weaken a test to force green.

## Report

Name scope; existing behavior/owner coverage and baseline-red findings; each deletion's replacement or reason; category and safety evidence; retained/skipped issues; exact exercised checks and limits. For each `F`/`C`/`D` row include the contract, all keeper obligations, proof kind, intended failure evidence and restore receipt. No line-count quota, speculative debt mechanism, or canned claim that all gates passed.
