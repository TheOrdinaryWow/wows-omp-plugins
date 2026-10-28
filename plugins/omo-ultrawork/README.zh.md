<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-dark.png">
  <img alt="omo-ultrawork" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-light.png">
</picture>

# omo-ultrawork

[English](README.md) | 简体中文

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的 ultrawork 工作流在 OMP 上的移植。在请求里输入 `ulw`，代理就会以结果为先，把工作端到端完成并用可观察的证据支撑成功标准。插件还提供按依赖顺序分发的 `mass-ulw`、使用原生目标驱动持久执行的 `/ulw-loop`、对抗式规划 `/hyperplan`，以及忠于来源的调研报告流程 `/ulw-research`。

## 安装

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

需要 OMP 18.10.4 或更高版本。调研辅助脚本需要 `PATH` 中的 Node 20+ 或 Bun；浏览器、文档转换器、字体和图表工具按任务需要使用，不是插件运行时依赖。首次安装后请重启会话。

## 快速上手

```text
ulw fix the flaky upload test and make CI green
/ulw                               # keep ultrawork on for every message
/hyperplan migrate auth to OAuth   # debate a plan before writing it
/ulw-loop deliver a restart-safe upload CLI with observable acceptance criteria
/ulw-research compare SQLite WAL and rollback journal for our workload
```

进入 ultrawork 模式后，第一条回复以 `ULTRAWORK MODE ENABLED!` 开头，页脚显示 `Ultrawork armed` 或 `Ultrawork mode`。

## 用法

### Ultrawork 模式

把 `ulw` 或 `ultrawork` 作为独立的工作流词输入，插件会将 ultrawork 指令附到这条输入。同一会话之后使用简短提醒，压缩后再恢复完整指令。代码、块引用、普通引号内容、转述头、URL、否定调用以及路径或标识符邻接都不触发：`Do not use ulw`、`"ulw"`、`.omo/ulw/`、`/ulw-plan` 和 `mass-ulw-refactor` 不会开启模式。显式 `/ultrawork` 与 `/ulw` 保留命令授权行为。

指令通过输入转换附在同一条消息上，包括排队输入及其图片，不会以 aside 干扰正在进行的工作。触发后首次成功的 todo `init` 或 `append` 会通过工具结果附带一次分发提醒；压缩后重新启用。

`/ultrawork` 或 `/ulw` 会开启持续模式，此后每条消息都无需关键词即进入 ultrawork。再次运行任一命令即可关闭。`/ultrawork <request>` 会开启模式，并把请求作为你的下一条消息发出。

持续模式开启时，页脚显示 `Ultrawork mode`；由关键词触发后显示 `Ultrawork armed`。模式和触发状态保存在会话中，恢复、切换、分支和树导航时都会还原。

原版说明见 OmO 文档：[Ultrawork Mode](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/overview.md#ultrawork-mode-for-the-lazy)。

### 不要与 `orchestrate` 混用

OMP 内置的 `orchestrate` 关键词会注入它自己的规则，在提交、验证和委派方面与 ultrawork 相互矛盾。当消息里出现 OMP 会响应的 `orchestrate` 时，本插件不会为这条消息注入任何内容，并显示警告；持续模式从下一条消息起恢复。`/ultrawork orchestrate …` 会拒绝开启持续模式。如果你经常使用 ultrawork，建议关闭内置关键词：

```bash
omp config set magicKeywords.orchestrate false
```

### mass-ulw

`mass-ulw` 是一个技能，通过 `eval` 运行由子代理任务（`{ id, prompt, agent, dependsOn?, label? }`）组成的依赖图。启动任何任务前，它会先校验 id、依赖关系和环；每次运行一批已就绪的节点，读完它们的报告再启动下一批。最后还有一步验证来检查证据，因为子代理跑完并不等于工作已被接受。状态和报告在内核重置后仍会保留。

输入 `mass ulw`、`mass-ulw`、`ulw-mass`、`mulw` 或 `meth` 会把代理引向这个技能；其中 `mulw` 和 `meth` 本身不会触发 ultrawork。没有依赖关系的独立工作，用一次普通的 `task` 批量调用更简单。

原版说明见 OmO 文档：[Dependency graphs: mass-ulw](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#dependency-graphs-mass-ulw)。

### /ulw-loop

`/ulw-loop <objective>` 授权持久循环，创建一个由插件拥有的 OMP 原生目标，再提交已缓存的 `ulw-loop` 技能。OMP 的 TUI/RPC 目标控制器负责继续运行、预算与暂停；插件负责子目标、标准定义、尝试、转向及证据。仅使用 SDK 不会因此获得自动续跑控制器。

裸 `/ulw-loop` 或 `/ulw-loop status` 查看状态，`/ulw-loop pause|resume|stop` 只管理这个循环；用户显式输入 `/ulw-loop reset` 才会归档状态与证据。停止不是成功，也不会取消子代理。每个会话只有一个聚合目标，完成后只读，无关工作应使用新会话。关闭普通 `/ulw` 不会停止循环。

`ulw_loop` 工具读取作为权威来源的简报文件，接受有类型的目标与标准。`complete_goals` 只取得或恢复一个可执行目标，并不宣告完成。失败目标只在 `retryFailed:true` 时重试；阻塞或没有可执行工作不等于成功。非最终检查点需要新鲜的必要标准；最终验收需要全部当前标准、已声明的批次关口、真实界面或来源 QA，以及本会话独立子代理给出的目标与标准评审 PASS。

状态格式为 1，保存在 `<sessionDir>/ulw-loop/<sessionId>/state.json`；复制并校验哈希的证据放在 `evidence/` 子目录，日志与状态以单次原子事务发布。`--no-session` 会收到 `ULW_LOOP_PERSISTENCE_REQUIRED`，不会向项目写入循环状态，也不会把临时存储冒充持久存储。在 Git 仓库中，证据采集及完成都要求受跟踪文件干净，并绑定完整 `HEAD^{tree}`：rebase/amend 后树相同仍然有效，字节改变则必须重新采集。插件绝不自动 stash 或 reset。非 Git 调研改用来源与报告文件的哈希。

Plan Mode、`/audit` 和无关的活动或暂停原生目标保留控制权：启动或恢复时拒绝接管外来驱动；驱动变更、暂停、预算受限、丢弃或过早完成时，未验收标准保持暂停。只有用户显式 `/ulw-loop resume` 才能重建缺失或过早完成的驱动。已批准的 Atlas 计划仍是独立控制流程，不把子任务另起循环，也不新建第二本笔记。详见[持久循环契约](REFERENCE.zh.md#持久循环契约)。

### 自然语言入口引导

`ulw plan`、`ulw-plan` 和 `ulwplan` 会有条件地建议用户在安装 `omo-prometheus` 后输入 `/prometheus <request>`，绝不自动开启 Plan Mode。循环写法会有条件地引向 `skill://ulw-loop` 与显式 `/ulw-loop` 命令。讨论调研时只提示 `/ulw-research`；`use ulw research to compare X` 这类明确的句首正向请求会注入与命令共用的缓存私有流程和固定资源包。mass 与 research 的组合保留单一执行所有者和单一调研流程。提问、引号、否定及标识符或路径近似项都不会成为绑定请求。


### /hyperplan

`/hyperplan <request>` 让五个评审角色进行三轮对抗式辩论，每个角色只从一个角度挑战草案：多余的复杂度与范围膨胀、集成缺口与边界情况、未经验证的假设、架构缺陷，以及被忽略的替代方案。随后由独立的规划者把辩论结果写成计划。第一行输出为 `HYPERPLAN MODE ENABLED!`。

原版说明见 OmO 文档：[Adversarial alternative: /hyperplan](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#adversarial-alternative-hyperplan)。

### /ulw-research

`/ulw-research <request>` 通过并行来源采集、机器可读的论断图、扩展与反向检索，以及忠于来源的交付关口生成带引用的调研报告。第一行输出为 `ULW-RESEARCH MODE ENABLED!`。这是一套使用 OMP 原生代理的私有流程，不是模型可自行加载的技能。若已有明确激活的 `ulw-loop`，调研可将目标与证据纳入其中；否则沿用调研日志生命周期，不自动创建循环或原生目标。

来源保存为带提取出处与哈希的不可变快照。数字和直接引文通过来源定位器进入事实账本，再经确定性的占位符与填充映射进入 HTML/Markdown。保真验证会检查已锁定的简报、来源快照、单位、派生数值、引文、语句与论断绑定，以及图表数据。每个字节不同的交付版本都需要匹配的验证记录；PDF/DOCX 还需指明生成它们的已验证源文件。简报启用语义检查时，独立的低成本与强判断阅读代理核对来源配对语句；文字校对只提出受保护的修改，不直接改动事实。

五个关口依次为静态 → 保真与语义 → 布局 → 视觉 → 校对，润色后还要重跑保真与已变语句的语义检查。完整报告需要有意义的已渲染图像及描述性替代文本。视觉复刻需附真实来源与输出在相同时间点、视角下的对照，并披露剩余差异。修复预算耗尽不能豁免未解决的保真阻断或主要缺陷。OMP 没有内联 HTML 工具：交付独立文件、适当的浏览器实测截图、聊天摘要和辅助脚本打印的收尾简报。

**有意保留的上游差异：** 普通静态来源优先使用原生静态读取，并保留不可变快照；当论断依赖渲染、登录或访问状态、交互、视觉状态时，必须取得浏览器证据。`source snapshot --url` 只是原始抓取，不证明浏览器或登录态访问。浏览器采集的 HTML/文本必须按真实提取出处导入，不能另抓一次 URL 作为替代。

调研日志仍写入 `<tmpdir>/ulw-research/` 或 `researchScratchDir`，最终文件放在指定位置。插件在模块加载时缓存完整调研资源包，随后在 `<sessionDir>/ulw-research-assets/<upstream-pin>-<digest>/` 下校验并生成固定版本的内容寻址副本。因此，即使升级删除了旧安装目录，运行中会话缓存的脚本和参考资料仍可使用。`--no-session` 使用由当前用户拥有、权限私有的系统临时目录；该副本明确不持久化，也绝不会写到项目工作目录。旧 outcome v1 调研仍可读取，但标记为 `legacy_unverified`；恢复或重新交付必须取得当前保真证据，不能沿用历史豁免。

保真流程来源固定为 [oh-my-openagent 8a8db1d](https://github.com/code-yeongyu/oh-my-openagent/tree/8a8db1d3094da8743989bf693ee5de77889de50e/packages/shared-skills/skills/ulw-research)。

`/hyperplan` 和 `/ulw-research` 都拒绝空请求，并且只能在主会话中运行。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-omo-ultrawork`。

```bash
omp plugin config list wows-omp-plugin-omo-ultrawork
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `keywordTrigger` | boolean | `true` | 为 false 时，输入关键词不会触发普通 ultrawork；工作流引导、绑定调研请求及显式命令仍可用。 |
| `keywords` | 逗号分隔的字符串 | `ulw,ultrawork` | 不区分大小写的字面触发词，带工作流、路径及标识符边界防护；空字符串只关闭通用关键词触发。 |
| `researchScratchDir` | 字符串 | 空（`<tmpdir>/ulw-research`） | 调研临时文件的根目录。相对路径相对于会话的工作目录解析。 |

设置在会话启动和切换会话时读取，修改后请重启会话。

## 与其他插件配合

- 安装了 `omo-toolkit` 时，`/hyperplan` 和 `/ulw-research` 会使用它的分类代理（`deep-low`、`ultrabrain`、`artistry`、`librarian`、`writing`）；没有安装时回退到 `task` 和 `scout`，所有命令照常可用。
- 安装了 `omo-prometheus` 时，如果已有经 `/prometheus` 批准的计划，ultrawork 会以该计划为准，不再另写计划。

## 不使用终端界面时

关键词和所有命令都可以在 RPC、ACP 编辑器、SDK 和 headless 模式下使用，都不需要对话框。没有 UI 时，用法错误和模式变化会以可见的会话消息显示。

客户端程序可以从状态快照读取当前模式，见[参考文档](REFERENCE.zh.md#状态快照)。

## 已知限制

- 扩展生成的消息和子会话中的关键词会被忽略。
- `/hyperplan` 与 `/ulw-research` 仍是私有提示词，而非公开技能；自然语言调研绑定直接使用私有请求载荷。公开技能为 `mass-ulw` 与 `ulw-loop`。
- 持久循环需要可持久化的会话。没有循环所有权的调研也可在 `--no-session` 下使用，但临时资源快照不持久化。
- 循环不会强行开启目标续跑设置，也不绕过宿主的预算、Plan Mode 或用户暂停规则。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍关键词与指令投递规则、各命令使用的代理、`mass-ulw` 的持久化方式以及状态快照。

## 许可证

扩展代码和原创打包部分采用 MIT 许可证。修改后的提示词资源和随附的调研脚本采用 SUL-1.0。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
