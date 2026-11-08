<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-dark.png">
  <img alt="omo-toolkit" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-toolkit-light.png">
</picture>

# omo-toolkit

[English](README.md) | 简体中文

> 来自 oh-my-openagent 的专长代理、工作流技能和文档搜索，装上就能在 OMP 里用。

这个插件把 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的代理和技能带到了 OMP。你会得到一组专长子代理（深入实现、复杂推理、架构、UI、写作、开源调研），一批常用工作流技能（提交、调试、重构、前端、视觉 QA 等），以及两个文档搜索服务。主代理会自己挑合适的专长代理；你也可以点名，或者直接运行某个技能。另外还有几个可选的辅助功能：检查代理写的代码注释、建议生成 `AGENTS.md` 指引，以及在模型拒绝请求后帮代理接着干。

## 安装

```bash
omp plugin install omo-toolkit@wows-omp-plugins
```

需要 OMP 18.17.0 或更高版本。安装后重启会话。

## 快速上手

主代理在合适的时候会把工作交给这些代理。你也可以直接点名：

```text
让 ultrabrain 想清楚这套加锁方案
```

或者直接运行一个技能：

```text
/skill:git-master
/skill:init-deep --max-depth=2
```

想让设计和写作代理用各自的模型，就在 `/models` 里给 `designer` 和 `writer` 角色分配模型。

## 用法

### 代理

| 代理 | 适合做什么 | 模型角色 | 思考级别 |
| --- | --- | --- | --- |
| `deep-low` | 大多数实现工作：交付物明确，决策可以从读到的内容推出。遇到重要的未决选择时，以 `ESCALATE: deep-high` 交回。 | `@task` | `medium` |
| `deep-high` | 更难的工作，以及需要更多推理的决策（在选择获得授权之后）；否则带着方案和建议返回。 | `@slow` | `xhigh` |
| `ultrabrain` | 目标清楚的复杂逻辑和架构问题。 | `@slow` | `max` |
| `architect` | 比较设计方案并给出建议，不改代码。 | `@slow` | `max` |
| `visual-engineering` | UI 和 UX、样式、动画、前端和设计系统。 | `@designer`，然后 `@task` | `xhigh` |
| `artistry` | 需要创意、不按常规的问题。 | `@task` | `xhigh` |
| `writing` | 文档、文章和技术写作。 | `@writer`，然后 `@task` | `low` |
| `librarian` | 在网上调研开源代码和库文档，不做任何修改。回答附带证据和 GitHub 永久链接。 | `@tiny`，然后 `@smol` | `off` |

模型角色决定每个代理用哪个模型；某个角色没有配置模型时，就用下一个。这些代理不会替你决定你没批准过的取舍，也不会直接问你，而是把问题交回主代理。

为了让主代理知道什么时候该用哪个，只要这些代理可用，插件就会在它的指令里加一段简短的说明：拿不准时选 `deep-low`，相互独立的目标并行处理，子代理报告有未决决策时升级给 `deep-high` 或者问你。已批准的计划或审计循环如果指定了自己的代理，以它们为准。想去掉这段说明，可以停用你不想让主代理选择的代理，或者卸载插件。

原始的分类介绍见 OmO 的 [Built-in Categories](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-categories)。

### 技能

用 `/skill:<name>` 运行技能，或者在任务匹配时让代理自己加载。

| 技能 | 适合做什么 |
| --- | --- |
| `git-master` | 在你授权后进行提交、变基、改写历史和追查历史。已批准的提交计划不需要再确认一次。 |
| `review-work` | 在真实界面上检查完成的工作，外加一次独立评审。结果可能是 INCONCLUSIVE（无法定论），它不算通过。 |
| `eval-integrity` | 检查一项评估能否被信任：真值来源、数据泄漏，以及运行评估的人是否可能左右了结果。最后给出 PASS、FAIL 或 INCONCLUSIVE 的结论。它不会重新运行评估，也不批准部署。 |
| `remove-ai-slops` | 清理最近的改动，不改变行为。 |
| `refactor` | 重构和简化，规模与改动相称。 |
| `debugging` | 根据证据找到原因，修复前后都做确认。 |
| `frontend` | 网页和 HTML、CSS、SVG：规划、构建、精简、验证。新界面先做依据梳理（grounding）；渲染后的页面会在你的浏览器里检查，报告会写明哪些内容没能检查。 |
| `visual-qa` | 在手机和桌面尺寸、浅色和深色下截图，逐项通过或不通过的清单、修改前后对比图，以及两位独立评审。评审之前，会先在浏览器中检查每个页面，并列出没能看到的部分。 |
| `init-deep` | 为整个仓库生成或刷新 `AGENTS.md` 指引。只有你明确允许时才会提交、推送或开 PR，从不合并。 |
| `coding-agent-sessions` | 查找和还原 OMP、Codex、Claude、OpenCode 等编码代理以前的会话。 |
| `onboarding` | 带你看一遍已安装的功能，每一步都先征得你同意。 |
| `give-me-tips` | 根据已安装的文档和配置，解释 OMP 或插件的提示、命令和功能。 |
| `data-scientist` | 用 DuckDB、Polars 和 NumPy 分析 CSV、Parquet、JSON 和 NDJSON 文件。 |
| `programming` | 按你仓库的习惯编写 Python、Rust、TypeScript/JavaScript 和 Go，按需生成新项目。生成器基于 Bun 运行。 |
| `ultimate-browsing` | 借助 OMP 自带的阅读器和浏览器，阅读拦截机器人的页面、特定平台的内容和带日期的归档。只提供指引。 |
| `visualize` | 用一个独立的离线 HTML 页面（图表、表格、示意图）来回答，交给你之前会先在浏览器里检查。 |

有些技能会运行辅助脚本，需要你的机器上有相应工具：

- `frontend` 和 `visualize` 会运行一个草稿检查脚本，需要 Bun。`frontend` 还会在 OMP 自带的浏览器里检查渲染后的页面，无需额外安装。可选的 Lighthouse 审计需要 Node、本地 Chrome，以及项目能用的 `lighthouse` 包；把它加进项目需要你批准。
- `coding-agent-sessions` 需要 Python 3.11 或更高版本。
- `data-scientist` 的辅助脚本需要 Python 3.11 或更高版本和 uv。第一次运行可能会把依赖包下载到隔离环境中。
- `programming` 的项目生成器需要 Bun。生成 Python 项目还需要 uv，生成 Rust 项目需要 Cargo，生成 Go 项目需要 Go，这些工具都要事先安装好。生成器本身不安装任何东西，两者在安装插件时都不会运行。

原始的技能介绍见 OmO 的 [Built-in Skill Sets](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/reference/features.md#built-in-skill-sets)。

### 文档搜索服务

插件添加了两个 MCP 服务器，OMP 启动时会连接它们：

- `omo-toolkit:context7` 搜索库文档。设置 `CONTEXT7_API_KEY` 可以用你自己的密钥，不设置则匿名访问。
- `omo-toolkit:grep_app` 匿名搜索 GitHub 上的公开代码。

想关掉其中一个，在 OMP 的 MCP 设置里停用它。

### 检查代理写的代码注释（可选）

打开 `commentChecker` 后，代理每改一个文件，插件都会用 [comment-checker](https://github.com/code-yeongyu/go-claude-code-comment-checker) 检查这个文件，并把发现显示在工具输出里。这些发现只是给代理的建议，不会阻止修改，也不会删掉注释。只检查会话目录内的文本文件，通过 shell 命令或语言服务器做的修改不检查。

你只需要 Bun：插件用 `bun x` 运行 `@code-yeongyu/comment-checker@0.8.2`，第一次会下载约 52 MB。想用自己构建的版本，就设置 `commentCheckerPath`。

打开它之后，在这个会话剩下的时间里，OMP 不再提前启动部分文件读取和子代理，但任务仍会并行运行。再关掉它，要重新加载后才生效。

### 建议生成 `AGENTS.md` 指引

在 Git 仓库里开启主会话时，如果 `AGENTS.md` 指引缺失或已经过时，插件会建议运行 `init-deep`，选项有 `Run now`、`Skip this time`、`Never in this project` 和 `Never anywhere`。这个提示 60 秒后自动关闭。`Run now` 只是启动技能，不会替你决定结果要不要提交。跳过或等它超时后，七天内不会再提示。选 `Never` 则一直有效，直到你重置。

你也可以用命令控制它：

```text
/init-deep-advisor status
/init-deep-advisor run
/init-deep-advisor skip
/init-deep-advisor never-project
/init-deep-advisor never-global
/init-deep-advisor reset-project
/init-deep-advisor reset-global
```

即使提示处于暂停状态，`run` 也会启动技能。这些建议需要仓库至少有一次提交；在其他地方，你仍然可以手动运行 `init-deep`。用 `initDeepAdvisor: false` 可以关掉提示。

### 模型拒绝后接着干（可选）

有时服务商会拒绝一个请求，OMP 随后自动换另一个模型重试。打开 `fallbackArchitect` 后，插件会在这次重试里加一条提示，建议代理可以带上已有的证据，就一个独立且正当的问题咨询 `architect`。它不会自己发起咨询，不会改动你的模型，也不会放宽原来的拒绝。

## 设置

为当前用户修改设置：

```bash
omp plugin config set wows-omp-plugin-omo-toolkit commentChecker true
omp plugin config list wows-omp-plugin-omo-toolkit
```

只想在某个项目里改，就在该项目的 `.omp/plugin-overrides.json` 中写上：

```json
{ "settings": { "wows-omp-plugin-omo-toolkit": { "commentChecker": true } } }
```

设置在会话启动或切换时读取，修改后请重新加载或重启。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `commentChecker` | `false` | 用 comment-checker 检查代理修改的每个文件，并显示发现。 |
| `commentCheckerPath` | 空 | 为空时通过 Bun 运行固定版本的 comment-checker。否则填你自己的兼容可执行文件（相对会话目录的路径）或 `PATH` 中的命令。 |
| `initDeepAdvisor` | `true` | 指引缺失或过时时，在会话启动时建议运行 `init-deep`。不经你同意绝不会运行。 |
| `fallbackArchitect` | `false` | 模型拒绝并自动回退后，建议代理咨询 `architect`。 |

值无效时只关闭它所属的功能，并说明读到的是什么值。代理和它们的说明不受这些设置影响。

### 代理的模型

每个代理的模型来自你的 OMP 模型角色，见上面的[代理](#代理)表格。插件会在 `/models` 中添加 `designer` 和 `writer` 两个角色，但不分配模型；分配之前，这两个代理使用 `@task`。

想单独改某个代理的模型，在 `~/.omp/agent/config.yml` 中设置 `task.agentModelOverrides`：

```yaml
task:
  agentModelOverrides:
    ultrabrain: anthropic/claude-opus-5-5
```

OmO 在 `omo.json` 里配置模型；在 OMP 中请改用模型角色和上面的覆盖设置。哪些模型适合哪些代理，可以参考 OmO 的 [Agent-Model Matching Guide](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/agent-model-matching.md)。

## 与其他插件配合

- **omo-prometheus** 和 **omo-ultrawork** 安装后会使用这些代理，没有它们时回退到 OMP 的 `task` 代理（`librarian` 先回退到 `scout`，再到 `task`）。Prometheus 最终的代码质量、QA 和证据评审在 `deep-high` 或 `deep-low` 上运行。
- **judge-dispatch** 只会把只读请求（包括 `librarian`）路由到其他只读代理。

## 已知限制

- `librarian` 需要一个能调用工具的聊天模型。它先用你的 `tiny` 角色，再用 `smol`。如果 `tiny` 指向一个本地的小型标题模型，请用 `task.agentModelOverrides` 把 `librarian` 设为 `@smol`。
- `librarian` 不能运行 shell 命令，所以无法使用需要认证的 `gh` 搜索。不保证能访问私有来源；读不到的内容会如实报告为不可用。
- `ultimate-browsing` 只提供指引。它没有抓取引擎或 cookie 工具，某些平台可能只能拿到部分内容，需要登录的页面要用你自己登录过的浏览器会话。
- `visualize` 给你的是文件路径、摘要和截图，不会在聊天里直接显示 HTML。
- 注释检查无法判断一条针对整个文件的发现是不是来自最近一次修改。
- `coding-agent-sessions` 每次扫描最多查看最近的 2,000 个会话文件。会话很多时，请指定更小的目录。
- `frontend` 的页面检查会把它在文件夹中找到的 HTML 文件列为未渲染。结果干净也不代表完成了完整的视觉或无障碍检查。

## 更多细节

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍了代理的工具权限、技能辅助脚本、渲染页面检查器、评审与评估规则、注释检查器的调用方式、建议何时出现及其状态保存在哪里、`toolkit_init_deep` 工具、回退提示，以及在 RPC、ACP 编辑器和无界面模式下的表现。

## 许可证

原创的打包部分采用 MIT 许可证。移植的代理、技能和代理选择规程（`src/selection-protocol.ts`）是 OmO 修订版 `fe427efeed97e95f009dc6ca7fb17a3ac857f79f` 和 `adddd17004076e799c2de18ccfdee29e12525ace` 的衍生作品，适用 Sustainable Use License 1.0。修订版 `8a8db1d3094da8743989bf693ee5de77889de50e` 中新增的运行时组件和技能，同样是 Sustainable Use License 1.0 的衍生作品。原创的 OMP 接线和设置代码仍采用 MIT 许可证。部分前端规则和渲染页面检查器还分别遵循 Impeccable（Apache License 2.0）和 StyleGallery（MIT）。前端设计参考资料在 `skills/frontend/` 中保留了 Apache License 2.0 署名。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
