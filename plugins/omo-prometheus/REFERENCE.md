# omo-prometheus reference

English | [简体中文](REFERENCE.zh.md)

## Planning handoff

Only the planner's `ask` question with the header `Prometheus`, whose second option names Prometheus, counts as consent to switch an ordinary `/plan` session to Prometheus.

Both approval choices of a Prometheus plan hand off to Atlas. "Approve and execute" starts a fresh session; to survive that switch, the plugin writes a marker to `local://prometheus/<slug>.proposal.json` when the plan is proposed, and OMP copies it into the new session with the plan. Plans approved in ordinary Plan Mode have no marker, and the plugin leaves them alone.

OMP stays in charge of `xd://propose` approval and autosave. The plugin creates no project-local `.omo` state and runs children through OMP's native execution.

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

Fallbacks change the agent only; model-role chains are in the [omo-toolkit README](../omo-toolkit/README.md#agents). If nothing in a chain can be spawned, the ledger shows `unavailable` and Atlas picks the best fit from the live list when it starts the row (`atlas_ledger start` with `agent`). The pick is kept for that row until the requested agent or a fallback becomes spawnable again. Atlas reports a blocker only when the live list is empty.

## Plan bundle

Native approval creates a bundle at `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/`, usually `~/.omp/agent/sessions/<working-dir>/atlas/`. Custom session directories are respected; moving a session does not move its `atlas/` directory.

```text
plan.md          exact approved plan
approval.json    source approval, workspace and plan identity
ledger.json      task and gate progress, plus the workspace's Git HEAD at approval
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of the immutable approval
checkpoint.json  independent attempt and receipt bindings
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

While Atlas owns a plan, the session's plan reference is `atlas://<plan-id>/plan.md`, a read-only view of the approved `plan.md` that child agents load through OMP's plan handoff. Other sessions cannot read it, and it stops resolving if the plan bytes change.

## Ledger

The ledger tracks each T and F row's acceptance criteria, dependencies, status, requested and resolved agent, attempt and evidence receipt, plus the plan's SHA-256 and any X correction rows a gate asked for.

Atlas drives it with `atlas_ledger` (`status`, `start`, `done`, `block`, `reopen`, `fix`). A row is done only with proof from the child's real final result, so a failed, foreign or still-running child, or a hand-written reference, cannot complete work. Blocking or reopening a row affects only that row: completed work that depends on it keeps its proof, and the final gates judge the finished result. `atlas_release` needs a valid receipt for every row plus your explicit confirmation.

Child outputs are copied into `evidence/` and rechecked against their digests, so verified progress survives deleting the original session. `atlas_ledger status` shows where they are. Only the child's own output is kept, not files it links to. If a row's proof goes missing or changes, the row reopens, and an old session branch cannot roll shared progress back.

The continuation message is a hidden `<atlas-continuation>` with the ledger summary. Any message from you resets the continuation count.

A ledger written by an earlier release is upgraded on load, keeping verified progress. Ledgers before version 4 have no recorded Git baseline, so F1 dates one from the earliest recorded row start and says so. Plans from releases that kept the ledger inside the session are not migrated; resuming one pauses and asks for fresh approval. The old `prometheus_ledger` and `prometheus_release` tools are now `atlas_ledger` and `atlas_release`, with no aliases.

`timeline.jsonl` records attachment and release, row starts, completion, blocking and reopening, correction rows and gate verdicts. It is display-only: a missing or damaged timeline never invalidates approval, ownership, receipts or progress. Bundles from earlier releases show history derived from their ledger until real events are appended; derived events are not written back. A crash-truncated final line and unknown future event versions are ignored.

## Final gate inputs

F1 reads the hash-verified `plan.md` whose path the plugin prints when F1 starts (no inline plan copy), the ledger summary, and Git evidence collected read-only at that point: `git diff --stat`, `git log --oneline` and `git status --short` since the plan's baseline commit, or a plain "unavailable". `momus` runs F1 with `review_kind: compliance`. Only a matching structured `PASS` counts; a passing word in prose does not.

## Ownership

While native child work is running, its session keeps ownership of the plan until that work reports a final result, and other sessions cannot write to the plan. A plan can be recovered when its owning session has provably died; recovery is refused when ownership is unclear or belongs to another host. Some hosts give no reliable signal that a child's final processing has finished, and a cancelled wake-up can settle before the child does; then the plan stays owned until the original OMP process exits.

Exit does not block closing the host. Deleting a plan is refused while a live session owns it or native work is pending.

## Session integration

- Todo mirror: Atlas maintains session todo phases from the validated ledger (tasks, corrections when present, final gates). Other phases stay in place. Atlas phases are restored on attach and after ledger changes; do not edit them by hand. Each changed-row `atlas_ledger` result names a repeatable `todo` call to refresh the host HUD. Exiting leaves the todo list intact.
- Session title: after Atlas enters a plan, it asks OMP's title generator for a title starting with "Atlas", using your `TITLE_SYSTEM.md` override or OMP's default prompt. Without a result the session is named `Atlas: <plan name>`. A name set with `/rename` is never replaced, `PI_NO_TITLE` disables this, and exiting keeps the name.
- Model role: while a Prometheus proposal waits for approval, `atlas` is temporarily added to the front of `cycleOrder` so the approval slider offers it alongside `smol`, `default` and `slow`. `cycleOrder` is restored at the next input or agent turn, or when planning ends. Ordinary Plan Mode approvals never show `atlas`, and roles without an available model never appear. If the assigned `atlas` model cannot be resolved, Atlas still starts and reports that it kept the current model.
- Inspector: the live view keeps its selection and scroll when progress changes. The header shows running children and elapsed time; in-progress rows show elapsed time; the Live section shows child identity, model and thinking level, tool and arguments, intent, usage, cost, retries and recent activity when the host supplies progress. Space reveals archived child output. Derived timeline events from older bundles are marked.
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
    "rows": [{ "id": "T1", "title": "…", "status": "open | in_progress | done | blocked", "kind": "task | fix | gate",
               "agent": "task", "dependsOn": [], "attempt": "…", "startedAt": 0, "evidence": "…", "origin": "F1",
               "child": { "id": "…", "status": "running", "currentTool": "read" } }],
    "gates": [{ "id": "F1", "title": "…", "status": "done", "evidence": "…" }]
  }
}
```

`awaiting-approval` covers the time between a Prometheus proposal and the approval choice. `atlas` appears only while executing. Its progress fields come from the same live ledger observation that feeds the Herdr DAG contract and appear once that has loaded; a paused plan may carry only `planId` and `paused`. A gate with status `done` has passed. Session switches and shutdown leave an executing session's file as it was, because the plan can be resumed there.

## Herdr DAG contract

With `herdrDag` enabled, `omp-herdr-dag` observes this session's bound Atlas plan through `pi.events`. All payloads are plain JSON with `v: 1` and do not change Atlas bundle formats.

| Event | Direction and payload |
| --- | --- |
| `herdr-dag:hello` | Viewer to producer: `{v:1, sessionId, requestId}`. |
| `atlas:hello` | Synchronous reply preserving `requestId`, with the bound plan identity (`id`, `name`, `planFilePath`, `cwd`) when present. Also sent unprompted when an unbound session starts or switches. |
| `atlas:snapshot` | Follows every hello with a bound plan, and every live update: plan identity, ledger status and totals, T/X/F rows with dependency and fix-origin metadata, per-row child progress, the last 50 timeline events. |
| `atlas:released` | Detach with `reason: "exit"`, `"session-switch"` or `"shutdown"`, followed by a hello without a plan. |

Startup order does not matter. Unsupported versions and unknown sessions are ignored. Last-known child progress stays visible after a row finishes and clears on a new attempt. A release only detaches the plan from the view; execution may be unfinished and children may still run. With `herdrDag: false` nothing is emitted, including hello replies; ledger, todo mirror, ownership and UI behave the same. The producer needs no viewer.

## Roadmap contract

With `roadmap` installed, Prometheus uses a `pi.events` contract independent of `herdrDag`:

1. At proposal time it emits `roadmap:binding-request {v:1, sessionId, requestId}` and accepts only a synchronous `roadmap:binding` reply for that session and request, carrying `repoRoot`, `toolSourcePath` and an optional bound active stage.
2. New bundles write approval version 2 with optional `roadmapStage: {repoRoot, id}`. Version 1 approvals still resume without rewriting their bytes or requiring fresh approval. Check `approval.json` for `roadmapStage` to see whether a stage was bound at proposal time.
3. Atlas admits `roadmap_*` tools only when their extension source path exactly matches `toolSourcePath`. The guard requests the binding on its first roadmap call and asks again while roadmap has not answered; a refusal says whether the handshake is missing or the tool comes from another source. Within that boundary Atlas may use every roadmap action the plan needs: starting or joining the stage, amending it, ADR and TODO changes, and closing it.
4. After the ledger write that first completes a stage-bound plan, Prometheus emits `atlas:completed {v:1, sessionId, planId, roadmapStage, gates, at}` with verified gate verdicts and summaries. A plan approved without a stage uses the stage bound in the executing session at that moment. Roadmap records a pending-close reminder for the next turn; the session must still map the evidence to the stage criteria and call the normal stage-close tool.

Completion events are deduplicated per producer instance only. A producer restart followed by reopening and recompleting a plan can emit again. Roadmap deduplicates pending-close entries by `planId` within the receiving session; another session may get its own reminder.
