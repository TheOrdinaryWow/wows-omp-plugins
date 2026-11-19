# switch-until 参考

面向维护者和客户端开发者。使用方法见 [README.zh.md](README.zh.md)。

## 文件

- `src/index.ts`：`/switch-until` 命令、会话事件、轮次循环和恢复定时器。
- `src/state.ts`：保存记录的格式、从会话分支重建状态，以及停止规则。
- `src/judge.ts`：判定问题、判定调用和翻译。
- `src/evidence.ts`：从会话消息和插件状态组装判定文本。
- `src/translation-cache.ts`：按消息缓存翻译，以及判断文本是否含非拉丁字母。
- `src/sidecars.ts`：读取本会话的插件状态文件。
- `src/models.ts`：模型选择、选择器和压缩判断。
- `src/args.ts`：无界面命令形式的解析器。
- `src/settings.ts`：设置的默认值和校验。

清单是 `package.json`，`omp.extensions` 指向 `./src/index.ts`。`omp.settings` 声明了四个设置。插件没有运行时依赖。

| 设置 | 类型 | 默认值 | 规则 |
| --- | --- | --- | --- |
| `minimumConfidence` | 数字 | `0.8` | 0.5 到 1 |
| `maxTurns` | 整数 | `0` | 0 或更大；0 表示不限 |
| `maxHours` | 数字 | `6` | 大于 0；允许小数 |
| `contextMessages` | 整数 | `6` | 1 或更大 |

设置在设置阶段、每轮开始和结束、重建运行状态时，以及每次定时检查时，通过 `getPluginSettings("wows-omp-plugin-switch-until", ctx.cwd)` 重新读取。校验失败的值会记录警告并使用默认值。读取本身失败时，全部使用默认值。

## 只有主会话生效

所有命令和事件处理器都会先判断 `ctx.agent.kind === "main"`，否则直接返回。加载了插件的子代理会话不做任何事。

## 设置流程

`/switch-until` 按下面的顺序执行。直到第 9 步才真正切换。

1. 要求当前会话有模型，并且 agent 注册表里能找到这个会话。否则命令失败。
2. 如果已有切换在进行，且有界面，就询问是否替换；拒绝则停止。没有界面则失败。
3. 选目标模型。有界面且带参数时，参数经 `resolveCliModel` 解析，使用会话的 scoped 模型。有界面且无参数时打开选择器。无界面时，参数按无界面形式解析。取消则直接返回，不发消息。
4. 确认目标模型有原生判定模型：`findScopedSettings(ctx.cwd)` 必须返回设置，并且 `hasNativeJudge(settings, registry, 目标模型)` 必须通过。否则命令失败，并给出判定模型的提示。
5. 读取目标。有界面时，`ctx.ui.input("Until what?")` 的结果会去掉首尾空白。空目标或含换行的目标会直接返回，不发消息。无界面时，目标取自 `--until`。
6. 读取补充说明。有界面时使用 `ctx.ui.editor("Additional context (optional)")`，取消则中止。结果为空表示没有补充说明。无界面时取自 `--context`。
7. 读取设置，然后用 60 秒超时把目标翻译成英文。翻译失败会报错，且不切换。
8. 确认会话没变、原模型仍是当前模型，并且没有其他设置或切换正在进行。
9. 如果对话超过目标模型的上下文窗口，先压缩。压缩失败，或者压缩后仍超过窗口，就报错停止。然后再次确认目标模型有原生判定模型，再用 `session.setModelTemporary(model, thinking)` 切换，`thinking` 是选定的档位，没有则用模型的默认档位。切换后若当前模型不是目标，报错停止。
10. 写入 `start` 记录，挂接运行状态，安排截止时间检查，并发出通知。

TUI 中的选择器是 `ModelPickerComponent`，显示在底部浮层中。它使用会话的 scoped 模型，标出当前模型，并显示会话当前的思考档位。选择结果带有思考档位。有界面但不是 TUI 时，`ctx.ui.select` 列出所有可用模型的 `provider/id`，当前模型后面带 `(current)`。这条路径没有思考档位，使用模型默认值。

## 切换与恢复

- `setModelTemporary` 与 `/switch` 走同一条路径。它记录一次临时模型变更，不写入默认设置。
- 原始选择在设置时记下 provider、id、`selector` 和 `configuredThinkingLevel()`。`selector` 由 `formatModelStringWithRouting` 生成，带路由的模型会存成 `provider/id@upstream`。
- 恢复时用 `resolveExactModelIdentity` 解析保存的 `selector`，同一条上游路由连同 provider 和 id 一起回来。
- 恢复时传入保存的思考档位。如果保存的档位是 undefined，而会话当前设置了档位，就用 `setThinkingLevel(undefined)` 清掉。
- 两个方向的压缩都经由 `compactToFit`。只有 `getContextUsage().tokens` 大于模型的 `contextWindow` 时，才调用 `session.compact(undefined, { readerModel })`。窗口为 0 或缺失时跳过压缩。压缩后上下文仍超过窗口，调用会抛出错误。
- 恢复时，如果原模型需要压缩，先压缩。找不到原模型，或者压缩抛出错误，插件就显示错误，并在 60 秒后重新尝试。待处理的原因保持不变，所以每次重试都会再执行一次恢复。
- 只有确认原模型已经是当前模型，恢复才会写入 `end` 记录并发出通知。
- 流式输出过程中需要压缩时，恢复会先让出一次，让轮次结束的处理器先完成，再让压缩打断循环。其他情况下，插件不会等流式输出结束再恢复。
- 轮次结束时的轮数上限恢复，只有该轮有工具结果，或以 `toolUse` 结束时，才会把 `continues` 设为 true。如果此时恢复需要压缩，`compactToFit` 会对没有调用工具就暂停的轮次抑制继续。循环会停在那里，用户需要发一条消息才能继续。
- `needsCompaction` 把 `getContextUsage().tokens` 与目标的 `contextWindow` 比较。这个数字是 OMP 为当前模型报告的。服务商自己压缩之后，它反映的是当前模型的视角，因此切到另一家服务商、窗口小得多的模型时，仍可能超出窗口。

### 外部切换模型

插件用 `formatModelStringWithRouting` 生成的路由标签比较 `ctx.models.current()` 与目标模型。不检测思考档位的变化。

自动备用模型会被视为同一个运行状态。归属从 `start` 记录开始，恢复过的运行则从最新的 `reconciled` 记录开始。归属点之后，角色不是 `fallback`（临时）的模型变更都算作明确切换。明确切换会以 `foreign-change` 结束运行，即使它选的正是目标模型。没有明确切换时，只要当前模型是目标模型，或者归属点之后最新的一次变更带有 `resolvedModelIsFallback` 标记并且模型名是当前模型，检查就通过。

比较发生在：每轮开始和结束时、每次判定前后、恢复前、每次定时器触发时、`context` 处理器中、切换进行时的命令处理器中、设置阶段，以及因待处理的上限而被拦住的请求准备中止之前，还有 `retry_fallback_applied` 事件中。不一致时写入 reason 为 `foreign-change` 的 `end` 记录，清除状态栏，并发出通知。不做恢复。

### 定时器与停止规则

运行状态会为截止时间设置定时器，即 `startedAt + maxHours`。延迟时间限制在 2,147,483,647 毫秒以内。定时器触发时，插件重新读取设置并判断：

- 如果切换或恢复正在进行，或者会话正在切换，250 毫秒后再检查。
- 否则，如果有待处理的原因，或者 `decide` 返回了原因，就执行恢复。
- 否则检查模型，并把下一次检查安排在截止时间。

`decide` 的判断顺序是：截止时间（`time-limit`），然后是 `maxTurns`（大于 0 时为 `turn-limit`），最后是判定概率与 `minimumConfidence` 的比较（`met`）。只有证据是最新符合条件的轮次时，概率才能得出 `met`。定时器和轮次边界的检查不传入概率，所以只能得出上限类原因。

主会话每次 `turn_end` 都会让 `turns` 加一，写入一条 `turn` 记录，并在判定运行之前先检查上限。因此上限会直接触发恢复，不必等判定模型。轮数从切换开始时计起。替换切换时，轮数从零重新计。

待处理的上限原因存在时，发往模型的请求会经过一个 before-model-call 钩子。钩子先等待正在进行的轮次检查和恢复。如果等完后运行状态仍然拥有临时模型，钩子就中止这次请求。上限在恢复开始时就已记录，早于压缩和通知，因此从那一刻起请求就被拦住。钩子会一直安装到运行状态脱离为止，所以恢复失败后，请求仍然被拦住。上限待处理时执行 `/switch-until cancel`，恢复时沿用上限的原因。

## 上下文注入

切换进行中且设置了补充说明时，`context` 事件会返回一份请求消息的副本，末尾多一条用户消息：

```text
Additional user-provided guidance for the current goal, active until the goal is met:

<补充说明内容>
```

这条消息不写入会话，也不修改系统提示词，所以提示词缓存不受影响。切换结束后，它随之消失。

## 判定

### 何时判定

只有当该轮的助手消息包含非空白文字，或者该轮的工具结果中有 `task` 工具的结果时，`turn_end` 才会判定。只调用工具的轮次会跳过。

判定在事件处理器之外的队列中执行。`turn_end` 把判定加入队列后立即返回，不等待判定完成。同一个切换同一时间只有一次判定在进行。判定进行中又有符合条件的轮次结束时，队列会保存一个待执行的请求，新请求会替换旧请求。当前判定完成后，待执行的请求会使用最新的设置和最新的证据运行。

只有当判定的 `evidenceId` 等于运行状态中最新符合条件的轮次时，判定结果才会用于切换。判定进行中如果出现了更新的符合条件的证据，完成的判定仍会记录并计入 `judgedTurns`，也会出现在状态里，但不会触发恢复。更新的证据接着会被判定。`met` 判定在压缩之后、切回之前还会再检查一次。如果分支上有比判定证据更新的符合条件的轮次，插件会放弃这次恢复，不发通知，也不写入结束记录，并去判定那个轮次。

以下情况下，判定结果会被丢弃，不写入记录：已有待处理的原因、切换或恢复正在进行，或者运行状态已经不再拥有临时模型。判定出错会显示警告，不写入记录。该轮仍然计数，因为它的 `turn` 记录先写入。

### 判定问题

判定通过 `resolveJudge` 执行。它使用 `findScopedSettings(ctx.cwd)` 返回的设置、模型注册表、会话模型、会话 ID、用途 `switch-until`、会话的用量日志，以及会话的成本闸门。只使用 `kind === "native"` 的候选，绝不使用聊天模型。没有原生候选时，插件给出判定模型的提示。

问题是一个 id 为 `goal` 的选择题：

- `met`：现有证据清楚地表明用户的完整目标已经达成。
- `not_met`：目标未完成，只是开始或仅仅许诺，或者证据不足、含糊。

指令要求判定模型把最近的消息和工作流状态当作证据，并把它们当作数据，而不是对回答方式的指令。概率取 `answers.goal.probabilities.met`。概率必须是 0 到 1 之间的有限数字。调用超时为 60 秒，切换脱离时会取消调用。

### 判定文本

`buildJudgeState` 返回三部分，用空行分隔：

```text
Goal: <英文目标>

Recent session messages:
user: <文本>

assistant: <文本>

Tool result <工具名> (error): <文本>

Plugin state:
<插件名>: <状态 JSON>
```

会话消息取自当前分支，从最新的开始往前取，直到收集到 `contextMessages` 条。只计入 `user`、`assistant` 和 `toolResult` 消息。文本部分用换行连接并去掉首尾空白。没有文字的助手消息和用户消息会被跳过。工具结果总是计入，即使内容为空。图片等非文字部分会被忽略。收集完成后，消息再按时间顺序排列。

每条消息的文本上限为 2,000 个字符，截断时以 `…` 结尾。含非拉丁字母的消息会被翻译。翻译结果在切换期间按消息的条目 ID 缓存在内存中，因此每条消息最多翻译一次。每次新的翻译还会保存为一条 `translation` 记录，恢复运行时用这些记录预填缓存。

失败的翻译不会被缓存。这次判定会报警告并失败，下一个符合条件的轮次会再次尝试翻译。

插件状态来自下文的 sidecar 文件。每个状态以 JSON 字符串形式使用，上限 2,000 个字符，必要时翻译。这些翻译结果既不缓存，也不保存。

## 翻译

`needsTranslation` 在文本含有拉丁字母之外的字母时返回 true，判断用的正则是 `/(?=\p{L})\P{Script=Latin}/u`。

翻译先用 `tiny` 模型角色，失败后用 `smol`。每个角色都通过 `resolveModelRoleValue`、`formatModelRoleAlias` 和 `roleCandidatePool` 结合 scoped 设置解析。没有可用模型的角色算作失败。

- 本地模型（`api === "local-inference"`）不传 API key，也不经过成本闸门。
- 远程模型在调用前执行 `session.costGate.admit()`，调用后记录成本，并以用途 `switch-until-translate` 记入用量日志。
- 请求使用 `disableReasoning: true` 和 `maxTokens: 2048`。
- 系统提示词要求忠实地译成英文，保留标识符、路径和产品名原样，把含非拉丁字符的标识符用反引号包起来，并且只返回译文。

只有同时满足以下条件，结果才算翻译成功：有文字、含 ASCII 字母，并且去掉反引号片段后没有非拉丁字母。停止原因为 `error`、`aborted` 或 `length` 时算失败。两个角色都失败时，错误信息会列出每个角色的失败原因。

目标在设置时翻译一次，超时 60 秒。英文结果以 `englishGoal` 存入 `start` 记录。

## 插件状态 sidecar

插件读取其他插件为会话发布的状态文件，从不写入。

- 运行目录是：当 `XDG_RUNTIME_DIR` 为绝对路径时，为 `$XDG_RUNTIME_DIR/wows-omp-plugins`；否则为 `<os.tmpdir()>/wows-omp-plugins-<uid>`。
- 文件位于 `plugin-state/<sessionId>/`。会话 ID 必须是单一路径段，`.` 和 `..` 会被拒绝。
- 根目录必须是真正的目录，归当前用户所有，且没有组和其他用户的权限位。检查不通过时，什么都不读。
- 只读取普通的 `.json` 文件，按文件名排序。只有同时满足以下条件的文件才会被采用：`schema` 为 `"wows-omp-plugins/plugin-state"`，`version` 为 `1`，`sessionId` 与当前会话相同，`plugin` 是字符串，并且有 `state` 键。
- 无效文件会被跳过，并以 debug 级别记录日志。

## 保存的记录

每条记录都是会话中的自定义条目，自定义类型为 `switch-until`。每条记录都带有 `version: 1`。读取时只接受这一个版本，格式不符的记录会被跳过。载荷有下面六种 `kind`：

| kind | 字段 | 写入时机 |
| --- | --- | --- |
| `start` | `run`：`id`、`original`、`target`、`goal`、`englishGoal`，可选 `context`，`startedAt` | 设置时 |
| `turn` | `id`、`turns` | 轮数增加时写入，通常在 `turn_end` |
| `judgment` | `id`、`turns`、`judgedTurns`、`judgment`：`probability`、`at`、`evidenceId` | 每次记录的判定 |
| `translation` | `id`、`messageId`、`text` | 切换期间每次翻译一条消息 |
| `reconciled` | `id`、`modelEntryId` | 恢复时重新应用目标模型 |
| `end` | `id`、`reason`：`met`、`cancel`、`foreign-change` 或 `limit`，可选 `limit`：`turn-limit` 或 `time-limit` | 切换结束时 |

选择项的形式是 `{ provider, id, selector?, thinking? }`。`selector` 是带路由信息的标签，用于精确恢复。`thinking` 是 CLI 思考档位之一，或者 `inherit`。替换切换的 `start` 记录保留第一次切换的 `original`。

`limit` 既包括轮数上限，也包括时间上限。通知文字会区分两者，`end.limit` 会记录是哪一个结束了切换。

重建状态时按顺序遍历当前分支：

- `start` 记录会替换之前的运行状态，并开始新的工作流。
- 版本不是 1 的记录会被忽略，字段校验不通过的记录也会被忽略。
- 其他记录只有在 `id` 与当前运行一致时才会应用。
- `end` 记录会把运行标记为已结束。它不再是活动切换，但在下一次 `start` 之前，状态命令仍会显示结束原因。
- 轮数比运行状态已有的值小的 `turn` 或 `judgment` 记录会被忽略。
- `translation` 记录会预填翻译缓存。
- `reconciled` 记录会移动归属点，外部切换检查从这里开始计算。其 `modelEntryId` 是重新应用目标模型的那条模型变更。

`startedAt` 是墙上时钟时间，因此重启后已用时间仍会继续累计。

## 会话事件

- `session_start`、`session_switch`、`session_tree` 和 `session_clear` 会脱离当前运行状态，并从分支重建。如果会话正在切换，插件会等切换完成，再检查运行状态。只有最近一次判定的 `evidenceId` 与运行状态中最新符合条件的轮次一致时，检查才会使用它的概率。因此，重启前留下的 `met` 判定只有在判定的是最新证据时，才会立即触发恢复。否则插件会立即判定比上次判定更新的证据。
- 重建时先调用 `reconcileTarget`。只要运行状态仍拥有会话模型，它就重新应用保存的目标路由和思考档位。遇到明确的模型变更时它不做任何事，随后这个变更会以外部切换结束运行。
- `session_shutdown` 清除定时器，并中止判定。在 print 和 json 模式下，它会先等待未完成的工作最多 1.5 秒。它不写入记录，所以下次打开会话时切换仍然有效。
- `turn_start` 在该轮运行前检查停止规则。
- `retry_fallback_applied` 会重新检查运行状态的模型。自动备用模型不会结束切换，而真正的外部切换仍会结束它。

## 状态与通知

有界面时，状态栏是 `ctx.ui.setStatus("switch-until", "until: <目标>")`。目标截到 40 个码位，第 39 个之后接 `…`。运行状态脱离时清除状态栏。

有界面时，通知通过 `ctx.ui.notify(text, level)` 发出。无界面时，通过 `pi.sendMessage({ customType: "switch-until", content, display: true, excludeFromContext: true })` 发出。

设置完成时的通知是 `Switched to <目标模型> (<思考档位> thinking) until: <目标>`。

恢复时的通知文字为：

- `Goal met. Restored <selector> (<thinking> thinking).`（目标达成）
- `Switch-until cancelled. Restored ...`（已取消）
- `Switch-until reached its turn limit. Restored ...`（达到轮数上限）
- `Switch-until reached its time limit. Restored ...`（达到时间上限）
- `Switch-until ended because the session model changed.`（会话模型已改变）

恢复失败时，以 error 级别显示 `Switch-until could not restore the model. <原因>`，并在 60 秒后重试。判定失败时，以 warning 级别显示 `Switch-until judgment failed. <原因>`。

`/switch-until status` 输出临时模型和思考档位、恢复模型和思考档位、目标、是否有补充说明、已用时间（时、分、秒）、已判定轮数与总轮数，以及最近一次判定的概率、时间和简短解读。概率高于 0.5 时解读为 “judge favored met”，低于 0.5 为 “judge favored not met”，等于 0.5 为 “judge was evenly split”。

没有活动切换、但上一次运行已经结束时，状态会改为输出 `Last switch-until: <原因>.`、目标和最近一次判定。原因包括 `Goal met`、`Switch-until cancelled`、`Session model changed`、`Switch-until reached its turn limit` 和 `Switch-until reached its time limit`。

## 运行模式

- TUI（`ctx.mode === "tui"`）：模型选择浮层、通知和状态栏。
- 其他有界面的模式，比如提供对话框的 RPC 和 ACP 宿主：模型选择用 `ctx.ui.select`，目标用 `input`，补充说明用 `editor`，替换时用 `confirm`。插件根据 `ctx.mode` 和 `ctx.hasUI` 分支，而不是根据宿主的名字。
- 无界面（headless）：只能使用命令形式，即 `/switch-until <模型> --until "<目标>" [--context "<文本>"]`。解析器接受双引号值（支持 `\"` 和 `\\` 转义）、单引号值和裸词。标志必须是裸词。`--until` 必填。以 `--` 开头的裸值会被拒绝。目标必须在一行内。已有切换时拒绝新的切换，必须先取消。不询问替换确认。通知以显示消息的形式发出。
- `status` 和 `cancel` 在所有模式下都可用。参数补全会提供 `status`、`cancel` 以及会话模型列表中的模型标签。前缀含空白时不返回任何补全。

## 并发

- `commandOpen` 阻止同时进行第二次设置。
- `switching` 在切换或恢复进行中阻止模型变更、判定和恢复。设置流程在完成各个 await 后，会再次检查会话，然后才切换。
- 判定队列最多保存一个待执行的请求，新请求会替换它。
