# roadmap

Tool-managed build rounds, stages, carry-over TODOs and architecture decisions. Roadmap records what a project should deliver and what evidence closed each stage. Implementation plans stay separate.

Requires OMP 18.3.5 or newer and a git work tree. Version 0.1.0 has no plugin settings or runtime dependencies.

## Install

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install roadmap@wows-omp-plugins
```

Start a new session after installation. The plugin includes the `roadmap` judgment skill and a pinned MADR 4.0 template.

## Concepts

| Record | Purpose |
| --- | --- |
| Round (`R1`) | A build cycle with a goal, constraints, non-goals and principles citing ADRs. At most one round is active. Closing freezes its directory in place. |
| Stage (`S01`) | An objective, scope and verifiable done criteria. Stages move from `planned` to `active` to `closed`, or are `dropped`. Dependencies must be closed before starting. |
| Done criterion (`DC1`) | A statement of what must pass plus a verification method. Stage close requires passing evidence for every current criterion. |
| TODO (`T001`) | Deferred work with a source, severity (`high`, `normal`, `low`) and either an unclosed target stage in the active round or a trigger. Each round has one TODO document. |
| ADR (`ADR-0001`) | A decision in MADR format, with considered options, outcome and optional Confirmation. ADRs outlive rounds. |
| Plan | Implementation steps produced from a stage handoff. Plans aren't stored in the roadmap directory. |

**In-system work** starts or joins a stage and binds the session to it. The handoff includes the objective, scope, done criteria, targeted TODOs, cited ADRs, free-work log and closing guidance. A closed stage never reopens; use a new stage with `follows` for corrective work.

**Free work** doesn't bind the session. When the main agent notices that a free request overlaps an unclosed stage, it calls `roadmap_overlap`. You choose to use the roadmap, log it as free work, or treat it as unrelated. The stored answer is reused for that stage in that session. A free answer appends one intent line to the stage's Free-work log; it doesn't claim delivery or satisfaction of any criterion. Later planning must verify what already exists in code.

While a round is active, the plugin reads the checked-out documents on each turn and injects bounded status into main and subagent context. The stage list is capped at 12, with a pointer to `roadmap_status` for the remainder. With no active round, that status isn't injected and free work continues normally. ADR tools and managed-file protection remain available in an initialized repository.

## First project and everyday use

1. Run `/init-project` in the main session. The repository must be a git work tree, `docs/roadmap/` must not exist, and `docs/adr/` must be absent or empty.
2. Answer the agent's interview: project identity and description; first-round goal, constraints, non-goals and principles; decisions already made; stages with objectives, scope, done criteria and dependencies.
3. Review the files presented by `roadmap_init` and confirm before anything is written. Preview editors show editable text, but edits made there are discarded. Ask the agent to revise the tool inputs if the draft needs changes.
4. Ask the agent to start a stage with `roadmap_stage`, `action: "start"`. Use its handoff to plan and execute the work. Starting an already active stage joins it and warns that another session may be working on it.
5. Record scope or criterion changes on an active stage with `amend` and a reason. Keep later work in TODOs and decisions in ADRs.
6. Close the stage with evidence and dispositions, then close the round when all stages are closed or dropped.

Initialization and opening a round require explicit user commands, an armed main session, and a confirmed preview. The plugin revalidates the files after confirmation and rejects stale previews. A successful write consumes that authorization. Headless contexts cannot answer the preview, overlap or round-close dialogs; cancellation or an unavailable answer doesn't authorize a write.

### Stage close

A stage closes only from `active`. The agent calls `roadmap_stage` with `action: "close"`, its `id`, a `delivered` summary, optional `deviations`, and:

- `evidence`: one entry for each current criterion, naming `criterion`, `result: "pass"`, the actual `method` and a `summary`; `commit` is optional. Missing or failed evidence refuses the close.
- `todos`: every open TODO targeting the stage must be `resolved` with a `reference`, or `moved` to another valid target. A move leaves the TODO open. A trigger can be supplied through the target form `trigger: <text>`.
- `adrs`: every proposed ADR associated with the stage must be `accepted` or `rejected`. Subagents cannot make those decisions; the main session must dispose of them before a subagent can close the stage.

The operation records the Outcome and closure hash. The plugin validates evidence entries, not the truth of their claims; the agent must run the stated checks and report real results.

### Round close and carry-over

`/roadmap close-round` requires every stage to be closed or dropped and no document-check errors. Its dialog asks for a disposition for every open TODO: `resolved` with a reference, `wontfix` recorded under Known limitations, or `carried` for consideration in a later round. Closing freezes the directory rather than moving it.

The dialog authorizes only the round and round-file snapshot reviewed before it opened. When closing through the status menu, that review starts when the menu is shown, not when its Close round option is selected. If that round closes, another round opens, or any of its files change while a menu or disposition dialog is pending, closing is refused as stale without writing. Run `/roadmap close-round` again to review the current state.

`/roadmap new-round` interviews you for the next charter. The resulting `roadmap_round_open` preview can import selected carried TODO ids from frozen rounds. Imported items get new ids, retain their origin, and begin with a trigger rather than a stale target stage. The old round stays untouched.

## Commands

All commands below require the main session. Stage ids have argument completions.

| Command | Behavior |
| --- | --- |
| `/init-project` | Check initialization prerequisites, arm initialization and start the interview. |
| `/roadmap` | Open the status menu with stages, TODO counts and valid actions. Close stage shows guidance for the evidence-gated `roadmap_stage` close tool; it doesn't write files. |
| `/roadmap stage <id>` | Show the full stage document and planning handoff; doesn't start or bind it. |
| `/roadmap check` | Check document consistency. |
| `/roadmap check --fix` | Regenerate eligible generated blocks, never authored bodies or frozen rounds. |
| `/roadmap new-round` | Require no active round and no check errors, then arm and interview for the next round. |
| `/roadmap close-round` | Collect TODO dispositions and freeze the active round after its stages finish. |

## Tools

These are agent tools, not slash commands. Mutating tools use write approval; `roadmap_status` uses read approval.

| Tool | Inputs or actions |
| --- | --- |
| `roadmap_status` | No parameters for rounds, stages and open TODOs by target or trigger; optional `stage` for full detail and handoff. |
| `roadmap_stage` | `add`, `edit`, `amend`, `start`, `close`, `drop`, `renumber`. |
| `roadmap_todo` | `add`, `update`, `resolve`, `move`. |
| `roadmap_adr` | `create`, `revise`, `set_status`, `supersede`, `note`. |
| `roadmap_check` | Optional `fix: true` regenerates eligible generated blocks. Checks documents, not code/document drift. |
| `roadmap_overlap` | `stage` and `intent`; an already-bound stage returns in-system with its handoff, without a dialog or free-work entry, even headless. Otherwise ask the main-session user once per stage/session and reuse the answer. Subagents don't prompt. |
| `roadmap_init` | `project`, `round`, initial `adrs` and `stages`; requires `/init-project` authorization and a confirmed preview. |
| `roadmap_round_open` | `round` charter and `import_todos` ids; requires `/roadmap new-round` authorization and a confirmed preview. |

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

Tools reparse rendered documents and refuse body text that changes the intended item ids, order, metadata, bodies or section boundaries. Escape structural headings or keep Markdown examples inside fully closed fenced code blocks; a body cannot leave a fence open across later items or sections. Stage bodies and ADR sections follow the same boundary rules; criterion statements and verification methods remain single-line text.

ADR `create` requires `title` and `sections` with `context`, nonempty `options` and `outcome`. Optional sections include `drivers`, `consequences`, `confirmation`, `pros_cons` and `more_info`; participant lists and a stage association are also supported. The vendored MADR 4.0 template uses Confirmation, not an implementation checklist.

`revise` replaces the whole body of a proposed ADR while retaining its metadata; it can also change the title. Accepted ADRs aren't rewritten through `revise`. The main session can use `set_status` for `accepted`, `rejected` or `deprecated`, or `supersede` an accepted/deprecated ADR with a newly accepted successor and reciprocal links. `note` appends dated `text` under More Information. Subagents create proposed ADRs regardless of a requested final status, and cannot set status or supersede.

If an existing ADR or the new note ends inside an unterminated fenced block, `note` refuses without changing the document. Close the fence in your editor or correct the note input, then retry; the tool never rewrites an accepted body to repair it.

## Managed-file protection

After initialization, a tool-call hook protects `docs/roadmap/**` and `docs/adr/**` in main and subagent sessions. It discovers the target's own git work tree, checks lexical and resolved paths (including dangling symlink destinations), and blocks with guidance to use the roadmap tools. Native paths use the host's normalization for `@`-prefixed absolute paths, stray `:` prefixes, home-relative `~` paths and `file://` URLs. Repositories without the initialization marker are unaffected. A validation or path-resolution error in the hook refuses the call rather than allowing a potentially unmanaged mutation.

| Surface | Coverage |
| --- | --- |
| `write` | Its `path`, including `[path#TAG]` headers copied from read output. |
| `edit`, `apply_patch` | Native edit projection across supported grammars, including source and destination paths for file operations. |
| `ast_edit` | `paths`, including directories and the containing directory of the first glob segment: `docs/roadm*/**/*.ts` and `docs/roa?map/**/*.md` both project to `docs`. |
| `lsp` | File-named `rename`, `rename_file` source/destination and applied `code_actions` via `file` and `new_name`. This isn't inspection of every file in a cross-file workspace edit. |
| `bash` | Best-effort static detection of path arguments after redirections (`>`, `>>`), `tee`, `mv`, `cp`, `rm`, in-place `sed` and `truncate`. |

This is workflow protection, not a filesystem sandbox. It doesn't intercept `eval`, `ctx_execute*`, editors launched from bash, or arbitrary programs that write files. Shell variables, substitutions and indirect writes can evade static bash matching. Broad directory/glob candidates can also be blocked conservatively.

Your own editor isn't intercepted. You can edit authored body text, but retain the front matter, managed comment, fixed headings and generated-block delimiters. Tools refuse malformed structure, and changing a closed stage or frozen round is reported by its hash check. Use a new stage for corrective work instead of rewriting closed history.

## Recovery and git worktrees

Writes take one repository lock and atomically replace each file. A multi-file operation is **not** an all-or-nothing transaction. If interrupted, it can leave individually complete files but stale generated indexes or a partially applied operation.

1. Run `/roadmap check` or `roadmap_check` to inspect the tree.
2. Use `/roadmap check --fix` or `roadmap_check` with `fix: true` for stale generated blocks. This doesn't repair authored content, recompute historical closure hashes or change frozen rounds.
3. Restore other damage with git, then run the document check again.

Commit the changed documents according to your project's rules. Checked-out Markdown is the source of truth on each branch. Worktrees share only the lock and versioned id counters under the git common directory's `roadmap/`; ids are allocated above both the stored counter and ids on disk. Separate clones don't share counters, so cross-clone collisions can be detected when combined, not prevented.

## Optional Prometheus integration

Install [omo-prometheus](../omo-prometheus/README.md) alongside roadmap to plan and execute a bound stage. Neither plugin requires the other, and this integration isn't controlled by the `herdrDag` setting.

1. Start or join the stage before the Prometheus proposal. At proposal time, Prometheus emits `roadmap:binding-request` and roadmap answers synchronously with `roadmap:binding`, both contract version `v: 1`. The answer identifies the session, request, repository, trusted tool source and optional bound active stage. No synchronous answer means roadmap is absent.
2. New Atlas bundles write `approval.json` version 2 with optional `roadmapStage: { repoRoot, id }`, captured from that proposal binding. Older version 1 approvals still load without rewriting their bytes or requiring reapproval.
3. Atlas admits `roadmap_*` tools only when their provenance is an extension and its source path exactly matches the handshake's `toolSourcePath`. A same-named tool from another extension or MCP server isn't admitted by this exception.
4. After a ledger write first makes the bound plan complete, Prometheus emits `atlas:completed` with the executing session id, plan id, stage and verified gate verdicts/summaries. Roadmap stores a pending-close entry in that session and adds a reminder on its next turn while the stage remains active.
5. The executing session maps the gate results to stage criteria, verifies their relevance and calls `roadmap_stage` with `action: "close"`. Completion is a reminder, not automatic stage closure; the normal evidence and disposition gate still applies.

**How to tell it's active:** `roadmap_status` with the stage id confirms the stage is active, and the next turn's status shows `Bound stage: S01` after a start/join. For a proposed plan, inspect its Atlas bundle's `approval.json`: `roadmapStage` is the durable sign that the plan carries a binding. After completion, the executing session receives `Plan <id> completed for <stage>` and gate evidence candidates in its next-turn context. Merely installing both plugins doesn't attach an unbound proposal to a stage.

Completion deduplication is per Prometheus producer instance, not a durable exactly-once marker. Restarting the producer, reopening a completed ledger row and recompleting the plan can emit `atlas:completed` again. Roadmap deduplicates pending-close entries by `planId` within the receiving session's retained state; a repeat in another session can create a reminder there.

## Known limits

- No adoption of existing roadmap or ADR trees in 0.1.0. Initialization requires a fresh managed directory and an absent or empty ADR directory.
- Overlap detection depends on the main agent noticing and calling the tool. It isn't a classifier or an automatic comparison of each request against every stage.
- Bash protection is best-effort, with the other gaps listed above. It doesn't sandbox the agent.
- Joining an active stage warns about other sessions; it doesn't reserve the stage or prevent concurrent implementation. The shared lock serializes document writes only.
- Cross-clone id collisions aren't prevented. Checked-out branches can have different roadmap state even when their worktrees share numbering.
- `check` verifies references, metadata, generated blocks and closure integrity, not whether code satisfies the documents. Honest close evidence and boundary checks remain necessary.
- Per-file atomic writes don't provide operation-wide rollback. Previewed ids can be consumed even when a preview is declined, so numbering can have gaps.
- Dialogs need an interactive UI. Headless execution doesn't supply confirmation or an overlap answer.
- Atlas completion reminders have the per-producer and per-session deduplication limits described above.

The following format description is copied from `HOW_THIS_DIRECTORY_WORKS` in `src/documents.ts`. Initialization writes the same text into your project's [docs/roadmap/README.md](../../docs/roadmap/README.md), which also serves as its initialization marker and generated index. That project file doesn't exist until initialization.

## How this directory works

This directory records structured build rounds, their stages and carry-over TODOs. ADRs in docs/adr/ record decisions and outlive rounds. Plans describe implementation steps and do not live here.

The root README is the initialization marker and rounds index. Each NN-slug round directory contains its charter README, TODO.md and stages/NN-slug.md. Rounds use R1, R2 and so on; stages use S01, TODOs T001 and ADRs ADR-0001. Stage and TODO numbers are global across rounds, monotonic and never reused. ADR files use NNNN-slug.md. Slugs contain lowercase ASCII letters, digits and hyphens.

Every managed file has format: 1 front matter and a managed-by comment. This README also carries roadmap: { format: 1 }. Front matter and fixed headings are structure; section bodies are free Markdown. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages and Known limitations. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.

Agents change managed files through roadmap_* tools. Body text can be edited by a user in an editor; malformed structure must be repaired before tools can write. Generated blocks are marked with <!-- roadmap:generated:<name> --> and <!-- /roadmap:generated -->. The tools own numbering, metadata, headings and generated indexes.

Rounds are active or closed. Stages are planned, active, closed or dropped. Closed stages never reopen; corrective work uses a new stage with follows. Dependencies must be closed before a stage starts. Done criteria state what must pass and how to verify it; closing records evidence, TODO dispositions and ADR dispositions. Open TODOs need severity, source and either an unclosed target stage or a trigger. Charter principles cite ADRs rather than restating decisions. Accepted ADRs change through status transitions, supersession and dated append-only notes.

Closed stages carry closed_sha256; closed rounds carry frozen_sha256 and remain read-only history. There is at most one active round. With none active, free work is unrestricted and roadmap context is not injected; ADR management remains available.

Writes use one repository lock and per-file atomic replacement. An interrupted multi-file operation can leave stale indexes: run roadmap_check or /roadmap check, then check --fix to regenerate generated blocks. Fix never changes authored bodies or a closed round. Restore other damage with git. The shared git common directory stores only the lock and versioned id counters; the checked-out Markdown is the source of truth on each branch.

Check verifies document consistency. It cannot determine whether code implements the documents. Close evidence and boundary checks help keep them aligned.
