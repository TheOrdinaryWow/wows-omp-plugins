<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-dark.png">
  <img alt="omo-toolkit" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-light.png">
</picture>

# omo-toolkit

English | [简体中文](README.zh.md)

> Specialist agents, workflow skills and documentation search from oh-my-openagent, ready to use in OMP.

This plugin brings the agents and skills of [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) to OMP. You get a set of specialist subagents (deep implementation, hard reasoning, architecture, UI work, writing, open-source research), skills for common workflows such as commits, debugging, refactoring, frontend work and visual QA, and two documentation search servers. The main agent picks the right specialist on its own; you can also name one or run a skill yourself. A few optional helpers can check your agent's code comments, suggest generating `AGENTS.md` guidance, and help the agent keep going after a model refuses a request.

## Install

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

You need OMP 18.19.0 or newer. Restart the session after installing.

## Quick start

The main agent hands work to these agents when they fit. You can also ask for one by name:

```text
have ultrabrain work out the locking scheme
```

Or run a skill directly:

```text
/skill:git-master
/skill:init-deep --max-depth=2
```

To give the design and writing agents models of their own, assign the `designer` and `writer` roles in `/models`.

## Usage

### Agents

| Agent | Good for | Model role | Thinking |
| --- | --- | --- | --- |
| `deep-low` | Most implementation work: one clear deliverable where the decisions follow from what it reads. Hands open choices that matter back as `ESCALATE: deep-high`. | `@task` | `medium` |
| `deep-high` | Harder work and decisions that need more reasoning, once the choice is authorized; otherwise it comes back with options and a recommendation. | `@slow` | `xhigh` |
| `ultrabrain` | Hard logic and architecture problems with clear goals. | `@slow` | `max` |
| `architect` | Comparing designs and recommending one, without changing code. | `@slow` | `max` |
| `visual-engineering` | UI and UX, styling, animation, frontend and design systems. | `@designer`, then `@task` | `xhigh` |
| `artistry` | Creative, unconventional problem solving. | `@task` | `xhigh` |
| `writing` | Documentation, prose and technical writing. | `@writer`, then `@task` | `low` |
| `librarian` | Researching open-source code and library docs on the web, without changing anything. Answers with evidence and GitHub permalinks. | `@tiny`, then `@smol` | `off` |

The model role is where each agent gets its model; when a role has no model, the next one is used. Agents never decide trade-offs you have not approved and do not ask you directly; they hand them back to the main agent.

So the main agent knows when to use which, the plugin adds a short guide to its instructions whenever these agents are available. It tells the agent to pick `deep-low` when unsure, to run independent goals in parallel, and to escalate to `deep-high`, or ask you, when a child reports an open decision. An approved plan or an audit loop that names its own agents takes precedence. To stop the guide, disable the agents you do not want offered, or uninstall the plugin.

The original categories are described in OmO's [Built-in Categories](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-categories).

### Skills

Run a skill with `/skill:<name>`, or let the agent load it when the task matches.

| Skill | Use for |
| --- | --- |
| `git-master` | Commits, rebases, history rewrites and digging through history, when you have authorized them. An approved commit plan needs no second confirmation. |
| `review-work` | Checking finished work on the real surface, plus one independent review. A review can end INCONCLUSIVE, which is not a pass. |
| `eval-integrity` | Checking whether an evaluation can be trusted: its ground truth, data leakage, and whether the people running it could have shaped the results. It ends with a PASS, FAIL or INCONCLUSIVE verdict. It does not rerun the evaluation or approve a deployment. |
| `remove-ai-slops` | Cleaning up recent changes without changing behavior. |
| `refactor` | Refactoring and simplifying, sized to the change. |
| `debugging` | Finding the cause from evidence and confirming the fix before and after. |
| `frontend` | Web pages and HTML, CSS or SVG work: plan, build, trim and verify. New screens start with a grounding pass, and rendered pages are checked in your browser. The report says what it could not inspect. |
| `visual-qa` | Screenshots on phone and desktop sizes in light and dark, a pass/fail checklist, before-and-after images and two independent reviewers. A browser check of each page runs first and lists what it could not see. |
| `init-deep` | Generating or refreshing `AGENTS.md` guidance across the repository. It commits, pushes or opens a PR only when you explicitly allow it, and never merges. |
| `coding-agent-sessions` | Finding and reconstructing earlier sessions from OMP, Codex, Claude, OpenCode and other coding agents. |
| `onboarding` | A guided tour of what you have installed, with each step asking for your consent. |
| `give-me-tips` | Explaining an OMP or plugin tip, command or feature from the installed docs and configuration. |
| `data-scientist` | Analyzing CSV, Parquet, JSON and NDJSON files with DuckDB, Polars and NumPy. |
| `programming` | Writing Python, Rust, TypeScript/JavaScript and Go that follows your repository, and generating new projects on request with generators that run on Bun. |
| `ultimate-browsing` | Reading pages that block bots, platform-specific content and dated archives, through OMP's own reader and browser. Guidance only. |
| `visualize` | Answering with a standalone offline HTML page (charts, tables, diagrams), checked in a browser before you get it. |

Some skills run helper scripts and need tools on your machine:

- `frontend` and `visualize` run a draft check that needs Bun. `frontend` also checks rendered pages in OMP's own browser, with nothing extra to install. The optional Lighthouse audit needs Node, a local Chrome and a `lighthouse` package the project can use; adding it to a project needs your approval.
- `coding-agent-sessions` needs Python 3.11 or newer.
- `data-scientist` helpers need Python 3.11 or newer and uv. The first run may download packages into isolated environments.
- `programming` project generators need Bun. Python projects also need uv, Rust projects need Cargo and Go projects need Go, all already installed. The generators install nothing, and neither runs anything at install.

The original skills are described in OmO's [Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets).

### Documentation search servers

The plugin adds two MCP servers, which OMP connects at startup:

- `omo-toolkit:context7` searches library documentation. Set `CONTEXT7_API_KEY` to use your own key; without it, access is anonymous.
- `omo-toolkit:grep_app` searches public code on GitHub anonymously.

To turn one off, disable it in OMP's MCP settings.

### Check the agent's code comments (optional)

Turn on `commentChecker` and, after every file edit the agent makes, the plugin runs [comment-checker](https://github.com/code-yeongyu/go-claude-code-comment-checker) on the changed file and shows its findings in the tool output. The findings are advice for the agent: they never block an edit or delete a comment. Only text files inside the session's folder are checked, and changes made through shell commands or the language server are not.

You only need Bun: the plugin runs `@code-yeongyu/comment-checker@0.8.2` with `bun x`, which downloads about 52 MB the first time. To use your own build, set `commentCheckerPath`.

Turning it on makes OMP stop starting some file reads and subagents early for the rest of the session. Tasks still run in parallel. Turning it off again only takes effect after you reload.

### Suggestions to generate `AGENTS.md` guidance

When you start a main session in a Git repository whose `AGENTS.md` guidance is missing or out of date, the plugin offers to run `init-deep`: `Run now`, `Skip this time`, `Never in this project` or `Never anywhere`. The offer closes after 60 seconds. `Run now` only starts the skill; it does not choose for you whether results get committed. Skipping or letting the offer time out pauses offers for seven days. `Never` lasts until you reset it.

You can also control it by command:

```text
/init-deep-advisor status
/init-deep-advisor run
/init-deep-advisor skip
/init-deep-advisor never-project
/init-deep-advisor never-global
/init-deep-advisor reset-project
/init-deep-advisor reset-global
```

`run` starts the skill even when offers are paused. The advice needs a repository with at least one commit; elsewhere you can still run `init-deep` by hand. Turn the offers off with `initDeepAdvisor: false`.

### Keep going after a model refuses (optional)

Sometimes a provider refuses a request and OMP automatically retries on another model. With `fallbackArchitect` on, the plugin adds one hint to that retry, suggesting the agent may consult `architect` on an independent, legitimate question with the evidence it has. It does not start that consultation itself, change your models, or relax the original refusal.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-omo-toolkit commentChecker true
omp plugin config list wows-omp-plugin-omo-toolkit
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-omo-toolkit": { "commentChecker": true } } }
```

Settings are read when a session starts or switches, so reload or restart after changing them.

| Setting | Default | What it changes |
| --- | --- | --- |
| `commentChecker` | `false` | Check every file the agent edits with comment-checker and show the findings. |
| `commentCheckerPath` | empty | Empty uses the pinned comment-checker through Bun. Otherwise, your own compatible executable (a path relative to the session folder) or a command on `PATH`. |
| `initDeepAdvisor` | `true` | Offer to run `init-deep` at session start when guidance is missing or stale. It never runs without your consent. |
| `fallbackArchitect` | `false` | After a model refusal and automatic fallback, suggest consulting `architect`. |

An invalid value turns off only the feature it belongs to and says which value it found. The agents and their guide work regardless of these settings.

### Agent models

Each agent's model comes from your OMP model roles, as listed in [Agents](#agents). The plugin adds the `designer` and `writer` roles to `/models` without a model; until you assign one, those agents use `@task`.

To change a single agent's model, set `task.agentModelOverrides` in `~/.omp/agent/config.yml`:

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

OmO configures models in `omo.json`; in OMP, use model roles and these overrides instead. OmO's [Agent-Model Matching Guide](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/agent-model-matching.md) explains which models suit which agents.

## Working with other plugins

- **omo-prometheus** and **omo-ultrawork** use these agents when they are installed and fall back to OMP's `task` agent otherwise (`librarian` falls back to `scout`, then `task`). Prometheus's final code-quality, QA and evidence reviews run on `deep-high` or `deep-low`.
- **judge-dispatch** only routes read-only requests, including `librarian`, to other read-only agents.

## Known limitations

- `librarian` needs a chat model that can use tools. It uses your `tiny` role, then `smol`. If `tiny` points to a small local title model, set `librarian` to `@smol` with `task.agentModelOverrides`.
- `librarian` cannot run shell commands, so it cannot use an authenticated `gh` search. Access to private sources is not guaranteed; what it cannot reach, it reports as unavailable.
- `ultimate-browsing` only gives guidance. It has no scraping engine or cookie tools, may get partial content from some platforms, and pages behind a login need a browser session you signed in to yourself.
- `visualize` gives you a file path, a summary and screenshots, not HTML shown in the chat.
- Comment checking cannot tell whether a finding covering the whole file came from the last edit.
- `coding-agent-sessions` looks at up to the 2,000 most recent session files per scan. Point it at a narrower folder for larger stores.
- `frontend`'s page check lists HTML files it finds in a folder as not rendered. A clean result is not a full visual or accessibility check.

## More details

[REFERENCE.md](REFERENCE.md) documents the agents' tool access, the skill helpers, the rendered-page checker, the review and evaluation rules, how the comment checker is called, when the advisor runs and where it stores its state, the `toolkit_init_deep` tool, the fallback hint, and behavior in RPC, ACP editors and headless runs.

## License

Original packaging is MIT. The ported agents, skills and agent selection protocol (`src/selection-protocol.ts`) are Sustainable Use License 1.0 derivatives of OmO revisions `fe427efeed97e95f009dc6ca7fb17a3ac857f79f` and `adddd17004076e799c2de18ccfdee29e12525ace`. The runtime components and skills added at revision `8a8db1d3094da8743989bf693ee5de77889de50e` are also Sustainable Use License 1.0 derivatives. The original OMP wiring and settings code stay under MIT. Some frontend rules and the rendered-page checker also follow Impeccable (Apache License 2.0) and StyleGallery (MIT). The frontend design references keep their Apache License 2.0 attribution in `skills/frontend/`. See `NOTICE`, `LICENSE-MIT` and `LICENSE-SUL-1.0`.
