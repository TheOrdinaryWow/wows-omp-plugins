# omo-toolkit

English | [简体中文](README.zh.md)

Category agents, a research agent, workflow skills, and two documentation MCP servers, adapted from oh-my-openagent for OMP.

## Install

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

The plugin has no extension code. OMP picks up its `agents/`, `skills/`, and `.mcp.json` from the installed plugin directory.

## Agents

Category agents start from the same worker prompt as OMP's bundled `task` agent and add oh-my-openagent's category guidance on top.

| Agent | Use for | Default model role | Thinking |
| --- | --- | --- | --- |
| `deep-low` | One deliverable whose routine decisions follow from evidence; hands consequential open choices back to its parent as `ESCALATE: deep-high` | `@task` | `medium` |
| `deep-high` | Escalated reasoning and implementation once a material choice is authorized; otherwise returns options and a recommendation | `@slow` | `xhigh` |
| `ultrabrain` | Hard logic and architecture reasoning with clear goals | `@slow` | `max` |
| `architect` | Read-only system design comparison and recommendation | `@slow` | `max` |
| `visual-engineering` | UI/UX, styling, animation, frontend, and design-system work | `@designer`, then `@task` | `xhigh` |
| `artistry` | Creative, unconventional problem solving | `@task` | `xhigh` |
| `writing` | Documentation, prose, and technical writing | `@writer`, then `@task` | `low` |
| `librarian` | Read-only open-source research with GitHub permalinks and official docs | `@tiny`, then `@smol` | `off` |

Model roles come from your OMP `modelRoles`, and a list is tried in order. `designer` and `writer` are custom roles; when they are not set to an available model, those agents use `@task`. `librarian` uses `@tiny` and falls back to `@smol` when `tiny` is unset. It needs a chat model that can call tools, so if `tiny` points at an on-device `local/` title model, override `librarian` to `@smol`.

To change one agent's model without editing plugin files, set `task.agentModelOverrides` in `~/.omp/agent/config.yml`:

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

`omo-prometheus` and `omo-ultrawork` use these agents when they are installed and fall back to `task` otherwise (`librarian` falls back to `scout`, then `task`). Trade-offs the user has not approved go to the worker's parent; workers do not settle them or ask the user directly. Final code-quality, real-surface QA, and evidence gates run on fresh `deep-high` or `deep-low` children (fallback `task`) whose assignments include the full verification requirements.

## Skills

| Skill | Use for |
| --- | --- |
| `git-master` | Authorized commits, rebases, history rewrites, and history investigation; an approved commit cadence needs no second confirmation |
| `review-work` | Real-surface QA after implementation, plus one independent gate review |
| `remove-ai-slops` | Cleaning up recent changes without changing behavior |
| `refactor` | Refactors and simplification traced to their contracts and sized to the change; delegates only when the independent work justifies it |
| `debugging` | Diagnosis from evidence, with before/after checks on the real surface; does not reproduce an already observed failure as a formality |
| `frontend` | Web UI, UX, styling, layout, animation, accessibility, SEO, and frontend performance |
| `visual-qa` | Checking rendered web pages, terminal output, and paginated documents |
| `init-deep` | Generating or refreshing hierarchical `AGENTS.md` files; supports `--create-new` and `--max-depth=N` |

Run a skill with `/skill:<name>`; models read it through `skill://<name>`. Helper scripts run with `node`, `bun`, `python3`, or `uv`, as each skill documents.

## MCP servers

`.mcp.json` registers two HTTP MCP servers, which OMP exposes as `omo-toolkit:context7` and `omo-toolkit:grep_app`:

- `context7` (`https://mcp.context7.com/mcp`): set `CONTEXT7_API_KEY` for keyed access. Without it, the header is empty and access is anonymous.
- `grep_app` (`https://mcp.grep.app`): anonymous public code search.

OMP connects both at startup. Disable either in OMP's MCP settings if you do not want it.

## License

Original packaging is MIT. The ported agents and skills are Sustainable Use License 1.0 derivatives of oh-my-openagent revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. The frontend design references keep their Apache License 2.0 attribution in `skills/frontend/`. See `NOTICE`, `LICENSE-MIT`, and `LICENSE-SUL-1.0`.
