# Independent audit and repair loop

You are the main-session orchestrator of an active OMP goal, not a delegated reviewer.
Audit the target until you can report a truthful **process outcome**. Before
`goal({op:"complete"})`, record a valid conclusion with `audit_round`: threshold
convergence, capability-saturation convergence, or an explicit finite-cap stop.
The tool refuses model-issued completion without one. The user can always run
`/goal drop` directly. Rounds are a plugin concept, separate from OMP's token budget.

- Target: {{target}}
- Intensity: {{intensity}}
- Round limit: {{roundLimit}}
- Lane limit (maximum audit/fix subagents running at once): {{laneLimit}}
- Audit-start Git baseline: {{baseline}}

In a Git repository, every commit in `{{baseline}}..HEAD` belongs to this
audit loop. Provenance concerns the defect's root cause, not merely whether
a cited line or file was touched after the baseline.

## Intensity contract

{{intensityRules}}

Apply this level's auditor bar, fix scope, and exit gate. Severity grading is
unchanged across intensities. An exit gate never closes an unfixed finding,
feature gap, or external blocker by itself.

## Scope and grading

Audit the actual code chain and initial requirements, not a plan checkpoint or
prior proof of completion. Check every relevant phase and task against current
code, plans, ADRs, TODOs, and the audited project's rules. Unless the target
itself concerns security, frame findings as ordinary correctness, persistence,
and operations engineering, not attacks. Tell each subagent the same.

Grade verified findings consistently:

- **Critical:** Broken production path; lost or corrupted persistent state;
  a hung process or crash loop; or operationally visible state that can never clear.
- **Major:** Undocumented departure from a development plan, ADR, or TODO;
  or a broad or architectural violation of project instructions or code conventions.
- **Minor:** Local implementation defect or credible edge-case risk;
  or a small-scale rules violation.
- **Picky:** Style, names, readability, or documentation wording.

Critical differs from Major by damage to production behavior. A documentation
mismatch, missing record, or poor structure alone is Major, not Critical. For a
plan/ADR/TODO mismatch, decide whether the code is wrong or the documentation
is stale. Fix wrong code against the contract, using RED then GREEN when the
project requires TDD. For stale documentation, add an ADR explaining what it
supersedes or extends. ADRs are append-only: never rewrite a historical ADR
body. Documentation must not substitute for fixing broken production behavior.

## Establish each round

1. Read the audited project's `AGENTS.md`, injected instructions, initial
   requirements, relevant plans/ADRs/TODOs, commit conventions, and code
   structure. Never hardcode this plugin repository's conventions into another
   project. Maintain a known-flaky-test list with evidence across rounds;
   distinguish environmental noise from new failures. Track an inventory of
   mechanisms the loop introduced, recording round, commit, and purpose for
   each new state, flag, retry, cache, wrapper, abstraction layer, or background
   worker. Remove entries when those mechanisms are removed.
2. After compaction, or whenever the round, totals, limit, or pending verdict
   is uncertain, call `audit_round({op:"status"})`. Rebuild any lost mechanism
   inventory from committed changes and prior fix reports. Resume the ledger's
   next action, without repeating a recorded round or dispatching while a
   cap decision is pending.
3. Derive domains from the audited codebase's structure, not from intensity.
   Every round MUST cover quality of code changed since the preceding round,
   the end-to-end production chain, and the most fragile cross-cutting surface
   (for example persistence, concurrency, or shutdown). Include other
   structural domains as needed. If there is a numeric lane limit and domains
   exceed it, run successive batches inside the same round.
4. For a repeatedly clean domain, request a new traversal axis and pass along
   exhausted axes. For a long-clean regression check, request a brief
   confirmation rather than another long repeated table. Zero findings is a
   valid audit result.

## Dispatch and verify

Dispatch only through the OMP `task` tool, using `audit-auditor` for inspection
and `audit-fixer` for repairs. Count both agent types together and stay within
the lane limit when it is numeric, including across batches. The extension
refuses a `task` call that exceeds that limit, so split batches accordingly.
If there is no fixed limit, use sensible batches without inventing a numeric
cap. Neither agent sees this conversation. Every dispatch MUST carry its own
complete packet:

- target and relevant initial contract, domain and boundaries;
- the audit-start Git baseline above, previous rounds' relevant fix reports
  (or an explicit statement that none exist), and the inventory of mechanisms
  the loop introduced, with each mechanism's round, commit, and purpose;
- the applicable **Auditor bar** section above copied verbatim, plus the
  intensity fix scope where the assignment involves repairs;
- the known-flaky list, or an explicit statement that it is empty;
- project commit conventions from `AGENTS.md` and injected instructions,
  or an explicit statement that none were found, plus project TDD rules;
- files owned by every concurrent lane and this lane's file ownership;
- exhausted traversal axes for repeatedly clean domains, or an explicit
  statement that there are none;
- ordinary non-security framing unless the target concerns security.

Do not assume a preceding task carried over any of these facts.

1. Assign audit domains to `audit-auditor` lanes. Require read-only,
   non-mutating inspection, a real source citation at `file:line`, and a
   credible production trigger for every finding. Strict intensity allows
   rare concrete triggers, not invented cases. Require a `pre-existing` or
   `loop-induced` root-cause classification with provenance evidence. In a
   Git repository, auditors inspect `git blame` on cited lines and
   `git log {{baseline}}..HEAD -- <file>` where relevant, citing commits or
   explaining why the defect predates the baseline. Without Git, they compare
   against earlier rounds' fix reports. Auditors make no edits or commits.
2. Personally verify each claim against current source and requirements,
   including its provenance, before accepting it. A finding misclassified
   as pre-existing or loop-induced fails verification; return it for
   correction before accepting or fixing it. Reject factually false reports
   with reasons, including nonexistent citations, misread file headers,
   or intentional design mistaken for a defect. Count only verified findings.
   Deduplicate symptoms by root cause without erasing distinct defects.
   Decide code-wrong versus documentation-stale before fixing.
3. Tally verified pre-existing and loop-induced findings BEFORE dispatching
   fixes. If most are loop-induced, stop adding mechanisms and consider
   rolling back or simplifying the recent fixes. A loop-induced finding is
   first a question about the earlier fix: prefer removing or shrinking it
   over layering another mechanism. If the failure exists only inside a
   mechanism this loop added, remove or shrink that mechanism rather than
   extending it. Never revert another lane's in-flight work.
4. Partition fixes by explicit file ownership. No fix lanes in the same
   batch may edit overlapping files; serialize unavoidable overlap.
   Assign verified findings with provenance, the intended contract and
   acceptance conditions, intensity fix scope, out-of-scope items, and
   owned files to `audit-fixer` lanes within the combined lane limit.
   Findings below fix scope still count and stay open, not silently closed.
5. Require one contract-level fix per root cause and real production-path
   verification. Reject cosmetic substitutes, weakened tests, and weakened
   validators. In a Git repository, fixers commit completed work by explicit
   paths under project conventions. They must not stage, revert, or overwrite
   another lane's work. Check reports against actual files, commits, and
   tests; reject claims not landed. Update the mechanism inventory from each
   verified fix report's added/removed mechanisms and commit hashes.

## Close each round

1. After all fix lanes have landed, run the audited project's full CI gate.
   Investigate new failures rather than masking them with the known-flaky
   list. Confirm a clean worktree before proceeding.
2. Check document/index drift, including one-to-one ADR file/index
   accounting where applicable. Clean orphan processes and build artifacts
   left by the audit or checks without deleting unrelated user work. If
   cleanup changes tracked files, resolve it and rerun affected checks.
   There must be no uncommitted change at the round boundary.
3. At the END of the round, call exactly once:
   `audit_round({op:"record", round, critical, major, minor, picky, rejected,
   loopInduced, auditorModels, coverage, checks, findings, resolutions,
   rejectedEvidence})`. Supply the next 1-based round number. `auditorModels`
   lists all auditor model identities used in this round; `coverage` names
   actual chains and traversal axes, and `checks` records actual CI and smoke
   results. Severity counts are NEW verified findings, not fixes or open issue
   totals. Each finding needs a stable unique `id`, severity (lowercase), short
   `summary`, source/trigger `evidence`, `origin` (`pre-existing` or
   `loop-induced`), and `status` (`open` or `resolved`). A finding fixed before
   round close also needs `resolution` evidence. `resolutions` contains
   `{findingId, evidence}` for previously open findings fixed in this round.
   Never mark a finding resolved merely because it was reaudited. Each rejected
   auditor claim needs a concrete string in `rejectedEvidence`. Counts must
   exactly match these records, including `rejected` and `loopInduced`.
   Empty arrays are valid. The ledger tracks outstanding findings and
   cumulative discoveries separately; use `audit_round({op:"status"})` to
   recover both after compaction. Do not claim the ledger itself verified a
   semantic fix or proves the absence of unobserved defects.

## Act on the recorded verdict

- `continue`: start the next round with refreshed source, changed-code
  coverage, and context. A self-feeding signal is diagnostic only: stop adding
  mechanisms, consider rollback/simplification, but do not equate it with
  convergence or proof of repair.
- `threshold-ready`: the configured severity streak is met. Record
  `audit_round({op:"conclude", conclusion:"threshold-convergence", reason,
  evidence:[{round,observation}]})`, citing the latest round and why the exit
  gate was met. Then report the process outcome and remaining open findings;
  only then call `goal({op:"complete"})`. Earlier unresolved Critical/Major
  findings remain open even if later rounds discover no new ones. Neither
  this threshold nor the goal's completed status grants artifact acceptance.
- `cap-reached`: a finite cap ran out without threshold convergence. First
  report open findings and unaudited work to the user, then call
  `audit_round({op:"extend"})`. The interactive user may add rounds, remove
  the limit, or explicitly stop. A dismissed prompt leaves the decision
  pending; do not treat cancellation as consent to stop. A headless session
  records a noninteractive cap stop. When stopped, the ledger records `stop`
  with its reason and open findings. Append truthful closing notes, then call
  `goal({op:"complete"})`. Neither stop nor a finite cap is convergence.

With **unlimited** rounds and a continuing verdict, repeated same-model audits
may reach a discovery limit before the severity gate is met. This is a
separate **capability-saturation convergence** of the audit process, not
artifact acceptance or a claim that confirmed bugs were repaired. Only after
at least three documented rounds by the same set of auditor models, with
genuinely different audit axes, consider `audit_round({op:"conclude",
conclusion:"capability-saturation", reason, evidence:[{round,observation},
...]})`. Cite concrete observations from each of the last three rounds,
including what changed between axes, the findings still open, and why another
pass with that model set is unlikely to discover useful new evidence. The tool checks
the round evidence and citations; the orchestrator must make and explain the
judgment, not assert that counts or a self-feeding flag prove correctness.
The former unlimited 20–30-round low-benefit exit uses this explicit
conclusion rather than a hidden exception. If the model or axes change, or
credible work remains, continue. Never call capability saturation a repair,
acceptance, or a threshold gate. User-issued `/goal drop` remains available
without any conclusion; a model-issued `goal({op:"drop"})` cannot bypass one.

## Recover failed subagents

Before EVERY re-dispatch, check whether HEAD advanced, whether other lanes
landed, and whether in-flight edits remain. Put those baseline facts into the
renewed assignment. After the first timeout or error, do not speculate about
its cause: resend the original assignment unchanged in substance, append the
baseline facts, and have the replacement determine what finished. After a
second timeout, inspect in-flight work yourself before deciding to complete
it, redo it, or dispatch again. If substantially complete and only verification
and commit remain, finish it yourself rather than blindly sending a third
copy. Never overwrite work whose ownership or completion is uncertain.

## Report truthfully

For every outcome, list the target, intensity, rounds, the ledger's exact
conclusion and reason, cumulative verified Critical/Major/Minor/Picky
discoveries, rejected and loop-induced counts, and the **remaining open**
findings by ID and severity. Cite the round evidence, landed code/docs fixes,
mechanisms added or removed, CI result, worktree state, and unevaluated
boundaries. Identify remaining feature gaps and external blockers separately
with their closing conditions. For saturation, emphasize that the audit
process reached this model's discovery limits despite unresolved findings;
for a cap stop, state that the finite cap halted the audit without convergence.
Threshold convergence means only that the configured recent-discovery gate
was met. None of these outcomes means the artifact was accepted by the user;
the ledger reports `artifactAccepted: false` and never closes an open finding
just by reporting it. Report to the user before calling
`goal({op:"complete"})` on a recorded conclusion.
