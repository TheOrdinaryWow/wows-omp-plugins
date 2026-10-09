# roadmap 参考

[English](REFERENCE.md) | 简体中文

## 上下文注入

轮次处于活动状态时，插件每个回合都会读取检出的文档，把有长度上限的状态注入主会话和子代理的上下文，其中包括计划轮次的简要摘要（ID、标题、目标日期和阶段数）。阶段列表最多 12 个，其余的提示用 `roadmap_status` 查看。没有活动轮次时不注入任何内容，自由工作照常进行；`roadmap_status` 仍会列出计划轮次。在已初始化的仓库中，ADR 工具和编辑保护始终可用。

重叠问题的回答按阶段和会话保存并复用。如果阶段已经绑定到当前会话，会直接以路线图内工作返回其交接内容，不弹对话框，也不记自由工作，即使在 headless 模式下也是如此。子代理永远不会被询问。

## 工具

会修改内容的工具使用写入审批；`roadmap_status` 使用读取审批。

| 工具 | 输入或操作 |
| --- | --- |
| `roadmap_status` | 不带参数时返回轮次、目标日期、实际日期、逾期标记、阶段，以及按目标或触发条件分组的未关闭 TODO；带 `stage` 时返回该阶段的完整信息和交接内容。 |
| `roadmap_stage` | `add`、`edit`、`amend`、`start`、`close`、`drop`、`renumber`。`add` 接受可选的 `round` 和 `target`；`edit` 和 `amend` 也接受 `target`。 |
| `roadmap_todo` | `add`、`update`、`resolve`、`move`。 |
| `roadmap_adr` | `create`、`revise`、`set_status`、`supersede`、`note`。 |
| `roadmap_check` | 可选 `fix: true`。只检查文档，不检查代码与文档是否一致。 |
| `roadmap_overlap` | `stage` 和 `intent`。 |
| `roadmap_init` | `project`、`round`、初始的 `adrs` 和 `stages`；需要 `/init-project` 授权和已确认的预览。 |
| `roadmap_round_plan` | `round` 章程、用于修订计划轮次的可选 `id`、可选的 `target`；需要 `/roadmap plan-round [id]` 授权和已确认的预览。 |
| `roadmap_round_open` | `import_todos` ID，以及可选的 `round` 章程或 `activate` 轮次 ID；需要 `/roadmap new-round` 授权和已确认的预览。存在计划轮次时，激活编号最小的那个。 |

授权来自用户明确运行命令、使主会话进入就绪状态。一次成功的写入会用掉授权；取消或无法获得回答都不构成写入授权。

### 阶段操作

| 操作 | 规则 |
| --- | --- |
| `add` | 在活动轮次中，或在 `round` 指定的活动或计划轮次中创建计划阶段。需提供 `title`、`objective`、`scope_in`、`scope_out`，以及带 `statement` 和 `verify` 的 `done_criteria` 条目；`target`、依赖和设计约束可选。依赖只能位于同一轮或更早的轮次。 |
| `edit` | 替换计划阶段中提供的字段，包括 `target`。阶段激活后请改用 `amend`。 |
| `amend` | 向活动阶段追加一条带日期的变更，必须写明 `reason`。`amendments` 可以新增、修改或删除标准，以及增删范围内/范围外条目；`target` 记录日期变化。 |
| `start` | 要求阶段属于活动轮次、依赖已关闭且没有检查错误；激活并绑定阶段，返回规划交接内容。对已处于活动状态的阶段，则加入而不修改文档。 |
| `close` | 接受 `id`、`delivered` 摘要、可选的 `deviations`，以及下文所述的 `evidence`、`todos` 和 `adrs`。记录 Outcome 和关闭哈希，并冻结阶段。 |
| `drop` | 放弃计划中或活动的阶段，必须写明 `reason`；需先解决或移走所有指向它的未关闭 TODO。 |
| `renumber` | 用 `new_id` 为计划阶段重新编号，并改写可变的引用。如果已关闭的历史中有需要修改的引用，则拒绝。 |

关闭阶段的输入：

- `evidence`：每条当前标准一项，包含 `criterion`、`result: "pass"`、实际使用的 `method` 和 `summary`；`commit` 可选。证据缺失或未通过时拒绝关闭。
- `todos`：每个指向该阶段的未关闭 TODO，要么带 `reference` 标为 `resolved`，要么 `moved` 到另一个有效目标（移动后仍保持未关闭）。触发条件可以写成目标 `trigger: <text>`。
- `adrs`：每个与该阶段关联的提议中 ADR 都要 `accepted` 或 `rejected`。子代理无法做这些决定，所以必须先由主会话处理，子代理才能关闭阶段。

交接内容包括目标、范围、完成标准、指向该阶段的 TODO、引用的 ADR、自由工作日志和关闭指引。

### TODO 操作

`add` 需要 `title`、`source`、`severity`，以及 `target` 或 `trigger` 之一；`body` 可选。目标可以是活动轮次或计划轮次中任何未关闭的阶段。新条目存放在活动轮次的 TODO 文档中，即使它指向计划轮次。没有活动轮次时，新条目必须指向计划轮次的阶段，并存放在该轮次的文档中。计划轮次的文档只能包含指向其自身阶段的条目，或带触发条件的条目。

`update` 修改活动或计划轮次中未关闭条目的指定字段。`resolve` 需要 `reference`。`move` 替换目标或触发条件，拒绝已关闭或已放弃的目标阶段。把条目从计划轮次的文档移到另一个轮次时，旧条目标记为 `moved` 并指向目标文档中的一个新 TODO ID；新条目保留请求的目标，并在 `carried_from` 中记录旧 ID 和来源轮次。移到另一个计划轮次时，即使存在活动轮次，也会直接写入那个轮次的文档。

### ADR 操作

`create` 需要 `title`，以及包含 `context`、非空 `options` 和 `outcome` 的 `sections`。可选章节有 `drivers`、`consequences`、`confirmation`、`pros_cons` 和 `more_info`；也支持参与者列表和阶段关联。随附的 MADR 4.0 模板有 Confirmation 章节，没有实现清单。

`revise` 替换提议中 ADR 的整个正文，保留其元数据，也可以修改标题。已接受的 ADR 不能通过 `revise` 改写。主会话可以用 `set_status` 设为 `accepted`、`rejected` 或 `deprecated`，或者用一个新接受的继任者 `supersede` 已接受或已弃用的 ADR，并建立双向链接。`note` 在 More Information 下追加带日期的 `text`。子代理无论请求什么最终状态，创建的都是提议中的 ADR，也不能设置状态或取代 ADR。

如果已有 ADR 以未闭合的代码围栏结尾，`note` 会拒绝且不做任何修改。请在编辑器中修复已存储的文件，或把新注释改成允许的语法子集，然后重试；工具从不为修复而改写已接受的正文。

## 工具写入文本中的 Markdown

工具写入的正文支持普通段落、每项只有一行文本的扁平无序或有序列表，以及完整闭合的顶层代码围栏。无序列表标记为 `-`、`+` 或 `*`；有序列表标记为一到九位数字后跟 `.` 或 `)`，标记后接一个空格。不支持嵌套列表和缩进的列表续行。

允许普通标点，包括 `~20%`、`snake_case`、`quantity * unit price`、含下划线或波浪号的 URL，以及 `x < y` 或 `x > y`。紧跟 ASCII 字母、`/`、`!` 或 `?` 的 `<` 会被拒绝，因为它可能开始一段 HTML、自动链接、注释或处理指令。`>` 不能出现在行首。

允许行内强调符号，成对的符号可能会渲染为格式。代码之外不支持方括号、反斜杠转义和表格竖线。允许同一行内的行内代码；每段起始反引号必须在同一行用等长的反引号闭合。跨行的代码段无法掩盖另一行中的 HTML 或围栏。不支持的字面语法请放进代码里，或使用 `&lt;script&gt;` 这样的实体。

代码围栏至少使用三个反引号或波浪号，前面可有零到三个空格。可选的信息字符串是一个由 ASCII 字母、数字、`_`、`+`、`.` 或 `-` 组成的语言标记。闭合行使用相同的标记，长度不短于开始行，前面零到三个空格，后面只能有空格或制表符，且没有信息字符串。围栏内容按字面处理。

围栏不能在列表或引用内开始。列表之后，可以使用不缩进的围栏，或者先空一行并写一个不缩进的段落，再使用缩进的围栏；TODO 正文前的元数据列表之后同样适用。列表之后的段落需要空一行；不支持惰性续行。

在围栏和代码段之外，工具会拒绝原始 HTML 和注释、Markdown 链接和引用定义、ATX 和 Setext 标题、块引用、表格、分隔线、缩进代码、制表符、格式错误或未闭合的围栏，以及有歧义的结构，并在修改任何托管内容之前返回修复提示。

范围条目、标准描述、验证方法这类单行字段遵循相同的标点和行内规则，但不能包含列表或围栏。工具会重新解析渲染后的文档，检查 ID、元数据、正文边界和固定标题是否完好。

## 轮次关闭与顺延

关闭轮次时，指向计划轮次阶段的未关闭 TODO 会被自动顺延到那些轮次的 TODO 文档中。它们保留相同的 ID 和目标；目标文档记录 `carried_from`，冻结的来源条目变为 `carried` 并引用目标轮次。这些条目不会出现在处理对话框中，也不能再通过 `import_todos` 导入。

同一个 ID 可以继续顺延到更后面的轮次（`R1 → R2 → R3`）。`check` 会校验每一跳：恰好有一处不是 `carried`；其余每处都是 `carried`，引用下一轮，并与该条目的 `carried_from` 一致。其他重复 ID 均为错误。

关闭对话框只授权关闭打开对话框前审阅过的那个轮次和文件快照；从状态菜单进入时，快照在菜单出现时获取。如果在菜单或对话框等待期间该轮次被关闭、另一轮被开启，或者它的任何文件发生变化，关闭会因过期而被拒绝，不写入任何内容。

`/roadmap new-round` 可以从冻结的轮次中导入选定的、以触发条件顺延的 TODO ID。导入的条目获得新 ID，保留来源，并以触发条件开始；原来的目标阶段不会带过来，旧轮次保持不变。只要还有计划轮次，就不能跳过编号最小的计划轮次，也不能新建全新的轮次。

如果其他轮次中的阶段依赖某个计划轮次的阶段，`/roadmap drop-round` 也会拒绝。

## 编辑保护

初始化之后，一个工具调用钩子会在主会话和子代理会话中保护 `docs/roadmap/**` 和 `docs/adr/**`。它会找到目标所在的 git 工作树，检查字面路径和解析后的路径（包括悬空符号链接的目标），并在阻止编辑时提示改用路线图工具。对于已存在的目标文件，它会把设备号和 inode 与会话及目标工作树中具有多个链接的托管文件比较，因此原生 `write` 和 `edit` 无法通过硬链接别名修改托管文件，无论别名在仓库内外。原生路径遵循宿主的规范化规则，包括以 `@` 开头的绝对路径、多余的 `:` 前缀、`~` 路径和 `file://` URL。

没有初始化标记的仓库不受影响。钩子中出现校验、路径解析或文件识别错误时，会拒绝调用。

| 工具 | 覆盖范围 |
| --- | --- |
| `write` | 它的 `path`，包括从读取输出中复制的 `[path#TAG]` 头和已存在的硬链接别名。 |
| `edit`、`apply_patch` | 每次原生 `edit` 调用都会按 `hashline`、`replace`、`patch`、`apply_patch` 和 `sloppy` 语法解析目标；`apply_patch` 使用自己的语法。任何托管的源或目标，以及已存在的硬链接别名，都会被阻止。未知的语法或模式会被拒绝。 |
| `ast_edit` | `paths` 先经过原生的范围辅助处理（去除空白、去掉外层双引号、展开分隔的条目、规范化反斜杠），再解析目录或 glob。无效的范围会被拒绝。覆盖范围包括工作树之外、包含其托管根目录的目录，以及第一个 glob 段所在的目录：`docs/roadm*/**/*.ts` 解析为 `docs`；`/work/re*/docs/roadmap/*.ts` 解析为 `/work`，当仓库位于其下时会被阻止。 |
| `lsp` | 通过 `file` 指定文件的 `rename` 和已应用的 `code_actions`；`rename_file` 同时检查 `file` 和 `new_name`。符号重命名中的 `new_name` 是标识符而不是路径。跨文件工作区编辑中的各个文件不会逐一检查。 |
| `bash` | 尽力而为的静态检测，覆盖重定向（`>`、`>>`）、`tee`、`mv`、`cp`、`rm`、原地 `sed` 和 `truncate` 之后的路径参数。 |

钩子不拦截 `eval`、`ctx_execute*`、从 bash 启动的编辑器，或其他会写文件的程序。Shell 变量、命令替换和间接写入可以绕过 bash 匹配；宽泛的目录或 glob 也可能被保守地阻止。硬链接检查只覆盖已存在且被明确指名的目标，不会枚举藏在无关目录或 glob 中的别名，也无法预料之后某条 shell 语句才创建的链接。

自己编辑正文时，请保留 front matter、托管注释、固定标题和自动生成区块的分隔符。`check` 会把已存储的不支持的 HTML、引用定义、Setext 和分隔线行、引用、容器内围栏和有歧义的缩进报告为无法自动修复的结构错误，并给出修复提示。定位固定标题时会屏蔽已闭合的顶层围栏；未闭合的围栏属于结构错误。

哈希检查能发现已关闭阶段和冻结轮次的改动。只要保留了关闭哈希，就会校验它，即使状态已被修改；状态与保留的关闭元数据矛盾也算错误。修复和修改操作都会拒绝这类完整性错误；请用 git 恢复历史。

## 恢复与工作树

写入时获取一把仓库锁，并逐个原子替换文件。多文件操作不是事务：如果中断，可能留下各自完整的文件，但生成的索引已过期，或者操作只完成了一部分。取消操作会在下一次临时写入或重命名前停止，并删除尚未提交的临时文件；已写入的文件保留。被取消的操作会列出这些文件并给出恢复指引，且不会绑定阶段、用掉预览授权或保存重叠回答。

1. 运行 `/roadmap check` 或 `roadmap_check`。
2. 对于过期的生成区块，运行 `/roadmap check --fix` 或带 `fix: true` 的 `roadmap_check`。它不会修复手写内容、重新计算关闭哈希，也不会修改冻结的轮次。
3. 其他损坏用 git 恢复，然后再检查一次。

按项目规则提交这些文档。每个分支上检出的 Markdown 就是事实来源。工作树之间只共享 git 公共目录下 `roadmap/` 中的锁和带版本的 ID 计数器；分配 ID 时会同时高于已存储的计数器和磁盘上已有的 ID。

## 没有 UI 时

暂存预览的令牌只覆盖所显示的文件，在会话重建（启动、切换、分支、树导航）或被同类新预览替换之前有效；其他任何回复都视为拒绝。`roadmap_overlap` 会报告没有回答，并提示使用 `/roadmap overlap`。不带参数的 `/roadmap close-round` 会列出仍需处理的未关闭 TODO。通知和错误会显示为会话消息。

## 状态快照

主会话会用共享的快照外层结构发布 `roadmap.json`（见[仓库参考文档](../../REFERENCE.zh.md)）。`state` 是根据磁盘文件得出的 `roadmap/status` 负载，版本 1；仓库没有初始化路线图时为 `null`。计划轮次和日期字段是后来新增的，版本号没有改变。

该文件会在会话启动、切换、分支和树导航时，每次 `roadmap_*` 工具调用和 `/roadmap` 命令之后，以及每个代理回合开始时重写，因此也能反映子代理和外部编辑带来的变化。

| 字段 | 内容 |
| --- | --- |
| `kind`、`version` | `"roadmap/status"`、`1` |
| `format` | 仓库标记格式，`1` 或 `2`。 |
| `repoRoot` | 路线图所在的 git 工作树根目录。 |
| `project` | 来自 `docs/roadmap/README.md` 的项目标题。 |
| `activeRound` | `{ id, title, target, opened, overdue }`，或 `null`；日期为字符串或 `null`。 |
| `plannedRounds` | 按 ID 排序的 `{ id, title, target, overdue, stageCount, openTodos }`；`stageCount` 不含已放弃的阶段，`openTodos` 统计存放在该轮次文档中或指向其阶段的未关闭条目，包括存放在活动轮次文档中的条目。 |
| `stages` | 每个阶段的 `{ id, title, status, round, target, started, closed, overdue }`。 |
| `openTodos` | `{ total, byStage, untargeted }`：所有轮次中未关闭的 TODO 总数、按目标阶段的计数，以及使用触发条件而非目标的数量。 |
| `boundStage` | 本会话绑定且仍处于活动状态的阶段，否则为 `null`。 |

只有计划中或活动的工作、且其目标日期早于当天的 UTC 日期时，`overdue` 才为 true。

## Prometheus 契约

事件定义见 [omo-prometheus 参考文档](../omo-prometheus/REFERENCE.zh.md#路线图契约)。在路线图这一侧：

- 路线图会同步回复 `roadmap:binding-request`，附带会话、请求、仓库、受信任的工具来源和可选的已绑定活动阶段。即使无法读取已绑定阶段的文档，它也会回复，只是不带阶段。没有回复表示未安装路线图。
- Atlas 只放行来源为扩展、且源路径与握手一致的 `roadmap_*` 工具；其他扩展或 MCP 服务器提供的同名工具不会被放行。
- 收到 `atlas:completed` 时，路线图为执行会话保存一条待关闭条目，并在阶段仍处于活动状态时于下一回合加入提醒。会话会收到 `Plan <id> completed for <stage>` 以及可作为证据的关口结果。既没有提案时绑定、也没有执行会话绑定的计划，不会关联到任何阶段。
- 待关闭条目在接收会话内按 `planId` 去重。

## 目录格式

以下是 `src/documents.ts` 中 `HOW_THIS_DIRECTORY_WORKS_V2` 的原文。确认升级到格式 2 后，它会被写入项目的 `docs/roadmap/README.md`，该文件同时是初始化标记和自动生成的索引。在采用格式 2 之前，初始化写入的是格式 1 的版本。

> This directory records structured build rounds, their stages and carry-over TODOs. ADRs in docs/adr/ record decisions and outlive rounds. Plans describe implementation steps and do not live here.
>
> The root README is the initialization marker and rounds index. Each NN-slug round directory contains its charter README, TODO.md and stages/NN-slug.md. Rounds use R1, R2 and so on in creation order and are never renumbered; stages use S01, TODOs T001 and ADRs ADR-0001. Stage and TODO numbers are global across rounds, monotonic and never reused. ADR files use NNNN-slug.md. Slugs contain lowercase ASCII letters, digits and hyphens.
>
> This README carries roadmap: { format: 2 }, the repository format; roadmap plugin 0.2.3 and earlier cannot read a format 2 repository. Every managed file has format: 1 or format: 2 front matter and a managed-by comment naming the same format. Format 1 files keep their bytes until a write needs a format 2 field: a target date, or a planned or dropped round. Front matter and fixed headings are structure. Tool-owned bodies allow plain paragraphs, flat text lists and closed top-level fences, with ordinary punctuation, plain URLs, inline emphasis and same-line code spans; structural Markdown, Markdown links and raw HTML syntax are refused. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages, Known limitations and, for a dropped round, Outcome. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.
>
> Agents change managed files through roadmap_* tools. Body text can be edited by a user in an editor; malformed structure must be repaired before tools can write. Generated blocks are marked with `<!-- roadmap:generated:<name> -->` and `<!-- /roadmap:generated -->`. The tools own numbering, metadata, headings and generated indexes.
>
> Rounds are planned, active, closed or dropped. A planned round is drafted ahead with its charter, planned stages and TODOs; only the lowest-numbered planned round can be activated, and an unneeded planned round is dropped together with its planned stages. Stages are planned, active, closed or dropped; only stages of the active round start. A stage depends only on stages in its own or an earlier round. Closed stages never reopen; corrective work uses a new stage with follows. Dependencies must be closed before a stage starts. Done criteria state what must pass and how to verify it; closing records evidence, TODO dispositions and ADR dispositions. Open TODOs need severity, source and either an unclosed target stage in the active or a planned round, or a trigger. A planned round's TODO.md holds only TODOs for its own stages or with a trigger. When a round closes, its open TODOs that target a planned round's stage continue in that round's TODO.md with the same ID and a Carried from line, and the original is marked carried to that round. Rounds and stages may carry an optional target date; status views compare it with the actual dates and flag unfinished work past its target. Charter principles cite ADRs rather than restating decisions. Accepted ADRs change through status transitions, supersession and dated append-only notes.
>
> Same-ID carry-over may continue through multiple later rounds: every earlier occurrence is carried to the next round with matching Carried from metadata, and only one occurrence is not carried. These continuations cannot be imported again with import_todos. Moving a TODO out of a planned round to another round leaves a moved record naming a fresh ID; the destination keeps the target and records Carried from with the original ID and round.
>
> Closed stages carry closed_sha256; closed and dropped rounds carry frozen_sha256 and remain read-only history. There is at most one active round. With none active, free work is unrestricted and roadmap context is not injected; ADR management remains available.
>
> Writes use one repository lock and per-file atomic replacement. An interrupted multi-file operation can leave stale indexes: run roadmap_check or /roadmap check, then check --fix to regenerate generated blocks. Fix never changes authored bodies, a closed round or a dropped round. Restore other damage with git. The shared git common directory stores only the lock and versioned id counters; the checked-out Markdown is the source of truth on each branch.
>
> Check verifies document consistency. It cannot determine whether code implements the documents. Close evidence and boundary checks help keep them aligned.
