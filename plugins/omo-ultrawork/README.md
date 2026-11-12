<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-dark.png">
  <img alt="omo-ultrawork" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-light.png">
</picture>

# omo-ultrawork

English | [简体中文](README.zh.md)

> Add `ulw` to a request and the agent sees it through to the end, with evidence that it actually works.

This plugin brings the ultrawork workflow of [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) to OMP. With ultrawork on, the agent does not stop at a plausible answer: it carries the request through and backs every success criterion with something it actually observed, such as a passing test or a working command. The plugin also adds commands for bigger jobs: `mass-ulw` runs many subagent tasks in dependency order, `/ulw-loop` keeps working toward a goal across turns until its criteria are met, `/hyperplan` has critics attack a plan before it is written, and `/ulw-research` produces a report with sources.

## Install

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

You need OMP 18.19.0 or newer. `/ulw-research` also needs Node 20 or newer, or Bun, on your `PATH`; browsers, document converters, fonts and chart tools are used only when a report needs them. Restart the session after installing.

## Quick start

```text
ulw fix the flaky upload test and make CI green
/ulw                               # keep ultrawork on for every message
/hyperplan migrate auth to OAuth   # debate a plan before writing it
/ulw-loop deliver a restart-safe upload CLI with observable acceptance criteria
/ulw-research compare SQLite WAL and rollback journal for our workload
```

In ultrawork mode, the agent's first reply starts with `ULTRAWORK MODE ENABLED!`, and the footer shows `Ultrawork armed` (this message only) or `Ultrawork mode` (every message).

## Usage

### Turn on ultrawork

Write `ulw` or `ultrawork` as a word of its own anywhere in a message to turn ultrawork on for that message. Later uses in the same session add a short reminder, and the full instructions come back after the conversation is compacted.

The word does not count inside code, quotes or block quotes, in URLs, in a negation such as `Do not use ulw`, or as part of a path or name such as `.omo/ulw/`, `/ulw-plan` or `mass-ulw-refactor`. The commands `/ultrawork` and `/ulw` always work.

To keep ultrawork on for every message, run `/ulw` or `/ultrawork`; run it again to turn it off. `/ultrawork <request>` turns it on and sends the request right away. The mode is remembered when you resume or switch sessions.

The ultrawork instructions travel with your message, including queued messages and their images, so they never interrupt work already in progress.

OmO's original description: [Ultrawork Mode](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/overview.md#ultrawork-mode-for-the-lazy).

### Don't mix it with `orchestrate`

OMP's own `orchestrate` keyword adds rules about commits, verification and delegation that conflict with ultrawork. When OMP acts on `orchestrate` in a message, this plugin stays out of that message and shows a warning; persistent ultrawork picks up again with the next message. `/ultrawork orchestrate …` refuses to turn persistent mode on.

If you use ultrawork often, turn the built-in keyword off:

```bash
omp config set magicKeywords.orchestrate false
```

### Run many tasks in order with `mass-ulw`

`mass-ulw` is a skill for work that splits into many subagent tasks, some of which depend on others. The agent describes each task and what it depends on; the skill checks the graph for mistakes and cycles before starting, runs the tasks that are ready in batches, and reads each batch's reports before starting the next. A final step checks the evidence, because a subagent finishing is not the same as the work being accepted. Progress survives a restart of the agent's script runtime.

Before a run that costs money or can't be undone, the agent asks you in the main session. If you dismiss the question or don't answer, the run does not start. Graphs you want to reuse by name can live in `.omp/dags/` in your project or in `~/.omp/dags/`. Saving or loading a graph never starts a run, and each run starts with fresh progress.

Typing `mass ulw`, `mass-ulw`, `ulw-mass`, `mulw` or `meth` points the agent to the skill (`mulw` and `meth` do not turn on ultrawork by themselves). For a handful of independent tasks, a plain parallel `task` call is simpler.

OmO's original description: [Dependency graphs: mass-ulw](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#dependency-graphs-mass-ulw).

### Keep working toward a goal with `/ulw-loop`

`/ulw-loop <objective>` starts a loop that keeps going across turns until the objective's criteria are met. It runs as an OMP goal, so OMP handles continuing, budgets and pausing, while the plugin keeps track of subgoals, criteria, attempts and evidence.

- `/ulw-loop` or `/ulw-loop status` shows where it stands.
- `/ulw-loop pause`, `/ulw-loop resume` and `/ulw-loop stop` control this loop.
- `/ulw-loop reset` archives the loop's state and evidence. Only you can run it.

The loop finishes only when every current criterion has evidence, the work has been checked on the real surface or in the source, and a separate reviewer has passed it. Stopping is not success, and it does not stop subagents that are already running. In a Git repository, the loop can only record evidence and finish when tracked files have no uncommitted changes; it never stashes or resets your work.

One session holds one loop. A finished loop is read-only, so start a new session for unrelated work. Turning off `/ulw` does not stop a loop.

### Debate a plan with `/hyperplan`

`/hyperplan <request>` has five critics debate a draft plan over three rounds. Each attacks it from one angle: needless complexity and scope creep, integration gaps and edge cases, unverified assumptions, architecture flaws, or missed alternatives. A separate planner then writes the plan from the outcome, in the same format `/prometheus` produces. The reply starts with `HYPERPLAN MODE ENABLED!`.

OmO's original description: [Adversarial alternative: /hyperplan](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#adversarial-alternative-hyperplan).

### Write a researched report with `/ulw-research`

`/ulw-research <request>` produces a report in which every claim can be traced to a source. The agent collects sources in parallel, follows up leads, searches for counter-evidence, and runs the result through five checks before delivery: structure, faithfulness to the sources and meaning, layout, visuals, and proofreading. A full report includes rendered charts or figures with descriptive alt text. The reply starts with `ULW-RESEARCH MODE ENABLED!`.

Working notes go to `<tmpdir>/ulw-research/`, or to `researchScratchDir`. The finished report goes wherever you ask for it.

When you refresh a source, the earlier copy is kept, so the evidence behind earlier claims is not lost. Pages captured in the browser must be recaptured in the browser; the plugin will not download them again.

`/hyperplan` and `/ulw-research` need a request and run only in the main session.

### Phrases that point to the right command

- `ulw plan`, `ulw-plan` or `ulwplan` suggests `/prometheus <request>` when omo-prometheus is installed. It never turns on Plan Mode by itself.
- Asking for a loop points the agent to `/ulw-loop`.
- Talking about research points to `/ulw-research`. A clear request at the start of a sentence, such as `use ulw research to compare X`, runs the research directly; questions, quotes and negations do not.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
omp plugin config list wows-omp-plugin-omo-ultrawork
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-omo-ultrawork": { "keywords": "focus,ship" } } }
```

Settings are read when a session starts or switches, so restart the session after changing them.

| Setting | Default | What it changes |
| --- | --- | --- |
| `keywordTrigger` | `true` | Set to `false` to stop typed keywords from turning on ultrawork. The commands, the pointers to other commands and direct research requests still work. |
| `keywords` | `ulw,ultrawork` | The words that turn on ultrawork, separated by commas, in any letter case. An empty value turns off keyword triggering only. |
| `researchScratchDir` | empty | Where `/ulw-research` keeps its working notes. Empty means `<tmpdir>/ulw-research`; a relative path is relative to the session's folder. |

## Working with other plugins

- **omo-toolkit**: `/hyperplan` and `/ulw-research` use its specialist agents when it is installed, and OMP's `task` and `scout` agents otherwise. Without its `deep-low` agent, `/hyperplan` runs with four critics. Every command works either way.
- **omo-prometheus**: an approved `/prometheus` plan is in charge of the work, so ultrawork does not write a second plan and a loop does not split the plan into its own subgoals.
- **audit-goal**: a running `/audit` keeps its own goal; `/ulw-loop` does not take it over.

## Known limitations

- Keywords in messages written by other plugins, and in subagent sessions, are ignored.
- `/hyperplan` and `/ulw-research` are commands, not skills the agent can load on its own. The skills are `mass-ulw` and `ulw-loop`.
- `/ulw-loop` needs a saved session. Research also works with `--no-session`, but its working files are then temporary.
- A loop does not turn on OMP's goal continuation settings for you, and it respects OMP's budgets, Plan Mode and your pauses.

## More details

[REFERENCE.md](REFERENCE.md) covers the exact keyword and delivery rules, which agents each command uses, how `mass-ulw` saves progress, the loop's acceptance rules, the research procedure and storage, behavior in RPC, ACP editors and headless runs, and the state snapshot.

## License

Extension code and original packaging are MIT. Modified prompt assets and the vendored research scripts are SUL-1.0. See `NOTICE`, `LICENSE-MIT`, and `LICENSE-SUL-1.0`.
