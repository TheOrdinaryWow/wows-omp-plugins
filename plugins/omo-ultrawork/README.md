# omo-ultrawork

English | [简体中文](README.zh.md)

This plugin adapts oh-my-openagent's ultrawork keyword mode, dependency-ordered `mass-ulw`, adversarial `/hyperplan`, and saturation-based `/ulw-research` for OMP.

## Install

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

The plugin installs no runtime dependencies. `/ulw-research` needs `node` on PATH to build its report. Its helper scripts are dependency-free Node CLIs bundled under `assets/ulw-research/scripts/`, and the command passes their absolute path.

## Ultrawork mode

Typing `ulw` or `ultrawork` as a standalone word in a message injects the full hidden ultrawork directive ahead of your text, and the reply starts with `ULTRAWORK MODE ENABLED!`. Later triggers in the same session inject only a short reminder, since the directive is still in context. After compaction, the next trigger injects the full directive again.

`/ultrawork` or `/ulw` turns on persistent mode. Every message then gets the reminder (or the full directive after compaction) without a keyword. Running either command again turns it off and queues a hidden exit notice. The directive arrives according to when you enable the mode:

- with arguments (`/ultrawork fix X`): the directive is queued and the arguments are sent as your next message;
- without arguments while idle: the directive goes out with your next message;
- mid-turn: the directive joins the running turn.

The footer shows `Ultrawork mode` while persistent mode is on, or `Ultrawork armed` after a keyword trigger. It clears on exit or when you switch to a session that is not armed. Mode, arming, and reminder state are saved in the session and restored on resume, switching, branching, and tree navigation. Child sessions and extension-generated messages are ignored.

Keywords inside inline code, fenced blocks, injected directive or reminder blocks, and slash commands do not count. Pasting a complete `<ultrawork-mode>…</ultrawork-mode>` block arms the session without injecting it twice.

Typing `mass ulw`, `mass-ulw`, `ulw-mass`, `mulw`, or `meth` also injects a pointer to `skill://mass-ulw`; `mulw` and `meth` do not arm ultrawork on their own. While armed, the first `todo init` or `todo append` triggers one hidden reminder asking the agent to size independent work and explain its delegation choice. Compaction resets that reminder.

### Do not combine with `orchestrate`

OMP's built-in `orchestrate` magic keyword injects its own orchestration rules, which contradict ultrawork on commits, verification, and delegation. When a message contains a standalone `orchestrate` that OMP would act on (the keyword is enabled and the `task` tool is active), this plugin injects nothing for that message and shows a warning. Persistent mode stays on and resumes with the next message. `/ultrawork orchestrate …` and `/ulw orchestrate …` refuse to turn on persistent mode. If you use ultrawork regularly, disable the built-in keyword:

```bash
omp config set magicKeywords.orchestrate false
```

## mass-ulw

The model can invoke the `mass-ulw` skill to run a dependency graph of `{ id, prompt, agent, dependsOn?, label? }` nodes through `eval`. Before launching any child, the skill validates all ids, dependencies, cycles, and saved statuses. Each cell runs one batch of ready nodes, and the agent reads the returned reports before launching the next batch.

Status (`local://mass-ulw/<run-key>.json`) and reports (`local://mass-ulw/<run-key>/<id>.md`) survive a kernel reset, but a saved `running` handle cannot be reattached to `wait` and must be reconciled before more work is dispatched. `done` only means a child returned; a final verification frontier checks the evidence for acceptance. Retrying or amending some nodes leaves the other `done` reports intact.

For independent work without dependencies, use one plain `task` batch instead. Read `skill://mass-ulw` and its planning reference before using it.

## Commands

`/hyperplan <request>` runs a three-round adversarial debate between five roles, then hands off to a separate planner. The skeptic uses `task`, the validator `task` with `effort: "hi"`, and the researcher, architect, and creative use `deep-low`, `ultrabrain`, and `artistry` when those agents are listed. Without `deep-low` the debate runs with four roles; missing `ultrabrain` or `artistry` fall back to `task`. The planner uses `ultrabrain`, or `task`. The first visible line is `HYPERPLAN MODE ENABLED!`.

`/ulw-research <request>` builds a claim graph through expansion and counter-search, writes a cited synthesis, runs ordered QA gates, and checks the deliverable. Mechanical work goes to `sonic`, bounded judgment to `task`, and high-effort work to `task` with `effort: "hi"`. `scout` does local discovery, `librarian` (or `scout`) does source research, and `writing` (or `task`) proofreads; other category agents fall back to `task`. Scratch files go to `<tmpdir>/ulw-research/` or the configured `researchScratchDir`, and the final output goes wherever you asked. The first visible line is `ULW-RESEARCH MODE ENABLED!`.

Both commands reject an empty request and run only in the main session. Their procedures are private prompt assets and are not registered as skills. Children and the model cannot find or invoke them through `skill://` or `/skill:`. `mass-ulw` is the only skill this plugin exposes.

Install `omo-toolkit` for the named category agents and `omo-prometheus` for the reviewed `/prometheus` planning option; without them, the fallbacks above keep every command working. `metis` is used only inside Prometheus planning, and `momus` outside planning only for explicit Atlas compliance checks.

Work that needs a full review follows its governing plan. Independent compliance, code-quality, and real-surface QA reports may run in parallel; the final evidence-gate reviewer starts once those reports exist. Do not add a second review pipeline alongside an approved plan. Light work gets a scoped self-review and real-surface proof without parallel reviewers.

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
| `keywordTrigger` | boolean | `true` | When false, typed keywords do not arm or inject ultrawork. The mass-ulw pointer and the commands still work. |
| `keywords` | comma-separated string | `ulw,ultrawork` | Case-insensitive whole-word triggers, ignored inside quoted regions; an empty string disables keyword triggering. |
| `researchScratchDir` | string | empty (`<tmpdir>/ulw-research`) | Root for research scratch files; relative paths resolve against the session's cwd. |

Settings are read at `session_start` and on session switch; restart the session after changing them.

## License

Extension code and original packaging are MIT. Modified prompt assets and the vendored research scripts are SUL-1.0. See `NOTICE`, `LICENSE-MIT`, and `LICENSE-SUL-1.0`.
