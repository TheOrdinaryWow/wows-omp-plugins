# omo-ultrawork

An OMP-native adaptation of ultrawork keyword mode, dependency-ordered `mass-ulw`, adversarial `/hyperplan`, and saturation `/ulw-research`. Install from the marketplace:

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

No plugin runtime dependencies are installed. The research helper scripts are dependency-free Node CLIs and require `node` on PATH when `/ulw-research` produces a report. The scripts are vendored under `assets/ulw-research/scripts/` and are invoked using the absolute assets directory supplied by the command.

## Keyword and session behavior

Writing `ulw` or `ultrawork` as a standalone word in ordinary user input injects the full hidden directive before the user's own text on the first trigger. The visible reply begins `ULTRAWORK MODE ENABLED!`. Subsequent keyword triggers in that session inject only a short reminder because the directive remains in context. After compaction, the next trigger re-injects the full directive. `/ultrawork` and `/ulw` toggle persistent mode: entering queues the full hidden directive and optionally submits command arguments as the next user message (for example, `/ultrawork fix X`); while on, **every** ordinary user input injects a reminder, or the full directive after compaction, without needing a keyword. Repeating either command turns the mode off and queues a hidden exit notice. The footer shows `Ultrawork mode` while enabled or `Ultrawork armed` after keyword arming, and clears on exit or an unarmed session switch. Mode, arming, and reminder state persist in session entries and restore on session resume, switching, branching, and tree navigation; child sessions and extension-origin messages are ignored. A pasted complete `<ultrawork-mode>…</ultrawork-mode>` block arms the session without duplication. Text inside inline code, fenced blocks, and injected directive/reminder blocks is ignored, as are slash commands.

Writing `mass ulw`, `mass-ulw`, `ulw-mass`, `mulw`, or `meth` also injects a pointer to read `skill://mass-ulw`. The `mulw` and `meth` forms do not arm ultrawork by themselves. If `todo init` or `todo append` runs while armed, one hidden fan-out reminder tells the agent to size independent work and explain its delegation decision; compaction resets that reminder.

## Mass-ulw

The model-invocable `mass-ulw` skill defines a dependency graph of `{ id, prompt, agent, dependsOn?, label? }`. Its existing eval recipe validates **all** ids, dependencies, cycles and saved statuses before any child launch, then runs one ready frontier per cell. Inspect returned reports before launching the next frontier. Status at `local://mass-ulw/<run-key>.json` and reports at `local://mass-ulw/<run-key>/<id>.md` survive a kernel reset, but a saved `running` handle cannot be reattached to `wait`; reconcile it before dispatching more work. `done` means a child returned, not that its work passed acceptance. Selective retry/amend leave untouched `done` reports intact, and the final verification frontier establishes acceptance from evidence. Read `skill://mass-ulw` and its planning reference before use. Independent work without dependency edges should use one plain `task` batch.

## User-only commands

`/hyperplan <request>` launches the prompt for a five-role, three-round adversarial debate and a separate planner handoff. Skeptic uses `task`, validator uses `task` with `effort: "hi"`, and researcher, architect, and creative use `deep-low`, `ultrabrain`, and `artistry` respectively when listed in the task tool description. If `deep-low` is unavailable, the debate runs with four roles; unavailable `ultrabrain` and `artistry` use `task`. The planner uses `ultrabrain` or `task`. It prints `HYPERPLAN MODE ENABLED!` as the first visible line.

`/ulw-research <request>` starts a claim-graph research procedure with expansion, counter-search, cited synthesis, ordered QA gates, and a checked deliverable. Mechanical work uses `sonic`, bounded judgment uses `task`, and high-effort work uses `task` with `effort: "hi"`. `scout` handles local discovery; `librarian` if listed (otherwise `scout`) handles source research; `writing` if listed (otherwise `task`) proofreads. Other category agents fall back to `task`. Report scripts operate on an absolute scratch directory under the system temporary directory by default (`<tmpdir>/ulw-research/`), or under the configured `researchScratchDir`; the final output goes to the user's requested destination. It prints `ULW-RESEARCH MODE ENABLED!` as the first visible line.

`/hyperplan` and `/ulw-research` reject empty requests with a usage warning; all commands run only in the main session. Their procedures live in private prompt assets, not OMP skills: they are **not** discoverable through `skill://` or `/skill:` and cannot be invoked by a child or the model. `mass-ulw` is the only exposed skill. Install `omo-toolkit` for named category agents and `omo-prometheus` for the reviewed `/prometheus` plan option. A qualifying heavy review follows its controlling plan: independent compliance, code-quality and real-surface QA reports may run in parallel; the final evidence-gate reviewer starts only after those reports are available. Do not add a second review pipeline beside an approved plan. Light work uses scoped self-review and real-surface proof without that fan-out. `metis` stays within Prometheus planning, and `momus` performs only explicit Atlas compliance verification outside planning. The documented fallbacks keep each command usable when those categories are unavailable.

## Settings

The installed package name for `omp plugin config` is `wows-omp-plugin-omo-ultrawork`:

```bash
omp plugin config list wows-omp-plugin-omo-ultrawork
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
```

| Setting | Type | Default | Effect |
| ------- | ---- | ------- | ------ |
| `keywordTrigger` | boolean | `true` | When false, typed keywords do not arm or inject ultrawork; the mass-ulw pointer still works. Commands remain available. |
| `keywords` | comma-separated string | `ulw,ultrawork` | Case-insensitive whole-word triggers outside quoted regions; an empty string disables keyword triggering. |
| `researchScratchDir` | string | empty (`<tmpdir>/ulw-research`) | Root for research session scratch files; relative paths resolve against the active session's cwd. |

Settings are read for each session at `session_start` (and reloaded on session switch); restart the session after changing them.

## Licenses

Extension code and original packaging use MIT; modified prompt assets and vendored upstream research scripts use SUL-1.0. See `NOTICE`, `LICENSE-MIT`, and `LICENSE-SUL-1.0` for terms and attribution.
