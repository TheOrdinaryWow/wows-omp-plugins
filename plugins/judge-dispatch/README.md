<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/judge-dispatch-dark.png">
  <img alt="judge-dispatch" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/judge-dispatch-light.png">
</picture>

# judge-dispatch

English | [简体中文](README.zh.md)

> A second opinion on every subagent: a judge model checks which kind of agent should do the task and how hard it is, and your settings decide what that changes.

When the agent hands a task to a subagent, it picks which agent type does the work (`task`, `explore`, `deep-low` and so on), and that choice is not always right. With this plugin, OMP's judge model looks at each task first. It can switch the agent type to a better fit, and it can rate the task `routine`, `standard` or `demanding`. You decide what the rating does: run easy tasks with less thinking and hard ones with more, or send them to models you pick. The judge never picks a model itself. When it is unsure, the task runs exactly as the agent asked.

You can also tell the agent to run one particular task on a specific model or model role, for example "run the review on the abliterated role".

## Install

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

You need OMP 18.17.0 or newer. Restart the session after installing. Automatic routing needs a judgment model behind OMP's `judge` role (see below); running one task on a specific model works without one.

## Quick start

The plugin uses whatever model OMP's `judge` role points to. That has to be a judgment model, such as TypeSafe's Jev or an OpenRouter decision model, because the plugin relies on the confidence score those models return. An ordinary chat model will not do.

The quickest setup is a TypeSafe login, which points the `judge` role at Jev by default:

```bash
omp            # then run: /login typesafe
# or, before OMP starts:
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

To use another judgment model, assign it to the `judge` role in your OMP configuration. If the role points to a chat model, a local model or a model without credentials, the plugin keeps every task as requested and warns once per session.

Once it works, every routed task shows a dim status line:

```text
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · thinking medium → high (0.92) ; #3 ultrabrain kept (0.95) · model openai/gpt-6.1 → @slow (0.88)
```

Here task 1 was moved from `explore` to `task`, task 2 kept its agent but thinks harder, and task 3 runs on the `@slow` model role. The numbers are the judge's confidence.

By default the plugin only switches agent types. To let the difficulty rating change thinking levels or models, turn on `judgeEffort` or set `modelTiers` (see [Settings](#settings)).

## Usage

### Picking the right agent

The judge looks at the task and the agents available in your session, and switches the agent type when another one fits clearly better. A read-only agent is only ever replaced by another read-only agent, so a request to look at code never turns into one that changes it. Turn this off with `routeAgent: false`.

Some tasks are always left exactly as they are, model and thinking level included:

- tasks for the workflow agents of other plugins: audit-goal's `audit-*` agents and omo-prometheus's `metis`, `momus` and `oracle`. Other tasks are never sent to them either;
- tasks for OMP's `seance` agent, which consults an earlier session;
- tasks for an agent the plugin does not know;
- tasks that already name their own model (OMP's per-task `model` field);
- every task while an omo-prometheus plan is being carried out, because the approved plan already decided who does what.

Tasks whose instructions are in a file (OMP's `taskFile`) keep their agent, since the judge cannot read them. Subagents started from `eval` scripts are not routed at all.

### How hard is a task

The judge rates how open the problem is, not how much work it is: `routine` when the fix or the steps are already known, `standard` for ordinary work whose approach is mostly clear, and `demanding` when the cause or the design is still open. It only asks for a rating when the answer would change something, that is, when `judgeEffort` is on or a tier is configured for the agent. A rating the judge is not confident about counts as `standard`, which changes nothing.

### Adjust thinking by difficulty

With `judgeEffort` on, a `routine` task thinks one level less and a `demanding` task one level more than the agent normally would. The starting point is the agent's own configured level.

- An agent with no fixed level (none, `auto`, `inherit` or `off`) is left alone.
- The step stays within the levels the model supports, so it never turns thinking off and does nothing at either end.
- A step up never goes past OMP's `task.maxEffort`.
- A task that already sets its own `effort` keeps it.

### Run easy or hard tasks on other models

`modelTiers` says which model runs `routine` and which runs `demanding` tasks:

```text
routine=@smol,demanding=@slow,ultrabrain.demanding=openai/gpt-6.1:xhigh
```

Each comma-separated entry is `[<agent>.]<routine|demanding>=<model>`, where the model is a model role such as `@smol` or one model such as `provider/model[:level]`. An entry for one agent (`ultrabrain.demanding=…`) wins over the entry for all agents. `standard` tasks always run on the agent's own model.

A tier uses its model role's fallback models if the first one is unavailable. When a tier applies, its own thinking level is used and the thinking step above does not. If a tier cannot be used, for example because the role does not exist or the model has no credentials, the task keeps the agent's model and the status line says why. A tier never blocks a task.

### Retry or escalate a task

The plugin tells the agent to retry or escalate a task by sending it again under the same name, and then raises that one attempt:

- If a subagent's answer starts with the line `ESCALATE: deep-high`, the next attempt counts as `demanding`.
- If a subagent fails on a route the plugin made easier (a `routine` tier or less thinking), the next attempt counts as `standard` and runs on the agent's own model and level.

The raised attempt keeps the agent that was asked for and is not judged again. The status line shows `escalated to demanding after ESCALATE: deep-high` or `raised to standard after a failed lowered run`. These records last until OMP restarts.

### Run one task on a specific model

Tell the agent which model role or model to use for one task, for example "run the review on the abliterated role". The plugin teaches the agent to write that task's agent as `<agent>@<role>` or `<agent>@<provider>/<model>`:

```text
task({"name":"ReviewLogic","agent":"deep-low@abliterated","task":"Review the logic"})
```

The subagent then runs as `deep-low` on that role's model, with the role's fallback models. The role must exist in your OMP `modelRoles`, and a specific model must be enabled and have credentials. A pinned task gets no tier or thinking step, though the judge may still switch its agent type. Pins work even without a judge.

The subagent's ID gets a suffix such as `ReviewLogic_jd0123456789ab`, so no other task with the same name can take over its model. The agent is told about this and uses the new ID. The rewritten call is what OMP shows; that is the pin working, not an error.

If a pin cannot be applied, the whole call is refused with the reason, instead of quietly running on the agent's usual model. That happens for an unknown role, a model that cannot be used, a workflow agent such as `metis`, a task that also sets OMP's own `model` field, and any pin while an omo-prometheus plan is being carried out. For `seance`, put the model in that task's `model` field instead.

### What you see

While the judge works, the status reads `judge-dispatch: routing N tasks…`. Then each routed call shows a status line like the one above: the agent, `thinking <from> → <to>`, `model <agent's model> → <tier>` or why the model stays, with the judge's confidence for each decision. A task kept without a usable answer says why: `judge unavailable`, `judge failed`, `timed out`, `no alternatives`, `no confident choice`, `file-backed task`, `native model`, or `workflow-owned or unknown agent`. A call that could not be judged at all shows a line starting with `kept the requested agent:`.

The status line is only for you. It is not sent to the model and not saved, so it does not come back after `/resume`. Set `indicator` to `false` to hide it.

### What the judge sees

A judgment request contains the task's instructions, its description of how open the problem is, the shared context of the call (unless you turn `includeSharedContext` off), the requested agent, and a short description of each available agent. It never contains your models, prices, the conversation or the system prompt.

Judge requests count toward your session's cost limit (`session.maxCost`) and its usage, like any other judgment in OMP.

### When the judge is not available

If the judge is missing, unsure, rejects its credentials or cannot be reached, the task runs with its original agent, thinking level and model. Nothing is blocked. The plugin gives up after eight seconds.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-judge-dispatch judgeEffort true
omp plugin config set wows-omp-plugin-judge-dispatch modelTiers "routine=@smol,demanding=@slow"
omp plugin config list wows-omp-plugin-judge-dispatch
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-judge-dispatch": { "judgeEffort": true } } }
```

Settings are read on every task, so changes apply right away. If a value is invalid, such as a malformed `modelTiers` entry, the plugin keeps every task as requested and logs a warning.

| Setting | Default | What it changes |
| --- | --- | --- |
| `routeAgent` | `true` | Lets the judge switch a task to a better-fitting agent type. |
| `judgeEffort` | `false` | Gives routine tasks one level less thinking and demanding tasks one level more. |
| `modelTiers` | empty | Which models run routine and demanding tasks, as `[<agent>.]<routine\|demanding>=<@role or provider/model[:level]>` entries separated by commas. Empty means every task uses its agent's model. |
| `minimumConfidence` | `0.70` | How sure the judge must be (0 to 1) before the plugin switches an agent or acts on a difficulty rating. Higher means fewer changes. |
| `includeSharedContext` | `true` | Whether the judge also sees the shared context of a `task` call, in addition to each task's instructions. |
| `indicator` | `true` | Shows the status message and status line. Routing works the same either way. |

## Working with other plugins

- **audit-goal**: its reviewer and fixer agents are never rerouted.
- **omo-prometheus**: `metis`, `momus` and `oracle` are never rerouted, and nothing is rerouted while an approved plan is being carried out. Routing resumes once the plan is done or you are planning again.
- **omo-toolkit**: its `deep-low` agent answers `ESCALATE: deep-high` when it hits a decision it cannot settle. Sent again under the same name, the task counts as demanding.

## Known limitations

- Subagents started from `eval` scripts (`agent()`, `workpool()`) are not routed and cannot be pinned to a model; only `task` calls can.
- A pinned subagent's ID has a `_jd…` suffix instead of the name you gave it.
- When the agent makes several `task` calls in one turn, OMP may show only the last status line.
- Retry and escalation records are lost when OMP restarts, and only a retry under the same name finds them.
- The thinking step needs OMP to know which thinking levels a model supports. A model without that information keeps its level.

## More details

[REFERENCE.md](REFERENCE.md) covers how tiers and pins expand into model lists, the exact thinking-step rules, the retry and escalation records, how decisions reach the subagent, and timeouts.

## License

MIT.
