<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/judge-dispatch-dark.png">
  <img alt="judge-dispatch" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/judge-dispatch-light.png">
</picture>

# judge-dispatch

[English](README.md) | 简体中文

> 给每个子代理把一道关：判定模型先看看该派哪种代理、任务有多难，你的设置决定这会改变什么。

代理把任务交给子代理时，会选一种代理类型来做（`task`、`explore`、`deep-low` 等等），这个选择不一定对。装上这个插件后，OMP 的判定模型会先看一遍每个任务。它可以把代理换成更合适的类型，也可以把任务评为 `routine`、`standard` 或 `demanding`。评级有什么用由你决定：让简单的任务少思考、难的任务多思考，或者交给你指定的模型。判定模型自己从不挑模型。它拿不准的时候，任务会完全按代理原来的要求运行。

## 安装

```bash
omp plugin install judge-dispatch@wows-omp-plugins
```

需要 OMP 18.17.0 或更高版本。安装后重启会话。自动路由需要 OMP 的 `judge` 角色配置了判定模型（见下文）。

## 快速上手

插件使用 OMP `judge` 角色指向的模型。这个模型必须是判定模型（judgment model），比如 TypeSafe 的 Jev 或 OpenRouter 的判定模型，因为插件要用到这类模型返回的置信度。普通聊天模型不行。

最快的办法是登录 TypeSafe，`judge` 角色默认就会指向 Jev：

```bash
omp            # 然后运行：/login typesafe
# 或者在启动 OMP 之前：
export TYPESAFE_API_KEY="your-typesafe-api-key"
```

想用别的判定模型，在 OMP 配置里把它分配给 `judge` 角色即可。如果这个角色指向的是聊天模型、本地模型，或者没有凭据，插件会让所有任务保持原样，并在每个会话里警告一次。

配置好之后，每个经过路由的任务都会显示一行灰色状态：

```text
judge-dispatch  #1 explore → task (0.87) ; #2 task kept (0.93) · thinking medium → high (0.92) ; #3 ultrabrain kept (0.95) · model openai/gpt-6.1 → @slow (0.88)
```

意思是：任务 1 从 `explore` 换成了 `task`；任务 2 保留原代理，但思考级别调高了；任务 3 改在 `@slow` 模型角色上运行。括号里的数字是判定模型的置信度。

默认情况下，插件只会更换代理类型。想让难度评级去调整思考级别或模型，请打开 `judgeEffort` 或设置 `modelTiers`（见[设置](#设置)）。

## 用法

### 选对代理

判定模型会结合任务内容和会话中可用的代理，在另一种代理明显更合适时更换代理类型。只读代理只会被换成另一个只读代理，所以只看代码的请求不会变成改代码的请求。用 `routeAgent: false` 可以关掉这项功能。

以下任务始终保持原样，模型和思考级别也不变：

- 其他插件的工作流代理：audit-goal 的 `audit-*` 代理，以及 omo-prometheus 的 `metis`、`momus` 和 `oracle`。其他任务也不会被派给它们；
- 交给 OMP `seance` 代理的任务，它用来查阅以前的会话；
- 交给插件不认识的代理的任务；
- 已经指定了自己模型的任务（OMP 的逐任务 `model` 字段）；
- omo-prometheus 执行计划期间的所有任务，因为批准的计划已经定好了谁做什么。

任务内容写在文件里的任务（OMP 的 `taskFile`）会保留原代理，因为判定模型读不到内容。从 `eval` 脚本启动的子代理完全不参与路由。

### 任务有多难

判定模型评估的是问题有多开放，而不是工作量有多大：修法或步骤已经明确时是 `routine`，做法基本清楚的常规工作是 `standard`，原因或设计还没定时是 `demanding`。只有评级会带来变化时才会询问，也就是打开了 `judgeEffort`，或者为这个代理配置了档位。判定模型没把握的评级按 `standard` 处理，不会带来任何变化。

### 按难度调整思考级别

打开 `judgeEffort` 后，`routine` 任务比代理平时少思考一级，`demanding` 任务多思考一级。起点是代理自己配置的级别。

- 没有固定级别的代理（未设置、`auto`、`inherit` 或 `off`）不做调整。
- 调整不会超出模型支持的级别范围，所以不会把思考关掉，已经在最低或最高一级时也不会变。
- 上调不会超过 OMP 的 `task.maxEffort`。
- 任务自己设置了 `effort` 时，保持它的设置。

### 让简单或困难的任务换模型

`modelTiers` 指定 `routine` 和 `demanding` 任务分别用哪个模型：

```text
routine=@smol,demanding=@slow,ultrabrain.demanding=openai/gpt-6.1:xhigh
```

每一项用逗号分隔，格式为 `[<agent>.]<routine|demanding>=<model>`，其中 model 可以是模型角色（如 `@smol`），也可以是具体模型（如 `provider/model[:level]`）。针对某个代理的项（`ultrabrain.demanding=…`）优先于针对所有代理的项。`standard` 任务始终使用代理自己的模型。

第一个模型不可用时，档位会使用对应模型角色的回退模型。档位生效时，使用档位自己的思考级别，不再做上面的思考级别调整。档位用不了时（比如角色不存在，或模型没有凭据），任务保留代理自己的模型，状态行会说明原因。档位从不阻止任务运行。

### 重试或升级任务

插件会告诉代理：要重试或升级任务，就用同一个名字再发一次。插件随后会把这一次尝试提一级：

- 子代理的回答以 `ESCALATE: deep-high` 这一行开头时，下一次尝试按 `demanding` 处理。
- 子代理在插件降低过难度的路线上（`routine` 档位或少思考一级）失败时，下一次尝试按 `standard` 处理，使用代理自己的模型和级别。

提级后的尝试保留原本要求的代理，也不会再次判定。状态行会显示 `escalated to demanding after ESCALATE: deep-high` 或 `raised to standard after a failed lowered run`。这些记录在 OMP 重启后失效。

### 让某个任务换一个模型运行

OMP 可以让某一个任务跑在你指定的模型上。在你自己的 OMP 设置里（不是项目设置）把 `task.perCallModel` 设为 `on`。之后代理会把这个任务的 `model` 字段写成一个精确的 `provider/model-id`，还可以加 `:level` 指定思考级别。只能用你已经配好的模型：在 `modelRoles` 里配置的聊天角色、所选代理自己的模型，或者会话当前使用的模型。如果你设置了 `task.perCallModelAllow`，模型还必须在这个列表里。其他模型都会被 OMP 拒绝。

judge-dispatch 会原样保留带有 `model` 的任务，不判断代理，不询问难度，也不改变模型或思考级别。

以前的 `agent@role` 写法已经去掉了。OMP 现在会把 `deep-low@abliterated` 这样的代理名当作未知代理拒绝。

### 你会看到什么

判定进行时，状态显示 `judge-dispatch: routing N tasks…`。之后每个经过路由的调用会显示一行类似上面的状态：代理、`thinking <from> → <to>`、`model <代理的模型> → <档位>` 或保留模型的原因，每项决定都带有判定模型的置信度。没得到可用答案而保留原样的任务会注明原因：`judge unavailable`、`judge failed`、`timed out`、`no alternatives`、`no confident choice`、`file-backed task`、`native model` 或 `workflow-owned or unknown agent`。整个调用都没能判定时，会显示一行以 `kept the requested agent:` 开头的说明。

状态行只给你看。它不会发给模型，也不会保存，所以 `/resume` 之后不会再出现。把 `indicator` 设为 `false` 可以隐藏它。

### 判定模型能看到什么

一次判定请求包含任务内容、任务对问题开放程度的描述、调用的共享上下文（除非你关掉 `includeSharedContext`）、原本要求的代理，以及每个可用代理的简短说明。你的模型、价格、对话内容和系统提示词都不会发送。

判定请求和 OMP 里其他判定一样，计入会话的费用上限（`session.maxCost`）和用量。

### 判定模型用不了时

判定模型缺失、拿不准、凭据被拒或连不上时，任务会按原来的代理、思考级别和模型运行，不会阻塞任何东西。插件最多等待八秒。

## 设置

为当前用户修改设置：

```bash
omp plugin config set wows-omp-plugin-judge-dispatch judgeEffort true
omp plugin config set wows-omp-plugin-judge-dispatch modelTiers "routine=@smol,demanding=@slow"
omp plugin config list wows-omp-plugin-judge-dispatch
```

只想在某个项目里改，就在该项目的 `.omp/plugin-overrides.json` 中写上：

```json
{ "settings": { "wows-omp-plugin-judge-dispatch": { "judgeEffort": true } } }
```

每个任务都会重新读取设置，所以修改立即生效。值无效时（比如 `modelTiers` 写错了），插件会让所有任务保持原样，并在日志中警告。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `routeAgent` | `true` | 允许判定模型把任务换给更合适的代理类型。 |
| `judgeEffort` | `false` | 让 routine 任务少思考一级，demanding 任务多思考一级。 |
| `modelTiers` | 空 | routine 和 demanding 任务分别用哪个模型，格式为逗号分隔的 `[<agent>.]<routine\|demanding>=<@role 或 provider/model[:level]>`。为空表示所有任务都用代理自己的模型。 |
| `minimumConfidence` | `0.70` | 判定模型要有多大把握（0 到 1），插件才会更换代理或按难度评级行事。值越高，改动越少。 |
| `includeSharedContext` | `true` | 判定模型除了每个任务的内容，是否还能看到 `task` 调用的共享上下文。 |
| `indicator` | `true` | 是否显示状态提示和状态行。路由本身不受影响。 |

## 与其他插件配合

- **audit-goal**：它的审查者和修复者代理不会被改派。
- **omo-prometheus**：`metis`、`momus` 和 `oracle` 不会被改派，执行已批准计划期间也不改派任何任务。计划完成或重新开始规划后，路由恢复。
- **omo-toolkit**：它的 `deep-low` 代理遇到自己定不了的决策时会回答 `ESCALATE: deep-high`。用同一个名字再派一次，这个任务就按 demanding 处理。

## 已知限制

- 从 `eval` 脚本启动的子代理（`agent()`、`workpool()`）不参与路由。
- 代理在一轮里发起多个 `task` 调用时，OMP 可能只显示最后一行状态。
- 重试和升级记录在 OMP 重启后丢失，而且只有同名的重试才能用上它们。
- 思考级别调整需要 OMP 知道模型支持哪些思考级别。缺少这项信息的模型保持原级别。

## 更多细节

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍了档位如何展开成模型列表、思考级别调整的具体规则、重试与升级记录、判定结果如何作用到子代理，以及超时。

## 许可证

MIT。
