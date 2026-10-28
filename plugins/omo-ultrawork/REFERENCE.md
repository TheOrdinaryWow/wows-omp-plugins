# omo-ultrawork reference

English | [简体中文](REFERENCE.zh.md)

## Keyword detection

- Triggers are case-insensitive literal workflow words outside code, blockquotes, straight/curly quoted spans, injected mode/pointer/reminder blocks, relay headers, URLs and English negated-invocation clauses. Path/identifier/hyphen/dot neighbours are rejected without breaking literals such as configured `c++`. Slash commands use their registered handlers, not keyword activation.
- Pasting a complete `<ultrawork-mode>…</ultrawork-mode>` block arms the session without injecting the directive twice.
- Child sessions and extension-generated messages are ignored.
- `orchestrate` suppresses injection only when OMP would act on it: the keyword is enabled and the `task` tool is active.
- `orchestrate` uses the host-parity scanner separately: quote/negation suppression for workflows must not hide a keyword the host itself would activate.
- Pointers return independent `{target,intent}` values. Targets are `mass-ulw`, `prometheus`, `ulw-loop`, `ulw-research`; intent is `mention` or `binding`. Plan/loop are always conditional. Mass/research bind only positive leading `run|start|use|do|execute` forms with allowed connectors or the exact upstream Korean request endings, never questions (including `？`); bare `meth` is mention-only. URLs are masked before question detection. No Chinese semantic-intent classifier is added.
- `ulw plan`, `ulw-plan`, `ulwplan` suggest user-entered `/prometheus`; no hook activates Plan Mode. Loop mentions suggest the explicit command. Binding research uses the same private payload builder as `/ulw-research`, including pinned assets, scratch-root settings, native acquisition companions and active-loop-only reuse. Discussion does not load the procedure. Composites deduplicate their targets/procedure.

## Directive delivery

When persistent mode is turned on, the directive arrives:

- with arguments (`/ultrawork fix X`): queued, with the arguments sent as your next message;
- without arguments while idle: with your next message;
- mid-turn: joined to the running turn.

Turning the mode off queues a hidden exit notice. Each message in persistent mode gets the short reminder, or the full directive after compaction. `/ultrawork <request>` submits the request only when the mode was off.

Ordinary-input instructions and pointers are returned through the host's input transform, preserving images and associating queued research with its own request. They are not sent as a steering aside to work already running. Explicit toggle commands keep their existing immediate/next-message behavior. Turning `/ulw` off does not pause or stop an explicitly active loop.

While armed, the first `todo init` or `todo append` triggers one hidden reminder asking the agent to size independent work and explain its delegation choice. Compaction resets that reminder.

The footer clears on exit or when you switch to a session that is not armed. Switching or shutting down does not clear an armed session's saved state.

## Agents used by the commands

`/hyperplan`: the scope critic (`skeptic`) uses `task`, the integration critic (`validator`) uses `task` with `effort: "hi"`, and the evidence (`researcher`), architecture (`architect`) and alternatives (`creative`) critics use `deep-low`, `ultrabrain` and `artistry` when those agents are listed. Without `deep-low` the debate runs without the evidence critic; a missing `ultrabrain` or `artistry` falls back to `task`. The planner uses `ultrabrain`, or `task`.

`/ulw-research`: mechanical work goes to `sonic`, bounded judgment to `task`, and high-effort work to `task` with `effort: "hi"`. `scout` does local discovery, `librarian` (or `scout`) does source research, and `writing` (or `task`) proofreads; other category agents fall back to `task`. The helper scripts are dependency-free Node CLIs under `assets/ulw-research/scripts/`, called by absolute path.

`metis` is used only inside Prometheus planning, and `momus` outside planning only for explicit Atlas compliance checks.

Work that needs a full review follows its governing plan. Independent compliance, code-quality and real-surface QA reports may run in parallel, and the final evidence-gate reviewer starts once those reports exist. Light work gets a scoped self-review and real-surface proof without parallel reviewers.

## mass-ulw persistence

Status lives in `local://mass-ulw/<run-key>.json` and reports in `local://mass-ulw/<run-key>/<id>.md`. Both survive a kernel reset, but a saved `running` handle cannot be reattached to `wait` and must be reconciled before more work is dispatched. `done` only means a child returned. Retrying or amending some nodes leaves the other `done` reports intact.

## Durable loop contract

The plugin creates one native goal from a durable run-marked intent, then binds its exact id. OMP's goal controller owns continuation/accounting/budgets; no `session_stop` driver or custom scheduler is installed. The `ulw_loop` tool owns typed subgoals and immutable criterion/evidence history. It is discoverable, with read approval for help/status/criteria/template and write approval for mutations. Payloads reject extra fields and caller-provided session/store identities. Tool envelopes are `{ok:true,op,result,nextActions,warnings?}` or `{ok:false,op,error:{code,message}}`.

| Operation | Payload and behavior |
| --- | --- |
| `help` / `status` | Help includes cached reference text; status includes state, fresh/stale counts, exact driver relation, evidence root, current attempt directory and next actions. |
| `create_goals` | `{briefPath,objective,goals,validationBatches?}` reads/copies the authoritative brief. Requires user `/ulw-loop` authorization and refuses an existing decomposition. |
| `complete_goals` | `{retryFailed?}` acquires/resumes exactly one eligible goal. Failed attempts retry only explicitly; blocked/superseded goals do not restart. A completed loop returns `aggregateComplete:true` read-only; no eligible work in an unfinished loop returns false. |
| `criteria` | `{goalId}` returns definitions, revision/attempt-bound captures and current freshness. |
| `record_evidence` | `{goalId,criterionId,status:"pass"|"fail"|"blocked",evidence,artifacts,notes?}` validates non-empty files and copies/hashes the evidence. Pass needs at least one artifact. |
| `checkpoint` | `{goalId,status:"complete"|"failed"|"blocked",evidence,qualityGatePath?}` or `{printTemplate:true,goalId?}`. Failure/blocking preserves diagnostics; final/batch acceptance requires the authoritative gate file. |
| `steer` | `{kind,source:"finding",evidence,rationale,...fields}` applies one validated atomic steering proposal; see below. |
| `add_goal` | A fully specified goal seed; stable ids never change when pending work is reordered. |
| `record_review_blockers` | `{goalId,title,objective,evidence,artifacts}` blocks the target and appends a repair goal atomically. Finishing repair reopens the target for fresh acceptance. |
| `pause` / `resume` / `stop` | `{reason?}` manages only the owned driver. Model resume cannot recreate a missing/completed native goal; user `/ulw-loop resume` can. Stop never reports success or child cancellation. |

A goal seed is `{title,objective,shape:"delivery"|"research",tier:"LIGHT"|"HEAVY",criteria:[{scenario,expectedEvidence,essential?,userModel?:"happy"|"edge"|"regression"|"adversarial"}]}` with at least one concrete criterion. `essential` defaults true and `userModel` defaults happy. Store ids are `G001…` and per-goal `C001…`. Validation batches are `{id,goalIds,finalGoalId}` with unique valid members and a member closer.

Steering kinds and fields: `add_subgoal` takes a goal seed; `split_subgoal` takes pending `targetGoalId,childGoals`; `reorder_pending` takes the complete `pendingOrder` permutation; `revise_pending_wording` takes pending `targetGoalId` plus at least one `revisedTitle,revisedObjective`; `revise_criterion` takes `goalId,criterionId` plus at least one `scenario,expectedEvidence,userModel`; `annotate_ledger` has no additional fields; `mark_blocked_superseded` takes `targetGoalId,childGoals?,blockedReason?`. Criterion revision invalidates the old effective pass without rewriting history. Replacement relations and validation-batch links are retained.

The canonical v1 state is `<getSessionDir()>/ulw-loop/<getSessionId()>/state.json`; it includes intent/id, goal attempts, criteria, copied-artifact hashes, gates, events and completion notification state in one atomic JSON write. Mutations serialize through an in-process queue and short exclusive disk lock. Missing initialized, corrupt, unknown-version or mismatched state refuses continuation rather than reinitializing. File-backed v1 resume is tested; later format changes must upgrade shipped versions on load. `getSessionDir()===""` refuses a durable loop before writing anything in the project. Only user `/ulw-loop reset` archives state/evidence; there is no model force/reset flag.

The host session also retains `wows-omp-omo-ultrawork.loop-driver` v1 `{version:1,runId,goalId,objective}` as a minimal ownership binding, not a second criterion authority. If the canonical store is corrupt or missing, recovery pauses a native driver only when its id and exact run-marked objective match that binding; an unrelated goal or `/audit` stays untouched. The store is never overwritten to make recovery appear successful.

Each capture binds its criterion definition revision and acquired goal attempt. Git capture/completion requires clean tracked files and the full `HEAD^{tree}` (never commit id or short stamp). An unchanged tree after rebase/amend stays fresh; changed tree, source/report bytes, captured bytes, criterion or attempt makes the effective pass stale. Untracked evidence files are hashed too. No automatic stash/reset is performed. Non-Git research uses artifact hashes; Git delivery requires a committed Git HEAD. Non-final checkpoints require essential fresh criteria; final checkpoints recheck every current criterion and declared intermediate batch gates.

Final/batch gate file shape (paths are real filesystem paths, relative to the session cwd when not absolute):

```json
{
  "version": 1,
  "treeHash": "<full HEAD tree id; omit only for non-Git research>",
  "criteriaCoverage": [{ "goalId": "G001", "criterionId": "C001", "captureId": "<current capture>" }],
  "qa": {
    "reportPath": "qa.md",
    "entries": [{ "goalId": "G001", "criterionId": "C001", "kind": "real-surface", "artifactPath": "observed-output.txt", "observation": "<actual observation>" }]
  },
  "review": { "agentId": "<distinct OMP child of this session>", "reportPath": "review.md", "verdict": "PASS", "blockers": [] }
}
```

Research-shaped QA entries use `kind:"research-source"`. Every covered report/artifact must exist and be non-empty; the gate references the exact current capture for every criterion. The plugin proves binding, hashes and presence, not the truth of arbitrary prose: the lead still checks final native child/job success and actual observations. It does not introduce Atlas assignment/receipt authentication. Final acceptance commits first, then completes only the owned native goal and persists notification state. `ulw-loop:completed` v1 `{version:1,sessionId,runId,revision}` is output-only; historical completion is not re-emitted.

A foreign live/paused goal blocks start/resume. Native pause, budget limit, user completion/drop, foreign id and Plan Mode pause unfinished work without taking over the other owner. Intent recovery accepts only the exact run-marked objective; a similar-looking goal is not ownership. `/audit` and the loop therefore cannot share an active driver. `/goal` user actions remain usable, but model `goal complete` is blocked while this loop's criteria are unfinished. An approved Atlas plan retains its own ledger and isolation; ordinary ultrawork uses the loop journal instead of another notepad. The plugin keeps the existing todo-result rewrite hook and adds only the necessary native-completion tool-call guard; no passive result hook is added.

## Research storage and fidelity contract

`#src/research-assets` exports `RESEARCH_UPSTREAM_PIN` and `materializeResearchAssets(sessionDir) -> Promise<{directory,pin,digest,durable}>`. Module import caches scripts, references, attribution, and the private procedure bytes. The snapshot key combines the full upstream pin with a SHA-256 digest of sorted `{path,bytes,sha256}` entries; `manifest.json` is version 1 and lists those entries. Materialization stages files in the same parent, atomically renames the complete directory, and validates the manifest, exact inventory, and every file hash. Existing corrupt or mixed snapshots fail closed rather than being silently replaced. Concurrent initial materializations converge on the same validated directory.

Persisted sessions use `<sessionDir>/ulw-research-assets/<pin>-<digest>/`; the value comes from the host, never a reconstructed home path. Empty session directories use `<os tmpdir>/wows-omp-plugins-<uid-or-username>/ulw-research-assets/<pin>-<digest>/` with private 0700 owner-checked parent directories. The latter returns `durable:false`: it is not a durable session store. The separate research journal remains a real filesystem path under the configured scratch root because Node/Bun cannot resolve `local://`.

Outcome manifests use `OUTCOME_SCHEMA_VERSION = 2`; `SCHEMA_VERSION = 1` continues to govern repair-state and its attempt/plateau/time history. Loading outcome v1 preserves timestamps, promises/deliveries, render paths, non-fidelity gate statuses, residuals, repairs, source counts, and harmless optional fields. It sets fidelity `not_run`, records `legacyFidelity:{upgradedFrom:1,status:"legacy_unverified"}`, and marks historical delivered rows `fidelityStatus:"legacy_unverified"`. Read-only status/briefing does not rewrite the old bytes; the next successful mutation atomically writes v2. Historical deliveries remain delivered, but no legacy marker exempts a resumed/re-delivered edition from the fidelity barrier. `outcome set` creates a new row without inherited legacy fidelity status.

Fact ledgers, fidelity-state, claim indexes, fill maps, pairs, and run-local calibration start at their upstream v1 schemas; fidelity/meaning/conversion records retain upstream field names and strict envelopes. `verifiedBy` binds a delivery to its exact `artifact_sha256`; `renderedFrom` names the verified source of PDF/DOCX. Newest matching-byte meaning records win, with more severe equal-time records winning. Missing readers, required strong coverage, malformed verdict fragments, stale/mismatched records, and unresolved registry blockers/majors prevent delivery. Neither repair exhaustion nor an explicit dispute clears that barrier.

The scripts have no runtime npm dependencies. Their executable behavioral tests and fixtures live under repository `src/omo-ultrawork-research/`, not in the shipped plugin; module-lifetime, schema migration, and representative Chinese fact/quote regressions have separate repository tests. English/Korean normalization is upstream behavior, not a claim of universal-language parsing.


## State snapshot

The main session publishes `omo-ultrawork.json` in the shared snapshot envelope (see the [repository reference](../../REFERENCE.md)):

```json
{ "kind": "omo-ultrawork/mode", "version": 1, "mode": true, "armed": true }
```

`mode` is the persistent toggle; `armed` means the directive is already in session context. `state` is `null` when both are false. The snapshot follows resume and branch navigation. `mass-ulw` files and research scratch files are separate from it.

Without a UI, command feedback arrives as custom messages of type `wows-omp-omo-ultrawork.command-status`.
