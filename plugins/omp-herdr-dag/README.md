# omp-herdr-dag

English | [简体中文](README.zh.md)

Live native todos, approved-plan execution, Atlas dependencies, and subagent activity in a Herdr side pane. The viewer observes work. It does not schedule dependencies, complete todos, or change the Atlas ledger when a child finishes.

## Install

```bash
omp plugin install omp-herdr-dag@wows-omp-plugins
```

Restart OMP after installing. Requires OMP 18.3.5 or newer, the `herdr` CLI on `PATH`, and an interactive OMP session inside Herdr. Linux and macOS use the same implementation, but macOS has not been verified. Windows is unsupported and receives a one-time notice. Noninteractive child sessions do not start a viewer.

The pane needs a Bun executable. Put `bun` on `PATH` or set `viewerRuntime` to its path. Automatic discovery tries `bun` first, then the host executable only if its `--version` output looks like Bun's semantic version. The plugin does not assume a compiled OMP executable can run the viewer. Missing Bun produces a warning and skips pane management.

Herdr supplies `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`; all three are required. Outside Herdr, `/dag-pane` reports that the pane is unavailable. The native todo wrapper remains registered, including outside Herdr.

## Host modes

Pane management, the viewer, transport subscriptions, and snapshot publishing run only with `mode: "tui"`, `hasUI: true`, and all three Herdr environment variables. RPC/rpc-ui and ACP are inactive even when `hasUI` is true or Herdr variables were inherited. SDK/headless sessions with `hasUI: false` never start or split panes. A missing `HERDR_PANE_ID` also prevents pane startup. `/dag-pane [open|close|toggle]` is a TUI command; there is no headless pane equivalent. The native todo wrapper remains available in every mode as described below.

There is no plugin-state sidecar for this viewer: its graph projects native todo/subagent state and Atlas state, available through host RPC data and omo-prometheus's sidecar. Its existing Herdr snapshot is viewer recovery data, not another workflow authority.

## Commands and automatic opening

```text
/dag-pane [open|close|toggle]
```

The bare command toggles. `open` is idempotent; `close` is safe when no pane exists. Manual opening works regardless of `displayTiming`. The plugin manages only its recorded pane ID, never panes found by title.

Automatic opening follows `displayTiming`:

| Value | Opens for |
| --- | --- |
| `never` | Nothing automatically; use the command. |
| `any-todo` | Native todos, approved-plan todos, or a bound Atlas plan. |
| `plan-execution` | Verified native plan execution or a bound Atlas plan. |
| `atlas-only` | A bound Atlas plan only. |

Subagent activity by itself does not open the pane. Pressing `q` in the viewer or running `/dag-pane close` saves a dismissal. Updates to the same run will not reopen it. A newly observed run ID, or `/dag-pane open`, clears dismissal. `/new` and session switches reuse the pane while rebinding its contents and storage.

## Sources and graph meaning

| Source | Default border and header color | Meaning |
| --- | --- | --- |
| Native todo | Blue, `#4f8cff` | Native phases form bands. Dashed phase separators mean order, not dependency. |
| Native plan execution | Purple, `#a371f7` | The first nonempty new todo list after a verified native approval handoff. |
| Atlas | Green, `#3fb950` | omo-prometheus tasks, fixes, and final gates, with ledger dependency and fix-origin edges. |

Plan execution requires the recorded proposal, the host's matching plan reference, and its exact approval envelope. A user message saying `Plan approved.` or a bare new-session event is not enough. The plan epoch ends once its list is completed or abandoned and the agent turn ends without continuation. A later list is an ordinary blue todo run.

Queued synthetic developer approval messages use the same checks as a new turn's approval prompt. Canonical todo writes must be newer than both the live polling baseline and the recorded approval to claim the first plan list; historical lists replayed on startup, switching, or rewinding cannot. The final agent-turn boundary reconciles canonical todo writes before checking whether the plan list is terminal. Trusted queued handoffs are identified by their host timestamp and approval text, accepted only after the current proposal, and consumed once. A context retaining an old approval cannot approve a later proposal for the same path.

While Atlas is bound, the mirrored phases named exactly `Atlas tasks`, `Atlas fixes`, and `Atlas final gates` are hidden from the native todo view. An all-mirror list cannot claim or consume an armed native plan approval. The mirrors reappear as plain blue todos when Atlas releases or integration is disabled; a later new native list can still claim the approval.

Forward dependencies use solid connectors in a subdued color, so the boxes stand out more than the lines. The selected node's incoming and outgoing edges switch to the run's source color in bold. Backward dependencies remain valid, with a dotted connector and an `↑ after <label>` annotation on their target. Fix edges are dotted. The critical path uses observed node elapsed time, or unit weight for unstarted nodes, across explicit dependency edges only. It is drawn with heavy lines. Where it crosses other connectors, only its own arms stay heavy, and where it shares a stroke with the selection, the critical path wins. Runs without those edges have no critical path. Completed layers can be folded.

By default the graph shows the transitive reduction of the forward dependencies. When a longer forward path already orders two nodes, the direct edge between them is not drawn. For example, final gates that depend on every task hang off the last task as one fan-out. Fix and backward edges are always drawn, and the critical path still weighs every dependency. `e` draws every dependency, and the footer always lists the selected node's direct dependencies (`deps: T4, T6, T7`). A long edge runs as one vertical trunk per source through the layers it skips and branches off at each target. Edges converging on one node share a single arrowhead.

Node boxes are 30 columns wide, shrinking to no less than 20 when that lets the widest layer fit the pane. The viewer pans and follows the selection, so a layer wider than the pane stays a single row as long as it fits twice the pane's width, or 120 columns in narrower panes. Four boxes need 86 columns, so a 50-column pane keeps four final gates in one row and scrolls sideways to the selected one. Only a wider layer wraps onto extra rows inside its band, spread evenly and kept in their usual order: left to right, then top to bottom. Eight boxes in a 50-column pane, for example, make two rows of four. The trunks feeding later rows run down the middle of the earlier rows, never around the outside. Several edges from one node, or into one node, share a connector there. Arrow keys move between the drawn boxes, and paging follows the drawn order. A folded layer stays a single summary row.

Each node sits under the median of its parents, so chains run straight down. With `layoutAlign` set to `centered` (the default), siblings that would overlap spread evenly on both sides of their parent, and the whole graph is centered on the canvas axis, which is the pane's axis when the graph fits. With `left`, overlapping siblings move only rightwards and the graph sits against the left edge.

State colors come from the OMP theme, separately from source colors:

| Icon | State | Color role |
| --- | --- | --- |
| `○` | Pending | Muted |
| `◐` | Running | Accent |
| `✔` | Done | Success |
| `✖` | Failed | Error |
| `⊘` | Blocked | Warning |
| `⊖` | Abandoned | Dim |

A running node linked to a stalled child uses warning color. Running task cards, linked or unlinked, also use warning borders and a `stalled` label until new progress arrives. Child failure does not mark a todo or ledger row failed or done.

The Tasks view shows direct children from native `task`, eval agents, and workpool: tool and arguments, recent output, model, retry details, elapsed time, tokens, and cost when supplied by the host. A child is attached to the native todo in progress when it starts. Repeated activations of the same child keep completed usage and add the current activation, so cumulative progress frames are not counted twice. Run usage counts each linked child once. Unavailable metrics use a missing-value marker, not zero.

## Explicit todo dependencies

With `todoDependencies` enabled, `todo` accepts optional `edges` alongside its unchanged native fields. Match task contents verbatim. `task` depends on every content string in `after`:

```json
{
  "op": "init",
  "list": [
    { "phase": "Implementation", "items": ["Build parser", "Connect viewer"] },
    { "phase": "Verification", "items": ["Check rendered output"] }
  ],
  "edges": [
    { "task": "Connect viewer", "after": ["Build parser"] },
    { "task": "Check rendered output", "after": ["Connect viewer"] }
  ]
}
```

The wrapper removes `edges` before delegating to the native tool, preserving native mutations, details, hooks, approval, batch failure, and rendering. Malformed, unknown-task, self-referencing, or cyclic dependencies are dropped with a `Herdr DAG edges:` warning appended to the result text; the successful todo change still applies. A native operation error does not record edges. Removing or changing tasks prunes their edges; `init` starts a fresh generation. No dependencies are inferred from wording or phase order. Turning off `todoDependencies` disables edge processing, not native todo operations.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omp-herdr-dag`.

```bash
omp plugin config wows-omp-plugin-omp-herdr-dag
```

Settings are read for the session's working directory on startup, session switch, each command, and each automatic-opening evaluation, including heartbeat evaluations. Invalid fields fall back independently to their defaults, with one warning per project scope. "Next launch" below means close and reopen the viewer; changes do not restart an already running viewer.

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `displayTiming` | `never` \| `any-todo` \| `plan-execution` \| `atlas-only` | `plan-execution` | Automatic-opening policy; applies on the next evaluation, without closing an existing pane. |
| `finishBehavior` | `close-with-omp` \| `keep-open` | `close-with-omp` | Host shutdown uses the current setting; the viewer's heartbeat-loss policy is fixed at its next launch. |
| `landscapePosition` | `left` \| `right` \| `top` \| `bottom` | `right` | Landscape placement; next open or orientation recreation. |
| `portraitPosition` | `left` \| `right` \| `top` \| `bottom` | `bottom` | Portrait placement; next open or orientation recreation. |
| `landscapeSize` | number from 0.15 to 0.6 | `0.35` | DAG share in landscape; next open or orientation recreation. |
| `portraitSize` | number from 0.15 to 0.6 | `0.4` | DAG share in portrait; next open or orientation recreation. |
| `followOrientation` | boolean | `true` | Enable recreation on orientation flips; applies on the next orientation check. |
| `focusPane` | boolean | `false` | Focus the viewer when creating it; next open or recreation. See the swap caveat below. |
| `stalledAfterSeconds` | number from 10 to 900 | `90` | Time without child progress before running task cards and linked running nodes are marked stalled; restart OMP to update the task source threshold. |
| `todoDependencies` | boolean | `true` | Process and persist explicit todo edges; applies to subsequent tool calls after settings reload. |
| `atlasIntegration` | boolean | `true` | Listen to the Atlas contract; reload disables or reactivates the consumer and adjusts mirror deduplication. |
| `followTheme` | boolean | `true` | Poll OMP theme changes on heartbeats; turning it off keeps the last sampled palette. |
| `colorTodo` | string (`#rrggbb`) | `#4f8cff` | Todo headers and borders; next snapshot publication after reload. |
| `colorPlan` | string (`#rrggbb`) | `#a371f7` | Plan headers and borders; next snapshot publication after reload. |
| `colorAtlas` | string (`#rrggbb`) | `#3fb950` | Atlas headers and borders; next snapshot publication after reload. |
| `retentionDays` | number from 1 to 365 | `14` | Age cutoff for plugin-owned session files; pruning runs at session startup. |
| `layoutAlign` | `centered` \| `left` | `centered` | DAG placement: a tree centered on the pane's axis, or compact against the left edge; next snapshot publication after reload. |
| `viewerRuntime` | string (executable path, or empty for discovery) | `""` | Bun executable; next viewer launch. |

## Placement and finish behavior

Initial orientation is portrait when `cols < 2 * rows`, landscape otherwise. The measured OMP rectangle adds the owned DAG pane's share back, so opening the viewer does not itself flip orientation. Hysteresis switches landscape to portrait below `2 * rows - 4`, and portrait to landscape above `2 * rows + 4`. Resize checks are debounced by 750 ms and also requested on heartbeats.

Herdr 0.9.3 cannot move a pane within the same tab. On an orientation flip the plugin closes only its recorded pane and opens a replacement in the configured position, resuming the persisted view state and socket connection. The replacement has a new pane ID. Placement and size changes alone do not recreate an open pane.

Right and bottom use a direct split; left and top use a split followed by a swap. Herdr focuses the swap source. With `focusPane: false`, the plugin restores normal OMP focus, but the CLI cannot restore an arbitrary unrelated pane that was focused before the swap.

- `close-with-omp`: close the pane on host shutdown. After three missed 2-second heartbeats, the viewer closes its own pane and exits.
- `keep-open`: leave the pane on shutdown or heartbeat loss, show a disconnected banner, and retry the socket every second. A recovery snapshot is never proof that OMP is still live.

Shutdown blocks further pane launches and resize timers immediately. Pane closure, socket cleanup, and snapshot flushing share one 1.8-second budget; unfinished socket startup remains cancelled and cleans up without accepting viewers or starting heartbeats.

On restart, an owned pane launched for a different socket (or an older record without a socket) is closed and recreated with the current viewer connection. A viewer closed with `q` remains dismissed across session rebinding; a missing pane does not prevent the transport from switching sessions.

Pressing `q` always closes the viewer's own pane, regardless of finish behavior. A crash between splitting and recording the new pane ID may leave an orphan pane. The plugin warns about it but never searches for or closes panes by title, so close the orphan manually.

## Viewer keys

| Key | Action |
| --- | --- |
| `q`, Ctrl+C | Quit and close the viewer's own pane. |
| `t` | Toggle DAG and Tasks; from transcript, switch to the other main view. |
| `h` | Toggle visibility of the retained previous todo generation; only one previous generation is kept. |
| `[` / `]` | Select previous / next run in the DAG view. |
| Tab | Switch the DAG's arrow keys between node mode (default, footer badge `NODES`) and pan mode (`PAN`). |
| Arrows, `j` / `k` | Node mode: select the nearest drawn node. Up / Down pick the box closest by centre in the row above or below; Left / Right pick the next box in the same row. The view follows the selection. Pan mode: move the view a few rows or columns; the selection stays. Tasks: move the selection. Transcript: scroll. |
| PgUp / PgDn | Page through nodes (half a screen in pan mode), tasks, or transcript. |
| Enter | Expand or collapse selected node or task details. |
| `c` | Toggle folding of completed layers for the selected run. |
| `p` | Toggle critical-path highlighting. |
| `e` | Show every direct dependency edge. By default, an edge whose order a longer path already shows is hidden; the footer still lists the selected node's direct dependencies. |
| `f` | Select the next running node and scroll to it; repeated presses cycle through all running nodes. Does nothing when no node is running. |
| `o` | Open the selected task's transcript, or a child transcript attached to the selected node. |
| Esc | Return from transcript or dismiss help. |
| `?` | Toggle help. |

The viewer turns terminal mouse reporting on while it runs and off again on every exit path, including signals. The wheel scrolls the DAG in either mode, the Tasks list, and transcripts; Shift+wheel or a horizontal wheel scrolls the DAG sideways. Clicking a node selects it, and double-clicking opens its transcript like `o`. Panning or scrolling detaches the DAG from the selection, so live updates keep the scrolled position until a node-mode arrow key, paging, or a click selects a node again. Switching runs or views starts at the top, following the selection. Every action is also available from the keyboard. The mode, the scroll position, and the edge toggle are not persisted. While mouse reporting is on, a plain drag no longer selects text in the pane; most terminals still select while Shift is held.

Transcript drill-down reads the existing child session file incrementally, showing assistant text, tool calls, and short result previews. It does not open a writable host session. User text and output have terminal control sequences stripped; labels use display-width-aware wrapping.

## omo-prometheus integration

Install [omo-prometheus](../omo-prometheus/README.md) to see Atlas runs. Both this plugin's `atlasIntegration` and the producer's `herdrDag` setting must be enabled; both default to `true`. Without an enabled producer, the viewer reports Atlas integration as unavailable, while native todos and Tasks remain usable.

The observational `pi.events` contract uses plain JSON with `v: 1` and a matching `sessionId`:

| Event | Direction and payload |
| --- | --- |
| `herdr-dag:hello` | Consumer to producer: session ID and request ID. |
| `atlas:hello` | Producer availability, echoed request ID when replying, and optional bound plan identity (`id`, `name`, `planFilePath`, `cwd`). |
| `atlas:snapshot` | Bound plan identity, ledger status and totals, rows with dependency/fix metadata, per-row child progress, last 50 timeline events, and timestamp. |
| `atlas:released` | Detached plan ID and reason: `exit`, `session-switch`, or `shutdown`. |

Hello replies are synchronous; a bound plan is followed by a snapshot. Binding and release also announce state, so startup order does not matter. Unknown versions and foreign sessions are ignored. Release means detached from this view, not finished work or cancelled children. When `herdrDag` is false, omo-prometheus emits nothing, including hello replies, without changing its ledger, todo mirror, ownership, or UI behavior. No Atlas bundle format changes are required.

## Local storage and privacy

Durable files live under `ctx.sessionManager.getSessionDir()/herdr-dag/<sessionId>/`. They are versioned JSON, written with temporary-file replacement. `snapshot.json` and `pane.json` use version 2 and upgrade version 1 on load without losing recovery data, ownership, or dismissal. A v1 pane record without a socket path keeps that connection unknown and relaunches only its recorded pane; it never adopts other panes. `view-state.json` stays at version 1. Unknown/newer versions are ignored and replaced. The stored field allowlist is:

| File | Stored fields |
| --- | --- |
| `snapshot.json` | `version`, session ID/name, generation, connection flag, timestamp, runs, task cards, theme palette, three source colors, Atlas availability, and the optional `layoutAlign` setting (absent in older snapshots, which render centered). |
| Run objects | ID, source, title, generation, nodes, edges, creation/update/finish timestamps, and done/total/elapsed/token/cost stats. |
| Node objects | ID, label, state, band/name, detail, start/finish timestamps, agent, linked task IDs, and stalled flag. Edges contain `from`, `to`, and `kind`. |
| Task cards | ID, parent task/node IDs, agent, status, optional stalled flag, description, current tool/arguments, recent output, completed/current activation totals, activation count, model, retry attempt/limit/error, transcript path, start/finish timestamps, detached flag, depth, and activity-availability flag. Activation totals contain tokens, cost, and duration. |
| Theme palette | Text, muted, dim, accent, success, error, warning, border, accented/muted border, and optional background colors. |
| `pane.json` | `version`, splitting/open phase, pane/tab IDs when known, host pane ID, orientation, position, launch timestamp, optional launching socket path, and dismissal flag. |
| `view-state.json` | `version`, folded run IDs, view (`dag`, `tasks`, `transcript`), selected run ID, and critical-path toggle. |

The host session also stores custom entries: `omp-herdr-dag:plan-execution` contains `v`, proposed/executing/idle state, optional plan path/run ID, and timestamp; `omp-herdr-dag:todo-edges` contains `v`, generation, and task/after dependency records. No credentials are collected, but snapshots can contain task descriptions, tool arguments, output fragments, error messages, and local paths. Treat them like session data.

Live transport uses a Unix socket under `os.tmpdir()/omp-herdr-dag/<hash>.sock`, keyed by the Herdr host pane and process ID, in a private directory. Snapshots provide restart recovery, not the live transport. Socket deltas are coalesced, with full resynchronization after a sequence mismatch or excessive backlog.

On session startup, `retentionDays` prunes other plugin-owned session directories whose newest directory/file modification time is older than the cutoff. It never prunes the current session, host transcripts, Atlas bundles, or custom entries in host sessions. Transcript contents are not copied into these files; the viewer reads their existing paths.

## Known limitations

- Herdr only; no standalone terminal pane management or Windows support.
- Grandchildren do not reach the root session's activity event bus. Registry-discovered descendants appear as status-only cards labeled `activity unavailable`, without live tools, output, or usage.
- Metrics and transcript availability depend on what the host supplies. Child lifecycle is activity evidence, not proof of final task acceptance.
- Dependency edges are display metadata, never a scheduler. Phase order is not a dependency.
- macOS follows the Linux code path but has not been verified here.

## License

MIT. An improved port of [jc01rho/omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag), inspected at revision `a093cdf5da96e28dfe50348965d9f3bafb1c9531`. The upstream copyright and permission notice are retained in [NOTICE](NOTICE); see [LICENSE](LICENSE) for this plugin's license.
