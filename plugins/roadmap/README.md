# roadmap

English | [简体中文](README.zh.md)

> The planning layer above your plans and tasks: rounds, stages and decisions that stay in your repository across sessions.

Keeps a project roadmap in your repository as Markdown, maintained by the agent through dedicated tools. It records build rounds, the stages in each round with verifiable done criteria, deferred TODOs and architecture decisions in MADR format, plus the evidence that closed each stage. Implementation plans stay out of it.

## Install

```bash
omp plugin install roadmap@wows-omp-plugins
```

Requires OMP 18.3.5 or newer and a git work tree. Start a new session after installing. The plugin ships the `roadmap` skill and a pinned MADR 4.0 template.

## Quick start

1. Run `/init-project` in the main session. `docs/roadmap/` must not exist yet, and `docs/adr/` must be absent or empty.
2. Answer the agent's interview: project description; the first round's goal, constraints, non-goals and principles; decisions already made; and the stages with objectives, scope, done criteria and dependencies.
3. Review the preview and pick `Write N files`. Nothing is written before you confirm.
4. Ask the agent to start a stage. It gets a handoff with the stage's objective, scope, criteria, TODOs and relevant ADRs, and plans the work from there.
5. When the work is done, the agent closes the stage with evidence for every criterion. Once every stage in the round is closed or dropped, run `/roadmap close-round`.

`/roadmap` opens a status menu at any time.

## Usage

### Concepts

| Record | Purpose |
| --- | --- |
| Round (`R1`) | A build cycle with a goal, constraints, non-goals and principles citing ADRs. Rounds are `planned`, `active`, `closed` or `dropped`; at most one is active. |
| Stage (`S01`) | An objective, scope and verifiable done criteria. Stages go from `planned` to `active` to `closed`, or are `dropped`. Dependencies must be closed before a stage starts. |
| Done criterion (`DC1`) | What must pass and how to verify it. |
| TODO (`T001`) | Deferred work with a source, a severity (`high`, `normal`, `low`) and either a target stage or a trigger. |
| ADR (`ADR-0001`) | A decision in MADR format. ADRs outlive rounds. |

Everything lives under `docs/roadmap/` and `docs/adr/`. The agent changes these files only through the roadmap tools, and a hook blocks ordinary edits to them. You can still edit body text in your own editor.

While a round is active, the agent sees a short roadmap status in every turn, including which stage the session is bound to.

### Working on a stage

Starting a stage binds the session to it and returns the handoff. Starting a stage that is already active joins it instead, with a warning that another session may be working on it.

Scope or criterion changes on an active stage are recorded with `amend` and a reason. Later work goes into TODOs and decisions into ADRs.

A stage closes only from `active`, and only when:

- every current criterion has evidence with `result: "pass"`, the method actually used and a summary;
- every open TODO targeting the stage is resolved with a reference or moved to another target;
- every proposed ADR tied to the stage is accepted or rejected (the main session decides this, not subagents).

The plugin checks that the evidence is complete, not that it is true; the agent has to run the checks it reports. A closed stage never reopens. For corrective work, add a new stage that `follows` it.

### Free work and overlap

Work outside the roadmap does not need a stage. When the agent notices that a request overlaps an unclosed stage, it asks once per stage and session whether to use the roadmap, log the request as free work, or treat it as unrelated. Logging adds one line to the stage's Free-work log and claims nothing about its criteria.

### Closing a round

`/roadmap close-round` needs every stage closed or dropped and no document errors. It asks you how to dispose of each remaining open TODO: `resolved` with a reference, `wontfix` (recorded under Known limitations) or `carried` to a later round. Open TODOs targeting stages of a planned round move there automatically with the same ID. Closing freezes the round's directory in place.

`/roadmap new-round` then interviews you for the next round's charter, or activates the next planned round. It can import carried TODOs from earlier rounds.

### Planning future rounds

`/roadmap plan-round` drafts a future round, with or without an active round; `/roadmap plan-round R2` revises one. Add its stages with `roadmap_stage` (`action: "add"`, `round: "R2"`). They cannot start until their round is active, and planned rounds activate in order.

Rounds and stages can carry an optional `target` date (`YYYY-MM-DD`). Status views show it next to the actual dates and flag unfinished work past its target. Targets never block anything.

Planned rounds and target dates need repository format 2. `/roadmap upgrade`, or the first `/roadmap plan-round` preview, offers the upgrade. After it, **roadmap 0.2.3 and earlier can no longer read the repository**. The upgrade changes only the root marker; existing files keep format 1 until a write needs a format-2 field, and closed history is never rewritten. Repositories that never use these features stay at format 1 byte for byte.

`/roadmap drop-round R2 <reason>` drops an unneeded planned round and its stages, keeping the files as history. Move or resolve TODOs targeting its stages first.

### Confirmation

Initialization and every round-level change (planning, opening, upgrading, dropping, retargeting) need an explicit command from you and a confirmed preview. The plugin rechecks the files after you confirm and refuses a stale preview. Cancelling writes nothing.

### Commands

All commands run in the main session and complete subcommands, stage IDs and round IDs.

| Command | Behavior |
| --- | --- |
| `/init-project` | Check prerequisites and start the initialization interview. |
| `/roadmap` | Status menu: active and planned rounds, dates, stages, TODO counts and available actions. |
| `/roadmap stage <id>` | Show a stage and its handoff without starting it. |
| `/roadmap check [--fix]` | Check document consistency; `--fix` regenerates generated blocks. |
| `/roadmap upgrade` | Adopt repository format 2. |
| `/roadmap plan-round [id]` | Draft a planned round, or revise one. |
| `/roadmap new-round` | Activate the next planned round, or create a new one when none is planned. |
| `/roadmap drop-round <id> <reason>` | Drop a planned round and its stages. |
| `/roadmap retarget <round-or-stage> <YYYY-MM-DD\|none>` | Set or clear a target date (format 2). |
| `/roadmap close-round [<todo>=<disposition>[:<reference>] …]` | Close the active round; arguments answer the disposition dialog, e.g. `T001=resolved:abc1234 T002=wontfix:"out of scope" T003=carried`. |
| `/roadmap overlap <stage> roadmap\|free\|unrelated [intent]` | Answer the overlap question for this session. |
| `/roadmap confirm <token>` | Confirm a held preview when no dialog was available. |

### Agent tools

| Tool | Purpose |
| --- | --- |
| `roadmap_status` | Rounds, stages and open TODOs; with `stage`, its full detail and handoff. |
| `roadmap_stage` | `add`, `edit`, `amend`, `start`, `close`, `drop`, `renumber`. |
| `roadmap_todo` | `add`, `update`, `resolve`, `move`. |
| `roadmap_adr` | `create`, `revise`, `set_status`, `supersede`, `note`. |
| `roadmap_check` | Document consistency check; `fix: true` regenerates generated blocks. |
| `roadmap_overlap` | Ask the overlap question. |
| `roadmap_init`, `roadmap_round_plan`, `roadmap_round_open` | Write the previews prepared by `/init-project`, `/roadmap plan-round` and `/roadmap new-round`. |

Subagents can use the tools too, but cannot accept, reject or supersede ADRs and are never prompted.

## Settings

The plugin has no settings.

## Working with other plugins

With `omo-prometheus`, a plan proposed while a stage is bound remembers that stage. During execution Atlas may use the roadmap tools, and when the plan completes the session is reminded to close the stage, mapping the final gate results to the stage's criteria. The stage never closes automatically. `roadmap_status` with the stage ID shows whether it is active; the Atlas bundle's `approval.json` shows whether a plan recorded a stage.

## Without the terminal UI

| Host | Behavior |
| --- | --- |
| RPC (`--mode rpc`, `rpc-ui`) and ACP | The same dialogs, sent as `select`, `input` and `editor` requests. ACP clients may show notices only in their log. |
| No UI (`--no-ui`, print, JSON, SDK) | No dialogs. Bare `/roadmap` prints status and usage. Previews return a token without writing anything; confirm with `/roadmap confirm <token>`. Answer overlaps with `/roadmap overlap` and round closing with `/roadmap close-round` arguments. |

Client programs can read the roadmap status from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- Initialization needs fresh `docs/roadmap/` and `docs/adr/` directories; existing roadmap or ADR trees cannot be adopted.
- Planned rounds cannot be skipped or renumbered, and dropped round IDs are not reused.
- Overlap detection depends on the agent noticing the overlap.
- The edit protection is best effort, especially for `bash`, and is not a sandbox.
- Joining an active stage warns about other sessions but does not reserve the stage.
- `check` verifies the documents, not whether the code matches them.
- A multi-file write is not all-or-nothing, and previewed IDs can be used up by a declined preview, leaving gaps.
- Separate clones do not share numbering, so their IDs can collide; worktrees of one clone do share it.
- Without a UI, a held preview lives only in memory and is lost when the process exits.

## Reference

[REFERENCE.md](REFERENCE.md) covers every tool action, the allowed Markdown in tool-written text, edit protection, recovery and worktrees, carry-over rules, the state snapshot, the Prometheus contract and the directory format.

## License

MIT. The vendored MADR template keeps its own licenses in `assets/madr/`.
