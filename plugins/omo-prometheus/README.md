# omo-prometheus

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

Both approval choices of a Prometheus plan hand off to Atlas. "Approve and execute" starts a fresh session. To survive that switch, the plugin writes a marker to `local://prometheus/<slug>.proposal.json` when the plan is proposed, and OMP copies it into the new session along with the plan. Plans approved in ordinary Plan Mode have no marker, and the plugin leaves them alone.

### Dispatching with `/atlas`

```text
/atlas                   # while inactive: open Atlas Dispatch, the interactive plan menu
/atlas <plan-name-or-id> # while inactive: enter a plan in this session and start executing (name/ID completion available)
/atlas                   # while active: open the running plan's view (read-only)
/atlas exit              # while active: exit (asks first if the plan is unfinished)
```

Plans come from Prometheus; Atlas Dispatch is where you hand one to Atlas. It opens on unfinished plans in the current workspace. Tab switches to All, which adds complete, invalid, and other-workspace plans; All is display-only, so start and resume work only from the Unfinished view. The menu shows each plan's progress and the highlighted plan's T/F rows.

| Key | Action |
| --- | ------ |
| type | fuzzy-search names, IDs, or status |
| Enter | start the highlighted plan and begin executing right away |
| Space, Shift+I | open the fullscreen plan view |
| Shift+R | resume the plan in a session that already executed it |
| Backspace | edit the search, or delete the highlighted plan when the search is empty |
| Delete | delete the highlighted plan |
| Shift+N | rename (display label only; the approved plan is unchanged) |
| Esc | close |

A plan runs in one session at a time, so Enter and Shift+R refuse a plan that another live session holds.

**Start (Enter).** In an empty session Atlas enters the plan here. Otherwise a prompt offers a new session, this session, or cancel. Atlas then sends the first execution message itself, the same way native plan approval starts work, so you do not need to type anything. Started plans can be started again in another session; shared progress and evidence carry over.

**Resume (Shift+R).** Only plans that have started can be resumed. The plugin scans this project's session files for sessions that executed the plan. With one match it switches there; with several it lists them, most recently used first. The session comes back in Atlas mode but does not continue on its own; send a message when you are ready. Resume is refused during planning.

**Plan view (Space, Shift+I).** The fullscreen inspector keeps its row selection and scroll when progress changes. Tab switches its body between the selected row and a newest-first timeline; derived events from older bundles are marked. Space still reveals archived child output. Up/Down select rows, PgUp/PgDn scroll, Enter and Shift+R start or resume as in the list, and Esc returns to the list.

Deleting asks for confirmation and permanently removes the plan and its evidence. It is refused while a live session owns the plan or native work is pending. Without an interactive UI, bare `/atlas` prints the plan list.

A plan can be selected by its display label, its original name, or either name without the `-plan` suffix, so `checkout` and `checkout-plan` match the same plan. If several plans share a name, use the full ID from the list.

While Atlas is active, bare `/atlas` opens the same fullscreen inspector as a live, read-only observation page: committed ledger changes, child lifecycle, and host progress update without reopening it. The header reports running children and plan elapsed time; in-progress rows show elapsed time in the sidebar and a Live section with child identity, model/thinking, tool and arguments, intent, usage, cost, retries, and recent activity when the host supplies it. Tab switches to the persisted timeline. Start, resume, delete, and rename are unavailable. Shift+X exits Atlas as `/atlas exit` does, and Esc closes the page. If the host has no progress channel, ledger and lifecycle details still work. Without an interactive UI, bare `/atlas` only says which plan is running. Exiting asks first if rows are unfinished or progress cannot be verified. `/atlas` with any other argument, even the current plan, is an error: exit first, then enter the other plan from the same session. Atlas will not enter during planning or run an unapproved plan. If entering fails, the session stays paused until you run `/atlas exit`; it never falls back to prompt-only execution.

During execution an above-editor Atlas widget shows the plan bar, done/total and gate counts, running children, and compact live per-row usage. It remains visible while you use the normal editor and disappears on exit, session switch, or shutdown. Disable it with `atlasWidget`; the `/atlas` observation page remains available.

Session A can finish part of a plan and exit, and session B can pick it up with `/atlas <name>`, as long as both use the same host session directory and workspace. Exiting is immediate: it neither cancels children nor marks anything complete, and it does not block closing the host. While native child work is still running, the plan stays owned by its session until that work reports a final result, so no other session can write to it at the same time. A session that owns a plan and has provably died can be recovered; unclear ownership, or ownership by another host, is refused.

Some hosts do not give Atlas a reliable signal that a child's final processing has finished, and a cancelled wake-up can settle before the child does. In those cases the plan stays owned until the original OMP process exits; start a new session after closing it.

While Atlas owns a plan, the session's plan reference is `atlas://<plan-id>/plan.md`, a read-only view of the approved `plan.md` that child agents load through OMP's plan handoff. Other sessions cannot read it, and it stops resolving if the plan bytes change.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omo-prometheus`.

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| Setting | Values | Default | Effect |
| ------- | ------ | ------- | ------ |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | Controls plan review before the proposal. |
| `atlasWidget` | `true` \| `false` | `true` | Show the live progress widget above the editor while this session executes Atlas. |

- `ask`: Momus reviews every plan. Momus and Oracle together review when you ask for high accuracy or the work is nontrivial and unclear; for clear work you get a one-time choice.
- `standard`: Momus reviews every plan without offering high accuracy, but an explicit request still adds Oracle.
- `high-accuracy`: Momus and Oracle always review, with no choice offered.
- `off`: no Momus or Oracle plan review, even on request. Metis still checks for planning gaps, and Atlas still runs the F1 compliance gate after approval.

User settings merge with project overrides. The plugin reads settings for the session's cwd at startup, so restart the session after changing them.

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

Prometheus plans against the agents the `task` tool actually lists in the session, after spawn policy and disabled agents are applied, and Momus reviews against the same list. Each `Agent:` row should name the most specific listed specialist; installed omo-toolkit agents are preferred over generic `task` or `sonic`. A user-defined agent is valid only if it is listed, and an unlisted name only if it has a known fallback. If the tool description cannot be parsed, planning still works with known names, but user-defined names cannot be checked and known names are kept as written.

At dispatch, the requested agent is tried first, then its fallbacks in order, choosing only agents in the live list:

|Requested agent|Fallback chain|
|---|---|
|`deep-low`, `deep-high`, `ultrabrain`, `architect`, `visual-engineering`, `artistry`, `writing`|`task`|
|`librarian`|`scout` → `task`|
|`metis`, `momus`, `oracle`|`reviewer` → `task`|
|`sonic`, `scout`, `reviewer`, `security-reviewer`|`task`|
|`task`|none|

This table swaps agents, not models; each agent's model-role chain is documented in the [omo-toolkit README](../omo-toolkit/README.md#agents). If nothing in a chain can be spawned, the ledger shows `unavailable` and Atlas reports a blocker.

## Execution ledger

Native approval creates a plan bundle at `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/`. That is usually `~/.omp/agent/sessions/<working-dir>/atlas/`, outside the repository and outside `local://`; custom session directories are respected.

```text
plan.md          exact approved plan
approval.json    source approval, workspace, and plan identity
ledger.json      task and gate progress
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of immutable approval
checkpoint.json independent attempt and receipt bindings
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

The ledger tracks each T and F row's acceptance criteria, dependencies, status, requested and resolved agent, attempt, evidence receipt, and the plan's SHA-256, plus any X correction rows a final gate asked for. The dependency graph is validated up front, so a plan with a cycle never partially runs. Ticking a box in the plan file does not count as progress.

Atlas drives the ledger with `atlas_ledger` (`status`, `start`, `done`, `block`, `reopen`, `fix`). A row is marked done only with proof from the child's real final result, so a failed, foreign, or still-running child, or a hand-written reference, cannot complete work. Blocking or reopening a row affects only that row: completed work that depends on it keeps its proof, and the final gates judge the finished result. `atlas_release` needs a valid receipt for every row plus your explicit confirmation.

If the ledger or plan artifacts are missing, corrupt, or no longer match the approved plan, Atlas pauses instead of carrying on without one, and nothing is silently rebuilt. Restore the approved artifacts, or exit with `/atlas` and get a changed plan approved again.

When Atlas stops with unfinished rows, the plugin continues it with a hidden `<atlas-continuation>` message containing the ledger summary. OMP allows at most eight chained continuations per user turn. Two continuations in a row without progress stop the loop and notify you; exit with `/atlas` or send new instructions. Any message from you resets the count.

Progress lives in the shared bundle, not in the session. Child outputs are copied into `evidence/` and rechecked against their digests, so verified progress survives deleting the original session. `atlas_ledger status` shows where those outputs are. Only the child's own output is kept; files it merely links to are not copied. If a row's proof goes missing or changes, that row reopens, and an old session branch cannot roll shared progress back.

Updating the plugin keeps existing plans runnable. A ledger written by an earlier release is upgraded when it is loaded, keeping its verified progress, and needs no fresh approval.

`timeline.jsonl` records attachment and release, row starts, completion, blocking and reopening, correction rows, and gate verdicts. It is display-only: a missing or damaged timeline never invalidates approval, ownership, receipts, or progress. Bundles from earlier releases show derived history from their ledger until real timeline events are appended; derived events are not written back. A crash-truncated final line and unknown future event versions are ignored.

Plans run with older versions of the plugin kept their ledger inside the session. Those are not migrated: resuming one pauses and asks for fresh approval. The old `prometheus_ledger` and `prometheus_release` tools are now `atlas_ledger` and `atlas_release`, with no aliases.

## Final gates

Once every T row is done, Atlas sends F1–F4 together to four separate fresh verification children, none of which did implementation work or already reviewed.

|Gate|Agent|Fallback|Checks|
|---|---|---|---|
|F1. Plan compliance review|`momus` (`review_kind: compliance`)|`reviewer`|executed changes match the approved plan, using the ledger summary and `git diff --stat`|
|F2. Code quality review|`deep-high`|`task`|maintainability, scope, test value, and evidence-backed blockers|
|F3. Real-surface QA|`deep-low`|`task`|every scenario in the plan's Verification section run on the real surface with command and observed result|
|F4. Success-criteria fidelity|`deep-high`|`task`|every named success criterion and adversarial case, tied to evidence|

Each gate returns a strict structured verdict (`PASS`, `FAIL`, or `INCONCLUSIVE`) with a summary and evidence. Only a matching structured `PASS` counts, never a passing word in prose.

When a gate rejects the work, Atlas records each correction as an X row (`atlas_ledger fix`), dispatches it like any task, and then reruns only the gate that rejected. Completed T rows and gates that already passed are not reopened.

## Models

Metis, Oracle, and Momus run as child agents on OMP's `@slow` role, which resolves through your OMP model configuration. The plugin hard-codes no provider or model.

Atlas is the main session after approval, not a child agent. The plugin registers an `atlas` model role, shown in `/model` as **Atlas**, that you can assign like any other role. It is not part of the Ctrl+P cycle. While a Prometheus proposal waits for approval, `atlas` is temporarily added to the front of `cycleOrder`, so the approval slider offers it next to `smol`, `default`, and `slow`, while Ctrl+P still skips it. The slider still starts on `default`; move it to `atlas` to execute with that role. The change to `cycleOrder` is undone at the next input or agent turn, or when planning ends. Ordinary Plan Mode approvals never show `atlas`, and roles without an available model never appear on the slider.

`/atlas <plan>` switches to the `atlas` role when it is assigned and keeps the current model otherwise. If the assigned model cannot be resolved, Atlas still starts and reports that it kept the current model.

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

## Compatibility

Requires OMP 18.3.1 or newer. OMP stays in charge of `xd://propose` approval and autosave. Planning drafts and the handoff marker live in `local://`, and approved plans live in the shared Atlas bundle. The plugin creates no project-local `.omo` state and runs children through OMP's native execution.

Shared execution needs file-backed sessions on a local filesystem that supports hard links, atomic rename, and file and directory sync. In-memory, remote-only, or otherwise unsupported storage makes Atlas refuse to run. Sessions with different session directories cannot see each other's plans, and moving a session does not move its `atlas/` directory.

## License

The Prometheus, Metis, Oracle, Momus, and Atlas prompt assets are modified derivatives of OmO; `NOTICE` records the upstream repository, the pinned revision, earlier fork history, and the modification notice.

Extension code and original packaging are MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/`, and `skills/prometheus/` stay under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), which allows internal business, personal, and non-commercial use and free distribution only for non-commercial purposes.
