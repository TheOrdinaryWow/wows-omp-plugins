# Runtime reference

Contracts behind the optional runtime helpers in [README.md](README.md). User-facing behavior is documented there.

## Settings and hooks

The four runtime settings come from OMP's merged global and project plugin settings for `wows-omp-plugin-omo-toolkit`, read with the session's `ctx.cwd`. Defaults: `commentChecker=false`, `commentCheckerPath=""`, `initDeepAdvisor=true`, `fallbackArchitect=false`.

An invalid boolean disables only that feature. An invalid `commentCheckerPath` value disables comment checking. If settings fail to load at startup, the defaults apply with `initDeepAdvisor` disabled. Model-role registration is never affected.

The comment-checker `tool_result` handler is registered at session start or switch only when enabled. The host has no unregister API, so turning the setting off needs a reload or restart to restore speculative reads and streamed task launch. `turn_start` clears the reported-file set. That set deduplicates feedback; it does not deduplicate analyzer runs, so a clean file can be checked again later in the same turn. State is keyed by the real session id, and mutations are analyzed in result order within that session. Only `content` and the fixed `additionalContext` are patched. Original details and error status stay unchanged.

`edit` consumes `details.path` or `move`, `op`, `oldText`, `newText`, `snapshotsPruned`, and `perFileResults`. All native edit modes share this metadata. A real `write` requires `details.resolvedPath` and reads the final on-disk text. Known mounted mutation envelopes are unwrapped from `details.xdev.inner`. An applied AST proposal uses `resolve`'s `sourceToolName` and `sourceResultDetails`. A preview alone is not a mutation. LSP and shell output is never parsed to infer changed files. Ordinary protocol and device writes are not source-file mutations.

## External analyzer protocol

The package ships no native executable, platform resolver, npm package, or third-party runtime dependency. Any executable compatible with `code-yeongyu/go-claude-code-comment-checker` 0.8.x works.

- With `commentCheckerPath` empty, the checker is the MIT-licensed npm package `@code-yeongyu/comment-checker@0.8.2`, run through Bun's package runner as `bun x @code-yeongyu/comment-checker@0.8.2 check`. `bun` is looked up on `PATH`. Bun fetches the package (about 52 MB with its platform binary) into its own cache, and the exact version pin means later runs do not contact the registry.
- When checking is enabled, session start or switch runs `bun x @code-yeongyu/comment-checker@0.8.2 --help` once per process in the background, so the first download is never part of a check and its installer output never mixes with findings. A check that finds the download still running waits for it only as long as the result budget leaves room for a full check; otherwise that file is skipped, a single notice says files edited during the download are not checked, and checking stays enabled. A failed or five-minute-overdue download (no network, no Bun, registry error) takes the one-warning, session-inert path below.
- A non-empty `commentCheckerPath` replaces that default. A bare command is resolved through the normal process `PATH`. A value containing a path separator is resolved against the session cwd.
- Invocation is a direct argv spawn: `<command> check`. No shell is involved.
- Stdin is one JSON object with `session_id`, `transcript_path`, `cwd`, `hook_event_name: "PostToolUse"`, `tool_name`, and `tool_input`.
- Exact edit snapshots use `tool_name: "edit"` with `file_path`, `old_string`, and `new_string`.
- File writes, and explicitly labelled snapshot-unavailable fallback, use `tool_name: "write"` with `file_path` and the final `content`. A file-wide fallback does not show that a reported comment came from the last edit.

Exit codes:

| Result | Meaning |
| --- | --- |
| Exit 0 | Clean |
| Exit 2 with delivered input and non-empty stderr | Findings. Stderr is kept up to 16,384 UTF-16 code units, with a truncation label |
| Any other exit, spawn error, incomplete stdin delivery (including EPIPE), or timeout | Not checked. Never reported as clean |

Stdout is ignored. Each checker process has a 20-second deadline. On timeout it gets SIGTERM, then SIGKILL after a one-second grace period if needed. Each `tool_result` has a 29-second total budget measured before entering the session queue, leaving a return margin below the host's 30-second extension-handler cap. Queue wait and file preparation count against that same budget. A checker starts only when at least its full 20-second deadline plus one-second kill grace remains; otherwise that file is explicitly reported as not checked through the existing one-warning failure path, and checking becomes inert for the session. Multi-file results share this budget rather than granting each file a fresh one. The result handler also stops waiting at its total deadline, so a queued or preparing check cannot consume the host's whole window. The stdin error listener stays attached for the stream's lifetime, so late pipe errors cannot reach the host as uncaught exceptions. Neither process failure nor budget exhaustion changes the underlying edit or write result.

Only fixed, plugin-authored review instructions enter `additionalContext`. Checker stderr, comments, and file paths remain ordinary untrusted tool output.

## Advisor eligibility and metrics

Automatic evaluation runs after a managed startup timer, and only for enabled `ctx.agent.kind === "main"` sessions with `hasUI` set and `mode` equal to `tui` or `rpc`. It does not propose anything on session switch. Switching or shutdown cancels pending dialogs and invalidates late answers.

Non-Git workspaces and repositories without a committed HEAD cannot get Git advice or durable snapshots. Every Git subprocess uses direct argv, a 5-second deadline, hidden Windows consoles, and bounded output. Filesystem scans are asynchronous.

Coverage (no durable snapshot yet):

- Candidate directories are at depths 1 to 3. A candidate needs at least 8 direct source files or 500 direct lines of code. The root itself is not a candidate.
- A candidate is covered by its own `AGENTS.md` or by any ancestor guide up to the worktree root, so a root guide covers every candidate.
- Symlinked files and directories are skipped, as are these directory names: `node_modules`, `.git`, `dist`, `build`, `vendor`, `.next`, `__pycache__`, `.venv`, `target`, `coverage`, `third_party`.
- No candidates means no offer. Otherwise the missing-coverage ratio must be at least 0.5.
- Source extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.swift`, `.rb`, `.php`, `.c`, `.cpp`, `.cs`, `.scala`, `.lua`, `.ex`, `.exs`, `.zig`, `.dart`.
- Tracked-file inventory and source reads are reused within one evaluation. Snapshot `fileCount` counts current tracked paths. `loc` counts newlines in current regular tracked source files. Coverage's direct line count splits lines, so a final empty line counts.

Drift (valid baseline). Refresh triggers in this precedence order:

1. `commits >= 30 AND touchedRatio >= 0.15`
2. `churnLocRatio >= 0.25`
3. `ageDays >= 90`

An invalid or unresolvable snapshot commit is stale. Commit distance is `rev-list snapshot..HEAD`. Touched files and added-plus-deleted lines come from the net `snapshot` to `HEAD` diff with rename detection, not from summing per-commit churn. Binary numstat entries add no lines. Rename metadata is not counted. `AGENTS.md` at any depth and the historical `.omo/init-deep.json` are excluded from the diff numerators. Denominators are `max(current tracked file count, 1)` and `max(current tracked source LOC, 1)`, not the recorded snapshot counts.

Suppression order: global Never, project Never, seven-day cooldown, then the same last-proposed HEAD. The proposed HEAD and time are recorded before the 60-second selector opens. `Run now` queues a follow-up that reads `skill://init-deep`, and records a version-1 advisory custom entry with repository identity, trigger, measurements, and a suggested (not chosen) mode. Skip, cancel, or timeout sets the cooldown. Never stays until reset. A UI answer never writes a baseline.

## Advisor state

All paths derive from the real filesystem and Git identity. Callers cannot supply a path.

```text
<real git-common-dir>/wows-omp-plugins/omo-toolkit/init-deep/advisor.json
<real git-common-dir>/wows-omp-plugins/omo-toolkit/init-deep/worktrees/<sha256(real worktree root)>/snapshot.json
<getAgentDir()>/omo-toolkit/init-deep-advisor.json
```

The project file is shared across linked worktrees. Snapshots are per worktree. Writes use a sibling temporary file and atomic rename, with file mode 0600. Owned state directories use mode 0700.

Project advisor state (`advisor.json`):

```json
{"version":1,"declined":false,"cooldownUntil":0,"lastProposedHead":null,"lastProposedAt":0}
```

Worktree snapshot (`snapshot.json`):

```json
{"version":1,"commitSha":"<full Git SHA>","fileCount":0,"loc":0,"timestamp":0,"mode":"local"}
```

Global decline (`init-deep-advisor.json`):

```json
{"version":1,"declined":false,"declinedAt":null}
```

Times are non-negative finite epoch milliseconds. Counts are non-negative finite numbers. `mode` is `local` or `committed`.

A missing file means no decline and no baseline. An invalid or unsupported project or global file is reported and preserved, not reset into new offers. An invalid snapshot is the explicit `snapshot-invalid` eligibility case. A snapshot from a future version is refused and preserved.

These are the first shipped durable formats, so there is no older format to upgrade. An unversioned `local://init-deep/snapshot.json` written by the skill is left unchanged, and it is not silently treated as version 1 or migrated. Any future schema bump must ship a load-time upgrade and a resume test from the previous format.

## `toolkit_init_deep` tool

The tool requires write approval because `record` changes repository metadata.

- Parameters: `action` is `"status"` or `"record"`. `mode` is `"local"` or `"committed"` and is required for `record`.
- Neither action accepts a caller-provided repository, destination, SHA, count, or timestamp.
- `status` returns the current repository's project, global, and snapshot state.
- `record` runs only after `init-deep` has an independent verification PASS and settled delivery, either a settled guidance commit or a reviewed-PR handoff. It captures the current HEAD, tracked inventory, source LOC, and time, then writes the version-1 worktree snapshot.
- On success it returns `{commitSha, fileCount, loc, timestamp, mode}` in both JSON content and `details`. The skill copies those five fields into `local://init-deep/snapshot.json`.
- On failure it returns `isError: true` with an explanation and keeps the prior snapshot.
- Recording is not verification evidence. The skill owns that requirement. Reports and digests stay session-local under `local://init-deep/`.

## Fallback continuity

`message_end` arms the hint only for an assistant result with `stopReason: "error"` and `stopDetails.type` of `refusal` or `sensitive`. A new refusal replaces an earlier pending one. A later non-refusal assistant result, new interactive or RPC input, session switch, or shutdown clears it.

The fallback-applied event must match the refusing provider and model, the current primary target model, and an `architect` entry in the live active task roster. Thinking-suffix normalization uses the host helper. `reason` is optional display context, not a classifier or a trusted instruction source.

The `context` hook consumes the hint once, on the matching target request. It adds one plugin-authored developer message (`attribution: "agent"`) to that request's message copy only. Fallback-success events never re-arm it. There is no permanent fallback mode, no per-input reminder, no automatic `architect` dispatch, no model-role change, and no safety-boundary override.
