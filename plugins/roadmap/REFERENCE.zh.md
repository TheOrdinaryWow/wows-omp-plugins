# roadmap 参考

[English](REFERENCE.md) | 简体中文

## 上下文注入

轮次处于活动状态时，插件每个回合都会读取检出的文档，把有长度上限的状态注入主会话和子代理的上下文，其中包括一行就绪情况（活动轮次中现在就能开始的计划阶段，以及其余阶段在等待的未关闭依赖）和计划轮次的简要摘要（ID、标题、目标日期和阶段数）。阶段列表最多 12 个，其余的提示用 `roadmap_status` 查看。没有活动轮次时不注入任何内容，自由工作照常进行；`roadmap_status` 仍会列出计划轮次。在已初始化的仓库中，ADR 工具和编辑保护始终可用。

路线图需要本地 Git 仓库（任何 `git init` 得到的工作树都可以，不需要远程仓库）。在 Git 仓库之外，所有命令和工具都会拒绝。

重叠问题的回答按阶段和会话保存并复用。如果阶段已经绑定到当前会话，会直接以路线图内工作返回其交接内容，不弹对话框，也不记自由工作，即使在 headless 模式下也是如此。子代理永远不会被询问。

## 工具

会修改内容的工具使用写入审批；`roadmap_status` 使用读取审批。

| 工具 | 输入或操作 |
| --- | --- |
| `roadmap_status` | 不带参数时返回轮次、目标日期、实际日期、逾期标记、阶段及其依赖、活动轮次中计划阶段的就绪情况、未关闭阶段的 Atlas 计划（omo-prometheus 有回复时），以及按目标或触发条件分组的未关闭 TODO；带 `stage` 时返回该阶段的完整信息和交接内容。 |
| `roadmap_stage` | `add`、`edit`、`amend`、`revise_amendment`、`delete_amendment`、`revise_free_work`、`delete_free_work`、`start`、`close`、`drop`、`move`、`renumber`。`add` 接受可选的 `round` 和 `target`；`move` 必须提供 `id` 和目标 `round`，不需要命令授权。`edit`、`amend` 和 `revise_amendment` 也接受 `target`。`start` 和 `close` 会向 omo-prometheus 查询该阶段的 Atlas 计划。 |
| `roadmap_todo` | `add`、`update`、`resolve`、`move`。 |
| `roadmap_check` | 可选 `fix: true`。只检查文档，不检查代码与文档是否一致。它会列出全部警告；写操作的回执只列出这次写入新产生的警告。 |
| `roadmap_overlap` | `stage` 和 `intent`。 |
| `roadmap_init` | `project`、`round`、初始的 `adrs` 和 `stages`；需要 `/init-project` 授权和已确认的预览。初始 ADR 通过 adr 插件创建（见[通过 adr 插件管理的 ADR](#通过-adr-插件管理的-adr)）。 |
| `roadmap_round_plan` | `round` 章程、用于修订活动或计划轮次的可选 `id`、可选的 `target`；需要 `/roadmap plan-round [id]` 授权和已确认的预览。直接替换标题、目标、约束、非目标和原则，不追加修订日志或重命名目录；已关闭、已放弃的轮次拒绝修订。只修订活动轮次章程保留格式 1；创建计划轮次或添加目标日期时，在预览中升级为格式 2。 |
| `roadmap_round_open` | `import_todos` ID，以及可选的 `round` 章程或 `activate` 轮次 ID；需要 `/roadmap new-round` 授权和已确认的预览。存在计划轮次时，激活编号最小的那个。 |
| `roadmap_upgrade` | 无参数，仅限主会话。在格式 1 的仓库中打开一步式“是/否”对话框：选“是”写入与 `/roadmap upgrade` 相同的变更（只改 `docs/roadmap/README.md`），选“否”报告保留格式 1 且不写入，没有回答也不写入。格式 2 的仓库会报告已经升级。没有对话框或在子代理中时，它会拒绝并提示 `/roadmap upgrade`。这条手动路径不会提交变更。 |

授权来自用户明确运行命令、使主会话进入就绪状态。一次成功的写入会用掉授权；取消或无法获得回答都不构成写入授权。

### 阶段操作

| 操作 | 规则 |
| --- | --- |
| `add` | 在活动轮次中，或在 `round` 指定的活动或计划轮次中创建计划阶段。需提供 `title`、`objective`、`scope_in`、`scope_out`，以及带 `statement` 和 `verify` 的 `done_criteria` 条目；`target`、依赖和设计约束可选。依赖只能位于同一轮或更早的轮次。 |
| `edit` | 替换计划阶段中提供的字段，包括 `target`。阶段激活后请改用 `amend`。 |
| `amend` | 向活动阶段追加一条带日期的变更，必须写明 `reason`，并返回从零开始的修订索引。`amendments` 可以新增、修改或删除标准，以及增删范围内/范围外条目；`target` 记录日期变化。新日志会保留旧验证方法和条目位置，供撤销使用。 |
| `revise_amendment`、`delete_amendment` | 接受阶段 `id` 和从零开始的修订 `index`。只有最新且影响可明确撤销的未提交修订可以修改；修改会先撤销原修订，再应用替换的 `reason`、`amendments` 和可选 `target`。删除会撤销其影响，没有其他改动时恢复追加前规范格式的阶段字节。缺少撤销信息的旧条目以及与后续编辑冲突的条目会被拒绝。 |
| `revise_free_work`、`delete_free_work` | 接受未关闭阶段的 `id` 和从零开始的自由工作 `index`。修改接受与 `roadmap_overlap` 相同形状的替换 `intent`，保留原日期和会话。追加操作会返回索引。 |
| `start` | 要求阶段属于活动轮次、依赖已关闭且没有检查错误；激活并绑定阶段，返回规划交接内容。对已处于活动状态的阶段，则加入而不修改文档。 |
| `close` | 接受 `id`、`delivered` 摘要、可选的 `deviations`，以及下文所述的 `evidence` 和 `todos`。与该阶段关联的 ADR 仍处于提议状态时拒绝。记录 Outcome（在 `### ADRs` 下包含关联 ADR 的状态）和关闭哈希，并冻结阶段。关联的 Atlas 计划尚未完成时不会阻止关闭：回执会给出警告，并在 Outcome 的 Deviations 文本后追加一行，列出这些计划（名称、计划 ID、声明的标准）。 |
| `drop` | 放弃计划中或活动的阶段，必须写明 `reason`；需先解决或移走所有指向它的未关闭 TODO。 |
| `move` | 用 `id` 和目标 `round` 移动一个计划阶段，可在活动、计划轮次之间双向移动。同轮移动、活动或终态阶段、已关闭或已放弃的轮次均拒绝。保留 ID、文件名和 ADR 关联，迁移阶段文件，重建两个轮次的阶段表和根状态块。若自身依赖，或其他未放弃阶段的 `depends_on`、`follows` 因移动而指向较晚轮次，则拒绝并列出冲突 ID；应先移动后续阶段或修改依赖。只有留在计划轮次文档中会变得无效的未关闭 TODO 才迁移：旧条目标记为 `moved` 并引用目标文档中的新 ID，新条目保留目标，以 `carried_from` 记录旧 ID 和轮次。成功后清除调用会话对该阶段的绑定。 |
| `renumber` | 用 `new_id` 为计划阶段重新编号，并改写可变的引用，包括通过 adr 插件改写 ADR 的阶段关联。如果已关闭的历史中有需要修改的引用，则拒绝。 |

是否提交按 `HEAD` 中解析出的阶段条目判断，对相同标题和正文采用多重集匹配，重复条目按数量计算。仓库尚无提交，或文件在 `HEAD` 中不存在时，所有条目均视为未提交。其他位置的修改不会解锁已提交条目；此时会拒绝并提示追加新条目。索引越界时不写入。每次成功修改都执行与追加相同的验证和索引重新生成，并列出需要提交的文件；不引入缓冲或自动提交。

关闭阶段的输入：

- `evidence`：每条当前标准一项，包含 `criterion`、`result: "pass"`、实际使用的 `method` 和 `summary`；`commit` 可选。证据缺失或未通过时拒绝关闭。
- `todos`：每个指向该阶段的未关闭 TODO，要么带 `reference` 标为 `resolved`，要么 `moved` 到另一个有效目标（移动后仍保持未关闭）。触发条件可以写成目标 `trigger: <text>`。
- ADR：关闭时通过 adr 插件读取与该阶段关联的 ADR。只要其中有 `proposed` 的，关闭就会拒绝并列出它们；需先由主会话用 `adr_manage` 接受或拒绝，子代理无法做这些决定。ADR 文件无法解析时关闭也会拒绝，因为其中可能藏有提议中的关联。

交接内容包括本轮章程（完整的目标、约束、非目标），该阶段的目标、范围和完成标准，omo-prometheus 有回复时该阶段的 Atlas 计划，设计约束、风险、修订记录，直接前置阶段（`depends_on` 和 `follows`：ID、标题、状态和阶段文档；对已关闭的前置阶段，附上其 Outcome 中 Delivered 和 Deviations 的文本，各截断到约 800 个字符），指向该阶段的 TODO、引用的 ADR、自由工作日志和关闭指引。

### 一个阶段的多个计划

一个阶段可以由多个 Atlas 计划共同交付。每个计划用一行 `Roadmap criteria:` 声明自己负责的标准，由 Prometheus 在批准前检查。路线图本身不保存计划记录；它在生成交接内容、`roadmap_status`、关闭提醒或关闭阶段时，用 `atlas:plans-request` 向 omo-prometheus 查询。交接内容中的 Plans for this stage 一节会列出每个计划的状态、进度以及是否声明了覆盖范围，然后逐条列出当前标准：由已完成的计划覆盖、仅由未完成的计划覆盖，或无人覆盖。如果计划记录的规划基准修订号与阶段当前的不同，就标记为漂移：计划获批之后，目标、范围、完成标准或设计约束发生了变化。漂移只是提示。没有 omo-prometheus 时省略这一节。

就绪情况在每次读取时推导，从不保存：活动轮次中的计划阶段在所有依赖都已关闭时可以开始，否则被未关闭的依赖 ID 阻塞。其他阶段既不可开始，也不算被阻塞。

### TODO 操作

`add` 需要 `title`、`source`、`severity`，以及 `target` 或 `trigger` 之一；`body` 可选。目标可以是活动轮次或计划轮次中任何未关闭的阶段。新条目存放在活动轮次的 TODO 文档中，即使它指向计划轮次。没有活动轮次时，新条目必须指向计划轮次的阶段，并存放在该轮次的文档中。计划轮次的文档只能包含指向其自身阶段的条目，或带触发条件的条目。

`update` 修改活动或计划轮次中未关闭条目的指定字段。`resolve` 需要 `reference`。`move` 替换目标或触发条件，拒绝已关闭或已放弃的目标阶段。把条目从计划轮次的文档移到另一个轮次时，旧条目标记为 `moved` 并指向目标文档中的一个新 TODO ID；新条目保留请求的目标，并在 `carried_from` 中记录旧 ID 和来源轮次。移到另一个计划轮次时，即使存在活动轮次，也会直接写入那个轮次的文档。

### 通过 adr 插件管理的 ADR

ADR 归 [adr 插件](../adr/README.zh.md)（`adr_status`、`adr_manage`、`adr_check`、`/adr`）管理；路线图从不解析或写入 `docs/adr/`。它在会话开始时并在之后按需为自己的会话请求 adr 服务（`adr:binding-request` v1，见 adr 插件 REFERENCE 的“Service contract”），并注册一个接受仓库路线图中任意阶段的阶段解析器，使 `adr_manage` 能把 ADR 关联到阶段。会话关闭和重建时会注销该解析器。如果仓库有路线图，而回合开始时仍无法绑定该服务，这一回合注入的只是一行 `[Roadmap status]`，写明原因和安装提示；主会话还会在每个会话中用同样的原因和提示通知用户一次。

- 轮次原则（`/init-project`、`/roadmap plan-round`、`/roadmap new-round`）必须引用 adr 插件报告的 ADR。ADR 文件无法读取或 `docs/adr/` 未初始化时会拒绝并给出指引。
- `/init-project` 用 adr 插件 `createMany` 的试运行预览初始 ADR（`docs/adr/` 不存在或为空时一并初始化，已受管理时追加），在同一预览中展示 ADR 文件，确认后先创建它们，再写入任何路线图文件。初始 ADR 的 `id` 是别名，原则和阶段文本可以引用；它不能与已有 ADR 的 ID 相同。初始 ADR 的 `stage` 指向初始阶段的别名。
- `renumber` 在写完路线图文件后改写 ADR 的阶段关联。两次写入不是一个事务：如果改写关联失败，拒绝信息会列出已提交的路线图文件和仍关联旧 ID 的 ADR；请用 git 恢复 `docs/roadmap/` 和 `docs/adr/` 后重新编号。
- `<git common dir>/roadmap/counters.json` 中的 ADR 计数键保持原样；路线图不再分配 ADR ID。

写入 `docs/roadmap/README.md` 的目录说明（格式 1 和 2）仍写着 ADR 通过路线图工具修改；那是逐字节保留的已存储文本。ADR 由 adr 插件管理。

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

关闭轮次时会在该轮的 `## Outcome` 中记录目标结果：`### Assessment`（`achieved`、`partial`、`not_achieved` 或 `cancelled`）和 `### Summary`。格式 2 的仓库没有它就拒绝关闭；格式 1 的仓库拒绝记录结果，因为只有格式 2 的轮次文件才能包含这一节。关闭对话框会询问评估和总结；在格式 1 中会先提供一步完成的升级（选“是”则升级并记录结果，跳过则不记录结果直接关闭）。升级属于关闭本身的写入，并经过相同的结果、TODO 和过期校验，因此关闭被拒绝时不写入任何内容，仓库仍是格式 1。只有记录了结果时，正在关闭的轮次文件才会变为格式 2。更早关闭或放弃的轮次保持原有字节和冻结哈希。

同一个 ID 可以继续顺延到更后面的轮次（`R1 → R2 → R3`）。`check` 会校验每一跳：恰好有一处不是 `carried`；其余每处都是 `carried`，引用下一轮，并与该条目的 `carried_from` 一致。其他重复 ID 均为错误。

关闭对话框只授权关闭打开对话框前审阅过的那个轮次和文件快照；从状态菜单或控制台进入时，快照在它出现时获取，控制台每次重新打开都会重新获取。如果在菜单、控制台或对话框等待期间该轮次被关闭、另一轮被开启，或者它的任何文件发生变化，关闭会因过期而被拒绝，不写入任何内容。

`/roadmap new-round` 可以从冻结的轮次中导入选定的、以触发条件顺延的 TODO ID。导入的条目获得新 ID，保留来源，并以触发条件开始；原来的目标阶段不会带过来，旧轮次保持不变。只要还有计划轮次，就不能跳过编号最小的计划轮次，也不能新建全新的轮次。

如果其他轮次中的阶段依赖某个计划轮次的阶段，`/roadmap drop-round` 也会拒绝。

## 编辑保护

初始化之后，一个工具调用钩子会在主会话和子代理会话中保护 `docs/roadmap/**`，无论 adr 插件是否加载；`docs/adr/**` 由 adr 插件保护。钩子会找到目标所在的 git 工作树，检查字面路径和解析后的路径（包括悬空符号链接的目标），并在阻止编辑时提示改用路线图工具。对于已存在的目标文件，它会把设备号和 inode 与会话及目标工作树中具有多个链接的托管文件比较，因此原生 `write` 和 `edit` 无法通过硬链接别名修改托管文件，无论别名在仓库内还是仓库外。

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

## 不使用终端界面时

| 宿主 | 行为 |
| --- | --- |
| RPC（`--mode rpc`、`rpc-ui`）和 ACP | 无论 `uiMenu` 怎么设，都使用内联选择菜单和对话框，以 `select`、`input` 和 `editor` 请求发送。ACP 客户端可能只把通知写进日志。 |
| 无 UI（`--no-ui`、print、JSON、SDK） | 没有对话框。不带参数的 `/roadmap` 输出状态和用法。预览只返回令牌，不写入任何内容；用 `/roadmap confirm <token>` 确认。重叠问题用 `/roadmap overlap` 回答，关闭轮次用 `/roadmap close-round` 的参数回答，包括目标结果。 |
| Tern | 控制台和写入预览以原生面板打开。点击标签切换分区，点击一行选中，双击执行与 Enter 相同的操作。面板下方的按钮执行与按键相同的操作（Shift+O 对应 Order 按钮），按键仍然可用。roadmap 工具调用显示为原生卡片：状态以表格显示，检查诊断按严重度分组，阶段只显示要点（轮次、日程、完成标准、未关闭的 TODO 和引用的 ADR，给出数量和编号），不再展示整份规划交接。展开卡片后，模型收到的原文放在默认折叠、已格式化的 “Model text” 区块里。命令消息只显示结果摘要，完整文本仍通过隐藏消息发给模型。roadmap 消息带有可读的标题，比如 “Roadmap check”。 |

暂存预览的令牌只覆盖所显示的文件，在会话重建（启动、切换、分支、树导航）或被同类新预览替换之前有效；其他任何回复都视为拒绝。暂存的预览只保存在内存里，进程退出后就会丢失。`roadmap_overlap` 会报告没有回答，并提示使用 `/roadmap overlap`。不带参数的 `/roadmap close-round` 会列出仍需处理的未关闭 TODO，在格式 2 中还要求提供 `outcome=<assessment>:<summary>`。自动升级格式 2 在无 UI 时也会运行；`roadmap_upgrade` 需要对话框，否则会提示 `/roadmap upgrade`。通知和错误会显示为会话消息。

### 控制台细节

- `uiMenu: inline` 使用早期版本的选择菜单。设置在每次使用时读取；无法识别的值会回退到 `fullscreen`，并在日志中警告。
- 阶段列表默认显示活跃轮次，直到你从另一个轮次跳转到它的阶段。
- 检查、关闭轮次、放弃轮次、修改目标日期或升级之后，完整结果也会写进聊天。关闭阶段、开启轮次以及规划或修改轮次会关闭控制台；关闭阶段时会有一条通知告诉你该让代理做什么。简短的回答，比如日期、放弃原因或关闭轮次的问题，仍使用小对话框。
- `stageOrder: dependency` 时，同时就绪的阶段保持 ID 顺序。这个设置作用于控制台、内联菜单、`/roadmap` 补全、`roadmap_status` 和每轮注入给代理的上下文；Shift+O 只在本次会话剩余时间内切换。
- 没有 adr 插件时，`/roadmap`、`/init-project` 和所有 `roadmap_*` 工具都会拒绝并给出安装提示，而对 `docs/roadmap/` 的编辑仍被阻止。插件附带 `roadmap` 技能。
- Plan Mode 下代理不能提交，所以在那里启动阶段只会绑定会话并返回交接内容；阶段保持 planned，文件不变。计划批准、开始实现时，阶段才真正启动并提交其文件。配合 omo-prometheus 时，Atlas 会在派发任何任务之前完成这一步，完成之前拒绝派发（见 [Prometheus 契约](#prometheus-契约) 中的 `activation`）；对于在 Plan Mode 之外启动但无人提交的阶段，它也会补上提交。

## 自动升级格式 2

每次进入会话（`session_start` 和 `session_switch`）时，如果已初始化的格式 1 仓库的索引能正常解析，且 `docs/roadmap/` 下没有暂存、未暂存或未跟踪的改动，主会话就会自动升级。升级在宿主的会话启动处理程序返回后运行，不会在分支或树导航时运行，也不会在子代理中运行。仓库必须已有 HEAD 提交，且路线图 README 已被跟踪；无需 adr 插件。不满足条件时，插件不写入、不通知，下次进入会话时再试。

升级只修改 `docs/roadmap/README.md`，并用 `chore(roadmap): upgrade roadmap to format 2` 提交该文件。按路径提交保证其他已暂存的改动不会混入提交，且仍留在暂存区。用户的 Git hook 会照常运行，提交最多等待 30 秒。提交失败时，README 会恢复为原始字节，并简短提示可以运行 `/roadmap upgrade`。成功后会显示短提交 SHA，并刷新路线图状态。

现有文件保持格式 1，直到某次写入需要格式 2 的字段；已关闭的历史不会被改写。自动升级跳过时，可运行 `/roadmap upgrade`。第一次 `/roadmap plan-round` 的预览、关闭轮次的对话框和 `roadmap_upgrade` 也仍提供手动升级选项。这些路径仍需确认，不会自动提交升级。

## 状态快照

主会话会用共享的快照外层结构发布 `roadmap.json`（见[仓库参考文档](../../REFERENCE.zh.md)）。`state` 是根据磁盘文件得出的 `roadmap/status` 负载，版本 1；仓库没有初始化路线图时为 `null`。计划轮次、日期和就绪字段是后来新增的，版本号没有改变。

该文件会在会话启动、切换、分支和树导航时，每次 `roadmap_*` 工具调用和 `/roadmap` 命令之后，以及每个代理回合开始时重写，因此也能反映子代理和外部编辑带来的变化。

| 字段 | 内容 |
| --- | --- |
| `kind`、`version` | `"roadmap/status"`、`1` |
| `format` | 仓库标记格式，`1` 或 `2`。 |
| `repoRoot` | 路线图所在的 git 工作树根目录。 |
| `project` | 来自 `docs/roadmap/README.md` 的项目标题。 |
| `activeRound` | `{ id, title, target, opened, overdue }`，或 `null`；日期为字符串或 `null`。 |
| `plannedRounds` | 按 ID 排序的 `{ id, title, target, overdue, stageCount, openTodos }`；`stageCount` 不含已放弃的阶段，`openTodos` 统计存放在该轮次文档中或指向其阶段的未关闭条目，包括存放在活动轮次文档中的条目。 |
| `stages` | 每个阶段的 `{ id, title, status, round, target, started, closed, overdue, dependsOn, blockedBy, startable }`。`dependsOn` 列出其 `depends_on` ID；`startable` 和 `blockedBy` 是上文推导的就绪情况（不属于活动轮次计划阶段时为 `false` 和 `[]`）。 |
| `openTodos` | `{ total, byStage, untargeted }`：所有轮次中未关闭的 TODO 总数、按目标阶段的计数，以及使用触发条件而非目标的数量。 |
| `boundStage` | 本会话绑定且仍处于活动状态的阶段，否则为 `null`。 |

只有计划中或活动的工作、且其目标日期早于当天的 UTC 日期时，`overdue` 才为 true。

## Prometheus 契约

事件定义见 [omo-prometheus 参考文档](../omo-prometheus/REFERENCE.zh.md#路线图契约)。在路线图这一侧：

- 路线图会同步回复 `roadmap:binding-request`，附带会话、请求、仓库、受信任的工具来源和可选的已绑定阶段。已绑定阶段处于活动状态；如果会话是在 Plan Mode 中绑定而未开始的，则处于计划状态。阶段包含 `id`、`title`、`round`，并新增 `criteria`（按文档顺序排列的当前 DC ID，不含已删除的标准）和 `revision`。即使无法读取已绑定阶段的文档，它也会回复，只是不带阶段。没有回复表示未安装路线图。
- `revision` 是阶段规划基准的小写 SHA-256 十六进制值，基准为对解析后各节计算的 `JSON.stringify([objective, scope_in, scope_out, done_criteria, design_constraints ?? ""])`（`src/documents.ts` 中的 `planningRevision`）。日期、状态、标题、依赖、风险、修订记录、自由工作日志和 Outcome 都不会改变它。使用方应把它视为不透明值。
- 路线图会同步回复本会话的 `roadmap:stage-request` `{ v: 1, sessionId, requestId, repoRoot, stage }`，前提是 `repoRoot` 等于会话工作目录所在的 git 工作树根目录，回复为 `roadmap:stage` `{ v: 1, sessionId, requestId, repoRoot, stage? }`。`stage` 为 `{ id, title, round, status, criteria, revision, activation? }`，任何状态都会返回；仓库没有路线图、阶段不存在或文档无法读取时不带 `stage`。格式错误的请求不会得到回复。
- `activation`（新增）表示开始实施前还欠这个阶段什么：阶段仍为计划状态时是 `{ action: "start" }`；磁盘上已是活动状态，但 HEAD 中没有已开始的副本，且阶段文档、轮次索引和路线图索引中有文件与 HEAD 不同时，是 `{ action: "commit", files }`（`files` 列出这些相对仓库根目录的路径）。不欠任何东西时不带该字段。存在该字段时，Atlas 拒绝派发计划行。
- 路线图发送 `atlas:plans-request` `{ v: 1, sessionId, requestId, repoRoot, stage? }`，并读取同步返回的 `atlas:plans`。它只接受针对本会话和本请求 ID 的回复；只要有一个计划条目格式错误，就丢弃整个回复（每个字段都会检查类型：ID、无重复的 `DC` 标准、64 位十六进制修订号、`unfinished` 或 `complete`、`done` 不超过 `total`、关口、交付和延后发现的结构，以及绝对路径的 `directory`）。多余字段会被忽略，其他仓库或阶段的计划会被排除。没有回复表示没有计划信息。
- Atlas 只放行来源为扩展、且源路径与握手一致的 `roadmap_*` 工具；其他扩展或 MCP 服务器提供的同名工具不会被放行。每个路线图工具都把这个路径（已加载的 `src/index.ts` 的真实路径）显式声明为自己的来源，因此通过符号链接加载的安装（插件市场的默认布局）也能匹配。
- 收到 `atlas:completed` v1（结构不变）时，路线图为执行会话保存一条待关闭条目，并在阶段仍处于活动状态时于下一回合加入提醒。提醒会写明已完成的计划，把它的关口结果列为证据候选，并根据针对该阶段重新查询的 `atlas:plans` 回复，列出所有计划对各条标准的覆盖情况、未完成的计划、未声明覆盖范围的计划、漂移、尚未分类的延后发现，以及是否每条当前标准都有已完成的计划声明覆盖。提醒有长度上限；没有回复时只显示完成事件本身。可选的 `delivery: { mode: "pr" | "ship"; summary: string }` 会检查类型，摘要规范为单行并截断至 180 个字符，随待关闭条目持久化，并显示为 `Delivery (<mode>): <summary>`。交付字段无效时拒绝该完成事件；允许省略交付信息，包括此前持久化的 v1 条目。既没有提案时绑定、也没有执行会话绑定的计划，不会关联到任何阶段。
- 待关闭条目在接收会话内按 `planId` 去重。

## 目录格式

以下是 `src/documents.ts` 中 `HOW_THIS_DIRECTORY_WORKS_V2` 的原文。`/init-project` 会把它写入项目的 `docs/roadmap/README.md`，该文件同时是初始化标记和自动生成的索引；升级到格式 2 时，它会替换更早版本写入的格式 1 版本。

> This directory records structured build rounds, their stages and carry-over TODOs. ADRs in docs/adr/ record decisions and outlive rounds. Plans describe implementation steps and do not live here.
>
> The root README is the initialization marker and rounds index. Each NN-slug round directory contains its charter README, TODO.md and stages/NN-slug.md. Rounds use R1, R2 and so on in creation order and are never renumbered; stages use S01, TODOs T001 and ADRs ADR-0001. Stage and TODO numbers are global across rounds, monotonic and never reused. ADR files use NNNN-slug.md. Slugs contain lowercase ASCII letters, digits and hyphens.
>
> This README carries roadmap: { format: 2 }, the repository format; roadmap plugin 0.2.3 and earlier cannot read a format 2 repository. Every managed file has format: 1 or format: 2 front matter and a managed-by comment naming the same format. Format 1 files keep their bytes until a write needs a format 2 field: a target date, a planned or dropped round, or a round outcome. Front matter and fixed headings are structure. Tool-owned bodies allow plain paragraphs, flat text lists and closed top-level fences, with ordinary punctuation, plain URLs, inline emphasis and same-line code spans; structural Markdown, Markdown links and raw HTML syntax are refused. Stage headings are Objective, Scope (In and Out), Done criteria, optional Design constraints and Risks, Amendments, Free-work log and optional Outcome. Round charters contain Goal, Constraints, Non-goals, Principles, Stages, Known limitations and, for a dropped round or a round closed with its goal outcome, Outcome. TODOs are split into Open and Closed in this round. ADR bodies follow the vendored MADR 4.0 template, using Confirmation for verification and leaving implementation steps to the plan.
>
> Agents change managed files through roadmap_* tools. Body text can be edited by a user in an editor; malformed structure must be repaired before tools can write. Generated blocks are marked with `<!-- roadmap:generated:<name> -->` and `<!-- /roadmap:generated -->`. The tools own numbering, metadata, headings and generated indexes.
>
> Rounds are planned, active, closed or dropped. A planned round is drafted ahead with its charter, planned stages and TODOs; only the lowest-numbered planned round can be activated, and an unneeded planned round is dropped together with its planned stages. Stages are planned, active, closed or dropped; only stages of the active round start. A stage depends only on stages in its own or an earlier round. Closed stages never reopen; corrective work uses a new stage with follows. Dependencies must be closed before a stage starts. Done criteria state what must pass and how to verify it; closing records evidence, TODO dispositions and ADR dispositions. Closing a round records how its goal turned out in Outcome: an assessment (achieved, partial, not_achieved or cancelled) and a summary. Open TODOs need severity, source and either an unclosed target stage in the active or a planned round, or a trigger. A planned round's TODO.md holds only TODOs for its own stages or with a trigger. When a round closes, its open TODOs that target a planned round's stage continue in that round's TODO.md with the same ID and a Carried from line, and the original is marked carried to that round. Rounds and stages may carry an optional target date; status views compare it with the actual dates and flag unfinished work past its target. Charter principles cite ADRs rather than restating decisions. Accepted ADRs change through status transitions, supersession and dated append-only notes.
>
> Same-ID carry-over may continue through multiple later rounds: every earlier occurrence is carried to the next round with matching Carried from metadata, and only one occurrence is not carried. These continuations cannot be imported again with import_todos. Moving a TODO out of a planned round to another round leaves a moved record naming a fresh ID; the destination keeps the target and records Carried from with the original ID and round.
>
> Closed stages carry closed_sha256; closed and dropped rounds carry frozen_sha256 and remain read-only history. There is at most one active round. With none active, free work is unrestricted and roadmap context is not injected; ADR management remains available.
>
> Writes use one repository lock and per-file atomic replacement. An interrupted multi-file operation can leave stale indexes: run roadmap_check or /roadmap check, then check --fix to regenerate generated blocks. Fix never changes authored bodies, a closed round or a dropped round. Restore other damage with git. The shared git common directory stores only the lock and versioned id counters; the checked-out Markdown is the source of truth on each branch.
>
> Check verifies document consistency. It cannot determine whether code implements the documents. Close evidence and boundary checks help keep them aligned.
