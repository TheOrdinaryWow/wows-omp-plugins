# omo-prometheus reference

English | [简体中文](REFERENCE.zh.md)

## Planning handoff

Only the planner's `ask` question with the header `Prometheus`, whose second option names Prometheus, counts as consent to switch an ordinary `/plan` session to Prometheus.

Both approval choices of a Prometheus plan hand off to Atlas. "Approve and execute" starts a fresh session, so the plugin writes a marker to `local://prometheus/<slug>.proposal.json` at proposal time and OMP copies it into the new session with the plan. Plans approved in ordinary Plan Mode have no marker and are left alone.

## Plan grammar

- `## Tasks`: rows `- [ ] T<n>. <title>` numbered from `T1`, each with indented `Agent:`, `Depends on:`, `Acceptance:` and an optional `Tier: LIGHT | HEAVY` (case-insensitive). A missing tier means LIGHT, so older plans keep their behavior. Any other value or a repeated field is a parse error. The other body lines the planning skill requires (`Closes:`, `References:`, `Mechanisms:`, `QA happy:`, `QA failure:`, `Commit:`) are read by children and reviewers only; the parser ignores them.
- `## Final gates`: exactly F1–F4 with their fixed titles.
- `Delivery: direct | pr | ship`: one plain line at column 0, outside code fences, lists, `## Tasks` and `## Final gates`. A duplicate, an unknown value, or a `Delivery:` line inside those sections is a parse error. No line means `direct`.

The plan writes only T and F rows; Atlas appends D, X and P1 rows. The `delivery` setting (`ask | direct | pr | ship`, default `ask`) reaches the planner as `<delivery-policy mode=...>`; the plan's `Delivery:` line governs execution.

## Atlas tool guard

The guard admits only tools that observe the session or change host-owned state; apart from `atlas_git commit`, none writes to the workspace. It enables nothing: a tool missing from your session stays unavailable.

| Tool | Allowed in the Atlas parent |
| --- | --- |
| `task`, `wait`, `todo`, `think`, `web_search`, `atlas_ledger`, `atlas_release` | always |
| `ask` | only when no row is in progress or dispatchable (see the ask guard below) |
| `atlas_git` | always: `status`, `diff`, `log`, `show`, and `commit` of named files (see below) |
| `read`, `find`, `glob`, `grep`, `ast_grep` | always; `read` refuses `ssh://` |
| `lsp` | read-only actions, and `code_actions` without `apply` |
| `github` | `repo_view`, `file_read`, `search_*`, `run_watch` |
| `debug` | state inspection only (`threads`, `stack_trace`, `scopes`, `variables`, `output`, …), never `launch`, `continue` or breakpoints |
| `ida` | `list` |
| `recall`, `reflect`, `retain`, `memory_edit`, `learn`, `manage_skill` | always: they write memory backends and managed skills, not the workspace |
| `goal`, `context_notes`, `new_context` | always |
| `write` | `agent://` peer messages, `proc://<id>/kill`, and `xd://` dispatch of any admitted tool |

Everything else is blocked, including `bash`, `eval`, `edit`, `ast_edit`, file writes, `security_scan` and `checkpoint`/`rewind` (rewinding would branch the session tree away from the receipts that prove completed rows). Tools registered by other extensions or MCP servers are blocked even when they share a native tool's name, unless listed below.

`atlas_git` is the Atlas session's only git surface; there is no shell behind it. Atlas commits with it in two cases: files a roadmap or ADR step changed, and finished work a child left uncommitted. `commit` takes the exact files and a message Atlas writes, so your `RULES.md` commit conventions apply. It stages and commits only those files, refuses directories and pathspec magic, and refuses while any bound child task is still running. Inspection never runs external diff drivers, textconv filters or pagers; commit hooks run as usual, and a failing hook leaves the files staged. The tool is active only while Atlas executes, and refuses any caller other than the executing Atlas main session.

| Integration | Admitted tools |
| --- | --- |
| [Magic Context](https://github.com/cortexkit/magic-context) | `ctx_reduce`, `ctx_expand`, `ctx_search`, `ctx_memory`, `ctx_note`, only when registered by an extension; same-named MCP tools stay blocked |
| Extension wrappers of `todo`, such as [omp-herdr-dag](../omp-herdr-dag/README.md)'s edge-aware `todo` | `todo`, when an extension re-registers it; an MCP `todo` stays blocked |
| [roadmap](../roadmap/README.md) | `roadmap_*`, called directly or as `write xd://roadmap_*`, only from the extension source path verified by the roadmap binding handshake (see [Roadmap contract](#roadmap-contract)) |
| [adr](../adr/README.md) | `adr_*`, called directly or as `write xd://adr_*`, only from the extension source path verified by the ADR binding handshake (see [ADR contract](#adr-contract)); independent of `roadmap` |

## Task dispatch

Every `task` call from the Atlas parent is either bound or research:

- A **bound** call carries exactly one `atlas_assignment` line per task: `{"rows": {...}}` binds started T, D, X, F or P1 attempts, and `{"verify": {"T3": "…"}}` binds one HEAVY row's verification attempt. Gates and verifiers each need their own child with the `outputSchema` from `atlas_ledger` and `schemaMode: "strict"`. A row whose implementation is already recorded refuses another implementation dispatch.
- A **research** call carries no `atlas_assignment` line. Each task names an agent from the live roster whose definition restricts tools to `read`, `find`, `grep`, `glob`, `ast_grep` and `web_search` (plus the host's `yield`); an agent without a `tools` list is refused. Extra `tools` are refused, `metis` and `momus` stay plan-gated, and research needs a valid ledger. It gets no row and never completes one. Mixing bound and research tasks in one call is refused.

Isolation follows the host settings. While `task.isolation.enabled` is on, every T, D, X and P1 dispatch must pass `isolated: true`; gates, verifiers and research children may go either way. Host patch merges apply an isolated child's work to the checkout uncommitted and drop its commits, so when `task.isolation.merge` is `patch`, the first isolated dispatch switches it to `branch` as a runtime override and says so once. Atlas exit, a switch to a session that is not executing, and session shutdown restore it; the saved setting is never written.

Gates and verifiers return their verdicts through the host's structured task results. The `task` tool offers `outputSchema` and `schemaMode` only while `task.structured` is on, and it is off by default, so while Atlas executes it turns `task.structured` on as a runtime override and says so once. The same events restore it. The schema may arrive as an object or as its JSON text, which the host parses; models on providers with strict tool schemas, such as OpenAI Responses, can only send the text.

## Agent fallbacks

Prometheus plans and Momus reviews against the agents the session's `task` tool lists. A user-defined agent is valid only if listed.

At dispatch, the requested agent is tried first, then its fallbacks, from the live list only:

| Requested agent | Fallback chain |
| --- | --- |
| `deep-low`, `deep-high`, `ultrabrain`, `architect`, `visual-engineering`, `artistry`, `writing` | `task` |
| `librarian` | `scout` → `task` |
| `metis`, `momus`, `oracle` | `reviewer` → `task` |
| `sonic`, `scout`, `reviewer`, `security-reviewer` | `task` |
| `task` | none |

Fallbacks change the agent only; model-role chains are in the [omo-toolkit README](../omo-toolkit/README.md#agents). If nothing in a chain can be spawned, the ledger shows `unavailable` and Atlas picks the best fit from the live list when it starts the row (`atlas_ledger start` with `agent`); it reports a blocker only when that list is empty. A verifier defaults to `deep-high` (fallback `task`); `atlas_ledger verify` with `agent` picks another listed agent other than `metis` or `momus`.

## Plan matching

A plan argument matches the display label, the original name, or either one without the `-plan` suffix. Use the full ID when names collide. A plan whose name starts with a subcommand word stays reachable by ID or through `/atlas start`.

## Plan bundle

Native approval creates a bundle at `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/`, usually `~/.omp/agent/sessions/<working-dir>/atlas/`. Moving a session does not move its `atlas/` directory.

```text
plan.md          exact approved plan
approval.json    source approval, workspace, plan identity and roadmap stage (version 3)
ledger.json      row progress, deferred findings, owner rulings and durable retry windows (version 9), plus Git HEAD at approval
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of the immutable approval
checkpoint.json  independent attempt and receipt bindings, including verification attempts (version 2)
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

While Atlas owns a plan, the session's plan reference is `atlas://<plan-id>/plan.md`, a read-only view of the approved `plan.md` for child agents. Other sessions cannot read it, and it stops resolving if the plan bytes change.

## Ledger

The ledger tracks each row's acceptance criteria, dependencies, status, requested and resolved agent, tier, attempt and evidence receipt, plus the plan's SHA-256, its delivery mode, the out-of-scope findings (`O1`, `O2`, … in recorded order, each with its triage once recorded) and the owner rulings (`R1`, `R2`, … in recorded order, each naming a T, D or X row, the complete acceptance text now in force for it, a `decidedBy` of `user` or `setting`, a note holding the user's decision when there was one, and when it was confirmed). A row's own `acceptance` stays the approved plan's text; the latest ruling naming the row is the acceptance it is judged against, and every ruling is a deviation from the approved plan that the owner approved, by you or by `atlasAmend`. Rows come in this order:

| Rows | Origin | Waits for |
| --- | --- | --- |
| `T1…` | the approved plan | their `Depends on:` rows |
| `D1…` | `discover` scope `in`, before any gate has started; each names the T or D row whose work surfaced it | nothing |
| `X1…` | `fix` after F1–F4 or P1 rejected the work; `origin` names that row | nothing |
| `F1`–`F4` | the approved plan | every T and D row, plus their own X rows |
| `P1` | `Delivery: pr` or `ship` | every gate and every X row |

Atlas drives it with `atlas_ledger`:

| Action | Effect |
| --- | --- |
| `status` | Every row with its acceptance in force (marked `amended by Rn` when a ruling replaced the plan's text), owner rulings, deferred findings with their ids and triage, delivery mode and dispatchable rows. |
| `start` | Reserves an open row whose prerequisites are done and returns its attempt binding; gates also get their `outputSchema`, a HEAVY row its last verification failure. |
| `done` | Records authenticated final native success. LIGHT rows/P1 finish; HEAVY records implementation then needs verifier PASS. Gate/verifier FAIL or INCONCLUSIVE archives a diagnostic, charges the window, and reopens or blocks the row rather than throwing away the mutation. |
| `verify` | HEAVY row with recorded implementation: binds a distinct fresh verifier and strict schema (`rowId`, `planSha256`, `attempt`, `verdict`, `summary`, `evidence`, optional `failure: {failureClass, check, firstError}`). Old outputs without failure details remain valid; non-PASS defaults to counted unknown. Live native work must settle before replacement. |
| `fail` | With `id`, inspected `evidence`, `check`, `firstError`, optional `failureClass` (product/harness/unknown) and owned `childAgentId`, authenticates a terminal native generation and records it once. The child id may be absent only for a correlated native pre-spawn failure. No success receipt is minted. |
| `retry` | Exhausted row plus changed hypothesis in `evidence`: outside-lock owner confirmation (or the `atlasRetry` decision), then ownership/history/unchanged-acceptance recheck; appends a new window and reopens only this row. Decline, changed attachment or live children grant nothing, and without a dialog only an approving setting grants. |
| `discover` | `scope: "in"` appends a D row (title, acceptance, reason, optional agent and tier), refused once a gate has started or a fix row exists; `scope: "out"` records the next deferred finding `O<n>` with no row, at any time. |
| `triage` | Records where the deferred finding named by `id` went, with the reference in `evidence`; a later triage replaces it. `todo`: the Roadmap TODO id (`T` and at least three digits), only when the roadmap is usable in this repository. `duplicate`: what it duplicates. `wontfix`: the reason. `report`: only when no roadmap is usable in this repository; the reference is optional. Usability is the `usable` flag of a fresh roadmap binding answer; no answer means no roadmap, and an older roadmap's answer without the flag accepts either `todo` or `report`. |
| `fix` | Appends an ordinary tiered X row for rejecting F1–F4 or P1; reopens only its origin. P1 depends on every X exactly once; X never depends on P1. An exhausted source cannot create automatic repairs without a retry grant. |
| `block`, `reopen` | Affect only the named row; completed dependents keep their proof. |
| `amend` | Records an owner ruling for the T, D or X row named by `id`: `acceptance` is the complete replacement text, `evidence` the note. Refused for gates, P1, unknown rows and rows in progress. Settlement follows `atlasAmend`. With the default `ask`, the plugin shows you the row, the acceptance currently in force, the proposed one and the note in a confirmation dialog before writing; a declined dialog records nothing, and without a UI the tool refuses and names `/atlas exit` plus a revised plan through `/prometheus` as the path. `approve` records the ruling with no dialog, marked `decidedBy: "setting"`; `decline` records nothing and never shows a dialog; `ask-then-approve` and `ask-then-decline` show the dialog for `atlasAskTimeout` minutes, then apply their value. The row's status, other rows and passed gates are untouched. `status`, `start` and `verify` show the acceptance in force marked `amended by Rn`; the `start` results of F1 and F4 and every `verify` result list all rulings. |

A row is done only with proof from the child's real final result; a failed, foreign or still-running child, or a hand-written reference, cannot complete work. A HEAVY row also needs a passing receipt from a different child created after verification started. Verification status (`pending`, `running`, `passed`, `failed`) is derived, never stored. `atlas_release` needs a valid receipt for every row, the verifier receipts of HEAVY rows, a triage for every deferred finding (it names the untriaged ones), and the release confirmation. That confirmation follows `atlasRelease` (default `ask`, a dialog): `ask-then-approve` and `ask-then-decline` decide after `atlasAskTimeout` minutes, and `approve` and `decline` never show a dialog. A declined release keeps Atlas active until `/atlas exit`. Plan completion and `atlas:completed` never wait for triage.

Child success outputs and original receipts are copied into `evidence/` and rechecked against their digests, so verified progress survives deleting the originating session. Terminal diagnostics (including failed verifiers) are copied as `failure-<outcome-digest>.md` and referenced with their digest from the versioned ledger; they provide context, never completion authority or checkpoint bindings. Missing/changed success proof reopens only that row. On resume, HEAVY retains a valid implementation and drops only an unfinished verifier binding. Checkpoint stays version 2; approval bytes are unchanged.

### Retry windows and delivery repair

Optional per-row `retry.windows` stores `openedAt`, terminal failures (native `outcomeKey`, implementation/verification attempts, tool call/session/child identities, timestamp, class, raw check/error, normalized signature, inspected evidence and copied-output path/digest), the one harness-repair reservation, an optional stop reason/time and owner grant note/time. Counts are derived, not duplicated counters. New windows preserve earlier windows. Normalization removes volatile ANSI/timestamp/temp-root/labelled-id/duration fields, not ordinary assertion values, error codes or repository-relative paths.

Each retry window's `grant` records `decidedBy`: `user` when you confirmed it in the dialog, `setting` when `atlasRetry` granted it. Setting-granted windows count per row against `atlasAutoRetryLimit` (default `1`, `0` unlimited). Past the limit, `approve` acts as `decline` and `ask-then-approve` as `ask-then-decline`; you can still grant in the dialog. Atlas receives the policy in a `<decision-policy>` tag and requests grants directly when a setting can approve, instead of asking through `ask` first.

The second consecutive identical counted signature or third counted failure stops; product and unknown count. One evidenced harness non-exercise failure is uncounted; its next repair dispatch consumes the reservation, and any second harness failure stops. T/D/X product work stops after four hours from accepted native dispatch, including session absence. Each gate rerun gets a fresh dispatch clock; waiting for its X rows is untimed. A HEAVY row's recorded implementation is not timed while awaiting a verifier; the verifier's accepted dispatch starts a fresh clock. Verifier expiry blocks the row but retains its authenticated implementation receipt, and an owner grant resumes verification rather than reimplementation. P1's passive CI/review waiting is exempt. Expiry is persisted during owned recovery before a requested mutation can refuse, checked on resume/host return/continuation and work operations, not by a real-time scheduler. Live child ids are reported for cancellation and native-settlement observation. Reopen, amendments, replacement children or X creation never reset failure history; known native failures must be recorded before replacement. Semantic acceptance failure and harness classification still require evidence inspection by Atlas. Pending remote work, deliberate reproductions, cancellation and owner-only blockers do not themselves count as failed product cycles.

Stored failure signatures are historical facts: v8 loading validates their shape, not equality with the current normalizer. Recorded failures and stop history survive a process restart. Native dispatch/outcome observations that have not yet been recorded with `fail` are process-local: restarting forgets those unrecorded failures and they do not consume the durable retry budget. This is not restart-proof accounting of unrecorded native outcomes.

Retain and inventory attributable unverified commits/files when stopped; do not roll them back or mark partially complete. Every row remains required for release/delivery. `ship` failures create P1-origin X rows, normal tiers and fresh affected tests/consuming-surface QA (HEAVY additionally verified), then a fresh P1 child reuses the PR and checks current-head repository-required checks/reviews with no unresolved blocking change request before merge. Never self-approve. `pr` hands off without merge. Missing human approval/access or ambiguous branches is an external blocker; remote state is inspected by the delegated child, not a provider-specific plugin client. Native task branch integration and isolation are unchanged.


Continuation is a hidden `<atlas-continuation>` message with the ledger summary, sent at most eight times per message from you; two in a row without progress stop the loop and notify you. When nothing can move without you, because every unfinished row is blocked or waits on a blocked row, the continuation lists each blocked row with its recorded reason and tells Atlas to `ask` you, so the session waits for your answer instead of ending with a question in chat.

Ledgers from earlier releases upgrade lazily on load: v7 becomes v8 preserving rulings, triage, receipts and approved plan/approval bytes, with no invented failure history or inferred first-dispatch time; prospective accounting starts at the next accepted bound dispatch. Reading alone does not rewrite a previous-format bundle; the next mutation writes v8. Before v7 rulings start empty; before v6 deferred findings get stable O ids and start untriaged; before v5 rows remain LIGHT and delivery comes from the approved plan; checkpoint v1 upgrades to v2 and older approvals remain byte-identical. Pre-shared session-local ledgers still need fresh approval. No tool aliases are retained.

Ledgers at versions 1 to 8 upgrade to version 9 on load. Their existing retry-window grants and owner rulings all went through the dialog, so they become `decidedBy: "user"`.

`timeline.jsonl` is display-only: a missing or damaged timeline never affects approval, ownership, receipts or progress. Bundles from earlier releases show history derived from their ledger, never written back. A crash-truncated final line and unknown future event kinds or versions are ignored.

## Final gate inputs

F1 reads the hash-verified `plan.md` (its path is printed when F1 starts), the ledger summary, and read-only Git evidence since the plan's baseline commit (`git diff --stat`, `git log --oneline`, `git status --short`) or a plain "unavailable". `momus` runs F1 with `review_kind: compliance`. Only a matching structured `PASS` counts. Gate children report and never fix.

## Ownership

While native child work is running, its session keeps ownership of the plan until that work reports a final result, and other sessions cannot write to it. When another agent wakes a finished child and that turn ends without `yield`, the host reports no native result for it: the turn stops holding the plan once the host reports it finished, and its output never counts as evidence. A plan can be recovered when its owning session has provably died; recovery is refused when ownership is unclear or belongs to another host. When a child's end cannot be confirmed, for example after its wake job was cancelled, the plan stays owned until the original OMP process exits. Research children never hold ownership. Deleting a plan is refused while a live session owns it or native work is pending.

## Session integration

- Todo mirror: Atlas keeps session todo phases in step with the validated ledger, in row order: `Atlas tasks`, `Atlas discovered` and `Atlas fixes` when present, `Atlas final gates`, and `Atlas delivery` when the plan delivers. Other phases stay in place; don't edit Atlas phases by hand.
- Progress guard: while `todo` is active, task dispatch, wait and release require a non-view todo refresh after row changes. An unrecorded final result blocks unrelated dispatch/wait; inspect and record `done`, `fail`, or an external `block` first. Known native failures require `fail` before replacement, block, reopen or source repair; successful native results with failed acceptance also require `fail` by orchestration policy. Native observations are process-local, but recorded retry history survives restart. Expired stopped generations cannot authorize completion or hold a granted window hostage after terminal settlement.
- Ask guard: `ask` holds the whole session until you answer, so no finished child is recorded and no row dispatched meanwhile. While any row is in progress or dispatchable, Atlas's `ask` is refused with the rows that can still move. The refusal holds the question back without downgrading it: a question that some plausible answer would turn into a different deliverable, acceptance, scope or irreversible step is recorded with `block` on its row, and only a question every answer leaves valid goes into Atlas's reply with the assumption it proceeds under. `ask` becomes available once every unfinished row is blocked or waits on a blocked row. An unusable ledger never refuses `ask`.
- Session title: Atlas asks OMP's title generator for a title starting with "Atlas", else uses `Atlas: <plan name>`. A name set with `/rename` is never replaced, and `PI_NO_TITLE` disables this.
- Without a UI, bare `/atlas` prints the plan list, or the running plan with its rows; if entering a plan fails, the session stays paused until `/atlas exit` and Atlas never falls back to prompt-only execution. Output arrives as `wows-omp-omo-prometheus.command-status` messages. In RPC, bare `/atlas` while Atlas is active shows a summary with Keep running, View details (a read-only `editor` dialog with the plan text) and Exit; widget lines are sent at most twice a second.

## State snapshot

The main session publishes `omo-prometheus.json` in the shared snapshot envelope (see the [repository reference](../../REFERENCE.md)). `state` is `null` while neither planning nor Atlas is active. Otherwise:

```json
{
  "kind": "omo-prometheus/state",
  "version": 1,
  "phase": "planning | awaiting-approval | executing",
  "planFilePath": "local://… (planning only)",
  "atlas": {
    "planId": "…", "name": "…", "paused": "reason, when execution is paused",
    "status": "In progress 1/6", "done": 1, "total": 6, "startedAt": 1760000000000, "runningChildren": 1,
    "rows": [{ "id": "T1", "title": "…", "status": "open | in_progress | done | blocked",
               "kind": "task | discovered | fix | gate | delivery", "agent": "task", "dependsOn": [], "attempt": "…",
               "startedAt": 0, "evidence": "…", "origin": "F1", "tier": "light | heavy",
               "verification": { "status": "pending | running | passed | failed" },
               "child": { "id": "…", "status": "running", "currentTool": "read" } }],
    "gates": [{ "id": "F1", "title": "…", "status": "done", "evidence": "…" }],
    "discoveries": [{ "id": "D1", "title": "…", "status": "open", "origin": "T2" }],
    "deferred": 1,
    "delivery": "direct | pr | ship"
  }
}
```

`awaiting-approval` covers the time between a proposal and the approval choice. `atlas` appears only while executing; a paused plan may carry only `planId` and `paused`. A gate with status `done` has passed. `tier` appears on T, D and X rows and `verification` on HEAVY rows only. Session switches and shutdown leave an executing session's file as it was.

## Herdr DAG contract

With `herdrDag` enabled, `omp-herdr-dag` observes this session's bound Atlas plan through `pi.events`. All payloads are plain JSON with `v: 1` and do not change Atlas bundle formats.

| Event | Direction and payload |
| --- | --- |
| `herdr-dag:hello` | Viewer to producer: `{v:1, sessionId, requestId}`. |
| `atlas:hello` | Synchronous reply preserving `requestId`, with the bound plan identity (`id`, `name`, `planFilePath`, `cwd`) when present; also sent unprompted when an unbound session starts or switches. |
| `atlas:snapshot` | After every hello with a bound plan and every live update: plan identity, ledger status and totals, rows with dependency and origin metadata, per-row child progress, the last 50 timeline events. |
| `atlas:released` | Detach with `reason: "exit"`, `"session-switch"` or `"shutdown"`, followed by a hello without a plan. |

Each snapshot row has a `kind` derived from its id: `task` (T), `discovered` (D), `fix` (X), `gate` (F) or `delivery` (P). `origin` names the rejecting gate **or P1** of an X row and the source row of a D row. Rows may carry `tier` and `verification: {status}`; verifier summaries are not published. While a HEAVY row is verified, its `attempt` is the verification attempt. P1-origin fixes use ordinary fix/dependency events, never a false `gate_failed`; the v1 snapshot/timeline formats are unchanged.

Startup order does not matter. Unsupported versions and unknown sessions are ignored. Last-known child progress stays visible after a row finishes and clears on a new attempt. A release only detaches the plan from the view. With `herdrDag: false` nothing is emitted, including hello replies.

## Roadmap contract

With `roadmap` installed, Prometheus uses `pi.events` contracts independent of `herdrDag`. Every payload has `v: 1`. A request carries `sessionId` and a fresh `requestId`; an answer counts only when it arrives synchronously inside the request, for the same session and request, and a malformed answer is dropped. No answer means the roadmap plugin is absent or older.

1. Binding. When Prometheus checks a proposal and again when it records it, it emits `roadmap:binding-request {v, sessionId, requestId}` and accepts a `roadmap:binding` reply carrying `repoRoot`, `toolSourcePath`, an optional bound stage `{id, title, round, criteria?, revision?}` and an optional `usable` boolean. The bound stage is active, or still planned when the planning session started it in plan mode, which only binds. `criteria` lists the stage's current done-criterion ids; `revision` is roadmap's opaque planning-basis hash. `usable` says whether roadmap tools, `roadmap_todo` included, can work in this repository now: a Git work tree with an initialized roadmap and the adr plugin connected. Deferred-finding triage asks afresh and follows it. Replies from releases that send none of `criteria`, `revision` and `usable` are accepted.
2. Coverage. When the bound stage lists `criteria`, the plan needs exactly one plan-level line such as `Roadmap criteria: DC1, DC3` (column 0, outside `## Tasks`, `## Final gates` and code fences) naming unique ids that are all current criteria. The `write xd://propose` call is refused before the approval dialog opens when the line is missing, repeated, empty, malformed, misplaced or names another id; the refusal lists the current ids. Without a bound stage, or when the binding has no `criteria`, the line is optional and is neither validated nor stored.
3. Storage. The proposal marker (version 4) and the approval (version 3) record `roadmapStage: {repoRoot, id, criteria?, revision?}`: `criteria` only when declared against a binding that listed criteria, `revision` whenever the binding carried one. Version 3 markers and version 1 and 2 approvals still load and resume.
4. Tools. Atlas admits `roadmap_*` tools, `roadmap_upgrade` included, only from the extension source path equal to `toolSourcePath`; a refusal says whether the handshake is missing or the tool comes from another source. Within that boundary every roadmap action the plan needs is allowed.
5. Plans. Prometheus answers `atlas:plans-request {v, sessionId, requestId, repoRoot, stage?}` for its own main sessions with `atlas:plans {v, sessionId, requestId, plans}`, read synchronously from the shared plan store with no locks or writes. Each plan has `planId`, `name`, `repoRoot`, `stage`, the declared `criteria` and approval `revision` when recorded, `status` (`unfinished` or `complete`), `done`, `total`, `gates` (verified verdicts and summaries, empty until complete), `delivery: {mode, summary}` once P1 is done, `deferred` (`id`, `title`, and `disposition` and `reference` once triaged) and the bundle `directory`. Only bundles whose approval records a stage in that `repoRoot` (and that stage, when given) are listed; unreadable bundles are skipped with a warning, and a session without a session directory answers with no plans. Plans bound to a stage only at completion are not listed.
6. Drift. When a plan is entered with `/atlas <plan>` (or resumed by switching to its session) and when it completes, Prometheus emits `roadmap:stage-request {v, sessionId, requestId, repoRoot, stage}` and accepts a `roadmap:stage` answer whose optional `stage` carries `id`, `title`, `round`, `status`, current `criteria` and `revision`. When that revision differs from the approval's, the user sees a notice naming the stage and its current criteria, and the completing `atlas_ledger` result repeats it for the final report. Drift never pauses execution; approvals without a revision get no notice.
7. Activation. Before every row-bound `task` dispatch of a plan whose approval records a stage, Atlas sends the same `roadmap:stage-request`. A `stage.activation` of `{action: "start"}` (the stage is still planned) or `{action: "commit", files}` (the stage is active but its start is not committed; `files` are non-empty repository-relative paths) refuses the dispatch, naming the `roadmap_stage` start or the `atlas_git commit` it needs. While activation is owed, `ask` is not held back, so a refused start can reach the user. A malformed `activation` invalidates the whole answer; no answer, or an answer without `activation`, owes nothing.
8. Completion. After the ledger write that first completes a stage-bound plan, Prometheus emits `atlas:completed {v:1, sessionId, planId, roadmapStage: {repoRoot, id}, gates, delivery?, at}` with verified gate verdicts and summaries. A plan is complete only when every row is done: with `Delivery: pr` or `ship` the event follows P1 and carries `delivery: {mode, summary}`; with `direct` it follows the gates. A plan approved without a stage uses the stage bound in the executing session at that moment; `atlas:plans` does not list it, so roadmap's close reminder counts its completion as a complete plan with undeclared coverage. Roadmap records a pending-close reminder; the session still evaluates and closes the stage itself.

Completion events are deduplicated per producer instance only, so a restart followed by reopening and recompleting a plan can emit again. Roadmap deduplicates pending-close entries by `planId` per receiving session.

## ADR contract

With `adr` installed, Atlas admits the ADR tools through their own `pi.events` handshake, independent of `roadmap` and `herdrDag`:

1. When Atlas calls an `adr_*` tool, directly or as `write xd://adr_*`, Prometheus emits `adr:binding-request {v:1, sessionId, requestId}` and accepts only a synchronous `adr:binding` reply with `v: 1`, the same session and request, and an absolute `toolSourcePath`. A confirmed answer is cached for the session and forgotten at shutdown; a missing one is asked again on the next call.
2. Prometheus uses only `toolSourcePath`. The reply's `api` object serves `roadmap` and is never read or called by Prometheus.
3. Atlas admits `adr_*` tools only from the extension source path equal to the ADR `toolSourcePath`; a refusal says whether the handshake is missing (check that the adr plugin is installed and enabled) or the tool comes from another source. Each family is verified only through its own handshake: the roadmap binding never admits an `adr_*` tool, and the ADR binding never admits a `roadmap_*` tool.
