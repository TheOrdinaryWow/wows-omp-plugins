> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Planning a mass-ulw run

Read this reference in full before defining a graph. Plan its topology, wave sizes, reasons for agent choices, disjoint write scopes, and final verification. One run is one stage, not an entire multi-stage project; between stages synthesize the verified previous outputs and write a new run definition.

## Decompose before routing

Enumerate the independently deliverable components first. Split components by disjoint file domain, research territory, or phase, not by arbitrary worker count. Start with `sonic` for mechanical work, `task` for bounded judgment and integration within the graph, `deep-low` for difficult evidence-led diagnosis, `deep-high` for an unresolved trade-off, and at most one `ultrabrain` for a genuinely hard central decision. For high-effort integration that needs `effort: "hi"`, dispatch a `task` batch outside the eval graph and use its verified result to define the next stage; the eval `agent()` runner cannot pass effort. `visual-engineering` owns UI/design and `writing` owns prose. Route git-only work to `task` with `read skill://git-master` in its prompt when the skill is available. If another named category agent is not listed in the task tool description, use `task`. Explain each non-`sonic` choice in one sentence.

Do not split one coherent judgment or split work so finely that briefing costs more than execution. When parallel lanes would edit the same files, serialize or merge them; `dependsOn` must represent real ordering, never data you already know. A fan-out wave followed by one synthesis node is the default useful graph. Two independent nodes with no dependency are just one ordinary `task` batch, not a graph. Every implementation node owns its change and its own narrow check; a later independent verification node tests the integrated result.

Choose wave width by natural independence and OMP's `task.maxConcurrency` setting; excess ready children queue. A wide harvest may have dozens of cheap lanes, but bounded aggregators should reduce their reports so no single planner ingests all raw output. For thousands of source items, shard batches among children and require compact per-child reports. `task.maxConcurrency` limits simultaneous work, not correctness or the number of defined nodes.

## Self-contained node prompt

The worker sees none of the parent's conversation. Include these labels in order:

1. **TASK**: one imperative assignment.
2. **DELIVERABLE**: exact changed files or bounded report and its evidence.
3. **SCOPE**: exact files the worker may read/write, with forbidden overlap named.
4. **VERIFY**: literal command/action and binary pass observable.
5. **STOP WHEN**: the terminal condition.

Paste all facts a worker needs. Preserve only actionable context, and state uncertainty rather than silently elevating assumptions. A worker should report failure and evidence, not call itself successful because it returned text.

Before starting, check duplicate ids, unknown dependencies, cycles, parallel write conflicts, and that the verification frontier depends on every producer. `dependsOn` does not interpolate earlier output into later prompts: when a later stage needs discoveries, create its definition after reading the previous stage's results.

## Waves, synthesis, and research

The eval cell in `skill://mass-ulw` computes a ready frontier from all-`done` dependencies, launches that frontier concurrently through `agent()`, records `agent://` handles and results under `local://mass-ulw/<run-key>/`, and marks dependents of a failed node skipped. `wait(handles, raise_errors=False)` isolates failures. Read the status JSON and child report paths between waves; steer live children over IRC. For work whose scope changes based on a discovery, stop at a synthesis boundary and write a new graph instead of mutating a running node silently.

For mass research, first read the user-only `/ulw-research` procedure when it is available through the command (a model cannot invoke that command); the user must invoke `/ulw-research` to activate that workflow. If the user asks for mass-ulw research without that command, apply its epistemic principles explicitly: open breadth across source territories, collect EXPAND leads, run further waves from those leads, counter-search high-risk claims, and reduce bounded digests through parallel `architect` agents (if absent use `task`) before a final reducer. Do not make a single opening wave the entire research result.

## Verification and recovery

Every code-changing graph has a last verification node dependent on all producers. That child executes actual commands, compares observed results against the success criteria, and reports failures with output. For PDF, DOCX, slides, or print HTML, render and inspect every page; existence or page count is not visual proof. Check the artifact and claims of each completed node before relying on them downstream.

On failure inspect the node's `error` and output first. Reset only the failed node and its skipped transitive dependents to `pending` for retry. For a changed definition, reset changed nodes and their transitive dependents; untouched `done` nodes reuse their reports. A running child can receive `write agent://<handle>`; `read agent://<id>` retrieves output. If the eval kernel restarted with nodes still marked `running`, re-establish their observed status before a retry; do not assume durable JSON means the child is still alive. Never cancel a quiet child merely because it has not reported yet. End the run when verified evidence fulfills the goal, not when a status table happens to contain only `done`.
