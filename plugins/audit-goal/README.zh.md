# audit-goal

[English](README.md) | 简体中文

添加 `/audit <audit-target>` 命令，以 OMP 目标的形式反复进行独立审计和修复，直到记录结论或由你停止。循环使用两个专用代理，并将每轮结果保存到证据账本中。

## 安装

```bash
omp plugin install audit-goal@wows-omp-plugins
```

需要 OMP 18.3.5 或更高版本，并启用目标模式（`goal.enabled`，默认开启）。安装后请重启会话。

## 用法

```text
/audit plan local://PLAN.md
/audit the checkout service refactor on this branch
```

审计对象可以用自由文本描述：计划、任务，或任何你希望核验的内容。在 Plan Mode 或 vibe 模式下、另一个目标尚未完成时，或当前会话已有审计正在运行时，`/audit` 不会启动。

运行中的审计是一个普通的 OMP 目标，因此可以通过 `/goal` 查看、暂停、恢复或放弃，也可以随时用 `/goal drop` 停止。在 `audit_round` 记录有效结论之前，模型不能完成目标（调用 `goal({op:"complete"})`，包括通过嵌套设备调用）。底栏会显示轮数、轮数上限、审计强度，以及任何待确认的结论。

每一轮中，主代理会：

1. 将代码库划分为审计领域（例如服务端、worker、数据库），并派出只读的 `audit-auditor` 子代理分别审计；
2. 对照源码核验每个报告的问题，剔除不成立的问题；
3. 派出 `audit-fixer` 子代理修复其余问题，各并行工作组不会共用文件；
4. 运行项目的完整检查，确认工作树干净，并记录本轮结果。

无论使用哪种强度，问题都分为 Critical、Major、Minor 或 Picky。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-audit-goal`。

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `intensity` | `relaxed` \| `standard` \| `strict` | `standard` | 审计深度、需要修复的问题级别，以及审计何时可以收敛。 |
| `maxRounds` | 数字或留空 | 留空 | 每次 `/audit` 的轮数上限；留空表示不限轮数。 |
| `maxParallelLanes` | 数字或留空 | 留空 | 同时运行的审计或修复子代理数量；留空表示插件不设限制。 |

`maxParallelLanes` 受 OMP 的 `task.maxConcurrency` 限制：如果此项设为 10，而宿主上限为 3，就只会运行三个并行工作组。插件会拒绝任何导致超出上限的 `task` 调用。

### 审计强度

|  | `relaxed` | `standard` | `strict` |
| --- | --- | --- | --- |
| 审计代理报告的范围 | 明显问题：正常使用时行为错误、检查失败、明确偏离计划 | 覆盖完整端到端链路，报告在生产环境中有可信触发条件的问题 | 还涵盖工具链、依赖和宿主边界，以及具有明确触发条件的潜在缺陷，即使触发情形很罕见 |
| 修复范围 | Critical、Major | Critical、Major、Minor | 所有级别 |
| 收敛条件 | 一轮中没有 Critical 或 Major | 连续两轮没有 Critical 或 Major | 连续两轮没有 Critical、Major 或 Minor |

### 审计如何结束

每轮账本包含审计代理使用的模型、实际覆盖范围、执行的检查，以及经过核验的问题、源码证据和解决状态。账本也会列出对先前问题的修复和驳回报告的原因。严重程度计数只统计新发现的问题；仍未解决的问题单独列出。

审计有三种结束方式：

- 达到阈值后收敛。一旦满足当前强度的退出条件，代理就会记录 `threshold-convergence` 及其理由，汇报结果，并完成目标。这个条件只表示审计不再发现问题，并不能证明代码没有缺陷。先前的 Critical 或 Major 问题仍会保持未解决状态，直到有已记录的修复将其关闭。
- 能力饱和。在不限轮数时，同一组审计模型完成至少三轮可比较的审计、覆盖不同审计维度后，如果有引用的实际观察表明再审计一轮也不太可能发现更多问题，代理可以记录 `capability-saturation`。尚未解决的 Critical 和 Major 问题仍保持未解决状态。仅凭问题数量或循环因自身修复而延长的迹象，不能认定能力饱和。
- 停止。如果达到有限轮数上限时仍未收敛，代理会说明审计尚未完成，并询问是否增加轮数、取消上限或停止。选择停止时，会记录 `stop`、停止原因及剩余问题。取消该询问会使选择保持待定，并阻止模型完成目标。无界面会话会记录单独的非交互停止结果。

`/goal budget` 限制 token 数量，不限制轮数；本插件自行统计轮数。

修复可能引入新机制，后续轮次又需要审计这些机制，导致循环延长。`/audit` 会在启动时记录 git `HEAD`，并单独跟踪由循环引入的问题。出现这种情况时，代理应简化或撤回新增机制。这种现象本身不会结束审计。

任何结束结果都不代表被审计的工作已经通过验收。记录的结果始终带有 `artifactAccepted: false`；是否验收由你和项目自身的流程决定。

## 宿主模式

`/audit <target>` 通过参数接收审计目标，因此在 TUI、RPC（`--mode rpc`）、ACP 编辑器、SDK 和无界面运行中用法相同。

- TUI 和 RPC 会在状态栏显示轮次（`Audit 2/5 · standard`）；ACP 会忽略状态栏。
- 达到有限轮数上限时，TUI、RPC 和 ACP 客户端会通过选择对话框询问增加轮数、取消上限或停止。没有界面时，插件会记录上文所述的非交互停止结果。
- 没有界面时，`/audit` 的用法错误和拒绝原因（缺少目标、已有目标、处于计划模式、设置无效）会作为会话中的可见消息显示，不使用通知。

## 状态快照

插件每次保存账本时，都会按共享快照格式（见[市场 README](../../README.zh.md)）写出 `audit-goal.json`。从未运行过 `/audit` 的会话不会生成该文件。`state` 内容如下：

| 字段 | 含义 |
| --- | --- |
| `kind`、`version` | `"audit-goal/audit"`、`1` |
| `status` | `running`、`awaiting-limit-decision`（已达到有限轮数上限，等待用户选择）、`converged`、`saturated`、`stopped`，或 `invalid`（最新账本条目格式无效或无法保存；此时没有其他字段） |
| `ended` | 审计目标已完成、被放弃或被替换时为 `true` |
| `target`、`intensity`、`maxRounds`、`laneLimit`、`baseline` | 审计配置；不限时 `maxRounds` 和 `laneLimit` 为 `null`，不在 git 仓库中时 `baseline` 为 `null` |
| `rounds[]` | `index`、`counts`（`critical`、`major`、`minor`、`picky`）、`rejected`、`loopInduced` 和 `verdict`（`continue`、`threshold-ready`、`cap-reached`；按当前轮数上限计算） |
| `totals` | 各轮计数之和，另含 `rejected` 和 `loopInduced` |
| `openFindings` | 按严重程度统计的 `counts`，以及仍未解决问题的 `items[]`（`id`、`severity`、`summary`、`origin`） |
| `conclusion` | `null`，或包含 `kind`（`threshold-convergence`、`capability-saturation`、`stop`）、`reason` 和引用的 `evidence[]` |
| `stopReason` | 审计停止时为结论理由，否则为 `null` |
| `artifactAccepted` | 始终为 `false` |

切换分支后若会话中已没有审计账本，文件会被改写为 `state: null`。

## 专用代理

`audit-auditor`（只读）和 `audit-fixer` 会出现在每个会话的 `task` 代理列表中，因为 OMP 无法隐藏插件代理。插件会拒绝在运行中的 `/audit` 循环之外派出它们，也会拒绝由子代理派出它们，或通过 `eval` 的 `agent()` 派出它们。两者都使用阻塞调用，主代理会等待每批执行结束。本市场中的 `judge-dispatch` 不会将其他代理路由为它们，也不会将它们路由为其他代理。

## 行为说明

- 审计启动时，以及每次上下文压缩后，协议和轮次账本都会作为隐藏消息注入。
- 插件会为审计循环启用 `goal` 和 `audit_round` 工具，并在目标完成或被放弃时关闭由它启用的工具。
- 如果最新账本条目格式无效，模型就不能完成目标或派出专用代理，插件也不会回退到旧快照。请使用 `/goal drop`，然后启动新的审计。
- 提交约定和项目规则来自被审计项目自身的上下文文件。
