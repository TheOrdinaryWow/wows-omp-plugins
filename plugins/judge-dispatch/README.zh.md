# judge-dispatch

[English](README.md) | 简体中文

插件让 OMP 的 `judge` 模型角色参与 `task` 调用启动子代理的决策。开启 `routeAgent`（默认开启）后，它可以替换父代理请求的代理类型。开启 `selectModel` 后，它会从该代理配置的所有模型中为子代理选择模型。开启 `judgeEffort` 后，它会设置思考强度。OMP 仍会验证每次子代理启动。

## 安装

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

需要 OMP 18.3.5 或更高版本。安装后请重启会话，让扩展完成注册。它使用 OMP 内置的评判功能，没有自己的凭据，详见[启用 judge 角色](#启用-judge-角色)。

## 路由范围

开启 `routeAgent` 后，插件会改写普通 `task` 调用中的 `agent` 字段，单项和批量调用都适用。通过 `eval.agent()` 或 `workpool()` 启动的子代理不会参与路由，因为 OMP 的 `before_subagent_spawn` 钩子只能更改子代理的模型，不能更改其代理类型。关闭 `routeAgent` 后，请求的代理始终保持不变，评判模型只回答思考强度和模型问题。

候选代理来自当前 `task` 工具描述中的代理列表，OMP 已根据启动策略和禁用状态过滤该列表。如果列表缺失、无法读取或为空，插件不会进行评判。`task` 工具会重新验证插件写入的任何代理名称。

以下调用保持原样，包括思考强度和模型：

- 请求 `audit-*`、`metis`、`momus` 或 `oracle` 的调用；普通请求也绝不会被路由到这些工作流角色；
- 请求的代理不在插件读取到的列表中，因为其访问权限未知；
- `omo-prometheus` 计划执行期间的所有 `task` 调用，因为已批准的计划决定了代理和思考强度的选择。工作流回到空闲或规划状态后，路由会恢复。

插件依据 OMP 的代理工具元数据判断权限，只读代理只能被另一只读代理替换。

## 宿主模式

TUI、RPC/rpc-ui、ACP、SDK 和无界面/CI 中，路由与启动模型选择均不依赖界面。TUI 显示工作与状态提示；RPC 客户端接收宿主支持的通知帧，ACP 可能仅记录通知日志。`hasUI: false` 时跳过路由指示器。插件没有交互式对话框，也没有需要参数化的斜杠命令。

插件不保留每会话路由历史或工作流状态，因此不发布插件状态 sidecar。模型切换使用有数量限制的一次性待启动交接记录，而非决策历史。当前路由状态不会保存或发送给模型；旧版会话记录仅为兼容而保留渲染和上下文过滤。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-judge-dispatch`。

```bash
omp plugin config list wows-omp-plugin-judge-dispatch
omp plugin config set wows-omp-plugin-judge-dispatch routeAgent false
omp plugin config set wows-omp-plugin-judge-dispatch selectModel true
omp plugin config set wows-omp-plugin-judge-dispatch modelBudget minimum
omp plugin config set wows-omp-plugin-judge-dispatch modelPick weighted
omp plugin config set wows-omp-plugin-judge-dispatch providerWeights "openai=2,anthropic=1"
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `routeAgent` | 布尔值 | `true` | 允许评判模型替换请求的代理类型。 |
| `selectModel` | 布尔值 | `false` | 从代理的模型池中为每次启动选择模型，详见[模型选择](#模型选择)。 |
| `modelBudget` | `minimum` \| `balanced` \| `max` | `balanced` | `selectModel` 可以使用模型池中的哪些模型，以代理的主模型为基准。 |
| `modelPick` | `best` \| `weighted` | `best` | `selectModel` 在可用模型中如何选择：取评判最契合的模型，或按偏向便宜模型的权重随机抽取。 |
| `providerWeights` | 文本 | 空 | 提供商偏好，格式为 `provider=weight`，用逗号或换行分隔。权重必须大于 0；未列出的提供商权重为 1。 |
| `judgeEffort` | 布尔值 | `false` | 同时让评判模型设置每次 `task` 调用的思考强度，详见[思考强度](#思考强度)。 |
| `minimumConfidence` | 0 到 1 之间的数字 | `0.70` | 替换请求的代理类型或思考强度、采用评判出的难度所需的最低置信度。 |
| `includeSharedContext` | 布尔值 | `true` | 将任务调用的共享 `context` 一并发送给路由评判请求。 |
| `indicator` | 布尔值 | `true` | 显示路由活动，详见[界面显示](#界面显示)。无论是否显示，路由行为都相同。 |

用户设置会与项目覆盖配置合并。插件在每次 `task` 调用时读取这些设置，因此更改后无需重启即可生效。设置值无效时（例如 `providerWeights` 中有格式错误的条目），插件会保持所有调用原样并记录警告。

0.6 之前的版本只有 `modelBudget`，并带有 `off` 取值。已保存的 `modelBudget: off` 仍会被读取为 `selectModel: false`；已保存的其他预算值会开启 `selectModel`，除非显式设置了 `selectModel`。

## 界面显示

评判过程中，工作提示显示为 `judge-dispatch: routing N tasks…`。评判完成、失败或超时后，会恢复默认提示。

每次参与路由的 `task` 调用随后都会立即显示一行暗色状态提示，与 Ctrl+O 显示的提示类型相同，例如：

```text
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · effort med → hi (0.92) · model openai/gpt-6.1 → anthropic/claude-opus (fit 0.71)
```

每一项都会显示评判置信度，无论代理被替换还是保留。如果没有可用的评判结果而保留原代理，则会显示原因：`judge unavailable`、`judge failed`、`timed out`、`no alternatives`、`no confident choice` 或 `workflow-owned or unknown agent`。关闭 `routeAgent` 时，该项只显示代理名称。开启 `selectModel` 时，`model` 部分会显示主模型和替换它的模型，或主模型保留的原因。如果调用因路由失败、超时或宿主未留出评判时间而完全未进行评判，仍会显示以 `kept the requested agent:` 开头的状态行。Prometheus 执行已批准计划期间的调用不会参与路由，也不会显示任何提示。

你可以看到状态行，但 OMP 不会将它发送给模型或保存在会话中，因此在 `/resume` 后不会再次出现。OMP 会将连续到达的状态行合并为一行，所以同一轮中的多次 `task` 调用可能只留下最后一行可见。OMP 也会在子代理解析出的模型旁标注模型切换。

将 `indicator` 设为 `false` 可同时隐藏工作提示和状态行。

## 思考强度

开启 `judgeEffort` 后，评判模型会判断任务的开放程度，将其分类为 `routine`、`standard` 或 `demanding`。插件据此将 `task` 调用的 `effort` 设置为 `lo`、`med` 或 `hi`。OMP 会将其映射到子代理模型支持的最低、中间或最高思考级别，并受 `task.maxEffort` 上限约束。最终级别始终是该模型支持的级别。

难度判断的置信度达到 `minimumConfidence` 时，插件会替换父代理指定的思考强度。置信度较低时则保持原值。即使只有一种代理类型符合条件，评判模型也会判断难度。无论 `task.enableEffort` 是否向父代理显示该字段，OMP 都会应用思考强度。[路由范围](#路由范围)中的排除规则也适用于思考强度。

## 模型选择

开启 `selectModel` 后，插件会从被启动代理的**模型池**中为子代理选择模型，而不是总从主模型开始。

### 模型池

模型池按顺序展平该代理可以使用的所有模型：

1. 代理的模型选择器：其 `task.agentModelOverrides` 配置项，否则为 frontmatter 中的 `model` 列表，`@smol` 等角色别名展开为该角色的模型；
2. 这些选择器中每个角色别名对应的 `retry.fallbackChains` 配置项；
3. 只有一个选择器时，OMP 本身会给子代理的回退链（该角色的链，或 `default`）。

解析到同一 `provider/id` 的条目只计一次，保留最先出现的条目及其思考级别后缀。OMP 的模型注册表负责解析每个条目。注册表包含来自 models.dev 的价格和 OMP 实时模型目录中的智能评分，并会将自定义提供商和代理提供商的 ID 匹配到已评分的目录条目，因此插件不维护自己的模型数据。没有凭据的模型会被移除，没有评分或价格的模型不会被选中。如果主模型没有评分，子代理会保留原配置模型。

### 哪些模型可用

`modelBudget` 以**主模型**（模型池第一项）为基准决定哪些模型可用。主模型是你在配置中声明的基线：可能是最强的模型，也可能是较便宜的次选，或是"够用"的模型、把更强和更弱的模型都放进回退链。预算只设下限，因此比主模型更强的模型始终可用，主模型本身也始终可用。

| 预算 | Routine | Standard | Demanding |
| --- | --- | --- | --- |
| `max` | 不低于主模型评分 | 同左 | 同左 |
| `balanced` | 不低于主模型评分的 80% | 不低于 90% | 不低于主模型评分 |
| `minimum` | 模型池中任意模型 | 任意 | 任意 |

难度来自设置[思考强度](#思考强度)的同一次评判，与 `judgeEffort` 是否开启无关。难度判断的置信度低于 `minimumConfidence` 时按 demanding 处理，因此预算不会基于猜测降级。

### 如何选出一个

评判模型还会收到模型池中的模型及其评分和价格，并返回每个模型与任务的契合度。

- `best`（默认）选择契合度 × 提供商权重最高的可用模型。因此低预算只扩大可选范围，不会强制选更便宜的模型：评判模型仍可能选择最强的模型。评判模型没有给出模型答案时，保留主模型。
- `weighted` 按契合度 × 提供商权重 × 便宜度加权，随机抽取一个可用模型。便宜度按价格对可用模型排名，价格相同时能力较弱的排在前面，名次 `r`（0 为最便宜）的权重为 $1/(1+r)^k$：

| 预算 | Routine `k` | Standard `k` | Demanding `k` |
| --- | --- | --- | --- |
| `max` | 0 | 0 | 0 |
| `balanced` | 1 | 0.5 | 0 |
| `minimum` | 2 | 1 | 0.5 |

`k = 0` 时不考虑价格。多次调用后，`weighted` 会把任务分散到整个模型池，预算越低越偏向便宜的模型。

价格按输入与输出价格 3:1 的比例取加权平均值。`providerWeights` 会把模型的权重乘以其提供商的值：`openai=2` 表示同等条件下 OpenAI 模型被选中的权重是两倍，但不会让不可用的模型变为可用。

选中的模型会移到本次启动的选择器列表首位，模型池中的其余模型依次作为重试链。OMP 会在解析后的模型旁显示路由注释。

OMP 的 `before_subagent_spawn` 事件不携带任务内容，因此插件通过任务项的 `name` 将决策与子代理启动关联起来。如果父代理没有提供名称，插件会写入一个名称（`<agent>-<8 hex>`）。如果两个待处理调用使用同一名称，或宿主在启动时解析出不同的主模型，子代理会保留原配置模型。通过 `eval.agent()` 和 `workpool()` 启动的子代理会保留各自的模型，[路由范围](#路由范围)中的排除规则也适用于此处。

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

评判请求包含任务内容、可选的共享上下文、原请求中的代理、候选代理的简短说明及其模型池，开启 `selectModel` 时还包含模型池中每个模型的评分和价格。对话内容和系统提示词绝不会发送。请求、凭据和用量日志都通过 OMP 的 `judge` 角色处理；插件不存储密钥，也不修改进程环境。

只有当评判模型返回合法选项且置信度达到或超过配置值时，代理或思考强度才会改变。其他情况，包括没有原生评判模型、发现候选项失败、置信度过低、返回非法选项、凭据被拒绝或网络错误，都会保留原路由和模型，不会阻塞任何调用。路由会在八秒后放弃，并且总会比会话的工具调用处理器超时至少提前一秒结束；如果已经没有时间，便跳过路由。改写只会在开启 `routeAgent` 时修改 `agent`，在开启 `judgeEffort` 时修改 `effort`，以及在切换模型需要名称时修改 `name`。模型在评判 `task` 调用时选定，在子代理启动时应用；该阶段出现任何失败，都会保留原配置模型。
