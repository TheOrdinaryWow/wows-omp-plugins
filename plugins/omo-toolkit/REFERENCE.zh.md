# 运行时参考

本文档说明 [README.zh.md](README.zh.md) 中可选运行时辅助功能背后的契约。面向用户的行为见该文件。

## 设置与钩子

四个运行时设置通过宿主合并后的全局/项目插件设置读取，包名为 `wows-omp-plugin-omo-toolkit`，作用域以会话 `ctx.cwd` 为准。默认值为 `commentChecker=false`、`commentCheckerPath=""`、`initDeepAdvisor=true`、`fallbackArchitect=false`。

无效布尔值只禁用对应功能；无效的 `commentCheckerPath` 值禁用注释检查。启动时设置加载失败，则使用默认值，并禁用 `initDeepAdvisor`。模型角色注册不受影响。

注释检查器的 `tool_result` 处理器只有在启用后，才于会话启动或切换时注册。宿主没有取消注册接口，因此关闭该设置后需要重新加载或重启，才能恢复推测性读取和流式子任务提前启动。`turn_start` 会清空已报告文件集合。该集合用于反馈去重，不是分析器调用去重：无问题的文件仍可能在同一轮后续编辑后再次检查。状态以真实会话 ID 为键，同一会话内的修改按结果顺序分析。只修改 `content` 和固定的 `additionalContext`，原有 details 与错误状态保持不变。

`edit` 使用 `details.path` 或 `move`、`op`、`oldText`、`newText`、`snapshotsPruned` 和 `perFileResults`，所有原生编辑模式共用这些元数据。实际文件 `write` 必须有 `details.resolvedPath`，并读取磁盘上的最终内容。已知的挂载修改从 `details.xdev.inner` 解包；已应用的 AST 提案使用 `resolve` 的 `sourceToolName` 和 `sourceResultDetails`。仅预览不算修改。绝不解析 LSP 或 Shell 输出来推断改动文件。普通协议或设备写入不算源文件修改。

## 外部分析器协议

本包不附带原生可执行文件、下载器、平台解析器、npm 包或第三方运行时依赖。操作者需提供兼容 `code-yeongyu/go-claude-code-comment-checker` 0.8.0 的程序。

- 不含路径分隔符的命令按正常进程 `PATH` 查找；含分隔符的路径以会话 cwd 解析。
- 执行方式为直接 argv 调用：`<executable> check`，不经过 Shell。
- stdin 为一个 JSON 对象，包含 `session_id`、`transcript_path`、`cwd`、`hook_event_name: "PostToolUse"`、`tool_name` 和 `tool_input`。
- 精确编辑快照使用 `tool_name: "edit"`，传入 `file_path`、`old_string` 和 `new_string`。
- 文件写入，以及明确标注的快照缺失回退，使用 `tool_name: "write"`，传入 `file_path` 和最终 `content`。整文件回退不能证明被报告的注释由最近一次编辑引入。

退出结果：

| 结果 | 含义 |
| --- | --- |
| 退出码 0 | 无问题 |
| 退出码 2，且 stdin 已完整交付、stderr 非空 | 发现问题。stderr 最多保留 16,384 个 UTF-16 码元，并标注截断 |
| 其他退出码、启动错误、stdin 交付不完整（包括 EPIPE）或超时 | 未检查。绝不记为通过 |

忽略 stdout。截止时间为 30 秒；超时后先发送 SIGTERM，如有需要，经过一秒宽限再发送 SIGKILL。stdin 错误监听器保留至流结束，迟到的管道错误不会成为宿主未捕获的异常。首次失败只警告一次，并在本会话中使检查器失效；它绝不改变底层编辑或写入的成功状态。多文件检查同时受宿主扩展处理器截止时间约束。

只有固定的、由插件编写的评审指令会进入 `additionalContext`。检查器 stderr、注释和文件路径仍是普通的不可信工具输出。

## 建议资格与指标

自动评估仅在受宿主管理的启动后定时器中运行，并且只针对启用的 `ctx.agent.kind === "main"` 会话，且 `hasUI` 为真、`mode` 为 `tui` 或 `rpc`。切换会话不会自动提议。切换或关闭会取消待处理对话，并使迟到的答案失效。

非 Git 工作区，以及尚无提交 HEAD 的仓库，无法提供 Git 建议或持久快照。所有 Git 子进程使用直接 argv、5 秒截止时间、Windows 隐藏控制台和有界输出。文件系统扫描为异步。

覆盖计算（尚无持久快照时）：

- 深度 1 至 3 的候选目录，需至少有 8 个直接源文件或 500 行直接代码。根目录本身不算候选。
- 候选目录由自身或直到 worktree 根目录之间任一祖先的 `AGENTS.md` 覆盖，因此根指引覆盖所有候选。
- 跳过符号链接的文件和目录，以及以下目录名：`node_modules`、`.git`、`dist`、`build`、`vendor`、`.next`、`__pycache__`、`.venv`、`target`、`coverage`、`third_party`。
- 无候选则不提议。否则缺失覆盖比例需至少为 0.5。
- 源文件扩展名：`.ts`、`.tsx`、`.js`、`.jsx`、`.py`、`.go`、`.rs`、`.java`、`.kt`、`.swift`、`.rb`、`.php`、`.c`、`.cpp`、`.cs`、`.scala`、`.lua`、`.ex`、`.exs`、`.zig`、`.dart`。
- 一次评估内复用受跟踪文件清单和源文件内容读取。快照 `fileCount` 统计当前受跟踪路径；`loc` 统计当前普通受跟踪源文件的换行符数量。覆盖计算的直接行数按分隔后的行计数，末尾空行也计入。

漂移（有效基线）。按以下优先级触发刷新：

1. `commits >= 30 AND touchedRatio >= 0.15`
2. `churnLocRatio >= 0.25`
3. `ageDays >= 90`

无效或无法解析的快照提交视为过时。提交距离用 `rev-list snapshot..HEAD`。改动文件数与增加加删除的行数，来自开启重命名检测的 `snapshot` 到 `HEAD` 净差异，而不是逐提交累加。二进制 numstat 不计入行数，重命名元数据也不计数。任意深度的 `AGENTS.md` 和历史遗留的 `.omo/init-deep.json` 不计入差异分子。分母分别为 `max(当前受跟踪文件数, 1)` 和 `max(当前受跟踪源代码行数, 1)`，而不是快照中记录的计数。

抑制顺序：全局 Never、项目 Never、七天冷却期，然后是同一上次提议的 HEAD。提议的 HEAD 和时间在打开 60 秒选择器之前记录。`Run now` 会排入读取 `skill://init-deep` 的后续步骤，并写入一条 version-1 的建议性自定义条目，包含仓库身份、触发原因、指标，以及建议（并非替用户选择）的模式。跳过、取消或超时会设置冷却期。Never 保持到重置。用户的界面答案绝不写入基线。

## 建议器状态

所有路径都来自真实的文件系统和 Git 身份，调用者无法提供路径。

```text
<real git-common-dir>/wows-omp-plugins/omo-toolkit/init-deep/advisor.json
<real git-common-dir>/wows-omp-plugins/omo-toolkit/init-deep/worktrees/<sha256(real worktree root)>/snapshot.json
<getAgentDir()>/omo-toolkit/init-deep-advisor.json
```

项目文件由关联的 worktree 共享，快照按 worktree 分别保存。写入使用同目录临时文件和原子重命名，文件权限为 0600，自有状态目录权限为 0700。

项目建议器状态（`advisor.json`）：

```json
{"version":1,"declined":false,"cooldownUntil":0,"lastProposedHead":null,"lastProposedAt":0}
```

worktree 快照（`snapshot.json`）：

```json
{"version":1,"commitSha":"<full Git SHA>","fileCount":0,"loc":0,"timestamp":0,"mode":"local"}
```

全局拒绝记录（`init-deep-advisor.json`）：

```json
{"version":1,"declined":false,"declinedAt":null}
```

时间为非负有限的 epoch 毫秒，计数为非负有限数值，`mode` 为 `local` 或 `committed`。

文件缺失表示没有拒绝记录，也没有基线。项目或全局状态无效或版本不受支持时，会报告并保留，而不是重置后重新提示。无效快照是显式的 `snapshot-invalid` 资格条件。未来版本的快照会被拒绝并保留。

这是首个已发布的持久格式，因此没有需要升级的旧格式。技能写入的无版本号 `local://init-deep/snapshot.json` 保持不变，不会被静默视为 version 1 或迁移。以后任何持久格式升级，都必须同时提供加载时升级，以及从上一格式恢复的测试。

## `toolkit_init_deep` 工具

该工具采用写入审批，因为 `record` 会修改仓库元数据。

- 参数：`action` 为 `"status"` 或 `"record"`。`mode` 为 `"local"` 或 `"committed"`，`record` 必须提供。
- 两种操作都不接受调用者指定的仓库、目标路径、SHA、计数或时间。
- `status` 返回当前仓库的项目、全局和快照状态。
- `record` 只在 `init-deep` 的独立验证 PASS，且指引已交付或提交（或已完成待评审 PR 交接）之后运行。它捕获当前 HEAD、受跟踪清单、源代码行数和时间，然后写入 version-1 的 worktree 快照。
- 成功时，JSON content 和 `details` 中返回 `{commitSha, fileCount, loc, timestamp, mode}`。技能将这五个字段复制到 `local://init-deep/snapshot.json`。
- 失败时返回 `isError: true` 和说明，并保留原有快照。
- 记录操作不是独立验证证据，验证要求仍由技能负责。报告和摘要保留在会话本地的 `local://init-deep/` 下。

## 回退连续性

`message_end` 只会在 assistant 结果的 `stopReason` 为 `"error"`，且 `stopDetails.type` 为 `refusal` 或 `sensitive` 时启用提示。新的拒绝会替换之前待处理的拒绝。之后出现非拒绝的 assistant 结果、新的交互或 RPC 输入、会话切换或关闭，都会清除待处理状态。

fallback-applied 事件必须匹配被拒绝的提供商和模型、当前主模型回退目标，以及实时活动 task 名单中的 `architect`。思考后缀归一化使用宿主提供的辅助函数。`reason` 只是可选的展示信息，不是分类器，也不是可信指令来源。

`context` 钩子只在匹配的目标请求上消费一次提示。它只向该请求的消息副本添加一条由插件编写的 developer 消息（`attribution: "agent"`）。回退成功事件不会重新启用它。没有永久回退模式、没有按输入提醒、没有自动派发 `architect`、没有模型角色修改，也不会覆盖安全边界。
