<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-dark.png">
  <img alt="omo-toolkit" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-light.png">
</picture>

# omo-toolkit

[English](README.md) | 简体中文

从 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）移植到 OMP 的分类代理、只读调研代理、工作流技能、可选运行时辅助功能和两个文档类 MCP 服务器。安装后，这些代理会出现在 `task` 工具的代理列表中，技能可以通过 `/skill:` 使用。

## 安装

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

需要 OMP 18.10.4 或更高版本。安装后重启会话。

## 快速上手

合适的时候，主代理会自己选用这些代理。你也可以直接点名，例如“让 `ultrabrain` 设计一下加锁方案”，或者直接运行技能：

```text
/skill:git-master
/skill:init-deep --max-depth=2
```

如果想让设计和写作代理使用专门的模型，在 `/models` 中为 `designer` 和 `writer` 角色指定模型。

## 用法

### 代理

分类代理以 OMP 内置 `task` 代理的同一份工作者提示词为基础，再加上 OmO 的分类指导。

| 代理 | 适用于 | 默认模型角色 | 思考强度 |
| --- | --- | --- | --- |
| `deep-low` | 单一交付物，常规决策可以从证据推出；遇到重大的未决选择时，以 `ESCALATE: deep-high` 交还给父代理 | `@task` | `medium` |
| `deep-high` | 升级后的推理与实现，前提是重大选择已获授权；否则返回选项和建议 | `@slow` | `xhigh` |
| `ultrabrain` | 目标明确的复杂逻辑与架构推理 | `@slow` | `max` |
| `architect` | 只读的系统设计比较与建议 | `@slow` | `max` |
| `visual-engineering` | UI/UX、样式、动画、前端和设计系统 | `@designer`，然后 `@task` | `xhigh` |
| `artistry` | 有创意、不走寻常路的问题求解 | `@task` | `xhigh` |
| `writing` | 文档、文章和技术写作 | `@writer`，然后 `@task` | `low` |
| `librarian` | 只读的开源调研，使用原生 HTTPS／源码读取和网页搜索，附证据与 GitHub 永久链接 | `@tiny`，然后 `@smol` | `off` |

`librarian` 只声明 `read`、`glob`、`grep`、`find` 和 `web_search`，因此 OMP 原生分类器会将其识别为只读代理，judge-dispatch 也只会为它的请求提供只读路由目标。它用 `read` 读取 HTTPS 文档、GitHub 原始文件 URL 以及 blob、tree、commit 页面；仓库讨论与变更通过 `issue://<N>`、`pr://<N>` 和 `pr://<N>/diff` 获取（跨仓库形式包含 `<owner>/<repo>/`）。宿主授予的文档类 MCP 在安装后仍可使用。

工作者遇到你尚未批准的取舍时，会交还给父代理，不会自行拍板，也不会直接问你。

原版分类说明见 OmO 文档：[Built-in Categories](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-categories)。

### 代理选择规程

每轮开始前，插件会在主代理的系统提示词末尾追加一段简短的代理选择规程，改编自 OmO 的分类选择规程。只有当 `task` 工具处于启用状态、且其代理列表中至少有一个 omo-toolkit 代理时才会追加，并且只提及列表中出现的 omo-toolkit 代理。它告诉主代理：

- 每个列出的代理负责哪类工作；拿不准时选 `deep-low`；相互独立的目标拆成并行的 `task` 条目；
- 子代理结果首行为 `ESCALATE: deep-high` 时：若你已记录过相应决定就照此执行，否则把同一目标重新派给 `deep-high`（未列出 `deep-high` 时则询问你），并保持任务的 `name` 不变；
- `deep-high` 返回 `ESCALATE: parent` 时询问你。

点名某个代理的显式工作流指令（例如已批准的计划或审计循环）优先于该规程。若要关闭它，请禁用你不想提供的 omo-toolkit 代理，或卸载本插件。

### 技能

| 技能 | 适用于 |
| --- | --- |
| `git-master` | 已授权的提交、rebase、历史改写和历史调查；已批准的提交节奏不需要再次确认 |
| `review-work` | 实现后的真实界面 QA，外加一次独立的关口评审 |
| `remove-ai-slops` | 在不改变行为的前提下清理最近的改动 |
| `refactor` | 以契约为依据、规模与改动相称的重构和简化 |
| `debugging` | 基于证据的诊断，在真实界面上做修复前后的检查 |
| `frontend` | 面向网页与 HTML/CSS/SVG 产物的简报、构建、精简和验证流程；包含修改前基线、必需内容保留、无依赖 Bun 草稿检查器、组件目录许可与访问门禁，以及既有界面小改动沿用相邻样式的例外 |
| `visual-qa` | 完整的手机与桌面、明暗主题截图矩阵，滚动末端与动效证据，逐项 PASS/FAIL/N/A 清单，修改前后配对图片，两名独立评审，以及有轮数上限的缺陷、审美和证据评审循环 |
| `init-deep` | 通过有界的原生 map/reduce 和独立验证生成或刷新分层的 `AGENTS.md`。本地模式保持本地；提交模式需要明确授权分支、提交、推送和待评审 PR，绝不合并 |
| `coding-agent-sessions` | 查找并重建本地 OMP、Codex、Claude、OpenCode、OMO/Senpi 等编程代理的历史会话。OMP 回顾优先使用原生 archive，选定的原始记录仍是证据 |
| `onboarding` | 手动启动、逐项征得同意的入门导览：已安装功能、配置映射、有范围限制的历史回顾、提示缓存折扣估算、仅保存用户选中的原生记忆，以及符合条件时的 `init-deep` 提议。没有首次运行钩子，也不自动导入 |
| `give-me-tips` | 根据已安装文档、实时工具 schema、配置及源码证据，用你的语言解释引用的 OMP 或已安装插件提示、命令和功能。不添加轮播启动提示 |
| `data-scientist` | 使用 DuckDB、Polars 和 NumPy 分析 CSV、Parquet、JSON 和 NDJSON，选择常驻 eval、流式或落盘执行位置及基于查询的图表。提供显式调用的隔离式 quick-query 辅助脚本 |
| `programming` | 仓库优先的 Python、Rust、TypeScript/JavaScript 和 Go 参考资料，按需生成新项目，以及可选的策略检查器。没有强制的文件行数或参数数量门槛，也不会自动重构 |
| `ultimate-browsing` | 通过原生 `read` 与 OMP 浏览器处理受阻网页、平台专用阅读和带日期的归档来源。仅提供参考指引，不捆绑提取引擎或 Cookie 工具 |
| `visualize` | 生成数字可追溯的离线独立 HTML 答案，运行 frontend 草稿检查，并在明暗主题、窄宽视口下检查浏览器渲染。交付文件路径与摘要，不是内联 HTML |

用 `/skill:<name>` 运行技能，模型则通过 `skill://<name>` 读取。部分技能会用 `node`、`bun`、`python3` 或 `uv` 运行辅助脚本，具体见各技能的说明。

运行前需要了解的辅助功能细节：

- **前端草稿检查。** `bun <frontend-skill-directory>/scripts/perfection/check-draft-guard.ts <files-or-dirs> [--json]` 只需要 Bun。退出码：0 表示通过，1 表示发现问题，2 表示用法错误或显式目标不可读。它是视觉验证前的检查，不能替代真实渲染观察。
- **Visual QA。** 对每个枚举场景，在 390 和 1440 CSS 像素下（页面布局另加 1920）捕获明暗主题。修改既有界面时，先固定场景并捕获 `before`。低风险改动限两轮，产品界面限三轮。轮数用尽仍有缺陷时以 NEEDS HUMAN REVIEW 结束。
- **Lighthouse（可选）。** 需要 Node、本机 Chrome，以及目标项目可解析的 `lighthouse` 包。缺少前置条件时审计会明确停止。向项目添加依赖需要所有者同意。
- **会话查找器。** 需要 Python 3.11+ 及其标准库。使用 `python3 -B`，并在 OMP 返回的实际技能目录中运行。不会改写复制后的插件目录。
- **入门导览。** 接受导览不等于授权检查历史、迁移配置、保存记忆或生成项目指引。每个有实际影响的步骤单独征求同意，拒绝后直接跳过。历史回顾默认范围为当前项目、最近七天、20 个候选会话和最多五份完整记录。缓存辅助程序输出的是**提示缓存折扣估算**，不是账单成本，也不是本插件带来的因果节省。保存记忆需要已启用且兼容的原生记忆工具；没有则不保存任何内容。
- **data-scientist 与 programming 辅助脚本** 只在模型显式调用时运行，不会被扩展导入，也不会在安装插件时运行。Python 脚本需要 Python 3.11+ 和 uv，首次使用可能将声明的软件包下载到隔离环境。生成器只写入新的目标目录，拒绝覆盖已有目录。可选缓存脚本只写入你设置的 `OMP_DATA_SCIENTIST_CACHE`。
- **visualize。** 生成一个内联资源、可离线打开的独立 HTML 文件，并使用自己的明暗配色。交付前用 frontend 草稿检查器和浏览器在窄屏及预期报告宽度下检查。

原版技能说明见 OmO 文档：[Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets)。

### MCP 服务器

`.mcp.json` 注册了两个 HTTP MCP 服务器，分别以 `omo-toolkit:context7` 和 `omo-toolkit:grep_app` 的名字出现：

- `context7`（`https://mcp.context7.com/mcp`）用于查询库文档。设置 `CONTEXT7_API_KEY` 可使用带密钥的访问；不设置则匿名访问。
- `grep_app`（`https://mcp.grep.app`）用于匿名搜索公开代码。

OMP 启动时会连接这两个服务器。不需要的话，可以在 OMP 的 MCP 设置中禁用。

原版服务器说明见 OmO 文档：[Built-in MCPs](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-mcps)。

## 运行时辅助功能

扩展在代理和技能之上增加了三项可选行为。每项都在会话启动或切换时读取设置。修改设置后需要重新加载或重启。

### 可选注释反馈

默认关闭。请自行准备兼容原生 `comment-checker` 0.8.0 的可执行文件，然后启用 `commentChecker`，并将 `commentCheckerPath` 设为可执行文件路径或 `PATH` 中的命令名。插件不会下载、安装或捆绑检测器。

原生 `write`、`edit`（包括 apply-patch 在内的所有模式）或已应用的 AST 编辑提案成功后，检查器会检查被修改的文件。它只检查会话工作目录内的普通文本文件。反馈仅供参考，出现在工具输出中，不会否决编辑，也不会删除注释。Shell 和 LSP 修改不会被检查。

取舍：启用后会注册 `tool_result` 钩子，这会关闭整个会话的推测性读取，以及流式参数尚未接收完整时的子任务提前启动。正常的子任务并行仍然可用。关闭后，需要重新加载才能恢复推测执行，因为宿主没有取消注册钩子的接口。

### Init-deep 建议器

默认对有终端或 RPC UI 的主会话开启。启动后，它会检查 Git 指标。如果指引覆盖缺失，或已记录的 `init-deep` 基线过时，就通过宿主选择器提供 `Run now`、`Skip this time`、`Never in this project`、`Never anywhere` 四个选项，选择器 60 秒后超时。子代理和没有 UI 的会话保持静默。

`Run now` 启动现有的 `init-deep` 技能。它不会替你选择本地或提交模式，也不授权提交、推送或合并。跳过、取消或超时会抑制提议七天；即使冷却期结束，同一上次提议的 HEAD 也不会再次提示。`Never` 会一直保持，直到显式重置。

操作者命令在没有 UI 时同样可用，并会返回可见消息：

```text
/init-deep-advisor status
/init-deep-advisor run
/init-deep-advisor skip
/init-deep-advisor never-project
/init-deep-advisor never-global
/init-deep-advisor reset-project
/init-deep-advisor reset-global
```

`run` 表示显式同意启动技能，即使自动提议已被抑制。重置只影响指定范围。非 Git 目录或尚无提交的仓库仍可手动使用 `init-deep`，但 Git 建议和持久记录需要已有提交的 HEAD。状态文件及其格式见 [REFERENCE.zh.md](REFERENCE.zh.md)。

### 回退连续性提示

默认关闭。主会话出现提供商拒绝，随后宿主切换到匹配的主模型回退目标，并且实时子任务名单包含 `architect` 时，插件会在该自动回退请求中添加一条工程连续性提示。它建议在独立、合法且有益的高层架构问题上，携带完整证据进行可选咨询。它不会派发咨询、修改模型角色或重试设置，也不会留下持久提醒。原有安全边界始终有效。

## 设置

使用 OMP 插件设置配置 `wows-omp-plugin-omo-toolkit` 的清单设置。项目覆盖在 `.omp/plugin-overrides.json` 中使用同一个包名键。

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `commentChecker` | `false` | 用你自己的注释检查器可执行文件检查成功的文件修改。启用后会话内关闭推测性读取和子任务提前启动；需要重新加载。 |
| `commentCheckerPath` | `""` | 兼容可执行文件的路径（相对于会话工作目录），或 `PATH` 中的命令名。不会下载任何内容。 |
| `initDeepAdvisor` | `true` | 符合条件的主会话在有终端或 RPC UI 时提议 `init-deep`。未经同意绝不运行。 |
| `fallbackArchitect` | `false` | 拒绝触发的主模型回退之后，若 `architect` 可用，添加一条工程连续性提示。 |

无效值只禁用对应的功能，并报告实际的无效值。模型角色和代理选择规程的注册不依赖这些设置。

### 代理模型

代理使用的模型来自你的 OMP `modelRoles`，角色列表按顺序尝试。插件会把 `designer` 和 `writer` 加进 `/models`，但不为它们指定模型；在你指定之前，相关代理使用 `@task`。如果你为这两个角色配置了 `modelTags`，它会覆盖插件提供的标签。

如果只想改某一个代理的模型而不修改插件文件，可以在 `~/.omp/agent/config.yml` 中设置 `task.agentModelOverrides`：

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

OmO 如何为代理和分类匹配模型，见其 [Agent-Model Matching Guide](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/agent-model-matching.md)。OmO 在 `omo.json` 中配置模型；在 OMP 中请使用上面的模型角色和覆盖设置。

## 与其他插件配合

- 安装了本插件时，`omo-prometheus` 和 `omo-ultrawork` 会使用这些代理，否则回退到 `task`；`librarian` 依次回退到 `scout`、`task`。
- 在 `omo-prometheus` 中，最终的代码质量、真实界面 QA 和证据关口由全新的 `deep-high` 或 `deep-low` 子代理执行（回退为 `task`）。
- `judge-dispatch` 对只读请求（包括 `librarian` 的请求）只会路由到只读目标。

## 不使用终端界面时

代理、技能和 MCP 服务器在 OMP 的所有模式下行为相同。

- 注释反馈不依赖 UI。警告写入插件日志；有 UI 时还会以通知形式显示。
- Init-deep 建议器需要终端或 RPC UI 才会提议。没有 UI 时它保持静默，但 `/init-deep-advisor` 仍会返回可见消息。
- 回退连续性提示不依赖 UI。

## 已知限制

- `librarian` 需要能调用工具的聊天模型。它使用 `@tiny`，未设置 `tiny` 时回退到 `@smol`。如果 `tiny` 指向本地的 `local/` 标题生成模型，请把 `librarian` 覆盖为 `@smol`。
- `librarian` 没有 shell，无法执行需要身份认证的 `gh` 搜索或 API 命令。原生读取器可能使用宿主配置的身份认证，但不保证能访问私有来源或执行认证搜索；无法获取的证据会如实标注为不可用。声明的内置工具列表是只读的，但这不代表插件为宿主授予的 MCP 或扩展能力提供了沙箱，这些能力仍由宿主策略管理。
- `ultimate-browsing` 只含指引，不包含提取引擎，也不提供 Cookie 导出、解密或注入工具。平台配方可能失效或只返回部分内容。需要登录态的验收，必须使用你自己附加的已登录浏览器会话。
- `visualize` 交付文件路径、摘要和截图，不会在聊天中内联渲染 HTML。
- 注释反馈不检查 Shell 或 LSP 修改，也无法判断整文件回退检查中的注释是否来自最近一次编辑。
- `coding-agent-sessions` 每次原生扫描最多解析最近的 2,000 个文件。更大的存储请选择范围更窄的目录。

## 参考

钩子契约、建议器状态文件及其格式、注释检查器的可执行协议，以及 `toolkit_init_deep` 工具，见 [REFERENCE.zh.md](REFERENCE.zh.md)。

## 许可证

原创的打包部分采用 MIT 许可证。移植的代理、技能和代理选择规程（`src/selection-protocol.ts`）是 OmO 修订版 `fe427efeed97e95f009dc6ca7fb17a3ac857f79f` 的衍生作品，适用 Sustainable Use License 1.0。在修订版 `8a8db1d3094da8743989bf693ee5de77889de50e` 中新增的运行时组件和技能同样是 Sustainable Use License 1.0 的衍生作品。原创的 OMP 接线和设置代码仍采用 MIT 许可证。前端设计参考资料在 `skills/frontend/` 中保留了 Apache License 2.0 署名。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
