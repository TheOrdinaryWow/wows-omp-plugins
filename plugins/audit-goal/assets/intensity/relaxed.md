## Auditor bar

Report visible problems only: wrong behavior reachable through normal use, failing checks, or clear deviations from a plan or ADR. Follow the direct call chain of code under audit; do not speculate about latent bugs. For each finding, cite source you read at `file:line` and show the real trigger. A zero-finding result is valid.
Classify every finding's root cause as `pre-existing` or `loop-induced` using the supplied baseline or earlier fix reports. Do not report missing hardening around a loop-added mechanism without a concrete production trigger.

## Fix scope

Fix verified Critical and Major findings. Record Minor and Picky findings without treating them as fixed or closed.

## Exit gate

One round with zero verified Critical and zero verified Major findings. `audit_round` computes this from the recorded round, even if lower-severity findings remain open.

Severity definitions are identical at every intensity. The auditor bar changes depth, not the grading rubric or the requirement for real source evidence.
