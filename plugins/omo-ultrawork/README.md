# omo-ultrawork

An OMP-native adaptation of ultrawork keyword mode, dependency-ordered `mass-ulw`, adversarial `/hyperplan`, and saturation `/ulw-research`. Install from the marketplace:

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

No plugin runtime dependencies are installed. The research helper scripts are dependency-free Node CLIs and require `node` on PATH when `/ulw-research` produces a report. The scripts are vendored under `assets/ulw-research/scripts/` and are invoked using the absolute assets directory supplied by the command.

## Keyword and session behavior

Writing `ulw` or `ultrawork` as a standalone word in ordinary user input injects the full hidden directive before the user's own text on the first trigger. The visible reply begins `ULTRAWORK MODE ENABLED!`. Subsequent triggers in that session inject only a short reminder because the directive remains in context. After compaction, the next keyword re-injects the full directive. Arming and reminder state persist in session entries and restore on session resume, switching, branching, and tree navigation; child sessions and extension-origin messages are ignored. A pasted complete `<ultrawork-mode>…</ultrawork-mode>` block arms the session without duplication. Text inside inline code, fenced blocks, and injected directive/reminder blocks is ignored, as are slash commands.

Writing `mass ulw`, `mass-ulw`, `ulw-mass`, `mulw`, or `meth` also injects a pointer to read `skill://mass-ulw`. The `mulw` and `meth` forms do not arm ultrawork by themselves. If `todo init` or `todo append` runs while armed, one hidden fan-out reminder tells the agent to size independent work and explain its delegation decision; compaction resets that reminder.

## Mass-ulw

The model-invocable `mass-ulw` skill defines an acyclic graph of `{ id, prompt, agent, dependsOn?, label? }`, runs ready children in eval-kernel waves, and records status at `local://mass-ulw/<run-key>.json` with results at `local://mass-ulw/<run-key>/<id>.md`. It supports selective retry, amend, IRC steering, and a final verification frontier. Read `skill://mass-ulw` and its planning reference before using it. Independent work without dependency edges should use one plain `task` batch.

## User-only commands

`/hyperplan <request>` launches the prompt for a five-role, three-round adversarial debate and a separate planner handoff. Skeptic uses `task`, validator uses `task` with `effort: "hi"`, and researcher, architect, and creative use `deep-low`, `ultrabrain`, and `artistry` respectively when listed in the task tool description. If `deep-low` is unavailable, the debate runs with four roles; unavailable `ultrabrain` and `artistry` use `task`. The planner uses `ultrabrain` or `task`. It prints `HYPERPLAN MODE ENABLED!` as the first visible line.

`/ulw-research <request>` starts a claim-graph research procedure with expansion, counter-search, cited synthesis, ordered QA gates, and a checked deliverable. Mechanical work uses `sonic`, bounded judgment uses `task`, and high-effort work uses `task` with `effort: "hi"`. `scout` handles local discovery; `librarian` if listed (otherwise `scout`) handles source research; `writing` if listed (otherwise `task`) proofreads. Other category agents fall back to `task`. Report scripts operate on an absolute scratch directory under `.omp/tmp/ulw-research/`, while the final output goes to the user's requested destination. It prints `ULW-RESEARCH MODE ENABLED!` as the first visible line.

Both commands reject empty requests with a usage warning and run only in the main session. Their procedures live in private prompt assets, not OMP skills: they are **not** discoverable through `skill://` or `/skill:` and cannot be invoked by a child or the model. `mass-ulw` is the only exposed skill. Install `omo-toolkit` for the named category and reviewer agents and `omo-prometheus` for the reviewed `/prometheus` plan option; the documented fallbacks keep each command usable when those plugins are absent.

## Licenses

Extension code and original packaging use MIT; modified prompt assets and vendored upstream research scripts use SUL-1.0. See `NOTICE`, `LICENSE-MIT`, and `LICENSE-SUL-1.0` for terms and attribution.
