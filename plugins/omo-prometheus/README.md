# omo-prometheus

This plugin ports the Prometheus planning workflow and Atlas execution model from [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) to OMP. It is a modified OMP-native adaptation, not an independent reimplementation presented under a new name.

It keeps OMP's native Plan Mode and approval flow, then adds the workflow that makes large plans useful:

- Metis performs pre-planning intent and GAP analysis.
- Prometheus asks only the questions that can change the plan, with an iterative clarification loop.
- Configurable Momus and Oracle plan review checks blocking reference, executability, QA, and task-grammar gaps when enabled.
- Oracle is available for architecture and high-risk decisions.
- Atlas takes over after approval, delegates every plan task to child agents, saves progress and verified evidence across sessions, and runs four final verification gates before declaring completion.

`/prometheus` and opted-in native `/plan` share the planning workflow. `/atlas` separately controls execution and resumes approved plans in another session.

## Install

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install omo-prometheus@wows-omp-plugins
```

Restart OMP after installation so the extension and agents are loaded.

## Migrating from `prometheus`

Uninstall the retired package with `omp plugin uninstall prometheus@wows-omp-plugins`, then install `omo-prometheus@wows-omp-plugins`. Session state from the old plugin is not carried over; start a new Prometheus plan after migrating.

## Usage

Start or leave Prometheus planning, like native `/plan`:

```text
/prometheus
```

Turning it on enters OMP's native Plan Mode (or upgrades an already active Plan Mode session); describe the request in your next message, or pass it inline as `/prometheus <request>`. Running `/prometheus` again while planning leaves both Prometheus and Plan Mode. The plan is written to the session's `local://` artifact and submitted through `xd://propose`; if OMP plan autosave is enabled, the approved copy is saved under `.omp/plans/`.

For ordinary native Plan Mode:

```text
/plan
```

The plugin leaves small, well-defined requests on the normal OMP path. For large, cross-cutting, or ambiguous goals, the planner uses `ask` to offer the Prometheus workflow: one question with header `Prometheus` whose second choice names Prometheus. Only that exact question counts as consent. If accepted, it activates the same shared workflow instead of switching to a second planner implementation.

After approval, the main session becomes Atlas. The execution prompt overrides OMP's delegation preference for this approved plan, and the extension blocks direct implementation tools in the parent session. Use `task` to assign work to child agents. `/prometheus` never exits Atlas; use bare `/atlas` instead.

Both approval choices hand off to Atlas. "Approve and execute" starts a fresh session: when the plan is proposed, the plugin writes a marker to `local://prometheus/<slug>.proposal.json`, which OMP copies into the new session together with the plan, so the handoff survives the session switch without any in-process state. A plan approved in ordinary Plan Mode has no marker and is left alone.

### Resume with Atlas

```text
/atlas                  # while inactive: list approved shared plans
/atlas <plan-name-or-id> # while inactive: enter or resume a plan
/atlas                  # while active: exit without discarding progress
```

Any argument while Atlas is active is an error, even the current plan name. Exit first; the same OMP session may then enter another plan. A name matches the plan's listed name or its proposal file name, so `checkout` and `checkout-plan` select the same plan; an unknown name lists the available ones. If several approved plans share a name, select the full ID shown by the list. Atlas cannot enter during planning or execute an unapproved plan. A failed entry remains paused until you exit with bare `/atlas`; it does not silently authorize ordinary implementation.

Session A can complete part of a plan, exit Atlas, and leave session B to resume it with `/atlas <name>`. Both must use the same host session directory and canonical workspace. Exiting is immediate and does not cancel children or claim completion. If native work is still running, its plan remains exclusively owned until final results or actual job settlement; another session cannot race those writers. Closing the host is not blocked. A provably dead local owner can be recovered; ambiguous or foreign-host ownership is refused.

Some hosts report peer-message wake lifecycle events without a verifiable final wake-job handle. Atlas does not treat an `idle` or `completed` lifecycle signal as proof that native postprocessing finished. In that case the old plan remains owned until the originating host terminates; start a new session after closing that host to recover it safely.

A cancelled native wake-job wrapper can finish before the underlying child and its postprocessing. That wrapper is not termination proof. Without a stronger final handle, Atlas keeps the old plan owned until the originating host terminates, rather than allowing a concurrent session to take over.

## Settings

The installed package name used by `omp plugin config` is
`wows-omp-plugin-omo-prometheus`:

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| Setting | Values | Default | Effect |
| ------- | ------ | ------- | ------ |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | Controls pre-proposal plan review. |

- `ask` retains the existing behavior: routine Momus review on every plan; high-accuracy Momus+Oracle review for an explicit request or nontrivial unclear work; a one-time choice for clear work.
- `standard` runs routine Momus review without offering high accuracy, but an explicit request still upgrades to the Momus+Oracle pair.
- `high-accuracy` always runs the Momus+Oracle pair without offering a choice.
- `off` skips Momus and Oracle plan review entirely, even on an explicit high-accuracy request. Metis still checks planning gaps, and Atlas still runs the Momus compliance gate F1 after approval.

OMP merges user settings with project overrides. The plugin reads the effective setting for each session's cwd at session startup; restart the session after changing it.

## Plan grammar

Every Prometheus plan ends its body with two machine-readable sections. Tasks are column-0 checkbox rows numbered from `T1`, each with indented `Agent:`, `Depends on:`, and `Acceptance:` lines:

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

During planning, Prometheus reads the current `task` tool's available-agent list after spawn-policy and disabled-agent filtering, injects the names into the planning context, and binds that list into Momus reviews. Choose the most specific **listed** specialist for each `Agent:` row: installed omo-toolkit agents are preferred to generic `task`/`sonic`, and a user-defined agent is valid only when listed. An unlisted name is valid only if it has a known fallback. If the tool description cannot be parsed, planning still works with known names; user-defined names cannot be validated.

The resolver tries the requested name first, then these fallbacks in order (only agents actually in the live list may be selected):

|Requested agent|Fallback chain|
|---|---|
|`deep-low`, `deep-high`, `ultrabrain`, `architect`, `visual-engineering`, `artistry`, `writing`|`task`|
|`librarian`|`scout` → `task`|
|`metis`, `momus`, `oracle`|`reviewer` → `task`|
|`sonic`, `scout`, `reviewer`, `security-reviewer`|`task`|
|`task`|none|

This table substitutes agents, not models. Each agent's own model-role chain (for example `writing` trying `@writer` before `@task`) is defined by the agent and documented in the [omo-toolkit README](../omo-toolkit/README.md#agents).

If none in a chain are spawnable, the ledger shows `unavailable` and Atlas reports a blocker rather than dispatching an illegal agent. If the list cannot be parsed, the resolver leaves known requested names unchanged instead of guessing which specialists are installed.

## Execution ledger

Native approval creates a plan bundle below `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/`. This is normally under `~/.omp/agent/sessions/<working-dir>/atlas/`, not inside the repository or a session's `local://` directory. The host API determines the root, including custom session directories.

```text
plan.md          exact approved plan
approval.json    source approval, workspace, and plan identity
ledger.json      task and gate progress
checkpoint.json independent attempt and receipt bindings
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

The version-2 ledger retains each T/F row's acceptance criteria, dependencies, status, requested and resolved agents, attempt, evidence receipt, and exact plan SHA-256. The complete dependency graph is validated first; cyclic plans cannot partially execute. Checked plan boxes do not count as receipts. Use `atlas_ledger`:

- `status` prints rows, acceptance criteria, dependencies, evidence and dispatchable tasks/gates.
- `start` must run **before** spawning. It returns a fresh attempt and a standalone `atlas_assignment: {"planSha256":"…","rows":{"T1":"…"}}` line to put in native `task.task` or unambiguous batch `context`. No new native tool argument is introduced. One implementation child can cover several independent started T rows only when the dispatch binds all their attempts; each F row requires its own child.
- `done` requires `childAgentId` and inspected `evidence`. The extension correlates the native task call and completion lifecycle with the real direct-child identity, owned output, and final native task result or owner-scoped background-job success. The early child-completed event alone is insufficient: isolated-work capture or commit can still fail afterward. Foreign, running, failed, nonexistent, stale or unbound children cannot complete work. A filename or caller-written `agent://` string is not proof.
- `block` requires a reason; `reopen` clears an old attempt. Both invalidate transitive descendants and dependent gates, including running attempts whose inputs became stale. Start blocked work only after reopening it.

`atlas_release` requires every row's valid receipt and explicit user confirmation. Missing, corrupt, unavailable or mismatched ledgers pause dispatch and completion instead of downgrading to prompt-only execution. Missing artifacts are not silently rebuilt. Restore the exact approved artifacts, or use `/atlas` to exit and obtain new native approval for a changed plan. An invalid ledger does not cause endless auto-continuation.

**Auto-continuation.** When Atlas stops while ledger rows are unfinished, the plugin asks OMP to continue with a hidden `<atlas-continuation>` message containing the ledger summary. OMP caps chained continuations at eight per user turn. Two consecutive continuations without ledger progress stop the loop and notify you: run `/atlas` to exit, or send new instructions. Any user message resets the stall count.

**Resume and persistence.** Session entries hold the shared plan pointer; the shared checkpoint and evidence are authoritative. Completed rows retain their original session, child, attempt, and receipt identity. Copied native outputs are rechecked against their digests, so verified progress survives deletion of the source session artifacts. `status` exposes the durable output paths for later review. Required findings and observed results belong in native output, not solely in links to session-local reports; arbitrary linked files are not copied.

Missing or changed proof reopens the affected rows and their dependents. Interrupted attempts reopen for fresh work only after ownership can be acquired. Old session branches cannot roll shared progress back. On resume Atlas validates the shared approval, workspace, and ownership before restoring the host reference; an unrelated explicit host reference still pauses recovery. Atomic writes and independent checkpoints prevent a stale ledger from reviving invalidated completion.

**Older plans.** Session-local execution ledgers are not migrated. Their artifacts remain untouched, but resuming one pauses with reapproval guidance. Exit with `/atlas`, obtain fresh native approval, and revalidate execution against a new shared plan. The old `prometheus_ledger` and `prometheus_release` tools are replaced by `atlas_ledger` and `atlas_release`, without aliases.

## Final gates

After every T row is done, Atlas dispatches F1–F3 to distinct fresh verification children. F4 is dispatched only after all three have passed and consumes their actual reports. None may be an implementation child or a previously consumed verifier. Each uses its resolved `dispatchAgent` (requested names and usual first fallback below):

|Gate|Agent|Fallback|Checks|
|---|---|---|---|
|F1. Plan compliance review|`momus` (`review_kind: compliance`)|`reviewer`|executed changes match the approved plan, using the ledger summary and `git diff --stat`|
|F2. Code quality review|`deep-high`|`task`|maintainability, scope, test value, and evidence-backed blockers|
|F3. Real-surface QA|`deep-low`|`task`|every scenario in the plan's Verification section run on the real surface with command and observed result|
|F4. Success-criteria fidelity|`deep-high`|`task`|independent synthesis of completed F1–F3 reports and criterion-tied evidence|

Each gate's `start` result supplies its exact native `outputSchema`; dispatch with that schema and `schemaMode: "strict"`. The actual child output must be a JSON object containing `gateId`, `planSha256`, `attempt`, `verdict` (`PASS`, `FAIL`, `INCONCLUSIVE`), a nonempty `summary`, a nonempty `evidence` array, and `reviewedGates`. F1–F3 use an empty `reviewedGates` object; F4 must echo the supplied F1–F3 output digests after inspecting those reports. Only a matching structured `PASS` authorizes completion; prose containing a passing word is never parsed as a verdict. Native per-spawn schemas override agent-native prose formats, including Momus's planning-only `[OKAY]` format.

A rejected gate reopens the affected T rows, their transitive dependents, and all final gates. Cancel stale running work and re-run fresh attempts in dependency order. Reopening only F1, F2 or F3 leaves the other independent reviews intact but always invalidates F4. Shared attempt checkpoints prevent old receipts from becoming current again after a ledger rollback.

## Models

Metis, Oracle, and Momus run as child agents on OMP's `@slow` role alias. The alias resolves through the user's OMP model configuration; the plugin does not hard-code a provider or model name.

Atlas is not a child agent: it is the main session after approval. The plugin registers an `atlas` model role, listed in `/model` as **Atlas**, so it can be assigned like any other role; it is not added to the Ctrl+P quick-switch cycle. While a Prometheus proposal awaits native approval, `atlas` is temporarily placed first in `cycleOrder`, so the approval slider offers it next to `smol`, `default`, and `slow`. The slider still starts on `default`; move it to `atlas` to execute with that role. The runtime `cycleOrder` override is removed at the next input or agent turn, or when planning ends, restoring the configured value. Roles without an available model do not appear on the slider.

`/atlas <plan>` switches the session to the `atlas` role when it is assigned and leaves the current model unchanged when it is not. If the assigned model cannot be resolved, Atlas still enters and reports that the current model was kept.

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

## Native state and compatibility

OMP remains the authority for native `xd://propose` approval and autosave. Planning drafts and the proposal handoff marker use `local://`; approved execution uses the shared Atlas bundle. The plugin neither creates project-local `.omo` state nor replaces native child execution with another worker engine. The minimum supported host is OMP 18.3.1.

Shared execution requires file-backed sessions and a local filesystem supporting hard links, atomic rename, and file/directory synchronization. In-memory, remote-only, or unsupported storage fails closed. Sessions using different session directories do not discover each other's plans, and moving a host session does not automatically move its sibling `atlas/` directory.

The embedded Prometheus, Metis, Oracle, Momus, and Atlas prompt assets are modified derivatives of OmO. `NOTICE` records the upstream repository, pinned source revision, earlier fork provenance, and modification notice.

The extension code and original packaging are licensed under MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/`, and `skills/prometheus/` remain under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), including its internal-business/personal/non-commercial use terms and free non-commercial distribution limitation.
