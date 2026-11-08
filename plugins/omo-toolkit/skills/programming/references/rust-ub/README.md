> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

> **OMP scope.** Repository-first scope: these are optional recipes, not installation-wide rules. Existing repository contracts, language/toolchain versions, standard libraries and dependencies win. Do not migrate stacks, add dependencies, brand every primitive, run checks outside the assignment, or refactor automatically. Size and argument-count metrics are not gates. Run only explicitly requested/authorized checks. Provision packages only in the requested project, a temporary environment, or an explicit user cache; machine-wide installs/upgrades require separate consent.


# Rust Undefined Behavior Exorcist

For an **authorized unsafe-code audit**, classify concrete undefined-behavior findings and collect evidence on the supported paths. Run both Stacked Borrows and Tree Borrows for the exercised tests; a clean run covers only those inputs, executions, targets, and the recorded Miri version. It is not a proof of soundness or of all unsafe behavior. Do not install a nightly, change CI, or ban an unsupported platform merely because this reference was loaded.

The [Miri documentation](https://github.com/rust-lang/miri#readme) describes model limitations and unsupported operations. Inspect the installed nightly's supported flags before using the pinned examples.

## Core Philosophy

1. **Evidence-led audit.** Trace the unsafe contract, identify supported tests, and use Miri when the assignment authorizes it. An already observed failure is evidence, not an instruction to replay it.
2. **Classify before fixing.** Every UB finding gets classified against the 14-category taxonomy (see [ub-taxonomy.md](ub-taxonomy.md)). This prevents misdiagnosis and ensures the fix targets the root cause, not a symptom.
3. **Bound the claim.** Exercise the regression under both aliasing models when supported. For FFI, I/O, or unsupported targets, name the uncovered behavior and use an authorized sanitizer or targeted runtime test where appropriate; do not label an unsupported run clean.
4. **Bead handoff.** Each resolved UB instance is a "bead" — a discrete, documented, proven fix. Hand it off with: the UB category, the root cause, the fix, and the Miri proof.

## The UB Taxonomy

14 categories. The full reference is in [ub-taxonomy.md](ub-taxonomy.md). Memorize the categories; classify every finding:

| # | Category | Miri? |
|---|----------|-------|
| 1 | Aliasing violations (Stacked/Tree Borrows) | YES |
| 2 | Data races | YES |
| 3 | Use-after-free / dangling pointers | YES |
| 4 | Uninitialized memory | YES |
| 5 | Invalid values (type invariant violations) | YES |
| 6 | Misaligned pointer access | YES |
| 7 | Pin invariant violations | PARTIAL |
| 8 | FFI boundary UB | LIMITED |
| 9 | Incorrect Send/Sync implementations | YES (via race) |
| 10 | Out-of-bounds memory access | YES |
| 11 | Provenance violations | YES (strict mode) |
| 12 | Double free / invalid free | YES |
| 13 | Library / unsafe contract violations | PARTIAL |
| 14 | Unwinding across extern "C" | PARTIAL |

## The Hunt Workflow

### Phase 1: Reconnaissance

1. **Find all `unsafe` blocks and `unsafe impl`s:**
   ```bash
   rg 'unsafe\s*(fn|impl|{|\{)' --type rust -n
   ```

2. **Find all `unsafe` trait implementations:**
   ```bash
   rg 'unsafe\s+impl\s+(Send|Sync)' --type rust -n
   ```

3. **Find transmute / pointer casts / raw pointer derefs:**
   ```bash
   rg '(transmute|transmute_copy|from_raw|into_raw|as_ptr|as_mut_ptr|offset|add|sub|read|write|copy|ptr::null)' --type rust -n
   ```

4. **Find FFI boundaries:**
   ```bash
   rg 'extern\s+"C"' --type rust -n
   ```

5. **Count and catalog.** Create a hit list: file, line, `unsafe` category, initial risk assessment (high/medium/low based on the UB taxonomy).

### Phase 2: Miri Sweep (THE CRITICAL PHASE)

In a requested audit, the lower levels are useful diagnosis; Levels 3 and 4 supply the two-model evidence for supported paths. Use the target/filter authorized by the assignment, not an automatic whole-repository sweep. Record the actual aliasing model for the installed nightly rather than assuming a default forever.

**Level 1 — Default (Stacked Borrows):**
```bash
cargo +nightly miri test 2>&1
```

**Level 2 — Strict Provenance + Symbolic Alignment:**
```bash
MIRIFLAGS="-Zmiri-strict-provenance -Zmiri-symbolic-alignment-check -Zmiri-backtrace=full" \
  cargo +nightly miri test 2>&1
```

**Level 3 — Full Paranoia (the audit standard):**
```bash
MIRIFLAGS="\
  -Zmiri-strict-provenance \
  -Zmiri-symbolic-alignment-check \
  -Zmiri-preemption-rate=0.1 \
  -Zmiri-backtrace=full" \
  cargo +nightly miri test 2>&1
```

**Level 4 — Tree Borrows (second model confirmation):**
```bash
MIRIFLAGS="\
  -Zmiri-tree-borrows \
  -Zmiri-strict-provenance \
  -Zmiri-symbolic-alignment-check \
  -Zmiri-preemption-rate=0.1 \
  -Zmiri-backtrace=full" \
  cargo +nightly miri test 2>&1
```

Keep Miri isolation enabled by default. Add `-Zmiri-disable-isolation` only when the particular authorized test needs host resources and its effects are understood. Do not automatically provision Miri's first-run prerequisites; obtain consent when setup would install or download tools.

**Interpret results:**
- Fails at Level 1 → Definite UB. Fix immediately.
- Passes Level 1, fails Level 2 → Provenance or alignment UB. Fix.
- Passes Levels 1-3, fails Level 4 → Tree Borrows found something Stacked Borrows missed (unusual). Investigate — may be a Tree Borrows false positive, but usually indicates fragile aliasing. It does not ship until the aliasing is fixed or the false positive is proven and recorded with the Miri output.
- Passes both models → no UB observed on the exercised paths under those model/version/seed/target settings; this is not global soundness proof.
- Unsupported operation or unavailable toolchain → incomplete evidence, not a program assertion failure or a clean audit.

### Phase 3: Supplementary Scans

For code Miri cannot fully cover:

**Concurrent code with custom atomics:**
```bash
RUSTFLAGS="--cfg loom" cargo test --lib --release -- loom_tests 2>&1
```

**FFI-heavy code:**
```bash
RUSTFLAGS="-Zsanitizer=address" cargo +nightly test -Zbuild-std --target $(rustc -vV | rg host | awk '{print $2}') 2>&1
```

**Untrusted input parsing:**
```bash
cargo +nightly fuzz run <target> -- -max_total_time=300 2>&1
```

### Phase 4: Fix-and-Prove Loop

For each UB finding:

1. **Classify** against the 14-category taxonomy.
2. **Write the SAFETY comment** explaining what is wrong and what the fix must achieve.
3. **Apply the minimal fix.** Do not refactor — fix the UB and nothing else.
4. **Run the regression under both aliasing models (Levels 3 and 4)** when supported and authorized.
5. **Run the relevant authorized suite under both models**, reporting its target, filters, seeds, version, and uncovered paths.
6. **Document the bead:**
   ```
   BEAD: [Category #] [Short description]
   FILE: [path:line]
   ROOT CAUSE: [one sentence]
   FIX: [one sentence]
   PROOF: Miri Level [N] pass — [command used]
   ```

### Phase 5: Hardening (Post-Fix)

After all beads are resolved:

1. **Discuss CI separately** if ongoing audit coverage is requested; [miri-sanitizers-loom.md](miri-sanitizers-loom.md) has optional examples, not a mandatory infrastructure change.
2. **Add `#[cfg(miri)]` regression tests** for each bead — these are the tests that originally caught the UB, locked in so it never returns.
3. **Review SAFETY comments** on every remaining `unsafe` block. Each must name the specific invariant from the taxonomy.
4. **Run the full paranoia sweep one final time** to confirm clean.

## Miri-First Decision Protocol

When an authorized audit covers unsafe paths:

```
Is there unsafe code in the changeset?
  YES → Run Miri Level 1 before proceeding.
  │     Miri fails?
  │       YES → Stop. Classify. Fix. Prove. Then continue.
  │       NO  → Run Miri Level 2 (strict provenance).
  │             Miri fails?
  │               YES → Stop. Classify. Fix. Prove. Then continue.
  │               NO  → Collect Levels 3 and 4 for the authorized, supported paths.
  NO → Proceed normally.
```

Both aliasing models are the requested audit evidence for paths Miri supports. Report incomplete or unavailable evidence to the owner; do not silently expand the assignment or claim universal safety.

## SAFETY Comment Standard

Every `unsafe` block requires a SAFETY comment within 5 lines above it. The comment must:

1. **Name the UB category** it could trigger (from the taxonomy).
2. **State the invariant** that makes this safe.
3. **Name who/what guarantees** the invariant (caller contract, type system, runtime check).

```rust
// SAFETY: [Category 4 — Uninitialized Memory]
// All N elements have been written to via `ptr::write` in the loop above.
// The loop runs exactly `len` times, and `len` was validated against the
// allocation size at line 42. MaybeUninit::assume_init is therefore sound.
unsafe { buf.assume_init() }
```

Bad SAFETY comments that must be rejected:
- `// SAFETY: we know this is safe` — Says nothing.
- `// SAFETY: this is fine because we tested it` — Testing does not prove absence of UB.
- `// SAFETY: the caller ensures correctness` — Which invariant? What is the contract?
- No SAFETY comment at all — Immediate failure.

## Audit Report Format

When completing a UB audit, produce a summary:

```markdown
## UB Audit Report

**Scope:** [crate/module/file]
**Miri version:** [output of `cargo +nightly miri --version`]
**Date:** [date]

### Findings

| # | Category | File:Line | Severity | Status |
|---|----------|-----------|----------|--------|
| 1 | Aliasing | src/buf.rs:42 | High | Fixed (Bead #1) |
| 2 | Uninit | src/ffi.rs:98 | High | Fixed (Bead #2) |

### Beads

#### Bead #1: Aliasing violation in buffer resize
- **Root cause:** `&mut` created while `&` to same slice existed
- **Fix:** Restructured to drop shared ref before taking mutable
- **Evidence:** `test_buffer_resize` passes under recorded Stacked Borrows and Tree Borrows flags; list version, target, seeds, and unexercised behavior.

### Miri CI Status
- [ ] CI changes requested separately, or not in scope
- [ ] All SAFETY comments reviewed
- [ ] Regression tests added for each bead
```

## Common Fix Patterns

### Aliasing → Use `UnsafeCell` or restructure borrows
```rust
// BEFORE (UB: &mut while & exists)
let ptr = slice.as_ptr();
let mut_ref = &mut slice[0];  // UB: ptr still usable

// AFTER
let mut_ref = &mut slice[0];
// ptr is never created / used across the mutable borrow
```

### Uninitialized → Use `MaybeUninit::write` + `assume_init`
```rust
// BEFORE (UB: mem::uninitialized)
let x: T = unsafe { std::mem::uninitialized() };

// AFTER
let x: T = unsafe {
    let mut uninit = MaybeUninit::<T>::uninit();
    uninit.write(initial_value);
    uninit.assume_init()
};
```

### Provenance → Use `expose_provenance` / `with_exposed_provenance`
```rust
// BEFORE (UB: provenance lost)
let addr = ptr as usize;
let recovered = addr as *const T;

// AFTER
let addr = ptr.expose_provenance();
let recovered = std::ptr::with_exposed_provenance::<T>(addr);
```

### Send/Sync → Remove manual impl, use PhantomData
```rust
// BEFORE (unsound)
unsafe impl Send for MyType {}

// AFTER — if MyType truly needs Send, prove it:
// SAFETY: [Category 9 — Send/Sync]
// MyType's only non-Send field is `*mut Buffer`. Access to the buffer
// is guarded by `self.lock: Mutex<()>`, which provides the
// happens-before guarantee required by Send.
unsafe impl Send for MyType {}
```

### FFI → Validate at boundary
```rust
// BEFORE (UB: null pointer from C becomes &T)
let result = unsafe { ffi_call() };

// AFTER
let raw = unsafe { ffi_call() };
let result = NonNull::new(raw).ok_or(Error::NullFromFfi)?;
```

## Activation

This skill activates when:
- The user requests a "UB audit", "miri sweep", "unsafe audit", "soundness check", "rustonomicon audit", "race hunt"
- The agent encounters `unsafe` code during a Rust task and needs to verify it
- Miri reports a failure and the agent needs to classify and fix it
- The user asks "is this sound?" about Rust code

**A two-model Miri pass is evidence for the exercised paths, not proof of soundness. Report what ran and what Miri could not cover.**
