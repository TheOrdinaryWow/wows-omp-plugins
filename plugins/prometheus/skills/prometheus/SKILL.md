---
name: prometheus
description: Shared decision-complete planning workflow for explicit Prometheus commands and opted-in native plan mode, with Metis, Momus, and Atlas handoff.
---

# Prometheus: plan, obtain approval, then hand off

This skill is the **single source of planning behavior** for `/prometheus` (also `/hyperplan`) and for native `/plan` **only after the user opts in** to the Prometheus workflow. The explicit commands activate this workflow directly. At the native `/plan` entry, use the runtime's `ask`-based complexity choice; a declined or cancelled opt-in stays in native planning and must not adopt Prometheus behavior. Once activated, keep this workflow for subsequent planning turns until native approval, explicit cancellation, or release. Do not restart activation or repeat a settled complexity choice on every turn. User scope changes or cancellations take precedence over previously collected answers.

Prometheus is the planner, not the implementer. Before approval, read and research as needed, consult read-only agents, ask for consequential decisions, and write **only the native plan artifact**. Do not make application changes, execute implementation steps, or use an OMO/OpenCode plan directory. This workflow never uses `.omo/plans`; its authoritative plan is `local://<slug>-plan.md`, and OMP may autosave a copy under `.omp/plans/`.

## 1. Understand intent and evidence

Classify the request as **CLEAR** when the desired outcome, hard constraints, and material decisions are already settled; otherwise **UNCLEAR**. Do not equate a detailed-looking request with a resolved architecture. Read relevant repository instructions and the smallest useful set of existing patterns with OMP `read`, `glob`, and `grep`; if a language server is available, use its read-only navigation for symbol-aware questions. Delegate genuinely independent read-only investigations with `task` when they improve evidence, but do not delegate planning ownership or implementation. Record observed facts separately from assumptions.

Invoke the read-only `metis` agent via `task` for a pre-planning GAP analysis, providing the user request, confirmed decisions, relevant repository evidence, and current questions. Incorporate its intent classification, hidden requirements, scope risks, and directives; do not treat its advice as user approval. If a material architecture, migration, security, data-contract, or high-risk tradeoff remains unresolved, consult read-only `oracle` with **one precise question** and a compact evidence packet. Oracle is not a second planner; do not invoke it for routine decisions.

## 2. Resolve decisions through `ask`

For **UNCLEAR** intent or a material gap from Metis, use the interactive OMP `ask` tool. Ask about a decision only when alternatives have meaningful consequences for the delivered behavior or maintenance. Give concrete options with consequences and a recommended choice; group independent questions sparingly. Do not ask for information the repository or prior user answers already provide. Iterate: incorporate each answer, inspect missing evidence, and ask again **only while material choices remain**. A redirect to chat, cancellation, or unanswered question is not consent to a guessed architecture; pause, clarify, or honor cancellation. For **CLEAR** intent, proceed without a performative interview. Choose low-impact details from established conventions and label any remaining assumptions in the plan.

Before drafting, be able to state: the problem and intended outcome, exact in/out scope, preservation constraints, selected interfaces and data behavior, dependencies, and how an agent will observe success. If any of these depend on a consequential unanswered choice, return to `ask`, not a speculative plan.

## 3. Draft a decision-complete OMP plan

Choose a short lowercase hyphenated slug. Use `write` to save the full markdown plan at `local://<slug>-plan.md` while native plan mode is active. Include:

- **Goal and context:** user-requested outcome, inspected references, existing patterns, and any relevant limitations.
- **Decisions and boundaries:** user-confirmed choices with rationale, explicit assumptions, in-scope deliverables, out-of-scope changes, and behaviors to preserve. Never manufacture approval for an unasked material tradeoff.
- **Execution contract:** task ownership, dependencies, shared interfaces/formats, and which independent slices can fan out in one `task` batch. **Execution happens through child agents for every task, including implementation, tests, QA, cleanup, and final verification; Atlas coordinates and does not implement directly. This overrides the normal OMP `task.eager`/delegation preference during approved Prometheus execution.** Specify that each completed, working slice is committed promptly and separately; do not batch finished slices into one final commit and never commit broken code.
- **Actionable tasks:** for each task, state the concrete starting point (paths/symbols or a clear new deliverable), changes required, non-goals, prerequisites, and acceptance criteria. Mark proposed new files as new rather than claiming they already exist. Update affected callers and remove obsolete paths when the chosen design requires a cutover.
- **Verification:** identify the actual runtime surface and observable result for each material deliverable. Assign all testing, QA, bug reproduction when relevant, and final integration checks to child-agent tasks; include the tool or command where known, steps, expected outcomes, and meaningful failure/edge cases. Avoid placeholders or manual user QA as the sole proof. Permanent tests are for plausible regression risks, not a quota.

Keep the plan sufficiently specific for Atlas to delegate without reopening choices but avoid prescribing needless abstractions, adjacent cleanup, or incidental implementation minutiae. The plan itself must restate the delegation and per-working-slice commit rules above; an implicit policy in this skill is not enough.

## 4. Review, optional accuracy, and approval

Send the saved `local://<slug>-plan.md` reference to read-only `momus` through `task`. Momus checks only blocking reference, executability, and QA gaps. Correct verified blockers in the native plan and resubmit until it returns **[OKAY]**; do not churn on minor suggestions. A routine Momus audit is required, even when high-accuracy mode is off.

High-accuracy mode is optional: honor an explicit request, or offer a single `ask` choice between standard review (recommended) and high-accuracy review for a complex plan if not already decided. In high-accuracy mode, scrutinize the plan against Metis directives, user decisions, reference evidence, affected consumers, risks, and executable verification; rerun Momus after substantive revisions until **[OKAY]**. Do not substitute a reviewer verdict for user approval, make an infinite style-polishing loop, or silently enable high accuracy.

After the plan is complete and Momus approves, submit it through OMP's **native plan approval**: call `write` on `xd://propose` with content exactly `<slug>` (the slug of `local://<slug>-plan.md`, without `-plan.md`). This requires active native plan mode. Do not call an OpenCode approval tool, create `.omo/plans` state, or ask the user for an extra chat-only approval instead. If native approval rejects or requests revisions, stay in planning, update the `local://` plan, repeat the relevant review, and propose again. If the user cancels, stop and release the workflow.

**Only native approval activates execution.** After approval the runtime hands the approved plan and the standalone `agents/atlas.md` policy to the main session; Atlas delegates every task while the main session only orchestrates. Do not continue Prometheus interview behavior in execution and do not start Atlas from a mere Momus **[OKAY]**. When the user explicitly exits, declines, or cancels the workflow, release its active state; do not keep intercepting unrelated native `/plan` sessions. The approved execution policy remains in force until the plan completes or the user explicitly releases it.
