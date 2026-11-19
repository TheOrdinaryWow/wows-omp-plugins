# judge-dispatch reference

English | [简体中文](REFERENCE.zh.md)

## Agent discovery

Candidates come from the agent list in the live `task` tool description. If that list is missing, unreadable or empty, the plugin skips judgment. The `task` tool revalidates any agent name the plugin writes. OMP's classification of the requested agent's own tools determines whether the request is read-only. A read-only request can only switch to an agent with read-only tools and no `spawns` grant. Any grant rules out a replacement, even if it cannot be used in the current session. The requested agent remains an option, so one eligible replacement is enough for the judge to make a choice.

The plugin uses the `agent` value OMP delivers to `tool_call` after validation, including when OMP fills in the default. A rewrite can carry that value forward. If the validated item still has no `agent`, the plugin looks for the default in the live tool description and leaves the call as received if it cannot identify one. The resolved default follows the same authority rule and supplies the starting configuration for tiers and thinking steps.

Model agents you tag in a session, such as `m1`, are reserved for explicit use. The plugin skips judgments, tiers, thinking steps and retry records for these agents and excludes them from automatic routing. If an installed agent has the same name, OMP resolves that agent first and the ordinary routing rules apply.

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

The parent agent retries a task by dispatching it again with the same `name`, including a name the plugin generated. The plugin records names as dispatched, so `Lane-1` and `Lane-2` stay separate. Two outcomes can raise the next dispatch.

- Escalation: the first non-empty line of a child's final output is exactly `ESCALATE: deep-high`. The next dispatch counts as `demanding`.
- A child ends aborted, with a nonzero exit, or with an error after it ran with a routine tier or a step down. The next dispatch counts as `standard`.

The `task` call's `tool_execution_end` details identify synchronous results by item position. If the call ends in error, a synchronous item with no result row counts as failed if its spawn received a routine tier or a thinking step down. Sibling result rows describe their own items. For a background child, the plugin binds the parent session's job by child ID and dispatch time on the first `tool_execution_update` that identifies it, or at the end of the call if the first identifying frame is the result. At settlement it reads the job's terminal status and the `<output>` or `<preview>` block in its `<task-result>` text. Retry records cover tasks eligible for routing.

The next eligible dispatch under that name keeps the requested agent, skips the judge and uses the recorded difficulty for tiers and thinking steps. Returning that raised route consumes the record. Calls that bypass routing, time out or fail open leave the record available for a later dispatch. Up to 256 retry records are kept, oldest first out.

## From decision to spawn

OMP's `before_subagent_spawn` event supplies a spawn key without a tool call ID or item index. The plugin looks for exactly one pending item, using its allocated child ID when known or its task name and possible allocation suffix. Both `Lane` and `Lane-2` can match the key `Lane-2`. The plugin discards the affected items' tiers and thinking changes when more than one item matches and records no lowering for those spawns. An item with neither a name nor an allocated ID counts as a possible match for any key.

For an unnamed task that needs a tier or thinking step, the plugin writes `<agent>-<8 hex>`. The expected agent and starting model must still match at spawn, and a recalculated thinking step must still land on the same level. OMP shows the routing note next to the child's resolved model when the change applies.

A rewrite changes `agent` only when `routeAgent` is on, and `name` only when a tier or a thinking step needs one.

### Known limitations

- Concurrent calls with the same name can lose their spawn adjustments. A call whose judge times out still counts as a possible match until the plugin can attribute a spawn to it or the host reports completion.
- A direct SDK call stopped by another extension or rejected before execution may never emit `tool_execution_end`. Its pending name can suppress a later same-name adjustment. Direct calls that omit the end event can also miss a synchronous retry raise.
- The plugin keeps at most 256 dispatch records per session and drops the oldest on overflow. If a discarded record still had a pending spawn, the plugin skips all further spawn adjustments in the session because that spawn may still arrive. Dropping a record can also lose the outcome needed to raise a retry.
- An SDK session with a private agent registry and its own extension roots can resolve an agent name to a different definition than judge-dispatch sees. The plugin's read-only check can therefore disagree with the permissions of the agent OMP actually spawns.
- If an agent definition changes while a judgment is in flight, OMP uses the updated definition when it spawns the agent.
- Another extension can rename a task after judge-dispatch runs. If the new name matches a pending route for the same agent and starting model, the renamed task can receive that route's tier.
- An SDK caller that reuses a tool call ID while its previous call is still live can overwrite the dispatch record and confuse the correlation of later events.
- Two overlapping retries under the same name can both use one escalation if they read the record before either consumes it.
- Background failures in SDK sessions with a private agent registry are not remembered for retry. The plugin looks up the parent session in the global registry to find its background jobs.

When a spawn adjustment is skipped, the task uses OMP's model and thinking settings for the selected agent. The same agent-authority rules govern that selection.

A host-provided tool call ID on `before_subagent_spawn` would remove the need to match by name across calls. An item index would identify individual tasks within a batch.

## Native per-item models and staged tasks

With OMP's `task.perCallModel` setting on, a task item can carry its own `model`. The plugin leaves such an item's agent, selector and effort exactly as written: no agent judgment, no difficulty question, tier, thinking step or retry raise, and a same-named pending spawn decision from another dispatch cannot apply to it.

A `model` that is blank or an empty list counts as no model, as it does for OMP, so that item is routed normally.

With `task.steps` on, an item may give its assignment as `steps`, an ordered list of stages, instead of `task`. Each item must have exactly one of the two. The judge reads the stages together as one numbered list, and the `steps` array is passed through untouched.

Routing judgments resolve the current local session and pass its cost gate to `resolveJudge`, so they count toward `session.maxCost` and are refused once the cap is reached; usage is still journaled. Without a local session the plugin judges as before.

## Timeouts and failure

Routing gives up after eight seconds and always finishes at least one second before the session's tool-call handler timeout. If no time is left, it skips routing. Requests, credentials and usage journaling go through OMP's `judge` role; the plugin stores no keys and does not touch the process environment.

## Without the terminal UI

Routing, thinking steps and tiers work the same in RPC, ACP editors, the SDK and headless runs. RPC clients receive the working message and status line as notification frames; ACP editors may only log them. Without a UI the indicators are skipped. The plugin has no dialogs or commands.

Children started through `eval.agent()` or `workpool()` are not routed, because OMP's `before_subagent_spawn` hook can change a child's model but not its agent type.

## State

The plugin saves no routing state in the session and publishes no plugin-state snapshot. Pending tiers and thinking steps, and retry and escalation records, live only in the current process; they are lost on restart. Stored settings the manifest no longer declares are ignored, with a warning once per session that points to `modelTiers`. Older transcript records are still rendered and filtered.
