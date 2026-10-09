# omo-prometheus

English | [简体中文](README.zh.md)

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO)'s Prometheus planning and Atlas execution, ported to OMP. Prometheus interviews you until it can write a plan worth approving. After approval, Atlas executes that plan by delegating every task to subagents, records verified evidence for each one, and runs four independent verification gates before it calls the plan done. Progress is shared across sessions, so one session can pick up where another stopped.

The plugin builds on OMP's native Plan Mode and approval flow and adds:

- Metis, which checks intent and gaps before planning starts;
- Prometheus, which asks only questions that can change the plan;
- optional Momus and Oracle reviews that look for blocking problems in the plan; Oracle can also be consulted on architecture and high-risk decisions;
- Atlas, the executor.

## Install

```bash
omp plugin install omo-prometheus@wows-omp-plugins
```

Requires OMP 18.3.5 or newer, with Plan Mode enabled for planning (`plan.enabled`, on by default). Restart OMP after installing.

If you used the older `prometheus` plugin, uninstall it first with `omp plugin uninstall prometheus@wows-omp-plugins`. Its session state does not carry over, so start a new plan.

## Quick start

```text
/prometheus add rate limiting to the public API
```

1. Prometheus enters Plan Mode, consults Metis and asks its questions. Answer them until it proposes a plan.
2. Review the proposal and approve it through OMP's normal approval dialog. Either approval choice hands off to Atlas.
3. Atlas starts executing on its own. The widget above the editor shows progress; `/atlas` opens the full view.
4. When all tasks, the four final gates and, if the plan delivers through a pull request, the delivery task pass, the plan is complete. `/atlas exit` leaves Atlas at any time.

## Usage

### Planning

`/prometheus` enters Plan Mode, or upgrades a Plan Mode session that is already active. Describe the request inline or in your next message. Running `/prometheus` again while planning leaves both Prometheus and Plan Mode.

In ordinary `/plan` mode, small and well-defined requests stay on OMP's normal path. For large, cross-cutting or ambiguous goals, the planner asks whether to switch to Prometheus. Accepting that question moves the session into the same workflow.

The plan is written as a `local://` session artifact and submitted through OMP's approval flow. With OMP plan autosave on, the approved copy is also saved under `.omp/plans/`.

`reviewLevel` (see [Settings](#settings)) controls whether Momus, or Momus and Oracle together, review the plan before it is proposed.

OmO documents the original in [Planning: the Ultrawork Planner](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#planning-the-ultrawork-planner); in the revision this plugin is based on, Prometheus is called the Ultrawork Planner and runs as `/ulw-plan`.

### Plan format

Every plan ends with two machine-readable sections. Tasks are checkbox rows numbered from `T1`, each with `Agent:`, `Depends on:`, `Tier:` and `Acceptance:` lines:

```markdown
## Tasks
- [ ] T1. Add the parser
  - Agent: task
  - Depends on: none
  - Tier: LIGHT
  - Acceptance: the new unit test passes and the CLI prints the parsed value
- [ ] T2. Update the command help text for the new flag
  - Agent: sonic
  - Depends on: T1
  - Tier: LIGHT
  - Acceptance: CLI help lists the new flag

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
```

Prometheus assigns each task the most specific agent your session's `task` tool offers, preferring `omo-toolkit` agents over generic `task` or `sonic`. If an agent is missing at execution time, Atlas tries its fallbacks (most fall back to `task`) and otherwise picks the best fit from the live list, without asking you to re-approve the plan.

### Execution

After approval the main session becomes Atlas. Atlas does not edit files itself: the plugin blocks implementation tools (`bash`, `eval`, `edit`, file writes and so on) in the parent session, so every task goes to a child agent through `task`. Read-only tools, `task`, `todo`, `ask` and similar coordination tools remain available.

Atlas tracks the plan in a ledger. A task is marked done only with proof from the child's actual final result; ticking a box in the plan file does not count. Tasks run in dependency order, and a plan with a dependency cycle is rejected before anything runs.

Each task has a tier. A LIGHT task is done when its own child's evidence shows its acceptance check passing. A HEAVY task (authentication, security, migrations, concurrency, persistence formats, public API, data-loss risk) is done only after a second, fresh child independently verifies it; a failed verification sends the task back for another attempt with the verifier's findings.

Every child reports a structured done-claim: the commands it ran with their results, the artifacts behind each acceptance check, the failure cases it probed, and its cleanup. Atlas checks that claim before it marks anything done. A defect a child finds inside the change's reach becomes a new discovered task (`D1`, `D2`, …) before the final gates; one outside it is noted for the final report. To diagnose a failure, Atlas may also spawn read-only research children, whose output never counts as proof.

When Atlas stops with unfinished tasks, the plugin nudges it to continue, up to eight times per message from you. Two nudges in a row without progress stop the loop and notify you.

If the ledger or plan files are missing, damaged or no longer match the approved plan, Atlas pauses until you fix it: restore the files, or exit with `/atlas exit` and get a changed plan approved.

While executing, Atlas keeps your session's todo list in sync with the plan (tasks, discovered tasks, corrections, final gates and delivery) and renames the session to an "Atlas …" title unless you named it yourself.

If OMP's `task.isolation.enabled` setting is on, Atlas runs every implementation child isolated; with `task.isolation.merge: patch` it warns once that each child's commits are squashed into one patch. Atlas never changes these settings.

OmO documents the original in [Execution: /ulw-execute](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#execution-ulw-execute), its name for Atlas execution in that revision.

### Final gates

Once every task is done, Atlas runs four verification gates in parallel, each on a fresh child that did no earlier work on the plan. Gate children only report; they never fix what they find.

| Gate | Agent | Checks |
| --- | --- | --- |
| F1. Plan compliance review | `momus` (fallback `reviewer`) | the changes match the approved plan, using the plan, the ledger and the plan's Git history |
| F2. Code quality review | `deep-high` (fallback `task`) | correctness, scope, maintainability, test value and regression risk; any CRITICAL or HIGH finding fails |
| F3. Real-surface QA | `deep-low` (fallback `task`) | every verification scenario run for real, each pass backed by an artifact |
| F4. Success-criteria fidelity | `deep-high` (fallback `task`) | the result against each success criterion and ideal-state row; it passes unless one is shown to fail |

Each gate returns a structured `PASS`, `FAIL` or `INCONCLUSIVE`; only a structured `PASS` counts. When a gate fails, Atlas adds correction rows (`X1`, `X2`, …), runs them like tasks, and reruns only that gate with the earlier rejection and the changes since. Completed tasks and gates that already passed stay done. If two reruns of the same gate also fail, Atlas asks you how to proceed.

### Delivery

When the repository has a remote, Prometheus asks how finished work should leave it, and the plan records `Delivery: direct`, `pr` or `ship`. With `pr`, a delivery task runs after the gates and a child pushes the branch and opens a pull request; with `ship`, it also waits for CI and merges. Atlas itself never runs git. With `direct` (the default), commits stay on the working branch.

### The `/atlas` command

```text
/atlas                          # inactive: open Atlas Dispatch; active: open the running plan's view
/atlas <plan-name-or-id>        # enter a plan in this session and start executing
/atlas start <plan-name-or-id>  # same as above
/atlas list                     # list approved plans with their status
/atlas show <plan-name-or-id>   # show a plan's rows, acceptance and evidence
/atlas resume <plan-name-or-id> # switch to a session that already ran the plan
/atlas rename <id> <new name>   # change a plan's display label
/atlas delete <id> [--yes]      # delete a plan and its evidence
/atlas exit                     # leave Atlas (asks first if the plan is unfinished)
```

Everything except bare `/atlas` and `exit` works only while Atlas is inactive. To switch plans, exit first. A plan matches by its display label, its original name, or either one without the `-plan` suffix; use the full ID when names collide. A plan whose name starts with a subcommand word is still reachable by ID or through `/atlas start`.

Atlas Dispatch lists unfinished plans in the current workspace; Tab shows all plans, including finished, invalid and other-workspace ones, for viewing only.

| Key | Action |
| --- | --- |
| type | fuzzy-search names, IDs or status |
| Enter | start the highlighted plan right away |
| Space, Shift+I | open the fullscreen plan view |
| Shift+R | resume in a session that already executed the plan |
| Backspace, Delete | edit the search; delete the plan when the search is empty (Backspace) or always (Delete) |
| Shift+N | rename the display label |
| Esc | close |

Starting a plan in a non-empty session asks whether to use a new session or this one. Atlas then sends the first execution message itself.

While Atlas is active, bare `/atlas` opens a live, read-only view with each row's status, running children with their model, current tool and usage, and a timeline (Tab). Shift+X exits Atlas, Esc closes the view. Disable the widget above the editor with `atlasWidget`.

### Continuing in another session

Plans and their evidence live outside any one session, in your OMP session directory. Session A can finish part of a plan and exit, and session B can continue it with `/atlas <name>`, as long as both use the same session directory and workspace. Shift+R or `/atlas resume` instead switches back to a session that already ran the plan; it comes back in Atlas mode and waits for your next message.

A plan runs in one session at a time. Exiting releases it immediately but does not cancel running children or mark work complete. While a child is still running, its session keeps the plan until the child reports a final result.

Updating the plugin keeps existing plans runnable without re-approval.

### Models

Metis, Oracle and Momus run on OMP's `@slow` role. Atlas runs in the main session; the plugin registers an `atlas` model role you can assign in `/model`:

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

While a Prometheus proposal waits for approval, the approval slider also offers `atlas`; it starts on `default`, so move it to `atlas` to execute with that role. `/atlas <plan>` switches to the `atlas` role when it is assigned and keeps the current model otherwise. The role is not part of the Ctrl+P cycle.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omo-prometheus`.

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | Plan review before the proposal. |
| `atlasWidget` | boolean | `true` | Show the progress widget above the editor while Atlas executes. |
| `herdrDag` | boolean | `true` | Publish Atlas progress for the `omp-herdr-dag` viewer. |

Review levels:

- `ask`: Momus reviews every plan. Momus and Oracle together review when you ask for high accuracy or the work is nontrivial and unclear; for clear work you get a one-time choice.
- `standard`: Momus reviews every plan; an explicit request still adds Oracle.
- `high-accuracy`: Momus and Oracle always review.
- `off`: no Momus or Oracle review, even on request. Metis still runs, and Atlas still runs the F1 compliance gate.

User settings merge with project overrides. Settings are read at session start, so restart the session after changing them.

## Working with other plugins

- `omo-toolkit`: plans prefer its category agents, and gates F2, F3 and F4 run on `deep-high` and `deep-low`.
- `judge-dispatch`: does not reroute anything while a plan executes, and never reroutes `metis`, `momus` or `oracle`.
- `omp-herdr-dag`: shows Atlas tasks, discovered tasks, fixes, gates and delivery as a live dependency graph, with each task's tier and verification state.
- `roadmap`: a plan proposed while a roadmap stage is bound remembers that stage. Atlas may use the roadmap tools during execution, and when the plan completes (after delivery, for `pr` and `ship` plans) the session is reminded to close the stage with the gate evidence. The stage is never closed automatically.
- [Magic Context](https://github.com/cortexkit/magic-context): its `ctx_*` tools stay available to Atlas.

## Without the terminal UI

| Host | `/atlas` behavior |
| --- | --- |
| RPC (`--mode rpc`, rpc-ui) | Atlas Dispatch becomes a chain of select dialogs (pick a plan, then Start, Resume, View details, Rename, Delete or Back). The widget is sent as text lines. |
| ACP editors | The same dialogs through form elicitation. No widget. |
| SDK, `--no-ui`, print | No dialogs; use the subcommands. Deleting needs `--yes`. `/atlas resume` works only from the one session that executed the plan; otherwise it names the sessions to open. |

Prometheus planning needs Plan Mode's interactive approval, so it runs in the TUI, RPC and ACP only.

Client programs can read planning and execution state from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- Atlas needs file-backed sessions on a local filesystem that supports hard links, atomic rename and file and directory sync. In-memory or remote-only session storage makes it refuse to run. Sessions with different session directories cannot see each other's plans.
- Some OMP versions give no reliable signal that a child has fully finished. Then the plan stays owned by its session until that OMP process exits; start a new session after closing it.
- Plans run with versions before the shared ledger cannot be resumed; get them approved again.
- `checkpoint` and `rewind` are blocked in the Atlas parent, because rewinding would detach the session from the proof of completed tasks.
- Tools from other extensions and MCP servers are blocked in the Atlas parent unless the reference lists them.

## Reference

[REFERENCE.md](REFERENCE.md) covers the Atlas tool guard, the plan bundle and ledger, ownership, the state snapshot, and the event contracts with `omp-herdr-dag` and `roadmap`.

## License

The Prometheus, Metis, Oracle, Momus and Atlas prompt assets are modified derivatives of OmO; `NOTICE` records the upstream repository, the pinned revision, earlier fork history and the modification notice.

Extension code and original packaging are MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/` and `skills/prometheus/` stay under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), which allows internal business, personal and non-commercial use, and free distribution only for non-commercial purposes.
