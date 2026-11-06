<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/adr-dark.png">
  <img alt="adr" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/adr-light.png">
</picture>

# adr

English | [简体中文](README.zh.md)

> Keep a written record of your architecture decisions in the repository, and let the agent help you write it without rewriting history.

An architecture decision record (ADR) is a short document explaining one design decision: the problem, the options you considered and what you chose. This plugin keeps them in `docs/adr/` as Markdown in the [MADR 4.0](https://github.com/adr/madr) format. The agent interviews you, drafts the record and saves it as proposed; you decide whether it is accepted. Accepted decisions are never rewritten. They can only be deprecated, replaced by a newer decision or extended with a dated note, so the record shows how your thinking changed. Every turn, the agent also gets a short summary of the decisions still open.

## Install

```bash
omp plugin install adr@wows-omp-plugins
```

You need OMP 18.17.0 or newer and a Git repository (a local `git init` is enough; no remote needed). Outside a Git repository the commands refuse to run. Start a new session after installing.

## Quick start

1. Run `/adr init`. `docs/adr/` must not exist or must be empty. Review the preview and choose `Write 1 file` (Shift+W in the fullscreen preview).
2. Run `/adr new`, optionally with a topic: `/adr new database choice`. The agent asks about the context, the options and the outcome, shows you the draft and saves it as a proposed ADR.
3. Run `/adr`, select the ADR, press Enter and choose `Accept`, `Reject` or `Deprecate`.

If your ADRs were written by the roadmap plugin 0.4.0 or earlier, skip `/adr init`; see [ADRs from the roadmap plugin](#adrs-from-the-roadmap-plugin).

## Usage

### What an ADR records

| Field | Meaning |
| --- | --- |
| ID (`ADR-0001`) | Counts up and is never reused. The file is `docs/adr/0001-slug.md`. |
| Status | `proposed`, `accepted`, `rejected`, `deprecated` or `superseded`. |
| Supersedes / superseded by | Links between a decision and the one that replaced it. |
| Stage | Optional link to a stage of your roadmap; needs the roadmap plugin. |
| Decision-makers, consulted, informed | Optional lists of the people involved. |

`docs/adr/README.md` marks the folder as managed and holds a table of all decisions, kept up to date for you.

### How a decision changes over time

- New decisions start as `proposed`. The agent only records a decision as accepted when you explicitly agree.
- While a decision is proposed, it can be rewritten as a whole.
- An accepted decision is never rewritten. It can be deprecated, superseded by a new accepted decision, or given a dated note under More Information.
- Only you, or the main agent acting for you, can accept, reject, deprecate or supersede a decision, and change its stage link. Subagents can draft proposed decisions, revise them and add notes.
- Notes can be edited or deleted until you commit them. After that they stay as written; add a new note instead.

The agent cannot edit files in `docs/adr/` directly. It has to go through the plugin, which enforces these rules. You can still edit the text in your own editor.

### Commands

All commands run in the main session and complete subcommands and ADR IDs.

| Command | What it does |
| --- | --- |
| `/adr` | Open the ADR console (see below). |
| `/adr list [status]` | List ADRs, optionally only one status. |
| `/adr show <id>` | Show one ADR and the decisions it replaced or was replaced by. |
| `/adr accept\|reject\|deprecate <id>` | Record your decision. |
| `/adr note <id> <text>` | Add a dated note under More Information. |
| `/adr new [topic]` | Have the agent interview you for a new decision. |
| `/adr supersede <id> [topic]` | Have the agent interview you for a decision that replaces an accepted or deprecated one. |
| `/adr check [--fix]` | Check that the records are consistent; `--fix` rebuilds the decision table. |
| `/adr init` | Set up `docs/adr/` after you confirm a preview. |
| `/adr confirm <token>` | Confirm an `/adr init` preview when no dialog was available. |

### The `/adr` console

`/adr` fills the terminal: ADRs on the left with a status mark, the selected one in full on the right.

| Key | Action |
| --- | --- |
| Up, Down, Home, End | Select an ADR. |
| PgUp, PgDn, mouse wheel | Scroll the decision text. The wheel over the list moves the selection. |
| Tab, Shift+Tab | Switch between All and each status, with counts. |
| Lowercase letters, digits | Search IDs, titles and statuses. Backspace edits the search. |
| Enter | Choose what to do with the selected ADR. |
| Shift+A, R, D | Accept, reject or deprecate the selected ADR, when its status allows it. |
| Shift+N, S | Add a note, or supersede an accepted or deprecated ADR. |
| Shift+O | Start a new decision. |
| Shift+C | Run the check. |
| Shift+F | Run the check and rebuild the decision table. |
| Esc | Clear the search, then close. |

After accepting, rejecting, deprecating, adding a note or running the check, the console stays open on the same ADR and shows the result above the key hints; the full result also goes into the conversation. Starting a new decision or a supersession closes the console, because the agent interviews you next.

The `/adr init` preview looks the same, with the files on the left. Shift+W writes them, Esc declines.

In [Tern](https://docs.stencil.so/tern/), the console and the preview open as native sheets with buttons for the same actions, and the agent's ADR tool calls show as readable cards.

### What the agent does

The agent reads and changes ADRs through three tools: `adr_status` to list and read them, `adr_manage` to create, revise, change status, supersede, add notes and link stages, and `adr_check` to check them. You do not call these yourself. In a repository where `/adr init` has not been run, they refuse and the agent asks you to run it.

### ADRs from the roadmap plugin

ADRs written by the roadmap plugin 0.4.0 or earlier are read as they are, so the repository already counts as set up. Whenever the plugin changes a file, it rewrites only that file in the new format; the first change also converts the decision table and keeps any text you wrote in it. Files nobody touches stay exactly as they are, and new IDs continue after the roadmap plugin's numbering.

The conversion is one-way: the roadmap plugin 0.4.0 and earlier cannot read converted files. If other clones of the repository still run one of those versions, upgrade the roadmap plugin there and install this plugin before the first change.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-adr uiMenu inline
omp plugin config list wows-omp-plugin-adr
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-adr": { "uiMenu": "inline" } } }
```

Changes apply the next time you run an `/adr` command.

| Setting | Default | What it changes |
| --- | --- | --- |
| `uiMenu` | `fullscreen` | `fullscreen` opens the console and the fullscreen preview described above. `inline` uses small dialogs instead: pick a status, then an ADR, then an action. Only affects the terminal; an unknown value counts as `fullscreen`. |

## Working with other plugins

- **roadmap** needs this plugin. It reads your ADRs and links them to roadmap stages, and its `/init-project` sets up `docs/adr/` when the folder does not exist or is empty. Linking an ADR to a stage needs roadmap to be installed and the stage to exist; removing a link does not.
- **omo-prometheus** lets the agent keep using the ADR tools while it carries out an approved plan.

## Known limitations

- `/adr init` cannot take over a `docs/adr/` folder that already has files and is not managed by this plugin.
- The protection against direct edits is best effort, especially for shell commands. It is not a sandbox.
- `/adr check` checks the records, not whether the code follows the decisions.
- A change that touches several files is not all-or-nothing. If one is interrupted, `/adr check --fix` repairs the decision table.
- Separate clones of a repository number ADRs independently, so their IDs can collide. Worktrees of the same clone share the numbering.

## More details

[REFERENCE.md](REFERENCE.md) covers the tool inputs, the file formats including the roadmap plugin's older files, which Markdown the tools accept, how edit protection works, recovery and worktrees, how `/adr` behaves in RPC, ACP editors and headless runs, the state snapshot, and the interface other plugins use.

## License

MIT. The bundled MADR template keeps its own licenses in `assets/madr/`.
