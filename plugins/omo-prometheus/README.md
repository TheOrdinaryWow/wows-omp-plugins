# omo-prometheus

English | [简体中文](README.zh.md)

Ports the Prometheus planning workflow and Atlas execution model from [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) to OMP. It is a modified adaptation of OmO, not an independent reimplementation.

It keeps OMP's native Plan Mode and approval flow and adds:

- Metis, which checks intent and gaps before planning starts.
- Prometheus, which asks only the questions that can change the plan and keeps clarifying until it can write one.
- Optional Momus and Oracle plan review for blocking problems in references, executability, QA, and task grammar. Oracle can also be consulted on architecture and high-risk decisions.
- Atlas, which takes over after approval, delegates every plan task to child agents, keeps progress and verified evidence across sessions, and runs four final verification gates before it calls the plan done.

`/prometheus` and opted-in native `/plan` share the planning workflow. `/atlas` controls execution and can resume an approved plan in another session.

## Install

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install omo-prometheus@wows-omp-plugins
```

Restart OMP after installing so the extension and agents load.

## Migrating from `prometheus`

Run `omp plugin uninstall prometheus@wows-omp-plugins`, then install `omo-prometheus@wows-omp-plugins`. Session state from the old plugin does not carry over, so start a new plan after migrating.

## Usage

### Planning

```text
/prometheus
```

This enters OMP's native Plan Mode, or upgrades a Plan Mode session that is already active. Describe the request in your next message, or inline as `/prometheus <request>`. Running `/prometheus` again while planning leaves both Prometheus and Plan Mode.

Prometheus requires Plan Mode to be enabled in OMP settings (`plan.enabled`, on by default). When it is off, `/prometheus` refuses with an error and changes nothing; turn Plan Mode on and run it again. Atlas and `/atlas` do not depend on this setting.

The plan is written to a `local://` session artifact and submitted through `xd://propose`. If OMP plan autosave is on, the approved copy is also saved under `.omp/plans/`.

In ordinary `/plan` mode, small and well-defined requests stay on the normal OMP path. For large, cross-cutting, or ambiguous goals, the planner offers Prometheus through `ask`: one question with the header `Prometheus`, whose second option names Prometheus. Only that exact question counts as consent. Accepting it switches to the same shared workflow.

### Execution

After approval the main session becomes Atlas. For this plan, the execution prompt overrides OMP's delegation preference, and the extension blocks direct implementation tools in the parent session, so all work goes to child agents through `task`. `/prometheus` does not exit Atlas; use `/atlas exit`.

The guard admits only tools that observe the session or change host-owned state; none of them writes to the workspace. The table enables nothing: a tool missing from your session (for example, a memory tool while no memory backend is configured) stays unavailable.

| Tool | Allowed in the Atlas parent |
| --- | --- |
| `task`, `wait`, `todo`, `ask`, `think`, `web_search`, `atlas_ledger`, `atlas_release` | always |
| `read`, `find`, `glob`, `grep`, `ast_grep` | always; `read` refuses `ssh://` |
| `lsp` | read-only actions, and `code_actions` without `apply` |
| `github` | `repo_view`, `file_read`, `search_*`, `run_watch` |
| `debug` | state inspection only (`threads`, `stack_trace`, `scopes`, `variables`, `output`, …), never `launch`, `continue`, or breakpoints |
| `ida` | `list` |
| `recall`, `reflect`, `retain`, `memory_edit`, `learn`, `manage_skill` | always: they write memory backends and managed skills, not the workspace |
| `goal`, `context_notes`, `new_context` | always |
| `write` | `agent://` peer messages, `proc://<id>/kill`, and `xd://` dispatch of any admitted tool |
| `hub` | observing ops and `send` to agents, never process input |

Everything else is blocked, including `bash`, `eval`, `edit`, `ast_edit`, file writes, `security_scan`, and `checkpoint`/`rewind`. Rewind branches the session tree away from the task receipts that prove completed ledger rows. Tools registered by other extensions or MCP servers are blocked, even when they share a native tool's name, unless listed under third-party integrations below.

#### Third-party integrations

| Integration | Admitted tools |
| --- | --- |
| [Magic Context](https://github.com/cortexkit/magic-context) (an extension, not part of OMP) | `ctx_reduce`, `ctx_expand`, `ctx_search`, `ctx_memory`, `ctx_note`, only when registered by an extension; same-named MCP tools stay blocked |
| Extension wrappers of `todo`, such as [omp-herdr-dag](../omp-herdr-dag/README.md)'s edge-aware `todo` | `todo`, when an extension re-registers it; an MCP `todo` stays blocked |
| [roadmap](../roadmap/README.md) | `roadmap_*`, called directly or as `write xd://roadmap_*` devices, only from the extension source path verified by the synchronous roadmap binding handshake; shadows from other extensions or MCP servers stay blocked |

Both approval choices of a Prometheus plan hand off to Atlas. "Approve and execute" starts a fresh session. To survive that switch, the plugin writes a marker to `local://prometheus/<slug>.proposal.json` when the plan is proposed, and OMP copies it into the new session along with the plan. Plans approved in ordinary Plan Mode have no marker, and the plugin leaves them alone.

### Dispatching with `/atlas`

```text
/atlas                          # while inactive: open Atlas Dispatch, the interactive plan menu
/atlas <plan-name-or-id>        # while inactive: enter a plan in this session and start executing (name/ID completion available)
/atlas start <plan-name-or-id>  # same as above
/atlas list                     # while inactive: list approved plans with their status
/atlas show <plan-name-or-id>   # while inactive: show a plan's rows, acceptance and evidence
/atlas resume <plan-name-or-id> # while inactive: resume a started plan (see below)
/atlas rename <id> <new name>   # while inactive: change a plan's display label
/atlas delete <id> [--yes]      # while inactive: delete a plan and its evidence; asks first, or needs --yes without dialogs
/atlas                          # while active: open the running plan's view (read-only)
/atlas exit                     # while active: exit (asks first if the plan is unfinished)
```

A leading `list`, `show`, `start`, `resume`, `rename`, `delete` or `exit` is always the subcommand, never a plan name. A plan whose name starts with one of these words is still reachable by its ID or with `/atlas start <name>`.

Atlas Dispatch is the menu for handing a Prometheus plan to Atlas. It opens on unfinished plans in the current workspace. Tab switches to All, which adds complete, invalid, and other-workspace plans. All is display-only, so start and resume work only from the Unfinished view. The menu shows each plan's progress and the highlighted plan's T/F rows.

| Key | Action |
| --- | --- |
| type | fuzzy-search names, IDs, or status |
| Enter | start the highlighted plan and begin executing right away |
| Space, Shift+I | open the fullscreen plan view |
| Shift+R | resume the plan in a session that already executed it |
| Backspace | edit the search, or delete the highlighted plan when the search is empty |
| Delete | delete the highlighted plan |
| Shift+N | rename (display label only; the approved plan is unchanged) |
| Esc | close |

A plan runs in one session at a time, so Enter and Shift+R refuse a plan that another live session holds.

Enter starts a plan. In an empty session Atlas enters the plan here. Otherwise a prompt offers a new session, this session, or cancel. Atlas then sends the first execution message itself, the same way native plan approval starts work, so you do not need to type anything. A started plan can be started again in another session, and its shared progress and evidence carry over.

Shift+R resumes a plan that has already started. The plugin scans this project's session files for sessions that executed the plan. With one match it switches there; with several it lists them, most recently used first. The session comes back in Atlas mode but does not continue on its own; send a message when you are ready. Resume is refused during planning.

Space or Shift+I opens the fullscreen plan view, which keeps its row selection and scroll when progress changes. Tab switches its body between the selected row and a newest-first timeline; derived events from older bundles are marked. Space reveals archived child output. Up/Down select rows, PgUp/PgDn scroll, Enter and Shift+R start or resume as in the list, and Esc returns to the list.

Deleting asks for confirmation and permanently removes the plan and its evidence. It is refused while a live session owns the plan or native work is pending. Without an interactive UI, bare `/atlas` prints the plan list.

A plan can be selected by its display label, its original name, or either name without the `-plan` suffix, so `checkout` and `checkout-plan` match the same plan. If several plans share a name, use the full ID from the list.

While Atlas is active, bare `/atlas` opens the fullscreen inspector as a live, read-only view. Committed ledger changes, child lifecycle, and host progress update without reopening it. The header shows running children and plan elapsed time. In-progress rows show elapsed time in the sidebar. When the host supplies progress, the Live section shows child identity, model/thinking, tool and arguments, intent, usage, cost, retries, and recent activity.

Tab switches to the persisted timeline. Start, resume, delete, and rename are unavailable. Shift+X exits Atlas as `/atlas exit` does, and Esc closes the page. Ledger and lifecycle details remain available when the host has no progress channel.

Without an interactive UI, bare `/atlas` prints which plan is running with its rows. Exiting asks first if rows are unfinished or progress cannot be verified. `/atlas` with any other argument, even the current plan, is an error: exit first, then enter the other plan from the same session. Atlas will not enter during planning or run an unapproved plan. If entering fails, the session stays paused until you run `/atlas exit`, and Atlas never falls back to prompt-only execution.

During execution an above-editor Atlas widget shows the plan bar, done/total and gate counts, running children, and compact live per-row usage. It remains visible while you use the normal editor and disappears on exit, session switch, or shutdown. Disable it with `atlasWidget`; the `/atlas` observation page remains available.

Atlas also maintains session todo phases from the validated ledger: tasks, corrections when present, and final gates. Existing non-Atlas phases remain in place. Atlas phases are restored on attach and after ledger changes; do not edit them manually. Each changed-row `atlas_ledger` result names a repeatable `todo` call to refresh the host HUD. Exiting Atlas leaves the todo list intact.

Once Atlas has entered a plan, after native approval, `/atlas <plan>` or `start`, or a resume, it asks OMP's title generator to rename the session from the plan. The request uses your `TITLE_SYSTEM.md` override, or OMP's default title prompt, followed by Atlas rules asking for an execution title that starts with "Atlas". If no title comes back, the session is named `Atlas: <plan name>`. A name you set with `/rename` is never replaced, `PI_NO_TITLE` disables this, and exiting Atlas keeps the name.

Session A can finish part of a plan and exit, and session B can pick it up with `/atlas <name>`, as long as both use the same host session directory and workspace. Exit takes effect immediately and does not cancel children or mark work complete. It does not block closing the host.

While native child work is running, its session keeps ownership of the plan until that work reports a final result. Other sessions cannot write to the plan during that time. A plan can be recovered if its owning session has provably died. Recovery is refused when ownership is unclear or belongs to another host.

Some hosts do not give Atlas a reliable signal that a child's final processing has finished, and a cancelled wake-up can settle before the child does. In those cases the plan stays owned until the original OMP process exits; start a new session after closing it.

While Atlas owns a plan, the session's plan reference is `atlas://<plan-id>/plan.md`, a read-only view of the approved `plan.md` that child agents load through OMP's plan handoff. Other sessions cannot read it, and it stops resolving if the plan bytes change.

### Host modes

| Host | `/atlas` behavior |
| --- | --- |
| TUI | Atlas Dispatch menu, fullscreen plan view, and the above-editor widget, as described above. |
| RPC (`--mode rpc`, rpc-ui) | Atlas Dispatch becomes a chain of `select` dialogs: pick a plan (labels carry the status; a toggle switches to all plans, which is display-only), then Start, Resume, View details, Rename, Delete or Back. View details opens a read-only `editor` dialog with the plan text. The same refusals apply as in the TUI menu. While active, bare `/atlas` shows a summary with Keep running, View details and Exit. The widget is sent as text lines (plan bar, done/total, running children, current rows) at most twice a second. |
| ACP editors | Same dialogs as RPC, through form elicitation. Widgets are not shown. |
| SDK, `--no-ui`, print | No dialogs. Use the subcommands above; output arrives as `wows-omp-omo-prometheus.command-status` messages. Deleting needs `--yes`. `/atlas resume` works only when the current session is the one session that executed the plan; when a choice of session would be needed it names the sessions and stops, so open the right one and resume there. |

Prometheus planning itself needs native plan mode and its interactive approval, so it runs in TUI, RPC and ACP; the `prometheus_activate` and `atlas_release` confirmations use plain `select`/`confirm` dialogs.

### Client state file

The main session publishes `omo-prometheus.json` with the shared plugin-state envelope (see the [repository README](../../README.md)). `state` is `null` while neither planning nor Atlas is active. Otherwise it is:

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

`awaiting-approval` covers the time between a Prometheus proposal and the native approval choice. `atlas` appears only while executing. Its progress fields come from the same live ledger observation that feeds the Herdr DAG contract and appear once that observation has loaded; a paused plan may carry only `planId` and `paused`. A gate with status `done` has passed. Session switches and shutdown leave an executing session's file as it was, because the plan can be resumed there.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omo-prometheus`.

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | Controls plan review before the proposal. |
| `atlasWidget` | boolean | `true` | Show the live progress widget above the editor while this session executes Atlas. |
| `herdrDag` | boolean | `true` | Publish the versioned Atlas event contract for the Herdr DAG viewer; false disables all contract emissions, including hello replies. |

- `ask`: Momus reviews every plan. Momus and Oracle together review when you ask for high accuracy or the work is nontrivial and unclear; for clear work you get a one-time choice.
- `standard`: Momus reviews every plan without offering high accuracy, but an explicit request still adds Oracle.
- `high-accuracy`: Momus and Oracle always review, with no choice offered.
- `off`: no Momus or Oracle plan review, even on request. Metis still checks for planning gaps, and Atlas still runs the F1 compliance gate after approval.

User settings merge with project overrides. The plugin reads settings for the session's cwd at startup, so restart the session after changing them.

## Herdr DAG contract

With `herdrDag` enabled, `omp-herdr-dag` can observe this session's bound Atlas plan through `pi.events`. The producer answers `herdr-dag:hello {v:1, sessionId, requestId}` synchronously with `atlas:hello`, preserving `requestId` and including the bound plan when present. A bound plan's hello is immediately followed by `atlas:snapshot`; startup order does not matter. Unsupported versions and sessions not known to this producer are ignored.

Binding emits `atlas:hello` and `atlas:snapshot`. Live updates publish the plan identity, ledger status and totals, T/X/F rows with dependency and fix-origin metadata, per-row child progress, and the last 50 timeline events. Last-known progress remains visible after a row finishes, but is cleared on a new attempt. Payloads are plain JSON and use `v:1`; this does not change Atlas bundle formats.

An enabled producer also announces availability without a plan after an unbound session starts or switches, so a viewer that starts first does not need to retry its initial handshake.

Detaching emits `atlas:released` with `reason: "exit"`, `"session-switch"`, or `"shutdown"`, followed by a hello without a plan. A release only detaches the plan from the view; execution may still be unfinished and children may still be running. With `herdrDag: false`, no contract events are emitted, including hello replies; ledger, todo mirror, ownership, and UI behavior remain unchanged. The producer needs no viewer and adds no runtime dependency.

## Roadmap contract

With [roadmap](../roadmap/README.md) installed, Prometheus uses a versioned `pi.events` contract independent of `herdrDag`. At proposal time it emits `roadmap:binding-request {v:1, sessionId, requestId}` and accepts only a synchronous `roadmap:binding` reply matching that session and request. The reply includes `repoRoot`, `toolSourcePath` and an optional bound active stage.

New Atlas bundles write approval version 2 with optional `roadmapStage: {repoRoot, id}`. Version 1 approvals still resume without rewriting their bytes or requiring fresh approval. Atlas admits `roadmap_*` tools, whether called directly or through `write xd://roadmap_*`, only when their extension source path exactly matches the handshake's `toolSourcePath`. The guard requests that binding on its first roadmap call and asks again while roadmap has not answered; a refusal says whether the handshake is missing or the tool comes from another source. Within that boundary Atlas may use every roadmap action the plan needs: starting or joining the stage, amending it, ADR and TODO changes, and closing it.

After the ledger write that first makes a stage-bound plan complete, Prometheus emits `atlas:completed {v:1, sessionId, planId, roadmapStage, gates, at}` with verified gate verdicts and summaries. A plan approved without a stage uses the stage bound in the executing session at that moment, for example one Atlas started during execution. Roadmap records a pending-close reminder for the executing session's next turn. The session must still map and verify that evidence against the stage criteria and call the normal stage-close tool with TODO/ADR dispositions; completion does not close a stage automatically. Check the bundle's `approval.json` for `roadmapStage` to see whether the stage was bound at proposal time.

Completion events are deduplicated per producer instance only, which does not give durable exactly-once delivery. A producer restart followed by reopening and recompleting a plan can emit again. Roadmap deduplicates pending-close entries by `planId` within the same receiving session's retained state; another session may receive its own reminder.

## Plan format

Every Prometheus plan ends with two machine-readable sections. Tasks are unindented checkbox rows numbered from `T1`, each with indented `Agent:`, `Depends on:`, and `Acceptance:` lines:

```markdown
## Tasks
- [ ] T1. Add the parser
  - Agent: task
  - Depends on: none
  - Acceptance: the new unit test passes and the CLI prints the parsed value
- [ ] T2. Update the command help text for the new flag
  - Agent: sonic
  - Depends on: T1
  - Acceptance: CLI help lists the new flag

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
```

Prometheus plans against the agents the session's `task` tool lists after applying spawn policy and disabled-agent settings. Momus reviews against the same list. Each `Agent:` row should name the most specific listed specialist; installed omo-toolkit agents are preferred over generic `task` or `sonic`.

A user-defined agent is valid only if listed. An unlisted name needs a known fallback. If the tool description cannot be parsed, planning can still use known names and keeps them as written, but cannot check user-defined names.

At dispatch, the requested agent is tried first, then its fallbacks in order, choosing only agents in the live list:

| Requested agent | Fallback chain |
| --- | --- |
| `deep-low`, `deep-high`, `ultrabrain`, `architect`, `visual-engineering`, `artistry`, `writing` | `task` |
| `librarian` | `scout` → `task` |
| `metis`, `momus`, `oracle` | `reviewer` → `task` |
| `sonic`, `scout`, `reviewer`, `security-reviewer` | `task` |
| `task` | none |

Fallbacks change the agent only. Each agent's model-role chain is documented in the [omo-toolkit README](../omo-toolkit/README.md#agents). If nothing in a chain can be spawned — for example, a user-defined agent named in the plan was removed after approval — the ledger shows `unavailable` and Atlas picks the best fit from the live list when it starts the row (`atlas_ledger start` with `agent`). The pick is kept for that row until the requested agent or a fallback becomes spawnable again, and changing it never requires re-approving the plan. Atlas reports a blocker only when the live list is empty.

## Execution ledger

Native approval creates a plan bundle at `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/`. That is usually `~/.omp/agent/sessions/<working-dir>/atlas/`, outside the repository and outside `local://`; custom session directories are respected.

```text
plan.md          exact approved plan
approval.json    source approval, workspace, and plan identity
ledger.json      task and gate progress, plus the workspace's Git HEAD at approval
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of immutable approval
checkpoint.json independent attempt and receipt bindings
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

The ledger tracks each T and F row's acceptance criteria, dependencies, status, requested and resolved agent, attempt, evidence receipt, and the plan's SHA-256, plus any X correction rows a final gate asked for. The dependency graph is validated up front, so a plan with a cycle never partially runs. Ticking a box in the plan file does not count as progress.

Atlas drives the ledger with `atlas_ledger` (`status`, `start`, `done`, `block`, `reopen`, `fix`). A row is marked done only with proof from the child's real final result, so a failed, foreign, or still-running child, or a hand-written reference, cannot complete work. Blocking or reopening a row affects only that row: completed work that depends on it keeps its proof, and the final gates judge the finished result. `atlas_release` needs a valid receipt for every row plus your explicit confirmation.

If the ledger or plan artifacts are missing, corrupt, or no longer match the approved plan, Atlas pauses and rebuilds nothing. Restore the approved artifacts, or exit with `/atlas` and get a changed plan approved again.

When Atlas stops with unfinished rows, the plugin continues it with a hidden `<atlas-continuation>` message containing the ledger summary. OMP allows at most eight chained continuations per user turn. Two continuations in a row without progress stop the loop and notify you; exit with `/atlas` or send new instructions. Any message from you resets the count.

Progress is stored in the shared bundle. Child outputs are copied into `evidence/` and rechecked against their digests, so verified progress survives deleting the original session. `atlas_ledger status` shows where those outputs are. Only the child's own output is kept; files it merely links to are not copied. If a row's proof goes missing or changes, that row reopens, and an old session branch cannot roll shared progress back.

Updating the plugin keeps existing plans runnable. A ledger written by an earlier release is upgraded when it is loaded, keeping its verified progress, and needs no fresh approval. Ledgers from before version 4 have no recorded Git baseline, so F1 dates one from the earliest recorded row start and says so.

`timeline.jsonl` records attachment and release, row starts, completion, blocking and reopening, correction rows, and gate verdicts. It is display-only: a missing or damaged timeline never invalidates approval, ownership, receipts, or progress. Bundles from earlier releases show derived history from their ledger until real timeline events are appended; derived events are not written back. A crash-truncated final line and unknown future event versions are ignored.

Plans run with older versions of the plugin kept their ledger inside the session. Those are not migrated: resuming one pauses and asks for fresh approval. The old `prometheus_ledger` and `prometheus_release` tools are now `atlas_ledger` and `atlas_release`, with no aliases.

## Final gates

Once every T row is done, Atlas sends F1 to F4 together to four separate fresh verification children. None of them did implementation work or reviewed earlier.

| Gate | Agent | Fallback | Checks |
| --- | --- | --- | --- |
| F1. Plan compliance review | `momus` (`review_kind: compliance`) | `reviewer` | executed changes match the approved plan, reading the hash-verified `plan.md` whose path the plugin prints when F1 starts (no inline plan copy), with the ledger summary and the Git evidence the plugin collects read-only at that point (`git diff --stat`, `git log --oneline`, `git status --short` since the plan's baseline commit, or a plain "unavailable") |
| F2. Code quality review | `deep-high` | `task` | maintainability, scope, test value, and evidence-backed blockers |
| F3. Real-surface QA | `deep-low` | `task` | every scenario in the plan's Verification section run on the real surface with command and observed result |
| F4. Success-criteria fidelity | `deep-high` | `task` | every named success criterion and adversarial case, tied to evidence |

Each gate returns a strict structured verdict (`PASS`, `FAIL`, or `INCONCLUSIVE`) with a summary and evidence. Only a matching structured `PASS` counts; a passing word in prose does not.

When a gate rejects the work, Atlas records each correction as an X row (`atlas_ledger fix`), dispatches it like any task, and then reruns only the gate that rejected. Completed T rows and gates that already passed are not reopened.

## Models

Metis, Oracle, and Momus run as child agents on OMP's `@slow` role, which resolves through your OMP model configuration. The plugin hard-codes no provider or model.

Atlas runs in the main session after approval. The plugin registers an `atlas` model role, shown in `/model` as Atlas, that you can assign like any other role. It is not part of the Ctrl+P cycle.

While a Prometheus proposal waits for approval, `atlas` is temporarily added to the front of `cycleOrder`. The approval slider then offers it alongside `smol`, `default`, and `slow`, while Ctrl+P still skips it. The slider starts on `default`; move it to `atlas` to execute with that role. The plugin restores `cycleOrder` at the next input or agent turn, or when planning ends. Ordinary Plan Mode approvals never show `atlas`, and roles without an available model never appear on the slider.

`/atlas <plan>` switches to the `atlas` role when it is assigned and keeps the current model otherwise. If the assigned model cannot be resolved, Atlas still starts and reports that it kept the current model.

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

## Compatibility

Requires OMP 18.3.5 or newer. OMP stays in charge of `xd://propose` approval and autosave. Planning drafts and the handoff marker live in `local://`, and approved plans live in the shared Atlas bundle. The plugin creates no project-local `.omo` state and runs children through OMP's native execution.

Shared execution needs file-backed sessions on a local filesystem that supports hard links, atomic rename, and file and directory sync. In-memory, remote-only, or otherwise unsupported storage makes Atlas refuse to run. Sessions with different session directories cannot see each other's plans, and moving a session does not move its `atlas/` directory.

## License

The Prometheus, Metis, Oracle, Momus, and Atlas prompt assets are modified derivatives of OmO; `NOTICE` records the upstream repository, the pinned revision, earlier fork history, and the modification notice.

Extension code and original packaging are MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/`, and `skills/prometheus/` stay under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), which allows internal business, personal, and non-commercial use and free distribution only for non-commercial purposes.
