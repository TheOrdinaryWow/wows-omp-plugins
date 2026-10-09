# omo-prometheus reference

English | [简体中文](REFERENCE.zh.md)

## Planning handoff

Only the planner's `ask` question with the header `Prometheus`, whose second option names Prometheus, counts as consent to switch an ordinary `/plan` session to Prometheus.

Both approval choices of a Prometheus plan hand off to Atlas. "Approve and execute" starts a fresh session; to survive that switch, the plugin writes a marker to `local://prometheus/<slug>.proposal.json` when the plan is proposed, and OMP copies it into the new session with the plan. Plans approved in ordinary Plan Mode have no marker, and the plugin leaves them alone.

OMP stays in charge of `xd://propose` approval and autosave. The plugin creates no project-local `.omo` state and runs children through OMP's native execution.

## Plan grammar

The ledger reads these parts of an approved plan; every other heading and line is prose for people and agents.

- `## Tasks`: rows `- [ ] T<n>. <title>` numbered from `T1`, each with indented `Agent:`, `Depends on:`, `Acceptance:` and an optional `Tier: LIGHT | HEAVY` (case-insensitive). A missing tier means LIGHT, so plans approved before tiers existed keep their behavior; Prometheus writes the field for every new plan. Any other tier value or a repeated field is a parse error.
- `## Final gates`: exactly F1–F4 with their fixed titles.
- `Delivery: direct | pr | ship`: one plain line at column 0, outside code fences, lists, `## Tasks` and `## Final gates`. At most one is allowed; a duplicate, an unknown value, or a `Delivery:` line inside those sections is a parse error. No line means `direct`.

The plan writes only T and F rows. Atlas appends D, X and P1 rows at runtime.

## Atlas tool guard

The guard admits only tools that observe the session or change host-owned state; none of them writes to the workspace. The table enables nothing: a tool missing from your session stays unavailable.

| Tool | Allowed in the Atlas parent |
| --- | --- |
| `task`, `wait`, `todo`, `ask`, `think`, `web_search`, `atlas_ledger`, `atlas_release` | always |
| `read`, `find`, `glob`, `grep`, `ast_grep` | always; `read` refuses `ssh://` |
| `lsp` | read-only actions, and `code_actions` without `apply` |
| `github` | `repo_view`, `file_read`, `search_*`, `run_watch` |
| `debug` | state inspection only (`threads`, `stack_trace`, `scopes`, `variables`, `output`, …), never `launch`, `continue` or breakpoints |
| `ida` | `list` |
| `recall`, `reflect`, `retain`, `memory_edit`, `learn`, `manage_skill` | always: they write memory backends and managed skills, not the workspace |
| `goal`, `context_notes`, `new_context` | always |
| `write` | `agent://` peer messages, `proc://<id>/kill`, and `xd://` dispatch of any admitted tool |
| `hub` | observing ops and `send` to agents, never process input |

Everything else is blocked, including `bash`, `eval`, `edit`, `ast_edit`, file writes, `security_scan` and `checkpoint`/`rewind`. Rewind would branch the session tree away from the task receipts that prove completed ledger rows. Tools registered by other extensions or MCP servers are blocked even when they share a native tool's name, unless listed below.

| Integration | Admitted tools |
| --- | --- |
| [Magic Context](https://github.com/cortexkit/magic-context) | `ctx_reduce`, `ctx_expand`, `ctx_search`, `ctx_memory`, `ctx_note`, only when registered by an extension; same-named MCP tools stay blocked |
| Extension wrappers of `todo`, such as [omp-herdr-dag](../omp-herdr-dag/README.md)'s edge-aware `todo` | `todo`, when an extension re-registers it; an MCP `todo` stays blocked |
| [roadmap](../roadmap/README.md) | `roadmap_*`, called directly or as `write xd://roadmap_*`, only from the extension source path verified by the roadmap binding handshake (see [Roadmap contract](#roadmap-contract)) |

## Task dispatch

Every `task` call from the Atlas parent is either bound or research:

- A **bound** call carries exactly one `atlas_assignment` line per task. `{"rows": {...}}` binds started T, D, X, F or P1 attempts; `{"verify": {"T3": "…"}}` binds one HEAVY row's verification attempt. Gates and verifiers each need their own child with the `outputSchema` from `atlas_ledger` and `schemaMode: "strict"`. A row whose implementation is already recorded refuses another implementation dispatch.
- A **research** call carries no `atlas_assignment` line at all. Each of its tasks must name an agent from the live `task` roster whose definition restricts its tools to `read`, `find`, `grep`, `glob`, `ast_grep` and `web_search` (plus the `yield` tool the host adds); an agent without a `tools` list can use every tool and is refused. Research tasks cannot carry extra `tools`, `metis` and `momus` stay plan-gated, and research still needs a valid ledger. A research child gets no row, and its output can never complete one. Mixing bound and research tasks in one call is refused.

Isolation follows the host settings and the plugin never changes them. While `task.isolation.enabled` is on, every T, D, X and P1 dispatch must pass `isolated: true`; gates, verifiers and research children are not forced either way. When isolation is on and `task.isolation.merge` is `patch`, the first isolated dispatch in a session warns once that child commits will be squashed into one patch.

## Agent fallbacks

Prometheus plans against the agents the session's `task` tool lists after spawn policy and disabled-agent settings; Momus reviews against the same list. A user-defined agent is valid only if listed; an unlisted name needs a known fallback. If the tool description cannot be parsed, planning keeps known names as written but cannot check user-defined ones.

At dispatch, the requested agent is tried first, then its fallbacks, choosing only agents in the live list:

| Requested agent | Fallback chain |
| --- | --- |
| `deep-low`, `deep-high`, `ultrabrain`, `architect`, `visual-engineering`, `artistry`, `writing` | `task` |
| `librarian` | `scout` → `task` |
| `metis`, `momus`, `oracle` | `reviewer` → `task` |
| `sonic`, `scout`, `reviewer`, `security-reviewer` | `task` |
| `task` | none |

Fallbacks change the agent only; model-role chains are in the [omo-toolkit README](../omo-toolkit/README.md#agents). If nothing in a chain can be spawned, the ledger shows `unavailable` and Atlas picks the best fit from the live list when it starts the row (`atlas_ledger start` with `agent`). The pick is kept for that row until the requested agent or a fallback becomes spawnable again. Atlas reports a blocker only when the live list is empty. A verifier defaults to `deep-high` (fallback `task`); `atlas_ledger verify` with `agent` picks another listed agent other than `metis` or `momus`.

## Plan bundle

Native approval creates a bundle at `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/`, usually `~/.omp/agent/sessions/<working-dir>/atlas/`. Custom session directories are respected; moving a session does not move its `atlas/` directory.

```text
plan.md          exact approved plan
approval.json    source approval, workspace and plan identity
ledger.json      row progress (version 5), plus the workspace's Git HEAD at approval
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of the immutable approval
checkpoint.json  independent attempt and receipt bindings, including verification attempts (version 2)
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

While Atlas owns a plan, the session's plan reference is `atlas://<plan-id>/plan.md`, a read-only view of the approved `plan.md` that child agents load through OMP's plan handoff. Other sessions cannot read it, and it stops resolving if the plan bytes change.

## Ledger

The ledger tracks every row's acceptance criteria, dependencies, status, requested and resolved agent, tier, attempt and evidence receipt, plus the plan's SHA-256, its delivery mode, and the out-of-scope findings recorded for the final report. Rows come in this order:

| Rows | Origin | Waits for |
| --- | --- | --- |
| `T1…` | the approved plan | their `Depends on:` rows |
| `D1…` | `discover` scope `in`, before any gate has started; each names the T or D row whose work surfaced it | nothing |
| `X1…` | `fix` after a gate rejected the work | nothing |
| `F1`–`F4` | the approved plan | every T and D row, plus their own X rows |
| `P1` | `Delivery: pr` or `ship` | every gate and every X row |

Atlas drives it with `atlas_ledger`:

| Action | Effect |
| --- | --- |
| `status` | Every row, deferred findings, delivery mode and dispatchable rows. |
| `start` | Reserves an open row whose prerequisites are done and returns its attempt binding; gates also get their `outputSchema`, and a HEAVY row gets its last verification failure. |
| `done` | Records the real final result of the row's child. LIGHT rows, gates and P1 finish. A HEAVY row records its implementation and stays in progress; for its verifier, `PASS` finishes the row, `FAIL` reopens it with the verifier's summary, and `INCONCLUSIVE` changes nothing. |
| `verify` | For a HEAVY row with a recorded implementation: binds a distinct fresh verifier and returns its `{"verify": …}` binding and strict `outputSchema` (`rowId`, `planSha256`, `attempt`, `verdict`, `summary`, `evidence`). Calling it again replaces an unfinished verifier. |
| `discover` | `scope: "in"` appends a D row (title, acceptance, reason, optional agent and tier); refused once a gate has started or a fix row exists. `scope: "out"` records a deferred finding with no row, allowed at any time. |
| `fix` | Appends an X row (optional tier) for the rejecting gate and reopens only that gate. |
| `block`, `reopen` | Affect only the named row; completed rows that depend on it keep their proof. |

A row is done only with proof from the child's real final result, so a failed, foreign or still-running child, or a hand-written reference, cannot complete work. A HEAVY row additionally needs a passing verifier receipt from a different child created after verification started. Verification status (`pending`, `running`, `passed`, `failed`) is derived from the row and never stored. `atlas_release` needs a valid receipt for every row, the verifier receipts of HEAVY rows, and your explicit confirmation.

Child outputs are copied into `evidence/` and rechecked against their digests, so verified progress survives deleting the original session. `atlas_ledger status` shows where they are. Only the child's own output is kept, not files it links to; a failing verifier's output is not archived. If a row's proof goes missing or changes, the row reopens, and an old session branch cannot roll shared progress back. On resume, a HEAVY row whose implementation is recorded keeps it and only its unfinished verifier binding is dropped.

The continuation message is a hidden `<atlas-continuation>` with the ledger summary. Any message from you resets the continuation count.

A ledger written by an earlier release is upgraded on load, keeping verified progress. Version 5 rows from older ledgers are LIGHT, discoveries and deferred findings start empty, and delivery comes from the approved plan's `Delivery:` line, else `direct`; an older plan whose `Delivery:` text is not the new grammar delivers directly. Version 1 checkpoints upgrade to version 2 the same way. Ledgers before version 4 have no recorded Git baseline, so F1 dates one from the earliest recorded row start and says so. Plans from releases that kept the ledger inside the session are not migrated; resuming one pauses and asks for fresh approval. The old `prometheus_ledger` and `prometheus_release` tools are now `atlas_ledger` and `atlas_release`, with no aliases.

`timeline.jsonl` records attachment and release, row starts, completion, blocking and reopening, discovered and correction rows, recorded HEAVY implementations, verifier starts and verdicts, and gate verdicts. It is display-only: a missing or damaged timeline never invalidates approval, ownership, receipts or progress. Bundles from earlier releases show history derived from their ledger until real events are appended; derived events are not written back. A crash-truncated final line and unknown future event kinds or versions are ignored.

## Final gate inputs

F1 reads the hash-verified `plan.md` whose path the plugin prints when F1 starts (no inline plan copy), the ledger summary, and Git evidence collected read-only at that point: `git diff --stat`, `git log --oneline` and `git status --short` since the plan's baseline commit, or a plain "unavailable". `momus` runs F1 with `review_kind: compliance`. Only a matching structured `PASS` counts; a passing word in prose does not. Gate children report and never fix; F2 fails on any CRITICAL or HIGH finding, F3 needs a non-empty artifact for every `PASS`, and F4 approves unless it can cite a failed success criterion or ideal-state row.

## Ownership

While native child work is running, its session keeps ownership of the plan until that work reports a final result, and other sessions cannot write to the plan. A plan can be recovered when its owning session has provably died; recovery is refused when ownership is unclear or belongs to another host. Some hosts give no reliable signal that a child's final processing has finished, and a cancelled wake-up can settle before the child does; then the plan stays owned until the original OMP process exits. Research children are not tracked and never hold ownership.

Exit does not block closing the host. Deleting a plan is refused while a live session owns it or native work is pending.

## Session integration

- Todo mirror: Atlas maintains session todo phases from the validated ledger in row order: `Atlas tasks`, `Atlas discovered` and `Atlas fixes` when present, `Atlas final gates`, and `Atlas delivery` when the plan delivers. Other phases stay in place; a newly appearing Atlas phase goes before the next Atlas phase already listed. Atlas phases are restored on attach and after ledger changes; do not edit them by hand. Each changed-row `atlas_ledger` result names a repeatable `todo` call to refresh the host HUD. Exiting leaves the todo list intact.
- Session title: after Atlas enters a plan, it asks OMP's title generator for a title starting with "Atlas", using your `TITLE_SYSTEM.md` override or OMP's default prompt. Without a result the session is named `Atlas: <plan name>`. A name set with `/rename` is never replaced, `PI_NO_TITLE` disables this, and exiting keeps the name.
- Model role: while a Prometheus proposal waits for approval, `atlas` is temporarily added to the front of `cycleOrder` so the approval slider offers it alongside `smol`, `default` and `slow`. `cycleOrder` is restored at the next input or agent turn, or when planning ends. Ordinary Plan Mode approvals never show `atlas`, and roles without an available model never appear. If the assigned `atlas` model cannot be resolved, Atlas still starts and reports that it kept the current model.
- Inspector: the live view keeps its selection and scroll when progress changes. The header shows running children and elapsed time; in-progress rows show elapsed time; row details show tier, verification state and summary, and the origin of D and X rows; the Live section shows child identity, model and thinking level, tool and arguments, intent, usage, cost, retries and recent activity when the host supplies progress. While a HEAVY row is verified, its live child is the verifier. Space reveals archived child output. Derived timeline events from older bundles are marked.
- Without a UI, bare `/atlas` prints the plan list, or the running plan with its rows. If entering a plan fails, the session stays paused until `/atlas exit`; Atlas never falls back to prompt-only execution. Command output arrives as `wows-omp-omo-prometheus.command-status` messages.
- In RPC, while Atlas is active, bare `/atlas` shows a summary with Keep running, View details and Exit. View details opens a read-only `editor` dialog with the plan text. Widget lines are sent at most twice a second. The `prometheus_activate` and `atlas_release` confirmations use plain `select`/`confirm` dialogs.

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

`awaiting-approval` covers the time between a Prometheus proposal and the approval choice. `atlas` appears only while executing. Its progress fields come from the same live ledger observation that feeds the Herdr DAG contract and appear once that has loaded; a paused plan may carry only `planId` and `paused`. A gate with status `done` has passed. `tier` appears on T, D and X rows and `verification` on HEAVY rows only. Session switches and shutdown leave an executing session's file as it was, because the plan can be resumed there.

## Herdr DAG contract

With `herdrDag` enabled, `omp-herdr-dag` observes this session's bound Atlas plan through `pi.events`. All payloads are plain JSON with `v: 1` and do not change Atlas bundle formats.

| Event | Direction and payload |
| --- | --- |
| `herdr-dag:hello` | Viewer to producer: `{v:1, sessionId, requestId}`. |
| `atlas:hello` | Synchronous reply preserving `requestId`, with the bound plan identity (`id`, `name`, `planFilePath`, `cwd`) when present. Also sent unprompted when an unbound session starts or switches. |
| `atlas:snapshot` | Follows every hello with a bound plan, and every live update: plan identity, ledger status and totals, rows with dependency and origin metadata, per-row child progress, the last 50 timeline events. |
| `atlas:released` | Detach with `reason: "exit"`, `"session-switch"` or `"shutdown"`, followed by a hello without a plan. |

Each snapshot row has a `kind` derived from its id: `task` (T), `discovered` (D), `fix` (X), `gate` (F) or `delivery` (P). `origin` names the rejecting gate of an X row and the source row of a D row. Rows may carry `tier` and `verification: {status}`; a verifier's summary is not published. While a HEAVY row's verifier runs, the row's `attempt` is the verification attempt, so live child progress keeps matching it. Timeline kinds added in this version are `discovered`, `implemented`, `verify_started`, `verify_passed` and `verify_failed`.

Startup order does not matter. Unsupported versions and unknown sessions are ignored. Last-known child progress stays visible after a row finishes and clears on a new attempt. A release only detaches the plan from the view; execution may be unfinished and children may still run. With `herdrDag: false` nothing is emitted, including hello replies; ledger, todo mirror, ownership and UI behave the same. The producer needs no viewer.

## Roadmap contract

With `roadmap` installed, Prometheus uses a `pi.events` contract independent of `herdrDag`:

1. At proposal time it emits `roadmap:binding-request {v:1, sessionId, requestId}` and accepts only a synchronous `roadmap:binding` reply for that session and request, carrying `repoRoot`, `toolSourcePath` and an optional bound active stage.
2. New bundles write approval version 2 with optional `roadmapStage: {repoRoot, id}`. Version 1 approvals still resume without rewriting their bytes or requiring fresh approval. Check `approval.json` for `roadmapStage` to see whether a stage was bound at proposal time.
3. Atlas admits `roadmap_*` tools only when their extension source path exactly matches `toolSourcePath`. The guard requests the binding on its first roadmap call and asks again while roadmap has not answered; a refusal says whether the handshake is missing or the tool comes from another source. Within that boundary Atlas may use every roadmap action the plan needs: starting or joining the stage, amending it, ADR and TODO changes, and closing it.
4. After the ledger write that first completes a stage-bound plan, Prometheus emits `atlas:completed {v:1, sessionId, planId, roadmapStage, gates, delivery?, at}` with verified gate verdicts and summaries. A plan is complete only when every row is done, so with `Delivery: pr` or `ship` the event follows the P1 row and carries `delivery: {mode, summary}`, the summary being Atlas's inspected P1 evidence; with `direct` it follows the gates and has no `delivery`. A plan approved without a stage uses the stage bound in the executing session at that moment. Roadmap records a pending-close reminder for the next turn; the session must still map the evidence to the stage criteria and call the normal stage-close tool.

Completion events are deduplicated per producer instance only. A producer restart followed by reopening and recompleting a plan can emit again. Roadmap deduplicates pending-close entries by `planId` within the receiving session; another session may get its own reminder.
