# omo-toolkit

Content-only OMP plugin with oh-my-openagent-style category agents, research support, workflow skills, and documentation MCP servers.

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

The plugin ships no extension code. OMP discovers its `agents/`, `skills/`, and `.mcp.json` from the installed plugin directory.

## Agents

Category agents use the same worker base as OMP's bundled `task` agent, then add upstream category guidance.

|Agent|Use for|Default model role|Thinking|
|---|---|---|---|
|`deep-low`|One deliverable whose routine decisions follow evidence; sends unresolved consequential choices to its parent as `ESCALATE: deep-high`|`@task`|`medium`|
|`deep-high`|Escalated reasoning and implementation after a material choice is authorized; otherwise returns options and recommendation to its parent|`@slow`|`xhigh`|
|`ultrabrain`|Hard logic and architecture reasoning with clear goals|`@slow`|`max`|
|`architect`|Read-only system design comparison and recommendation|`@slow`|`max`|
|`visual-engineering`|UI/UX, styling, animation, frontend, and design-system work|`@task`|`high`|
|`artistry`|Creative, unconventional problem solving|`@task`|`high`|
|`writing`|Documentation, prose, and technical writing|`@task`|`low`|

Research agent:

|Agent|Use for|Default model role|
|---|---|---|
|`librarian`|Read-only open-source research with GitHub permalinks and official documentation; thinking off for speed|`@smol`|

Model roles resolve through the user's OMP `modelRoles`. Override one agent without editing plugin files through `task.agentModelOverrides` in `~/.omp/agent/config.yml`:

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

`omo-prometheus` and `omo-ultrawork` use these category agents when available, falling back to `task` otherwise; `librarian` falls back to `scout` and then `task`. Workers do not silently decide unapproved user-owned trade-offs or ask the user directly; their parent handles the decision. Final code-quality, real-surface QA, and evidence gates use fresh `deep-high` or `deep-low` children (fallback `task`) whose assignments carry the complete verification contracts.

## Skills

|Skill|Triggers|
|---|---|
|`git-master`|Authorized Git commits, rebases, branch-history rewrites, and Git history investigation; approved commit cadence needs no second confirmation|
|`review-work`|Post-implementation real-surface QA and one independent gate review|
|`remove-ai-slops`|Behavior-preserving cleanup of recent changes|
|`refactor`|Contract-traced, scope-proportionate refactors and simplification; delegate only when independent work merits it|
|`debugging`|Evidence-led diagnosis and before/after real-surface verification without replaying an already observed failure merely for ritual|
|`frontend`|Web UI, UX, styling, layout, animation, accessibility, SEO, and frontend performance|
|`visual-qa`|Rendered web, terminal, and paginated-surface verification|
|`init-deep`|Hierarchical `AGENTS.md` generation or refresh; supports `--create-new` and `--max-depth=N`|

Invoke a skill directly with `/skill:<name>`. Models can read skill files through `skill://<name>`. Bundled helper scripts use `node`, `bun`, `python3`, or `uv` as documented by the skill that runs them.

## MCP servers

`.mcp.json` registers two HTTP MCP servers, exposed by OMP as `omo-toolkit:context7` and `omo-toolkit:grep_app`:

- `context7`: `https://mcp.context7.com/mcp`. Set `CONTEXT7_API_KEY` to use keyed access; when it is unset, the header expands to an empty value for anonymous access.
- `grep_app`: `https://mcp.grep.app`, anonymous public code search.

OMP connects both servers at startup. Disable either one in OMP's MCP settings if you do not want it.

## License

Original packaging is MIT. Ported agents and skills are Sustainable Use License 1.0 derivatives of oh-my-openagent revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. Frontend design references retain the Apache License 2.0 attribution in `skills/frontend/`. See `NOTICE`, `LICENSE-MIT`, and `LICENSE-SUL-1.0`.
