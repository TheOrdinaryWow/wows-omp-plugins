# omo-toolkit

[English](README.md) | 简体中文

从 oh-my-openagent 移植到 OMP 的分类代理、研究代理、工作流技能，以及两个文档 MCP 服务器。

## 安装

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

OMP 会从已安装的插件目录加载 `agents/`、`skills/` 和 `.mcp.json`。插件附带一个小扩展，把 `designer` 和 `writer` 两个模型角色列进 `/models`，方便直接在那里指派模型。

## 代理

分类代理使用与 OMP 内置 `task` 代理相同的工作提示词，并加入 oh-my-openagent 的分类指导。

| 代理 | 适用场景 | 默认模型角色 | 思考级别 |
| --- | --- | --- | --- |
| `deep-low` | 完成单项交付，常规决策依据证据作出；遇到尚未决定且影响重大的选择时，以 `ESCALATE: deep-high` 交回父代理 | `@task` | `medium` |
| `deep-high` | 在重大选择获准后，处理升级的推理与实现工作；否则返回选项和建议 | `@slow` | `xhigh` |
| `ultrabrain` | 目标明确的复杂逻辑与架构推理 | `@slow` | `max` |
| `architect` | 只读，比较系统设计方案并给出建议 | `@slow` | `max` |
| `visual-engineering` | UI/UX、样式、动画、前端和设计系统工作 | `@designer`，然后是 `@task` | `xhigh` |
| `artistry` | 用创造性、非常规的方法解决问题 | `@task` | `xhigh` |
| `writing` | 文档、文章和技术写作 | `@writer`，然后是 `@task` | `low` |
| `librarian` | 只读的开源研究，附 GitHub 永久链接和官方文档 | `@tiny`，然后是 `@smol` | `off` |

模型角色来自你的 OMP `modelRoles` 配置，列表中的角色会按顺序尝试。插件会在 `/models` 中列出 `designer` 和 `writer`，但不为它们指派模型；在你指派之前，相应代理使用 `@task`。如果你在 `modelTags` 里为这两个角色配置过条目，以你的配置为准。

`librarian` 使用 `@tiny`，在未设置 `tiny` 时回退到 `@smol`。它需要能够调用工具的聊天模型。如果 `tiny` 指向设备上的 `local/` 标题模型，请将 `librarian` 的模型覆盖为 `@smol`。

要在不修改插件文件的情况下更改某个代理的模型，请在 `~/.omp/agent/config.yml` 中设置 `task.agentModelOverrides`：

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

安装这些代理后，`omo-prometheus` 和 `omo-ultrawork` 会使用它们；未安装时回退到 `task`（`librarian` 先回退到 `scout`，再回退到 `task`）。用户尚未批准的取舍交给父代理处理，执行任务的代理不会自行决定，也不会直接询问用户。

最终的代码质量检查、真实界面 QA 和证据关卡由新启动的 `deep-high` 或 `deep-low` 子代理执行（回退为 `task`）。任务说明包含完整的验证要求。

## 技能

| 技能 | 适用场景 |
| --- | --- |
| `git-master` | 经授权的提交、变基、历史重写和历史调查；已批准的提交节奏无需再次确认 |
| `review-work` | 实现后的真实界面 QA，以及一次独立的关卡审查 |
| `remove-ai-slops` | 清理近期改动，不改变行为 |
| `refactor` | 依据契约进行重构和简化，工作规模与改动相匹配；仅在独立工作值得委派时才委派 |
| `debugging` | 依据证据诊断，在真实界面上做修改前后的检查；不会为走形式而重现已观察到的故障 |
| `frontend` | Web UI、UX、样式、布局、动画、无障碍、SEO 和前端性能 |
| `visual-qa` | 检查渲染后的网页、终端输出和分页文档 |
| `init-deep` | 生成或更新分层的 `AGENTS.md` 文件；支持 `--create-new` 和 `--max-depth=N` |

通过 `/skill:<name>` 运行技能；模型通过 `skill://<name>` 读取技能。辅助脚本使用 `node`、`bun`、`python3` 或 `uv` 运行，具体见各技能的说明。

## MCP 服务器

`.mcp.json` 注册了两个 HTTP MCP 服务器，在 OMP 中的名称为 `omo-toolkit:context7` 和 `omo-toolkit:grep_app`：

- `context7`（`https://mcp.context7.com/mcp`）：设置 `CONTEXT7_API_KEY` 即可使用密钥访问。未设置时，请求头为空，使用匿名访问。
- `grep_app`（`https://mcp.grep.app`）：匿名的公开代码搜索。

OMP 会在启动时连接这两个服务器。如果不需要其中某个服务器，可在 OMP 的 MCP 设置中禁用它。

## 许可证

原创打包内容采用 MIT 许可证。移植的代理和技能是 oh-my-openagent 修订版 `fe427efeed97e95f009dc6ca7fb17a3ac857f79f` 的衍生作品，采用 Sustainable Use License 1.0。前端设计参考资料在 `skills/frontend/` 中保留了 Apache License 2.0 的署名。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
