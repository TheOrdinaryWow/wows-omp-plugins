# audit-goal reference

English | [简体中文](REFERENCE.zh.md)

## How the loop runs

- When the audit starts, and again after every compaction, the plugin injects the audit protocol and the round ledger as a hidden message.
- It enables the `goal` and `audit_round` tools for the loop and disables the ones it enabled once the goal completes or is dropped.
- The model cannot complete the goal through `goal({op:"complete"})`, including through a nested device call, until `audit_round` has recorded a valid conclusion.
- `audit-auditor` and `audit-fixer` are dispatched with blocking calls, so the main agent waits for each batch. The plugin refuses them outside a running `/audit`, from subagents, and through `eval` `agent()`.
- The plugin rejects any `task` call that would exceed the effective lane limit.
- If the latest ledger entry is malformed, the model can neither complete the goal nor dispatch the reserved agents. The plugin does not fall back to an older snapshot.
- Results always carry `artifactAccepted: false`.
- A headless session that hits a finite round limit records a noninteractive stop instead of asking.

## State snapshot

The plugin publishes `audit-goal.json` in the shared snapshot envelope (see the [repository reference](../../REFERENCE.md)) whenever it saves the ledger. Sessions that never ran `/audit` get no file. When a branch switch leaves the session without an audit ledger, the file is rewritten with `state: null`.

| Field | Meaning |
| --- | --- |
| `kind`, `version` | `"audit-goal/audit"`, `1` |
| `status` | `running`, `awaiting-limit-decision` (finite limit reached, user choice pending), `converged`, `saturated`, `stopped`, or `invalid` (latest ledger entry is malformed or could not be saved; no other fields) |
| `ended` | `true` once the audit goal completed, was dropped, or was replaced |
| `target`, `intensity`, `maxRounds`, `laneLimit`, `baseline` | Audit setup. `maxRounds` and `laneLimit` are `null` when unlimited; `baseline` is `null` outside git |
| `rounds[]` | `index`, `counts` (`critical`, `major`, `minor`, `picky`), `rejected`, `loopInduced`, and `verdict` (`continue`, `threshold-ready`, `cap-reached`, evaluated against the current round limit) |
| `totals` | Sums of the round counts, plus `rejected` and `loopInduced` |
| `openFindings` | `counts` by severity and `items[]` (`id`, `severity`, `summary`, `origin`) for findings still open |
| `conclusion` | `null`, or `kind` (`threshold-convergence`, `capability-saturation`, `stop`), `reason`, and cited `evidence[]` |
| `stopReason` | The conclusion reason when the audit stopped, otherwise `null` |
| `artifactAccepted` | Always `false` |
