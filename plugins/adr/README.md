# adr

English | [简体中文](README.zh.md)

> Architecture decisions that stay in your repository, written and changed by the agent only through dedicated tools.

Keeps architecture decision records (ADRs) in `docs/adr/` as Markdown in the [MADR 4.0](https://github.com/adr/madr) format. The agent drafts decisions from an interview with you, records them as proposed, and changes them only through status transitions, supersession and dated notes. You accept, reject or deprecate decisions from a menu. A short summary of open decisions reaches the agent in every turn.

## Install

```bash
omp plugin install adr@wows-omp-plugins
```

Requires OMP 18.5.1 or newer and a git work tree. Start a new session after installing. The plugin ships the `adr` skill and a pinned MADR 4.0 template.

## Quick start

1. Run `/adr init` in the main session. `docs/adr/` must be absent or empty. Review the preview and pick `Write 1 file`.
2. Run `/adr new` (optionally with a topic, such as `/adr new database choice`). The agent interviews you about the context, options and outcome, shows you the draft and records it as a proposed ADR.
3. Run `/adr`, pick the ADR and choose `Accept`, `Reject` or `Deprecate`.

Repositories whose ADRs were written by the roadmap plugin 0.4.0 or earlier need no initialization; see [Existing roadmap ADRs](#existing-roadmap-adrs).

## Usage

### Records

| Field | Meaning |
| --- | --- |
| ID (`ADR-0001`) | Monotonic, never reused. The file is `docs/adr/0001-slug.md`. |
| Status | `proposed`, `accepted`, `rejected`, `deprecated` or `superseded`. |
| Supersedes / superseded by | Reciprocal links between a decision and its replacement. |
| Stage | Optional link to a roadmap stage; needs the roadmap plugin. |
| Decision-makers, consulted, informed | Optional participant lists. |

`docs/adr/README.md` is the initialization marker and holds a generated table of every decision. A hook blocks ordinary agent edits to `docs/adr/`; you can still edit body text in your own editor.

### Lifecycle

- New decisions start as `proposed`; the agent creates an accepted one only when you explicitly agree.
- A proposed ADR can be revised as a whole. An accepted one is never rewritten: it is deprecated, superseded by a new accepted ADR, or extended with a dated note under More Information.
- Only the main session (you, or the main agent acting for you) accepts, rejects, deprecates or supersedes. Subagents can create proposed ADRs, revise them and add notes.
- Only the main session can set, change or clear an existing ADR's stage link, at any status (including superseded). This changes metadata, not the decision body or status.

### Commands

All commands run in the main session and complete subcommands and ADR IDs.

| Command | Behavior |
| --- | --- |
| `/adr` | Menu: filter by status, open an ADR, view it, accept, reject or deprecate it, append a note, supersede it, start a new decision or run the check. |
| `/adr list [status]` | List ADRs, optionally with one status. |
| `/adr show <id>` | Show one ADR with its supersession chain. |
| `/adr accept\|reject\|deprecate <id>` | Record your decision. |
| `/adr note <id> <text>` | Append a dated note under More Information. |
| `/adr new [topic]` | Ask the agent to interview you for a new decision. |
| `/adr supersede <id> [topic]` | Ask the agent to interview you for a replacement of an accepted or deprecated decision. |
| `/adr check [--fix]` | Check consistency; `--fix` regenerates the index table. |
| `/adr init` | Initialize `docs/adr/` after a confirmed preview. |
| `/adr confirm <token>` | Confirm a held `/adr init` preview when no dialog was available. |

### Agent tools

| Tool | Purpose |
| --- | --- |
| `adr_status` | List ADRs (optional `status` filter), or read one by `id` with its full text and supersession chain. |
| `adr_manage` | `create`, `revise`, `set_status`, `supersede`, `note`, `link`. `link` requires `id`; supply `stage` to set or change the link, or omit it to clear. |
| `adr_check` | Consistency check; `fix: true` regenerates the index table. |

In a repository without `docs/adr/` management, every tool refuses and tells the agent to ask you to run `/adr init`.

### Existing roadmap ADRs

ADRs written by the roadmap plugin 0.4.0 or earlier are read as they are, including their `docs/adr/README.md` index, so the repository counts as initialized. Each write rewrites only the files it touches in this plugin's format, and the first write converts the index. Untouched files keep their bytes. ADR numbering continues above the roadmap plugin's ADR counter, which is read but never changed.

## Settings

The plugin has no settings.

## Working with other plugins

- **roadmap**: the roadmap plugin requires this plugin. It reads ADRs and links them to stages through this plugin's service contract, and its `/init-project` initializes `docs/adr/` when it is missing. Setting or changing a stage link requires the loaded roadmap plugin and an existing stage; clearing a link does not.
- **omo-prometheus**: Atlas admits the `adr_*` tools during plan execution, alongside the roadmap tools.

## Without the terminal UI

| Host | Behavior |
| --- | --- |
| RPC (`--mode rpc`, `rpc-ui`) and ACP | The same menu and dialogs, sent as `select`, `input` and `editor` requests. ACP clients may show notices only in their log. |
| No UI (`--no-ui`, print, JSON, SDK) | No dialogs. Bare `/adr` prints the list and usage; use the subcommands. `/adr init` returns the preview and a token without writing; confirm with `/adr confirm <token>`. Notices become session messages. |

Client programs can read the ADR status from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- `/adr init` does not adopt a non-empty `docs/adr/` that this plugin does not manage.
- The edit protection is best effort, especially for `bash`, and is not a sandbox.
- `check` verifies the documents, not whether the code follows the decisions.
- A multi-file write is not all-or-nothing; an interrupted one can leave a stale index for `/adr check --fix`.
- Separate clones do not share numbering, so their IDs can collide; worktrees of one clone do share it.
- Without a UI, a held `/adr init` preview lives only in memory and is lost when the process exits.

## Reference

[REFERENCE.md](REFERENCE.md) covers the tool inputs, the file formats including legacy roadmap files, the allowed Markdown, edit protection, recovery and worktrees, the state snapshot and the service contract for other plugins.

## License

MIT. The vendored MADR template keeps its own licenses in `assets/madr/`.
