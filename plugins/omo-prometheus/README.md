# omo-prometheus

This plugin ports the Prometheus planning workflow and Atlas execution model from [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) to OMP. It is a modified OMP-native adaptation, not an independent reimplementation presented under a new name.

It keeps OMP's native Plan Mode and approval flow, then adds the workflow that makes large plans useful:

- Metis performs pre-planning intent and GAP analysis.
- Prometheus asks only the questions that can change the plan, with an iterative clarification loop.
- Configurable Momus and Oracle plan review checks blocking reference, executability, QA, and task-grammar gaps when enabled.
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

If none in a chain are spawnable, the ledger shows `unavailable` and Atlas reports a blocker rather than dispatching an illegal agent. If the list cannot be parsed, the resolver leaves known requested names unchanged instead of guessing which specialists are installed.

## Execution ledger

Execution creates `local://prometheus/<slug>-ledger.json` with a version-2 ledger: every T/F row retains its acceptance criteria, dependencies, status, requested and resolved agents, current attempt, evidence receipt, and the exact approved plan SHA-256. The complete dependency graph is validated first; cyclic plans cannot partially execute. Checked plan boxes do not count as receipts.

- `status` prints rows, acceptance criteria, dependencies, evidence and dispatchable tasks/gates.
- `start` must run **before** spawning. It returns a fresh attempt and a standalone `prometheus_assignment: {"planSha256":"…","rows":{"T1":"…"}}` line to put in native `task.task` or unambiguous batch `context`. No new native tool argument is introduced. One implementation child can cover several independent started T rows only when the dispatch binds all their attempts; each F row requires its own child.
- `done` requires `childAgentId` and inspected `evidence`. The extension correlates the native task call and completion lifecycle with the real direct-child identity, owned output, and final native task result or owner-scoped background-job success. The early child-completed event alone is insufficient: isolated-work capture or commit can still fail afterward. Foreign, running, failed, nonexistent, stale or unbound children cannot complete work. A filename or caller-written `agent://` string is not proof.
- `block` requires a reason; `reopen` clears an old attempt. Both invalidate transitive descendants and dependent gates, including running attempts whose inputs became stale. Start blocked work only after reopening it.

`prometheus_release` requires every row's valid receipt and then explicit user confirmation. Missing, corrupt, unavailable or mismatched ledgers pause dispatch and completion instead of downgrading to prompt-only execution. Missing artifacts are not silently rebuilt. Restore the exact approved artifacts, or use `/prometheus` to exit and obtain new native approval for a changed plan. An invalid ledger does not cause endless auto-continuation.

**Auto-continuation.** When Atlas stops while ledger rows are unfinished, the plugin asks OMP to continue the session with a hidden `<prometheus-continuation>` message that carries the ledger summary. OMP caps chained continuations at eight per user turn. If two continuations in a row make no ledger progress, the plugin stops continuing and notifies you: run `/prometheus` to release, or send new instructions. Any message you send resets the stall count.

**Resume and persistence.** Workflow state stores the proposal-time plan hash and ledger path. Native completion receipts and the latest attempt checkpoints are independently recorded in session entries; artifact digests are rechecked on use. Verified completed rows survive restart without a populated live registry, but an empty registry cannot authorize a new completion. Missing historical proof, changed output, or unrecorded in-flight attempts reopen for fresh verification. Version-1 ledgers with the same approved bytes migrate with all rows open, never grandfathering status-only completion. Resume still re-resolves unfinished agents against the current roster. Read/validate/update operations serialize per ledger inside the host process and replace JSON files atomically; this is not a multi-process workflow engine, and concurrent independent hosts editing one session are unsupported.

## Final gates

After every T row is done, Atlas dispatches F1–F3 to distinct fresh verification children. F4 is dispatched only after all three have passed and consumes their actual reports. None may be an implementation child or a previously consumed verifier. Each uses its resolved `dispatchAgent` (requested names and usual first fallback below):

|Gate|Agent|Fallback|Checks|
|---|---|---|---|
|F1. Plan compliance review|`momus` (`review_kind: compliance`)|`reviewer`|executed changes match the approved plan, using the ledger summary and `git diff --stat`|
|F2. Code quality review|`deep-high`|`task`|maintainability, scope, test value, and evidence-backed blockers|
|F3. Real-surface QA|`deep-low`|`task`|every scenario in the plan's Verification section run on the real surface with command and observed result|
|F4. Success-criteria fidelity|`deep-high`|`task`|independent synthesis of completed F1–F3 reports and criterion-tied evidence|

Each gate's `start` result supplies its exact native `outputSchema`; dispatch with that schema and `schemaMode: "strict"`. The actual child output must be a JSON object containing `gateId`, `planSha256`, `attempt`, `verdict` (`PASS`, `FAIL`, `INCONCLUSIVE`), a nonempty `summary`, a nonempty `evidence` array, and `reviewedGates`. F1–F3 use an empty `reviewedGates` object; F4 must echo the supplied F1–F3 output digests after inspecting those reports. Only a matching structured `PASS` authorizes completion; prose containing a passing word is never parsed as a verdict. Native per-spawn schemas override agent-native prose formats, including Momus's planning-only `[OKAY]` format.

A rejected gate reopens the affected T rows, their transitive dependents, and all final gates. Cancel stale running work and re-run fresh attempts in dependency order. Reopening only F1, F2 or F3 leaves the other independent reviews intact but always invalidates F4. Session attempt checkpoints prevent old receipts from becoming current again after a ledger rollback.

## Models

Metis, Oracle, and Momus run as child agents on OMP's `@slow` role alias. The alias resolves through the user's OMP model configuration; the plugin does not hard-code a provider or model name. Atlas is not a child agent: it is the main session after approval, so it keeps whatever model that session already uses.

## Native state and compatibility

This plugin intentionally uses OMP-native `local://` plan artifacts and `xd://propose` approval. It does not create or depend on OMO's `.omo/plans/` or `boulder.json` state: OMP remains the source of truth for plan approval and autosave, and the plugin's proposal marker and execution ledger live beside the plan in the session's `local://` artifacts.

The embedded Prometheus, Metis, Oracle, Momus, and Atlas prompt assets are modified derivatives of OmO. `NOTICE` records the upstream repository, pinned source revision, earlier fork provenance, and modification notice.

The extension code and original packaging are licensed under MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/`, and `skills/prometheus/` remain under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), including its internal-business/personal/non-commercial use terms and free non-commercial distribution limitation.
