---
name: ulw-loop
description: "Procedure for the durable ulw-loop: criterion-gated goals, Git-tree-bound evidence, checkpoints, and steering through the ulw_loop tool. Load it when /ulw-loop is active or the user asks to inspect, steer, pause, resume, or finish one."
---

> **Modified-port notice and license.** This skill is a modified OMP port of oh-my-openagent ulw-loop material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# ulw-loop: durable, criterion-gated goal loop

A loop turns one user-authorized request into goals with binary success criteria, proves each criterion with captured evidence, and completes only when the criteria allow it. The `ulw_loop` tool owns the state. OMP's native goal drives continuation. `todo` shows only the current step.

Before you change any goal or criterion, read `skill://ulw-loop/references/define-goal.md`. Before your first dispatch, read `skill://ulw-loop/references/full-workflow.md` in full.

## Authority

- Only the user starts a loop, with `/ulw-loop <goal>`. Reading this skill never starts, takes over, or completes one. Without a loop, the tool answers `ULW_LOOP_NOT_STARTED`; tell the user to run `/ulw-loop <goal>`.
- The command creates the loop and its native driver goal together. You never create, complete, drop, or resume a native goal yourself. Reading the native goal with `goal` `get` is fine.
- One loop per session. A completed loop is read-only, and unrelated work belongs in a new session. There is no force option.
- Start is refused, and you should say why, when the session is a child agent (`ULW_LOOP_MAIN_ONLY`), Plan Mode or vibe mode is on, `goal.enabled` is off, or a live or paused native goal such as `/audit` owns the session (`ULW_LOOP_FOREIGN_GOAL`). An approved Atlas plan keeps control of its own subtasks; do not start a loop for them.
- Only the user runs `/ulw-loop reset`. It archives the state and evidence, deletes no proof, and you never choose it.
- State lives at `<session dir>/ulw-loop/<session id>/state.json`, with captured evidence under `evidenceRoot`. Never edit it by hand. Never pass a session id, store path, or ledger path to any op. In-memory sessions refuse the loop (`ULW_LOOP_PERSISTENCE_REQUIRED`); tell the user to open a persisted session.
- If the canonical store is corrupt or missing, stop and report the error. A minimal binding in the host session lets recovery pause only this loop's exact owned driver; it never pauses a foreign goal. Do not repair by replacing the store or relabeling old evidence.

## Commands

- `/ulw-loop <goal>`: creates the loop and its native driver, then submits this procedure with the request. It does not switch Plan Mode or approve anything.
- `/ulw-loop` or `/ulw-loop status`: shows the status and next actions.
- `/ulw-loop pause`, `/ulw-loop resume`, `/ulw-loop stop`: manage this loop only. `stop` records a stop, not success, and does not cancel running children. `resume` restores the owned driver after a pause, a yield, or a lost driver.
- `/ulw-loop reset`: user only.

## The `ulw_loop` tool

One tool, discriminated by `op`. Each call returns `{ok, op, result, nextActions, warnings?}` on success or `{ok:false, op, error:{code,message,details?}}` on failure. Read `nextActions` after every call, branch on `error.code`, fix the input, and retry. An error never reinitializes state. Call `help` for exact schemas, including the seven steering kinds.

| `op` | Payload beyond `op` | Use |
|---|---|---|
| `help` | none | Exact schemas and steering fields. |
| `status` | none | Loop state, fresh and stale criterion counts, driver relation, `evidenceRoot`, `currentAttemptDir`, next actions. Call it first after any context loss. |
| `create_goals` | `briefPath`, `objective`, `goals`, optional `validationBatches` | Seeds the goals once. Refused when goals already exist (`ULW_LOOP_GOALS_EXIST`). Ids such as `G001` and `C001` are assigned by the store. |
| `complete_goals` | optional `retryFailed` | Acquires the next eligible goal, or resumes the one in progress. On a completed loop it changes nothing and returns `aggregateComplete: true`. |
| `criteria` | `goalId` | Criteria with their evidence history and freshness. |
| `record_evidence` | `goalId`, `criterionId`, `status` (`pass`, `fail`, `blocked`), `evidence`, `artifacts`, optional `notes` | Captures one result. A `pass` needs at least one non-empty artifact. |
| `checkpoint` | `goalId`, `status` (`complete`, `failed`, `blocked`), `evidence`, optional `qualityGatePath`; or `printTemplate: true` | Closes a goal. A final or batch closer needs `qualityGatePath`. `printTemplate` prints the gate shape. |
| `steer` | `source: "finding"`, `evidence`, `rationale`, `kind`, plus the kind's fields | One atomic, evidence-backed change per call. |
| `add_goal` | `title`, `objective`, `shape`, `tier`, `criteria` | Appends a fully specified goal the user asked for. A goal a finding requires goes through `steer` `add_subgoal`. |
| `record_review_blockers` | `goalId`, `title`, `objective`, `evidence`, `artifacts` | Blocks the goal and appends one repair goal in the same step. |
| `pause`, `resume`, `stop` | optional `reason` | Manage this loop only. |

Example input for `create_goals`:

```json
{"op":"create_goals","briefPath":"/abs/path/outside/repo/brief.md","objective":"...","goals":[{"title":"...","objective":"...","shape":"delivery","tier":"LIGHT","criteria":[{"scenario":"...","expectedEvidence":"...","essential":true,"userModel":"happy"}]}]}
```

## Run contract

1. Confirm ownership: `status` must show `driver.owned: true`. If it does not, stop and report it.
2. Survey the skills and gather context as `full-workflow.md` describes under Bootstrap.
3. Write the brief to a plain file outside the repository, as `define-goal.md` describes.
4. Shape the objective, goals, and criteria per `define-goal.md`. Every default you chose goes into the objective as `assumed:`, and into your first report so the user can veto it.
5. Call `create_goals`, then `status`.
6. Run the execution loop in `full-workflow.md` until the final checkpoint completes or a stop rule holds.
7. Report the outcome, each criterion with its evidence path, the assumed defaults, blockers, and cleanup receipts.

Keep `todo` live with one `in_progress` item that names the current criterion. The loop state replaces the notepad: do not open a `local://ultrawork/...-notepad.md` for this run.

## Evidence rules

- Inside a Git work tree, every capture binds to the full `HEAD^{tree}` and needs a clean tracked tree at capture and at completion, research goals included. Commit verified work first; the tool refuses otherwise (`ULW_LOOP_DIRTY_TRACKED`). Delivery goals outside a Git repository are refused (`ULW_LOOP_GIT_REQUIRED`). Never stash, reset, or check out to clean the tree.
- Outside a Git work tree, research goals bind artifact hashes and dated sources only.
- A capture stays current only while its goal attempt, criterion revision, tree binding, and artifact hashes still match. Change makes it stale. Re-run the proof at the current tree and record a new capture. Never relabel, pin, or regenerate old output.
- A child's completion is not acceptance. Read its final result, including errors and aborts, and the proof it names, before you record a pass.

## Delegation

- Use the native `task` tool only. Use `scout` for broad code mapping, `librarian` for external documentation when it is listed (otherwise `scout`), `sonic` for mechanical edits, `task` for bounded judgment, and `deep-high` for hard review.
- Every prompt starts with `TASK:` and names `DELIVERABLE`, `SCOPE`, `VERIFY`, and `STOP WHEN`. Children do not see this conversation, so paste in what they need.
- Children do not run builds or tests unless `VERIFY` names them.
- Parallel children get disjoint write scopes. Dependent work waits for the wave it depends on.
- For a child that edits files, set `isolated: true` when the `task` schema offers it. Read what the child reports it changed, then verify the result yourself.
- Steer a child with `write agent://<id>`, read its output with `read agent://<id>`, and use `wait` only while blocked on children you started.

## Continuation and host

Continuation comes from OMP's goal controller and the user's settings. The loop never forces settings and never changes model roles. A session with no goal controller does not continue on its own. Say so, and tell the user what to send next.

## Coexistence

- An active loop owns the objective. Ordinary `ulw` adds no native goal and no second notepad. Turning `ulw` off does not stop the loop; use `/ulw-loop pause` or `/ulw-loop stop`.
- `/ulw-research` reuses an active loop's goals and criterion ids. It never creates an aggregate of its own.
- Audit findings are evidence inputs, not criterion passes. Map their observations to criteria yourself.

## References

- `references/define-goal.md`: objective quality bar, criteria construction, weak-goal repair, the brief file, registration.
- `references/full-workflow.md`: bootstrap, execution cycle, freshness, QA channels, research goals, the final quality gate, steering, constraints, stop rules, host behavior.

If a `skill://ulw-loop/references/...` read fails, for example because the plugin was upgraded during this session, call `ulw_loop` `help`. It returns the reference text cached when the plugin loaded. Never work from memory of a reference you cannot read.
