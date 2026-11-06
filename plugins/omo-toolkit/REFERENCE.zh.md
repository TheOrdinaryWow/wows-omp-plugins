# 运行时参考

本文档说明 [README.zh.md](README.zh.md) 中代理、技能和可选运行时辅助功能背后的细节。面向用户的行为见该文件。

## 代理

分类代理以 OMP 内置 `task` 代理的同一份工作提示为基础，再加入 OmO 的分类指引。模型角色按顺序尝试。

`librarian` 只声明 `read`、`glob`、`grep`、`find` 和 `web_search`，因此 OMP 的原生分类器把它视为只读，judge-dispatch 也只会把它路由到只读目标。它用 `read` 阅读 HTTPS 文档、GitHub 原始文件，以及 GitHub 的 blob、tree 和 commit 页面。issue、PR 和 diff 通过 `issue://<N>`、`pr://<N>` 和 `pr://<N>/diff` 读取；跨仓库时加上 `<owner>/<repo>/`。宿主授予的文档 MCP 服务器仍然可用。原生读取工具可能使用宿主已配置的认证。只读工具列表不会给宿主授予的 MCP 服务器或扩展能力加沙箱，它们仍受宿主策略约束。

### 选择协议

每轮开始前，插件会把一份改编自 OmO 分类选择协议的说明加到主代理的系统提示中。只有 `task` 工具处于启用状态、且其代理列表包含 omo-toolkit 代理时才会出现，并且只列出该列表中的 omo-toolkit 代理。它告诉主代理每个代理负责什么领域、拿不准时选 `deep-low`、把相互独立的目标作为并行的 `task` 条目运行。子代理结果以 `ESCALATE: deep-high` 开头时，主代理采用用户已记录的决定；否则用同一个 `name` 把目标改派给 `deep-high`，列表中没有 `deep-high` 时询问用户。`deep-high` 返回 `ESCALATE: parent` 时，主代理询问用户。模型角色和协议的注册不依赖运行时设置。用户为 `designer` 或 `writer` 设置的 `modelTags` 会覆盖插件的标签。

## 技能辅助脚本

技能通过 `skill://<name>` 读取。有些技能会按各自的说明用 `node`、`bun`、`python3` 或 `uv` 运行辅助脚本。

- `frontend` 包括修改前基线、必需内容检查、无依赖的 Bun 草稿检查、组件库许可与访问检查，以及对现有界面小改动的例外。草稿检查的运行方式是 `bun <frontend-skill-directory>/scripts/perfection/check-draft-guard.ts <files-or-dirs> [--json]`。退出码：0 无问题，1 有发现，2 用法错误或显式目标无法读取。请在视觉 QA 之前运行；它不能代替渲染后的检查。
- `visual-qa` 对每个列出的用例在 390 和 1440 CSS 像素宽度（页面布局另加 1920）下分别截取浅色和深色截图。修复现有 UI 时，它先冻结用例列表并截取 `before`。每项记为 PASS、FAIL 或 N/A。低风险工作进行两轮评审，产品界面三轮；到上限仍未解决的缺陷以 NEEDS HUMAN REVIEW 结束。
- Lighthouse（可选）需要 Node、本地 Chrome，以及目标项目能解析到的 `lighthouse` 包。缺少时审计会明确提示并停止。
- `coding-agent-sessions` 只使用 Python 标准库。从 OMP 返回的技能目录中用 `python3 -B` 运行；不会修改复制的插件目录。OMP 的回溯从原生归档开始，选中的原始记录仍是证据。
- `onboarding` 涵盖已安装功能、配置映射、有限的历史回顾、预估的提示缓存折扣、由用户选择的原生记忆写入，以及符合条件时的 `init-deep` 建议。没有首次运行钩子，也不会自动导入。接受导览不代表授权查看历史、迁移设置、写入记忆或生成指引；每个重要步骤都单独询问，拒绝后跳过且不再重复询问。历史回顾默认只看当前项目、最近七天、20 个候选会话和五份完整记录。缓存折扣辅助脚本报告的是预估折扣，不是账单费用，也不是本插件带来的节省。写入记忆需要已启用且兼容的原生记忆工具，没有时什么都不保存。
- `give-me-tips` 读取已安装的文档、实时结构、配置和源码，不会添加轮换的启动提示。
- `data-scientist` 会在常驻、流式或溢写执行之间选择，并附带一个需要显式调用的快速查询辅助脚本。`programming` 带有可选的策略检查器，没有强制的规模门槛，也不会自动重构。它们的辅助脚本只在模型调用时运行；扩展不导入它们，安装时也不运行。生成器只写入新的目标目录，目标已存在时拒绝。可选的缓存辅助脚本只在设置了 `OMP_DATA_SCIENTIST_CACHE` 时写入该目录。
- `ultimate-browsing` 通过 `read` 和 OMP 浏览器处理被拦截的站点、平台原生阅读和带日期的归档来源。它不附带提取引擎、cookie 导出、解密或注入工具。
- `visualize` 写出一个内联所有资源、自带浅色和深色配色的独立 HTML 文件。交付前会运行 frontend 草稿检查，并在窄屏和预期报告宽度下用浏览器检查页面。

## 不使用终端界面时

代理、技能和 MCP 服务器在所有 OMP 模式下都一样。注释反馈在没有 UI 时也能工作：警告写入插件日志，有 UI 时还会显示通知。init-deep 顾问需要终端或 RPC UI 才会提出建议；没有 UI 时保持静默，但 `/init-deep-advisor` 仍会以可见消息回复。回退提示不依赖 UI。

## 设置与钩子

四个运行时设置通过宿主合并后的全局/项目插件设置读取，包名为 `wows-omp-plugin-omo-toolkit`，作用域以会话 `ctx.cwd` 为准。默认值为 `commentChecker=false`、`commentCheckerPath=""`、`initDeepAdvisor=true`、`fallbackArchitect=false`。

无效布尔值只禁用对应功能；无效的 `commentCheckerPath` 值禁用注释检查。启动时设置加载失败，则使用默认值，并禁用 `initDeepAdvisor`。模型角色注册不受影响。

注释检查器的 `tool_result` 处理器只有在启用后，才于会话启动或切换时注册。宿主没有取消注册接口，因此关闭该设置后需要重新加载或重启，才能恢复推测性读取和流式子任务提前启动。`turn_start` 会清空已报告文件集合。该集合用于反馈去重，不是分析器调用去重：无问题的文件仍可能在同一轮后续编辑后再次检查。状态以真实会话 ID 为键，同一会话内的修改按结果顺序分析。只修改 `content` 和固定的 `additionalContext`，原有 details 与错误状态保持不变。

`edit` 使用 `details.path` 或 `move`、`op`、`oldText`、`newText`、`snapshotsPruned` 和 `perFileResults`，所有原生编辑模式共用这些元数据。实际文件 `write` 必须有 `details.resolvedPath`，并读取磁盘上的最终内容。已知的挂载修改从 `details.xdev.inner` 解包；已应用的 AST 提案使用 `resolve` 的 `sourceToolName` 和 `sourceResultDetails`。仅预览不算修改。绝不解析 LSP 或 Shell 输出来推断改动文件。普通协议或设备写入不算源文件修改。

## 外部分析器协议

本包不附带原生可执行文件、平台解析器、npm 包或第三方运行时依赖。任何兼容 `code-yeongyu/go-claude-code-comment-checker` 0.8.x 的程序都可以使用。

- `commentCheckerPath` 为空时，检查器是 MIT 许可的 npm 包 `@code-yeongyu/comment-checker@0.8.2`，通过 Bun 的包运行器以 `bun x @code-yeongyu/comment-checker@0.8.2 check` 调用，`bun` 从 `PATH` 查找。Bun 会把这个包（连同平台二进制约 52 MB）下载到它自己的缓存中；版本号固定，因此之后的调用不会再访问 registry。
- 启用检查后，会话启动或切换时会在后台运行一次 `bun x @code-yeongyu/comment-checker@0.8.2 --help`（每个进程一次），首次下载因此不会发生在检查过程中，安装输出也不会混进检查结果。检查时如果下载仍在进行，只在结果预算还够一次完整检查的前提下等待；否则跳过该文件，并只提示一次“下载期间编辑的文件不会被检查”，检查功能保持启用。下载失败或超过五分钟（无网络、没有 Bun、registry 出错）时，走下文的“只警告一次并在本会话停用”路径。
- `commentCheckerPath` 非空时取代上述默认命令。不含路径分隔符的命令按正常进程 `PATH` 查找；含分隔符的路径以会话 cwd 解析。
- 执行方式为直接 argv 调用：`<command> check`，不经过 Shell。
- stdin 为一个 JSON 对象，包含 `session_id`、`transcript_path`、`cwd`、`hook_event_name: "PostToolUse"`、`tool_name` 和 `tool_input`。
- 精确编辑快照使用 `tool_name: "edit"`，传入 `file_path`、`old_string` 和 `new_string`。
- 文件写入，以及明确标注的快照缺失回退，使用 `tool_name: "write"`，传入 `file_path` 和最终 `content`。整文件回退不能证明被报告的注释由最近一次编辑引入。

退出结果：

| 结果 | 含义 |
| --- | --- |
| 退出码 0 | 无问题 |
| 退出码 2，且 stdin 已完整交付、stderr 非空 | 发现问题。stderr 最多保留 16,384 个 UTF-16 码元，并标注截断 |
| 其他退出码、启动错误、stdin 交付不完整（包括 EPIPE）或超时 | 未检查。绝不记为通过 |

忽略 stdout。每个检查进程的截止时间为 20 秒；超时后先发送 SIGTERM，如有需要，经过一秒宽限再发送 SIGKILL。每个 `tool_result` 从进入会话队列之前开始，共享 29 秒总预算，为宿主 30 秒扩展处理器上限保留返回余量。排队和文件准备时间都计入同一预算。只有剩余时间足够容纳完整 20 秒检查和一秒终止宽限时，才会启动检查器；否则通过现有的仅警告一次失败路径明确报告该文件未检查，并在本会话中使检查器失效。多文件结果也共享此预算，不会为每个文件重新计时。处理器在总截止时间到达时也会停止等待，避免排队或文件准备耗尽宿主时间窗口。stdin 错误监听器保留至流结束，迟到的管道错误不会成为宿主未捕获的异常。进程失败和预算耗尽都不会改变底层编辑或写入的成功状态。

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
