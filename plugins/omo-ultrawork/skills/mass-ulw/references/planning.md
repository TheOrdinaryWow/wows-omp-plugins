> **Modified-port notice and license.** This reference is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace` (`packages/omo-senpi/skills/mass-ulw/references/planning.md`, with reusable-definition policy from `packages/omo-senpi/skills/dag-library/SKILL.md`). It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Planning a mass-ulw run

Read this reference in full before defining a graph. Reading is not planning: first record the topology, handoff paths, frontier widths, routing reasons, disjoint write scopes, verification, and the inspection boundaries where discoveries determine later work. One run is one coherent stage, not an entire evolving project. Define every dependency you can already specify; after an inspected stage changes the next graph's shape, write that next stage explicitly instead of improvising inside a running node.

## Decompose before routing

Enumerate independently deliverable components first, without inventing components or a minimum worker count. Split by disjoint file domain, source territory, or real stage. A small coherent judgment stays together; a piece that costs more to brief than execute stays with its neighbor. If writes overlap, serialize or merge rather than pretending independence. An implementation and its narrow proof are one deliverable; an independent integrated review is a separate role, not a second owner of the same edits.

Start with `sonic` for mechanical work, `task` for bounded judgment/integration, `deep-low` for hard evidence-led diagnosis, `deep-high` for an unresolved consequential trade-off, and at most one `ultrabrain` for a genuinely hard central judgment. Explain each non-mechanical route in one sentence. `visual-engineering` owns UI/design and `writing` owns prose; git-only work uses `task` with `read skill://git-master` in the prompt when available. Use only agents in the live task description, with `task` as the fallback for an unavailable named specialist. The eval `agent()` runner cannot pass effort; use a direct `task` assignment outside the graph when `effort: "hi"` is required, inspect it, and use its accepted output to define the next stage.

Size the frontier by natural independence and OMP's `task.maxConcurrency`, not a worker quota. Excess children queue; a wide stage can be correct without running all children simultaneously. For large harvests, shard many source items into bounded per-child reports. Reduce those through bounded aggregators so no lead or reducer must read every raw output. Fully independent work with no downstream dependency is one ordinary `task` batch, not a graph.

## Topology and acceptance joins

Fan-out followed by bounded synthesis is a useful default, not a mandatory shape. `dependsOn` represents a consumed output or a real acceptance prerequisite; a fact already known to the lead belongs directly in the consumer prompt, without a fake edge.

When **every** consumer in the next stage truly requires acceptance of **every** producer in the previous stage, use one review join: producers -> review -> consumers, rather than an all-to-all edge mesh. The review node consumes the producers' files and writes an acceptance report at a named physical path. All consumers read that report and fail on missing evidence or rejected prerequisites. This is for a real shared acceptance dependency, not graph prettification: do not add review work merely to reduce edge count, and do not make a branch-only consumer depend on unrelated producers.

A review finding targets the implicated producer; reset that producer and the consumers/review evidence its change invalidates, not all unaffected producers. The **one-inspected-frontier barrier still applies**: even a branch-only consumer waits for the whole current frontier to settle and for the coordinator to inspect it. No fast branch advances automatically and no rescue scheduler starts replacements beside unsettled writers.

## Producer/consumer files and scopes

- **Order is not transport.** Before dispatch, producer A's assignment names the exact absolute physical file it must write, and consumer B's assignment names the identical file it must read. Paste the resolved path into both prompts; do not give a child a variable or parent-local `local://` namespace it cannot resolve. Create an owned shared handoff root accessible in the actual child/isolation environment first. Keep it until its final consumer finishes.
- **Missing handoff is FAIL.** The dependency only says the producer returned, not that it wrote enough evidence. The consumer checks the file exists, is usable, and supports the exact facts it needs. Missing, empty, rejected, or insufficient data is a reported failure, never a reason to invent findings or silently fall back to the producer's completion claim.
- **Disjoint writes or serialize.** Parallel nodes may read shared files but cannot write the same files. Name read and write scopes separately, including handoff artifacts. When scopes overlap, use a real dependency or one integration owner. Do not reuse an output path while an original writer can still be active.
- **Creation-time ownership.** Record each handoff root, temporary directory, runtime cache, worktree, service, browser context, and output owner when created. Commands needing temporary/cache output get task-owned roots with explicit `TMPDIR`, `NODE_COMPILE_CACHE`, and `BUN_RUNTIME_TRANSPILER_CACHE_PATH`; independent children get independent roots. Remove only owned disposable resources after writers exit, never shared caches or worktrees/ancestors still needed by open PRs. Resource-free nodes need no ritual root or cleanup todo.

## Self-contained node prompt

The worker does not see the parent's conversation. Include these labels in order:

1. **TASK:** one imperative assignment and one role.
2. **DELIVERABLE:** exact changed files or bounded report, its physical handoff path, and evidence shape.
3. **SCOPE:** exact allowed reads/writes, neighboring ownership boundaries, relevant project rules, and any required resource ownership.
4. **VERIFY:** explicitly authorize the literal checks or real-surface actions the child must run, with concrete inputs and binary PASS/FAIL observables. Name the handoff absence/insufficiency failure condition.
5. **STOP WHEN:** the terminal observable; inability to complete is returned as a failure with evidence, not successful acknowledgement.

Paste only actionable facts and skills, state uncertainty honestly, and keep each prompt executable without hidden context. An investigator does not silently fix, and a producer's own checks are not independent acceptance. Favor clear action verbs and exact invariants rather than decorative emphasis. Machine warnings or a child's returned text do not replace the coordinator's prompt and evidence inspection.

## Preflight and main-session authorization

Before any child starts, validate the **whole** definition and state: unique safe ids, every dependency exists, no cycles, exact status coverage, valid report paths, and no saved running child awaiting reconciliation. The supplied cell performs this structural preflight. The coordinator separately checks current agent availability, scopes, physical handoff accessibility, and authorization; the cell does not prove those facts.

Only the main session asks unresolved scope, spending, or irreversible decisions through native `ask`, before starting dependent work. A child reports the need to the lead, never authorizes it, and an eval cell is not the user's decision surface. A timeout, dismissal, unavailable tool, or generic instruction to continue on best judgment is **not approval**. Continue only unaffected, already-authorized work; do not launch the dependent run/frontier. Saving a template or having executed it in the past grants no present authority.

## Execution, synthesis, and research

The eval cell in `skill://mass-ulw` validates inputs, launches **one** ready frontier through `agent()`, saves its handles and returned reports, and returns after the entire frontier settles. Inspect every report, final native outcome, and promised handoff file before invoking it again. `done` is returned text, not acceptance. A synthesis or review that needs reports belongs in a later inspected frontier, never their launch batch. Use `wait(handles, raise_errors=False)` to isolate failed children and IRC to steer active workers. A midpoint inspection serves a decision; it is not a polling loop.

For work needing ongoing dialogue, native `task` children with IRC can cooperate under a lead; choose that only when exchanging findings changes substantial work. Dependent stages that merely consume finished files are a sequence, not a reason to invent teams or another workflow runtime.

For mass research, the user-only `/ulw-research` command activates that procedure; the model cannot invoke it. Without that command, apply its epistemic principles explicitly to the authorized research: broad source territories, EXPAND leads, additional inspected harvest/expansion stages, and counter-searches for high-risk claims. Reduce bounded verified digests through `architect` agents when listed, otherwise `task`, before final synthesis. Do not impose a fixed angle count, predeclare discovery-shaped work, advance per-angle chains early, or start a failed-chain rescue run. When the research procedure is active, its evidence and delivery gates stay authoritative, including rendered inspection of paginated output.

## Reusable definitions, recovery, and verification

Keep saved input-only definitions separate from per-run status. A fresh run materializes current paths and agents under a fresh key, with all rows pending and fresh outputs. Saving a definition never starts it. Recovery explicitly retains the existing run and its evidence, then checks whether the relevant source, importers, dependencies, configuration, generated inputs, or environment invalidate any claim. Never silently treat a rerun as cached success or recovery as a fresh authorized run.

A code-changing graph ends with an independent verification node or real acceptance join consuming all relevant producers. Its assignment runs actual checks and reports exact observations against the user's criteria. A report, PDF, DOCX, deck, or print HTML is inspected through every rendered page; file existence, size, and page count are not visual proof. For each artifact record the commit when applicable, what was exercised, and relevant inputs. Preserve unaffected evidence, but do not reuse stale claims; an active loop keeps its stronger tree/attempt/revision/hash binding.

After a frontier fails, inspect the error first. Retry only named failed rows and skipped descendants, with clean pending status. For an amended materialized definition, reset changed nodes and their transitive dependents, preserving only unaffected valid reports. Update a reusable template separately for future runs. If the kernel lost live handles, reconcile the actual child results before changing saved running rows; do not launch while an original writer may still be active. A provider/route failure is not proof that a prompt is bad: stop launching, identify the observed failure, and recover the affected rows after the frontier settles. Quiet queued or running children are not dead. End when verified evidence fulfills the goal, not when the graph merely returns.
