<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-dark.png">
  <img alt="omo-prometheus" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-light.png">
</picture>

# omo-prometheus

English | [简体中文](README.zh.md)

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO)'s Prometheus planning and Atlas execution, ported to OMP. Prometheus asks questions until it can write a plan worth approving. Atlas then runs each task through a subagent, keeps evidence for every task, and runs four independent gates before the plan counts as done.

The plugin builds on OMP's Plan Mode and approval flow. It adds:

- Metis, which checks intent and gaps before planning starts;
- Prometheus, which asks only questions that can change the plan;
- optional Momus and Oracle reviews, which can reject a plan for what it misses or what it over-builds;
- Atlas, the executor.

## Install

```bash
omp plugin install omo-prometheus@wows-omp-plugins
```

Requires OMP 18.10.4 or newer. Planning also needs Plan Mode enabled (`plan.enabled`, on by default). Restart OMP after installing.

If you used the older `prometheus` plugin, uninstall it first with `omp plugin uninstall prometheus@wows-omp-plugins`. Its session state does not carry over, so start a new plan.

## Quick start

```text
/prometheus add rate limiting to the public API
```

1. Prometheus enters Plan Mode, consults Metis and asks its questions. Answer until it proposes a plan.
2. Review the proposal and approve it in OMP's normal approval dialog. Either choice hands off to Atlas.
3. Atlas starts on its own. The widget above the editor shows progress, and `/atlas` opens the full view.
4. The plan is complete when every task, the four final gates and any delivery task pass. `/atlas exit` leaves Atlas at any time.

## Usage

### Planning

`/prometheus` enters Plan Mode, or upgrades a Plan Mode session that is already active. Put the request on the same line or in your next message. Running `/prometheus` again while planning leaves both Prometheus and Plan Mode.

In plain `/plan` mode, small and well-defined requests stay on OMP's normal path. For large, cross-cutting or ambiguous goals, the planner asks whether to switch to Prometheus.

The plan is written as a `local://` session artifact and goes through OMP's approval flow. If OMP's plan autosave is on, the approved copy is also saved under `.omp/plans/`. [`reviewLevel`](#settings) decides whether Momus alone, or Momus and Oracle together, review the plan before it is proposed.

Plans only include work someone depends on. Each ideal-state row names who depends on it and where the requirement comes from: your request, a decision you confirmed, or a contract the repository already has. Each task lists the mechanisms it adds (`Mechanisms:`), and the plan's `## Must not build` section lists what it leaves out. The proposal shows both, plus any reviewer notes Prometheus declined. Reviewers can reject a plan for building too much, and the F2 gate fails work beyond what the plan declared.

Prometheus calls `architect` for an open boundary or decomposition question, and `ultrabrain` for a hard, independent algorithm or contract question. It calls an advisor only when that exact name is in the live agent list. Trivial and ordinary Standard plans call neither, and an unavailable advisor is skipped. Advisors are read-only and do not replace Metis, Oracle or your decisions.

This plugin keeps the `/prometheus` and `/atlas` commands from OmO's [Ultrawork Planner](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#planning-the-ultrawork-planner) (`/ulw-plan`) and [`/ulw-execute`](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#execution-ulw-execute), and it tracks those kernels. `NOTICE` records the pinned revision.

### Plan format

Every plan ends with two machine-readable sections. Tasks are checkbox rows numbered from `T1`, each with `Agent:`, `Depends on:`, `Tier:` and `Acceptance:` lines. `Tier:` is `LIGHT` or `HEAVY`; a missing tier means LIGHT. The full grammar is in the [reference](REFERENCE.md#plan-grammar).

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

Prometheus picks the most specific agent your `task` tool offers for each task, preferring `omo-toolkit` agents. If that agent is missing at execution time, Atlas tries its fallbacks, then the best fit from the live list. You do not need to approve again.

A plan bound to a [roadmap](#working-with-other-plugins) stage also needs one plan-level line, such as `Roadmap criteria: DC1, DC3`, listing the stage's done criteria it delivers. When the roadmap plugin reports criteria for the stage, Prometheus rejects the proposal before approval if that line is missing, repeated, empty, or names a criterion that is not current. Criteria left out stay open for another plan.

### Execution

After approval, the main session becomes Atlas, and Atlas does not edit files. The plugin blocks implementation tools (`bash`, `eval`, `edit`, file writes and so on) in the parent session, so every task goes to a child agent through `task`.

Progress lives in a ledger. A task is done only when its child's final result proves it. Ticking the box in the plan file does nothing. Tasks run in dependency order, and a dependency cycle is rejected before anything runs. A HEAVY task (security, migrations, public API, data-loss risk and similar) also needs a second, fresh child to verify it. The [reference](REFERENCE.md#ledger) has the contracts.

Defects that children find are sorted by where they sit:

- A defect inside the change's reach becomes a discovered task (`D1`, `D2`, …) and runs before the final gates.
- A defect outside it becomes a deferred finding (`O1`, `O2`, …). Atlas triages it as a Roadmap TODO, a duplicate, won't fix, or report only. Report only is the choice when the repository has no usable roadmap.
- The final report lists every finding and its disposition. Atlas cannot be released while a finding is untriaged.

Atlas keeps working until the plan is done. If the ledger or plan files go missing, get damaged, or stop matching the approved plan, Atlas pauses. It resumes once you restore them, or after you exit with `/atlas exit` and approve a changed plan.

Recorded failures survive restarts and session handoffs; a failure Atlas had not recorded yet does not. A row stops after two identical counted failures in a row, a third counted failure, or four hours of timed product work. Each gate rerun and each verifier dispatch starts a fresh clock, time spent waiting on repairs or on P1's CI and review is not timed, and an expired verifier keeps the implementation proof. Product and unknown failures count. A harness failure with evidence that product behavior never ran gets one uncounted repair, and a second harness failure stops the row. When independent work runs out, you can grant a new window without losing history or changing acceptance. The [reference](REFERENCE.md#retry-windows-and-delivery-repair) has the details.

Blocked work stays unfinished. Atlas keeps and lists any unverified commits or files it can trace to a child, and it never rolls them back. Delivery cannot proceed while gaps remain.

If a task needs you, Atlas marks it blocked and keeps going with everything that does not depend on it. It puts questions that would not change the work in its reply. When nothing else can move, it opens a dialog and waits. It never treats a real blocker as optional, and the final report lists every assumption it made.

If you fix a blocker yourself, tell Atlas which commit or files did it. Atlas reopens the task, and a new child checks it.

If your answer changes how a task's acceptance is met, for example by relaxing an unreachable ceiling or accepting a narrower result, Atlas records an owner ruling (`R1`, `R2`, …) and asks you to confirm it in a dialog. The task is then redone against the ruling. Reviewers see every ruling, and the final report lists each one as a deviation from the approved plan. If the change affects the tasks or scope, run `/atlas exit` and plan it with `/prometheus`.

Atlas mirrors the plan into your todo list and titles the session "Atlas …" unless you named it. The [reference](REFERENCE.md#session-integration) describes how the todo list stays in step.

Atlas follows the host's `task.isolation` settings with one exception. With `merge: patch`, it switches to `branch` while it runs, so each child's commits survive, and it restores your setting on exit. Children commit their own work. Atlas commits only roadmap and ADR documents, plus work a finished child left uncommitted, through its guarded `atlas_git` tool.

Outside a Git repository, nothing uses Git. Plans say `Commit: none`, delivery is `direct`, isolation is not required, and F1 checks the plan without Git history. Run `git init` yourself before planning if you want commits.

### Final gates

When every task is done, Atlas runs four gates in parallel. Each runs on a fresh child that reports and never fixes.

| Gate | Agent | Checks |
| --- | --- | --- |
| F1. Plan compliance review | `momus` (fallback `reviewer`) | the changes match the approved plan, checked against the plan, the ledger and Git history since the plan's baseline |
| F2. Code quality review | `deep-high` (fallback `task`) | correctness, scope, proportion, maintainability, test value and regression risk. Any CRITICAL or HIGH finding fails, including machinery built beyond what the plan declared |
| F3. Real-surface QA | `deep-low` (fallback `task`) | every verification scenario, run for real, with an artifact behind each pass |
| F4. Success-criteria fidelity | `deep-high` (fallback `task`) | the result against each success criterion and ideal-state row. It passes unless a criterion is shown to fail |

Each gate returns `PASS`, `FAIL` or `INCONCLUSIVE`. Only `PASS` counts. Non-PASS results use up the gate's retry window. Each correction becomes an X row, and only the gate that rejected the work reruns with a fresh child. Passing gates keep their proof. A gate whose window runs out blocks until you confirm a new one.

### Delivery

`delivery` sets how finished work leaves the repository. `direct` keeps commits on the working branch. `pr` has a child push the branch and open a pull request after the gates. `ship` also waits for CI and merges. With `ask` (the default), Prometheus asks when the repository has a remote. A fixed value is used without asking, and `pr` or `ship` without a remote becomes `direct`. You can override the setting in conversation. The plan's `Delivery:` line governs execution, and children always do the pushes and merges.

`pr` stops at the open pull request. `ship` keeps the same PR under watch through CI and review. In-scope failures become X repair rows with P1 as their origin, and affected tests and QA run again. The delivery child never fixes product code in place.

Merging follows the repository's required checks, review and merge policy, with no unresolved blocking change request. Atlas never approves its own work or invents a reviewer minimum. Missing access, a required human approval, an ambiguous PR branch or an incompatible policy blocks delivery. Scope or acceptance changes still need your decision. PR head and base must be explicit. Atlas checks the remote CI, review and merge evidence that children report, and it does not poll GitHub. Native isolation stays with the host.

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

Every subcommand except bare `/atlas` and `exit` works only while Atlas is inactive. To switch plans, exit first. Plans match by name or ID (see [plan matching](REFERENCE.md#plan-matching)).

Atlas Dispatch lists unfinished plans in the current workspace. Tab shows all plans, including finished, invalid and other-workspace ones, for viewing only.

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

While Atlas is active, bare `/atlas` opens a live, read-only view. It shows each row's status, running children with their model, current tool and usage, and a timeline (Tab). Shift+X exits Atlas and Esc closes the view. Set `atlasWidget` to `false` to hide the widget above the editor.

In Tern, Atlas Dispatch and the plan view open as native sheets over the conversation, and the progress widget shows a native progress bar. Clicks select, double-clicks open, and the tabs, buttons and keys all work. Atlas and Prometheus tool calls appear as native cards, and the model's guidance stays folded until you expand a card.

### Continuing in another session

Plans and their evidence live in your OMP session directory, outside any one session. Session B can continue a plan that session A started with `/atlas <name>`, as long as both share the session directory and workspace. Shift+R or `/atlas resume` returns to a session that already ran the plan, in Atlas mode, and waits for your next message.

A plan runs in one session at a time. Exiting releases the plan, but it does not cancel running children or mark work complete. A session with a running child keeps the plan until that child reports. The [reference](REFERENCE.md#ownership) covers ownership. Updating the plugin keeps existing plans runnable without re-approval.

### Models

Metis, Oracle and Momus run on OMP's `@slow` role. Atlas runs in the main session. The plugin registers an `atlas` model role that you can assign in `/model`:

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

While a proposal waits for approval, the approval slider also offers `atlas`. Move it off `default` to execute with that role. `/atlas <plan>` applies the role when it is assigned. The role is not in the Ctrl+P cycle.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omo-prometheus`.

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | Plan review before the proposal. |
| `reviewRoundLimit` | whole number ≥ 0 | `5` | Most plan-review rounds per plan; `0` or empty (`""`) means unlimited. |
| `delivery` | `ask` \| `direct` \| `pr` \| `ship` | `ask` | How finished work leaves the repository; see [Delivery](#delivery). |
| `atlasWidget` | boolean | `true` | Show the progress widget above the editor while Atlas executes. |
| `progressReports` | boolean | `false` | Atlas posts a short chat update before each dispatch batch and after each task: progress, result, how it was checked, any problem and the next step. Useful when its child assignments are hard to read. |
| `herdrDag` | boolean | `true` | Publish Atlas progress for the `omp-herdr-dag` viewer. |

Review levels:

- `ask`: Momus reviews every plan. Momus and Oracle review together when you ask for high accuracy or the work is non-trivial and unclear. For clear work, you get a one-time choice.
- `standard`: Momus reviews every plan. An explicit request still adds Oracle.
- `high-accuracy`: Momus and Oracle always review.
- `off`: no Momus or Oracle review, even on request. Metis still runs, and Atlas still runs the F1 gate.

The plugin counts review rounds itself. Each dispatch of Momus, or of Momus and Oracle together, is one round, including a round where the reviewer could not read the plan. At `reviewRoundLimit` you choose between adding rounds for that plan and stopping. If you stop, Prometheus proposes the plan as it stands and lists the open blockers. Without an interactive user, review stops at the limit.

User settings merge with project overrides. Settings are read at session start, so restart the session after changing them.

## Working with other plugins

- `omo-toolkit`: plans prefer its category agents, and gates F2, F3 and F4 run on `deep-high` and `deep-low`.
- `judge-dispatch`: does not reroute anything while a plan executes, and never reroutes `metis`, `momus` or `oracle`.
- `omp-herdr-dag`: shows Atlas tasks, discovered tasks, fixes, gates and delivery as a live dependency graph.
- `roadmap`: a plan remembers the stage it was proposed for and the criteria it declares. Several plans can deliver one stage, and the roadmap plugin can ask which plans exist for a stage and how far they got. Atlas may use the roadmap tools. With a usable roadmap (an initialized roadmap in a Git work tree, plus the `adr` plugin), Atlas files a Roadmap TODO for each deferred finding. If the stage's objective, scope, criteria or design constraints change after approval, `/atlas <plan>` and plan completion show a notice, and execution continues. A completed plan reminds the session to evaluate closing the stage. A stage closes only when every current criterion has passing evidence from some plan, never automatically. Starting a stage during planning only binds it, because Plan Mode cannot commit. Atlas starts the stage and commits that start before its first task, and it refuses to dispatch until that commit exists.
- `adr`: Atlas may use the ADR tools, with or without `roadmap`. Atlas accepts, rejects and supersedes ADRs itself through `adr_manage`; children never do. A stage with proposed ADRs cannot close until they are dealt with.
- [Magic Context](https://github.com/cortexkit/magic-context): its `ctx_*` tools stay available to Atlas.

## Without the terminal UI

| Host | `/atlas` behavior |
| --- | --- |
| RPC (`--mode rpc`, rpc-ui) | Atlas Dispatch becomes a chain of select dialogs (pick a plan, then Start, Resume, View details, Rename, Delete or Back). The widget is sent as text lines. |
| ACP editors | The same dialogs through form elicitation. No widget. |
| SDK, `--no-ui`, print | No dialogs; use the subcommands. Deleting needs `--yes`. `/atlas resume` works only from the one session that executed the plan; otherwise it names the sessions to open. |

Prometheus planning needs Plan Mode's interactive approval, so it runs only in the TUI, RPC and ACP.

Client programs can read planning and execution state from a state snapshot. See the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- Atlas needs file-backed sessions on a local filesystem that supports hard links, atomic rename, and file and directory sync. In-memory or remote-only session storage makes it refuse to run. Sessions with different session directories cannot see each other's plans.
- Plans run with versions before the shared ledger cannot be resumed. Get them approved again.

## Reference

[REFERENCE.md](REFERENCE.md) covers the Atlas tool guard, plan bundle and ledger, plan matching, ownership, the state snapshot, and the event contracts with `omp-herdr-dag`, `roadmap` and `adr`.

## License

The Prometheus, Metis, Oracle, Momus and Atlas prompt assets are modified derivatives of OmO. `NOTICE` records the upstream repository, the pinned revision, earlier fork history and the modification notice.

Extension code and original packaging are MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/` and `skills/prometheus/` stay under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), which allows internal business, personal and non-commercial use, and free distribution only for non-commercial purposes.
