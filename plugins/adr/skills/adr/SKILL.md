---
name: adr
description: Use for architecture decision records, ADRs, MADR, /adr, or deciding whether a change needs a recorded decision; covers interviewing, drafting, reviewing, accepting, superseding and noting decisions through the adr plugin's tools.
---

# ADR

Use this skill for judgment. The adr plugin owns the file format, numbering, the generated index and the status rules. Never write files under `docs/adr/` directly, run scripts that write them, or bypass a blocked write. Users may still edit body text in their own editor.

Read `adr_status` first: without arguments it lists every ADR with counts by status (`status` filters the list); with `id` it returns the full record, its metadata and its supersession chain. Consult relevant accepted ADRs, and the successors of superseded ones, before planning a change. Treat ADRs as intent, not proof of what the code does.

If `adr_status` reports that ADR management is not initialized, ask the user to run `/adr init`. Agents cannot initialize it, and a non-empty `docs/adr/` the plugin does not manage is never adopted.

## Does it need an ADR?

- A hard-to-reverse, cross-cutting decision with genuine alternatives needs an ADR.
- A scope change, a routine implementation choice or a bug fix does not.
- An accepted decision that no longer holds is superseded by a new ADR, not rewritten.

## ADR judgment and review

When `skill://adr-skill` exists, read it and follow its triggers, repository scan, intent interview, confirmation gate and review checklist. Adapt those instructions as follows:

- Never run its scripts, copy its templates into files, choose filenames yourself or write files directly. Use only `adr_manage` for ADR changes; the plugin supplies numbering and the vendored MADR 4.0 template.
- Use the MADR sections for context, decision drivers, considered options, decision outcome, consequences, pros and cons, Confirmation and More Information. Use **Confirmation instead of Verification**. Leave implementation steps to the implementation plan, not an ADR Implementation Plan section.
- Apply checklist items about implementation paths, patterns, migrations and tasks to the separate plan. Apply its testability checks to Confirmation. Review context, measurable constraints, genuine alternatives, tradeoffs, consequences, stakeholders and status in the ADR itself.
- Before accepting a decision, present the intent summary and any review gaps to the user. Don't infer acceptance from silence. Without a UI, create the ADR as `proposed`; subagents also create only proposed ADRs.

## Tool actions

`adr_manage` takes one `action` per call:

- `create`: `title` and `sections` with `context`, nonempty `options` and `outcome`; optional `drivers`, `consequences`, `confirmation`, `pros_cons`, `more_info`, `decision_makers`, `consulted`, `informed` and `status` (default `proposed`).
- `revise`: replaces the whole body of a proposed ADR and can change its title. Accepted ADRs are never rewritten.
- `set_status`: main agent only; `accepted`, `rejected` or `deprecated`. A superseded ADR keeps its status.
- `supersede`: main agent only; replaces an accepted or deprecated ADR with a new accepted successor and links both ways. Get the user's explicit agreement first.
- `note`: appends dated `text` under More Information. Subagents may add notes.

Subagents cannot accept, reject, deprecate or supersede; a subagent that needs one of these returns the decision to the main agent. A `stage` link is accepted only by `create` and `supersede`, and only when the roadmap plugin is installed: it validates that the stage exists. Without it, omit `stage`.

`/adr new` and `/adr supersede <id>` are the user asking you to interview them. Gather facts from the repository first, skip questions already answered, ask focused questions, show the draft, then write it with `adr_manage`.

## Body text

Use the tool-owned body subset: plain paragraphs, flat bullet or ordered lists with single-line text items, and fully closed top-level backtick or tilde fences. Ordinary punctuation is allowed: `~20%`, `snake_case`, `quantity * unit price`, URLs with underscores or tildes, and comparisons such as `x < y` and `x > y`. A `<` immediately followed by an ASCII letter, `/`, `!` or `?` is refused; a `>` cannot begin a line. Inline emphasis delimiters are allowed. Same-line inline code spans are allowed only when equal-length backtick runs close on that line. Considered options and other single-line fields follow the same rules but cannot contain lists or fences. Raw HTML, comments, Markdown links and reference definitions, square brackets, backslash escapes, headings, quotes, tables, thematic breaks, nested lists, indented code, tabs outside fences and ambiguous constructs are refused without changing any file. Put literal Markdown or HTML examples inside a closed fence instead of retrying container tricks. Separate a plain paragraph after a list with a blank line.

## Legacy files

Repositories that kept ADRs with the roadmap plugin 0.4.0 or earlier work as they are: the plugin reads those files transparently. Any write that touches a file rewrites it in the adr format, and the first write also converts `docs/adr/README.md`. Untouched files keep their bytes. There is no upgrade command and nothing to do by hand.

## Consistency

Use `adr_check`, or ask the user to run `/adr check`, after an interrupted write or a user edit. It checks parse errors, ids and filenames, supersession links and the generated index; `fix: true` regenerates only the index. **Check cannot tell whether the code follows the decisions.** Stage references are checked by the roadmap plugin.

The per-turn context shows counts by status and up to five proposed ADRs. It is a pointer, not the decision text: read the ADR with `adr_status` before relying on it.
