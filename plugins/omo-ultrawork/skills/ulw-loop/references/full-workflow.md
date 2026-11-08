> **Modified-port notice and license.** This reference is a modified OMP port of oh-my-openagent ulw-loop material at revision `adddd17004076e799c2de18ccfdee29e12525ace` (`packages/omo-senpi/skills/ulw-loop/references/full-workflow.md`). It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Full loop procedure

This reference covers the bootstrap, the execution cycle, evidence freshness, manual QA, research goals, the final quality gate, steering, constraints, and stop rules. `SKILL.md` has the command and tool table. `define-goal.md` has the objective and criteria rules. Read this file in full before your first dispatch.

## Bootstrap

Make no edits, dispatches, or checkpoints until these steps are done.

1. Call `status`. Confirm `driver.owned` is true and note `evidenceRoot`. If the driver is missing, foreign, or paused, or the loop is paused, blocked, or stopped, report it and follow `nextActions`.
2. Gather context with read-only tools first. Batch substantial independent investigations in one `task` call when useful: `scout` for broad code mapping, `librarian` for external documentation (or `scout` when absent). Do not delegate a lookup whose briefing costs more than reading it. Survey matching skill descriptions and name the workflows this run will use; load delegated skills in their assignments.
3. Write the brief as described in `define-goal.md`, under The brief file. It holds the user's request verbatim, every stated constraint, the out-of-scope items, and the owner decisions already made.
4. Shape the goals and criteria per `define-goal.md`. Set the tier (`LIGHT` or `HEAVY`) and the shape (`delivery` or `research`) for each goal. When unsure, choose HEAVY.
5. Call `create_goals` with the brief path, the objective, the goals, and any validation batches. Then call `status`.
6. Record tier triage and each `assumed:` default with `steer`, `kind: "annotate_ledger"`. The evidence names the repository fact or user statement behind the choice. The rationale names the default and whether it is reversible.
7. Name the assumed defaults in your first user-visible report, so the user can veto one with a single line.

For a HEAVY goal, split its criteria into atomic tasks, where an implementation and its test count as one task. Put tasks with no dependency between them in the same wave. Split waves only along real dependencies. Each task names the criterion it serves, its QA scenario, and its evidence path.

Planning is driven by unresolved decisions, not the tier: plan a known procedure directly, and seek a planning child only after discovery leaves genuine architecture or dependency-order choices. For optimization, capture the baseline metric and behavior/regression proof before changes; each attempt records the measurement and the keep/revert/iterate decision. A rollback never discards unrelated user changes.

### Resource ownership

Create no ritual temporary root or cleanup task for resource-free work. Before a command that writes temporary data or runtime caches, create an owned root such as `RUN_TMP=$(mktemp -d)` and use `TMPDIR="$RUN_TMP" NODE_COMPILE_CACHE="$RUN_TMP/node-compile-cache" BUN_RUNTIME_TRANSPILER_CACHE_PATH="$RUN_TMP/bun-transpiler"`. Propagate those variables explicitly when a child does not inherit them; independent tasks own separate roots.

At creation, register each root, cache, worktree, PID, service, browser context, container, port, script, or temporary path in the loop journal through `steer` `annotate_ledger`, and add its cleanup todo. Name its owner and teardown. Persist proof under `currentAttemptDir` before deleting a disposable root. Clean only resources this work owns after all their writers/processes exit; never wipe shared caches, another worker's paths, user browser state, or an ancestor of retained work. Retain worktrees still needed by open PRs, and their parent directories, with the path, reason, and continuing owner recorded. A resource-free scenario needs no teardown receipt; created disposable resources do.

Only the main session requests unresolved scope, spending, or irreversible decisions through native `ask`, before dependent work. Children and eval cells report the decision need to that session. Timeout, dismissal, or no usable question surface means unapproved; do not turn generic best-judgment advice into authorization.

## Execution loop

Limits: after three identical failures on one criterion, checkpoint that goal `failed`. After five cycles on one goal without its required criteria passing, checkpoint it `failed`.

### Acquire

1. Call `complete_goals`. Pass `retryFailed: true` only to retry failed goals on purpose.
2. Read the result.
   - A goal: read its criteria with `criteria` before any work. Calling `complete_goals` again returns the same in-progress goal, so it is safe on resume.
   - `noEligibleWork: true` and `aggregateComplete: false`: no pending goal is left. Only failed, blocked, or superseded goals remain. Report them, and retry failed goals only with `retryFailed`.
   - `aggregateComplete: true`: the loop is complete. `complete_goals` changes nothing on a completed loop. Go to the final report.
3. Call `status` and check the driver relation. If it reports the driver paused, budget-limited, foreign, or missing, stop and report it.

### Per-criterion cycle

1. **Plan.** Read the criterion's scenario, its expected evidence, and its prior captures. Choose the tasks for this wave. Tasks that touch the same files wait for a later wave.
2. **Track.** Keep `todo` current with one `in_progress` item that names the criterion. Mark each step done as soon as it finishes.
3. **Dispatch.** Send independent units in one `task` batch and dependent units in a later batch. Each prompt starts with `TASK:` and names `DELIVERABLE`, `SCOPE`, `VERIFY`, and `STOP WHEN`, carrying the criterion, exact allowed writes, project rules, required skills, named checks explicitly authorized in `VERIFY`, artifact paths, and creation-time resource ownership. A producer and consumer name the identical accessible absolute physical handoff path; a missing or insufficient file is FAIL, and the parent's `local://` namespace is not transport. When using `mass-ulw` for real ordering, retain its one-inspected-frontier barrier; no per-angle or rescue scheduler replaces this loop's acceptance.
4. **Integrate.** When a child returns, read its final result first. An error, an abort, or any non-success result means the unit is not done, even when output exists. Read the diff yourself, run the checks in your own plan, and send the child back with the specific failure when the change drifts or the evidence is missing. Do not hand-patch around a failure.
5. **Commit.** Load `skill://git-master` before you commit. Inspect recent commits and the touched paths, then commit only this unit's files in the repository's style. Commit each verified unit on its own. Never commit broken code. Commit before you capture, because every capture in a Git work tree needs a clean tracked tree.
6. **Execute the scenario.** Run the criterion's real-surface scenario yourself, or dispatch one QA child whose only job is to drive the channel and write the artifact. Write artifacts under `currentAttemptDir` from `status`. Record the exact invocation and the expected observable before you run it.
7. **Clean up.** Tear down the scenario's owned disposable resources and include stop commands plus read-back output in its artifact. Keep task-wide roots until their final consumers exit, then perform their recorded teardown before completion. Preserve open-PR worktrees under the recorded retention rule. A missing receipt for a created disposable resource is BLOCKED, not PASS; do not invent a receipt for resource-free work.
8. **Record.** Call `record_evidence` as soon as the artifact exists. Use `pass` only when it shows the expected observable; otherwise use `fail` or `blocked`. Record the exact invocation, commit when applicable, what was exercised, relevant inputs, and any resource receipts. Record from the artifact just written, never from memory.
9. **Repeat or move on.** On a mismatch, diagnose the cause, send the implementing child back with the captured failure, and rerun the same criterion, including its cleanup. Continue only when the next criterion has a concrete expected-evidence target.

Name each adversarial class that the change does not trigger once in the `notes` field, as not applicable, with a one-line reason.

### Goal completion

- Non-final goal: every essential criterion needs a current passing capture. Call `checkpoint` with `status: "complete"`, and name the captures in `evidence`.
- Final goal (every other live goal is already complete): every live criterion needs a current passing capture, and the final quality gate runs. Then call `checkpoint` `complete` with `qualityGatePath`.
- Validation batch closer: every batch member must be complete, and the closer needs a gate that covers its members.
- Failed or blocked: call `checkpoint` with `failed` or `blocked` and diagnosis evidence. A `blocked` checkpoint blocks the whole loop. Stop and report it until the user resolves the cause and runs `/ulw-loop resume`.
- After a complete checkpoint, call `complete_goals` for the next goal.

## Freshness and binding

- Inside a Git work tree, every capture binds to the full `git rev-parse --verify HEAD^{tree}` id and needs a clean tracked tree at capture and at completion, research goals included. The tool refuses when tracked files are dirty (`ULW_LOOP_DIRTY_TRACKED`) or when HEAD cannot be resolved (`ULW_LOOP_GIT_FAILED`). A delivery goal outside a Git repository is refused (`ULW_LOOP_GIT_REQUIRED`).
- Outside a Git work tree, research goals bind artifact hashes and dated sources only.
- A capture is current only when all four hold. It belongs to the goal's current attempt. Its criterion revision is the current definition. Its tree binding matches the current tree. Each artifact still matches its recorded `sha256`. `criteria` reports `fresh` for each criterion.
- An identical tree after a rebase or amend keeps a capture current. A changed tree makes it stale.
- Captures are append-only. A new result is a new capture. Never edit or delete an old capture.
- A commit or tree hash does not cover external dependencies, service state, credentials, configuration outside the tree, generated inputs, or environment. Record those relevant inputs with what each artifact exercised. If they change, rerun the affected proof, including consuming/importer paths, even when `criteria` still reports `fresh`; that field cannot inspect external state. Preserve unaffected observations without claiming their stronger loop binding was waived.
- Any tree change still invalidates every capture bound to the old full tree, regardless of ordinary ultrawork's narrower per-target reuse rule. Rerun all captures the loop marks stale at the new tree, not merely checks for edited files.

## Manual QA channels

Use the surface the criterion names. Every artifact must be non-empty.

- **HTTP.** Run `curl -i` through `bash` against the live endpoint. Keep the status line, the headers, and the body.
- **CLI and TUI.** Run the real program through `bash`, in a pty when interaction matters. Keep the input, the output, and the exit status. For a claim about color or layout, use the `browser` tool on a rendered terminal page when one is available. A plain text dump does not prove color or layout.
- **Browser.** Use the `browser` tool on the real page. Capture screenshots at desktop and mobile widths, plus the action log. Use an authenticated profile only when the user has authorized it. Never clear cookies or site data, and never install a second browser harness to get around access limits.
- **Desktop or GUI.** Drive the running app through the available GUI surface. Capture screenshots, and several angles for a spatial claim.
- **CLI data or configuration.** Captured stdout, a parsed state diff, or a generated artifact counts when the criterion is data-shaped. Capture the command's real output, not the command text.

These are not evidence: a printed command, `--dry-run`, "should respond", "looks correct", or a passing test suite alone. Baseline `lint`, `typecheck`, and `test` runs are necessary, but they never prove completion.

Start a named service with a `ready` probe, or a finite long command with `bash` `async: true`. Record ownership and teardown at creation, including command temp/cache roots as described above. Completion notifications arrive automatically; `wait` is for blocked work you started, not polling.

## Research goals

- Before each investigation, read this goal's prior findings and open hypotheses; extend them instead of reinvestigating an answered question. A research criterion passes on a cited answer whose source check is observable, cited as `file:line`, command output, or URL plus dated revision.
- Research needs source proof rather than an irrelevant UI/HTTP scenario or a commit with no code change. Resource-free research skips teardown; any browser context, service, temporary root, or cache it actually creates follows the same ownership/cleanup rules. Git-tree freshness still applies when the research runs inside a Git work tree.
- Track hypotheses in the rationale of `annotate_ledger` as `HYPOTHESIS[id]: <claim> | status: open`. Change the status to `confirmed` or `refuted` only on an observed source.
- Keep hypotheses inside the user's question. A hypothesis that widens the scope goes to the user as a proposal first. Add it as a goal only with their approval.
- `/ulw-research` reuses this loop's goals and criterion ids when a loop is active. It never creates an aggregate of its own. Mirror its findings through `steer` `annotate_ledger`.

## Final quality gate

The gate runs only at the closer of the final goal, or at the closer of a validation batch. It has two parts: real-surface or source QA, and one independent review. This gate supersedes ordinary ultrawork review, including its extra review lanes; do not stack a second pipeline.

1. **Targeted verification.** Run the checks the changed behavior needs. Keep their output as artifacts.
2. **Freeze.** Make no edits, rebases, or commits until the gate is recorded. If a fix is needed, go back to step 1 after the fix. Call `criteria` for each gated criterion. Re-run QA for any criterion whose capture is stale at the frozen tree.
3. **Manual QA.** Run final QA yourself through the real surfaces, even when a worker performed per-criterion QA earlier. For research, perform the cited source checks. Write `<currentAttemptDir>/qa-report.md` with each criterion, exact invocation/inputs, observation, artifact paths, and applicable cleanup receipts.
4. **Independent review.** Spawn exactly one fresh reviewer child with `task`, agent `deep-high`, or `task` when unavailable. Its self-contained `TASK`, `DELIVERABLE`, `SCOPE`, `VERIFY`, and `STOP WHEN` assignment includes the objective, original brief, criteria, diff range, current captures, relevant input changes, and accessible physical QA/evidence paths. Explicitly authorize any named checks it must run. It writes `<currentAttemptDir>/gate-review.md` and ends with `PASS` or criterion-cited blockers. The reviewer must be a child of this session, not the session itself. Inspect the final native result, including errors or aborts, and the report before accepting its verdict: the runtime's child-ancestry check does not authenticate the truth of PASS. A timeout, missing/empty report, `BLOCKED:` line, or inconclusive terminal result is a blocker.
5. **Gate file.** Call `checkpoint` with `printTemplate: true` to get the current shape. Write the JSON file outside the repository, in `currentAttemptDir`, using the capture ids from `criteria` and real file paths.
6. **Checkpoint.** Call `checkpoint` with `status: "complete"` and `qualityGatePath` set to that file. If it refuses, read the error code, then fix the part of the file the code names.
7. **Fixes.** Any change after freeze restarts the gate. Rerun every proof made stale by the loop's full-tree binding and any further proof invalidated by changed external inputs; record new captures without relabeling old output. **Spawn a new reviewer child for each re-review**, never resume the previous reviewer. Give it the delta, prior eligible blockers, fresh captures and QA report, with already-approved criteria out of scope unless invalidated. Keep a separate report such as `<currentAttemptDir>/gate-review-1.md` for each attempt and point the gate file to the actual latest reviewer/report. Re-review at most twice, then go to step 8.
8. **Blocked review.** Call `record_review_blockers` with the final goal's id, a title, the repair objective, the evidence, and the artifacts. It blocks the goal and appends one repair goal. Report it to the user.

Gate file shape:

```json
{
  "version": 1,
  "treeHash": "<full HEAD^{tree} the gate was reviewed at; include it for delivery>",
  "criteriaCoverage": [
    { "goalId": "G001", "criterionId": "C001", "captureId": "capture-<id from criteria>" }
  ],
  "qa": {
    "reportPath": "/abs/path/to/currentAttemptDir/qa-report.md",
    "entries": [
      {
        "goalId": "G001",
        "criterionId": "C001",
        "kind": "real-surface",
        "artifactPath": "/abs/path/to/artifact.txt",
        "observation": "curl -i returned 200 and the body matched the schema"
      }
    ]
  },
  "review": {
    "agentId": "<id of the reviewer child>",
    "reportPath": "/abs/path/to/currentAttemptDir/gate-review.md",
    "verdict": "PASS",
    "blockers": []
  }
}
```

- `kind` is `real-surface` for delivered behavior and `research-source` for cited research claims.
- Coverage must include every criterion that the closer covers, each with a current capture.
- Every artifact and report the file names must exist and be non-empty.

## Steering

Use `steer` only for a structured, evidence-backed change. A natural-language request to change the plan is a question for the user, not a steer.

Every steer call sends `op: "steer"`, `source: "finding"`, `evidence` (what you observed), `rationale` (what changes and why), and the fields for its `kind`. Send one proposal per call, in dependency order. Each call is atomic: it is accepted whole or rejected with reasons, and nothing is applied in part.

| `kind` | Extra fields | Use |
|---|---|---|
| `add_subgoal` | `title`, `objective`, `shape`, `tier`, `criteria` | A defect inside the change's blast radius, a regression the change introduced, an invalid proof, or a real blocker. A defect outside that radius goes to the user as a tracked issue, not a goal. |
| `split_subgoal` | `targetGoalId`, `childGoals` (one or more goal seeds) | The goal is too large to finish as one. The target must be pending. |
| `reorder_pending` | `pendingOrder` (the complete list of pending goal ids, in order) | A dependency order was discovered. |
| `revise_pending_wording` | `targetGoalId`, and at least one of `revisedTitle` or `revisedObjective` | The title or objective is ambiguous. The target must be pending. |
| `revise_criterion` | `goalId`, `criterionId`, and at least one of `scenario`, `expectedEvidence`, `userModel` | A criterion has no observable PASS. The criterion gets a new revision, and its old captures no longer count as current. |
| `annotate_ledger` | none | Tier triage, assumed defaults, hypotheses, excursion notes, and audit notes. |
| `mark_blocked_superseded` | `targetGoalId`, optional `childGoals`, optional `blockedReason` | New evidence replaces an old goal. Replacement goals go in `childGoals`. |

A goal seed is `{ title, objective, shape: "delivery" | "research", tier: "LIGHT" | "HEAVY", criteria: [ { scenario, expectedEvidence, essential?, userModel? } ] }`.

Example input for `revise_criterion`:

```json
{"op":"steer","kind":"revise_criterion","source":"finding","goalId":"G002","criterionId":"C001","expectedEvidence":"status line and body saved to health-response.txt","evidence":"The seeded criterion named no artifact.","rationale":"A named artifact makes the proof checkable."}
```

`add_goal` appends a goal the user asked for. A goal that a finding requires goes through `steer` `add_subgoal`, so that it carries its evidence and rationale.

## Constraints

1. Never call the `goal` tool to create, complete, drop, or resume a goal. The plugin owns the driver. A user's `/goal` complete or drop proves nothing about the criteria. Report it and stop automatic work.
2. Complete the aggregate only through a final `checkpoint` that carries a passing gate. Never mark completion in prose.
3. Never hand-edit loop state. Never pass a session id, store path, or ledger path to any op.
4. Never mark a criterion pass from memory. Never relabel, pin, refresh, or regenerate old output to match a new tree.
5. Evidence must come from a real surface. A printed command, `--dry-run`, or "looks correct" never counts.
6. Leftover owned disposable QA state (a live process, session, browser context, port, or temporary path) is never PASS. Clean it up and record the receipt. A resource-free scenario needs none; open-PR worktrees and their ancestors use the explicit retained-owner rule, not destructive cleanup.
7. Commit each verified delivery unit before its capture. Never commit broken code. Never stash, reset, or check out to clean the tree.
8. Children run no builds or tests unless their `VERIFY` names them.
9. At a safety boundary (a destructive command, secret exfiltration, or a production write), checkpoint `blocked`, surface the boundary, and offer a safe substitute.
10. The loop never changes host settings or model roles. A disabled `goal.enabled` refuses the start, and you tell the user to enable it.
11. `stop` does not cancel running children. Say so, and never claim that they stopped.

## Stop rules

- Stop when the final checkpoint completes. Report, and stop. Do not run extra review cycles or regenerate evidence.
- Three identical failures on one criterion: checkpoint `failed`, and report the diagnosis.
- Five cycles on one goal without its required criteria passing: checkpoint `failed`, and report the diagnosis.
- A safety boundary or a true impasse: checkpoint `blocked`, stop, and surface it. Waiting on a running child is not a block.
- The driver is paused, budget-limited, foreign, or missing: stop and report it. Never take over another native goal.
- The user runs `/ulw-loop pause` or `/ulw-loop stop`, or interrupts the turn: stop dispatching. Do not resume unless the user runs `/ulw-loop resume`.
- Plan Mode turns on: the loop yields. Exit Plan Mode before the loop continues.

## Driver and host behavior

- Continuation comes from the owned native goal and the host's goal controller. Mutating ops need the owned goal active and the loop active. Otherwise they return `ULW_LOOP_DRIVER_NOT_ACTIVE` or `ULW_LOOP_NOT_ACTIVE`. Tell the user to run `/ulw-loop resume`.
- A `goal_updated` event that shows the driver paused, budget-limited, completed, dropped, or replaced pauses the loop. Unfinished criteria stay unfinished.
- Final acceptance is recorded first. Then the owned native goal is completed. If that native completion is still pending, `status` says so, and the user's `/ulw-loop resume` restores ownership. No foreign goal is ever completed.
- Starting or resuming is refused while another native goal owns the session (`ULW_LOOP_FOREIGN_GOAL`), including one created by `/audit`.

## After compaction or restart

Call `status`. It returns the stored brief, the goals, the driver relation, and the next actions. Then call `criteria` for the active goal and follow `nextActions`. Do not re-plan from scratch or repeat completed captures.

If the state file cannot be read, the loop pauses with `ULW_LOOP_STATE_INVALID`. Preserve the file, report it, and never initialize over it.
