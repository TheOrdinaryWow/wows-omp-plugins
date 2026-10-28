<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-dark.png">
  <img alt="omo-ultrawork" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-light.png">
</picture>

# omo-ultrawork

English | [简体中文](README.zh.md)

A port of the ultrawork workflow from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) to OMP. Type `ulw` in a request and the agent works toward the outcome: it carries the request through to the end and backs each success criterion with observed evidence. The plugin also adds `mass-ulw` for dependency-ordered subagent work, `/ulw-loop` for durable goal-driven execution, `/hyperplan` for adversarial planning, and `/ulw-research` for cited research reports.

## Install

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

Requires OMP 18.12.0 or newer. The research helpers need Node 20+ or Bun on `PATH`. Browsers, document converters, fonts, and chart tools are optional and used only when a task needs them. Restart after the first install.

## Quick start

```text
ulw fix the flaky upload test and make CI green
/ulw                               # keep ultrawork on for every message
/hyperplan migrate auth to OAuth   # debate a plan before writing it
/ulw-loop deliver a restart-safe upload CLI with observable acceptance criteria
/ulw-research compare SQLite WAL and rollback journal for our workload
```

The first reply in ultrawork mode starts with `ULTRAWORK MODE ENABLED!`. The footer shows `Ultrawork armed` or `Ultrawork mode`.

## Usage

### Ultrawork mode

Type `ulw` or `ultrawork` as a standalone word to arm ultrawork for that message. Later triggers in the same session get a short reminder, and after compaction the full directive comes back.

These do not arm it: code, quoted text, blockquotes, URLs, relay headers, negations such as `Do not use ulw`, and words attached to a path or identifier such as `.omo/ulw/`, `/ulw-plan`, or `mass-ulw-refactor`. The explicit `/ultrawork` and `/ulw` commands always work.

The directive attaches to the same input, including a queued message and its images, so it never interrupts work that is already running. Full keyword and delivery rules are in [REFERENCE.md](REFERENCE.md).

`/ulw` or `/ultrawork` turns on persistent mode, so every message runs in ultrawork without a keyword. Run the command again to turn it off. `/ultrawork <request>` turns the mode on and sends the request as your next message.

The footer shows `Ultrawork mode` in persistent mode and `Ultrawork armed` after a keyword trigger. Both states are saved in the session and restored on resume, switch, branch, and tree navigation.

The original is documented in [Ultrawork Mode](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/overview.md#ultrawork-mode-for-the-lazy).

### Do not combine with `orchestrate`

OMP's built-in `orchestrate` keyword adds rules that conflict with ultrawork on commits, verification, and delegation. When a message contains an `orchestrate` that OMP acts on, the plugin adds nothing for that message and shows a warning. Persistent mode resumes with the next message. `/ultrawork orchestrate …` refuses to turn persistent mode on.

If you use ultrawork often, turn off the built-in keyword:

```bash
omp config set magicKeywords.orchestrate false
```

### mass-ulw

`mass-ulw` is a skill that runs a dependency graph of subagent tasks (`{ id, prompt, agent, dependsOn?, label? }`) through `eval`. Before it launches anything, it checks ids, dependencies, and cycles. It runs the ready nodes in batches and reads each batch's reports before starting the next one. A final step checks the evidence, because a finished child is not yet accepted work. Status and reports survive a kernel reset.

Typing `mass ulw`, `mass-ulw`, `ulw-mass`, `mulw`, or `meth` points the agent to the skill. `mulw` and `meth` do not arm ultrawork on their own. For independent tasks with no dependencies, one plain `task` batch is simpler.

The original is documented in [Dependency graphs: mass-ulw](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#dependency-graphs-mass-ulw).

### /ulw-loop

`/ulw-loop <objective>` authorizes a durable loop. It creates one native OMP goal owned by this plugin and submits the cached `ulw-loop` skill. OMP's goal controller handles continuation, budgets, and pausing. The plugin handles subgoals, criteria, attempts, steering, and evidence. A bare SDK session gets no continuation controller from this plugin.

- `/ulw-loop` or `/ulw-loop status` shows the status.
- `/ulw-loop pause`, `resume`, and `stop` act on this loop only.
- `/ulw-loop reset`, typed by the user, archives the loop's state and evidence.

Stop is not success, and it does not cancel child agents. A session holds one loop. A completed loop is read-only, so start a new session for unrelated work. Turning off ordinary `/ulw` does not stop the loop.

Final acceptance needs every current criterion, any batch gates, real-surface or source QA, and a PASS review from a separate child of this session. Failed goals retry only with `retryFailed:true`. Blocked or empty work is not success. In a Git repository, evidence capture and completion require clean tracked files. The plugin never stashes or resets your work. The full contract is in the [loop contract](REFERENCE.md#durable-loop-contract).

Plan Mode, `/audit`, and unrelated native goals keep their ownership. Resume refuses a foreign driver, and only an explicit `/ulw-loop resume` rebuilds a missing or completed driver. An approved Atlas plan is a separate workflow, so a loop does not create subtasks from it.

### Natural-language entry pointers

`ulw plan`, `ulw-plan`, and `ulwplan` suggest entering `/prometheus <request>` when `omo-prometheus` is installed. They never turn on Plan Mode. Loop phrasing points to `/ulw-loop` and `skill://ulw-loop`. Research discussion points to `/ulw-research`.

A clear request that starts the sentence, such as `use ulw research to compare X`, runs the same research procedure as the command. Questions, quoted text, negations, and identifier or path lookalikes do not count as requests.

### /hyperplan

`/hyperplan <request>` runs three rounds of debate among five critics. Each critic attacks the draft from one angle: needless complexity and scope creep, integration gaps and edge cases, unverified assumptions, architecture flaws, or missed alternatives. A separate planner then writes the plan from the result. The first line is `HYPERPLAN MODE ENABLED!`.

The original is documented in [Adversarial alternative: /hyperplan](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#adversarial-alternative-hyperplan).

### /ulw-research

`/ulw-research <request>` builds a cited report. It collects sources in parallel, builds a machine-readable claim graph, expands and counter-searches leads, and passes the result through delivery gates. The first line is `ULW-RESEARCH MODE ENABLED!`.

The procedure is private and runs on OMP's native agents. It is not a skill the model can load. If an active `ulw-loop` owns the goal, research uses that loop's goals and evidence. Otherwise research keeps its own journal and creates no loop or native goal.

The five gates run in order: static, fidelity and meaning, layout, visual, and proofreading. Fidelity and the meaning of changed sentences are checked again after polish. A full report needs rendered visuals with descriptive alt text. Each delivered edition needs its own fidelity check. A used-up repair budget never excuses an open fidelity blocker or a major defect.

Ordinary static sources are read natively and saved as immutable snapshots. Browser evidence is required when a claim depends on rendering, login or access state, interaction, or visual state. Browser-captured HTML or text keeps its real extraction origin and is never fetched again as a substitute. This is an intentional difference from upstream OmO.

Research journals go to `<tmpdir>/ulw-research/` or `researchScratchDir`. Final files go where you ask for them. The plugin caches its research scripts at load time, so a plugin upgrade does not break a running session. Storage details are in [REFERENCE.md](REFERENCE.md).

Research fidelity sources are pinned to [oh-my-openagent 8a8db1d](https://github.com/code-yeongyu/oh-my-openagent/tree/8a8db1d3094da8743989bf693ee5de77889de50e/packages/shared-skills/skills/ulw-research).

`/hyperplan` and `/ulw-research` reject an empty request and run only in the main session.

## Settings

Use this package name with `omp plugin config`: `wows-omp-plugin-omo-ultrawork`.

```bash
omp plugin config list wows-omp-plugin-omo-ultrawork
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
```

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `keywordTrigger` | boolean | `true` | When false, typed keywords do not arm ordinary ultrawork. Workflow pointers, binding research requests, and explicit commands still work. |
| `keywords` | comma-separated string | `ulw,ultrawork` | Case-insensitive literal triggers with workflow, path, and identifier guards. An empty string turns off generic keyword triggering only. |
| `researchScratchDir` | string | empty (`<tmpdir>/ulw-research`) | Root for research scratch files. Relative paths resolve against the session's working directory. |

Settings are read when a session starts or switches, so restart the session after you change them.

## Working with other plugins

- With `omo-toolkit` installed, `/hyperplan` and `/ulw-research` use its category agents (`deep-low`, `ultrabrain`, `artistry`, `librarian`, `writing`). Without it, they fall back to `task` and `scout`. `/hyperplan` runs with four critics when `deep-low` is missing. Every command still works.
- With `omo-prometheus` installed, an approved `/prometheus` plan controls the work, and ultrawork does not write a second plan.

## Without the terminal UI

The keyword and all commands work in RPC, ACP editors, the SDK, and headless runs. None of them needs a dialog. Without a UI, usage errors and mode changes appear as visible session messages.

Client programs can read the current mode from a state snapshot. See the [reference](REFERENCE.md#state-snapshot).

## Known limitations

- Keywords in messages that extensions generate, and in child sessions, are ignored.
- `/hyperplan` and `/ulw-research` are private prompts, not public skills. Natural-language research uses the private payload directly. The public skills are `mass-ulw` and `ulw-loop`.
- Durable loops need a persisted session. Research also works with `--no-session`, but its temporary asset copy is not durable.
- A loop does not turn on goal continuation settings, and it does not bypass the host's budget, Plan Mode, or user-pause rules.

## Reference

[REFERENCE.md](REFERENCE.md) covers keyword and delivery rules, the agents each command uses, `mass-ulw` persistence, the durable loop contract, and the state snapshot.

## License

Extension code and original packaging are MIT. Modified prompt assets and the vendored research scripts are SUL-1.0. See `NOTICE`, `LICENSE-MIT`, and `LICENSE-SUL-1.0`.
