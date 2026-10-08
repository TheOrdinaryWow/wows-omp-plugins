# omo-prometheus

[English](README.md) | 简体中文

将 [oh-my-openagent (OmO)](https://github.com/code-yeongyu/oh-my-openagent) 的 Prometheus 规划工作流和 Atlas 执行模型移植到 OMP。这是基于 OmO 修改而来的适配版本，并非独立重新实现。

它保留 OMP 原生的 Plan Mode 和批准流程，并增加：

- Metis：在规划开始前检查意图与缺漏。
- Prometheus：只询问可能改变计划的问题，持续澄清，直到能够写出计划。
- 可选的 Momus 和 Oracle 计划审查：查找引用、可执行性、QA 和任务格式中的阻塞问题。也可以就架构和高风险决策咨询 Oracle。
- Atlas：在批准后接管执行，将每项计划任务委派给子代理，跨会话保留进度与已验证的证据，并在宣布计划完成前运行四项最终验证关卡。

`/prometheus` 与经用户同意启用该工作流的原生 `/plan` 共享规划流程。`/atlas` 控制执行，也可以在另一个会话中继续已批准的计划。

## 安装

```bash
omp plugin marketplace add TheOrdinaryWow/wows-omp-plugins
omp plugin install omo-prometheus@wows-omp-plugins
```

安装后请重启 OMP，以加载扩展和代理。

## 从 `prometheus` 迁移

运行 `omp plugin uninstall prometheus@wows-omp-plugins`，然后安装 `omo-prometheus@wows-omp-plugins`。旧插件的会话状态不会继承，迁移后请开始一个新计划。

## 用法

### 规划

```text
/prometheus
```

此命令进入 OMP 原生的 Plan Mode，或升级已经处于 Plan Mode 的会话。在下一条消息中描述需求，也可以直接输入 `/prometheus <request>`。规划期间再次运行 `/prometheus` 会同时退出 Prometheus 和 Plan Mode。

Prometheus 要求在 OMP 设置中启用 Plan Mode（`plan.enabled`，默认开启）。如果关闭了该设置，`/prometheus` 会报错并拒绝进入，不改变任何状态；开启 Plan Mode 后再运行即可。Atlas 和 `/atlas` 不依赖此设置。

计划写入 `local://` 会话产物，并通过 `xd://propose` 提交。如果开启了 OMP 计划自动保存，获批副本也会保存到 `.omp/plans/` 下。

在普通 `/plan` 模式中，小型且明确的需求仍走 OMP 的常规流程。对于大型、涉及多个领域或含糊的目标，规划代理会通过 `ask` 提议使用 Prometheus：问题标题为 `Prometheus`，第二个选项明确提到 Prometheus。只有这一特定问题的回答才算作同意。接受后，会切换到同一套共享工作流。

### 执行

批准后，主会话变为 Atlas。对于该计划，执行提示会覆盖 OMP 的委派偏好，扩展也会阻止父会话直接使用实现工具，因此所有工作都通过 `task` 交给子代理。`/prometheus` 不会退出 Atlas；请使用 `/atlas exit`。

工具守卫只允许观察会话或修改宿主管理状态的工具，这些工具都不会写入工作区。此表不会启用任何工具：会话中缺失的工具（例如未配置记忆后端时的记忆工具）仍然不可用。

| 工具 | Atlas 父会话中的允许范围 |
| --- | --- |
| `task`、`wait`、`todo`、`ask`、`think`、`web_search`、`atlas_ledger`、`atlas_release` | 始终允许 |
| `read`、`find`、`glob`、`grep`、`ast_grep` | 始终允许；`read` 拒绝 `ssh://` |
| `lsp` | 只读操作，以及不带 `apply` 的 `code_actions` |
| `github` | `repo_view`、`file_read`、`search_*`、`run_watch` |
| `debug` | 仅允许检查状态（`threads`、`stack_trace`、`scopes`、`variables`、`output`、…），不允许 `launch`、`continue` 或断点操作 |
| `ida` | `list` |
| `recall`、`reflect`、`retain`、`memory_edit`、`learn`、`manage_skill` | 始终允许：它们写入记忆后端和受管理的技能，不写工作区 |
| `goal`、`context_notes`、`new_context` | 始终允许 |
| `write` | `agent://` 代理间消息、`proc://<id>/kill`，以及通过 `xd://` 调用任何已获准的工具 |
| `hub` | 观察类操作和向代理执行 `send`，不允许向进程发送输入 |

其他操作全部被阻止，包括 `bash`、`eval`、`edit`、`ast_edit`、文件写入、`security_scan` 和 `checkpoint`/`rewind`。Rewind 会使会话树转到一个不再包含任务回执的分支，而这些回执正是已完成账本行的证明。其他扩展或 MCP 服务器注册的工具也会被阻止，即使它们与原生工具同名，除非列在下方的第三方集成中。

#### 第三方集成

| 集成 | 获准工具 |
| --- | --- |
| [Magic Context](https://github.com/cortexkit/magic-context)（一个扩展，并非 OMP 的组成部分） | `ctx_reduce`、`ctx_expand`、`ctx_search`、`ctx_memory`、`ctx_note`，仅限由扩展注册的工具；同名 MCP 工具仍被阻止 |
| `todo` 的扩展包装器，例如 [omp-herdr-dag](../omp-herdr-dag/README.zh.md) 支持依赖边的 `todo` | 由扩展重新注册的 `todo`；MCP `todo` 仍被阻止 |
| [roadmap](../roadmap/README.zh.md) | `roadmap_*`，可直接调用，也可通过 `write xd://roadmap_*` 设备调用；仅限来自同步 roadmap 绑定握手所验证的扩展源路径；其他扩展或 MCP 服务器提供的同名工具仍被阻止 |

Prometheus 计划的两种批准选项都会交接给 Atlas。“Approve and execute” 会开启一个新会话。为了在切换后保留交接信息，插件在提交计划时将标记写入 `local://prometheus/<slug>.proposal.json`，OMP 会将它与计划一起复制到新会话。普通 Plan Mode 中批准的计划没有该标记，插件不会干预。

### 使用 `/atlas` 调度

```text
/atlas                          # while inactive: open Atlas Dispatch, the interactive plan menu
/atlas <plan-name-or-id>        # while inactive: enter a plan in this session and start executing (name/ID completion available)
/atlas start <plan-name-or-id>  # same as above
/atlas list                     # while inactive: list approved plans with their status
/atlas show <plan-name-or-id>   # while inactive: show a plan's rows, acceptance and evidence
/atlas resume <plan-name-or-id> # while inactive: resume a started plan
/atlas rename <id> <new name>   # while inactive: change a plan's display label
/atlas delete <id> [--yes]      # while inactive: delete a plan and its evidence; --yes is required without dialogs
/atlas                          # while active: open the running plan's view (read-only)
/atlas exit                     # while active: exit (asks first if the plan is unfinished)
```

开头的 `list`、`show`、`start`、`resume`、`rename`、`delete` 或 `exit` 一律按子命令解析。名称以这些词开头的计划需通过 ID 或 `/atlas start <name>` 选择。

Atlas Dispatch 是将 Prometheus 计划交给 Atlas 的菜单。打开时，它显示当前工作区中未完成的计划。Tab 切换到 All，额外显示已完成、无效及其他工作区的计划。All 仅供查看，只有在 Unfinished 视图中才能开始或恢复执行。菜单显示各计划的进度，以及当前选中计划的 T/F 行。

| 按键 | 操作 |
| --- | --- |
| 输入文字 | 按名称、ID 或状态进行模糊搜索 |
| Enter | 启动选中的计划，并立即开始执行 |
| Space, Shift+I | 打开全屏计划视图 |
| Shift+R | 在此前执行过该计划的会话中恢复计划 |
| Backspace | 编辑搜索内容；搜索为空时删除选中的计划 |
| Delete | 删除选中的计划 |
| Shift+N | 重命名（只修改显示标签；已批准的计划不变） |
| Esc | 关闭 |

一个计划同一时间只能在一个会话中运行，因此 Enter 和 Shift+R 会拒绝由另一个存活会话持有的计划。

Enter 启动计划。如果当前会话为空，Atlas 就在这里进入该计划。否则会提示选择新会话、当前会话或取消。随后 Atlas 会自行发送第一条执行消息，与原生计划批准后启动工作的方式相同，因此你无需再输入内容。已启动的计划可以在另一个会话中再次启动，共享进度和证据会一并保留。

Shift+R 恢复已经启动过的计划。插件扫描此项目的会话文件，寻找执行过该计划的会话。只有一个匹配会话时直接切换；有多个时会列出它们，最近使用的排在前面。恢复后的会话处于 Atlas 模式，但不会自行继续执行；准备好后发送一条消息即可。规划期间不能恢复。

Space 或 Shift+I 打开全屏计划视图，进度变化时它会保留选中行和滚动位置。Tab 在选中行的详情与按最新事件优先排列的时间线之间切换；旧计划包推导出的事件会带有标记。Space 可查看归档的子代理输出。Up/Down 选择行，PgUp/PgDn 滚动，Enter 和 Shift+R 与列表中一样用于启动或恢复，Esc 返回列表。

删除操作会请求确认，并永久删除计划及其证据。当存活会话持有计划或原生工作尚未结束时，不能删除。没有交互式 UI 时，不带参数的 `/atlas` 会输出计划列表。

可以使用显示标签、原始名称，或去掉 `-plan` 后缀的任一名称来选择计划，因此 `checkout` 和 `checkout-plan` 会匹配同一计划。如果多个计划同名，请使用列表中的完整 ID。

Atlas 激活时，不带参数的 `/atlas` 会打开全屏查看器，实时显示只读信息。已提交的账本变更、子代理生命周期和宿主进度会自动更新，无需重新打开。页头显示正在运行的子代理和计划已用时间，侧栏显示各进行中行的已用时间。宿主提供进度信息时，Live 区域会显示子代理身份、模型/思考级别、工具及参数、意图、用量、费用、重试次数和近期活动。

Tab 切换到持久化的时间线。此时不能启动、恢复、删除或重命名。Shift+X 与 `/atlas exit` 一样退出 Atlas，Esc 关闭页面。宿主没有进度通道时，账本和生命周期详情仍然可用。

没有交互式 UI 时，不带参数的 `/atlas` 会输出当前运行的计划及其各行。如果还有未完成行或无法验证进度，退出前会先询问。`/atlas` 携带任何其他参数都会报错，即使参数指向当前计划也一样：先退出，再从同一会话进入其他计划。Atlas 不会在规划期间进入，也不会运行未经批准的计划。如果进入失败，会话会保持暂停，直到你运行 `/atlas exit`；Atlas 绝不会退回到仅靠提示词约束的执行方式。

执行期间，编辑器上方的 Atlas 小组件显示计划进度条、已完成/总数及关卡数量、正在运行的子代理，以及各行的精简实时用量。使用普通编辑器时它仍然可见，退出、切换会话或关闭宿主后消失。可以通过 `atlasWidget` 禁用；`/atlas` 观察页面仍然可用。

Atlas 还会根据经过验证的账本维护会话待办阶段：任务、修正任务（如有）和最终关卡。现有的非 Atlas 阶段保持不变。附加计划及账本变更后会恢复 Atlas 阶段，请不要手动编辑。每次改变行状态的 `atlas_ledger` 结果都会给出一个可重复执行的 `todo` 调用，用于刷新宿主 HUD。退出 Atlas 不会清除待办列表。

会话 A 可以完成计划的一部分后退出，会话 B 再通过 `/atlas <name>` 接手，前提是两者使用相同的宿主会话目录和工作区。退出立即生效，不会取消子代理或将工作标记为完成，也不会阻止关闭宿主。

原生子代理工作仍在运行时，所属会话继续持有计划，直到该工作报告最终结果。在此期间，其他会话无法写入计划。持有计划的会话若已被证实终止，可以恢复其计划；所有权不明确或由其他宿主持有时，恢复会被拒绝。

部分宿主无法向 Atlas 提供可靠信号，证明子代理的最终处理已经结束；被取消的唤醒调用也可能先于子代理返回。在这些情况下，计划会一直由原会话持有，直到原 OMP 进程退出；关闭该进程后再启动新会话。

Atlas 持有计划时，会话的计划引用为 `atlas://<plan-id>/plan.md`，这是已批准 `plan.md` 的只读视图，子代理通过 OMP 的计划交接机制加载它。其他会话无法读取；如果计划内容的字节发生变化，该引用将无法继续解析。

### 宿主模式

| 宿主 | `/atlas` 的行为 |
| --- | --- |
| TUI | Atlas Dispatch 菜单、全屏计划视图和编辑器上方的小组件，如上所述。 |
| RPC（`--mode rpc`、rpc-ui） | Atlas Dispatch 改为一系列 `select` 对话框：先选择计划（标签附带状态；切换项可显示全部计划，此时仅供查看），再选择 Start、Resume、View details、Rename、Delete 或 Back。View details 在只读 `editor` 对话框中显示计划文本。拒绝规则与 TUI 菜单相同。Atlas 激活时，不带参数的 `/atlas` 显示摘要，并提供 Keep running、View details 和 Exit。小组件以文本行发送（进度条、已完成/总数、运行中的子代理、当前行），每秒最多两次。 |
| ACP 编辑器 | 与 RPC 相同的对话框，通过表单征询实现。不显示小组件。 |
| SDK、`--no-ui`、print | 没有对话框。使用上面的子命令；输出以 `wows-omp-omo-prometheus.command-status` 消息显示。删除需要 `--yes`。只有当前会话是唯一执行过该计划的会话时，`/atlas resume` 才会恢复；需要选择会话时，它列出候选会话并停止，请打开对应会话后在其中恢复。 |

Prometheus 规划本身依赖原生计划模式及其交互式批准，因此只在 TUI、RPC 和 ACP 中运行；`prometheus_activate` 和 `atlas_release` 的确认使用普通的 `select`/`confirm` 对话框。

### 客户端状态文件

主会话按共享插件状态格式（见[仓库 README](../../README.zh.md)）写出 `omo-prometheus.json`。既没有规划也没有 Atlas 激活时，`state` 为 `null`；否则为：

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

`awaiting-approval` 表示 Prometheus 已提交计划、尚未做出原生批准选择。`atlas` 只在执行时出现；其中的进度字段与 Herdr DAG 契约使用同一实时账本观察，观察加载后才出现；暂停的计划可能只有 `planId` 和 `paused`。状态为 `done` 的关卡表示已通过。切换会话或关闭宿主不会改动执行中会话的文件，因为该计划仍可在那里恢复。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-omo-prometheus`。

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | 控制提交计划前的审查。 |
| `atlasWidget` | 布尔值 | `true` | 此会话执行 Atlas 时，在编辑器上方显示实时进度小组件。 |
| `herdrDag` | 布尔值 | `true` | 为 Herdr DAG 查看器发布带版本的 Atlas 事件契约；设为 false 会禁用所有契约事件，包括 hello 回复。 |

- `ask`：Momus 审查每个计划。当你要求高准确度，或工作较复杂且不明确时，Momus 和 Oracle 联合审查；对于明确的工作，会提供一次选择机会。
- `standard`：Momus 审查每个计划，不主动提供高准确度选项，但明确请求仍会加入 Oracle。
- `high-accuracy`：始终由 Momus 和 Oracle 审查，不提供选择。
- `off`：不进行 Momus 或 Oracle 计划审查，即使明确请求也不会启用。Metis 仍会检查规划缺漏，Atlas 仍会在批准后运行 F1 合规关卡。

用户设置会与项目覆盖配置合并。插件启动时读取会话当前工作目录对应的设置，因此修改后请重启会话。

## Herdr DAG 契约

启用 `herdrDag` 后，`omp-herdr-dag` 可以通过 `pi.events` 观察本会话绑定的 Atlas 计划。事件生产方会同步回复 `herdr-dag:hello {v:1, sessionId, requestId}`，发出 `atlas:hello`，保留 `requestId`，并在存在绑定计划时附带该计划。绑定计划的 hello 后会立即跟随 `atlas:snapshot`；启动顺序不影响结果。不支持的版本及生产方未知的会话会被忽略。

绑定时会发出 `atlas:hello` 和 `atlas:snapshot`。实时更新发布计划身份、账本状态和统计、带有依赖及修正来源元数据的 T/X/F 行、各行子代理进度，以及最近 50 条时间线事件。行完成后仍显示最后已知进度，但新一轮尝试开始时会清除。载荷是普通 JSON，使用 `v:1`；这不会改变 Atlas 计划包格式。

启用的生产方还会在未绑定计划的会话启动或切换后，发布不包含计划的可用性通知，因此先启动的查看器无需重试最初的握手。

解除绑定时会发出 `atlas:released`，其原因是 `reason: "exit"`、`"session-switch"` 或 `"shutdown"`，随后发出不包含计划的 hello。释放只是让计划与视图解除绑定；此时执行可能尚未结束，子代理也可能仍在运行。设置 `herdrDag: false` 后不发出任何契约事件，包括 hello 回复；账本、待办镜像、所有权和 UI 行为保持不变。生产方不需要查看器，也不增加运行时依赖。

## Roadmap 契约

安装 [roadmap](../roadmap/README.zh.md) 后，Prometheus 使用独立于 `herdrDag` 的带版本 `pi.events` 契约。提交计划时，它发出 `roadmap:binding-request {v:1, sessionId, requestId}`，仅接受与该会话和请求匹配的同步 `roadmap:binding` 回复。回复包含 `repoRoot`、`toolSourcePath` 和可选的已绑定活跃阶段。

新的 Atlas 计划包写入版本 2 的批准记录，可包含 `roadmapStage: {repoRoot, id}`。版本 1 的批准记录仍可恢复，无需重写其字节或重新批准。无论直接调用还是通过 `write xd://roadmap_*` 调用，Atlas 仅允许来自扩展的 `roadmap_*` 工具，来源路径必须与握手中的 `toolSourcePath` 完全一致。工具守卫在首次调用 roadmap 工具时请求该绑定，roadmap 尚未应答时会再次请求；拒绝提示会说明是握手缺失，还是工具来自其他来源。在此范围内，Atlas 可以执行计划所需的全部 roadmap 动作：开始或加入阶段、修订阶段、变更 ADR 和 TODO，以及关闭阶段。

当某次账本写入首次使绑定阶段的计划达到完成状态后，Prometheus 发出 `atlas:completed {v:1, sessionId, planId, roadmapStage, gates, at}`，附带已验证的关卡结论与摘要。批准时没有绑定阶段的计划，改用执行会话此时绑定的阶段，例如 Atlas 在执行期间开始的阶段。Roadmap 为执行会话的下一轮记录一个待关闭提醒。会话仍须将这些证据对应到阶段验收条件并加以验证，然后携带 TODO/ADR 处置结果调用常规阶段关闭工具；计划完成不会自动关闭阶段。可以检查计划包 `approval.json` 中的 `roadmapStage`，确认提案时是否已绑定阶段。

完成事件只按生产方实例去重，因此无法提供持久化的恰好一次投递。生产方重启后，如果计划重新打开并再次完成，可能再次发出事件。Roadmap 在同一接收会话保留的状态中按 `planId` 对待关闭条目去重；其他会话可能收到各自的提醒。

## 计划格式

每个 Prometheus 计划都以两个机器可读的章节结尾。任务是从 `T1` 开始编号、不缩进的复选框行，每项包含缩进的 `Agent:`、`Depends on:` 和 `Acceptance:` 行：

```markdown
## Tasks
- [ ] T1. Add the parser
  - Agent: task
  - Depends on: none
  - Acceptance: the new unit test passes and the CLI prints the parsed value
- [ ] T2. Update the command help text for the new flag
  - Agent: sonic
  - Depends on: T1
  - Acceptance: CLI help lists the new flag

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
```

Prometheus 根据会话中 `task` 工具实际列出的代理制定计划，该列表已应用启动策略和禁用代理设置。Momus 也根据同一列表审查。每个 `Agent:` 行应指定列表中最适合任务的专业代理；已安装的 omo-toolkit 代理优先于通用的 `task` 或 `sonic`。

用户自定义代理只有出现在列表中才有效，未列出的名称需要具备已知回退代理。如果无法解析工具描述，仍可使用已知名称规划并按原样保留，但无法检查用户自定义名称。

调度时先尝试请求的代理，再按顺序尝试其回退代理，只选择实时列表中的代理：

| 请求的代理 | 回退链 |
| --- | --- |
| `deep-low`、`deep-high`、`ultrabrain`、`architect`、`visual-engineering`、`artistry`、`writing` | `task` |
| `librarian` | `scout` → `task` |
| `metis`、`momus`、`oracle` | `reviewer` → `task` |
| `sonic`、`scout`、`reviewer`、`security-reviewer` | `task` |
| `task` | 无 |

回退只更换代理。各代理的模型角色链记录在 [omo-toolkit README](../omo-toolkit/README.zh.md#代理) 中。如果某条链中没有任何代理能够启动（例如计划批准后，其中引用的用户自定义代理被删除），账本会显示 `unavailable`，Atlas 会在启动该行时从实时列表中选出最合适的代理（`atlas_ledger start` 并传入 `agent`）。该选择会一直绑定在这一行上，直到请求的代理或其回退代理重新可用；更换代理不需要重新批准计划。只有实时列表为空时，Atlas 才会报告阻塞原因。

## 执行账本

原生批准会在 `ctx.sessionManager.getSessionDir()/atlas/<plan-name>--<id>/` 创建计划包。通常是 `~/.omp/agent/sessions/<working-dir>/atlas/`，位于仓库和 `local://` 之外；自定义会话目录也受支持。

```text
plan.md          exact approved plan
approval.json    source approval, workspace, and plan identity
ledger.json      task and gate progress, plus the workspace's Git HEAD at approval
timeline.jsonl   append-only observation events (not execution proof)
label.json       optional display name, independent of immutable approval
checkpoint.json independent attempt and receipt bindings
evidence/        copied native outputs and origin receipts
ownership/       exclusive execution ownership records
```

账本跟踪每个 T 和 F 行的验收条件、依赖、状态、请求及实际使用的代理、尝试次数、证据回执和计划 SHA-256，也记录最终关卡要求的 X 修正行。依赖图会预先验证，因此存在环的计划不会先执行一部分。勾选计划文件中的复选框不算作进度。

Atlas 通过 `atlas_ledger`（`status`、`start`、`done`、`block`、`reopen`、`fix`）推进账本。只有具备子代理真实最终结果的证明，行才能被标记为完成；失败、来源不符或仍在运行的子代理，以及手写引用，都不能作为完成证明。阻塞或重新打开某行仅影响该行：依赖它的已完成工作保留原有证明，由最终关卡评判最终结果。`atlas_release` 要求每行都有有效回执，并且得到你的明确确认。

如果账本或计划产物缺失、损坏或不再匹配已批准计划，Atlas 会暂停，且不重建任何内容。请恢复已批准的产物，或通过 `/atlas` 退出，再让修改后的计划重新获批。

Atlas 停止时若仍有未完成行，插件会用包含账本摘要的隐藏 `<atlas-continuation>` 消息让它继续。OMP 每个用户轮次最多允许八次连续执行。连续两次没有进展时会停止循环并通知你；可通过 `/atlas` 退出或发送新指令。你发送的任何消息都会重置计数。

进度保存在共享计划包中。子代理输出会复制到 `evidence/`，并重新核对摘要值，因此即使删除原会话，已验证进度仍然保留。`atlas_ledger status` 显示这些输出的位置。只保留子代理自身的输出；仅在输出中链接的文件不会复制。如果某行的证明缺失或发生变化，该行会重新打开；旧会话分支无法回滚共享进度。

更新插件后，现有计划仍可运行。早期版本写入的账本会在加载时升级，保留已验证进度，无需重新批准。版本 4 之前的账本没有记录 Git 基线，F1 会以最早记录的行启动时间推导基线，并在证据中注明。

`timeline.jsonl` 记录附加与释放、行启动、完成、阻塞及重新打开、修正行和关卡结论。它仅用于显示：时间线缺失或损坏绝不会使批准、所有权、回执或进度失效。早期版本的计划包会根据账本展示推导历史，直到追加真实时间线事件；推导事件不会写回。因崩溃截断的最后一行及未知的未来事件版本会被忽略。

更早版本插件运行的计划将账本保存在会话内。这些计划不会迁移：恢复时会暂停并要求重新批准。旧工具 `prometheus_ledger` 和 `prometheus_release` 现已改为 `atlas_ledger` 和 `atlas_release`，不保留别名。

## 最终关卡

所有 T 行完成后，Atlas 将 F1 到 F4 同时交给四个独立且新启动的验证子代理。它们都没有参与实现，此前也没有做过审查。

| 关卡 | 代理 | 回退代理 | 检查内容 |
| --- | --- | --- | --- |
| F1. 计划合规审查 | `momus`（`review_kind: compliance`） | `reviewer` | 根据账本摘要和 F1 启动时插件以只读方式收集的 Git 证据（自计划基线提交以来的 `git diff --stat`、`git log --oneline`、`git status --short`，或明确说明“不可用”），检查实际变更是否符合已批准计划 |
| F2. 代码质量审查 | `deep-high` | `task` | 可维护性、范围、测试价值及有证据支持的阻塞问题 |
| F3. 真实界面 QA | `deep-low` | `task` | 在真实界面或环境上执行计划 Verification 章节中的每个场景，记录命令和实际观察结果 |
| F4. 成功标准忠实性 | `deep-high` | `task` | 逐一核查每项明确列出的成功标准和对抗性场景，并关联证据 |

每个关卡返回严格的结构化结论（`PASS`、`FAIL` 或 `INCONCLUSIVE`），附带摘要和证据。只有匹配的结构化 `PASS` 才算通过；正文中出现表示通过的词不算。

某个关卡拒绝通过时，Atlas 将每项修正记录为 X 行（`atlas_ledger fix`），像普通任务一样调度，然后仅重跑拒绝通过的关卡。已完成的 T 行和已经通过的关卡不会重新打开。

## 模型

Metis、Oracle 和 Momus 作为子代理运行，使用 OMP 的 `@slow` 角色，该角色通过你的 OMP 模型配置解析。插件不会硬编码任何提供商或模型。

批准后，Atlas 在主会话中运行。插件注册一个 `atlas` 模型角色，在 `/model` 中显示为 Atlas，可以像其他角色一样为其指定模型。它不参与 Ctrl+P 轮换。

Prometheus 提案等待批准时，`atlas` 会临时加入 `cycleOrder` 最前面。批准滑块因此会在 `smol`、`default` 和 `slow` 旁边提供它，Ctrl+P 仍会跳过它。滑块从 `default` 开始；移到 `atlas` 即可使用该角色执行。插件会在下一次输入、代理轮次或规划结束时恢复 `cycleOrder`。普通 Plan Mode 批准不会显示 `atlas`，没有可用模型的角色也不会出现在滑块上。

如果已为 `atlas` 角色指定模型，`/atlas <plan>` 会切换到该角色，否则保留当前模型。如果无法解析指定模型，Atlas 仍会启动，并报告已保留当前模型。

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

## 兼容性

需要 OMP 18.3.5 或更高版本。`xd://propose` 的批准和自动保存仍由 OMP 负责。规划草稿和交接标记保存在 `local://`，已批准计划保存在共享 Atlas 计划包中。插件不会在项目内创建 `.omo` 状态，子代理通过 OMP 原生执行机制运行。

共享执行要求会话以文件形式存储在支持硬链接、原子重命名及文件和目录同步的本地文件系统上。对于内存存储、纯远程存储或其他不支持的存储，Atlas 会拒绝运行。使用不同会话目录的会话无法看到彼此的计划；移动会话也不会移动其 `atlas/` 目录。

## 许可证

Prometheus、Metis、Oracle、Momus 和 Atlas 提示词资源是基于 OmO 修改的衍生作品；`NOTICE` 记录了上游仓库、固定版本、早期分叉历史和修改声明。

扩展代码和原创打包内容采用 MIT 许可证（`LICENSE-MIT`）。`agents/`、`assets/` 和 `skills/prometheus/` 下的衍生提示词资源仍遵循上游 Sustainable Use License 1.0（`LICENSE-SUL-1.0`），允许内部商业使用、个人及非商业使用，仅允许非商业目的的免费分发。
