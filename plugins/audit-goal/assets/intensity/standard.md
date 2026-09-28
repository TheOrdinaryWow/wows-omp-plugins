## Auditor bar

Require a credible production trigger path for each finding. Trace the full end-to-end chain from entry point through state changes, asynchronous work, persistence, and observable result or recovery, as applicable to the domain. Check the actual initial requirements and relevant plan/ADR/TODO contracts against this chain. Cite source you read at `file:line`; do not invent edge cases to fill a report. Zero findings is a valid result.
Classify every finding's root cause as `pre-existing` or `loop-induced` using the supplied baseline or earlier fix reports. Do not report missing hardening around a loop-added mechanism without a concrete production trigger.

## Fix scope

Fix verified Critical, Major, and Minor findings. Record Picky findings without treating them as fixed or closed.

## Exit gate

Two consecutive rounds with zero verified Critical and zero verified Major findings. `audit_round` computes the streak from recorded rounds. Minor findings still require fixes; Picky findings remain recorded and open.

Severity definitions are identical at every intensity. The auditor bar changes depth, not the grading rubric or the requirement for real source evidence.
