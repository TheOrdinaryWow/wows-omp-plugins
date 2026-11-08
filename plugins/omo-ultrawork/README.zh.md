<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-dark.png">
  <img alt="omo-ultrawork" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-ultrawork-light.png">
</picture>

# omo-ultrawork

[English](README.md) | 简体中文

> 在请求里加上 `ulw`，代理就会把事情做到底，并拿出确实能用的证据。

这个插件把 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的 ultrawork 工作流带到了 OMP。打开 ultrawork 后，代理不会停在一个看起来像样的答案上：它会把请求一路做完，每条成功标准都要有它亲眼看到的东西作为依据，比如通过的测试或能跑通的命令。插件还提供几个应对大活的命令：`mass-ulw` 按依赖顺序运行大批子代理任务，`/ulw-loop` 跨多轮持续推进一个目标直到满足标准，`/hyperplan` 让评审者在写计划之前先轮番挑刺，`/ulw-research` 生成附带来源的调研报告。

## 安装

```bash
omp plugin install omo-ultrawork@wows-omp-plugins
```

需要 OMP 18.17.0 或更高版本。`/ulw-research` 还需要 `PATH` 中有 Node 20 或更高版本，或者 Bun；浏览器、文档转换工具、字体和图表工具只在报告用得到时才会使用。安装后重启会话。

## 快速上手

```text
ulw fix the flaky upload test and make CI green
/ulw                               # 让之后的每条消息都使用 ultrawork
/hyperplan migrate auth to OAuth   # 先辩论，再写计划
/ulw-loop deliver a restart-safe upload CLI with observable acceptance criteria
/ulw-research compare SQLite WAL and rollback journal for our workload
```

进入 ultrawork 模式后，代理的第一条回复以 `ULTRAWORK MODE ENABLED!` 开头，页脚显示 `Ultrawork armed`（仅本条消息）或 `Ultrawork mode`（每条消息）。

## 用法

### 打开 ultrawork

在消息任意位置把 `ulw` 或 `ultrawork` 作为一个独立的词写出来，这条消息就会使用 ultrawork。同一会话中之后再用，只会附加一段简短提醒；对话被压缩后，完整的说明会重新加上。

以下情况不算：写在代码、引号或引用块里，出现在 URL 中，像 `Do not use ulw` 这样的否定说法，或者作为路径和名称的一部分，比如 `.omo/ulw/`、`/ulw-plan`、`mass-ulw-refactor`。`/ultrawork` 和 `/ulw` 命令总是有效。

想让之后每条消息都用 ultrawork，运行 `/ulw` 或 `/ultrawork`，再运行一次就关闭。`/ultrawork <request>` 会打开这个模式并立即发送请求。恢复或切换会话时，模式会被记住。

ultrawork 的说明会随你的消息一起送出，排队的消息和其中的图片也一样，所以不会打断已经在进行的工作。

OmO 的原始介绍：[Ultrawork Mode](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/overview.md#ultrawork-mode-for-the-lazy)。

### 不要和 `orchestrate` 混用

OMP 自带的 `orchestrate` 关键词会加入关于提交、验证和委派的规则，和 ultrawork 冲突。当 OMP 在某条消息里响应了 `orchestrate`，本插件就不处理这条消息，并给出警告；持续模式从下一条消息起照常生效。`/ultrawork orchestrate …` 会拒绝打开持续模式。

如果你经常用 ultrawork，可以关掉内置关键词：

```bash
omp config set magicKeywords.orchestrate false
```

### 用 `mass-ulw` 按顺序跑大批任务

`mass-ulw` 是一个技能，适合能拆成很多子代理任务、其中一些任务依赖另一些的工作。代理写出每个任务和它依赖的任务；技能在开始前检查这张依赖图有没有错误或循环，然后分批运行已经可以开始的任务，并在开始下一批之前读完这一批的报告。最后一步会核对证据，因为子代理跑完不等于工作被接受。即使代理的脚本运行环境重启，进度也不会丢。

在执行会花钱或无法撤销的运行之前，代理会先在主会话里问你。你关掉问题或没有回答，这次运行就不会开始。想按名字反复使用的图，可以放在项目的 `.omp/dags/` 或 `~/.omp/dags/` 里。保存或加载图本身不会启动任何运行，每次运行都从新的进度开始。

输入 `mass ulw`、`mass-ulw`、`ulw-mass`、`mulw` 或 `meth` 会把代理引向这个技能（`mulw` 和 `meth` 本身不会打开 ultrawork）。如果只是几个相互独立的任务，直接用一次并行的 `task` 调用更简单。

OmO 的原始介绍：[Dependency graphs: mass-ulw](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#dependency-graphs-mass-ulw)。

### 用 `/ulw-loop` 持续推进一个目标

`/ulw-loop <objective>` 会启动一个循环，跨多轮持续工作，直到目标的标准都满足为止。它以 OMP 目标（goal）的形式运行，所以续跑、预算和暂停由 OMP 负责，插件负责记录子目标、标准、尝试和证据。

- `/ulw-loop` 或 `/ulw-loop status` 查看进展。
- `/ulw-loop pause`、`/ulw-loop resume` 和 `/ulw-loop stop` 控制这个循环。
- `/ulw-loop reset` 归档循环的状态和证据，只能由你本人运行。

只有每条现行标准都有证据、工作已在真实界面或源码中检查过，并且另一位评审者给出通过，循环才算完成。停止不等于成功，也不会停掉已经在跑的子代理。在 Git 仓库中，只有已跟踪的文件没有未提交的改动时，循环才能记录证据和完成；它绝不会替你 stash 或重置改动。

一个会话只有一个循环。完成的循环变为只读，做无关的工作请开新会话。关闭 `/ulw` 不会停止循环。

### 用 `/hyperplan` 辩论计划

`/hyperplan <request>` 让五位评审者针对计划草稿辩论三轮。每位评审者从一个角度挑刺：不必要的复杂度和范围蔓延、集成缺口和边界情况、未经验证的假设、架构缺陷，或者被忽略的替代方案。之后由一位独立的规划者根据辩论结果写出计划，格式与 `/prometheus` 相同。回复以 `HYPERPLAN MODE ENABLED!` 开头。

OmO 的原始介绍：[Adversarial alternative: /hyperplan](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#adversarial-alternative-hyperplan)。

### 用 `/ulw-research` 写调研报告

`/ulw-research <request>` 生成一份每个论断都能追溯到来源的报告。代理并行收集来源，追踪线索，搜索反面证据，交付前还要通过五道检查：结构、对来源的忠实度和语义、版面、视觉效果以及校对。完整的报告包含渲染好的图表，并配有描述性的替代文本。回复以 `ULW-RESEARCH MODE ENABLED!` 开头。

工作笔记存放在 `<tmpdir>/ulw-research/` 或 `researchScratchDir` 指定的位置。最终报告放在你要求的地方。

刷新来源时，插件会保留旧的副本，此前论断所依据的证据不会丢失。在浏览器里采集的页面，需要在浏览器里重新采集，插件不会直接重新下载。

`/hyperplan` 和 `/ulw-research` 都需要带上请求，并且只能在主会话中运行。

### 会引向对应命令的说法

- `ulw plan`、`ulw-plan` 或 `ulwplan`：安装了 omo-prometheus 时，会建议你使用 `/prometheus <request>`。它本身从不打开 Plan Mode。
- 提到要做循环：把代理引向 `/ulw-loop`。
- 谈论调研：引向 `/ulw-research`。在句首明确提出的请求，比如 `use ulw research to compare X`，会直接开始调研；问句、引用和否定说法不算。

## 设置

为当前用户修改设置：

```bash
omp plugin config set wows-omp-plugin-omo-ultrawork keywordTrigger false
omp plugin config set wows-omp-plugin-omo-ultrawork keywords 'focus,ship'
omp plugin config set wows-omp-plugin-omo-ultrawork researchScratchDir /tmp/my-research
omp plugin config list wows-omp-plugin-omo-ultrawork
```

只想在某个项目里改，就在该项目的 `.omp/plugin-overrides.json` 中写上：

```json
{ "settings": { "wows-omp-plugin-omo-ultrawork": { "keywords": "focus,ship" } } }
```

设置在会话启动或切换时读取，修改后请重启会话。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `keywordTrigger` | `true` | 设为 `false` 后，输入关键词不再打开 ultrawork。命令、引向其他命令的提示和直接的调研请求仍然有效。 |
| `keywords` | `ulw,ultrawork` | 打开 ultrawork 的词，用逗号分隔，不区分大小写。设为空只会关闭关键词触发。 |
| `researchScratchDir` | 空 | `/ulw-research` 存放工作笔记的位置。为空表示 `<tmpdir>/ulw-research`；相对路径相对于会话所在目录。 |

## 与其他插件配合

- **omo-toolkit**：安装后，`/hyperplan` 和 `/ulw-research` 会使用它的专长代理；没有安装时使用 OMP 的 `task` 和 `scout` 代理。缺少它的 `deep-low` 代理时，`/hyperplan` 以四位评审者进行。无论哪种情况，所有命令都能用。
- **omo-prometheus**：已批准的 `/prometheus` 计划主导工作，所以 ultrawork 不会再写一份计划，循环也不会把计划拆成自己的子目标。
- **audit-goal**：正在运行的 `/audit` 保留自己的目标，`/ulw-loop` 不会接管它。

## 已知限制

- 其他插件生成的消息里的关键词，以及子代理会话中的关键词，都会被忽略。
- `/hyperplan` 和 `/ulw-research` 是命令，不是代理能自行加载的技能。可加载的技能是 `mass-ulw` 和 `ulw-loop`。
- `/ulw-loop` 需要已保存的会话。调研在 `--no-session` 下也能运行，但它的工作文件只是临时的。
- 循环不会替你打开 OMP 的目标续跑设置，并且遵守 OMP 的预算、Plan Mode 以及你的暂停。

## 更多细节

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍了关键词和投递的具体规则、每个命令使用哪些代理、`mass-ulw` 如何保存进度、循环的验收规则、调研流程与存储、在 RPC、ACP 编辑器和无界面模式下的表现，以及状态快照。

## 许可证

扩展代码和原创打包部分采用 MIT 许可证。修改后的提示词资源和随附的调研脚本采用 SUL-1.0。详见 `NOTICE`、`LICENSE-MIT` 和 `LICENSE-SUL-1.0`。
