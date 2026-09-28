# omo-prometheus

This plugin ports the Prometheus planning workflow and Atlas execution model from [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) to OMP. It is a modified OMP-native adaptation, not an independent reimplementation presented under a new name.

It keeps OMP's native Plan Mode and approval flow, then adds the workflow that makes large plans useful:

- Metis performs pre-planning intent and GAP analysis.
- Prometheus asks only the questions that can change the plan, with an iterative clarification loop.
- Momus reviews the drafted plan for blocking reference, executability, QA, and task-grammar gaps.
- Oracle is available for architecture and high-risk decisions.
- Atlas takes over after approval, delegates every plan task to child agents, tracks progress in a durable execution ledger, and runs four final verification gates before it may release.

The two entry points share one workflow: `/prometheus` is the explicit entry, and native `/plan` can ask whether a large or ambiguous request should switch to the same Prometheus workflow.

## Install

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install omo-prometheus@wows-omp-plugins
```

Restart OMP after installation so the extension and agents are loaded.

## Migrating from `prometheus`

Uninstall the retired package with `omp plugin uninstall prometheus@wows-omp-plugins`, then install `omo-prometheus@wows-omp-plugins`. Session state from the old plugin is not carried over; start a new Prometheus plan after migrating.

## Usage

Toggle the enhanced workflow on or off, like native `/plan`:

```text
/prometheus
```

Turning it on enters OMP's native Plan Mode (or upgrades an already active Plan Mode session); describe the request in your next message, or pass it inline as `/prometheus <request>`. Running `/prometheus` again while planning leaves both Prometheus and Plan Mode. The plan is written to the session's `local://` artifact and submitted through `xd://propose`; if OMP plan autosave is enabled, the approved copy is saved under `.omp/plans/`.

For ordinary native Plan Mode:

```text
/plan
```

The plugin leaves small, well-defined requests on the normal OMP path. For large, cross-cutting, or ambiguous goals, the planner uses `ask` to offer the Prometheus workflow: one question with header `Prometheus` whose second choice names Prometheus. Only that exact question counts as consent. If accepted, it activates the same shared workflow instead of switching to a second planner implementation.

After approval, the main session becomes Atlas. The execution prompt explicitly overrides OMP's delegation preference for this approved Prometheus plan, and the extension also blocks direct implementation tools in the parent session. Use `task` to assign work to child agents. Running `/prometheus` during execution toggles Atlas off and is the emergency escape hatch for the current session.

Both approval choices hand off to Atlas. "Approve and execute" starts a fresh session: when the plan is proposed, the plugin writes a marker to `local://prometheus/<slug>.proposal.json`, which OMP copies into the new session together with the plan, so the handoff survives the session switch without any in-process state. A plan approved in ordinary Plan Mode has no marker and is left alone.

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

`Agent:` is `task`, `sonic` for cheap mechanical work, or one of `metis`, `momus`, `oracle`, the omo-toolkit category agents (`deep-low`, `deep-high`, `ultrabrain`, `architect`, `visual-engineering`, `artistry`, `writing`), or `librarian`, `code-reviewer`, `qa-executor`, `gate-reviewer`. Momus rejects a plan whose sections are missing or whose rows break this grammar.

## Execution ledger

When execution starts, the plugin parses the approved plan into `local://prometheus/<slug>-ledger.json` in the session's artifact directory: one row per `T` task and `F` gate with status (`open`, `in_progress`, `done`, `blocked`), owner agent, dependencies, evidence, and the plan's SHA-256. Atlas reads and updates it with the `prometheus_ledger` tool, which is active only during execution:

- `status` prints the ledger table and the next dispatchable tasks.
- `start`, `block`, and `reopen` change one row's status.
- `done` requires non-empty evidence and finished dependencies. A final gate additionally requires every `T` row to be done and evidence that cites the verification child's `agent://<id>` output.

`prometheus_release` is refused while any row is unfinished. If the plan lacks the grammar, or the session has no artifact directory (a non-persisted session), the plugin notifies you and Atlas runs without a ledger for that plan.

**Auto-continuation.** When Atlas stops while ledger rows are unfinished, the plugin asks OMP to continue the session with a hidden `<prometheus-continuation>` message that carries the ledger summary. OMP caps chained continuations at eight per user turn. If two continuations in a row make no ledger progress, the plugin stops continuing and notifies you: run `/prometheus` to release, or send new instructions. Any message you send resets the stall count.

**Resume.** Workflow state, including the ledger path, is stored in session entries. Resuming or switching back to an executing session restores Atlas and injects the current ledger summary. If the ledger file has gone missing, the plugin notifies you and rebuilds it from the approved plan on the next turn.

## Final gates

After every `T` row is done, Atlas dispatches the four gates to separate verification children. Each gate names its agent, with a fallback for when the agent is not installed:

|Gate|Agent|Fallback|Checks|
|---|---|---|---|
|F1. Plan compliance review|`momus` (`review_kind: compliance`)|`reviewer`|executed changes match the approved plan, using the ledger summary and `git diff --stat`|
|F2. Code quality review|`code-reviewer` (omo-toolkit)|`reviewer`|quality of the changed code|
|F3. Real-surface QA|`qa-executor` (omo-toolkit)|`task`|the plan's Verification section run on the real surface|
|F4. Success-criteria fidelity|`gate-reviewer` (omo-toolkit)|`reviewer`|every plan outcome against the collected evidence|

A rejected gate reopens the `T` rows it names; Atlas re-runs those rows and then only the failed gate.

## Models

Metis, Oracle, and Momus run as child agents on OMP's `@slow` role alias. The alias resolves through the user's OMP model configuration; the plugin does not hard-code a provider or model name. Atlas is not a child agent: it is the main session after approval, so it keeps whatever model that session already uses.

## Native state and compatibility

This plugin intentionally uses OMP-native `local://` plan artifacts and `xd://propose` approval. It does not create or depend on OMO's `.omo/plans/` or `boulder.json` state: OMP remains the source of truth for plan approval and autosave, and the plugin's proposal marker and execution ledger live beside the plan in the session's `local://` artifacts.

The embedded Prometheus, Metis, Oracle, Momus, and Atlas prompt assets are modified derivatives of OmO. `NOTICE` records the upstream repository, pinned source revision, earlier fork provenance, and modification notice.

The extension code and original packaging are licensed under MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/`, and `skills/prometheus/` remain under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), including its internal-business/personal/non-commercial use terms and free non-commercial distribution limitation.
