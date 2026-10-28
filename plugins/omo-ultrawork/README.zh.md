<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-dark.png">
  <img alt="omo-ultrawork" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-light.png">
</picture>

# omo-ultrawork

[English](README.md) | 简体中文

这是 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的 ultrawork 工作流在 OMP 上的移植。在请求里写上 `ulw`，代理会以结果为先，把事情从头做到尾，并用观察到的证据支撑每条成功标准。插件另外提供按依赖顺序分发子代理的 `mass-ulw`、用原生目标持久推进的 `/ulw-loop`、对抗式规划的 `/hyperplan`，以及附带引用的调研报告 `/ulw-research`。

## 安装

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

需要 OMP 18.10.4 或更高版本。调研辅助脚本需要 `PATH` 中有 Node 20+ 或 Bun。浏览器、文档转换器、字体和图表工具都是可选的，任务需要时才会用到。首次安装后请重启会话。

## 快速上手

```text
ulw fix the flaky upload test and make CI green
/ulw                               # keep ultrawork on for every message
/hyperplan migrate auth to OAuth   # debate a plan before writing it
/ulw-loop deliver a restart-safe upload CLI with observable acceptance criteria
/ulw-research compare SQLite WAL and rollback journal for our workload
```

进入 ultrawork 模式后，第一条回复以 `ULTRAWORK MODE ENABLED!` 开头。页脚会显示 `Ultrawork armed` 或 `Ultrawork mode`。

## 用法

### Ultrawork 模式

把 `ulw` 或 `ultrawork` 作为一个单独的词写进消息，就能为这条消息启用 ultrawork。同一会话里之后再触发时，只会附上一段简短提醒；会话压缩后，完整指令会重新附上。

以下情况不会触发：代码、引号里的文字、块引用、URL、转述头，以及否定句（如 `Do not use ulw`），还有与路径或标识符连在一起的写法（如 `.omo/ulw/`、`/ulw-plan`、`mass-ulw-refactor`）。显式的 `/ultrawork` 和 `/ulw` 命令始终有效。

指令会附在同一条输入上，排队中的消息及其图片也一样，所以不会打断正在进行的工作。关键词和交付规则的完整说明见 [REFERENCE.zh.md](REFERENCE.zh.md)。

`/ulw` 或 `/ultrawork` 会开启持续模式，之后每条消息都会进入 ultrawork，不必再写关键词。再运行一次同一命令即可关闭。`/ultrawork <request>` 会开启模式，并把这段请求作为你的下一条消息发出。

持续模式下，页脚显示 `Ultrawork mode`；由关键词触发后，页脚显示 `Ultrawork armed`。两种状态都保存在会话里，恢复、切换、分支和树导航后都会还原。

原版说明见 OmO 文档：[Ultrawork Mode](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/overview.md#ultrawork-mode-for-the-lazy)。

### 不要与 `orchestrate` 混用

OMP 内置的 `orchestrate` 关键词会附加自己的规则，这些规则在提交、验证和委派方面与 ultrawork 相冲突。消息中只要有 OMP 会响应的 `orchestrate`，插件就不会为这条消息附加任何内容，并会显示警告。持续模式从下一条消息起恢复。`/ultrawork orchestrate …` 会拒绝开启持续模式。

如果你经常使用 ultrawork，可以关闭内置关键词：

```bash
omp config set magicKeywords.orchestrate false
```

### mass-ulw

`mass-ulw` 是一个技能，通过 `eval` 运行由子代理任务组成的依赖图，每个任务的格式为 `{ id, prompt, agent, dependsOn?, label? }`。启动任何任务前，它会先检查 id、依赖关系和循环依赖。它每次运行一批已就绪的节点，读完这批的报告后才启动下一批。最后还有一步验证，检查证据，因为子代理跑完不等于工作已被接受。状态和报告在内核重置后仍会保留。

输入 `mass ulw`、`mass-ulw`、`ulw-mass`、`mulw` 或 `meth`，会把代理引到这个技能。`mulw` 和 `meth` 本身不会启用 ultrawork。如果是没有依赖关系的独立任务，一次普通的 `task` 批量调用更简单。

原版说明见 OmO 文档：[Dependency graphs: mass-ulw](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#dependency-graphs-mass-ulw)。

### /ulw-loop

`/ulw-loop <objective>` 授权一个持久循环。它会创建一个由本插件拥有的 OMP 原生目标，然后提交已缓存的 `ulw-loop` 技能。续跑、预算和暂停由 OMP 的目标控制器负责；子目标、标准、尝试、转向和证据由插件负责。仅使用 SDK 时，本插件不会提供续跑控制器。

- `/ulw-loop` 或 `/ulw-loop status` 查看状态。
- `/ulw-loop pause`、`resume` 和 `stop` 只作用于当前循环。
- 用户亲自输入 `/ulw-loop reset`，会归档该循环的状态和证据。

停止不等于成功，也不会取消子代理。每个会话只有一个循环。循环完成后变为只读，无关工作请另开新会话。关闭普通 `/ulw` 不会停止循环。

最终验收需要满足所有当前标准、已声明的批次关口、真实界面或来源 QA，以及本会话中一个独立子代理给出的 PASS 评审。失败的目标只有在 `retryFailed:true` 时才会重试。阻塞或没有可执行工作的情况不算成功。在 Git 仓库中，采集证据和完成循环都要求受跟踪的文件是干净的。插件从不 stash 或 reset 你的工作。完整约定见[持久循环契约](REFERENCE.zh.md#持久循环契约)。

Plan Mode、`/audit` 和无关的原生目标各自保留控制权。恢复时会拒绝接管别人的驱动，只有用户显式执行 `/ulw-loop resume`，才会重建缺失或已完成的驱动。已批准的 Atlas 计划是独立的控制流程，循环不会从它派生子任务。

### 自然语言入口引导

`ulw plan`、`ulw-plan` 和 `ulwplan` 在安装了 `omo-prometheus` 时，会建议你输入 `/prometheus <request>`。它们绝不会自动开启 Plan Mode。循环相关的说法会指向 `/ulw-loop` 和 `skill://ulw-loop`。讨论调研时，则指向 `/ulw-research`。

句首明确的请求（如 `use ulw research to compare X`）会运行与命令相同的调研流程。提问、引号内容、否定句，以及与标识符或路径相似的写法，都不算请求。

### /hyperplan

`/hyperplan <request>` 让五个评审角色进行三轮辩论。每个角色只从一个角度挑战草案：多余的复杂度和范围膨胀、集成缺口和边界情况、未经验证的假设、架构缺陷，或被忽略的替代方案。随后由独立的规划者根据辩论结果写出计划。第一行输出为 `HYPERPLAN MODE ENABLED!`。

原版说明见 OmO 文档：[Adversarial alternative: /hyperplan](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#adversarial-alternative-hyperplan)。

### /ulw-research

`/ulw-research <request>` 会生成一份带引用的调研报告。它并行收集来源，构建可机器读取的论断图，对线索做扩展和反向检索，最后经过交付关口。第一行输出为 `ULW-RESEARCH MODE ENABLED!`。

这套流程是私有的，运行在 OMP 原生代理上，模型无法像技能一样自行加载。如果一个正在进行的 `ulw-loop` 拥有这项调研的目标，调研就使用该循环的目标和证据。否则，调研沿用自己的日志，不会创建循环或原生目标。

五道关口依次为：静态检查、保真与语义、布局、视觉和校对。润色之后，会重新检查保真和改动语句的语义。完整报告需要渲染后的视觉图像，并附有描述性替代文本。每个交付版本都需要单独的保真检查。修复预算用完，也不能豁免未解决的保真阻断项或重大缺陷。

普通静态来源通过原生读取获取，并保存为不可变快照。当论断依赖渲染结果、登录或访问状态、交互或视觉状态时，则必须取得浏览器证据。浏览器采集的 HTML 或文本保留其真实的提取来源，不能改为重新抓取一次 URL 来替代。这是本插件相对上游 OmO 有意保留的差异。

调研日志写入 `<tmpdir>/ulw-research/` 或 `researchScratchDir`，最终文件放在你指定的位置。插件在加载时缓存调研脚本，因此升级插件不会影响正在运行的会话。存储细节见 [REFERENCE.zh.md](REFERENCE.zh.md)。

调研保真流程的来源固定在 [oh-my-openagent 8a8db1d](https://github.com/code-yeongyu/oh-my-openagent/tree/8a8db1d3094da8743989bf693ee5de77889de50e/packages/shared-skills/skills/ulw-research)。

`/hyperplan` 和 `/ulw-research` 会拒绝空请求，并且只能在主会话中运行。

## 设置

`omp plugin config` 使用的包名是 `wows-omp-plugin-omo-ultrawork`。

```bash
omp plugin config list wows-omp-plugin-omo-ultrawork
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `keywordTrigger` | boolean | `true` | 为 false 时，输入关键词不会启用普通 ultrawork。工作流引导、绑定的调研请求和显式命令仍然有效。 |
| `keywords` | 逗号分隔的字符串 | `ulw,ultrawork` | 不区分大小写的字面触发词，带有工作流、路径和标识符边界防护。空字符串只关闭通用的关键词触发。 |
| `researchScratchDir` | 字符串 | 空（`<tmpdir>/ulw-research`） | 调研临时文件的根目录。相对路径相对于会话的工作目录解析。 |

设置在会话启动和切换会话时读取，修改后请重启会话。

## 与其他插件配合

- 安装了 `omo-toolkit` 时，`/hyperplan` 和 `/ulw-research` 会使用它的分类代理（`deep-low`、`ultrabrain`、`artistry`、`librarian`、`writing`）。没有安装时，它们回退到 `task` 和 `scout`。缺少 `deep-low` 时，`/hyperplan` 只用四个评审角色运行。所有命令都照常可用。
- 安装了 `omo-prometheus` 时，已通过的 `/prometheus` 计划是准绳，ultrawork 不会另写一份计划。

## 不使用终端界面时

关键词和所有命令都可以在 RPC、ACP 编辑器、SDK 和 headless 运行中使用，不需要对话框。没有 UI 时，用法错误和模式变化会以可见的会话消息显示。

客户端程序可以从状态快照中读取当前模式，见[参考文档](REFERENCE.zh.md#状态快照)。

## 已知限制

- 扩展生成的消息和子会话中的关键词会被忽略。
- `/hyperplan` 和 `/ulw-research` 是私有提示词，不是公开技能。自然语言调研绑定直接使用私有请求载荷。公开技能只有 `mass-ulw` 和 `ulw-loop`。
- 持久循环需要可持久化的会话。调研在 `--no-session` 下也能用，但其临时资源副本不持久。
- 循环不会打开目标续跑设置，也不会绕过宿主的预算、Plan Mode 或用户暂停规则。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍关键词与交付规则、各命令使用的代理、`mass-ulw` 的持久化方式、持久循环契约以及状态快照。

## 许可证

扩展代码和原创打包部分采用 MIT 许可证。修改后的提示词资源和随附的调研脚本采用 SUL-1.0。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
