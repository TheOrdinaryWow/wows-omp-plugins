<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/audit-goal-dark.png">
  <img alt="audit-goal" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/audit-goal-light.png">
</picture>

# audit-goal

[English](README.md) | 简体中文

> 在 OMP 里做 CodeRabbit 式的代码审查：发现问题就修，一轮接一轮，直到再也查不出问题。

用 `/audit` 指定一个想检查的对象，比如一个分支、一份计划或一项功能，代理就会分轮审查它。每一轮里，审查者只看不改，负责找问题；主代理逐条对照源码核实，剔除不成立的；修复者再把确认的问题修好。每轮结束后代理会运行项目的检查，并把发现和修复写进审计记录。审计收敛、轮数上限用完，或者你主动停止时，审计才会结束。

## 安装

```bash
omp plugin install audit-goal@wows-omp-plugins
```

需要 OMP 18.17.0 或更高版本，并开启目标模式（`goal.enabled`，默认开启）。安装后重启会话。

## 快速上手

```text
/audit the checkout service refactor on this branch
/audit plan local://PLAN.md
```

用自己的话描述审计对象即可。页脚会显示进度，例如 `Audit 2/5 · standard`，意思是第 2 轮、最多 5 轮、标准强度。之后审计会自己跑下去。

## 用法

### 查看、暂停或停止审计

审计以 OMP 目标（goal）的形式运行，所以用常规的目标命令控制它：

- `/goal` 查看审计状态。
- `/goal pause` 暂停审计。在你用 `/goal resume` 恢复之前，代理不能继续跑审计轮次。
- `/goal drop` 彻底停止审计。

`/goal budget` 限制的是 token，不是轮数。要限制轮数，请用 `maxRounds` 设置。

### 每一轮做什么

1. 代理把代码分成几个区域（服务端、worker、数据库……），给每个区域派一个只读的审查者。
2. 对照源码核实每条问题，驳回站不住的。
3. 派修复者修好确认的问题。同时工作的修复者不会改同一个文件。
4. 运行项目的完整检查，确认没有遗留未提交的改动，然后记录这一轮。

问题分为 Critical、Major、Minor、Picky 四级。每轮的记录会写明哪些模型参与了审查、覆盖了哪些范围、跑了哪些检查、确认的问题及其证据、对早先问题的修复，以及驳回的理由。

有时修复本身会加入新代码，下一轮又得审查这些代码，审计就停不下来。代理会把这类由自己的修复引出的问题单独统计，并被要求简化或撤回它加的东西。

### 选择审计的严格程度

`intensity` 设置决定什么算问题、修哪些问题，以及审计什么时候可以停：

|  | `relaxed` | `standard`（默认） | `strict` |
| --- | --- | --- | --- |
| 审查者报告 | 明显的问题：正常使用下的错误行为、失败的检查、明显偏离计划 | 在生产环境中确实可能发生的问题，并沿完整链路追查 | 另外还包括工具链、依赖和 OMP 边界上的问题，以及触发条件明确的罕见 bug |
| 会修复 | Critical、Major | Critical、Major、Minor | 全部 |
| 停止条件 | 一轮没有 Critical 或 Major | 连续两轮没有 Critical 或 Major | 连续两轮没有 Critical、Major 或 Minor |

### 审计怎样结束

目标完成之前，代理必须记录以下三种结论之一：

- `threshold-convergence`：满足了所选强度的停止条件。这表示审计没有再找到问题，并不说明代码没有 bug。早先的 Critical 或 Major 问题要等记录了修复才会关闭。
- `capability-saturation`：在不限轮数时，同一批模型已从不同角度做了至少三轮可比的审查，代理也说明了为什么再查一轮不太可能有新发现。未关闭的问题仍然保持打开，光凭新问题少不能下这个结论。
- `stop`：轮数上限先用完了。代理会问你是增加轮数、取消上限还是停止。选择停止时，会记录原因和仍未关闭的问题。直接关掉这个提问，选择会保持待定。

哪种结论都不代表被审计的工作已被接受，接不接受由你决定。

## 设置

为当前用户修改设置：

```bash
omp plugin config set wows-omp-plugin-audit-goal intensity strict
omp plugin config set wows-omp-plugin-audit-goal maxRounds 5
omp plugin config delete wows-omp-plugin-audit-goal maxRounds   # 恢复为不限
omp plugin config list wows-omp-plugin-audit-goal               # 查看当前值
```

只想在某个项目里改，就在该项目的 `.omp/plugin-overrides.json` 中写上：

```json
{ "settings": { "wows-omp-plugin-audit-goal": { "intensity": "strict" } } }
```

每次 `/audit` 使用启动时生效的设置，运行中的审计不受之后修改的影响。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `intensity` | `standard` | 审查的深度、修复哪些级别，以及审计何时可以停止：`relaxed`、`standard` 或 `strict`（见上表）。 |
| `maxRounds` | 未设置 | 一次 `/audit` 最多跑几轮。未设置表示不限。 |
| `maxParallelLanes` | 未设置 | 最多同时运行几个审查者或修复者。未设置表示插件不额外限制。OMP 自己的 `task.maxConcurrency` 仍然有效，所以设为 10 而 OMP 上限为 3 时，同时只会跑三个。 |

## 与其他插件配合

`judge-dispatch` 不会改动审计的审查者和修复者，也不会把其他任务派给它们。

## 已知限制

- 审查者和修复者代理 `audit-auditor`、`audit-fixer` 会出现在每个会话的代理列表里，因为 OMP 无法隐藏它们。它们只在 `/audit` 中运行，在其他地方插件会拒绝派发。
- 在 Plan Mode 或 vibe 模式下、另一个目标尚未完成时，或者已有审计在运行时，`/audit` 不会启动。
- 如果最新一轮的记录损坏，审计既不能继续也无法结束。运行 `/goal drop`，然后重新开始审计。
- 审计会遵循被审计项目自己的上下文文件（比如 `AGENTS.md`）里的提交约定和规则。

## 更多细节

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍插件如何驱动审计循环、审计在 RPC、ACP 编辑器、SDK 和 headless 模式下的表现，以及客户端程序可以读取的状态快照。

## 许可证

MIT。
