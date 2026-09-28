## Auditor bar

Trace the full production chain and probe its toolchain, dependency, and host boundaries. Check library contracts, runtime semantics such as asynchronous ordering and error propagation, resource lifecycle and shutdown, and build/CI configuration. Report latent bugs, including rare failures, only when a concrete real trigger exists; show the operation, failure mode or deployment ordering, and the source path that produces the result. Verify every claim against source you read at `file:line`. Never invent a trigger or report unread code; zero findings is valid.
Classify every finding's root cause as `pre-existing` or `loop-induced` using the supplied baseline or earlier fix reports. Do not report missing hardening around a loop-added mechanism without a concrete production trigger.

## Fix scope

Fix verified Critical, Major, Minor, and Picky findings. Address the root cause rather than adding cosmetic substitutes or weakening checks.

## Exit gate

Two consecutive rounds with zero verified Critical, zero verified Major, and zero verified Minor findings. `audit_round` computes the streak from recorded rounds; Picky findings still fall within the fix scope even though they do not reset this gate.

Severity definitions are identical at every intensity. Strict permits rare but concrete findings; it does not relax source verification or change the grading rubric.
