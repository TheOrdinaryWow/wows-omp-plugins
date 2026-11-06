<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-dark.png">
  <img alt="omo-prometheus" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-light.png">
</picture>

# omo-prometheus

[English](README.md) | 简体中文

> 大改动先交给一个会问对问题的代理来规划，再一个任务一个任务地执行，每个任务都要有完成的证据。

面对一个规模大或者目标不清的改动，直接动手写代码往往会走偏。这个插件把 [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的 Prometheus 规划器和 Atlas 执行器带到了 OMP，建立在 OMP 的 Plan Mode 之上：

- **Prometheus** 负责规划。动笔之前，它会让 **Metis** 检查你真正想要什么、还缺什么，并且只问那些答案会改变计划的问题。**Momus**（工作更难时再加上 **Oracle**）可以评审计划，因为遗漏了东西或者做了超出需要的东西而驳回它。
- **Atlas** 负责执行已批准的计划。它把每个任务交给子代理，只有子代理的结果证明任务完成了才算数，最后再做四项独立评审。Atlas 运行期间，主会话自己从不修改文件。

## 安装

```bash
omp plugin install omo-prometheus@wows-omp-plugins
```

需要 OMP 18.17.0 或更高版本，并启用 Plan Mode（`plan.enabled`，默认开启）。安装后重启 OMP。

如果你用过旧的 `prometheus` 插件，请先用 `omp plugin uninstall prometheus@wows-omp-plugins` 卸载它。它的计划不会迁移过来，请重新开始规划。

## 快速上手

```text
/prometheus add rate limiting to the public API
```

1. Prometheus 进入 Plan Mode，咨询 Metis 并向你提问。回答到它提出计划为止。
2. 查看计划，在 OMP 常规的批准对话框中批准。
3. Atlas 会自动开始。编辑器上方的小组件显示进度，`/atlas` 打开完整视图。
4. 所有任务、四项最终评审和交付步骤（如果有）都通过后，计划就完成了。随时可以用 `/atlas exit` 退出 Atlas。

## 用法

### 用 `/prometheus` 做规划

`/prometheus` 会进入 Plan Mode；如果会话已经在 Plan Mode 中，就切换为 Prometheus。需求可以写在同一行，也可以放到下一条消息里。规划期间再运行一次 `/prometheus`，会退出 Prometheus 和 Plan Mode。

在 OMP 普通的 `/plan` 模式下，小而明确的需求照常处理。目标较大、牵涉面广或不够清楚时，规划者会问你要不要切换到 Prometheus。

计划会经过 OMP 正常的批准流程。如果开启了 OMP 的计划自动保存，批准后的副本还会保存到 `.omp/plans/` 下。[`reviewLevel`](#设置) 设置决定在你看到计划之前，是只由 Momus 评审，还是 Momus 和 Oracle 一起评审。

Prometheus 会让计划只包含真正需要的东西。期望结果的每一部分都写明谁依赖它、需求从哪里来（你的请求、你确认过的决定，或者仓库已有的承诺）。每个任务都列出它新增了什么，计划中的 `## Must not build` 一节列出有意不做的东西。提交给你的计划会同时展示这两者，以及 Prometheus 决定不采纳的评审建议。遇到困难的设计或算法问题时，如果 `architect` 或 `ultrabrain` 可用，Prometheus 也可能咨询它们。

### 计划长什么样

每份计划都以任务列表和最终评审结尾：

```markdown
## Tasks
- [ ] T1. Add the parser
  - Agent: task
  - Depends on: none
  - Tier: LIGHT
  - Acceptance: the new unit test passes and the CLI prints the parsed value
- [ ] T2. Update the command help text for the new flag
  - Agent: sonic
  - Depends on: T1
  - Tier: LIGHT
  - Acceptance: CLI help lists the new flag

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
```

每个任务写明由哪个代理来做、依赖哪些任务、怎样算完成。`Tier: HEAVY` 标记有风险的工作（安全、迁移、公开 API、可能丢数据等），这类任务还需要另一个独立的子代理检查通过才算数。Prometheus 会从你会话中可用的代理里挑最贴切的，优先使用 omo-toolkit 的代理。如果到执行时这个代理已经不在了，Atlas 会使用替代代理，你不需要重新批准。完整的计划格式见[参考文档](REFERENCE.zh.md#计划语法)。

### Atlas 如何执行计划

批准之后，主会话变成 Atlas。Atlas 自己不改文件也不运行命令，而是把每个任务交给子代理，并在执行记录里跟踪进度。只有子代理的最终结果证明任务完成了，任务才算完成；在计划文件里打勾不起任何作用。任务按依赖顺序执行。

子代理在工作中可能会发现问题：

- 在这次改动影响范围内的问题，会成为一个新任务（`D1`、`D2`……），在最终评审之前执行。
- 范围外的问题会成为一条发现（`O1`、`O2`……），Atlas 会把它归为 roadmap TODO、重复、不修复或仅报告。还有发现没有归类时，Atlas 不能结束，最终报告会列出所有发现。

Atlas 会一直工作到计划完成。如果计划或执行记录文件丢失、损坏，或者不再与批准的计划一致，Atlas 会暂停，直到你恢复它们，或者你用 `/atlas exit` 退出并批准一份修改后的计划。

一个任务在连续两次相同的失败、第三次失败或四小时的工作之后就不再重试。没有其他工作可做时，你可以再给它一次机会，之前的记录不会丢。失败如果来自测试环境而不是产品本身，会额外得到一次修复机会。具体规则见[参考文档](REFERENCE.zh.md#重试窗口与交付修复)。

任务需要你介入时，Atlas 会把它标为阻塞，继续做所有不依赖它的工作。不会改变工作内容的问题，会写在它的回复里；没有其他工作可做时，它会用对话框问你并等待。正在运行的子代理如果只是需要你在会话之外做一件事，比如启动 Docker 或登录，Atlas 会让它继续运行，手上的工作不会丢；问过你之后，再通知它接着做。最终报告会列出它做过的每一个假设。如果你自己解决了阻塞，告诉 Atlas 是哪个提交或哪些文件，会有一个新的子代理重新检查这个任务。Atlas 从不回滚未经验证的工作，而是保留并列出它们。

如果你的回答改变了某个任务的验收方式，比如接受一个较小的结果，Atlas 会把它记为一条业主裁定（`R1`、`R2`……）。默认情况下，它会先请你确认这条裁定。随后这个任务会按裁定重新完成，评审者能看到裁定，最终报告也会把它列为相对已批准计划的偏差。如果改动涉及有哪些任务或范围，请运行 `/atlas exit`，再用 `/prometheus` 重新规划。

Atlas 会把计划同步到你的待办列表里，并把会话标题设为 “Atlas …”，除非你自己起过名字。

子代理自己提交自己的工作。如果你使用 OMP 的任务隔离且设置了 `merge: patch`，Atlas 运行期间会把它改为 `branch`，以保留每个子代理的提交，结束后再还原你的设置。不在 Git 仓库中时，什么都不使用 Git；如果你需要提交，请在规划前自己运行 `git init`。

### 最终评审

所有任务完成后，Atlas 并行运行四项评审，每项都由一个全新的子代理负责，只报告，从不修复：

| 评审 | 代理 | 检查内容 |
| --- | --- | --- |
| F1. Plan compliance review | `momus`（回退 `reviewer`） | 改动是否与已批准的计划一致 |
| F2. Code quality review | `deep-high`（回退 `task`） | 正确性、范围、分寸、可维护性、测试价值和回归风险。出现严重或高级别的问题就不通过，包括超出计划声明而构建的机制 |
| F3. Real-surface QA | `deep-low`（回退 `task`） | 每个验证场景都真实运行一遍，每项通过都有对应的产物 |
| F4. Success-criteria fidelity | `deep-high`（回退 `task`） | 结果是否满足每条成功标准；除非证明某条标准未达成，否则通过 |

只有 `PASS` 才算数。某项评审驳回时，每项修正都会成为一个新任务（`X1`……），之后只重跑这一项评审；已经通过的评审保留结果。

### 交付成果

`delivery` 设置决定完成的工作如何离开仓库：

- `direct` 让提交留在你当前的工作分支上。
- `pr` 在评审之后，由子代理推送分支并开一个拉取请求。
- `ship` 还会跟踪这个拉取请求通过 CI 和评审，然后合并。范围内的失败会成为修复任务，受影响的测试和 QA 会重新运行。
- `ask`（默认）表示仓库有远程仓库时，Prometheus 会问你。

没有远程仓库时，`pr` 和 `ship` 会变成 `direct`。你也可以直接在对话中说明要用哪一种。合并遵循仓库自己要求的检查和评审规则；Atlas 从不批准自己的工作。缺少权限、需要人工批准或分支不明确时，交付会停下来问你。

### `/atlas` 命令

```text
/atlas                          # 未运行：打开 Atlas Dispatch；运行中：打开计划视图
/atlas <plan-name-or-id>        # 在当前会话中开始一个计划
/atlas start <plan-name-or-id>  # 同上
/atlas list                     # 列出已批准的计划及其状态
/atlas show <plan-name-or-id>   # 显示计划的任务、验收标准和证据
/atlas resume <plan-name-or-id> # 切换到曾经执行过该计划的会话
/atlas rename <id> <new name>   # 修改计划的显示名称
/atlas delete <id> [--yes]      # 删除计划及其证据
/atlas exit                     # 退出 Atlas（计划未完成时会先询问）
```

除了不带参数的 `/atlas` 和 `exit`，其他子命令只能在 Atlas 未运行时使用；要切换计划，请先退出。可以用名称或 ID 指定计划。

Atlas Dispatch 列出当前工作区中未完成的计划。按 Tab 显示所有计划，包括已完成的和其他工作区的，但只能查看。

| 按键 | 操作 |
| --- | --- |
| 直接输入 | 搜索名称、ID 或状态 |
| Enter | 开始高亮的计划 |
| 空格、Shift+I | 打开完整的计划视图 |
| Shift+R | 在曾经执行过该计划的会话中恢复 |
| Backspace、Delete | 修改搜索内容；搜索为空时 Backspace 删除计划（Delete 总是删除） |
| Shift+N | 重命名计划 |
| Esc | 关闭 |

在已经有消息的会话中开始计划时，会问你用新会话还是当前会话。

Atlas 运行时，不带参数的 `/atlas` 会打开一个实时视图，显示每个任务的状态、正在运行的子代理及其模型、当前工具和用量，以及时间线（Tab）。Shift+X 退出 Atlas，Esc 关闭视图。把 `atlasWidget` 设为 `false` 可以隐藏编辑器上方的进度小组件。在 [Tern](https://docs.stencil.so/tern/) 中，这些界面以原生面板打开，按钮提供同样的操作。

### 在另一个会话中继续

计划和证据保存在你的 OMP 会话目录中，而不是某个会话里。同一工作区的另一个会话可以用 `/atlas <name>` 接着执行计划。Shift+R 或 `/atlas resume` 会回到曾经执行过该计划的会话。

一个计划同一时间只在一个会话中运行。退出会释放计划，但不会取消正在运行的子代理，也不会把工作标为完成；有子代理在运行的会话会一直持有计划，直到那个子代理报告结果。更新插件后，已有的计划无需重新批准即可继续执行。

### 选择模型

Metis、Oracle 和 Momus 使用 OMP 的 `@slow` 角色。Atlas 在主会话中运行，插件还添加了一个 `atlas` 模型角色，你可以在 `/model` 中为它指定模型：

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

计划等待批准时，批准滑块上也会出现 `atlas`；把它从 `default` 移开，就会用这个角色执行计划。`/atlas <plan>` 会在这个角色已分配时使用它。这个角色不在 Ctrl+P 的模型切换循环里。

## 设置

为当前用户修改设置：

```bash
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
omp plugin config set wows-omp-plugin-omo-prometheus delivery pr
omp plugin config list wows-omp-plugin-omo-prometheus
```

只想在某个项目里改，就在该项目的 `.omp/plugin-overrides.json` 中写上：

```json
{ "settings": { "wows-omp-plugin-omo-prometheus": { "delivery": "direct" } } }
```

设置在会话启动时读取，修改后请重启会话。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `reviewLevel` | `ask` | 在你看到计划之前怎样评审（见下文）。 |
| `reviewRoundLimit` | `5` | 每份计划最多评审几轮。`0` 或留空表示不限。到达上限时，你可以选择再给几轮，或者让 Prometheus 按现状提出计划，并列出尚未解决的问题。 |
| `delivery` | `ask` | 完成的工作如何离开仓库：`ask`、`direct`、`pr` 或 `ship`（见[交付成果](#交付成果)）。 |
| `atlasWidget` | `true` | Atlas 运行时在编辑器上方显示进度小组件。 |
| `progressReports` | `false` | 让 Atlas 在每批任务开始前和每个任务结束后，在聊天中发一条简短进展：进度、结果、怎样检查的、有什么问题、下一步做什么。 |
| `herdrDag` | `true` | 在 `omp-herdr-dag` 窗格中显示 Atlas 的进度。 |
| `atlasRetry` | `ask` | 由谁给停下的任务再一次机会（见[你不在时的决定](#你不在时的决定)）。 |
| `atlasAmend` | `ask` | 由谁确认改变任务验收方式的业主裁定。 |
| `atlasRelease` | `ask` | 由谁确认计划已经完成。 |
| `atlasAskTimeout` | `30` | 对话框保持打开多少分钟后，由 `ask-then-*` 的值来决定。 |
| `atlasAutoRetryLimit` | `1` | 每个任务最多允许设置在你不参与时额外给几次机会。`0` 表示不限。 |

`reviewLevel` 的取值：

- `ask`：每份计划都由 Momus 评审。你要求高准确度，或者工作复杂且不明确时，Momus 和 Oracle 一起评审；工作清楚时，会让你选一次。
- `standard`：每份计划都由 Momus 评审。你明确要求时仍会加上 Oracle。
- `high-accuracy`：总是由 Momus 和 Oracle 一起评审。
- `off`：即使你要求，也不做 Momus 或 Oracle 评审。Metis 照常运行，Atlas 仍会做 F1 评审。

### 你不在时的决定

执行期间，Atlas 有三类决定需要你来做：给停下的任务再一次机会（`atlasRetry`）、确认业主裁定（`atlasAmend`）、确认计划已完成（`atlasRelease`）。每个设置都可以取以下值：

| 值 | 会发生什么 |
| --- | --- |
| `ask` | 对话框一直等你回答。没有 UI 时，视为拒绝。 |
| `ask-then-approve` | 对话框等待 `atlasAskTimeout` 分钟，然后批准。在终端中按任意键会重新计时；在时限内按 Esc 或选择拒绝，算作你的拒绝。没有 UI 时立即批准。 |
| `ask-then-decline` | 同上，但时间到了就拒绝；没有 UI 时立即拒绝。 |
| `approve` | 不弹对话框，直接批准。 |
| `decline` | 不弹对话框，直接拒绝。 |

超过 `atlasAutoRetryLimit` 后，设置不能再为这个任务批准额外的机会，但你仍然可以在对话框中批准。每个决定都会注明是你做的还是设置做的；由设置批准的裁定会在评审和最终报告中特别标出。拒绝完成确认后，Atlas 会保持运行，直到你执行 `/atlas exit`。

`atlasAmend: approve` 会让 Atlas 不经你同意就放宽任务的验收条件，只有在你接受这个风险时才这样设置。下面是一个基本无人值守、但遇到需要你的问题仍会停下的配置示例：

```bash
omp plugin config set wows-omp-plugin-omo-prometheus atlasRetry ask-then-approve
omp plugin config set wows-omp-plugin-omo-prometheus atlasAmend ask-then-decline
omp plugin config set wows-omp-plugin-omo-prometheus atlasRelease approve
```

## 与其他插件配合

- **omo-toolkit**：计划优先使用它的专长代理，F2、F3 和 F4 评审运行在它的 `deep-high` 和 `deep-low` 上。
- **judge-dispatch**：计划执行期间不改派任何任务，也从不改派 `metis`、`momus` 或 `oracle`。
- **omp-herdr-dag**：把计划的任务、新发现的任务、修复、评审和交付显示成一张实时图。
- **roadmap**：会话处于某个 roadmap 阶段时做出的计划属于这个阶段，并用一行 `Roadmap criteria: DC1, DC3` 声明它覆盖阶段的哪些完成标准。Prometheus 会在你批准前对照阶段检查这一行；没有覆盖的标准留给其他计划。Atlas 可以使用 roadmap 工具，把发现记成 roadmap TODO，并在第一个任务之前启动该阶段。批准后阶段如有变动，你会收到提示，计划照常执行。计划完成时，会话会被提醒考虑关闭这个阶段；阶段不会自动关闭。
- **adr**：Atlas 可以使用 ADR 工具，并由它自己接受、拒绝或取代 ADR；子代理从不这样做。
- [Magic Context](https://github.com/cortexkit/magic-context)：它的 `ctx_*` 工具在 Atlas 中仍然可用。

## 已知限制

- Atlas 需要保存在本地磁盘上的会话，并且文件系统要支持硬链接、原子重命名以及文件和目录同步。会话存储在内存中或只存在于远端时，Atlas 会拒绝运行；会话目录不同的会话也看不到彼此的计划。
- 用 Prometheus 规划需要 Plan Mode 的交互式批准，所以在无界面或 SDK 会话中无法运行。
- 在共享执行记录出现之前的版本中执行的计划无法恢复，需要重新批准。

## 更多细节

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍了计划格式、Atlas 可以使用哪些工具、任务如何派发和检查、计划文件与执行记录、重试规则、会话之间的所有权、在 RPC、ACP 编辑器和无界面模式下的表现、状态快照，以及与 `omp-herdr-dag`、`roadmap` 和 `adr` 的接口。

## 许可证

Prometheus、Metis、Oracle、Momus 和 Atlas 的提示词资源是 OmO 的修改衍生作品。`NOTICE` 记录了上游仓库、固定的修订版本、早期 fork 历史和修改声明。`/prometheus` 和 `/atlas` 命令沿用 OmO 的 [Ultrawork Planner](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#planning-the-ultrawork-planner) 和 [`/ulw-execute`](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#execution-ulw-execute)。

扩展代码和原创打包部分采用 MIT 许可证（`LICENSE-MIT`）。`agents/`、`assets/` 和 `skills/prometheus/` 下的衍生提示词资源仍适用上游的 Sustainable Use License 1.0（`LICENSE-SUL-1.0`），允许内部商业、个人和非商业使用，且仅允许出于非商业目的免费分发。
