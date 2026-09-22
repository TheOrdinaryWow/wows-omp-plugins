# Prometheus

This plugin ports the Prometheus planning workflow and Atlas execution model from [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) to OMP. It is a modified OMP-native adaptation, not an independent reimplementation presented under a new name.

It keeps OMP's native Plan Mode and approval flow, then adds the workflow that makes large plans useful:

- Metis performs pre-planning intent and GAP analysis.
- Prometheus asks only the questions that can change the plan, with an iterative clarification loop.
- Momus reviews the drafted plan for blocking reference, executability, and QA gaps.
- Oracle is available for architecture and high-risk decisions.
- Atlas takes over after approval and delegates every plan task, including tests, QA, and final verification, to child agents.

The two entry points share one workflow: `/prometheus` is the explicit entry, and native `/plan` can ask whether a large or ambiguous request should switch to the same Prometheus workflow.

## Install

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install prometheus@wows-omp-plugins
```

Restart OMP after installation so the extension and agents are loaded.

## Usage

Explicitly start the enhanced workflow:

```text
/prometheus Add the requested feature
```

The command enters OMP's native Plan Mode. The plan is written to the session's `local://` artifact and submitted through `xd://propose`; if OMP plan autosave is enabled, the approved copy is saved under `.omp/plans/`.

For ordinary native Plan Mode:

```text
/plan
```

The plugin leaves small, well-defined requests on the normal OMP path. For large, cross-cutting, or ambiguous goals, the planner uses `ask` to offer the Prometheus workflow. If accepted, it activates the same shared workflow instead of switching to a second planner implementation.

After approval, the main session becomes Atlas. The execution prompt explicitly overrides OMP's delegation preference for this approved Prometheus plan, and the extension also blocks direct implementation tools in the parent session. Use `task` to assign work to child agents. `/prometheus off` is the emergency escape hatch for the current session.

## Models

Metis, Oracle, Momus, and Atlas use OMP's `@slow` role alias. The alias resolves through the user's OMP model configuration; the plugin does not hard-code a provider or model name.

## Native state and compatibility

This plugin intentionally uses OMP-native `local://` plan artifacts and `xd://propose` approval. It does not create or depend on OMO's `.omo/plans/` state, so OMP remains the single source of truth for plan approval, autosave, and execution handoff.

The embedded Prometheus, Metis, Oracle, Momus, and Atlas prompt assets are modified derivatives of OmO. `NOTICE` records the upstream repository, pinned source revision, earlier fork provenance, and modification notice.

The extension code and original packaging are licensed under MIT (`LICENSE-MIT`). The derived prompt assets under `agents/` and `skills/prometheus/` remain under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), including its internal-business/personal/non-commercial use terms and free non-commercial distribution limitation.
