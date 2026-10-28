<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-dark.png">
  <img alt="omo-toolkit" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-light.png">
</picture>

# omo-toolkit

English | [简体中文](README.zh.md)

Category agents, a read-only research agent, workflow skills, optional runtime helpers, and two documentation MCP servers, adapted from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) for OMP. Once installed, the agents appear in the `task` tool's agent list, and the skills run under `/skill:`.

## Install

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

Requires OMP 18.10.4 or newer. Restart the session after installing.

## Quick start

The main agent picks these agents on its own when they fit. You can also name one ("have `ultrabrain` work out the locking scheme") or run a skill directly:

```text
/skill:git-master
/skill:init-deep --max-depth=2
```

To give the design and writing agents their own models, assign the `designer` and `writer` roles in `/models`.

## Usage

### Agents

Category agents start from the same worker prompt as OMP's bundled `task` agent, with OmO's category guidance added.

| Agent | Use for | Default model role | Thinking |
| --- | --- | --- | --- |
| `deep-low` | One deliverable whose routine decisions follow from evidence; hands consequential open choices back to its parent as `ESCALATE: deep-high` | `@task` | `medium` |
| `deep-high` | Escalated reasoning and implementation once a material choice is authorized; otherwise returns options and a recommendation | `@slow` | `xhigh` |
| `ultrabrain` | Hard logic and architecture reasoning with clear goals | `@slow` | `max` |
| `architect` | Read-only system design comparison and recommendation | `@slow` | `max` |
| `visual-engineering` | UI/UX, styling, animation, frontend and design-system work | `@designer`, then `@task` | `xhigh` |
| `artistry` | Creative, unconventional problem solving | `@task` | `xhigh` |
| `writing` | Documentation, prose and technical writing | `@writer`, then `@task` | `low` |
| `librarian` | Read-only open-source research using native HTTPS/source reads and web search, with evidence and GitHub permalinks | `@tiny`, then `@smol` | `off` |

`librarian` declares only `read`, `glob`, `grep`, `find`, and `web_search`. OMP's native classifier therefore treats it as read-only, and judge-dispatch offers it only read-only routing destinations. It reads HTTPS documentation, raw GitHub files, and GitHub blob, tree, and commit pages with `read`. Issues, pull requests, and diffs come through `issue://<N>`, `pr://<N>`, and `pr://<N>/diff`; cross-repository forms add `<owner>/<repo>/`. Documentation MCP servers that the host grants stay available after install.

Workers hand back trade-offs you have not approved to their parent. They do not settle them or ask you directly.

The original categories are documented in [Built-in Categories](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-categories).

### Agent selection protocol

Before each turn, the plugin adds a short selection protocol to the main agent's system prompt. It is adapted from OmO's category selection protocol. The protocol appears only when the `task` tool is active and its agent list includes an omo-toolkit agent, and it names only the omo-toolkit agents in that list.

It tells the main agent which lane each listed agent covers, to pick `deep-low` when unsure, and to run independent goals as parallel `task` items. When a child's result starts with `ESCALATE: deep-high`, the main agent applies a decision you already recorded. Otherwise it re-dispatches the goal to `deep-high` under the same `name`, or asks you if `deep-high` is not listed. When `deep-high` returns `ESCALATE: parent`, the main agent asks you.

An explicit workflow instruction that names an agent, such as an approved plan or an audit loop, takes precedence over the protocol. To turn the protocol off, disable the omo-toolkit agents you do not want offered, or uninstall the plugin.

### Skills

| Skill | Use for |
| --- | --- |
| `git-master` | Authorized commits, rebases, history rewrites and history investigation. An approved commit cadence needs no second confirmation. |
| `review-work` | Real-surface QA after implementation, plus one independent gate review. |
| `remove-ai-slops` | Cleaning up recent changes without changing behavior. |
| `refactor` | Refactors and simplification, traced to their contracts and sized to the change. |
| `debugging` | Diagnosis from evidence, with before and after checks on the real surface. |
| `frontend` | Brief, build, subtract, and verify for web and HTML/CSS/SVG artifacts. Includes pre-edit baselines, required-content checks, a dependency-free Bun draft guard, component-catalog license and access gates, and an exception for small changes to existing surfaces. |
| `visual-qa` | A phone and desktop capture matrix in light and dark, a per-item PASS/FAIL/N/A checklist, paired before and after images, two independent reviewers, and a bounded review loop. |
| `init-deep` | Generates or refreshes hierarchical `AGENTS.md` guidance through bounded map/reduce and independent verification. Local mode stays local. Committed mode needs explicit authorization for branch, commit, push and reviewed PR, and it never merges. |
| `coding-agent-sessions` | Finds and reconstructs local OMP, Codex, Claude, OpenCode, OMO/Senpi and other coding-agent sessions. OMP recall starts with the native archive, and selected raw transcripts remain the evidence. |
| `onboarding` | A manual, consent-led tour of installed features, configuration mapping, bounded history review, estimated prompt-cache discounts, user-selected native-memory writes, and an eligible `init-deep` offer. No first-run hook and no automatic import. |
| `give-me-tips` | Explains a quoted OMP or plugin tip, command, or feature from installed docs, live schemas, configuration and source. It does not add rotating startup tips. |
| `data-scientist` | Analyzes CSV, Parquet, JSON and NDJSON with DuckDB, Polars and NumPy, and picks resident, streaming, or spill execution. Includes an explicitly invoked quick-query helper. |
| `programming` | Repository-first references for Python, Rust, TypeScript/JavaScript and Go, new-project generators on request, and optional policy checkers. No mandatory size gates, and no automatic refactors. |
| `ultimate-browsing` | Blocked-host routing, platform-native reading and dated archive provenance through `read` and the OMP browser. Guidance only: no extraction engine and no cookie tools. |
| `visualize` | Self-contained offline HTML answers with traceable figures, the frontend draft guard, and light, dark, narrow and wide browser checks. Delivers a file path and a summary, not inline HTML. |

Run a skill with `/skill:<name>`. Models read it through `skill://<name>`. Some skills run helper scripts with `node`, `bun`, `python3` or `uv`, as each skill documents.

Helper details to know before you run them:

- Frontend draft guard: `bun <frontend-skill-directory>/scripts/perfection/check-draft-guard.ts <files-or-dirs> [--json]` needs only Bun. Exit codes: 0 clean, 1 findings, 2 usage error or an unreadable explicit target. Run it before visual QA. It does not replace rendered inspection.
- Visual QA: captures each enumerated case at 390 and 1440 CSS pixels (plus 1920 for page layouts) in light and dark. For existing UI fixes, it freezes the case list and captures `before` first. Low-risk work gets two review rounds and product surfaces get three. Defects still open at the limit end as NEEDS HUMAN REVIEW.
- Lighthouse (optional): needs Node, a local Chrome, and a `lighthouse` package that the target project can resolve. Without them the audit stops with an explicit message. Adding a dependency to a project needs the owner's approval.
- Sessions helper: needs Python 3.11+ and only its standard library. Run it with `python3 -B` from the skill directory that OMP returns. The copied plugin tree is not modified.
- Onboarding: accepting the tour does not authorize history inspection, settings migration, memory writes, or guidance generation. Each consequential step asks separately, and declining skips it without repeated offers. History review defaults to the current project, the last seven days, 20 candidate sessions and five full transcripts. The cache-discount helper reports an estimated discount, not an invoiced cost or a saving this plugin caused. Memory writes need an enabled, compatible native memory tool. Without one, nothing is saved.
- Data-scientist and programming helpers run only when the model calls them. The extension does not import them, and they do not run at install. Python helpers need Python 3.11+ and uv. First use may download declared packages into isolated environments. Generators write only to a new target directory and refuse existing destinations. The optional cache helper writes only to `OMP_DATA_SCIENTIST_CACHE`, and only when you set it.
- Visualize: writes one standalone HTML file with inline assets and its own light and dark palette. Before delivery, it runs the frontend draft guard and checks the page in a browser at narrow and intended report widths.

The original skills are documented in [Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets).

### MCP servers

`.mcp.json` registers two HTTP MCP servers, exposed as `omo-toolkit:context7` and `omo-toolkit:grep_app`:

- `context7` (`https://mcp.context7.com/mcp`) for library documentation. Set `CONTEXT7_API_KEY` for keyed access. Without it, access is anonymous.
- `grep_app` (`https://mcp.grep.app`) for anonymous public code search.

OMP connects both at startup. To turn either one off, disable it in OMP's MCP settings.

The original servers are documented in [Built-in MCPs](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-mcps).

## Runtime helpers

The extension adds three optional behaviors on top of the agents and skills. Each one reads its setting when the session starts or switches, so reload or restart after you change a setting.

### Comment feedback (optional)

Off by default. Bring your own executable compatible with native `comment-checker` 0.8.0, enable `commentChecker`, and set `commentCheckerPath` to its path or to a command on `PATH`. The plugin does not download, install or bundle a detector.

After a successful native `write`, `edit` (all modes, including apply-patch), or applied AST-edit proposal, the checker runs on the changed file. It checks only regular text files inside the session's working directory. Findings are advisory. They appear in tool output and never block an edit or delete a comment. Shell and LSP changes are not checked. Timing and protocol details are in [REFERENCE.md](REFERENCE.md#external-analyzer-protocol).

Trade-off: enabling this registers a `tool_result` hook. That turns off speculative reads and early streamed task launches for the whole session, though normal task parallelism still works. Disabling it does not bring speculation back until you reload, because the host cannot remove a registered hook.

### Init-deep advisor

On by default for main sessions with a terminal or RPC UI. After startup, it checks Git metrics. If guidance coverage is missing or the recorded `init-deep` baseline is stale, it offers `Run now`, `Skip this time`, `Never in this project`, or `Never anywhere` in a host selector. The selector times out after 60 seconds. Subagents and sessions without a UI stay silent.

`Run now` starts the existing `init-deep` skill. It does not pick local or committed mode, and it does not authorize a commit, push or merge. Skip, cancel and timeout suppress offers for seven days. The same last-proposed HEAD stays suppressed after the cooldown. `Never` lasts until you reset it.

Operator commands also work without a UI and return visible messages:

```text
/init-deep-advisor status
/init-deep-advisor run
/init-deep-advisor skip
/init-deep-advisor never-project
/init-deep-advisor never-global
/init-deep-advisor reset-project
/init-deep-advisor reset-global
```

`run` counts as explicit consent to start the skill, even when automatic offers are suppressed. Reset affects only the named scope. Non-Git folders and repositories without a commit can still run `init-deep` by hand, but Git-based advice and durable records need a committed HEAD. State files and their schemas are in [REFERENCE.md](REFERENCE.md#advisor-state).

### Fallback continuity hint

Off by default. After a main-session provider refusal, when the host falls back to a matching primary model and the live task roster includes `architect`, the plugin adds one engineering-continuity hint to that automatic fallback request. The hint suggests an optional architecture consultation on an independent, legitimate question, with self-contained evidence. It does not dispatch a consultation, change model roles or retry settings, or leave a reminder behind. The original safety boundary still applies.

## Settings

Configure these manifest-backed settings for `wows-omp-plugin-omo-toolkit` in OMP's plugin settings. Project overrides use the same package key in `.omp/plugin-overrides.json`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `commentChecker` | `false` | Check successful file mutations with your own comment-checker executable. Speculative reads and early task launch are disabled for the session; reload required. |
| `commentCheckerPath` | `""` | Path to your compatible executable, relative to the session working directory, or a command on `PATH`. Nothing is downloaded. |
| `initDeepAdvisor` | `true` | Offer `init-deep` at eligible main-session startup when a terminal or RPC UI is present. Never runs it without consent. |
| `fallbackArchitect` | `false` | Add one engineering-continuity hint after a refusal-driven primary-model fallback when `architect` is available. |

An invalid value disables only the feature it belongs to and reports the value it found. Model-role and selection-protocol registration do not depend on these settings.

### Agent models

Agent models come from your OMP `modelRoles`, and a role list is tried in order. The plugin adds `designer` and `writer` to `/models` without assigning a model. Until you assign one, those agents use `@task`. A `modelTags` entry you set for either role overrides the plugin's label.

To change one agent's model without editing plugin files, set `task.agentModelOverrides` in `~/.omp/agent/config.yml`:

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

For how OmO matches models to agents and categories, see its [Agent-Model Matching Guide](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/agent-model-matching.md). OmO configures models in `omo.json`. In OMP, use the model roles and overrides above.

## Working with other plugins

- `omo-prometheus` and `omo-ultrawork` use these agents when they are installed and fall back to `task` otherwise. `librarian` falls back to `scout`, then `task`.
- Under `omo-prometheus`, the final code-quality, real-surface QA and evidence gates run on fresh `deep-high` or `deep-low` children, falling back to `task`.
- `judge-dispatch` routes read-only requests, including `librarian` requests, only to read-only destinations.

## Without the terminal UI

Agents, skills and MCP servers work the same in every OMP mode.

- Comment feedback works without a UI. Warnings go to the plugin log, and with a UI they also show as a notification.
- The init-deep advisor needs a terminal or RPC UI to offer anything. Without one it stays silent, but `/init-deep-advisor` still replies with visible messages.
- The fallback hint does not depend on the UI.

## Known limitations

- `librarian` needs a chat model that can call tools. It uses `@tiny`, then `@smol` when `tiny` is unset. If `tiny` points at an on-device `local/` title model, override `librarian` to `@smol`.
- `librarian` has no shell, so it cannot run authenticated `gh` search or API commands. Native readers may use the host's configured authentication, but private-source access and authenticated search are not guaranteed. Unavailable evidence is reported as unavailable. The read-only tool list does not sandbox MCP servers or extension capabilities that the host grants. Those stay under host policy.
- `ultimate-browsing` is guidance only. It ships no extraction engine, cookie export, decryption or injection tools. Platform recipes may fail or return partial content. Authenticated checks need a signed-in browser session that you attach yourself.
- `visualize` delivers a file path, a summary and screenshots. It does not render HTML inline in the chat.
- Comment feedback does not check shell or LSP changes, and it cannot tell whether a file-wide fallback comment came from the last edit.
- `coding-agent-sessions` parses at most the 2,000 most recent native files per scan. Use a narrower directory for larger stores.

## Reference

Hook contracts, advisor state files and their schemas, the comment-checker executable protocol, and the `toolkit_init_deep` tool are documented in [REFERENCE.md](REFERENCE.md).

## License

Original packaging is MIT. The ported agents, skills and agent selection protocol (`src/selection-protocol.ts`) are Sustainable Use License 1.0 derivatives of OmO revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. The runtime components and skills added at revision `8a8db1d3094da8743989bf693ee5de77889de50e` are also Sustainable Use License 1.0 derivatives. The original OMP wiring and settings code stay under MIT. The frontend design references keep their Apache License 2.0 attribution in `skills/frontend/`. See `NOTICE`, `LICENSE-MIT` and `LICENSE-SUL-1.0`.
