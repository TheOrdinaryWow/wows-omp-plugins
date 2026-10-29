<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-dark.png">
  <img alt="omo-prometheus" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-light.png">
</picture>

# omo-prometheus

[English](README.md) | 简体中文

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的 Prometheus 规划和 Atlas 执行，移植到了 OMP。Prometheus 会一直提问，直到能写出值得批准的计划。之后 Atlas 通过子代理执行每个任务，为每个任务保留证据，并在计划算完成之前运行四个独立关口。

本插件建立在 OMP 的 Plan Mode 和批准流程之上，另外增加了：

- Metis：规划开始前检查意图和遗漏；
- Prometheus：只问会改变计划的问题；
- 可选的 Momus 和 Oracle 评审：计划遗漏了什么、或者构建得超出需要，都可以让它被否决；
- Atlas：执行者。

## 安装

```bash
omp plugin install omo-prometheus@wows-omp-plugins
```

需要 OMP 18.12.0 或更高版本。规划还需要启用 Plan Mode（`plan.enabled`，默认开启）。安装后重启 OMP。

如果你用过旧的 `prometheus` 插件，请先运行 `omp plugin uninstall prometheus@wows-omp-plugins` 卸载。它的会话状态不会迁移过来，需要重新开始一份计划。

## 快速上手

```text
/prometheus add rate limiting to the public API
```

1. Prometheus 进入 Plan Mode，咨询 Metis，然后提问。回答到它给出计划为止。
2. 查看提案，在 OMP 的常规批准对话框中批准。两种批准选择都会交给 Atlas。
3. Atlas 自行开始执行。编辑器上方的小组件显示进度，`/atlas` 打开完整视图。
4. 所有任务、四个最终关口和交付任务（如果有）都通过后，计划即告完成。随时可以用 `/atlas exit` 离开 Atlas。

## 用法

### 规划

`/prometheus` 会进入 Plan Mode；如果会话已经处于 Plan Mode，则升级为 Prometheus。需求可以写在同一行，也可以放在下一条消息里。规划期间再次运行 `/prometheus`，会同时退出 Prometheus 和 Plan Mode。

在普通的 `/plan` 模式下，小而明确的需求仍走 OMP 的常规流程。遇到大型、跨模块或含糊的目标时，规划者会问你是否切换到 Prometheus。

计划写在 `local://` 会话产物中，并通过 OMP 的批准流程提交。如果开启了 OMP 的计划自动保存，批准后的副本还会保存到 `.omp/plans/` 下。[`reviewLevel`](#设置) 决定提案前由 Momus 单独评审，还是由 Momus 和 Oracle 一起评审。

计划只包含有人依赖的工作。每条理想状态行都写明谁依赖它，以及需求来自哪里：你的请求、你确认过的决定，或仓库里已经存在的契约。每个任务列出它新增的机制（`Mechanisms:`），计划的 `## Must not build` 一节列出有意不做的内容。批准前，提案会同时展示这两部分，以及 Prometheus 拒绝采纳的评审意见。评审者可以因为构建过多而否决计划；F2 关口会把超出计划声明范围的工作判为失败。

Prometheus 在遇到开放的边界或拆分问题时调用 `architect`，遇到困难且相对独立的算法或契约问题时调用 `ultrabrain`。只有当前代理列表里确有这个名字时才会调用。简单需求和普通的 Standard 计划都不调用，不可用的顾问会被跳过。顾问只读，不替代 Metis、Oracle，也不替代你的决定。

本插件保留 `/prometheus` 和 `/atlas` 命令，它们来自 OmO 的 [Ultrawork Planner](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#planning-the-ultrawork-planner)（`/ulw-plan`）和 [`/ulw-execute`](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#execution-ulw-execute)，并跟随这些内核更新。`NOTICE` 记录了固定的修订版本。

### 计划格式

每份计划都以两个机器可读的章节结尾。任务是从 `T1` 开始编号的复选框行，每行包含 `Agent:`、`Depends on:`、`Tier:` 和 `Acceptance:`。`Tier:` 取值为 `LIGHT` 或 `HEAVY`，缺省时视为 LIGHT。完整语法见[参考文档](REFERENCE.zh.md#计划语法)。

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

Prometheus 会为每个任务选择 `task` 工具提供的、最专门的代理，优先使用 `omo-toolkit` 的代理。执行时如果该代理不存在，Atlas 会先试它的回退代理，再从当前列表中挑最合适的。整个过程不需要你重新批准。

绑定了[路线图](#与其他插件配合)阶段的计划，还需要一行计划级声明，例如 `Roadmap criteria: DC1, DC3`，列出本计划交付的阶段完成标准。路线图插件报告了该阶段的完成标准后，如果这一行缺失、重复、为空，或列出了不是当前标准的编号，Prometheus 会在批准前拒绝这份提案。计划没有列出的标准留给其他计划。

### 执行

批准后，主会话变成 Atlas，而 Atlas 自己不改文件。插件会屏蔽父会话中的实现类工具（`bash`、`eval`、`edit`、写文件等），所以每个任务都通过 `task` 交给子代理。

进度记录在执行记录（ledger）中。只有子代理的最终结果证明任务完成，任务才算完成；在计划文件里勾选复选框没有任何作用。任务按依赖顺序执行，依赖有环的计划在运行前就会被拒绝。HEAVY 任务（安全、迁移、公共 API、数据丢失风险等）还需要另一个全新的子代理独立验证。约定见[参考文档](REFERENCE.zh.md#执行记录)。

子代理发现的缺陷按位置分流：

- 位于改动影响范围内的缺陷，会成为发现任务（`D1`、`D2`……），并在最终关口之前执行。
- 位于范围之外的缺陷，会成为延后发现（`O1`、`O2`……）。Atlas 将它分诊为路线图 TODO、重复项、不予处理，或仅列入报告。仓库里没有可用路线图时，只能选仅报告。
- 最终报告列出每条发现及其处置。只要还有未分诊的发现，Atlas 就无法被释放。

Atlas 会一直工作到计划完成。如果执行记录或计划文件缺失、损坏，或与批准的计划不一致，它会暂停。等你恢复这些文件，或用 `/atlas exit` 退出并批准修改后的计划，它才会继续。

已记录的失败在重启和会话交接后仍然有效，Atlas 尚未记录的失败则不会保留。某一行会在以下任一情况下停止：连续两次计数失败的签名相同；第三次计数失败；或计时的产品工作累计满四小时。每次关口重跑和每次验证派发都重新计时；等待修复、等待 P1 的 CI 或评审都不计时；验证超时也会保留已认证的实现证据。产品失败和原因不明的失败都计数。若有证据证明产品行为从未运行，即环境故障，可以有一次不计数的修复，第二次环境故障则停止该行。独立工作耗尽后，你可以授予新的额度窗口，不会丢失历史，也不会改变验收标准。细节见[参考文档](REFERENCE.zh.md#重试窗口与交付修复)。

阻塞的工作保持未完成。Atlas 会保留并列出能追溯到某个子代理的未验证提交或文件，从不自动回滚。存在缺口时，交付不能继续。

任务需要你介入时，Atlas 会把它标为阻塞，并继续推进所有不依赖它的工作。不影响结果的问题写在回复里。等其他工作都推进不下去了，它会打开对话框等你回答。它从不把真正的阻塞当作可选项，最终报告会列出它做过的每个假设。

如果你自己解决了阻塞，请告诉 Atlas 是哪个提交或哪些文件解决的。Atlas 会重新打开该任务，并派一个新的子代理核实。

如果你的回答改变了某个任务验收的达成方式，例如放宽一个实测无法达到的上限，或接受更窄的结果，Atlas 会记录一条业主裁定（`R1`、`R2`……）。默认情况下，它会在对话框中请你确认；设置了 `atlasAmend` 时，由该设置决定（见[无人值守的决定](#无人值守的决定)）。随后该任务按裁定重做。评审者能看到每条裁定，最终报告会把每条列为偏离已批准计划的地方。如果改动影响的是任务或范围，请运行 `/atlas exit`，再用 `/prometheus` 规划这项改动。

Atlas 会把计划同步到你的待办列表，并把会话标题设为以“Atlas …”开头，除非你自己起过名字。待办列表如何保持同步，见[参考文档](REFERENCE.zh.md#会话集成)。

Atlas 遵循宿主的 `task.isolation` 设置，只有一处例外：`merge: patch` 时，它运行期间会切换为 `branch`，让每个子代理的提交得以保留，退出时恢复你的设置。子代理自己提交工作。Atlas 只提交路线图和 ADR 文档，以及已完成的子代理漏提交的工作，并通过受保护的 `atlas_git` 工具完成。

不在 Git 仓库中时，就不会使用 Git。计划写 `Commit: none`，交付方式为 `direct`，不要求隔离，F1 在没有 Git 历史的情况下检查计划。如果需要提交记录，请在规划前自己运行 `git init`。

### 最终关口

所有任务完成后，Atlas 并行运行四个关口。每个关口都在一个全新的子代理上运行，只报告，从不修复。

| 关口 | 代理 | 检查内容 |
| --- | --- | --- |
| F1. Plan compliance review | `momus`（回退 `reviewer`） | 改动是否符合批准的计划，依据是计划、执行记录，以及计划基线之后的 Git 历史 |
| F2. Code quality review | `deep-high`（回退 `task`） | 正确性、范围、比例、可维护性、测试价值和回归风险。任何 CRITICAL 或 HIGH 级别的发现都会导致失败，包括超出计划声明范围的机制 |
| F3. Real-surface QA | `deep-low`（回退 `task`） | 实际运行每个验证场景，每个通过都有产物作为依据 |
| F4. Success-criteria fidelity | `deep-high`（回退 `task`） | 对照每条成功标准和理想状态行检查结果。除非某条标准被证明未达成，否则通过 |

每个关口返回 `PASS`、`FAIL` 或 `INCONCLUSIVE`，只有 `PASS` 算数。非 PASS 的结果会消耗该关口的重试窗口。每个修正成为一个 X 行，只有判定不通过的关口会由新的子代理重跑。已通过的关口保留各自的证明。窗口耗尽的关口会阻塞，直到有人授予新的窗口：可以是你在对话框中授予，也可以由 `atlasRetry` 设置授予（默认：询问你）。

### 交付

`delivery` 决定完成的工作如何离开仓库。`direct` 让提交留在当前工作分支上。`pr` 在关口之后，由子代理推送分支并创建拉取请求。`ship` 还会等待 CI 并合并。默认值 `ask` 表示：仓库有远程仓库时 Prometheus 会询问。固定值会直接使用，不再询问；没有远程仓库时，`pr` 或 `ship` 会变成 `direct`。你也可以在对话中覆盖这个设置。执行以计划里的 `Delivery:` 行为准，推送和合并始终由子代理完成。

`pr` 停在已打开的拉取请求上。`ship` 会让同一个 PR 持续跟进 CI 和评审。范围内的失败会成为 X 修复行，来源为 P1，受影响的测试和 QA 会重跑。交付子代理从不在原地修改产品代码。

合并遵循仓库要求的检查、评审和合并策略，不能留有未解决的阻塞性变更请求。Atlas 不会自批，也不会虚构评审人数下限。缺少访问权限、需要人工批准、PR 分支不明确或策略不兼容，都会阻塞交付。范围或验收标准的变化仍需你决定。PR 的 head 和 base 必须明确指定。Atlas 核查子代理报告的远程 CI、评审和合并证据，不轮询 GitHub。原生隔离仍由宿主负责。

### `/atlas` 命令

```text
/atlas                          # inactive: open Atlas Dispatch; active: open the running plan's view
/atlas <plan-name-or-id>        # enter a plan in this session and start executing
/atlas start <plan-name-or-id>  # same as above
/atlas list                     # list approved plans with their status
/atlas show <plan-name-or-id>   # show a plan's rows, acceptance and evidence
/atlas resume <plan-name-or-id> # switch to a session that already ran the plan
/atlas rename <id> <new name>   # change a plan's display label
/atlas delete <id> [--yes]      # delete a plan and its evidence
/atlas exit                     # leave Atlas (asks first if the plan is unfinished)
```

除了裸 `/atlas` 和 `exit`，其他子命令都只能在 Atlas 未激活时使用。要换计划，先退出。计划可以按名称或 ID 匹配（见[计划匹配](REFERENCE.zh.md#计划匹配)）。

Atlas Dispatch 列出当前工作区中未完成的计划。按 Tab 可以显示全部计划，包括已完成、无效和其他工作区的计划，这些只能查看。

| 按键 | 操作 |
| --- | --- |
| 直接输入 | 模糊搜索名称、ID 或状态 |
| Enter | 立即开始执行选中的计划 |
| Space、Shift+I | 打开全屏计划视图 |
| Shift+R | 在已执行过该计划的会话中恢复 |
| Backspace、Delete | 编辑搜索内容；搜索框为空时按 Backspace 删除计划，任何时候按 Delete 都删除计划 |
| Shift+N | 修改显示名称 |
| Esc | 关闭 |

在非空会话中开始计划时，插件会问你用新会话还是当前会话。之后第一条执行消息由 Atlas 自己发出。

Atlas 激活时，裸 `/atlas` 会打开一个实时只读视图，显示每一行的状态、正在运行的子代理及其模型、当前工具和用量，按 Tab 可切换到时间线。Shift+X 退出 Atlas，Esc 关闭视图。如果不想在编辑器上方显示小组件，可以把 `atlasWidget` 设为 `false`。

在 Tern 中，Atlas Dispatch 和计划视图会以原生面板浮在对话上方，进度小组件显示为原生进度条。单击选中，双击打开，标签页、按钮和键盘快捷键都能用。Atlas 和 Prometheus 的工具调用显示为原生卡片，模型的指引默认折叠，展开卡片才能看到。

### 在另一个会话中继续

计划及其证据保存在你的 OMP 会话目录中，不属于任何单个会话。只要会话 A 和会话 B 共用同一个会话目录和工作区，会话 B 就能用 `/atlas <name>` 接着做会话 A 开始的计划。Shift+R 或 `/atlas resume` 会切回曾经执行过该计划的会话，进入 Atlas 模式，等待你的下一条消息。

同一时间，一份计划只能在一个会话中执行。退出会释放计划，但不会取消正在运行的子代理，也不会把工作标记为完成。仍有子代理在运行的会话会一直持有计划，直到该子代理报告。所有权的细节见[参考文档](REFERENCE.zh.md#所有权)。升级插件后，已有计划无需重新批准即可继续执行。

### 模型

Metis、Oracle 和 Momus 使用 OMP 的 `@slow` 角色。Atlas 在主会话中运行。插件注册了一个 `atlas` 模型角色，你可以在 `/model` 中为它指定模型：

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

提案等待批准时，批准滑块也会提供 `atlas`。把滑块从 `default` 移开，就会用这个角色执行。`/atlas <plan>` 在指定了该角色时会切换到它。这个角色不在 Ctrl+P 的轮换列表中。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-omo-prometheus`。

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | 提案前的计划评审。 |
| `reviewRoundLimit` | 不小于 0 的整数 | `5` | 每份计划最多的评审轮数；`0` 或留空（`""`）表示不设上限。 |
| `delivery` | `ask` \| `direct` \| `pr` \| `ship` | `ask` | 完成的工作如何离开仓库，见[交付](#交付)。 |
| `atlasWidget` | boolean | `true` | Atlas 执行时，在编辑器上方显示进度小组件。 |
| `progressReports` | boolean | `false` | Atlas 在每批派发前和每个任务结束后，在对话中发一段简短汇报：进度、结果、核实方式、遇到的问题和下一步。子代理的任务说明不好读时有用。 |
| `herdrDag` | boolean | `true` | 向 `omp-herdr-dag` 查看器发布 Atlas 进度。 |
| `atlasRetry` | `ask` \| `ask-then-approve` \| `ask-then-decline` \| `approve` \| `decline` | `ask` | 由谁授予行的下一个重试窗口：你，还是该设置。见[无人值守的决定](#无人值守的决定)。 |
| `atlasAmend` | 同 `atlasRetry` | `ask` | 同样的选择，适用于会改变行验收的业主裁定。 |
| `atlasRelease` | 同 `atlasRetry` | `ask` | 同样的选择，适用于完成时的释放（`atlas_release`）。 |
| `atlasAskTimeout` | 不小于 1 的整数，单位为分钟 | `30` | `ask-then-*` 的对话框保持打开多久，之后由该设置决定。 |
| `atlasAutoRetryLimit` | 不小于 0 的整数 | `1` | 每行可由设置在你不参与时授予的重试窗口数；`0` 表示不设上限。 |

评审级别：

- `ask`：每份计划都由 Momus 评审。你要求高精度，或工作不简单且不清晰时，Momus 和 Oracle 一起评审。工作清晰时，你会得到一次性的选择。
- `standard`：每份计划都由 Momus 评审。你明确要求时，仍会加上 Oracle。
- `high-accuracy`：始终由 Momus 和 Oracle 一起评审。
- `off`：不做 Momus 或 Oracle 评审，即使你要求也不做。Metis 仍会运行，Atlas 也仍会运行 F1 关口。

插件自己统计评审轮数。每派一次 Momus，或一起派一次 Momus 和 Oracle，算作一轮，包括那次没能读到计划的轮次。达到 `reviewRoundLimit` 时，你可以为这份计划增加轮数，或者就此停止。选择停止后，Prometheus 会按计划现在的样子提交提案，并列出仍未解决的阻塞项。没有可交互的用户时，评审会在达到上限时停止。

用户设置会与项目覆盖设置合并。设置在会话启动时读取，修改后请重启会话。

### 无人值守的决定

Atlas 执行期间会自己提出三类决定：重试授权（`atlas_ledger retry`）、业主裁定（`atlas_ledger amend`）和完成释放（`atlas_release`）。每类都有各自的设置。默认值 `ask` 会一直等你在对话框中回答；没有对话框（无 UI）时，和以前一样直接拒绝。

- `ask-then-approve` 和 `ask-then-decline` 会显示对话框 `atlasAskTimeout` 分钟，超时后分别批准或拒绝。TUI 中任意按键都会重新开始计时。Esc 或在时限内拒绝，都算你的拒绝，不是超时。没有对话框时，立即执行回退规则。
- `approve` 和 `decline` 从不显示对话框。
- `atlasAutoRetryLimit` 限制设置能在你不参与时授予的每行重试窗口数（通过 `approve`、超时的 `ask-then-approve`，或无对话框时的回退）。超过上限后，`approve` 等同于 `decline`，`ask-then-approve` 等同于 `ask-then-decline`。你仍可在对话框中授予。`0` 表示不设上限。

每个工具结果都会说明是你还是设置做出的决定。由设置批准的业主裁定会标注为“由设置批准，非用户确认”，评审者能看到这一标注，最终报告会把它列为你没有确认过的偏离。释放被拒绝后，Atlas 保持激活，直到 `/atlas exit`。设置在会话启动时读取，修改后请重启会话。

`atlasAmend: approve` 会让 Atlas 在你不参与的情况下放宽某行的验收标准，请只在接受这一风险时使用。下面是一个无人值守、但遇到需要你处理的问题仍会停下来的配置示例：

```bash
omp plugin config set wows-omp-plugin-omo-prometheus atlasRetry ask-then-approve
omp plugin config set wows-omp-plugin-omo-prometheus atlasAmend ask-then-decline
omp plugin config set wows-omp-plugin-omo-prometheus atlasRelease approve
```

`atlasRelease approve` 下，账本检查通过后会直接释放，不再等你确认。

## 与其他插件配合

- `omo-toolkit`：计划优先使用它的分类代理；F2、F3、F4 三个关口运行在 `deep-high` 和 `deep-low` 上。
- `judge-dispatch`：计划执行期间不改派任何调用，也从不改派 `metis`、`momus` 或 `oracle`。
- `omp-herdr-dag`：以实时依赖图的形式显示 Atlas 的任务、发现任务、修复、关口和交付。
- `roadmap`：计划会记住它提出时所属的阶段，以及它声明的完成标准。一个阶段可以由多份计划共同交付；路线图插件可以询问某个阶段有哪些计划、进展到哪一步。Atlas 可以使用路线图工具。路线图在仓库中可用时（即 Git 工作树中已初始化路线图，并装有 `adr` 插件），Atlas 会为每条延后发现创建路线图 TODO。如果阶段的目标、范围、完成标准或设计约束在批准后发生变化，`/atlas <计划>` 和计划完成时都会显示提示，执行照常继续。计划完成后，会话会收到提醒，请你评估是否关闭该阶段。只有每条当前完成标准都有某份计划的通过证据时，阶段才能关闭，不会自动关闭。规划期间开始阶段只会绑定它，因为 Plan Mode 无法提交。Atlas 会在第一个任务之前开始该阶段并提交这次开始，在该提交存在之前拒绝派发任何任务。
- `adr`：Atlas 可以使用 ADR 工具，与是否启用 `roadmap` 无关。ADR 的接受、拒绝和取代由 Atlas 通过 `adr_manage` 完成，子代理从不做这些操作。阶段中还有待定的 ADR 时，该阶段无法关闭，需要先处理这些 ADR。
- [Magic Context](https://github.com/cortexkit/magic-context)：它的 `ctx_*` 工具在 Atlas 中保持可用。

## 不使用终端界面时

| 宿主 | `/atlas` 的行为 |
| --- | --- |
| RPC（`--mode rpc`、rpc-ui） | Atlas Dispatch 变成一串选择对话框（先选计划，再选 Start、Resume、View details、Rename、Delete 或 Back）。小组件以文本行的形式发送。 |
| ACP 编辑器 | 通过表单征询显示同样的对话框。没有小组件。 |
| SDK、`--no-ui`、print | 没有对话框，请使用子命令。删除需要 `--yes`。`/atlas resume` 只能在唯一执行过该计划的会话中使用；否则它会列出应该打开的会话。 |

Prometheus 规划需要 Plan Mode 的交互式批准，因此只能在 TUI、RPC 和 ACP 中运行。

客户端程序可以从状态快照中读取规划和执行状态，见[参考文档](REFERENCE.zh.md#状态快照)。

## 已知限制

- Atlas 需要基于文件的会话，并且所在的本地文件系统要支持硬链接、原子重命名，以及文件和目录同步。会话存储在内存中或只存在于远端时，Atlas 会拒绝运行。会话目录不同的会话看不到彼此的计划。
- 在共享执行记录出现之前的版本中执行的计划无法恢复，需要重新批准。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍 Atlas 工具守卫、计划包与执行记录、计划匹配、所有权、状态快照，以及与 `omp-herdr-dag`、`roadmap` 和 `adr` 的事件契约。

## 许可证

Prometheus、Metis、Oracle、Momus 和 Atlas 的提示词资源是 OmO 的修改衍生作品。`NOTICE` 记录了上游仓库、固定的修订版本、早期 fork 历史和修改声明。

扩展代码和原创打包部分采用 MIT 许可证（`LICENSE-MIT`）。`agents/`、`assets/` 和 `skills/prometheus/` 下的衍生提示词资源仍适用上游的 Sustainable Use License 1.0（`LICENSE-SUL-1.0`），允许内部商业、个人和非商业使用，且仅允许出于非商业目的免费分发。
