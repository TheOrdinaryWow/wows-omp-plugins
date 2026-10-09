# omo-prometheus 参考

[English](REFERENCE.md) | 简体中文

## 规划交接

只有规划者通过 `ask` 提出的、标题为 `Prometheus` 且第二个选项指名 Prometheus 的那个问题，才算同意把普通 `/plan` 会话切换到 Prometheus。

Prometheus 计划的两个批准选项都会交给 Atlas。“Approve and execute”会开启一个新会话；为了让交接在切换后仍然有效，插件会在提出计划时把一个标记写入 `local://prometheus/<slug>.proposal.json`，OMP 会把它和计划一起复制到新会话。普通 Plan Mode 批准的计划没有这个标记，插件不会处理它们。

## 计划语法

- `## Tasks`：从 `T1` 开始编号的 `- [ ] T<n>. <title>` 行，每行带缩进的 `Agent:`、`Depends on:`、`Acceptance:`，以及可选的 `Tier: LIGHT | HEAVY`（不区分大小写）。缺少 tier 即为 LIGHT，旧计划行为不变。其他取值或重复字段都是解析错误。
- `## Final gates`：恰好 F1–F4，标题固定。
- `Delivery: direct | pr | ship`：在第 0 列的一行普通文本，位于代码块、列表、`## Tasks` 和 `## Final gates` 之外。重复、未知取值，或者出现在上述章节里的 `Delivery:` 行都是解析错误。没有这一行即为 `direct`。

计划只写 T 行和 F 行，D、X 和 P1 行由 Atlas 追加。`delivery` 设置（`ask | direct | pr | ship`，默认 `ask`）以 `<delivery-policy mode=...>` 的形式注入规划者；执行以计划中的 `Delivery:` 行为准。

## Atlas 工具守卫

守卫只放行观察会话或修改宿主自有状态的工具；除 `atlas_git commit` 外，这些工具都不会写入工作区。它不会启用任何工具：会话中本来没有的工具，仍然不可用。

| 工具 | 在 Atlas 父会话中允许 |
| --- | --- |
| `task`、`wait`、`todo`、`ask`、`think`、`web_search`、`atlas_ledger`、`atlas_release` | 始终 |
| `atlas_git` | 始终：`status`、`diff`、`log`、`show`，以及按文件名 `commit`（见下文） |
| `read`、`find`、`glob`、`grep`、`ast_grep` | 始终；`read` 拒绝 `ssh://` |
| `lsp` | 只读操作，以及不带 `apply` 的 `code_actions` |
| `github` | `repo_view`、`file_read`、`search_*`、`run_watch` |
| `debug` | 仅状态检查（`threads`、`stack_trace`、`scopes`、`variables`、`output` 等），不允许 `launch`、`continue` 或断点 |
| `ida` | `list` |
| `recall`、`reflect`、`retain`、`memory_edit`、`learn`、`manage_skill` | 始终：它们写入的是记忆后端和托管技能，不是工作区 |
| `goal`、`context_notes`、`new_context` | 始终 |
| `write` | `agent://` 同伴消息、`proc://<id>/kill`，以及对任何已放行工具的 `xd://` 调用 |

其他工具一律屏蔽，包括 `bash`、`eval`、`edit`、`ast_edit`、文件写入、`security_scan` 以及 `checkpoint`/`rewind`（回退会让会话树分叉，脱离证明已完成行的回执）。其他扩展或 MCP 服务器注册的工具即使与原生工具同名也会被屏蔽，下表列出的除外。

`atlas_git` 是 Atlas 会话唯一的 git 入口，背后没有 shell。Atlas 只在两种情况下用它提交：路线图步骤改动的文件，以及子代理完成后遗漏提交的工作。`commit` 需要给出具体文件和由 Atlas 撰写的提交信息，所以你在 `RULES.md` 里的提交约定同样适用。它只暂存并提交这些文件，拒绝目录和 pathspec 魔法写法，并且在任何绑定的子代理任务仍在运行时拒绝提交。查看类操作不会运行外部 diff 驱动、textconv 过滤器或分页器；提交钩子照常运行，钩子失败时这些文件保持暂存状态。该工具只在 Atlas 执行期间激活，并拒绝执行中的 Atlas 主会话以外的任何调用方。

| 集成 | 放行的工具 |
| --- | --- |
| [Magic Context](https://github.com/cortexkit/magic-context) | `ctx_reduce`、`ctx_expand`、`ctx_search`、`ctx_memory`、`ctx_note`，仅限由扩展注册的；同名 MCP 工具仍被屏蔽 |
| 包装 `todo` 的扩展，例如 [omp-herdr-dag](../omp-herdr-dag/README.zh.md) 支持依赖边的 `todo` | 由扩展重新注册的 `todo`；MCP 提供的 `todo` 仍被屏蔽 |
| [roadmap](../roadmap/README.zh.md) | `roadmap_*`，可直接调用或以 `write xd://roadmap_*` 调用，仅限来自经路线图绑定握手验证过的扩展源路径（见[路线图契约](#路线图契约)） |

## 任务派发

Atlas 父会话的每次 `task` 调用，要么是绑定调用，要么是调研调用：

- **绑定调用**的每个任务恰好带一行 `atlas_assignment`。`{"rows": {...}}` 绑定已开始的 T、D、X、F 或 P1 尝试；`{"verify": {"T3": "…"}}` 绑定一个 HEAVY 行的验证尝试。每个关口和每个验证者都需要单独的子代理，并使用 `atlas_ledger` 给出的 `outputSchema` 和 `schemaMode: "strict"`。实现已记录的行会拒绝再次派发实现。
- **调研调用**不带 `atlas_assignment` 行。每个任务指定的代理必须在当前列表中，且其定义把工具限制在 `read`、`find`、`grep`、`glob`、`ast_grep` 和 `web_search`（外加宿主自动添加的 `yield`）；没有 `tools` 列表的代理会被拒绝。额外的 `tools` 会被拒绝，`metis` 和 `momus` 仍只在规划阶段可用，调研同样需要有效的执行记录。调研子代理在执行记录中没有对应的行，也不能完成任何一行。在同一次调用里混用绑定任务和调研任务会被拒绝。

隔离跟随宿主设置。`task.isolation.enabled` 开启时，每次派发 T、D、X 和 P1 都必须传入 `isolated: true`；关口、验证者和调研子代理可以隔离，也可以不隔离。宿主的 patch 合并会把隔离子代理的改动以未提交状态放进工作区，并丢掉它的提交，所以 `task.isolation.merge` 为 `patch` 时，第一次隔离派发会以运行时覆盖的方式把它切到 `branch`，并提示一次。退出 Atlas、切换到不在执行中的会话、会话关闭时都会恢复原值，已保存的设置不会被改写。

## 代理回退

Prometheus 根据会话 `task` 工具列出的代理制定计划，Momus 也按同一份列表评审。用户自定义代理只有出现在列表中才有效。

派发时先尝试请求的代理，再依次尝试其回退，只选当前列表中的代理：

| 请求的代理 | 回退链 |
| --- | --- |
| `deep-low`、`deep-high`、`ultrabrain`、`architect`、`visual-engineering`、`artistry`、`writing` | `task` |
| `librarian` | `scout` → `task` |
| `metis`、`momus`、`oracle` | `reviewer` → `task` |
| `sonic`、`scout`、`reviewer`、`security-reviewer` | `task` |
| `task` | 无 |

回退只改变代理；各代理的模型角色链见 [omo-toolkit README](../omo-toolkit/README.zh.md#代理)。如果整条链都无法派生，执行记录会显示 `unavailable`，Atlas 在开始该行时从当前列表中挑选最合适的代理（`atlas_ledger start` 带上 `agent`）；只有该列表为空时才会报告阻塞。验证者默认使用 `deep-high`（回退为 `task`）；`atlas_ledger verify` 带上 `agent` 可以改选列表中除 `metis` 和 `momus` 以外的代理。

## 计划匹配

计划参数可以匹配显示名称、原始名称，或去掉 `-plan` 后缀的任一名称；重名时请用完整 ID。名称以子命令单词开头的计划，仍可以通过 ID 或 `/atlas start` 选中。

## 计划包

原生批准会在 `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/` 创建计划包，通常位于 `~/.omp/agent/sessions/<working-dir>/atlas/`。移动会话不会一并移动它的 `atlas/` 目录。

```text
plan.md          exact approved plan
approval.json    source approval, workspace and plan identity
ledger.json      row progress (version 5), plus the workspace's Git HEAD at approval
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of the immutable approval
checkpoint.json  independent attempt and receipt bindings, including verification attempts (version 2)
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

Atlas 持有计划期间，会话的计划引用是 `atlas://<plan-id>/plan.md`，它是批准时 `plan.md` 的只读视图，供子代理加载。其他会话无法读取；如果计划内容发生变化，这个引用就无法再解析。

## 执行记录

执行记录保存每一行的验收标准、依赖、状态、请求的代理与实际使用的代理、tier、尝试和证据回执，以及计划的 SHA-256、交付方式和为最终报告记录的范围外发现。各行按以下顺序排列：

| 行 | 来源 | 等待 |
| --- | --- | --- |
| `T1…` | 已批准的计划 | 各自 `Depends on:` 中的行 |
| `D1…` | 任何关口开始之前的 `discover` scope `in`；每行注明是哪个 T 或 D 行的工作发现了它 | 无 |
| `X1…` | 关口否决后的 `fix` | 无 |
| `F1`–`F4` | 已批准的计划 | 所有 T 行和 D 行，以及各自的 X 行 |
| `P1` | `Delivery: pr` 或 `ship` | 所有关口和所有 X 行 |

Atlas 通过 `atlas_ledger` 驱动执行记录：

| 操作 | 效果 |
| --- | --- |
| `status` | 所有行、范围外发现、交付方式和可派发的行。 |
| `start` | 预留一个前置条件已完成的开放行并返回尝试绑定；关口还会得到 `outputSchema`，HEAVY 行会得到上一次验证失败。 |
| `done` | 记录子代理的真实最终结果。LIGHT 行、关口和 P1 随即完成。HEAVY 行只记录实现，仍保持进行中；其验证者的 `PASS` 完成该行，`FAIL` 带着摘要重新打开该行，`INCONCLUSIVE` 不改变任何状态。 |
| `verify` | 针对实现已记录的 HEAVY 行：绑定一个不同的全新验证者，返回其 `{"verify": …}` 绑定和严格的 `outputSchema`（`rowId`、`planSha256`、`attempt`、`verdict`、`summary`、`evidence`）。再次调用会替换尚未完成的验证者。 |
| `discover` | `scope: "in"` 追加一个 D 行（标题、验收、原因，可选代理和 tier），一旦有关口开始或存在修正行即被拒绝；`scope: "out"` 记录一条不建行的范围外发现，任何时候都可以。 |
| `fix` | 为否决的关口追加一个 X 行（可选 tier），并只重新打开该关口。 |
| `block`、`reopen` | 只影响指定的行；依赖它的已完成行保留各自的证明。 |

只有子代理真实最终结果提供的证明才能把一行标记为完成；失败的、不属于本计划的或仍在运行的子代理，以及手写的引用，都不能完成工作。HEAVY 行还需要一份通过的验证者回执，验证者必须是验证开始之后创建的另一个子代理。验证状态（`pending`、`running`、`passed`、`failed`）由行推导，从不存储。`atlas_release` 要求每一行都有有效回执、HEAVY 行都有验证者回执，并且需要你明确确认。

子代理的输出会被复制到 `evidence/` 并按摘要重新校验，因此删除原会话后，已验证的进度仍然保留。只保存子代理自己的输出（不含它链接的文件），未通过的验证者输出也不归档。某行的证明丢失或被改动时，该行会重新打开，旧的会话分支也无法回滚共享进度。恢复时，HEAVY 行保留已记录的实现，只丢弃尚未完成的验证者绑定。

继续执行的消息是一条隐藏的 `<atlas-continuation>`，其中包含执行记录摘要；你每发一条消息最多发送八次，连续两次没有进展时，循环停止并通知你。

旧版本写入的执行记录会在加载时升级，并保留已验证的进度：版本 5 之前各行均为 LIGHT，发现行和范围外发现为空，交付方式取自计划中的 `Delivery:` 行，没有则为 `direct`；版本 1 的检查点升级到版本 2；版本 4 之前没有记录 Git 基线，所以 F1 以最早记录的行开始时间推定。把执行记录存放在会话内的旧版本计划不会迁移，需要重新批准。`prometheus_ledger` 和 `prometheus_release` 已改名为 `atlas_ledger` 和 `atlas_release`，不保留别名。

`timeline.jsonl` 只用于展示：时间线缺失或损坏都不影响批准、所有权、回执或进度。旧版本的计划包显示从执行记录推导出的历史，推导出的事件从不写回。崩溃导致截断的最后一行，以及未知的未来事件类型或版本都会被忽略。

## 最终关口的输入

F1 读取经哈希校验的 `plan.md`（插件在 F1 开始时打印其路径）、执行记录摘要，以及从计划基线提交以来以只读方式收集的 Git 证据（`git diff --stat`、`git log --oneline`、`git status --short`），无法获取时写明“unavailable”。`momus` 以 `review_kind: compliance` 运行 F1。只有格式匹配的结构化 `PASS` 才算通过。关口子代理只报告、从不修复。

## 所有权

原生子代理工作运行期间，所在会话会一直持有计划，直到该工作报告最终结果；其他会话在此期间无法写入计划。如果持有计划的会话可以证明已经结束，计划可以被恢复；所有权不明确或属于另一个宿主时，拒绝恢复。有些宿主无法可靠地告知子代理是否已结束；这时计划会一直被持有，直到原 OMP 进程退出。调研子代理从不持有所有权。当有活动会话持有计划或仍有原生工作未完成时，拒绝删除该计划。

## 会话集成

- 待办镜像：Atlas 根据校验过的执行记录，按行的顺序维护会话的待办阶段：`Atlas tasks`、存在时的 `Atlas discovered` 和 `Atlas fixes`、`Atlas final gates`，以及计划需要交付时的 `Atlas delivery`。其他阶段保持不变；请不要手动编辑 Atlas 阶段。
- 会话标题：Atlas 请 OMP 的标题生成器生成一个以“Atlas”开头的标题，没有结果时命名为 `Atlas: <plan name>`。用 `/rename` 设置的名称永远不会被替换，`PI_NO_TITLE` 会关闭这一功能。
- 没有 UI 时，裸 `/atlas` 打印计划列表，或打印正在运行的计划及其各行；进入计划失败时，会话保持暂停，直到运行 `/atlas exit`，Atlas 永远不会退化为仅靠提示词的执行。输出以 `wows-omp-omo-prometheus.command-status` 消息送达。在 RPC 中，Atlas 激活时裸 `/atlas` 显示一个摘要，提供 Keep running、View details（只读 `editor` 对话框，显示计划文本）和 Exit；小组件文本行最多每秒发送两次。

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
    "rows": [{ "id": "T1", "title": "…", "status": "open | in_progress | done | blocked",
               "kind": "task | discovered | fix | gate | delivery", "agent": "task", "dependsOn": [], "attempt": "…",
               "startedAt": 0, "evidence": "…", "origin": "F1", "tier": "light | heavy",
               "verification": { "status": "pending | running | passed | failed" },
               "child": { "id": "…", "status": "running", "currentTool": "read" } }],
    "gates": [{ "id": "F1", "title": "…", "status": "done", "evidence": "…" }],
    "discoveries": [{ "id": "D1", "title": "…", "status": "open", "origin": "T2" }],
    "deferred": 1,
    "delivery": "direct | pr | ship"
  }
}
```

`awaiting-approval` 指从提出计划到作出批准选择之间的时段。`atlas` 只在执行时出现；暂停的计划可能只带 `planId` 和 `paused`。状态为 `done` 的关口表示已通过。`tier` 只出现在 T、D、X 行，`verification` 只出现在 HEAVY 行。切换会话和关闭时，正在执行的会话的文件保持原样。

## Herdr DAG 契约

启用 `herdrDag` 时，`omp-herdr-dag` 通过 `pi.events` 观察本会话绑定的 Atlas 计划。所有负载都是带 `v: 1` 的普通 JSON，不会改变 Atlas 计划包的格式。

| 事件 | 方向与负载 |
| --- | --- |
| `herdr-dag:hello` | 查看器发给生产者：`{v:1, sessionId, requestId}`。 |
| `atlas:hello` | 同步回复，保留 `requestId`；有绑定计划时附带其标识（`id`、`name`、`planFilePath`、`cwd`）；未绑定的会话启动或切换时也会主动发送。 |
| `atlas:snapshot` | 在每个带绑定计划的 hello 之后以及每次实时更新时发送：计划标识、执行记录状态和总数、带依赖与来源信息的各行、每行的子代理进度、最近 50 条时间线事件。 |
| `atlas:released` | 解除绑定，`reason` 为 `"exit"`、`"session-switch"` 或 `"shutdown"`，随后发送一个不带计划的 hello。 |

快照中每一行的 `kind` 由 id 推导：`task`（T）、`discovered`（D）、`fix`（X）、`gate`（F）或 `delivery`（P）。`origin` 对 X 行指否决的关口，对 D 行指发现它的行。各行可能带 `tier` 和 `verification: {status}`；验证者的摘要不会发布。HEAVY 行接受验证期间，该行的 `attempt` 是验证尝试。时间线另有 `discovered`、`implemented`、`verify_started`、`verify_passed` 和 `verify_failed`。

启动顺序无关紧要。不支持的版本和未知会话会被忽略。某行完成后，最后已知的子代理进度仍然可见，开始新的尝试时清除。释放只表示计划不再显示在视图中。`herdrDag: false` 时不发送任何事件，包括 hello 回复。

## 路线图契约

安装了 `roadmap` 时，Prometheus 使用一个独立于 `herdrDag` 的 `pi.events` 契约：

1. 提出计划时，发送 `roadmap:binding-request {v:1, sessionId, requestId}`，只接受与该会话和请求匹配的同步 `roadmap:binding` 回复，其中包含 `repoRoot`、`toolSourcePath` 以及可选的已绑定活动阶段。
2. 新的计划包写入版本 2 的批准文件，带可选的 `roadmapStage: {repoRoot, id}`；版本 1 的批准仍可恢复，不会改写，也不要求重新批准。
3. 只有当 `roadmap_*` 工具的扩展源路径与 `toolSourcePath` 一致时，Atlas 才会放行；拒绝信息会说明是缺少握手，还是工具来自其他来源。在此范围内，计划需要的所有路线图操作都允许。
4. 在首次使绑定阶段的计划完成的那次执行记录写入之后，Prometheus 发送 `atlas:completed {v:1, sessionId, planId, roadmapStage, gates, delivery?, at}`，附带经过验证的关口结论和摘要。只有所有行都完成，计划才算完成：`Delivery: pr` 或 `ship` 时，事件在 P1 行之后发送，并带上 `delivery: {mode, summary}`；`direct` 时事件在关口之后发送。批准时没有绑定阶段的计划，使用执行会话在那一刻绑定的阶段。路线图会记录一条待关闭提醒，阶段仍由会话自己关闭。

完成事件只在每个生产者实例内去重，所以重启后重新打开并再次完成计划，可能会再次发送。路线图在每个接收会话内按 `planId` 对待关闭条目去重。
