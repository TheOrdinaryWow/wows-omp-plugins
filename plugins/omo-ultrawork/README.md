<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-dark.png">
  <img alt="omo-ultrawork" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-light.png">
</picture>

# omo-ultrawork

English | [简体中文](README.zh.md)

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO)'s ultrawork workflow, adapted for OMP. Typing `ulw` in a request switches the agent into outcome-first execution: it delivers the request end to end and backs success criteria with observed evidence. The plugin also adds `mass-ulw` for dependency-ordered fan-out, `/ulw-loop` for durable native-goal execution, `/hyperplan` for adversarial planning, and `/ulw-research` for source-faithful research reports.

## Install

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

Requires OMP 18.10.4 or newer. Research helpers run with Node 20+ or Bun on `PATH`; optional browsers, document converters, fonts, and chart tools are task-scoped capabilities, not plugin runtime dependencies. Restart after initial installation.

## Quick start

```text
ulw fix the flaky upload test and make CI green
/ulw                               # keep ultrawork on for every message
/hyperplan migrate auth to OAuth   # debate a plan before writing it
/ulw-loop deliver a restart-safe upload CLI with observable acceptance criteria
/ulw-research compare SQLite WAL and rollback journal for our workload
```

The first reply in ultrawork mode starts with `ULTRAWORK MODE ENABLED!`, and the footer shows `Ultrawork armed` or `Ultrawork mode`.

## Usage

### Ultrawork mode

Typing `ulw` or `ultrawork` as a standalone workflow word attaches the ultrawork directive to your input. Later triggers use a short reminder; after compaction the full directive returns. Code, blockquotes, ordinary quoted spans, relay headers, URLs, negated invocations and path/identifier neighbours do not count: `Do not use ulw`, `"ulw"`, `.omo/ulw/`, `/ulw-plan` and `mass-ulw-refactor` do not arm it. Explicit `/ultrawork` and `/ulw` retain their command authorization.

Instructions are transformed onto that same input, including a queued input and its images, rather than sent as an aside into work already running. After the first successful todo `init` or `append` while armed, a fan-out reminder is attached to the tool result once; compaction rearms it.

`/ultrawork` or `/ulw` turns on persistent mode, so every message gets ultrawork without a keyword. Run either command again to turn it off. `/ultrawork <request>` turns the mode on and sends the request as your next message.

The footer shows `Ultrawork mode` while persistent mode is on and `Ultrawork armed` after a keyword trigger. Mode and arming are saved in the session and restored on resume, switching, branching and tree navigation.

OmO documents the original in [Ultrawork Mode](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/overview.md#ultrawork-mode-for-the-lazy).

### Do not combine with `orchestrate`

OMP's built-in `orchestrate` keyword injects its own rules, which contradict ultrawork on commits, verification and delegation. When a message contains an `orchestrate` that OMP would act on, this plugin injects nothing for that message and shows a warning; persistent mode resumes with the next message. `/ultrawork orchestrate …` refuses to turn on persistent mode. If you use ultrawork regularly, disable the built-in keyword:

```bash
omp config set magicKeywords.orchestrate false
```

### mass-ulw

`mass-ulw` is a skill for running a dependency graph of subagent tasks (`{ id, prompt, agent, dependsOn?, label? }`) through `eval`. It validates ids, dependencies and cycles before launching anything, runs one batch of ready nodes at a time, and reads their reports before the next batch. A final verification step checks the evidence, since a finished child is not yet accepted work. Status and reports survive a kernel reset.

Typing `mass ulw`, `mass-ulw`, `ulw-mass`, `mulw` or `meth` points the agent at the skill; `mulw` and `meth` do not arm ultrawork on their own. For independent work without dependencies, one plain `task` batch is simpler.

OmO documents the original in [Dependency graphs: mass-ulw](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#dependency-graphs-mass-ulw).

### /ulw-loop

`/ulw-loop <objective>` authorizes a durable loop and creates one owned OMP native goal, then submits the cached `ulw-loop` skill. OMP's TUI/RPC goal controller owns continuation, budgets and pause behavior; the plugin owns subgoals, criterion definitions, attempts, steering and evidence. A bare SDK does not gain a continuation controller from this plugin.

Use bare `/ulw-loop` or `/ulw-loop status` for status, `/ulw-loop pause|resume|stop` to manage only this loop, and explicit user-only `/ulw-loop reset` to archive its state/evidence. Stop is not success and does not cancel child agents. One aggregate belongs to one session; completed state is read-only, so unrelated work uses a new session. Turning ordinary `/ulw` off does not stop the loop.

The `ulw_loop` tool reads the authoritative brief file and accepts typed goals/criteria. `complete_goals` acquires or resumes one eligible goal; it does not declare completion. Failed goals retry only with `retryFailed:true`, and blocked/no-eligible work is not success. Non-final checkpoints need fresh essential criteria. Final acceptance needs every current criterion, any declared batch gates, real-surface/source QA and a PASS criterion/goal review from a distinct child of this session.

State version 1 lives at `<sessionDir>/ulw-loop/<sessionId>/state.json`, with copied/hash-checked evidence in its `evidence/` subtree and one atomic journal/state transaction. `--no-session` is refused with `ULW_LOOP_PERSISTENCE_REQUIRED`; no durable loop files are written into the project or disguised temporary storage. In Git repositories, evidence capture and completion require clean tracked files and bind the full `HEAD^{tree}`: an identical tree after rebase/amend stays fresh, but changed bytes require fresh captures. The plugin never stashes or resets. Non-Git research uses source/report artifact hashes instead.

Plan Mode, `/audit` and unrelated live/paused native goals retain ownership: start/resume refuses a foreign driver, and a changed, paused, budget-limited, dropped or prematurely completed driver leaves unfinished criteria paused. Only explicit user `/ulw-loop resume` may recreate a missing/completed driver. An approved Atlas plan remains a separate controlling workflow, not a source of loop subtasks or a second notepad. See the [loop contract](REFERENCE.md#durable-loop-contract).

### Natural-language entry pointers

`ulw plan`, `ulw-plan` and `ulwplan` conditionally suggest user-entered `/prometheus <request>` with `omo-prometheus`; they never activate Plan Mode. Loop spellings conditionally point to `skill://ulw-loop` and the explicit `/ulw-loop` command. Research discussion stays a pointer to `/ulw-research`, while positive leading requests such as `use ulw research to compare X` inject the same cached private procedure and pinned assets payload as the command. Mass/research composites keep one execution owner and one research procedure. Questions, quotes, negation and identifier/path lookalikes do not become binding requests.


### /hyperplan

`/hyperplan <request>` runs a three-round adversarial debate among five critics, each attacking the draft from one side: needless complexity and scope creep, integration gaps and edge cases, unverified assumptions, architectural flaws, and missed alternatives. A separate planner then turns the outcome into a plan. Its first line is `HYPERPLAN MODE ENABLED!`.

OmO documents the original in [Adversarial alternative: /hyperplan](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#adversarial-alternative-hyperplan).

### /ulw-research

`/ulw-research <request>` builds a cited research report through parallel source collection, a machine-readable claim graph, expansion/counter-search, and source-faithful delivery gates. Its first line is `ULW-RESEARCH MODE ENABLED!`. The private procedure uses native OMP agents; it is not a model-loadable skill. An explicitly active `ulw-loop` may own its goals and evidence; otherwise research keeps its existing journal lifecycle and does not create a loop or native goal.

Sources are captured as immutable snapshots with extraction provenance and hashes. Numbers and direct quotations enter a fact ledger through source locators, then reach HTML/Markdown through deterministic placeholders and fill maps. Fidelity verification checks the locked brief, source snapshots, units, derived values, quotations, sentence/claim bindings, and chart data. Each byte-distinct delivered edition needs matching verification; PDF/DOCX name the verified source they render from. Separate cheap/strong readers check source-paired meaning when the brief enables it, and a writing pass proposes protected edits rather than changing facts directly.

The five gates run static → fidelity/meaning → layout → visual → proofread, followed by fidelity and changed-pair meaning rechecks after polish. Full reports need meaningful rendered visuals and descriptive alt text. Visual reproductions include matched real-source/output comparison pairs and disclose residual differences. A repair budget does not waive unresolved fidelity blockers or major defects. OMP has no inline-HTML tool: delivery consists of standalone files, appropriate browser-inspected screenshots, a chat summary, and the helper's printed closing briefing.

**Intentional upstream deviation:** ordinary static sources use native static-first reads with immutable snapshots; browser evidence is required when a claim depends on rendering, authentication/access, interaction, or visual state. Plain `source snapshot --url` is raw fetch, not proof of browser/authenticated access. Captured browser HTML/text is imported with truthful extractor provenance, not fetched again as a substitute.

Research journals stay in `<tmpdir>/ulw-research/` or `researchScratchDir`; final artifacts go to the requested destination. At module load the plugin caches the complete research asset bundle, then validates/materializes a pinned content-addressed copy under `<sessionDir>/ulw-research-assets/<upstream-pin>-<digest>/`. An upgrade that removes the old plugin installation therefore does not remove the cached scripts or references from that running session. For `--no-session`, assets live in an owner-checked private OS temporary directory instead; that copy is explicitly non-durable and never uses the project working directory. Old outcome v1 runs remain readable with `legacy_unverified` provenance; resuming or redelivering requires current fidelity proof, not a historical exemption.

Research fidelity sources are pinned to [oh-my-openagent 8a8db1d](https://github.com/code-yeongyu/oh-my-openagent/tree/8a8db1d3094da8743989bf693ee5de77889de50e/packages/shared-skills/skills/ulw-research).

`/hyperplan` and `/ulw-research` reject an empty request and run only in the main session.

## Settings

Package name for `omp plugin config`: `wows-omp-plugin-omo-ultrawork`.

```bash
omp plugin config list wows-omp-plugin-omo-ultrawork
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `keywordTrigger` | boolean | `true` | When false, typed keywords do not arm ordinary ultrawork. Workflow pointers, binding research requests and explicit commands still work. |
| `keywords` | comma-separated string | `ulw,ultrawork` | Case-insensitive literal triggers with workflow/path/identifier guards. An empty string disables generic keyword triggering only. |
| `researchScratchDir` | string | empty (`<tmpdir>/ulw-research`) | Root for research scratch files. Relative paths resolve against the session's working directory. |

Settings are read at session start and on session switch, so restart the session after changing them.

## Working with other plugins

- With `omo-toolkit` installed, `/hyperplan` and `/ulw-research` use its category agents (`deep-low`, `ultrabrain`, `artistry`, `librarian`, `writing`); without it they fall back to `task` and `scout`, and every command still works.
- With `omo-prometheus` installed, ultrawork defers to an approved `/prometheus` plan instead of writing its own.

## Without the terminal UI

The keyword and all commands work in RPC, ACP editors, the SDK and headless runs; none of them needs a dialog. Without a UI, usage errors and mode changes appear as visible session messages.

Client programs can read the mode from a state snapshot; see the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- Keywords in messages generated by extensions, and in child sessions, are ignored.
- `/hyperplan` and `/ulw-research` remain private prompts, not public skills; natural research binding uses the private payload directly. Public skills are `mass-ulw` and `ulw-loop`.
- Durable loops require persisted sessions. Research without loop ownership also works in `--no-session`, but its temporary asset snapshot is not durable.
- A loop does not force goal continuation settings on or bypass the host's native budget/Plan Mode/user-pause rules.

## Reference

[REFERENCE.md](REFERENCE.md) covers keyword and delivery rules, the agents each command uses, `mass-ulw` persistence and the state snapshot.

## License

Extension code and original packaging are MIT. Modified prompt assets and the vendored research scripts are SUL-1.0. See `NOTICE`, `LICENSE-MIT` and `LICENSE-SUL-1.0`.
