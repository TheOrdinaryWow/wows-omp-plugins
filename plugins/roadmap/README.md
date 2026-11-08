<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/roadmap-dark.png">
  <img alt="roadmap" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/roadmap-light.png">
</picture>

# roadmap

English | [简体中文](README.zh.md)

> A project roadmap that lives in your repository, so every session knows what the project is building, what is done and what comes next.

A single plan or todo list covers one piece of work. A roadmap covers the whole project across many sessions. This plugin keeps it in `docs/roadmap/` as Markdown: build rounds with a goal, the stages of each round with done criteria you can check, deferred TODOs, and the evidence that closed each stage. The agent sees the current status every turn, starts a stage with a handoff that tells it everything it needs, and closes the stage only with evidence for every criterion. Decisions behind the roadmap are kept as ADRs by the [adr plugin](../adr/README.md).

New to the plugin? The [guide](GUIDE.md) walks through a first project.

## Install

```bash
omp plugin install adr@wows-omp-plugins
omp plugin install roadmap@wows-omp-plugins
```

You need OMP 18.17.0 or newer, a Git repository (a local `git init` is enough; no remote needed) and the [adr plugin](../adr/README.md), which roadmap requires. Start a new session after installing. Without the adr plugin, `/roadmap` and `/init-project` refuse and tell you to install it.

## Quick start

1. Run `/init-project`. `docs/roadmap/` must not exist yet; `docs/adr/` may be missing, empty or already managed by the adr plugin.
2. Answer the agent's questions: what the project is; the first round's goal, constraints, non-goals and principles; decisions already made; and the stages, with their objectives, scope, done criteria and dependencies.
3. Review the preview and choose `Write N files`. Nothing is written before you confirm.
4. Ask the agent to start a stage. It gets a handoff with the round's goal and limits, the stage's objective, scope, criteria, TODOs and related decisions, what earlier stages delivered, and any plans already made for it. It plans the work from there.
5. When the work is done, the agent closes the stage with evidence for every criterion. Once every stage of the round is closed or dropped, run `/roadmap close-round`.

`/roadmap` opens the roadmap console at any time.

## Usage

### What a roadmap contains

| Record | What it is |
| --- | --- |
| Round (`R1`) | A build cycle with a goal, constraints, non-goals and principles that cite decisions. A round is `planned`, `active`, `closed` or `dropped`; only one is active at a time. |
| Stage (`S01`) | A piece of work with an objective, a scope and done criteria. It goes from `planned` to `active` to `closed`, or is `dropped`. A stage can only start after the stages it depends on are closed. |
| Done criterion (`DC1`) | What must be true when the stage is done, and how to check it. |
| TODO (`T001`) | Work set aside for later, with where it came from, a severity (`high`, `normal`, `low`) and either a target stage or a trigger ("when we add payments"). |
| ADR (`ADR-0001`) | A recorded decision, kept by the adr plugin. Rounds cite them in their principles, and stages can be linked to them. Decisions outlive rounds. |

The agent changes roadmap files only through the plugin, which keeps them consistent; it cannot edit them directly. You can still edit the text in your own editor. While a round is active, the agent sees a short roadmap status every turn, including which stage the session is working on.

### Work on a stage

Asking the agent to start a stage binds the session to it and gives the agent the handoff. If the stage is already active, the session joins it, with a warning that another session may be working on it. The roadmap status shows which stages can start now and which are still waiting for others.

In Plan Mode, starting a stage only gives the agent the handoff for planning; the stage itself starts once the plan is approved and implementation begins.

If the scope or the criteria of an active stage need to change, the agent records an amendment with a reason. Work found along the way goes into TODOs, and decisions into ADRs. Until you commit, the agent can still correct or remove its latest amendment.

Before a stage starts, you can ask the agent to move it to another active or planned round. Its ID and linked ADRs stay the same. The plugin refuses moves that put a stage before a dependency or predecessor, and moves any TODOs that would otherwise be left in the wrong round. Active stages cannot move, and closed or dropped rounds cannot send or receive stages.

A stage closes only when:

- every current criterion has passing evidence, with the method actually used and a summary;
- every open TODO aimed at the stage is resolved or moved elsewhere;
- no decision linked to the stage is still proposed. You accept or reject those first.

The plugin checks that the evidence is complete, not that it is true; the agent has to actually run the checks it reports. A closed stage never reopens. For follow-up work, add a new stage that follows it.

### Work that is not on the roadmap

Not everything needs a stage. When the agent notices that a request overlaps an unfinished stage, it asks you once per stage and session whether to do it as part of the roadmap, log it as free work on that stage, or treat it as unrelated. Free work is a one-line note on the stage and says nothing about its criteria.

### Close a round and start the next

`/roadmap close-round` needs every stage closed or dropped and no errors in the documents. It asks how the round's goal turned out (`achieved`, `partial`, `not_achieved` or `cancelled`, plus a summary) and what to do with each TODO still open: `resolved` with a reference, `wontfix` (listed under Known limitations), or `carried` to a later round. TODOs aimed at stages of a planned round move there by themselves. After closing, the round's files never change again.

`/roadmap new-round` then interviews you for the next round, or activates the next planned one, and can bring along TODOs carried from earlier rounds.

### Plan ahead

`/roadmap plan-round` drafts a future round, whether or not a round is active. `/roadmap plan-round R2` revises the charter of an active or planned round after you confirm the preview; it replaces the charter without adding a revision log or renaming the directory. Revising an active charter alone keeps format 1; adding a target date needs format 2. The agent can add stages to planned rounds, which become active in order. Their stages cannot start before that.

Rounds and stages can have a target date (`YYYY-MM-DD`). Status views show it next to the actual dates and flag unfinished work past its target. Targets never block anything.

`/roadmap drop-round R2 <reason>` drops a planned round you no longer need, together with its stages, and keeps the files as history. Move or resolve TODOs aimed at its stages first.

### Older repositories

Planned rounds, target dates and round outcomes need format 2, which `/init-project` creates. When you enter a session, the plugin automatically upgrades a format-1 repository if `docs/roadmap/` has no uncommitted changes. It changes and commits only `docs/roadmap/README.md`; unrelated staged changes stay staged. If the directory has changes, the plugin leaves it alone. If the commit fails, it restores the README and tells you how to upgrade manually.

You can run `/roadmap upgrade`, or accept the offer in the first `/roadmap plan-round` preview or round close. Closed history is never rewritten.

### Confirming document changes

Setting up the roadmap and every change to rounds (planning, opening, dropping, changing a target date) need a command from you and a preview you confirm. The plugin checks the files again after you confirm and refuses a preview that is out of date. Cancelling writes nothing.

### Commands

All commands run in the main session and complete subcommands, stage IDs and round IDs.

| Command | What it does |
| --- | --- |
| `/init-project` | Check the requirements and start the setup interview. |
| `/roadmap` | Open the roadmap console. |
| `/roadmap stage <id>` | Show a stage and its handoff without starting it. |
| `/roadmap check [--fix]` | Check that the documents are consistent; `--fix` rebuilds the generated tables. |
| `/roadmap upgrade` | Upgrade a repository to format 2. |
| `/roadmap plan-round [id]` | Draft a planned round, or revise an active or planned round's charter. |
| `/roadmap new-round` | Activate the next planned round, or create one when none is planned. |
| `/roadmap drop-round <id> <reason>` | Drop a planned round and its stages. |
| `/roadmap retarget <round-or-stage> <YYYY-MM-DD\|none>` | Set or clear a target date. |
| `/roadmap close-round [outcome=<assessment>:<summary>] [<todo>=<disposition>[:<reference>] …]` | Close the active round. The arguments answer its questions in advance, for example `outcome=partial:"checkout shipped, refunds moved" T001=resolved:abc1234 T002=wontfix:"out of scope" T003=carried`. |
| `/roadmap overlap <stage> roadmap\|free\|unrelated [intent]` | Answer the "is this part of the roadmap?" question by command. |
| `/roadmap confirm <token>` | Confirm a preview when no dialog was available. |

### The `/roadmap` console

`/roadmap` fills the terminal. Tab switches between stages, rounds and open TODOs, and typing searches the list. The right side shows the selected item in full: status, dates, dependencies, linked decisions, open TODOs and its text. With omo-prometheus installed, it also shows which plans cover each done criterion. Enter jumps to a related item: from a stage to its round, from a round to its stages, from a TODO to its stage.

| Key | Action |
| --- | --- |
| Shift+X | Close the selected active stage (the agent does it). |
| Shift+R | Close the active round. |
| Shift+N | Open a new round, or activate the next planned one. |
| Shift+P | Plan a new round. |
| Shift+E | Revise the selected active or planned round's charter. |
| Shift+D | Drop the selected planned round. |
| Shift+T | Change the target date of the selected round or stage. |
| Shift+U | Upgrade a format-1 repository. |
| Shift+C | Run the check. |
| Shift+O | Switch between dependency order and ID order for this session. |
| Esc | Clear the search, then close the console. |

Checks, round closes, drops, target dates and upgrades happen right in the console, which comes back on the same item with a one-line result. Closing a stage and opening or planning a round need the agent, so the console closes and you continue in the chat.

For changes you make through the console, a preview lists the files on the left and shows the selected one on the right. Space switches between formatted and raw text, Shift+W writes every file, and Esc writes nothing. In [Tern](https://docs.stencil.so/tern/), the console and the previews open as native sheets with buttons for the same actions.

### What the agent does

The agent reads and changes the roadmap through the `roadmap_*` tools: reading status, adding and changing stages, starting and closing them, managing TODOs, checking the documents, and asking you about overlapping work. Setting up the roadmap and changing rounds only happen after you run the matching command and confirm its preview. Subagents can use the tools too, but never ask you anything. Decisions go through the adr plugin's tools.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-roadmap uiMenu inline
omp plugin config set wows-omp-plugin-roadmap stageOrder id
omp plugin config list wows-omp-plugin-roadmap
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-roadmap": { "stageOrder": "id" } } }
```

Changes apply the next time you use `/roadmap` or the agent reads the roadmap.

| Setting | Default | What it changes |
| --- | --- | --- |
| `uiMenu` | `fullscreen` | `fullscreen` opens the console and previews described above. `inline` uses small select menus instead. Only affects the terminal; an unknown value counts as `fullscreen`. |
| `stageOrder` | `dependency` | `dependency` lists stages in the order they will run: a stage comes after the stages it depends on, so one added later in between shows up where it belongs. `id` lists them by number. This affects the console, command completion and the status the agent sees. The tables written into the roadmap files always stay in ID order. |

## Working with other plugins

- **adr** is required. It keeps the decisions that rounds cite and stages link to.
- **omo-prometheus**: a plan made while the session is on a stage belongs to that stage. A stage can be delivered by several plans, each claiming the done criteria it covers with a `Roadmap criteria: DC1, DC3` line, which Prometheus checks before you approve. The stage handoff and the console show each plan's progress, which criteria are covered, and a notice when the stage changed after a plan was approved. When a plan finishes, the agent is reminded to consider closing the stage and gets the plan's final review results as evidence. Problems the plan found outside its scope can be filed as roadmap TODOs. The stage never closes by itself.

## Known limitations

- Setup needs a fresh `docs/roadmap/`. An existing roadmap, or a `docs/adr/` with files the adr plugin does not manage, cannot be taken over.
- Planned rounds cannot be skipped or renumbered, and IDs of dropped rounds are not reused.
- The agent asks about overlapping work only when it notices the overlap.
- The protection against direct edits is best effort, especially for shell commands. It is not a sandbox.
- Joining an active stage warns about other sessions but does not reserve the stage.
- `/roadmap check` checks the documents, not whether the code matches them.
- A change that touches several files is not all-or-nothing, and IDs shown in a declined preview may be skipped afterwards.
- Separate clones of a repository number independently, so their IDs can collide. Worktrees of the same clone share the numbering.
- In Tern, the console and previews keep one size and scroll their panes inside, so text in the scrolling panes cannot be selected or copied there.

## More details

[REFERENCE.md](REFERENCE.md) covers every tool action, which Markdown the tools accept, edit protection, recovery and worktrees, how TODOs are carried over, how the plugin behaves in RPC, ACP editors and headless runs, the state snapshot, the interface with omo-prometheus, and the directory format.

## License

MIT.
