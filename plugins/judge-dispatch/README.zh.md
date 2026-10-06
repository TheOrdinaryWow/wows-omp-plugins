# judge-dispatch

[English](README.md) | 简体中文

插件让 OMP 的 `judge` 模型角色决定 `task` 调用启动哪种子代理，父代理的选择作为路由请求提交。开启 `judgeEffort` 后，评判模型还会选择思考强度。开启 `modelBudget` 后，它会从配置的模型链中选择子代理模型。OMP 仍会验证每次子代理启动。

## 安装

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

需要 OMP 18.3.5 或更高版本。安装后请重启会话，让扩展完成注册。它使用 OMP 内置的评判功能，没有自己的凭据，详见[启用 judge 角色](#启用-judge-角色)。

## 路由范围

插件会改写普通 `task` 调用中的 `agent` 字段，单项和批量调用都适用。通过 `eval.agent()` 或 `workpool()` 启动的子代理不会参与路由，因为 OMP 的 `before_subagent_spawn` 钩子只能更改子代理的模型，不能更改其代理类型。

候选代理来自当前 `task` 工具描述中的代理列表，OMP 已根据启动策略和禁用状态过滤该列表。如果列表缺失、无法读取或为空，插件不会进行评判。`task` 工具会重新验证插件写入的任何代理名称。

以下调用保持原样，包括思考强度：

- 请求 `audit-*`、`metis`、`momus` 或 `oracle` 的调用；普通请求也绝不会被路由到这些工作流角色；
- 请求的代理不在插件读取到的列表中，因为其访问权限未知；
- `omo-prometheus` 计划执行期间的所有 `task` 调用，因为已批准的计划决定了代理和思考强度的选择。工作流回到空闲或规划状态后，路由会恢复。

插件依据 OMP 的代理工具元数据判断权限，只读代理只能被另一只读代理替换。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-judge-dispatch`。

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch minimumConfidence 0.8
omp plugin config set wows-omp-plugin-judge-dispatch includeSharedContext false
omp plugin config set wows-omp-plugin-judge-dispatch judgeEffort true
omp plugin config set wows-omp-plugin-judge-dispatch modelBudget balanced
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `minimumConfidence` | 0 到 1 之间的数字 | `0.70` | 替换请求的代理类型所需的最低评判置信度。 |
| `includeSharedContext` | 布尔值 | `true` | 将任务调用的共享 `context` 一并发送给路由评判请求。 |
| `judgeEffort` | 布尔值 | `false` | 同时让评判模型设置每次 `task` 调用的思考强度，详见[思考强度](#思考强度)。 |
| `modelBudget` | `off` \| `minimum` \| `balanced` \| `max` | `off` | 根据任务难度、模型智能评分和价格选择每次启动使用的模型，详见[模型预算](#模型预算)。 |
| `indicator` | 布尔值 | `true` | 显示路由活动，详见[界面显示](#界面显示)。无论是否显示，路由行为都相同。 |

用户设置会与项目覆盖配置合并。插件在每次 `task` 调用时读取这些设置，因此更改后无需重启即可生效。

## 界面显示

评判过程中，工作提示显示为 `judge-dispatch: routing N tasks…`。评判完成、失败或超时后，会恢复默认提示。

每次参与路由的 `task` 调用随后都会立即显示一行暗色状态提示，与 Ctrl+O 显示的提示类型相同，例如：

```text
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · effort med → hi (0.92)
```

每一项都会显示评判置信度，无论代理被替换还是保留。如果没有可用的评判结果而保留原代理，则会显示原因：`judge unavailable`、`judge failed`、`timed out`、`no alternatives`、`no confident choice` 或 `workflow-owned or unknown agent`。如果调用因路由失败、超时或宿主未留出评判时间而完全未进行评判，仍会显示以 `kept the requested agent:` 开头的状态行。Prometheus 执行已批准计划期间的调用不会参与路由，也不会显示任何提示。

你可以看到状态行，但 OMP 不会将它发送给模型或保存在会话中，因此在 `/resume` 后不会再次出现。OMP 会将连续到达的状态行合并为一行，所以同一轮中的多次 `task` 调用可能只留下最后一行可见。OMP 已在子代理模型旁标注 `modelBudget` 引起的变化，状态行不会重复这些信息。

将 `indicator` 设为 `false` 可同时隐藏工作提示和状态行。

## 思考强度

开启 `judgeEffort` 后，评判模型会判断任务的开放程度，将其分类为 `routine`、`standard` 或 `demanding`。插件据此将 `task` 调用的 `effort` 设置为 `lo`、`med` 或 `hi`。OMP 会将其映射到子代理模型支持的最低、中间或最高思考级别，并受 `task.maxEffort` 上限约束。最终级别始终是该模型支持的级别。

难度判断的置信度达到 `minimumConfidence` 时，插件会替换父代理指定的思考强度。置信度较低时则保持原值。即使只有一种代理类型符合条件，评判模型也会判断难度。无论 `task.enableEffort` 是否向父代理显示该字段，OMP 都会应用思考强度。[路由范围](#路由范围)中的排除规则也适用于思考强度。

## 模型预算

开启 `modelBudget` 后，同一次难度评判还会选择子代理模型。候选项来自被启动代理的模型选择器：其 `task.agentModelOverrides` 配置项或 frontmatter 中的 `model` 列表；如果只有一个选择器，则使用该选择器加上其角色对应的 `retry.fallbackChains` 配置项。

OMP 的模型注册表会解析每个候选项。注册表包含来自 models.dev 的价格和 OMP 实时模型目录中的智能评分。它会将自定义提供商和代理提供商的 ID 匹配到已评分的目录条目，因此插件不维护自己的模型数据。插件会跳过没有凭据或评分的候选项。如果第一个选择器没有评分，子代理会保留原配置模型。

| 预算 | 选择规则 |
| --- | --- |
| `max` | 选择评分最高的候选模型，即使它不在模型链首位。 |
| `balanced` | 对于 routine / standard / demanding 任务，分别选择评分至少达到最佳候选模型 80% / 90% / 100% 的候选项中价格最低的模型。 |
| `minimum` | 选择评分至少达到最佳候选模型 70% / 80% / 95% 的候选项中价格最低的模型。 |

价格按输入与输出价格 3:1 的比例取加权平均值。候选资格以最佳候选模型为基准，因此仅作为最后回退项保留的弱模型不会为了省钱而被选中。选中的模型会移到本次启动的选择器列表首位，其余模型作为回退项保留。OMP 会在解析后的模型旁显示路由注释。

OMP 的 `before_subagent_spawn` 事件不携带任务内容，因此插件通过任务项的 `name` 将评判结果与子代理启动关联起来。如果父代理没有提供名称，插件会写入一个名称（`<agent>-<8 hex>`）。如果两个待处理调用使用同一名称，两者都不会被更改。通过 `eval.agent()` 和 `workpool()` 启动的子代理会保留各自的模型，[路由范围](#路由范围)中的排除规则也适用于此处。

## 启用 judge 角色

路由使用 OMP 的 `judge` 模型角色。最简单的配置方式是提供 TypeSafe 凭据：

```bash
omp            # then run: /login typesafe
# or, before OMP starts:
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

有 TypeSafe 凭据时，`judge` 角色默认解析为 Jev（`providers.judgmentProvider: auto`）。OMP 负责提供凭据、基础 URL、模型、请求头和用量统计。

只有当该角色中第一个可用模型是通过 TypeSafe 或 OpenRouter decisions 等评判 API 提供服务的原生评判模型时，插件才会进行路由。`minimumConfidence` 依赖这些 API 返回的校准置信度。如果该角色解析为聊天模型或本地设备模型，或者没有凭据，插件不会调用它，而是保留请求的代理，并在每个会话中警告一次。

## 隐私与失败处理

评判请求包含任务内容、可选的共享上下文、原请求中的代理，以及候选代理的简短说明，其中包含模型和回退配置摘要。对话内容和系统提示词绝不会发送。请求、凭据和用量日志都通过 OMP 的 `judge` 角色处理；插件不存储密钥，也不修改进程环境。

只有当评判模型返回合法选项且置信度达到或超过配置值时，路由才会改变。其他情况，包括没有原生评判模型、发现候选项失败、置信度过低、返回非法选项、凭据被拒绝或网络错误，都会保留原路由，不会阻塞任何调用。路由会在八秒后放弃，并且总会比会话的工具调用处理器超时至少提前一秒结束；如果已经没有时间，便跳过路由。改写只影响 `agent`，另外会在开启 `judgeEffort` 时修改 `effort`，以及在 `modelBudget` 需要名称时修改 `name`。模型预算选择发生在子代理启动时；该阶段出现任何失败，都会保留原配置模型。
