<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-dark.png">
  <img alt="omo-toolkit" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-light.png">
</picture>

# omo-toolkit

English | [简体中文](README.zh.md)

Category agents, a read-only research agent, workflow skills, optional runtime helpers and two documentation MCP servers, adapted from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) for OMP. Once installed, the agents show up in the `task` tool's agent list and the skills under `/skill:`.

## Install

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

Requires OMP 18.10.4 or newer. Restart the session after installing.

## Quick start

The main agent picks these agents on its own when they fit. You can also name one, for example "have `ultrabrain` work out the locking scheme", or run a skill directly:

```text
/skill:git-master
/skill:init-deep --max-depth=2
```

To give the design and writing agents their own models, assign the `designer` and `writer` roles in `/models`.

## Usage

### Agents

Category agents start from the same worker prompt as OMP's bundled `task` agent and add OmO's category guidance.

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

`librarian` declares only `read`, `glob`, `grep`, `find`, and `web_search`, so OMP's native classifier recognizes it as read-only, and judge-dispatch only offers read-only routing destinations for its requests. It reads HTTPS documentation, raw GitHub file URLs, and GitHub blob, tree, and commit pages with `read`. Repository discussions and changes come through `issue://<N>`, `pr://<N>`, and `pr://<N>/diff` (cross-repository forms include `<owner>/<repo>/`). Documentation MCPs that the host grants remain available when installed.

Workers pass trade-offs you have not approved back to their parent instead of settling them or asking you directly.

OmO documents the original categories in [Built-in Categories](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-categories).

### Agent selection protocol

Before each turn, the plugin appends a short agent selection protocol to the main agent's system prompt, adapted from OmO's category selection protocol. It appears only when the `task` tool is active and its agent list includes at least one omo-toolkit agent, and it names only the omo-toolkit agents that list includes. It tells the main agent:

- which lane each listed agent covers, to pick `deep-low` when unsure, and to split independent goals into parallel `task` items;
- how to handle a child whose result starts with `ESCALATE: deep-high`: apply a decision you already recorded, otherwise re-dispatch the goal to `deep-high` (or ask you when `deep-high` is not listed), keeping the task's `name`;
- to ask you when `deep-high` returns `ESCALATE: parent`.

Explicit workflow instructions that name an agent, such as an approved plan or an audit loop, take precedence over the protocol. To turn it off, disable the omo-toolkit agents you do not want offered, or uninstall the plugin.

### Skills

| Skill | Use for |
| --- | --- |
| `git-master` | Authorized commits, rebases, history rewrites and history investigation; an approved commit cadence needs no second confirmation |
| `review-work` | Real-surface QA after implementation, plus one independent gate review |
| `remove-ai-slops` | Cleaning up recent changes without changing behavior |
| `refactor` | Refactors and simplification traced to their contracts and sized to the change |
| `debugging` | Diagnosis from evidence, with before/after checks on the real surface |
| `frontend` | Brief, build, subtract and verify for web and HTML/CSS/SVG artifacts; pre-edit baselines, required-content preservation, a dependency-free Bun draft guard, component-catalog license and access gates, and a styled-sibling exception for small existing-surface changes |
| `visual-qa` | Complete phone and desktop light/dark capture matrix, end-scroll and motion evidence, a per-item PASS/FAIL/N/A checklist, paired before/after images, two independent reviewers, and a bounded defect/taste/evidence review loop |
| `init-deep` | Generate or refresh hierarchical `AGENTS.md` guidance through bounded native map/reduce and independent verification. Local mode stays local; a committed mode needs explicit authorization for branch, commit, push and reviewed PR, and never merges |
| `coding-agent-sessions` | Find and reconstruct local OMP, Codex, Claude, OpenCode, OMO/Senpi and other coding-agent sessions. OMP recall starts with the native archive; selected raw transcripts remain the evidence |
| `onboarding` | A manual, consent-led tour of installed OMP features, configuration mapping, bounded history review, estimated prompt-cache discounts, user-selected native-memory writes, and an eligible `init-deep` offer. No first-run hook or automatic import |
| `give-me-tips` | Explain a quoted OMP or installed-plugin tip, command or feature from installed docs, live schemas, configuration and source evidence, in your language. Does not add rotating startup tips |
| `data-scientist` | Analyze CSV, Parquet, JSON and NDJSON with DuckDB, Polars and NumPy; choose resident eval, streaming or spill placement, and query-backed plots. Includes an explicitly invoked isolated quick-query helper |
| `programming` | Repository-first Python, Rust, TypeScript/JavaScript and Go references, requested new-project generators and optional policy checkers. No mandatory size or argument gates and no automatic refactors |
| `ultimate-browsing` | Blocked-host routing, platform-native reading and dated archive provenance through native `read` and the OMP browser. Reference-only: no bundled extraction engine or cookie utilities |
| `visualize` | Self-contained offline HTML answers with traceable figures, the frontend draft-guard lint, and light and dark, narrow and wide browser inspection. Delivers a file path and summary, not inline HTML |

Run a skill with `/skill:<name>`; models read it through `skill://<name>`. Some skills run helper scripts with `node`, `bun`, `python3` or `uv`, as each skill documents.

Helper details that matter before you run them:

- **Frontend draft guard.** `bun <frontend-skill-directory>/scripts/perfection/check-draft-guard.ts <files-or-dirs> [--json]` needs only Bun. Exit codes: 0 clean, 1 findings, 2 usage error or an unreadable explicit target. It is a check before visual QA, not a replacement for rendered inspection.
- **Visual QA.** Captures each enumerated case at 390 and 1440 CSS pixels (plus 1920 for page layouts) in light and dark. Existing UI fixes freeze the case list and capture `before` first. Low-risk work gets two review rounds and product surfaces get three. Unresolved defects at the limit end in NEEDS HUMAN REVIEW.
- **Lighthouse (optional).** Needs Node, a local Chrome and a `lighthouse` package that the target project can resolve. Without them the audit stops with an explicit message. Installing a dependency into a project needs the owner's approval.
- **Sessions helper.** Needs Python 3.11+ and only its standard library. Run it with `python3 -B` from the physical skill directory that OMP returns. The copied plugin tree is not modified.
- **Onboarding.** Accepting the tour does not authorize history inspection, settings migration, memory writes or guidance generation. Each consequential step asks separately, and declining skips it without repeated offers. History review defaults to the current project, the last seven days, 20 candidate sessions and five full transcripts. The cache-discount helper reports an **estimated** prompt-cache discount, not an invoiced cost or a savings claim caused by this plugin. Memory writes need an enabled, compatible native memory tool; without one, nothing is persisted.
- **Data-scientist and programming helpers** run only when the model invokes them. They are not imported by the extension and do not run at install time. Python helpers need Python 3.11+ and uv, and first use may download declared packages into isolated environments. Generators write only to a new target directory and refuse existing destinations. Optional cache helpers write only to `OMP_DATA_SCIENTIST_CACHE` when you set it.
- **Visualize.** Writes one standalone HTML file with inline assets and its own light/dark palette, then checks it with the frontend draft guard and browser inspection at narrow and intended report widths before delivery.

OmO documents the original skills in [Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets).

### MCP servers

`.mcp.json` registers two HTTP MCP servers, exposed as `omo-toolkit:context7` and `omo-toolkit:grep_app`:

- `context7` (`https://mcp.context7.com/mcp`) for library documentation. Set `CONTEXT7_API_KEY` for keyed access; without it, access is anonymous.
- `grep_app` (`https://mcp.grep.app`) for anonymous public code search.

OMP connects both at startup. Disable either in OMP's MCP settings if you do not want it.

OmO documents the original servers in [Built-in MCPs](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-mcps).

## Runtime helpers

The extension adds three optional behaviors on top of the agents and skills. Each one reads its setting when the session starts or switches. Reload or restart after changing a setting.

### Comment feedback (optional)

Off by default. Provide your own executable compatible with native `comment-checker` 0.8.0, then enable `commentChecker` and set `commentCheckerPath` to its path or to a command on `PATH`. The plugin does not download, install or bundle a detector.

After a successful native `write`, `edit` (all modes, including apply-patch) or applied AST-edit proposal, the checker runs on the changed file. It only checks regular text files inside the session's working directory. Findings are advisory: they appear in tool output and never veto an edit or delete a comment. Shell and LSP mutations are not checked.

Trade-off: enabling this registers a `tool_result` hook, which turns off speculative reads and early streamed task launches for the whole session. Normal task parallelism still works. Disabling it does not restore speculation until you reload, because the host has no way to remove a registered hook.

### Init-deep advisor

On by default for main sessions that have a terminal or RPC UI. After startup, it looks at Git metrics. If guidance coverage is missing or the recorded `init-deep` baseline is outdated, it offers `Run now`, `Skip this time`, `Never in this project`, or `Never anywhere` in a host selector that times out after 60 seconds. Subagents and sessions without a UI stay silent.

`Run now` starts the existing `init-deep` skill. It does not choose local or committed mode and does not authorize a commit, push or merge. Skip, cancel and timeout suppress offers for seven days. The same last-proposed HEAD stays suppressed after the cooldown. `Never` stays until you reset it.

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

`run` counts as explicit consent to start the skill even when automatic offers are suppressed. Reset affects only the named scope. Non-Git folders and repositories without a commit can still run `init-deep` manually, but Git-based advice and durable records need a committed HEAD. State files and their schemas are in [REFERENCE.md](REFERENCE.md).

### Fallback continuity hint

Off by default. When a main-session provider refusal is followed by a matching primary-model fallback, and the live task roster includes `architect`, the plugin adds one engineering-continuity hint to that automatic fallback request. It suggests an optional, independently legitimate architecture consultation with self-contained evidence. It does not dispatch a consultation, change model roles or retry settings, or leave a reminder behind. The original safety boundary still applies.

## Settings

Configure these manifest-backed settings for `wows-omp-plugin-omo-toolkit` using OMP's plugin settings. Project overrides use the same package key in `.omp/plugin-overrides.json`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `commentChecker` | `false` | Check successful file mutations with your own comment-checker executable. Speculative reads and early task launch are disabled for the session; reload required. |
| `commentCheckerPath` | `""` | Path to your compatible executable, relative to the session working directory, or a command on `PATH`. Nothing is downloaded. |
| `initDeepAdvisor` | `true` | Offer `init-deep` at eligible main-session startup when a terminal or RPC UI is present. Never runs it without consent. |
| `fallbackArchitect` | `false` | Add one engineering-continuity hint after a refusal-driven primary-model fallback when `architect` is available. |

An invalid value disables only the feature it belongs to and reports the value it found. Model-role and selection-guidance registration do not depend on these settings.

### Agent models

Agent models come from your OMP `modelRoles`, and a role list is tried in order. The plugin adds `designer` and `writer` to `/models` without assigning a model; until you assign one, those agents use `@task`. A `modelTags` entry you configured for either role takes precedence over the plugin's label.

To change one agent's model without editing plugin files, set `task.agentModelOverrides` in `~/.omp/agent/config.yml`:

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

For how OmO matches models to agents and categories, see its [Agent-Model Matching Guide](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/agent-model-matching.md). OmO configures models in `omo.json`; in OMP, use the model roles and overrides above.

## Working with other plugins

- `omo-prometheus` and `omo-ultrawork` use these agents when they are installed and fall back to `task` otherwise; `librarian` falls back to `scout`, then `task`.
- Under `omo-prometheus`, the final code-quality, real-surface QA and evidence gates run on fresh `deep-high` or `deep-low` children (fallback `task`).
- `judge-dispatch` routes a read-only request, including `librarian`, only to read-only destinations.

## Without the terminal UI

Agents, skills and MCP servers work the same in every OMP mode.

- Comment feedback works without a UI. Warnings go to the plugin log, and with a UI they also appear as a notification.
- The init-deep advisor needs a terminal or RPC UI to offer anything. Without one it stays silent, and `/init-deep-advisor` still answers with visible messages.
- The fallback hint does not depend on the UI.

## Known limitations

- `librarian` needs a chat model that can call tools. It uses `@tiny`, falling back to `@smol` when `tiny` is unset. If `tiny` points at an on-device `local/` title model, override `librarian` to `@smol`.
- `librarian` has no shell and cannot run authenticated `gh` search or API commands. Native readers may use host-configured authentication, but private-source access and authenticated search are not guaranteed. Unavailable evidence is reported as unavailable. The read-only tool list does not sandbox MCP or extension capabilities that the host grants, which remain under host policy.
- `ultimate-browsing` contains guidance only. It does not ship an extraction engine, cookie export, decryption or injection tools. Platform recipes may fail or return partial content. Authenticated checks need a signed-in browser session that you attach yourself.
- `visualize` delivers a file path, a summary and screenshots. It does not render inline HTML in the chat.
- Comment feedback does not check shell or LSP mutations, and it cannot tell whether a file-wide fallback comment came from the last edit.
- `coding-agent-sessions` parses at most the 2,000 most recent native files per scan. Use a narrower directory for larger stores.

## Reference

Hook contracts, advisor state files and their schemas, the comment-checker executable protocol and the `toolkit_init_deep` tool are documented in [REFERENCE.md](REFERENCE.md).

## License

Original packaging is MIT. The ported agents, skills and agent selection protocol (`src/selection-protocol.ts`) are Sustainable Use License 1.0 derivatives of OmO revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. The runtime components and skills added at revision `8a8db1d3094da8743989bf693ee5de77889de50e` are also Sustainable Use License 1.0 derivatives. The original OMP wiring and settings code stay under MIT. The frontend design references keep their Apache License 2.0 attribution in `skills/frontend/`. See `NOTICE`, `LICENSE-MIT` and `LICENSE-SUL-1.0`.
