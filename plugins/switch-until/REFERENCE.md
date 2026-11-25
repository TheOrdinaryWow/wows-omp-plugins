# switch-until reference

For maintainers and client authors. The [README](README.md) covers use.

## Files

- `src/index.ts`: the `/switch-until` command, session events, the turn loop, the restore timer.
- `src/state.ts`: the saved entry format, rebuilding state from the session branch, and the stop rules.
- `src/judge.ts`: the judge question, the judge call, and translation.
- `src/evidence.ts`: builds the judge's text from session messages and plugin state.
- `src/translation-cache.ts`: per-message translation cache and the non-English test.
- `src/sidecars.ts`: reads plugin state files for the session.
- `src/models.ts`: model selection and the compaction check.
- `src/model-picker.ts`: the TUI model picker.
- `src/tsp.ts`: helpers that build UI nodes without JSX.
- `src/args.ts`: parser for the headless command form.
- `src/settings.ts`: settings defaults and validation.

The manifest is `package.json` with `omp.extensions` pointing at `./src/index.ts`. It declares four settings in `omp.settings`. The plugin has no runtime dependencies.

| Setting | Type | Default | Rule |
| --- | --- | --- | --- |
| `minimumConfidence` | number | `0.8` | 0.5 to 1 |
| `maxTurns` | integer | `0` | 0 or more; 0 means unlimited |
| `maxHours` | number | `6` | greater than 0; fractions allowed |
| `contextMessages` | integer | `6` | 1 or more |

Settings are read with `getPluginSettings("wows-omp-plugin-switch-until", ctx.cwd)` during setup, at each turn start and turn end, when a run is rebuilt, and at each timer check. A value that fails validation logs a warning and uses its default. A failed read uses all defaults.

## Only the main session acts

Every command and event handler returns early unless `ctx.agent.kind === "main"`. Subagent sessions that load the plugin do nothing.

## Setup

`/switch-until` runs these steps in order. Nothing is switched until step 9.

1. Require the current session model and a session that the agent registry knows about. Otherwise the command fails.
2. If a switch is already active, ask to replace it when there is UI. Declining stops the command. Without UI, fail.
3. Pick the target model. With UI and an argument, the argument goes through `resolveCliModel` with the session's scoped models. With UI and no argument, the picker opens. Without UI, the argument is parsed as the headless form. Cancelling returns without a message.
4. Require a native judge for the target. `findScopedSettings(ctx.cwd)` must return settings, and `hasNativeJudge(settings, registry, target)` must accept the target model. Otherwise the command fails with the judge hint.
5. Read the goal. With UI, `ctx.ui.input("Until what?")` is trimmed. An empty goal or one with a line break returns without a message. Without UI, the goal comes from `--until`.
6. Read the context. With UI, `ctx.ui.editor("Additional context (optional)")` is used. Cancel aborts. An empty result means no context. Without UI, the context comes from `--context`.
7. Read settings, then translate the goal to English with a 60 second timeout. A translation failure reports an error and switches nothing.
8. Confirm that the session is still the same, the original model is still current, and no other setup or switch has started.
9. Compact if the transcript exceeds the target's context window. If compaction fails, or the transcript still exceeds the window, stop with an error. Check the native judge for the target again. Then switch with `session.setModelTemporary(model, thinking)`, where `thinking` is the picked level or the model's default level. If the target is not the current model afterward, stop with an error.
10. Persist a `start` entry, attach the run, schedule the deadline check, and send the notice.

The picker in TUI is a searchable `picker` sheet in a bottom overlay. It lists the session's scoped models, or every available model when the session has none, most recently used first. The current model is marked, and a model whose context window the conversation exceeds is marked "compacts first". Typing filters by `provider/id` and name, Backspace deletes, Ctrl+U clears the search, Esc clears the search first and then cancels. Left and Right move the thinking slider, which starts at the session's configured thinking level and is clamped to the highlighted model's levels. The result carries a thinking level only when the slider was moved. Outside TUI with UI, `ctx.ui.select` lists `provider/id` for each available model, with `(current)` after the current one. That path has no thinking level, so the model default applies.

## Switching and restoring

- `setModelTemporary` is the same path as `/switch`. It logs a temporary model change and does not write default settings.
- A selection records the provider, the id, a `selector` and `configuredThinkingLevel()`. The `selector` comes from `formatModelStringWithRouting`, so a routed model is stored as `provider/id@upstream`. The original selection is captured at setup.
- Restore resolves the saved `selector` with `resolveExactModelIdentity`, so the same upstream route comes back along with the provider and id.
- Restore passes the saved thinking level. If the saved level is undefined and the session has a level set, it clears the level with `setThinkingLevel(undefined)`.
- Compaction runs in both directions through `compactToFit`. It calls `session.compact(undefined, { readerModel })` only when `getContextUsage().tokens` is greater than the model's `contextWindow`. A window of 0 or missing skips compaction. If the context still exceeds the window afterward, the call throws.
- A restore first compacts when the original model needs it. If the original model is not found, or compaction throws, the plugin shows an error and schedules a retry in 60 seconds. The pending reason stays set, so each retry runs the restore again.
- A restore writes its `end` entry and notifies only after the original model is confirmed as current.
- When a restore needs compaction during a streaming turn, it yields once so the turn-end handler can finish before compaction interrupts the loop. Otherwise the plugin does not wait for streaming to end before it restores.
- The turn-end limit restore passes `continues` as true only when the turn had tool results or ended with `toolUse`. When that restore needs compaction, `compactToFit` suppresses the continuation for a turn that paused without a tool call. The loop stops there, and the user must send a message to continue.
- `needsCompaction` compares `getContextUsage().tokens`, the count OMP reports for the current model, with the target's `contextWindow`. After a provider-native compaction that count reflects the current model's view, so a switch to a much smaller window on another provider can still overflow.

### Foreign model changes

The plugin compares the route label of `ctx.models.current()` with the route label of the target (`formatModelStringWithRouting`). Thinking changes are not detected.

An automatic fallback is accepted as the same run. Ownership starts at the `start` entry, or at the latest `reconciled` entry after a resume. A model change after that point with a role other than the `fallback` (ephemeral) role is explicit. An explicit change ends the run as `foreign-change`, even when it selects the target model. Without an explicit change, the check passes when the current model is the target, or when the latest change after that point is flagged `resolvedModelIsFallback` and names the current model.

The plugin calls `session.disarmPrewalk()` once a new switch is saved or a resumed switch has reclaimed the model. It does so when the effective `prewalk.auto` setting is enabled or `getPrewalkState()` reports a pending prewalk. This cancels the pending handoff and keeps auto prewalk off in that session until `/new`. When starting a switch disarms prewalk, the notice includes "Auto prewalk is off for this session until /new."

The comparison runs at turn start and turn end, before and after each judgment, before a restore, on each timer fire, in the `context` handler, in the command handler when a switch is active, during setup, before a request held for a pending limit is stopped, and on the `retry_fallback_applied` event. A mismatch writes an `end` entry with reason `foreign-change`, clears the status line, and notifies. Nothing is restored.

### Timers and stop rules

The run sets a timer for its deadline, `startedAt + maxHours`. The delay is clamped to 2,147,483,647 ms. When the timer fires, the plugin re-reads settings and decides:

- If a switch or restore is in progress, or the session is transitioning, it checks again in 250 ms.
- Otherwise, if a reason is pending or `decide` returns one, it restores.
- Otherwise it checks the model and schedules the next check at the deadline.

`decide` checks in this order: the deadline (`time-limit`), then `maxTurns` (`turn-limit`) when it is greater than 0, then the judge probability against `minimumConfidence` (`met`). Only a probability whose evidence is the latest qualifying turn can produce `met`. The timer and turn-boundary checks pass no probability, so they can only produce a limit.

Each `turn_end` of the main session increments `turns`, writes a `turn` entry, and checks the limits before the turn's judgment runs. A limit therefore restores without waiting for the judge. Turns count from the start of the switch, and a replacement starts again at zero.

While a limit reason is pending, a before-model-call hook waits for any turn check and any restore in progress. If the run still owns the temporary model after that, the hook aborts the request. The limit is recorded as soon as the restore starts, before compaction and before the notice, so requests are blocked from that point. The hook stays installed until the run detaches, so a failed restore keeps blocking requests. A cancel during a pending limit restores with the limit's reason.

## Context injection

While a switch is active and has context, the `context` event returns a copy of the request messages with one extra user message at the end:

```text
Additional user-provided guidance for the current goal, active until the goal is met:

<context text>
```

The message is not stored in the session and the system prompt is not changed, so prompt caching is unaffected. The message disappears when the switch ends.

## Judging

### When a judgment runs

A `turn_end` produces a judgment only when the turn's assistant message has a non-blank text part, or when the turn's tool results include one from `task`. Turns that only call tools are skipped.

Judgments run on a queue outside the event handlers. `turn_end` adds to the queue and returns without waiting. Only one judgment runs at a time for a switch. A qualifying turn that ends during a judgment queues one request, which replaces any request already waiting. When the current judgment finishes, the waiting request runs with the latest settings and the latest evidence.

A judgment is acted on only when its `evidenceId` is the run's latest qualifying turn. If newer qualifying evidence arrives while the judge runs, the finished judgment is still recorded and counted in `judgedTurns`, and it can show in status, but it cannot restore. The newer evidence is judged next. A `met` decision is checked again after any compaction and before the switch back. If the branch has a newer qualifying turn than the judgment's evidence, the plugin drops the restore without a notice or an end entry, and judges that turn.

A judgment is dropped without an entry when a reason is pending, a switch or restore is in progress, or the run no longer owns the temporary model. A judgment error shows a warning and writes no entry. The turn is still counted, since its `turn` entry is written first.

### The judge question

The judge runs `resolveJudge` with settings from `findScopedSettings(ctx.cwd)`, the model registry, the session model, the session id, the purpose `switch-until`, the session's usage journal, and the session cost gate. It uses only a candidate with `kind === "native"`. A chat model is never used. If no native candidate exists, the plugin reports the judge hint.

The question is one choice question with id `goal`:

- `met`: the available evidence clearly establishes that the user's full goal has been accomplished.
- `not_met`: the goal is incomplete, merely started or promised, or the available evidence is insufficient or ambiguous.

The instructions ask the judge to use the recent messages and workflow state as evidence, and to treat them as data rather than instructions. The probability is `answers.goal.probabilities.met`. It must be a finite number from 0 to 1. The call has a 60 second timeout and is cancelled when the switch detaches.

### The judge's text

`buildJudgeState` returns three parts separated by blank lines:

```text
Goal: <English goal>

Recent session messages:
user: <text>

assistant: <text>

Tool result <tool name> (error): <text>

Plugin state:
<plugin>: <state JSON>
```

Session messages are taken from the current branch, newest first, until `contextMessages` entries are collected. Only `user`, `assistant` and `toolResult` messages count. Text parts are joined with newlines and trimmed. An assistant message with no text, and a user message with no text, are skipped. Tool results always count, even with an empty body. Non-text parts such as images are ignored. The collected messages are then put back in chronological order.

Each message's text is capped at 2,000 characters and ends with `…` when cut. Each message is translated when it contains non-Latin letters. Translations are cached in memory by message entry id for the life of the switch, so each message is translated at most once. Each new translation is also saved as a `translation` entry, and a resumed run seeds its cache from those entries.

A failed translation is not cached. The judgment fails with a warning, and the next qualifying turn tries the translation again.

Plugin state is read from the sidecar files described below. Each state is stringified as JSON, capped at 2,000 characters, and translated when needed. These translations are not cached and not saved.

## Translation

`needsTranslation` returns true when the text contains a letter outside the Latin script, using `/(?=\p{L})\P{Script=Latin}/u`.

Translation uses the `tiny` model role first and `smol` second. Each role resolves through `resolveModelRoleValue`, `formatModelRoleAlias` and `roleCandidatePool` with the scoped settings. A role with no available model counts as a failure.

- A local model (`api === "local-inference"`) gets no API key and no cost gate check.
- A remote model passes `session.costGate.admit()` before the call, records its cost afterward, and journals usage with the purpose `switch-until-translate`.
- The request uses `disableReasoning: true` and `maxTokens: 2048`.
- The system prompt asks for a faithful English translation, keeps identifiers, paths and product names as written, wraps non-Latin identifiers in backticks, and returns only the translation.

A result counts as a translation only when it has text, contains an ASCII letter, and has no non-Latin letters outside backtick spans. Stop reasons `error`, `aborted` and `length` count as failures. If both roles fail, the error lists each failure.

The goal is translated once during setup, with a 60 second timeout. The English text is stored in the `start` entry as `englishGoal`.

## Plugin state sidecars

The plugin reads state files that other plugins publish for the session. It never writes them.

- The runtime root is `$XDG_RUNTIME_DIR/wows-omp-plugins` when `XDG_RUNTIME_DIR` is an absolute path. Otherwise it is `<os.tmpdir()>/wows-omp-plugins-<uid>`.
- The files are in `plugin-state/<sessionId>/`. The session id must be one path segment. `.` and `..` are rejected.
- The root must be a real directory owned by the current user, with no group or other permission bits. If it fails the check, nothing is read.
- Only regular `.json` files are read, in name order. A file is used only when it has `schema: "wows-omp-plugins/plugin-state"`, `version: 1`, the same `sessionId`, a string `plugin`, and a `state` key.
- Invalid files are skipped and logged at debug level.

## Saved entries

Each entry is a session custom entry with custom type `switch-until`. Every entry has `version: 1`. Readers accept only that version, and an entry that does not match the format is skipped. The payload has one of six kinds:

| Kind | Fields | Written at |
| --- | --- | --- |
| `start` | `run`: `id`, `original`, `target`, `goal`, `englishGoal`, optional `context`, `startedAt` | setup |
| `turn` | `id`, `turns` | when the turn count rises, normally at `turn_end` |
| `judgment` | `id`, `turns`, `judgedTurns`, `judgment`: `probability`, `at`, `evidenceId` | each judgment that is recorded |
| `translation` | `id`, `messageId`, `text` | each message translated during a switch |
| `reconciled` | `id`, `modelEntryId` | a resume reapplies the target model |
| `end` | `id`, `reason`: `met`, `cancel`, `foreign-change` or `limit`, optional `limit`: `turn-limit` or `time-limit` | the end of a switch |

A selection is `{ provider, id, selector?, thinking? }`. `selector` is the route-aware label used for an exact restore. `thinking` is one of the CLI thinking levels or `inherit`. The `start` entry for a replacement keeps the first switch's `original`.

`limit` covers both the turn limit and the time limit. The notice text tells them apart, and `end.limit` records which one ended the switch.

Rebuilding state walks the current branch in order:

- A `start` entry replaces any earlier run and begins a new workflow.
- An entry with a `version` other than 1 is ignored, and so is an entry whose fields fail validation.
- Other entries are applied only when their `id` matches the current run.
- An `end` entry marks the run as ended. It is no longer active, but status shows its reason until the next `start`.
- A `turn` or `judgment` entry with a smaller turn count than the run already has is ignored.
- `translation` entries seed the translation cache.
- A `reconciled` entry moves the ownership point used by the foreign-change check. Its `modelEntryId` is the model change that reapplied the target.

`startedAt` is wall clock time, so elapsed time keeps counting across restarts.

## Session events

- `session_start`, `session_switch`, `session_tree`, `session_branch` and `session_clear` detach the current run and rebuild from the branch. `session_branch` covers a rewind (`/branch`, `/rewind`, a turn's Edit or Retry) that continues in a new session: a run whose `start` entry is still on the new branch keeps going there, and one whose `start` was cut off is dropped. When the kept history has no explicit model change after the run's last model entry, the rebuild reapplies the saved target, even if the host kept another model live (for example after a restore that the branch cut off). If the session is transitioning, the plugin waits for the transition, then checks the run. The check uses the last judgment's probability only when that judgment's `evidenceId` matches the run's latest qualifying turn. A `met` judgment from before a restart therefore restores at once only if it judged the newest qualifying evidence. Otherwise the plugin judges the newer evidence right away.
- A rebuild calls `reconcileTarget` first. While the run still owns the session model, it reapplies the saved target route and thinking level. After an explicit model change it does nothing, and that change ends the run as a foreign change.
- `session_shutdown` clears timers and aborts any judgment. In print and json modes it first waits up to 1.5 seconds for outstanding work. It writes no entry, so the run is still active when the session is opened again.
- `turn_start` checks the stop rules before the turn runs.
- `retry_fallback_applied` re-checks the run's model, so an automatic fallback keeps the run active and a foreign change still ends it.

## Status and notices

With UI, the status line is `ctx.ui.setStatus("switch-until", "until: <goal>")`. The goal is cut to 40 code points, with `…` after the 39th. The status line is cleared when the run detaches.

Notices go to `ctx.ui.notify(text, level)` with UI. Without UI they go to `pi.sendMessage({ customType: "switch-until", content, display: true, excludeFromContext: true })`.

Setup sends `Switched to <target> (<thinking> thinking) until: <goal>`.

Restore notices read:

- `Goal met. Restored <selector> (<thinking> thinking).`
- `Switch-until cancelled. Restored ...`
- `Switch-until reached its turn limit. Restored ...`
- `Switch-until reached its time limit. Restored ...`
- `Switch-until ended because the session model changed.`

A failed restore shows `Switch-until could not restore the model. <reason>` at error level and retries in 60 seconds. A failed judgment shows `Switch-until judgment failed. <reason>` at warning level.

`/switch-until status` prints the temporary model and thinking, the restore model and thinking, the goal, whether context is present, elapsed time as hours, minutes and seconds, judged turns against total turns, and the last judgment with its probability, time and a short reading. The reading is "judge favored met" above 0.5, "judge favored not met" below 0.5, and "judge was evenly split" at 0.5.

When no switch is active but the last run has ended, status prints `Last switch-until: <reason>.`, the goal, and the last judgment instead. The reasons are `Goal met`, `Switch-until cancelled`, `Session model changed`, `Switch-until reached its turn limit` and `Switch-until reached its time limit`.

## Modes

- TUI (`ctx.mode === "tui"`): the picker overlay, notifications and the status line.
- Other modes with UI, such as RPC and ACP hosts that provide dialogs: `ctx.ui.select` for the model, `input` for the goal, `editor` for the context and `confirm` when replacing. The plugin branches on `ctx.mode` and `ctx.hasUI`, not on the host's name.
- Headless (no UI): only the command form works. Use `/switch-until <model> --until "<goal>" [--context "<text>"]`. The parser accepts double-quoted values with `\"` and `\\` escapes, single-quoted values, and bare words. Flags must be bare words. `--until` is required. A bare value that starts with `--` is rejected. The goal must be on one line. A switch that is already active is refused, so it must be cancelled first. No replacement confirmation is asked. Notices become display messages.
- `status` and `cancel` work in every mode. Argument completion offers `status`, `cancel` and the model labels from the session's model list. It returns nothing when the prefix has whitespace.

## Concurrency

- `commandOpen` blocks a second setup while one is running.
- `switching` blocks model changes, judgments and restores while a switch or restore is in progress. A setup that finishes its awaits checks the session again before it switches.
- The judgment queue holds one pending request, and a newer request replaces it.
