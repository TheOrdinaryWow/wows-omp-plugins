# omo-prometheus 参考

[English](REFERENCE.md) | 简体中文

## 规划交接

只有规划者通过 `ask` 提出的、标题为 `Prometheus` 且第二个选项指名 Prometheus 的那个问题，才算同意把普通 `/plan` 会话切换到 Prometheus。

Prometheus 计划的两个批准选项都会交给 Atlas。“Approve and execute”会开启一个新会话；为了让交接在切换后仍然有效，插件会在提出计划时把一个标记写入 `local://prometheus/<slug>.proposal.json`，OMP 会把它和计划一起复制到新会话。普通 Plan Mode 批准的计划没有这个标记，插件不会处理它们。

`xd://propose` 的批准和自动保存仍由 OMP 负责。插件不会在项目中创建 `.omo` 状态，子代理通过 OMP 的原生执行机制运行。

## Atlas 工具守卫

守卫只放行观察会话或修改宿主自有状态的工具，这些工具都不会写入工作区。下表并不会启用任何工具：会话中本来没有的工具，仍然不可用。

| 工具 | 在 Atlas 父会话中允许 |
| --- | --- |
| `task`、`wait`、`todo`、`ask`、`think`、`web_search`、`atlas_ledger`、`atlas_release` | 始终 |
| `read`、`find`、`glob`、`grep`、`ast_grep` | 始终；`read` 拒绝 `ssh://` |
| `lsp` | 只读操作，以及不带 `apply` 的 `code_actions` |
| `github` | `repo_view`、`file_read`、`search_*`、`run_watch` |
| `debug` | 仅状态检查（`threads`、`stack_trace`、`scopes`、`variables`、`output` 等），不允许 `launch`、`continue` 或断点 |
| `ida` | `list` |
| `recall`、`reflect`、`retain`、`memory_edit`、`learn`、`manage_skill` | 始终：它们写入的是记忆后端和托管技能，不是工作区 |
| `goal`、`context_notes`、`new_context` | 始终 |
| `write` | `agent://` 同伴消息、`proc://<id>/kill`，以及对任何已放行工具的 `xd://` 调用 |
| `hub` | 观察类操作和发给代理的 `send`，不允许向进程输入 |

其他工具一律屏蔽，包括 `bash`、`eval`、`edit`、`ast_edit`、文件写入、`security_scan` 以及 `checkpoint`/`rewind`。回退会让会话树分叉，脱离证明账本已完成行的任务回执。其他扩展或 MCP 服务器注册的工具即使与原生工具同名也会被屏蔽，下表列出的除外。

| 集成 | 放行的工具 |
| --- | --- |
| [Magic Context](https://github.com/cortexkit/magic-context) | `ctx_reduce`、`ctx_expand`、`ctx_search`、`ctx_memory`、`ctx_note`，仅限由扩展注册的；同名 MCP 工具仍被屏蔽 |
| 包装 `todo` 的扩展，例如 [omp-herdr-dag](../omp-herdr-dag/README.zh.md) 支持依赖边的 `todo` | 由扩展重新注册的 `todo`；MCP 提供的 `todo` 仍被屏蔽 |
| [roadmap](../roadmap/README.zh.md) | `roadmap_*`，可直接调用或以 `write xd://roadmap_*` 调用，仅限来自经路线图绑定握手验证过的扩展源路径（见[路线图契约](#路线图契约)） |

## 代理回退

Prometheus 根据会话 `task` 工具在应用派生策略和禁用设置后列出的代理来制定计划；Momus 也按同一份列表评审。用户自定义代理只有出现在列表中才有效；未列出的名称需要有已知的回退。如果无法解析工具描述，规划时会按原样保留已知名称，但无法检查用户自定义的名称。

派发时先尝试请求的代理，再依次尝试其回退，只选择当前列表中存在的代理：

| 请求的代理 | 回退链 |
| --- | --- |
| `deep-low`、`deep-high`、`ultrabrain`、`architect`、`visual-engineering`、`artistry`、`writing` | `task` |
| `librarian` | `scout` → `task` |
| `metis`、`momus`、`oracle` | `reviewer` → `task` |
| `sonic`、`scout`、`reviewer`、`security-reviewer` | `task` |
| `task` | 无 |

回退只改变代理；各代理的模型角色链见 [omo-toolkit README](../omo-toolkit/README.zh.md#代理)。如果整条链都无法派生，账本会显示 `unavailable`，Atlas 在开始该行时从当前列表中挑选最合适的代理（`atlas_ledger start` 带上 `agent`）。这个选择对该行一直有效，直到请求的代理或某个回退重新可用。只有当前列表为空时，Atlas 才会报告阻塞。

## 计划包

原生批准会在 `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/` 创建计划包，通常位于 `~/.omp/agent/sessions/<working-dir>/atlas/`。自定义会话目录同样适用；移动会话不会一并移动它的 `atlas/` 目录。

```text
plan.md          exact approved plan
approval.json    source approval, workspace and plan identity
ledger.json      task and gate progress, plus the workspace's Git HEAD at approval
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of the immutable approval
checkpoint.json  independent attempt and receipt bindings
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

Atlas 持有计划期间，会话的计划引用是 `atlas://<plan-id>/plan.md`，它是批准时 `plan.md` 的只读视图，子代理通过 OMP 的计划交接加载它。其他会话无法读取；如果计划内容发生变化，这个引用就无法再解析。

## 账本

账本记录每个 T 行和 F 行的验收标准、依赖、状态、请求的代理与实际使用的代理、尝试次数和证据回执，以及计划的 SHA-256 和关口要求的 X 修正行。

Atlas 通过 `atlas_ledger`（`status`、`start`、`done`、`block`、`reopen`、`fix`）驱动账本。只有子代理真实最终结果提供的证明才能把一行标记为完成，所以失败的、不属于本计划的或仍在运行的子代理，以及手写的引用，都不能完成工作。阻塞或重新打开某一行只影响这一行：依赖它的已完成工作保留各自的证明，由最终关口评判最终结果。`atlas_release` 要求每一行都有有效回执，并且需要你明确确认。

子代理的输出会被复制到 `evidence/` 并按摘要重新校验，因此即使删除原会话，已验证的进度也不会丢失。`atlas_ledger status` 会显示这些输出的位置。只保存子代理自己的输出，不复制它链接的文件。如果某行的证明丢失或被改动，该行会重新打开；旧的会话分支也无法回滚共享进度。

继续执行的消息是一条隐藏的 `<atlas-continuation>`，其中包含账本摘要。你发送的任何消息都会重置推动计数。

旧版本写入的账本会在加载时升级，并保留已验证的进度。版本 4 之前的账本没有记录 Git 基线，所以 F1 会以最早记录的行开始时间推定基线，并注明这一点。把账本存放在会话内的旧版本计划不会迁移，恢复时会暂停并要求重新批准。旧的 `prometheus_ledger` 和 `prometheus_release` 工具已改名为 `atlas_ledger` 和 `atlas_release`，不保留别名。

`timeline.jsonl` 记录挂载与释放、行开始、完成、阻塞与重新打开、修正行以及关口结论。它只用于展示：时间线缺失或损坏都不会让批准、所有权、回执或进度失效。旧版本的计划包在追加真实事件之前，会显示从账本推导出的历史；推导出的事件不会写回文件。崩溃导致截断的最后一行，以及未知的未来事件版本都会被忽略。

## 最终关口的输入

F1 读取经哈希校验的 `plan.md`（插件会在 F1 开始时打印其路径，不内联计划副本）、账本摘要，以及此时以只读方式收集的 Git 证据：从计划基线提交以来的 `git diff --stat`、`git log --oneline` 和 `git status --short`，无法获取时写明“unavailable”。`momus` 以 `review_kind: compliance` 运行 F1。只有格式匹配的结构化 `PASS` 才算通过，文字里写着“通过”不算。

## 所有权

原生子代理工作运行期间，所在会话会一直持有计划，直到该工作报告最终结果；其他会话在此期间无法写入计划。如果持有计划的会话可以证明已经结束，计划可以被恢复；所有权不明确或属于另一个宿主时，拒绝恢复。有些宿主无法可靠地告知子代理的最终处理是否已结束，而被取消的唤醒可能先于子代理结束；这时计划会一直被持有，直到原 OMP 进程退出。

退出不会阻止关闭宿主。当有活动会话持有计划或仍有原生工作未完成时，拒绝删除该计划。

## 会话集成

- 待办镜像：Atlas 根据校验过的账本维护会话的待办阶段（任务、存在时的修正，以及最终关口），其他阶段保持不变。挂载时和账本变化后，Atlas 阶段会被还原，请不要手动编辑。每个改动了行的 `atlas_ledger` 结果都会给出一个可重复执行的 `todo` 调用，用于刷新宿主 HUD。退出时保留待办列表。
- 会话标题：Atlas 进入计划后，会请 OMP 的标题生成器生成一个以“Atlas”开头的标题，使用你的 `TITLE_SYSTEM.md` 覆盖或 OMP 默认提示词。没有生成结果时，会话命名为 `Atlas: <plan name>`。用 `/rename` 设置的名称永远不会被替换，`PI_NO_TITLE` 会关闭这一功能，退出时保留名称。
- 模型角色：Prometheus 提案等待批准时，`atlas` 会被临时加到 `cycleOrder` 最前面，使批准滑块在 `smol`、`default` 和 `slow` 之外也提供它。在下一次输入或代理回合，或规划结束时，恢复原来的 `cycleOrder`。普通 Plan Mode 的批准永远不会出现 `atlas`，没有可用模型的角色也不会出现。如果指定的 `atlas` 模型无法解析，Atlas 仍会启动，并说明保持了当前模型。
- 检视视图：实时视图在进度变化时保持选中项和滚动位置。标题栏显示正在运行的子代理和已用时间；进行中的行显示已用时间；宿主提供进度时，Live 区域显示子代理身份、模型和思考级别、工具及参数、意图、用量、费用、重试和最近活动。Space 显示已归档的子代理输出。旧计划包中推导出的时间线事件会被标注出来。
- 没有 UI 时，裸 `/atlas` 打印计划列表，或打印正在运行的计划及其各行。进入计划失败时，会话保持暂停，直到运行 `/atlas exit`；Atlas 永远不会退化为仅靠提示词的执行。命令输出以 `wows-omp-omo-prometheus.command-status` 消息送达。
- 在 RPC 中，Atlas 激活时裸 `/atlas` 显示一个摘要，提供 Keep running、View details 和 Exit。View details 打开一个只读 `editor` 对话框，显示计划文本。小组件文本行最多每秒发送两次。`prometheus_activate` 和 `atlas_release` 的确认使用普通的 `select`/`confirm` 对话框。

## 状态快照

主会话会用共享的快照外层结构发布 `omo-prometheus.json`（见[仓库参考文档](../../REFERENCE.zh.md)）。既不在规划也不在执行 Atlas 时，`state` 为 `null`。否则为：

```json
{
  "kind": "omo-prometheus/state",
  "version": 1,
  "phase": "planning | awaiting-approval | executing",
  "planFilePath": "local://… (planning only)",
  "atlas": {
    "planId": "…", "name": "…", "paused": "reason, when execution is paused",
    "status": "In progress 1/6", "done": 1, "total": 6, "startedAt": 1760000000000, "runningChildren": 1,
    "rows": [{ "id": "T1", "title": "…", "status": "open | in_progress | done | blocked", "kind": "task | fix | gate",
               "agent": "task", "dependsOn": [], "attempt": "…", "startedAt": 0, "evidence": "…", "origin": "F1",
               "child": { "id": "…", "status": "running", "currentTool": "read" } }],
    "gates": [{ "id": "F1", "title": "…", "status": "done", "evidence": "…" }]
  }
}
```

`awaiting-approval` 指从 Prometheus 提出计划到作出批准选择之间的时段。`atlas` 只在执行时出现。它的进度字段与 Herdr DAG 契约使用同一份实时账本观察数据，在其加载完成后才会出现；暂停的计划可能只带 `planId` 和 `paused`。状态为 `done` 的关口表示已通过。切换会话和关闭时，正在执行的会话的文件保持原样，因为计划还可以在那里恢复。

## Herdr DAG 契约

启用 `herdrDag` 时，`omp-herdr-dag` 通过 `pi.events` 观察本会话绑定的 Atlas 计划。所有负载都是带 `v: 1` 的普通 JSON，不会改变 Atlas 计划包的格式。

| 事件 | 方向与负载 |
| --- | --- |
| `herdr-dag:hello` | 查看器发给生产者：`{v:1, sessionId, requestId}`。 |
| `atlas:hello` | 同步回复，保留 `requestId`；有绑定计划时附带其标识（`id`、`name`、`planFilePath`、`cwd`）。未绑定的会话启动或切换时也会主动发送。 |
| `atlas:snapshot` | 紧跟在每个带绑定计划的 hello 之后，以及每次实时更新时发送：计划标识、账本状态和总数、带依赖与修正来源信息的 T/X/F 行、每行的子代理进度、最近 50 条时间线事件。 |
| `atlas:released` | 解除绑定，`reason` 为 `"exit"`、`"session-switch"` 或 `"shutdown"`，随后发送一个不带计划的 hello。 |

启动顺序无关紧要。不支持的版本和未知会话会被忽略。某行完成后，最后已知的子代理进度仍然可见，开始新的尝试时清除。释放只表示计划不再显示在视图中；执行可能尚未完成，子代理也可能仍在运行。`herdrDag: false` 时不发送任何事件，包括 hello 回复；账本、待办镜像、所有权和界面行为不变。生产者不依赖查看器。

## 路线图契约

安装了 `roadmap` 时，Prometheus 使用一个独立于 `herdrDag` 的 `pi.events` 契约：

1. 提出计划时，发送 `roadmap:binding-request {v:1, sessionId, requestId}`，只接受与该会话和请求匹配的同步 `roadmap:binding` 回复，其中包含 `repoRoot`、`toolSourcePath` 以及可选的已绑定活动阶段。
2. 新的计划包写入版本 2 的批准文件，带可选的 `roadmapStage: {repoRoot, id}`。版本 1 的批准仍可恢复，不会改写其内容，也不要求重新批准。查看 `approval.json` 中的 `roadmapStage`，可以知道提出计划时是否绑定了阶段。
3. 只有当 `roadmap_*` 工具的扩展源路径与 `toolSourcePath` 完全一致时，Atlas 才会放行。守卫在第一次调用路线图工具时请求绑定，路线图尚未应答时会再次请求；拒绝信息会说明是缺少握手，还是工具来自其他来源。在此范围内，Atlas 可以执行计划需要的所有路线图操作：开始或加入阶段、修订阶段、更改 ADR 和 TODO，以及关闭阶段。
4. 在首次使绑定阶段的计划完成的那次账本写入之后，Prometheus 发送 `atlas:completed {v:1, sessionId, planId, roadmapStage, gates, at}`，附带经过验证的关口结论和摘要。批准时没有绑定阶段的计划，使用执行会话在那一刻绑定的阶段。路线图会为下一回合记录一条待关闭提醒；会话仍需把证据对应到阶段标准，并调用正常的阶段关闭工具。

完成事件只在每个生产者实例内去重。生产者重启后重新打开并再次完成计划，可能会再次发送。路线图在接收会话内按 `planId` 对待关闭条目去重；其他会话可能收到各自的提醒。
