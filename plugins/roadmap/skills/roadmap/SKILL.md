---
name: roadmap
description: Use for roadmap, stage, ADR, TODO, or /init-project work to interview for a round, classify changes, review decisions, handle overlap, and close stages with evidence through the roadmap plugin.
---

# Roadmap

Use this skill for judgment. The plugin owns document formats, numbering, indexes, and lifecycle gates. Never write managed files under `docs/roadmap/` or `docs/adr/` directly, run scripts that write them, or bypass a blocked write. User edits in an editor are separate from agent writes.

Read `roadmap_status` first. With `stage`, it returns the stage detail and planning handoff. Consult relevant accepted ADRs and their successors before planning changes. Treat documents as intent, not proof of what the code does.

Use the tool-owned body subset: plain paragraphs, flat bullet or ordered lists with single-line plain-text items, and fully closed top-level backtick or tilde fences. Same-line inline code spans are allowed only when equal-length backtick runs close on that line; never use multiline spans. Single-line fields such as scope items, criteria and verification methods accept only plain text and same-line code. Other inline markup, raw HTML, comments, links and reference definitions, headings, quotes, tables, thematic breaks, nested lists, indented code, tabs outside fences and ambiguous constructs are refused without changing managed bytes. Put literal Markdown or HTML examples inside a closed fence rather than retrying container tricks. Fences have zero to three leading spaces and at least three markers; the closer uses the same marker, is at least as long, and has no info string. Use a single ASCII language token for opener info. Separate a plain paragraph after a list with a blank line; lazy list continuations are refused. After a list or at the start of a TODO body, an indented fence needs an unindented plain paragraph before it; an unindented fence is already top-level.

## Where a change belongs

- A scope or done-criterion change within an active stage belongs in `roadmap_stage` with `action: "amend"`. Record the delta and reason rather than rewriting its original commitment.
- New planned work belongs in `roadmap_stage` with `action: "add"`. Use `action: "edit"` only while the stage is planned.
- Deferred or carried-over work belongs in `roadmap_todo`. Use `add`, `update`, `resolve`, or `move`; give each open item a source, severity, and either an unclosed stage in the active round or a concrete trigger. Don't use a vague "later" target.
- A hard-to-reverse, cross-stage decision with real alternatives belongs in an ADR. A scope deviation isn't an ADR. Routine implementation choices and bug fixes aren't ADRs either.
- A failing test or broken build needs a fix now, not a TODO that hides unfinished work.

Use `roadmap_stage` with `action: "start"` to start a planned stage or join an active one. Read the returned handoff before planning implementation. Joining doesn't grant exclusive ownership; another session may be working on the same stage. Follow dependencies and don't bypass a refusal.

## Init interview and round charter

The user starts initialization with `/init-project`. Gather facts from the repository before asking questions, and skip questions already answered. Ask focused questions rather than handing the user a questionnaire.

1. Establish project identity: name, purpose, current state, and who the work serves.
2. Define the round goal, constraints, non-goals, and principles. Principles cite ADR ids; they never restate the decisions.
3. Identify decisions already made. Capture their context, genuine alternatives, rationale, and consequences as initial ADRs. Don't invent options or approval history.
4. Break the round into stages. For each, record an objective, scope in and out, done criteria with a specific verification method, and dependencies. Separate prerequisites from work that merely follows another stage.
5. Confirm the interview summary with the user. Submit the agreed project, charter, ADRs, and stages through `roadmap_init`; let the plugin show the rendered file preview and obtain confirmation before writing. Cancellation or no answer isn't approval.

Rounds are sequential, with at most one active. Opening and closing them are user-command decisions, not autonomous agent actions. For later rounds, the user uses `/roadmap new-round`; discuss the new charter and which carried TODOs to import without changing the frozen prior round.

## ADR judgment and review

When `skill://adr-skill` exists, read it and follow its triggers, repository scan, intent interview, confirmation gate, and review checklist. Adapt those instructions as follows:

- Never run its scripts, copy its templates into managed files, choose filenames yourself, or write files directly. Use only `roadmap_adr` for ADR mutations; the plugin supplies numbering and the vendored MADR template.
- Use MADR sections for context, decision drivers, considered options, decision outcome, consequences, pros and cons, Confirmation, and More Information. Use **Confirmation instead of Verification**. Leave implementation steps to the implementation plan, not an ADR Implementation Plan section.
- Apply checklist items about implementation paths, patterns, migrations, and tasks to the separate plan. Apply its testability checks to Confirmation and the stage's done criteria. Review context, measurable constraints, genuine alternatives, tradeoffs, consequences, stakeholders, and status in the ADR itself.
- Before accepting a decision, present the intent summary and any review gaps to the user. Don't infer acceptance from silence. Without a UI, create the ADR as `proposed`; subagents also create only proposed ADRs.

Use `roadmap_adr` with `action: "create"` for a new record and `action: "revise"` for whole-body changes to a proposed record. Accepted ADRs aren't rewritten. A main agent uses `set_status` for acceptance, rejection, or deprecation; `supersede` for a replacement decision with linked predecessor and successor; and `note` for a dated addition under More Information. Subagents cannot accept, reject, deprecate, or supersede ADRs. ADR management remains available after a round closes.

## Close a stage or round

1. Read the current stage with `roadmap_status`. Compare its amended scope and criteria with the actual code and delivered behavior.
2. Gather evidence for every done criterion: criterion id, `pass` or `fail`, method, observed summary, and a commit reference when useful. A general "tests passed" statement doesn't prove unrelated criteria. Failed or missing evidence means the stage isn't ready to close.
3. Disposition every open TODO targeting the stage: resolve it with a reference, or move it to another valid target or trigger. Record carry-over honestly rather than marking it resolved.
4. Have the main agent settle every proposed ADR tied to the stage as accepted or rejected. A subagent close requiring these dispositions must return to the main agent.
5. Call `roadmap_stage` with `action: "close"`, delivered work, deviations, per-criterion evidence, TODO dispositions, and ADR dispositions. The hard gate decides whether closure succeeds; don't replace it with direct edits or claim success after a refusal.

If a completion reminder supplies plan gate verdicts, treat them as evidence candidates. Map each relevant result to a criterion and verify gaps; plan completion doesn't automatically close the stage.

For abandoned planned or active work, use `roadmap_stage` with `action: "drop"` and a reason after moving or resolving its targeted TODOs. Don't pretend it was delivered. Use `action: "renumber"` only for planned stages; don't evade refusals involving closed or frozen references.

The user closes a round with `/roadmap close-round` only after every stage is closed or dropped. Each remaining open TODO needs a disposition: resolved with a reference, explicitly wontfix, or carried to a later round. Closure freezes the round directory in place.

## Overlap and free work

In a free session, the main agent calls `roadmap_overlap` with the candidate stage and the user's intent when a request appears to match an unclosed stage. Overlap detection depends on the agent noticing; it isn't a classifier. Closed and dropped stages aren't candidates.

The plugin asks once per stage per session, and remembers the answer across compaction:

- **Use the roadmap** starts or joins the stage, binds the session, and returns its handoff.
- **Free work** leaves the session outside that stage and appends a line to its Free-work log. When the stage is later started, verify in code what already exists before planning duplicate work. The log isn't completion evidence.
- **Unrelated** records the false positive without binding the session.

An already-bound stage returns in-system with its handoff, without a dialog or free-work entry, even without a UI; its binding takes precedence over an earlier free/unrelated answer. Otherwise don't re-ask after a stored answer. Without a UI, no answer is recorded; don't choose for the user. Subagents don't conduct this overlap dialog.

## Consistency and recovery

Use `roadmap_check` for document consistency, or `/roadmap check`. **Check cannot detect code/document drift.** Compare actual code and behavior at stage boundaries and during closure; a clean check doesn't prove delivery. Cross-clone id collisions are detected, not prevented.

Writes are atomic per file, not per operation. An interrupted multi-file operation can leave intact individual files but stale indexes. Check reports the inconsistency. Use `roadmap_check` with `fix: true`, or `/roadmap check --fix`, to regenerate generated blocks and indexes; it doesn't repair arbitrary content or touch frozen rounds. Restore other damage with `git`, preserving unrelated work and user edits. Never bypass the tools to repair managed files.
