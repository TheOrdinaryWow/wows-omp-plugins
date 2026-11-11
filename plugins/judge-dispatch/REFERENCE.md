# judge-dispatch reference

English | [简体中文](REFERENCE.zh.md)

## Agent discovery

Candidates come from the agent list in the live `task` tool description. If that list is missing, unreadable or empty, the plugin does not judge. The `task` tool revalidates any agent name the plugin writes. Read-only status comes from OMP's agent tool metadata.

The judge rates difficulty, even when only one agent type is eligible, as long as the rating can change something: `judgeEffort` is on and the item sets no `effort`, or `modelTiers` has an entry for the final agent. When only some candidates have tiers, the plugin first chooses the agent and asks for difficulty only if that agent has a tier.

## Model tiers

`modelTiers` is a comma-separated list of `[<agent>.]<routine|demanding>=<selector>` entries. A malformed or repeated entry, or a `standard` entry, invalidates the whole setting, and the plugin then keeps every call as requested. For the agent a task finally runs as, the plugin looks up `<agent>.<difficulty>` first and `<difficulty>` second.

A tier expands like this:

- `@<role>`: the expanded `modelRoles[role]` selectors, followed by `retry.fallbackChains[role]`, or by the `default` chain if the role has no entry.
- `provider/model[:level]`: that selector, followed by the `default` chain.

At `tool_call` the plugin checks the tier against scoped OMP settings and enabled models: the role must exist, the chain must be a list of selectors without provider wildcards, and some enabled model must resolve. A tier that fails a check keeps the agent's model and names the reason in the status line. A tier changes nothing only when its first resolving model is the one the agent's own selectors resolve to and it runs at the same thinking level (a selector's explicit `:level`, else the agent's `thinkingLevel`); then a thinking step may still apply. A tier that names the agent's own model at another level applies that level, and no step follows. A tier that resolves to a single selector with no chain of its own is not refused; OMP retries it on the agent's own role chain, which falls back towards the agent's model.

## Thinking steps

OMP picks a child's thinking level in this order: the task's `effort`, then an explicit `:level` suffix on the selector the model resolved from, then the agent definition's `thinkingLevel`. `effort` (`lo`, `med`, `hi`) maps onto the lowest, middle or highest level the model supports, so writing it would flatten a curated level such as an agent's `xhigh`. The plugin never writes `effort`.

With `judgeEffort` on and no `effort` on the item, the plugin computes the step as follows:

1. The baseline is the level OMP would use without `effort`: the `:level` of the first selector that resolves to an enabled model, or else the agent's `thinkingLevel`. No baseline, `auto`, `inherit` and `off` mean no step.
2. The baseline is clamped to the model's supported levels, as OMP does when it applies a level.
3. A routine rating moves one supported level down, a demanding rating one supported level up. There is no step below the lowest supported level or above the highest, so a step never reaches `off`.
4. The result is clamped to `task.maxEffort`. OMP applies that ceiling only to an `effort`, so the plugin applies it itself. A step up that the ceiling would cancel is dropped.

The ordering and the supported levels come from OMP's own thinking helpers and the model registry. At spawn, the plugin adds or replaces the resolving selector's `:level` suffix and leaves the selector itself and the other patterns as they were. OMP treats that suffix as explicit, so it wins over the agent's `thinkingLevel`. When a tier swaps the model, no step applies.

## Retry and escalation records

The plugin tells the parent agent to retry or escalate a task by dispatching it again with the same `name`. It keeps one record per session for each task name exactly as the caller wrote it, so `Lane-1` and `Lane-2` stay separate. A child is matched to its name through its item position in the routed call, never by trimming the `-N` suffix OMP adds to a child id on a name collision:

- Escalation: the first non-empty line of a child's final output is exactly `ESCALATE: deep-high`. The next dispatch counts as `demanding`.
- Failure: a child ends aborted, with a nonzero exit, or with an error after its spawn applied a routine tier or a step down. The next dispatch counts one difficulty above the applied one.

Outcomes are read without a `tool_result` hook. A synchronous child's result arrives in the `task` call's `tool_execution_end` details. For a background child, that event binds the parent session's async job by child id and dispatch time; when the job settles, its status decides failure, and the child output is read from the `<output>` or `<preview>` block of the `<task-result>` text the job delivers. Only calls the plugin routed count, so nothing is recorded while an approved Prometheus plan executes. Workflow-owned agents and the contract-owned `seance` lane are never recorded.

The next routed task item with that name uses the record. It keeps the requested agent, skips the judge, and acts on the recorded difficulty through tiers and thinking steps as usual. The record is removed only when that raised route is returned; an item that keeps its route (a workflow-owned or unlisted agent) or a call whose routing times out or fails open leaves it for the next dispatch. Each kind of record is capped at 256 entries, oldest first out.

## From decision to spawn

OMP's `before_subagent_spawn` event carries no assignment, so the plugin links a tier or thinking step to the spawn through the task item's `name`. When the parent gave no name, the plugin writes one (`<agent>-<8 hex>`). If two pending calls share a name, the spawn keeps its configured model. At spawn, the first selector that resolves must still be the model the decision was made for, and a thinking step is recomputed and applies only if it lands on the same level; otherwise the spawn keeps its configuration. Any failure at that point keeps the configured model. OMP shows the routing note next to the child's resolved model.

A rewrite changes `agent` only when `routeAgent` is on, and `name` only when a tier or a thinking step needs one.

## Native per-item models and file-backed tasks

With OMP's `task.perCallModel` setting on, a task item can carry its own `model`. The plugin leaves such an item's agent, selector and effort exactly as written: no agent judgment, no difficulty question, tier, thinking step or retry raise, and a same-named pending spawn decision from another dispatch cannot apply to it.

With `task.file` on, an item may give its assignment as `taskFile` instead of `task`. Each item must have exactly one of the two. A file-backed item keeps its agent (the plugin never reads the file, so there is nothing to judge) and its `taskFile` is passed through untouched; inline siblings in the same batch are routed normally.

Routing judgments resolve the current local session and pass its cost gate to `resolveJudge`, so they count toward `session.maxCost` and are refused once the cap is reached; usage is still journaled. Without a local session the plugin judges as before.

## Timeouts and failure

Routing gives up after eight seconds and always finishes at least one second before the session's tool-call handler timeout. If no time is left, it skips routing. Requests, credentials and usage journaling go through OMP's `judge` role; the plugin stores no keys and does not touch the process environment.

## Without the terminal UI

Routing, thinking steps and tiers work the same in RPC, ACP editors, the SDK and headless runs. RPC clients receive the working message and status line as notification frames; ACP editors may only log them. Without a UI the indicators are skipped. The plugin has no dialogs or commands.

Children started through `eval.agent()` or `workpool()` are not routed, because OMP's `before_subagent_spawn` hook can change a child's model but not its agent type.

## State

The plugin saves no routing state in the session and publishes no plugin-state snapshot. Pending tiers and thinking steps, and retry and escalation records, live only in the current process; they are lost on restart. Stored settings the manifest no longer declares are ignored, with a warning once per session that points to `modelTiers`. Older transcript records are still rendered and filtered.
