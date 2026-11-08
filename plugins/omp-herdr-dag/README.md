<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omp-herdr-dag-dark.png">
  <img alt="omp-herdr-dag" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omp-herdr-dag-light.png">
</picture>

# omp-herdr-dag

English | [简体中文](README.zh.md)

> Watch what OMP is doing as a live graph in a Herdr side pane: todos, plans and every subagent at work.

When the agent works through a long todo list, carries out an approved plan or runs many subagents at once, the conversation alone makes it hard to see what is happening. If you run OMP inside the Herdr terminal multiplexer, this plugin opens a pane next to it with a live dependency graph: what is done, what is running, what is waiting on what, and for each subagent its current tool, recent output, model and cost. It also shows `omo-prometheus` Atlas plans. The pane only watches; it never starts work, completes todos or changes a plan.

## Install

```bash
omp plugin install omp-herdr-dag@wows-omp-plugins
```

You need:

- OMP 18.17.0 or newer, started interactively inside a Herdr pane;
- the `herdr` command on your `PATH`;
- Bun, either `bun` on your `PATH` or set in `viewerRuntime`.

Linux is supported. macOS uses the same code but has not been tested. Windows is not supported. Restart OMP after installing.

## Quick start

With the default settings, the pane opens by itself when an approved plan starts running. To open or close it at any time:

```text
/dag-pane          # toggle
/dag-pane open
/dag-pane close
```

In the pane, use the arrow keys to move between nodes, Enter to expand one, `t` to switch to the Tasks view, `o` to read a subagent's transcript, and `?` for help.

## Usage

### When the pane opens

`displayTiming` decides when the pane opens by itself:

| Value | Opens for |
| --- | --- |
| `never` | Nothing; use `/dag-pane`. |
| `any-todo` | Any todo list, an approved plan or an Atlas plan. |
| `plan-execution` (default) | A plan you approved in Plan Mode, or an Atlas plan. |
| `atlas-only` | An Atlas plan only. |

Subagents alone do not open the pane. Once you close it with `q` or `/dag-pane close`, it stays closed for that run; a new run or `/dag-pane open` brings it back. `/new` and switching sessions reuse the same pane.

### Reading the graph

Each run's tab, title badge and progress bar take the color of its source, and the legend at the top of the pane repeats these colors:

| Source | Color | What it shows |
| --- | --- | --- |
| Todo list | Blue `#4f8cff` | Todo phases form bands. Dashed lines between phases mean order, not dependency. |
| Plan execution | Purple `#a371f7` | The first todo list after you approve a plan in Plan Mode. |
| Atlas | Green `#3fb950` | An `omo-prometheus` plan: tasks, discovered work, fixes, final reviews and delivery, with their real dependencies. |

Each node's icon, title and border use your OMP theme colors to show its state, so you can tell at a glance what is running, finished or stuck:

| Icon | State | Theme color |
| --- | --- | --- |
| `○` | Pending | muted |
| `◐` | Running | accent |
| `◐` | Stalled | warning |
| `✔` | Done | success |
| `✖` | Failed | error |
| `⊘` | Blocked | warning |
| `⊖` | Abandoned | dim |

The selected node has a double border. Solid lines are dependencies; the selected node's lines are drawn bold in its run's color. Dotted lines are fixes and dependencies that point backwards (marked `↑ after <label>`). To keep the graph readable, a line is hidden when a longer path already implies the same order; press `e` to draw them all. The footer always lists what the selected node depends on directly.

Press `p` to highlight the critical path, the longest chain of dependencies by time taken: its nodes get heavy borders and its lines are drawn heavy. Press `c` to fold layers that are done.

A running node whose subagent has shown no progress for `stalledAfterSeconds` is marked `stalled`. A failed subagent does not mark its todo or plan task as failed.

Subagent cards in the Tasks view use the same colors: running, stalled, completed, failed or aborted.

### Following running work

The pane follows running work on its own: it keeps the node or task it is following in view until that work finishes, then moves to the next running node or to a running subagent that belongs to no node. If needed, it switches runs or switches between the graph and Tasks. It only scrolls the node into view, so your selection and the footer details stay where you left them. When several things start at once, or a subagent prints more output, the pane doesn't jump between them.

Scrolling, selecting, switching runs or views, folding layers, expanding details or opening a transcript all stop following, so updates don't pull the view away from what you're reading. Press `f` to turn it back on, and the pane shows the current running work right away. The footer shows `f follow ON` or `f follow OFF`. Following is off while the pane is disconnected from OMP. It turns on each time the pane opens and is never saved with your folds or other view settings.

### Tasks and transcripts

The Tasks view (`t`) lists every subagent the main session started, with its current tool and arguments, recent output, model, retries, time, tokens and cost where OMP reports them. A subagent is attached to the todo that was in progress when it started. Missing numbers are shown as missing, never as zero.

Press `o` on a task, or on a node with a subagent attached, to read its transcript: its messages, tool calls and short previews of the results.

### Viewer keys

| Key | Action |
| --- | --- |
| `q`, Ctrl+C | Quit and close the pane. |
| `t` | Switch between the graph and Tasks; from a transcript, switch to the other main view. |
| `h` | Show or hide the previous todo list (only one is kept). |
| `[` / `]` | Previous / next run. |
| Tab | Switch the arrow keys between selecting nodes (`NODES`) and moving the view (`PAN`). |
| Arrows, `j` / `k` | Select the nearest node, move the view, move through tasks, or scroll a transcript. |
| PgUp / PgDn | Page through nodes, tasks or a transcript. |
| Enter | Expand or collapse the selected node or task. |
| `c` | Fold completed layers. |
| `p` | Highlight the critical path. |
| `e` | Draw every dependency line. |
| `f` | Turn following running work on or off. |
| `r` | Select the next running node. |
| `o` | Open the selected subagent's transcript. |
| Esc | Leave a transcript or close help. |
| `?` | Help. |

The mouse works too: the wheel scrolls, Shift+wheel scrolls sideways, a click selects a node and a double-click opens its transcript. While the viewer runs, dragging no longer selects text; in most terminals, hold Shift to select.

### Real dependencies between todos

By default, the graph only knows the order of todo phases. The agent can also say which todo has to wait for which, and the graph then draws those dependencies. You can ask for it ("mark the dependencies between the todos") or leave it to the agent. Dependencies are never guessed from the wording. A dependency on a task that does not exist, on itself or in a circle is dropped with a `Herdr DAG edges:` warning, and the todo change goes through anyway. Turn this off with `todoDependencies: false`.

### Where the pane goes

The pane goes to the right of OMP in a wide window and below it in a tall one. When the window changes shape, the plugin moves the pane. You can set the position and size for each shape.

When OMP exits, the pane closes too. With `finishBehavior: keep-open`, it stays open, shows that it is disconnected and keeps trying to reconnect.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-omp-herdr-dag displayTiming any-todo
omp plugin config set wows-omp-plugin-omp-herdr-dag landscapeSize 0.3
omp plugin config list wows-omp-plugin-omp-herdr-dag
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-omp-herdr-dag": { "displayTiming": "atlas-only" } } }
```

Settings are read at startup, on a session switch and with each `/dag-pane` command. Position, size and color changes take effect the next time the pane opens or the graph updates. An invalid value falls back to its default with a warning.

| Setting | Default | What it changes |
| --- | --- | --- |
| `displayTiming` | `plan-execution` | When the pane opens by itself: `never`, `any-todo`, `plan-execution` or `atlas-only` (see above). |
| `finishBehavior` | `close-with-omp` | `close-with-omp` closes the pane when OMP exits; `keep-open` leaves it open and reconnecting. |
| `landscapePosition` | `right` | Where the pane goes in a wide window: `left`, `right`, `top` or `bottom`. |
| `portraitPosition` | `bottom` | Where the pane goes in a tall window: `left`, `right`, `top` or `bottom`. |
| `landscapeSize` | `0.35` | How much of a wide window the pane takes, from 0.15 to 0.6. |
| `portraitSize` | `0.4` | How much of a tall window the pane takes, from 0.15 to 0.6. |
| `followOrientation` | `true` | Move the pane when the window changes from wide to tall or back. |
| `focusPane` | `false` | Put the keyboard focus on the pane when it opens. |
| `stalledAfterSeconds` | `90` | Seconds without subagent progress before a task is marked stalled, from 10 to 900. |
| `todoDependencies` | `true` | Let the agent declare dependencies between todos. Todos work the same either way. |
| `atlasIntegration` | `true` | Show `omo-prometheus` Atlas plans. |
| `followTheme` | `true` | Follow changes to your OMP theme. |
| `colorTodo` | `#4f8cff` | Color of todo runs in tabs, the run badge and the legend (`#rrggbb`). |
| `colorPlan` | `#a371f7` | Color of plan runs in tabs, the run badge and the legend (`#rrggbb`). |
| `colorAtlas` | `#3fb950` | Color of Atlas runs in tabs, the run badge and the legend (`#rrggbb`). |
| `retentionDays` | `14` | When a session starts, delete this plugin's files for sessions older than this many days, from 1 to 365. |
| `layoutAlign` | `centered` | `centered` centers the graph in the pane; `left` packs it against the left edge. |
| `viewerRuntime` | empty | The Bun executable for the viewer. Empty means find `bun` on your `PATH`. |

## Working with other plugins

**omo-prometheus**: its Atlas plans appear as green runs when both this plugin's `atlasIntegration` and Prometheus's `herdrDag` setting are on (the default). Bands are ordered Tasks, Discovered, Fixes, Final gates, Delivery, and tasks show their LIGHT or HEAVY tier and whether they have been verified. While an Atlas plan is shown, the matching todo phases (`Atlas tasks`, `Atlas discovered`, `Atlas fixes`, `Atlas final gates`, `Atlas delivery`) are left out of the blue todo view so the same work does not appear twice.

## Known limitations

- Works only in Herdr, and not on Windows.
- Subagents started by other subagents appear only as status cards marked `activity unavailable`, without their tools, output or usage.
- After upgrading the plugin, the pane cannot open again until you restart OMP. The plugin tells you so; a pane that is already open keeps working.
- Numbers and transcripts depend on what OMP reports.
- If OMP crashes right after creating the pane, a leftover pane may stay open. The plugin warns about it but never closes panes it did not create; close it yourself.
- The plugin's local files can contain task descriptions, tool arguments, bits of output, error messages and local paths. Treat them like session data.

## More details

[REFERENCE.md](REFERENCE.md) covers when the pane can run (including RPC, ACP and headless sessions), how a plan execution is recognized, graph layout and placement rules, the format of todo dependencies, the interface with omo-prometheus, and the local files.

## License

MIT. An improved port of [jc01rho/omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag), inspected at revision `2963f8fb0c1ab6c475de206d08a6b67c29ae1227`. The upstream copyright and permission notice are kept in [NOTICE](NOTICE); see [LICENSE](LICENSE) for this plugin's license.
