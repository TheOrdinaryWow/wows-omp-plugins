> **Modified-port notice and license.** This reference is a modified OMP port of oh-my-openagent ulw-loop material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Full loop procedure

This reference covers the bootstrap, the execution cycle, evidence freshness, manual QA, research goals, the final quality gate, steering, constraints, and stop rules. `SKILL.md` has the command and tool table. `define-goal.md` has the objective and criteria rules. Read this file in full before your first dispatch.

## Bootstrap

Make no edits, dispatches, or checkpoints until these steps are done.

1. Call `status`. Confirm `driver.owned` is true and note `evidenceRoot`. If the driver is missing, foreign, or paused, or the loop is paused, blocked, or stopped, report it and follow `nextActions`.
2. Gather context with read-only lookups. Batch independent lookups in one `task` call: `scout` for code mapping, `librarian` for external documentation (or `scout` when `librarian` is not listed). Read the descriptions of the skills that match the work, and name the ones you will use.
3. Write the brief as described in `define-goal.md`, under The brief file. It holds the user's request verbatim, every stated constraint, the out-of-scope items, and the owner decisions already made.
4. Shape the goals and criteria per `define-goal.md`. Set the tier (`LIGHT` or `HEAVY`) and the shape (`delivery` or `research`) for each goal. When unsure, choose HEAVY.
5. Call `create_goals` with the brief path, the objective, the goals, and any validation batches. Then call `status`.
6. Record tier triage and each `assumed:` default with `steer`, `kind: "annotate_ledger"`. The evidence names the repository fact or user statement behind the choice. The rationale names the default and whether it is reversible.
7. Name the assumed defaults in your first user-visible report, so the user can veto one with a single line.

For a HEAVY goal, split its criteria into atomic tasks, where an implementation and its test count as one task. Put tasks with no dependency between them in the same wave. Split waves only along real dependencies. Each task names the criterion it serves, its QA scenario, and its evidence path.

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
3. **Dispatch.** Send independent units in one `task` batch. Send dependent units in a later batch. Each prompt starts with `TASK:` and names `DELIVERABLE`, `SCOPE`, `VERIFY`, and `STOP WHEN`. The prompt also carries the criterion text, the files in scope, the project rules, the checks to run in `VERIFY`, and the artifact path the child must write.
4. **Integrate.** When a child returns, read its final result first. An error, an abort, or any non-success result means the unit is not done, even when output exists. Read the diff yourself, run the checks in your own plan, and send the child back with the specific failure when the change drifts or the evidence is missing. Do not hand-patch around a failure.
5. **Commit.** Load `skill://git-master` before you commit. Inspect recent commits and the touched paths, then commit only this unit's files in the repository's style. Commit each verified unit on its own. Never commit broken code. Commit before you capture, because every capture in a Git work tree needs a clean tracked tree.
6. **Execute the scenario.** Run the criterion's real-surface scenario yourself, or dispatch one QA child whose only job is to drive the channel and write the artifact. Write artifacts under `currentAttemptDir` from `status`. Record the exact invocation and the expected observable before you run it.
7. **Clean up.** Stop what you started: processes, services, browser sessions, ports, and temp paths. Put a cleanup receipt in the artifact, showing the stop commands and their read-back output. A missing receipt makes the result BLOCKED, not PASS.
8. **Record.** Call `record_evidence` as soon as the artifact exists. Use `pass` only when the artifact shows the expected observable. Otherwise use `fail` or `blocked`, with notes. Record from the artifact you just wrote, never from memory.
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

## Manual QA channels

Use the surface the criterion names. Every artifact must be non-empty.

- **HTTP.** Run `curl -i` through `bash` against the live endpoint. Keep the status line, the headers, and the body.
- **CLI and TUI.** Run the real program through `bash`, in a pty when interaction matters. Keep the input, the output, and the exit status. For a claim about color or layout, use the `browser` tool on a rendered terminal page when one is available. A plain text dump does not prove color or layout.
- **Browser.** Use the `browser` tool on the real page. Capture screenshots at desktop and mobile widths, plus the action log. Use an authenticated profile only when the user has authorized it. Never clear cookies or site data, and never install a second browser harness to get around access limits.
- **Desktop or GUI.** Drive the running app through the available GUI surface. Capture screenshots, and several angles for a spatial claim.
- **CLI data or configuration.** Captured stdout, a parsed state diff, or a generated artifact counts when the criterion is data-shaped. Capture the command's real output, not the command text.

These are not evidence: a printed command, `--dry-run`, "should respond", "looks correct", or a passing test suite alone. Baseline `lint`, `typecheck`, and `test` runs are necessary, but they never prove completion.

Start a service with a `ready` probe, or with `bash` `async: true`. Record its teardown as soon as you start it.

## Research goals

- A research criterion passes on a cited answer. Its scenario is the source check the question needs. Its expected evidence is the source itself, cited as `file:line`, command output, or URL, plus the dated revision.
- Skip QA channels, cleanup, and commits for research goals. Source observability still applies: never write "looks correct".
- Track hypotheses in the rationale of `annotate_ledger` as `HYPOTHESIS[id]: <claim> | status: open`. Change the status to `confirmed` or `refuted` only on an observed source.
- Keep hypotheses inside the user's question. A hypothesis that widens the scope goes to the user as a proposal first. Add it as a goal only with their approval.
- `/ulw-research` reuses this loop's goals and criterion ids when a loop is active. It never creates an aggregate of its own. Mirror its findings through `steer` `annotate_ledger`.

## Final quality gate

The gate runs only at the closer of the final goal, or at the closer of a validation batch. It has two parts: real-surface or source QA, and one independent review.

1. **Targeted verification.** Run the checks the changed behavior needs. Keep their output as artifacts.
2. **Freeze.** Make no edits, rebases, or commits until the gate is recorded. If a fix is needed, go back to step 1 after the fix. Call `criteria` for each gated criterion. Re-run QA for any criterion whose capture is stale at the frozen tree.
3. **Manual QA.** Run the QA yourself through the real surfaces. Write a QA report at `<currentAttemptDir>/qa-report.md`, with each criterion, its observation, and its artifact paths.
4. **Independent review.** Spawn exactly one reviewer child with `task`, agent `deep-high`, or `task` when `deep-high` is not listed. Give it the objective, the criteria, the diff range, the evidence paths, and the QA report path. It writes `<currentAttemptDir>/gate-review.md` and ends with `PASS` or a list of blockers. The reviewer must be a child of this session, not the session itself. A timeout, a missing or empty report, a `BLOCKED:` line, or an inconclusive verdict counts as a blocker.
5. **Gate file.** Call `checkpoint` with `printTemplate: true` to get the current shape. Write the JSON file outside the repository, in `currentAttemptDir`, using the capture ids from `criteria` and real file paths.
6. **Checkpoint.** Call `checkpoint` with `status: "complete"` and `qualityGatePath` set to that file. If it refuses, read the error code, then fix the part of the file the code names.
7. **Fixes.** Any change after the freeze restarts the gate. Re-run only the proofs the change invalidated, record fresh captures, and have the reviewer check the delta. Re-review at most twice. After that, go to step 8.
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
6. Leftover QA state (a live process, session, browser context, port, or temp path) is never PASS. Clean it up, record the receipt, then continue.
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
