# roadmap

English | [简体中文](README.zh.md)

Roadmap tools manage build rounds, stages, carry-over TODOs and architecture decisions. They record what a project should deliver and what evidence closed each stage. Implementation plans stay separate.

Requires OMP 18.3.5 or newer and a git work tree. Version 0.1.0 has no plugin settings or runtime dependencies.

## Install

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install roadmap@wows-omp-plugins
```

Start a new session after installing. The plugin includes the `roadmap` judgment skill and a pinned MADR 4.0 template.

## Concepts

| Record | Purpose |
| --- | --- |
| Round (`R1`) | A build cycle with a goal, constraints, non-goals and principles citing ADRs. At most one round is active. Closing freezes its directory in place. |
| Stage (`S01`) | An objective, scope and verifiable done criteria. Stages move from `planned` to `active` to `closed`, or are `dropped`. Dependencies must be closed before starting. |
| Done criterion (`DC1`) | A statement of what must pass plus a verification method. Stage close requires passing evidence for every current criterion. |
| TODO (`T001`) | Deferred work with a source, severity (`high`, `normal`, `low`) and either an unclosed target stage in the active round or a trigger. Each round has one TODO document. |
| ADR (`ADR-0001`) | A decision in MADR format, with considered options, outcome and optional Confirmation. ADRs outlive rounds. |
| Plan | Implementation steps produced from a stage handoff. Plans are not stored in the roadmap directory. |

In-system work starts or joins a stage and binds the session to it. The handoff includes the objective, scope, done criteria, targeted TODOs, cited ADRs, free-work log and closing guidance. A closed stage never reopens; use a new stage with `follows` for corrective work.

Free work does not bind the session. When the main agent notices that a free request overlaps an unclosed stage, it calls `roadmap_overlap`. You choose to use the roadmap, log it as free work, or treat it as unrelated. The stored answer is reused for that stage in that session. A free answer appends one intent line to the stage's Free-work log; it does not claim delivery or satisfaction of any criterion. Later planning must verify what already exists in code.

While a round is active, the plugin reads the checked-out documents on each turn and injects bounded status into main and subagent context. The stage list is capped at 12, with a pointer to `roadmap_status` for the remainder. With no active round, that status is not injected and free work continues normally. ADR tools and managed-file protection remain available in an initialized repository.

## First project and everyday use

1. Run `/init-project` in the main session. The repository must be a git work tree, `docs/roadmap/` must not exist, and `docs/adr/` must be absent or empty.
2. Answer the agent's interview: project identity and description; first-round goal, constraints, non-goals and principles; decisions already made; stages with objectives, scope, done criteria and dependencies.
3. Review the `roadmap_init` preview and confirm before anything is written. The preview opens as one menu: pick `Write N files` to confirm, `Cancel` to decline, or any file to read it in an editor and return to the menu. Edits made in that editor are discarded; ask the agent to revise the tool inputs if the draft needs changes.
4. Ask the agent to start a stage with `roadmap_stage`, `action: "start"`. Use its handoff to plan and execute the work. Starting an already active stage joins it and warns that another session may be working on it.
5. Record scope or criterion changes on an active stage with `amend` and a reason. Keep later work in TODOs and decisions in ADRs.
6. Close the stage with evidence and dispositions, then close the round when all stages are closed or dropped.

Initialization and opening a round require explicit user commands, an armed main session, and a confirmed preview. The plugin revalidates the files after confirmation and rejects stale previews. A successful write consumes that authorization. Cancellation or an unavailable answer does not authorize a write. Without a UI, every dialog has a command form instead; see [Host modes](#host-modes).

### Stage close

A stage closes only from `active`. The agent calls `roadmap_stage` with `action: "close"`, its `id`, a `delivered` summary, optional `deviations`, and:

- `evidence`: one entry for each current criterion, naming `criterion`, `result: "pass"`, the actual `method` and a `summary`; `commit` is optional. Missing or failed evidence refuses the close.
- `todos`: every open TODO targeting the stage must be `resolved` with a `reference`, or `moved` to another valid target. A move leaves the TODO open. A trigger can be supplied through the target form `trigger: <text>`.
- `adrs`: every proposed ADR associated with the stage must be `accepted` or `rejected`. Subagents cannot make those decisions; the main session must dispose of them before a subagent can close the stage.

The operation records the Outcome and closure hash. The plugin validates evidence entries but cannot verify whether their claims are true. The agent must run the stated checks and report real results.

### Round close and carry-over

`/roadmap close-round` requires every stage to be closed or dropped and no document-check errors. Its dialog asks for a disposition for every open TODO: `resolved` with a reference, `wontfix` recorded under Known limitations, or `carried` for consideration in a later round. Closing freezes the directory in place; it does not move it.

The dialog authorizes closing only the round and file snapshot reviewed before it opened. For the status-menu path, the snapshot is taken when the menu appears, before you select Close round. If that round closes, another round opens, or any of its files change while the menu or disposition dialog is pending, the close is refused as stale and writes nothing. Run `/roadmap close-round` again to review the current state.

`/roadmap new-round` interviews you for the next charter. The resulting `roadmap_round_open` preview can import selected carried TODO IDs from frozen rounds. Imported items get new IDs and retain their origin. They begin with a trigger; the old target stage is not carried over. The old round stays untouched.

## Commands

All commands below require the main session. Stage IDs have argument completions.

| Command | Behavior |
| --- | --- |
| `/init-project` | Check initialization prerequisites, arm initialization and start the interview. |
| `/roadmap` | Open the status menu with stages, TODO counts and valid actions. Close stage shows guidance for the evidence-gated `roadmap_stage` close tool; it does not write files. |
| `/roadmap stage <id>` | Show the full stage document and planning handoff; does not start or bind it. |
| `/roadmap check` | Check document consistency. |
| `/roadmap check --fix` | Regenerate eligible generated blocks, never authored bodies or frozen rounds. |
| `/roadmap new-round` | Require no active round and no check errors, then arm and interview for the next round. |
| `/roadmap close-round` | Collect TODO dispositions and freeze the active round after its stages finish. |
| `/roadmap close-round <todo>=<disposition>[:<reference>] ...` | Answer the disposition dialog in the command: `T001=resolved:abc1234`, `T002=wontfix:"out of scope"`, `T003=carried`. Every open TODO needs one; `resolved` needs a reference. Double quotes group text with spaces. |
| `/roadmap overlap <stage> roadmap\|free\|unrelated [intent]` | Answer the overlap question for this session: `roadmap` starts or joins and binds the stage, `free` logs the intent as free work (intent required), `unrelated` stops asking for that stage. An answer already stored for the stage is kept. |
| `/roadmap confirm <token>` | Write a preview that `roadmap_init` or `roadmap_round_open` held because no UI could confirm it. |

## Tools

These are agent tools, not slash commands. Mutating tools use write approval; `roadmap_status` uses read approval.

| Tool | Inputs or actions |
| --- | --- |
| `roadmap_status` | No parameters for rounds, stages and open TODOs by target or trigger; optional `stage` for full detail and handoff. |
| `roadmap_stage` | `add`, `edit`, `amend`, `start`, `close`, `drop`, `renumber`. |
| `roadmap_todo` | `add`, `update`, `resolve`, `move`. |
| `roadmap_adr` | `create`, `revise`, `set_status`, `supersede`, `note`. |
| `roadmap_check` | Optional `fix: true` regenerates eligible generated blocks. Checks documents, not code/document drift. |
| `roadmap_overlap` | `stage` and `intent`; an already-bound stage returns in-system with its handoff, without a dialog or free-work entry, even headless. Otherwise ask the main-session user once per stage/session and reuse the answer. Subagents do not prompt. |
| `roadmap_init` | `project`, `round`, initial `adrs` and `stages`; requires `/init-project` authorization and a confirmed preview. |
| `roadmap_round_open` | `round` charter and `import_todos` IDs; requires `/roadmap new-round` authorization and a confirmed preview. |

### Stage actions

| Action | Rules |
| --- | --- |
| `add` | Create a planned stage in the active round. Supply `title`, `objective`, `scope_in`, `scope_out` and `done_criteria` entries with `statement` and `verify`; dependencies and design constraints are optional. |
| `edit` | Replace supplied fields of a planned stage. Use `amend` once active. |
| `amend` | Append a dated delta and required `reason` to an active stage. `amendments` can add, modify or remove criteria and add or remove in/out scope items. |
| `start` | Require closed dependencies and no check errors, activate and bind the stage, and return a planning handoff. The same action joins an already active stage without changing its document. |
| `close` | Enforce the evidence and TODO/ADR gate described above, record the Outcome and freeze the stage. |
| `drop` | Drop a planned or active stage with a required `reason`. Resolve or move every open TODO targeting it first. |
| `renumber` | Renumber a planned stage using `new_id` and rewrite mutable references. Refuse when closed history contains a reference that would need changing. |

### TODO and ADR actions

TODO `add` requires `title`, `source`, `severity`, and either `target` or `trigger`; `body` is optional. `update` changes supplied fields of an open item in the active round. `resolve` requires a `reference`. `move` replaces its target or trigger and refuses a closed target stage.

Tool-owned body text supports a small Markdown subset: plain paragraphs, flat bullet or ordered lists with single-line text items, and fully closed top-level fenced code blocks. Bullet markers are `-`, `+` or `*`; ordered markers have one to nine digits followed by `.` or `)`. Use one space after the marker. Nested lists and indented list continuations are refused.

Ordinary punctuation is allowed, including `~20%`, `snake_case`, multiplication such as `quantity * unit price`, URLs with underscores or tildes, and comparisons such as `x < y` or `x > y`. A `<` is refused when immediately followed by an ASCII letter, `/`, `!` or `?`, which can begin HTML, an autolink, a comment or a processing instruction. A `>` cannot begin a line.

Inline emphasis delimiters are allowed, and matched pairs may render as formatting. Square brackets, backslash escapes and table pipes remain unsupported outside code. Same-line inline code spans are allowed; each opening backtick run must close with an equal-length run on that line. A multiline span cannot hide HTML or a fence on another line. Put literal unsupported syntax in code or use entities such as `&lt;script&gt;`.

Fences use at least three backticks or tildes, with zero to three leading spaces. The optional info string is one language token made of ASCII letters, digits, `_`, `+`, `.` or `-`. A closer uses the same marker, is at least as long as the opener, has zero to three leading spaces and only spaces or tabs after it, and has no info string. Fence contents are literal and may contain otherwise refused syntax.

Fences cannot begin inside lists or quotes. After a list, use an unindented fence, or a blank line followed by an unindented plain paragraph before an indented fence. This also applies to a TODO body's preceding metadata list. Plain paragraphs after a list require a blank separator; lazy list continuations are refused.

Outside fences and same-line code spans, the tools refuse raw HTML and comments, Markdown links and reference definitions, ATX and Setext headings, block quotes, tables, thematic breaks, indented code, tabs, malformed or unclosed fences and ambiguous constructs. They return a repair hint before changing any managed bytes.

Tool-supplied scope items, criterion statements, verification methods and other single-line fields follow the same punctuation and inline rules but cannot contain lists or fences. Tools reparse the rendered document to check that intended IDs, metadata, body boundaries and fixed headings survive.

ADR `create` requires `title` and `sections` with `context`, nonempty `options` and `outcome`. Optional sections include `drivers`, `consequences`, `confirmation`, `pros_cons` and `more_info`; participant lists and a stage association are also supported. The vendored MADR 4.0 template has a Confirmation section and no implementation checklist.

`revise` replaces the whole body of a proposed ADR while retaining its metadata; it can also change the title. Accepted ADRs are not rewritten through `revise`. The main session can use `set_status` for `accepted`, `rejected` or `deprecated`, or `supersede` an accepted/deprecated ADR with a newly accepted successor and reciprocal links. `note` appends dated `text` under More Information. Subagents create proposed ADRs regardless of a requested final status, and cannot set status or supersede.

If an existing ADR ends inside an unterminated fence, `note` refuses without changing the document. Repair the stored file in your editor or correct the new note to use the allowed body subset, then retry; the tool never rewrites an accepted body to repair it.

## Managed-file protection

After initialization, a tool-call hook protects `docs/roadmap/**` and `docs/adr/**` in main and subagent sessions. It discovers the target's git work tree, checks lexical and resolved paths (including dangling symlink destinations), and blocks edits with guidance to use the roadmap tools.

For existing file targets, the hook compares device and inode against multiply linked managed files in the session and target worktrees. This blocks native `write` and `edit` from changing a managed original through a hardlink alias, inside or outside the repository. Native paths follow the host's normalization for `@`-prefixed absolute paths, stray `:` prefixes, home-relative `~` paths and `file://` URLs.

Repositories without the initialization marker are unaffected. A validation, path-resolution or file-identity error in the hook refuses the call.

| Surface | Coverage |
| --- | --- |
| `write` | Its `path`, including `[path#TAG]` headers copied from read output and existing hardlink aliases. |
| `edit`, `apply_patch` | Every native `edit` call projects the `hashline`, `replace`, `patch`, `apply_patch` and `sloppy` grammars; `apply_patch` uses its own grammar. Any managed source/destination or existing hardlink alias is blocked. Unknown grammars or modes are refused. |
| `ast_edit` | `paths` use the native scope helpers: trim whitespace, strip outer double quotes, expand delimiter-separated entries and normalize backslash separators before projecting directories or globs. Invalid scopes are refused. Coverage includes directories outside the worktree that contain its managed roots, and the containing directory of the first glob segment. `docs/roadm*/**/*.ts` projects to `docs`; `/work/re*/docs/roadmap/*.ts` projects to `/work` and is blocked when the current repository is below it. |
| `lsp` | File-named `rename` and applied `code_actions` via `file`; `rename_file` via both `file` and `new_name`. Symbol-rename `new_name` is an identifier, not a filesystem path. This is not inspection of every file in a cross-file workspace edit. |
| `bash` | Best-effort static detection of path arguments after redirections (`>`, `>>`), `tee`, `mv`, `cp`, `rm`, in-place `sed` and `truncate`. |

This workflow protection does not provide a filesystem sandbox. It does not intercept `eval`, `ctx_execute*`, editors launched from bash, or arbitrary programs that write files. Shell variables, substitutions and indirect writes can evade static bash matching. Broad directory/glob candidates can also be blocked conservatively.

Hardlink identity checks cover existing named file targets. They do not enumerate aliases hidden inside an otherwise unrelated directory/glob or anticipate a link created by a later shell statement: the target filename must be projected and already exist for its inode to be compared.

You can edit authored body text in your own editor, which the hook does not intercept. Retain the front matter, managed comment, fixed headings and generated-block delimiters.

`check` reports unsupported stored HTML, reference definitions, Setext/thematic-break lines, quotes, container fences and ambiguous indentation as non-fixable structure errors, with an editor repair hint. It does not emulate their CommonMark behavior. Closed top-level fences are masked when locating fixed headings; an unclosed fence is a structure error.

Tools refuse malformed structure. Hash checks detect changes to closed stages or frozen rounds. Use a new stage for corrective work instead of rewriting closed history.

Closure hashes are verified whenever they are retained, even if the current status was changed. A status that contradicts retained closure metadata is also an error. Generated-block fixes and document mutations refuse these integrity errors; restore the affected history with git instead of reopening it by hand.

## Recovery and git worktrees

Writes take one repository lock and atomically replace each file. A multi-file operation is not an all-or-nothing transaction. If interrupted, it can leave individually complete files but stale generated indexes or a partially applied operation.

Cancellation stops before the next temporary write or rename and removes uncommitted temporary files; files already committed remain in place. A cancelled operation reports those files and recovery guidance. It does not bind a stage, consume preview authorization or persist an overlap answer, even if its first file was committed. Inspect and repair the partial operation before retrying.

1. Run `/roadmap check` or `roadmap_check` to inspect the tree.
2. Use `/roadmap check --fix` or `roadmap_check` with `fix: true` for stale generated blocks. This does not repair authored content, recompute historical closure hashes or change frozen rounds.
3. Restore other damage with git, then run the document check again.

Commit the changed documents according to your project's rules. Checked-out Markdown is the source of truth on each branch. Worktrees share only the lock and versioned ID counters under the git common directory's `roadmap/`; IDs are allocated above both the stored counter and IDs on disk. Separate clones do not share counters, so cross-clone collisions can be detected when combined, not prevented.

## Host modes

| Host mode | Behavior |
| --- | --- |
| TUI | Dialogs as described above. |
| RPC (`--mode rpc`, `rpc-ui`) and ACP | The same dialogs, sent to the client as `select`, `input` and `editor` requests. Notices are host notify frames; ACP clients may show them only in their log. |
| No UI (`--no-ui`, print, JSON, SDK without a UI) | No dialogs. Notices and errors become displayed session messages. Bare `/roadmap` prints the status and the command usage. `roadmap_init` and `roadmap_round_open` return the full preview and a token without writing; the user writes it with `/roadmap confirm <token>`, and any other reply declines it. The token covers exactly the shown files and lasts until the session is rebuilt (start, switch, branch, tree) or a newer preview of the same kind replaces it. `roadmap_overlap` reports no answer and names `/roadmap overlap`. `/roadmap close-round` without arguments closes a round only when it has no open TODOs; otherwise it lists them and expects dispositions as arguments. |

### State sidecar

The main session publishes `roadmap.json` in the shared plugin-state envelope (see the [root README](../../README.md)). Its `state` is the `roadmap/status` payload, version 1, derived from files on disk. It is `null` when the repository has no initialized roadmap.

The file is rewritten at session start, switch, branch and tree, after every `roadmap_*` tool call and `/roadmap` command, and at the start of each agent turn. This includes changes made by subagents or external edits.

| Field | Content |
| --- | --- |
| `kind`, `version` | `"roadmap/status"`, `1` |
| `repoRoot` | Git work tree root of the roadmap. |
| `project` | Project title from `docs/roadmap/README.md`. |
| `activeRound` | `{ id, title }` of the active round, or `null`. |
| `stages` | Every stage as `{ id, title, status, round }`; `status` is `planned`, `active`, `closed` or `dropped`. |
| `openTodos` | `{ total, byStage, untargeted }`: open TODOs across rounds, counts per target stage ID, and those with a trigger instead of a target. |
| `boundStage` | Stage ID this session is bound to while that stage is active, or `null`. |

## Optional Prometheus integration

Install [omo-prometheus](../omo-prometheus/README.md) alongside roadmap to plan and execute a bound stage. Neither plugin requires the other, and this integration is not controlled by the `herdrDag` setting.

1. Start or join the stage before the Prometheus proposal. At proposal time, Prometheus emits `roadmap:binding-request` and roadmap answers synchronously with `roadmap:binding`, both contract version `v: 1`. The answer identifies the session, request, repository, trusted tool source and optional bound active stage. Roadmap still answers, without a stage, when the bound stage document cannot be read. No synchronous answer means roadmap is absent.
2. New Atlas bundles write `approval.json` version 2 with optional `roadmapStage: { repoRoot, id }`, captured from that proposal binding. Older version 1 approvals still load without rewriting their bytes or requiring reapproval.
3. Atlas admits `roadmap_*` tools, called directly or as `write xd://roadmap_*` devices, only when their provenance is an extension and its source path exactly matches the handshake's `toolSourcePath`. A same-named tool from another extension or MCP server is not admitted by this exception. Atlas may then run every roadmap action the plan names, such as a late stage start, ADR revisions and status decisions, and the final close.
4. After a ledger write first makes the plan complete, Prometheus emits `atlas:completed` with the executing session ID, plan ID, stage and verified gate verdicts/summaries. The stage is the one recorded at proposal or, when the proposal had none, the stage bound in the executing session at that moment. Roadmap stores a pending-close entry in that session and adds a reminder on its next turn while the stage remains active.
5. The executing session maps the gate results to stage criteria, verifies their relevance and calls `roadmap_stage` with `action: "close"`. Completion sends a reminder and does not close the stage automatically. The normal evidence and disposition gate still applies.

Call `roadmap_status` with the stage ID to confirm the stage is active. After a start/join, the next turn's status shows `Bound stage: S01`.

For a proposed plan, inspect its Atlas bundle's `approval.json`. The `roadmapStage` field records the proposal-time binding. After completion, the executing session receives `Plan <id> completed for <stage>` and gate evidence candidates in its next-turn context. A plan with neither a proposal-time nor an executing-session binding is not attached to any stage.

Completion deduplication is per Prometheus producer instance, not a durable exactly-once marker. Restarting the producer, reopening a completed ledger row and recompleting the plan can emit `atlas:completed` again. Roadmap deduplicates pending-close entries by `planId` within the receiving session's retained state; a repeat in another session can create a reminder there.

## Known limitations

- No adoption of existing roadmap or ADR trees in 0.1.0. Initialization requires a fresh managed directory and an absent or empty ADR directory.
- Overlap detection depends on the main agent noticing and calling the tool. It is not a classifier or an automatic comparison of each request against every stage.
- Bash protection is best-effort, with the other gaps listed above. It does not sandbox the agent.
- Joining an active stage warns about other sessions; it does not reserve the stage or prevent concurrent implementation. The shared lock serializes document writes only.
- Cross-clone ID collisions are not prevented. Checked-out branches can have different roadmap state even when their worktrees share numbering.
- `check` verifies references, metadata, generated blocks and closure integrity, not whether code satisfies the documents. Honest close evidence and boundary checks remain necessary.
- Per-file atomic writes do not provide operation-wide rollback. Previewed IDs can be consumed even when a preview is declined, so numbering can have gaps.
- Without a UI, the agent cannot confirm previews or answer overlaps by itself. The user answers with `/roadmap confirm`, `/roadmap overlap` and `/roadmap close-round` arguments. A held preview lives only in memory and is lost when the process exits.
- Atlas completion reminders have the per-producer and per-session deduplication limits described above.

The following format description is copied from `HOW_THIS_DIRECTORY_WORKS` in `src/documents.ts`. Initialization writes the same text into your project's [docs/roadmap/README.md](../../docs/roadmap/README.md), which also serves as its initialization marker and generated index. That project file does not exist until initialization.

## How this directory works

This directory records structured build rounds, their stages and carry-over TODOs. ADRs in docs/adr/ record decisions and outlive rounds. Plans describe implementation steps and do not live here.

The root README is the initialization marker and rounds index. Each NN-slug round directory contains its charter README, TODO.md and stages/NN-slug.md. Rounds use R1, R2 and so on; stages use S01, TODOs T001 and ADRs ADR-0001. Stage and TODO numbers are global across rounds, monotonic and never reused. ADR files use NNNN-slug.md. Slugs contain lowercase ASCII letters, digits and hyphens.

Every managed file has format: 1 front matter and a managed-by comment. This README also carries roadmap: { format: 1 }. Front matter and fixed headings are structure. Tool-owned bodies allow plain paragraphs, flat text lists and closed top-level fences, with ordinary punctuation, plain URLs, inline emphasis and same-line code spans; structural Markdown, Markdown links and raw HTML syntax are refused. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages and Known limitations. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.

Agents change managed files through roadmap_* tools. Body text can be edited by a user in an editor; malformed structure must be repaired before tools can write. Generated blocks are marked with `<!-- roadmap:generated:<name> -->` and `<!-- /roadmap:generated -->`. The tools own numbering, metadata, headings and generated indexes.

Rounds are active or closed. Stages are planned, active, closed or dropped. Closed stages never reopen; corrective work uses a new stage with follows. Dependencies must be closed before a stage starts. Done criteria state what must pass and how to verify it; closing records evidence, TODO dispositions and ADR dispositions. Open TODOs need severity, source and either an unclosed target stage or a trigger. Charter principles cite ADRs rather than restating decisions. Accepted ADRs change through status transitions, supersession and dated append-only notes.

Closed stages carry closed_sha256; closed rounds carry frozen_sha256 and remain read-only history. There is at most one active round. With none active, free work is unrestricted and roadmap context is not injected; ADR management remains available.

Writes use one repository lock and per-file atomic replacement. An interrupted multi-file operation can leave stale indexes: run roadmap_check or /roadmap check, then check --fix to regenerate generated blocks. Fix never changes authored bodies or a closed round. Restore other damage with git. The shared git common directory stores only the lock and versioned id counters; the checked-out Markdown is the source of truth on each branch.

Check verifies document consistency. It cannot determine whether code implements the documents. Close evidence and boundary checks help keep them aligned.
