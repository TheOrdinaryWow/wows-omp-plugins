> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

> **OMP scope.** Repository-first scope: these are optional recipes, not installation-wide rules. Existing repository contracts, language/toolchain versions, standard libraries and dependencies win. Do not migrate stacks, add dependencies, brand every primitive, run checks outside the assignment, or refactor automatically. Size and argument-count metrics are not gates. Run only explicitly requested/authorized checks. Provision packages only in the requested project, a temporary environment, or an explicit user cache; machine-wide installs/upgrades require separate consent.

# Code Smells — Full Reference

Treat these examples as review questions, not automatic edit instructions. A code smell is not a syntax error — it is a signal that the current structure deserves a second look. The correct response is to assess whether `skill://refactor` is warranted, fix the smell, or document a SPECIFIC justification for carrying it. "It's fine" is not a justification.

---

## Cohesion and parameter design

Review a module when its responsibilities are hard to describe, not when a line counter crosses a threshold. Review a function when its arguments obscure its domain contract, not when it has a fourth argument. Preserve clear APIs and existing boundaries. A cohesive large file or a four-argument function can be correct; splitting either needs a concrete maintenance benefit and an in-scope change request. Do not add SIZE_OK markers or automatic refactors.

## Smell 3 — Redundant verification after a destructive action

### Why this is slop

The contract of a destructive operation (delete, remove, clear, drop) IS the verification. If the operation returns without error, the thing is gone. Re-querying to "confirm" is:

1. **Dead code.** The check can never fail unless the operation itself is broken — in which case fix the operation, not the caller.
2. **Misleading.** It teaches the next reader (human or AI) that the operation is unreliable.
3. **Performance waste.** An unnecessary round-trip to the database, filesystem, or data structure.

This pattern is the hallmark of AI-generated defensive bloat. LLMs produce it because they optimize for "looking thorough" over "being correct." **Recognize it. Delete it.**

### Examples

```python
# SLOP — delete then verify deletion
db.delete(user)
db.commit()
remaining = db.query(User).filter_by(id=user.id).first()
assert remaining is None  # the ORM already guaranteed this

# CLEAN
db.delete(user)
db.commit()
```

```typescript
// SLOP — remove from array then check it's gone
items = items.filter(i => i.id !== targetId);
if (items.find(i => i.id === targetId)) {
  throw new Error("removal failed");  // impossible by construction
}

// CLEAN
items = items.filter(i => i.id !== targetId);
```

```go
// SLOP — delete row then SELECT to confirm
_, err := db.ExecContext(ctx, "DELETE FROM users WHERE id = $1", id)
if err != nil { return err }
row := db.QueryRowContext(ctx, "SELECT id FROM users WHERE id = $1", id)
if err := row.Scan(&check); err != sql.ErrNoRows {
    return fmt.Errorf("delete verification failed")
}

// CLEAN
_, err := db.ExecContext(ctx, "DELETE FROM users WHERE id = $1", id)
if err != nil { return err }
```

```rust
// SLOP — remove from HashMap then check absence
map.remove(&key);
if map.contains_key(&key) {
    panic!("removal failed");  // HashMap::remove is not broken
}

// CLEAN
map.remove(&key);
```

### Broader pattern — same smell, different disguise

Any of these are the same defect:

- Calling a **setter** then immediately calling the **getter** to "confirm" the value changed.
- **Writing** a file then **reading** it back to "verify" the write.
- **Inserting** a row then **SELECT-ing** it to "confirm" the insert.
- **Pushing** to an array then checking `.length` increased by 1.
- **Assigning** a variable then asserting the variable equals the assigned value.

**The contract of the operation IS the verification.** If you cannot trust the operation's return, the defect is in the operation — fix it there, not at the call site.

---

## Smell 4 — Negative-form names and conditions

### Why positive form wins

Every negation forces the reader to mentally invert. One negation is tolerable. Two (`if !isNotReady`) is a logic puzzle. Codebases that default to negative naming accumulate double and triple negations that nobody can review confidently.

Positive form reads in the direction of intent: "is this ready?" rather than "is this not-not-ready?"

### Naming

| Negative (SMELL) | Positive (CLEAN) |
|---|---|
| `isNotValid` | `isValid` (invert branch) |
| `isDisabled` | `isEnabled` |
| `noErrors` | `isClean` / `errorsResolved` |
| `notFound` | `found` (invert branch) |
| `isNotEmpty` | `hasItems` / `isPopulated` |
| `missingAuth` | `hasAuth` / `isAuthenticated` |
| `cannotProceed` | `canProceed` (invert branch) |

Name the **presence** of the quality you care about, not the absence of its opposite.

### Conditions

```python
# SMELL — double negative
if not is_invalid(token):
    proceed()

# CLEAN — single positive check
if is_valid(token):
    proceed()
```

```typescript
// SMELL — negated boolean in branch
if (!user.isNotVerified) {
  grantAccess();
}

// CLEAN — positive name, direct check
if (user.isVerified) {
  grantAccess();
}
```

```go
// SMELL — inverted negative
if !config.DisableLogging {
    log.Info("starting")
}

// CLEAN — positive flag
if config.LoggingEnabled {
    log.Info("starting")
}
```

```rust
// SMELL — negated negative
if !skip_validation {
    validate(&input)?;
}

// CLEAN — positive gate
if should_validate {
    validate(&input)?;
}
```

### When negation IS appropriate

- **Early returns / guard clauses:** `if !authorized { return Err(...) }` — the negative form IS the intent (reject the bad case).
- **Filtering out:** `items.filter(|x| !x.is_expired())` — the negation describes the keep/discard decision directly.
- **Error state names:** `Error`, `Failed`, `Timeout` are negative concepts by nature — do not force them into positive wrappers like `isSuccessAbsent`.

The rule is not "never use negation." The rule is: **when you have a choice between naming the presence and naming the absence, name the presence.** The branch logic follows from the name, not the other way around.
