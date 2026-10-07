# judge-dispatch

English | [简体中文](README.zh.md)

The plugin gives OMP's `judge` model role a say in how `task` calls spawn subagents. With `routeAgent` on (the default), it can replace the agent type the parent requested. With `selectModel` on, it picks each child's model from every model configured for that agent. With `judgeEffort` on, it sets the thinking effort. OMP still validates every spawn.

## Install

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

Requires OMP 18.3.5 or newer. Restart the session after installing so the extension can register. It uses OMP's built-in judgment support and has no credentials of its own (see [Enabling the judge role](#enabling-the-judge-role)).

## What gets routed

With `routeAgent` on, the plugin rewrites the `agent` field of ordinary `task` calls, single or batch. Subagents started through `eval.agent()` or `workpool()` are not routed, because OMP's `before_subagent_spawn` hook can change a child's model but not its agent type. With `routeAgent` off, the requested agent always stays, and the judge is asked only about effort and model.

Candidates come from the agent list in the live `task` tool description, which OMP has already filtered by spawn policy and disabled agents. If that list is missing, unreadable, or empty, the plugin does not judge. The `task` tool revalidates any name the plugin writes.

These calls are left exactly as they are, effort and model included:

- requests for `audit-*`, `metis`, `momus`, or `oracle`; ordinary requests are never routed into these workflow roles either;
- requests for an agent the plugin cannot find in the list, since its access level is unknown;
- every `task` call while an `omo-prometheus` plan is executing, because the approved plan owns agent and effort choices. Routing resumes once that workflow returns to idle or planning.

A read-only agent is only ever replaced by another read-only agent, based on OMP's agent tool metadata.

## Host modes

Routing and spawn-model selection run independently of presentation in TUI, RPC/rpc-ui, ACP, SDK, and headless/CI. TUI shows the working/status indicators; RPC clients receive supported notification frames, while ACP may only log them. With `hasUI: false`, routing indicators are skipped. There are no interactive dialogs or slash commands to parameterize.

The plugin does not keep per-session routing history or workflow state, so it publishes no plugin-state sidecar. Model changes use bounded, one-shot pending spawn handoffs, not decision records. Current routing status is neither saved nor sent to the model; legacy transcript records are only rendered and filtered for compatibility.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-judge-dispatch`.

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch routeAgent false
omp plugin config set wows-omp-plugin-judge-dispatch selectModel true
omp plugin config set wows-omp-plugin-judge-dispatch modelBudget minimum
omp plugin config set wows-omp-plugin-judge-dispatch modelPick weighted
omp plugin config set wows-omp-plugin-judge-dispatch providerWeights "openai=2,anthropic=1"
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `routeAgent` | boolean | `true` | Lets the judge replace the requested agent type. |
| `selectModel` | boolean | `false` | Picks each spawn's model from the agent's model pool; see [Model selection](#model-selection). |
| `modelBudget` | `minimum` \| `balanced` \| `max` | `balanced` | Which pool models `selectModel` may use, relative to the agent's primary model. |
| `modelPick` | `best` \| `weighted` | `best` | How `selectModel` chooses among them: the judge's best fit, or a weighted draw that favors cheaper models. |
| `providerWeights` | text | empty | Provider preference as `provider=weight` pairs separated by commas or newlines. Weights must be greater than 0; unlisted providers weigh 1. |
| `judgeEffort` | boolean | `false` | Also lets the judge set each `task` call's thinking effort; see [Thinking effort](#thinking-effort). |
| `minimumConfidence` | number from 0 to 1 | `0.70` | Minimum judge confidence needed to replace the requested type or effort, or to use the judged difficulty. |
| `includeSharedContext` | boolean | `true` | Sends the task call's shared `context` along with the routing request. |
| `indicator` | boolean | `true` | Shows routing activity; see [What you see](#what-you-see). Routing works the same either way. |

User settings merge with project overrides. The plugin reads them on every `task` call, so changes apply without a restart. An invalid value, such as a malformed `providerWeights` entry, makes the plugin keep every call as requested and log a warning.

Releases before 0.6 had only `modelBudget`, with an `off` value. A stored `modelBudget: off` still reads as `selectModel: false`, and any other stored budget turns `selectModel` on unless `selectModel` is set explicitly.

## What you see

While the judge runs, the working message reads `judge-dispatch: routing N tasks…`, and the default message returns once judging finishes, fails, or times out.

Each routed `task` call then prints one dim status line right away, the same kind of line Ctrl+O prints, for example:

```text
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · effort med → hi (0.92) · model openai/gpt-6.1 → anthropic/claude-opus (fit 0.71)
```

Every item appears with the judge's confidence, whether its agent changed or was kept. An item kept without a usable judgment names the reason instead: `judge unavailable`, `judge failed`, `timed out`, `no alternatives`, `no confident choice`, or `workflow-owned or unknown agent`. With `routeAgent` off, the item shows just the agent name. With `selectModel` on, the `model` part shows the primary model and the model chosen in its place, or why the primary stays. A call that is not judged at all, because routing failed, timed out, or the host leaves no time to judge, still gets a line starting `kept the requested agent:`. Calls made while Prometheus executes an approved plan are not routed and print nothing.

The status line is visible to you, but OMP never sends it to the model or saves it in the session. It does not reappear after `/resume`. OMP folds consecutive status lines into one, so several `task` calls in the same turn can leave only the last line visible. OMP also notes a model switch next to the child's resolved model.

Set `indicator` to `false` to hide both the working message and the status line.

## Thinking effort

With `judgeEffort` on, the judge classifies how open-ended the assignment is (`routine`, `standard`, or `demanding`). The plugin sets the `task` call's `effort` to `lo`, `med`, or `hi` accordingly. OMP maps it to the lowest, middle, or highest thinking level the child's model supports, capped at `task.maxEffort`. The resulting level is always supported by the model.

When the difficulty judgment's confidence reaches `minimumConfidence`, the plugin replaces the parent's effort. A less confident answer leaves it unchanged. The judge assesses difficulty even when only one agent type is eligible. OMP applies the effort whether or not `task.enableEffort` shows the field to the parent. The exclusions in [What gets routed](#what-gets-routed) apply to effort too.

## Model selection

With `selectModel` on, the plugin picks each child's model from the spawning agent's **model pool** rather than always starting from its primary model.

### The pool

The pool flattens everything the agent may run on, in order:

1. the agent's model selectors: its `task.agentModelOverrides` entry, or else its frontmatter `model` list, with role aliases such as `@smol` expanded to the role's model;
2. the `retry.fallbackChains` entry of every role alias among those selectors;
3. for a single selector, the fallback chain OMP itself would give the child (its role's chain, or `default`).

Entries resolving to the same `provider/id` count once, and the first one wins, so its thinking suffix is kept. OMP's model registry resolves every entry. It has prices from models.dev and intelligence scores from OMP's live model catalog, and it maps custom and proxy provider ids to scored catalog entries, so the plugin keeps no model data of its own. Models without credentials are dropped, and models without a score or price are never chosen. If the primary model has no score, the spawn keeps its configured model.

### Which models are eligible

`modelBudget` decides eligibility relative to the **primary model**, the first entry in the pool. Your configuration declares the primary as the baseline, whether it is your strongest model, a cheaper second choice, or a "good enough" model with stronger and weaker ones in the chain. The budget only sets a lower bound, so a model stronger than the primary is always eligible, and the primary itself always is.

| Budget | Routine | Standard | Demanding |
| --- | --- | --- | --- |
| `max` | at least the primary's score | same | same |
| `balanced` | at least 80% of the primary's score | at least 90% | at least the primary's score |
| `minimum` | any pool model | any | any |

Difficulty comes from the same judgment that sets [thinking effort](#thinking-effort), whether or not `judgeEffort` is on. A difficulty answer below `minimumConfidence` counts as demanding, so the budget never trades down on a guess.

### How one is chosen

The judge also receives the pool models, with their scores and prices, and returns how well each fits the assignment.

- `best` (default) picks the eligible model with the highest fit × provider weight. A low budget therefore widens the choice without forcing a cheaper model: the judge can still pick the strongest one. When the judge gives no model answer, the primary stays.
- `weighted` draws one eligible model at random, weighted by fit × provider weight × cheapness. Cheapness ranks the eligible models by price, with the less capable model first on equal prices, and weighs rank `r` (0 = cheapest) as $1/(1+r)^k$:

| Budget | Routine `k` | Standard `k` | Demanding `k` |
| --- | --- | --- | --- |
| `max` | 0 | 0 | 0 |
| `balanced` | 1 | 0.5 | 0 |
| `minimum` | 2 | 1 | 0.5 |

With `k = 0`, price does not matter. Over many calls, `weighted` spreads work across the pool, and lower budgets push it toward cheaper models.

Price is the weighted average of input and output prices at a 3:1 ratio. `providerWeights` multiplies a model's weight by its provider's value: `openai=2` makes an OpenAI model twice as likely to win under the same conditions, but never makes an ineligible model eligible.

The chosen model moves to the front of the spawn's selectors, and the rest of the pool follows as its retry chain. OMP shows the routing note next to the resolved model.

OMP's `before_subagent_spawn` event carries no assignment, so the plugin links the decision to the spawn through the task item's `name`. When the parent gave no name, the plugin writes one (`<agent>-<8 hex>`). If two pending calls share a name, or the host resolves a different primary model at spawn time, the spawn keeps its configured model. Subagents from `eval.agent()` and `workpool()` keep their models, and the exclusions in [What gets routed](#what-gets-routed) apply here too.

## Enabling the judge role

Routing uses OMP's `judge` model role. The simplest setup is a TypeSafe credential:

```bash
omp            # then run: /login typesafe
# or, before OMP starts:
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

With a TypeSafe credential, the `judge` role resolves to Jev by default (`providers.judgmentProvider: auto`). OMP supplies the credentials, base URL, model, request headers, and usage accounting.

The plugin routes only when the first usable model in that role is a native judgment model, served through a judgment API such as TypeSafe or OpenRouter decisions. `minimumConfidence` relies on the calibrated confidence those APIs return. If the role resolves to a chat model or an on-device model, or there is no credential, the plugin never calls it. It keeps the requested agent and warns once per session.

## Privacy and failure behavior

A judgment request contains the assignment, the optional shared context, the originally requested agent, short candidate descriptions with their model pools, and, with `selectModel` on, each pool model's score and price. The conversation and system prompt are never sent. Requests, credentials, and usage journaling go through OMP's `judge` role; the plugin stores no keys and does not touch the process environment.

The agent or effort changes only when the judge returns a legal choice at or above the configured confidence. Anything else (no native judge, discovery failure, low confidence, an illegal choice, rejected credentials, network errors) keeps the original route and model, and nothing is blocked. Routing gives up after eight seconds and always finishes at least one second before the session's tool-call handler timeout; if there is no time left, it skips routing. A rewrite changes only `agent` when `routeAgent` is on, `effort` when `judgeEffort` is on, and `name` when a model switch needs one. The model is chosen while the `task` call is judged and applied when the child spawns; any failure there keeps the configured model.
