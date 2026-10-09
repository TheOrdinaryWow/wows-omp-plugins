# omo-ultrawork reference

English | [简体中文](REFERENCE.zh.md)

## Keyword detection

- A keyword counts only as a standalone word, case-insensitive, outside inline code, fenced blocks, injected directive or reminder blocks, and slash commands.
- Pasting a complete `<ultrawork-mode>…</ultrawork-mode>` block arms the session without injecting the directive twice.
- Child sessions and extension-generated messages are ignored.
- `orchestrate` suppresses injection only when OMP would act on it: the keyword is enabled and the `task` tool is active.

## Directive delivery

When persistent mode is turned on, the directive arrives:

- with arguments (`/ultrawork fix X`): queued, with the arguments sent as your next message;
- without arguments while idle: with your next message;
- mid-turn: joined to the running turn.

Turning the mode off queues a hidden exit notice. Each message in persistent mode gets the short reminder, or the full directive after compaction. `/ultrawork <request>` submits the request only when the mode was off.

While armed, the first `todo init` or `todo append` triggers one hidden reminder asking the agent to size independent work and explain its delegation choice. Compaction resets that reminder.

The footer clears on exit or when you switch to a session that is not armed. Switching or shutting down does not clear an armed session's saved state.

## Agents used by the commands

`/hyperplan`: the scope critic (`skeptic`) uses `task`, the integration critic (`validator`) uses `task` with `effort: "hi"`, and the evidence (`researcher`), architecture (`architect`) and alternatives (`creative`) critics use `deep-low`, `ultrabrain` and `artistry` when those agents are listed. Without `deep-low` the debate runs without the evidence critic; a missing `ultrabrain` or `artistry` falls back to `task`. The planner uses `ultrabrain`, or `task`.

`/ulw-research`: mechanical work goes to `sonic`, bounded judgment to `task`, and high-effort work to `task` with `effort: "hi"`. `scout` does local discovery, `librarian` (or `scout`) does source research, and `writing` (or `task`) proofreads; other category agents fall back to `task`. The helper scripts are dependency-free Node CLIs under `assets/ulw-research/scripts/`, called by absolute path.

`metis` is used only inside Prometheus planning, and `momus` outside planning only for explicit Atlas compliance checks.

Work that needs a full review follows its governing plan. Independent compliance, code-quality and real-surface QA reports may run in parallel, and the final evidence-gate reviewer starts once those reports exist. Light work gets a scoped self-review and real-surface proof without parallel reviewers.

## mass-ulw persistence

Status lives in `local://mass-ulw/<run-key>.json` and reports in `local://mass-ulw/<run-key>/<id>.md`. Both survive a kernel reset, but a saved `running` handle cannot be reattached to `wait` and must be reconciled before more work is dispatched. `done` only means a child returned. Retrying or amending some nodes leaves the other `done` reports intact.

## State snapshot

The main session publishes `omo-ultrawork.json` in the shared snapshot envelope (see the [repository reference](../../REFERENCE.md)):

```json
{ "kind": "omo-ultrawork/mode", "version": 1, "mode": true, "armed": true }
```

`mode` is the persistent toggle; `armed` means the directive is already in session context. `state` is `null` when both are false. The snapshot follows resume and branch navigation. `mass-ulw` files and research scratch files are separate from it.

Without a UI, command feedback arrives as custom messages of type `wows-omp-omo-ultrawork.command-status`.
