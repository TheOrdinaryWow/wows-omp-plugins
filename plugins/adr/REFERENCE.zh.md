# adr 参考

[English](REFERENCE.md) | 简体中文

## 上下文注入

在 `docs/adr/` 已被管理的仓库中（由本插件的标记或旧版 roadmap ADR 索引标识），插件会在每个代理回合开始时读取检出的文件，并在主会话和子代理会话的系统提示末尾追加一小段内容：

```text
ADRs in docs/adr: 2 proposed, 5 accepted, 1 superseded.
Proposed: ADR-0007 Use a queue; ADR-0009 Cache reads.
Read decisions with adr_status (an id gives the full text); change them only through adr_manage.
```

计数只列出非零的状态。最多按 ID 顺序列出五个提议状态的 ADR，其余以 `and N more` 表示；标题截断到 80 个字符。解析失败的文件会单独占一行说明。未初始化的仓库不注入任何内容。

## 工具

`adr_status` 使用读取审批；`adr_manage` 和 `adr_check` 使用写入审批。所有工具声明同一个 `sourcePath`（已加载的 `src/index.ts` 的真实路径），服务契约以 `toolSourcePath` 报告该路径。

| 工具 | 输入 |
| --- | --- |
| `adr_status` | 不带参数：计数和全部 ADR。`status`：只列该状态。`id`：元数据、文件、取代链和完整的 MADR 正文。 |
| `adr_manage` | `action` 加下表中的字段。 |
| `adr_check` | 可选 `fix: true`。 |

如果 `docs/adr/` 不存在或为空，所有工具都会以 "ADR management is not initialized in this repository" 拒绝，并提示请用户运行 `/adr init`。没有标记的非空 `docs/adr/` 会被视为未管理而拒绝。在 git 工作树之外，工具也会拒绝。

### `adr_manage` 操作

| 操作 | 字段 | 规则 |
| --- | --- | --- |
| `create` | `title`、`sections`，可选 `status`、`stage`、`decision_makers`、`consulted`、`informed` | `sections` 需要 `context`、非空的 `options` 列表和 `outcome`；`drivers`、`consequences`、`confirmation`、`pros_cons` 和 `more_info` 可选。`status` 默认为 `proposed`；子代理总是得到 `proposed`，请求其他状态时会收到警告。 |
| `revise` | `id`、`sections`，可选 `title` | 仅限提议状态的 ADR。整体替换正文，元数据不变。 |
| `set_status` | `id`、`status` | 仅限主代理。`accepted`、`rejected` 或 `deprecated`；已被取代的 ADR 会被拒绝。 |
| `supersede` | `id` 及 `create` 的字段 | 仅限主代理。该 ADR 必须是已接受或已弃用。创建一个 `supersedes: [id]` 的已接受后继，并把旧 ADR 设为 `superseded`，写入 `superseded_by`。 |
| `note` | `id`、`text` | 在 More Information 下追加 `### YYYY-MM-DD` 和文本，缺少该章节时自动添加。返回 `Note index: N`，按本 ADR 中带日期备注的文件顺序从零计数。任何执行者、任何状态都可使用。 |
| `revise_note` | `id`、`index`、`text` | 替换一条未提交备注的文本，保留日期。任何执行者、任何状态都可使用。 |
| `delete_note` | `id`、`index` | 删除一条未提交备注。任何执行者、任何状态都可使用。 |
| `link` | 必需 `id`，可选 `stage` | 仅限主会话，允许任何 ADR 状态，包括已被取代。设置或更改阶段关联；省略 `stage` 即清除，不需要解析器。正文、状态和取代关系不变。 |

只有 `create`、`supersede` 和 `link` 接受 `stage`。设置或更改阶段关联需要通过服务契约注册的阶段解析器（roadmap 插件会注册一个）；没有解析器时，调用会以 "Stage links need the roadmap plugin" 拒绝。有解析器时，解析器必须接受该阶段 ID。用 `link` 清除现有关联不需要解析器。

备注索引是按文件顺序从零计数的整数；无效索引会被拒绝且不写入。以 `HEAD` 中该文件的相同标题和正文逐条判断备注是否已提交，重复备注按数量匹配。修改已跟踪文件的其他部分不会使已提交备注可编辑。没有 `HEAD` 或文件在其中不存在时，所有备注都未提交。已提交备注会以 "ADR note is committed; append a new note instead." 拒绝修改。备注编辑与追加采用相同的验证和索引重新生成流程。

如果现有 ADR 结束于一个未闭合的代码围栏中，`note` 会拒绝且不做修改。请在编辑器中修复文件后重试。

## 文件格式

### ADR 文件

`docs/adr/NNNN-slug.md`，其中 `NNNN` 是 ADR 编号（至少四位），slug 由标题生成。

```markdown
---
format: 1
id: "ADR-0003"
status: "accepted"
date: "2026-10-10"
supersedes: ["ADR-0001"]
superseded_by: "ADR-0005"
stage: "S04"
decision-makers: ["Project owner"]
consulted: ["Platform team"]
informed: ["Support"]
---
<!-- Managed by the adr OMP plugin (format v1). Change it through adr_* tools. Format: docs/adr/README.md -->

# Title

## Context and Problem Statement
…
```

`format`、`id`、`status` 和 `date` 始终存在，且按此顺序排列。可选键按上例顺序跟在后面，缺失或为空时省略；本格式中没有 `null`。正文是随附的 MADR 4.0 模板（`assets/madr/adr-template.md`）：Context and Problem Statement、Considered Options 和 Decision Outcome 必须存在，其余标题可选并保持模板顺序。Confirmation 取代了 MADR 的 Verification。

### 索引与标记

`docs/adr/README.md` 标记该目录已被管理：

```markdown
---
format: 1
adr: { format: 1 }
---
<!-- Managed by the adr OMP plugin (format v1). Change it through adr_* tools. Format: docs/adr/README.md -->

# Architecture Decision Records

<conventions paragraph>

## Decisions

<!-- adr:generated:index -->
| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| ADR-0001 | Use Postgres | superseded by ADR-0003 | 2026-10-01 |
<!-- /adr:generated -->
```

每次写入都会重新生成该表。你在 Decisions 章节中生成块之外添加的文字会保留。声称受管理（带 `adr:` 键或托管注释）但无法解析的 README 会报错，绝不会被当作未管理的目录。

### 旧版 roadmap 文件

roadmap 插件 0.4.0 及更早版本写入的 ADR 文件总是包含全部十个键（在 `format` 和 `id` 之后依次为 `supersedes`、`superseded_by`、`stage`、`status`、`date`、`decision-makers`、`consulted`、`informed`），缺少阶段或后继时写 `null`，格式为 `format: 1` 或 `format: 2`，注释为 `<!-- Managed by the roadmap OMP plugin (format vN). Change it through roadmap_* tools. Format: docs/roadmap/README.md -->`。其索引的前置元数据只有 `format`，生成块为 `<!-- roadmap:generated:adrs -->` … `<!-- /roadmap:generated -->`。

文件的读取方式由托管注释决定，注释中的格式必须与文件自身的 `format` 一致。旧版文件会被透明读取，并视为已初始化。写入只会把涉及的文件改写为本插件的格式；旧版索引会在第一次写入时转换（或在其表格过期时由 `check --fix` 转换），替换 roadmap 约定段落（仅当它仍是 roadmap 插件写入的原文时）和生成块分隔符，保留其余所有自行编写的文字。未涉及的文件保持原有字节，读取时不会改写任何内容。`adr_status` 和状态快照会报告仍是旧版格式的文件数量。

转换是单向的。roadmap 插件 0.4.0 及更早版本无法读取转换后的索引或 ADR 文件，因此转换后的文件一旦提交，仍在运行这些版本的克隆或工作树就无法读取 `docs/adr/`。请在第一次写入之前，在每个环境中升级 roadmap 插件并安装本插件。

## 工具写入文本中的 Markdown

工具接受与 roadmap 插件相同的正文子集。正文章节支持普通段落、每项只有一行文本的扁平无序或有序列表，以及完整闭合的顶层代码围栏。无序列表标记为 `-`、`+` 或 `*`；有序列表标记为一到九位数字后跟 `.` 或 `)`，标记后接一个空格。不支持嵌套列表和缩进的列表续行。

允许普通标点，包括 `~20%`、`snake_case`、`quantity * unit price`、含下划线或波浪号的 URL，以及 `x < y` 或 `x > y`。紧跟 ASCII 字母、`/`、`!` 或 `?` 的 `<` 会被拒绝，因为它可能开启 HTML、自动链接、注释或处理指令。`>` 不能出现在行首。

允许行内强调符号。代码之外不支持方括号、反斜杠转义和表格竖线。允许同一行内的行内代码；每个开头的反引号串都必须在同一行用等长的反引号串闭合。

代码围栏使用至少三个反引号或波浪号，前面可有零到三个空格。可选的信息字符串是一个由 ASCII 字母、数字、`_`、`+`、`.` 或 `-` 组成的语言标记。闭合围栏使用相同的符号、长度不短于开头，且没有信息字符串。围栏不能在列表内开始；列表之后请使用不缩进的围栏。列表之后的段落需要空一行。

考虑的选项、标题和参与者名称都是单行文本，不能包含列表或围栏。工具会重新解析每个渲染后的文件，如果正文会改变 ID、元数据或固定标题，就在修改任何字节之前拒绝写入。

## 一致性检查

`adr_check` 和 `/adr check` 报告：

| 规则 | 含义 |
| --- | --- |
| `structure`、`format` | 无法解析的文件、不支持的格式、缺少索引，或 `NNNN-slug.md` 文件名与 ID 不符。 |
| `duplicate-id` | 两个文件使用同一个 ID，例如来自不同的克隆或分支。 |
| `dangling-reference` | `supersedes` 或 `superseded_by` 指向不存在的 ADR。 |
| `supersession` | 链接不是双向的，或者状态为 `superseded` 却没有后继（或反之）。 |
| `generated` | 索引表已过期。唯一可修复的规则。 |

`fix: true` 会在 ADR 锁下重新生成索引，从不修改 ADR 文件。存在结构或格式错误时它会拒绝。阶段引用由 roadmap 插件检查。

## 编辑保护

一旦 `docs/adr/` 受管理，工具调用钩子就会在主会话和子代理会话中阻止对 `docs/adr/**` 的原生修改，并提示改用 `adr_manage`。它会找到目标所在的 git 工作树，检查字面路径和解析后的路径（包括悬空符号链接的目标），并把设备号和 inode 与具有多个链接的托管文件比较，因此硬链接别名无法修改托管文件。

| 入口 | 覆盖范围 |
| --- | --- |
| `write` | 其 `path`，包括从读取输出复制的 `[path#TAG]` 头。 |
| `edit`、`apply_patch` | 所有原生编辑语法（`hashline`、`replace`、`patch`、`apply_patch`、`sloppy`）；任何托管的源或目标都会被阻止，未知语法会被拒绝。 |
| `ast_edit` | 经原生范围规范化后的 `paths`；包含 `docs/adr` 的目录和通配模式会被阻止。 |
| `lsp` | 指定文件的 `rename`、已应用的 `code_actions`，以及 `rename_file`（两个名称都检查）。 |
| `bash` | 对重定向、`tee`、`mv`、`cp`、`rm`、原地 `sed` 和 `truncate` 的尽力静态检测。 |

没有标记的仓库不受影响。格式错误的标记，或路径解析、文件标识出错时，调用会被拒绝。钩子不拦截 `eval`、从 bash 启动的编辑器或其他会写文件的程序；shell 变量和间接写入可以绕过它。

## 恢复与工作树

写入时获取一把锁 `<git common dir>/adr/lock`，并逐个原子替换文件（临时文件加重命名），先写 ADR 文件，最后写索引。多文件写入不是事务。取消会在下一次临时写入或重命名前停止；已写入的文件保留，并在拒绝信息中列出。

1. 运行 `/adr check` 或 `adr_check`。
2. 索引过期时运行 `/adr check --fix` 或带 `fix: true` 的 `adr_check`。
3. 用 git 恢复其他损坏，然后再次检查。

ID 来自 `<git common dir>/adr/counters.json`，即 `{"v":1,"adr":N}`，同一克隆的所有工作树共享。新 ID 比以下三者中的最大值大一：该计数器、roadmap 插件在 `<git common dir>/roadmap/counters.json` 中保留的 `adr` 计数器（只读，从不写入），以及磁盘上的所有 ID。计数器文件无法读取时会暂停分配，以免重复使用 ID。每个分支上检出的 Markdown 是唯一可信来源。

## 不使用终端界面时

| 宿主 | 行为 |
| --- | --- |
| RPC（`--mode rpc`、`rpc-ui`）和 ACP | 无论 `uiMenu` 怎么设，都使用内联菜单和对话框，以 `select`、`input` 和 `editor` 请求发送。ACP 客户端可能只把通知写进日志。 |
| 无 UI（`--no-ui`、print、JSON、SDK） | 没有对话框。不带参数的 `/adr` 输出列表和用法，请使用子命令。通知和错误显示为会话消息。 |
| Tern | 控制台和 `/adr init` 预览以原生面板打开：点击状态标签筛选，点击 ADR 或文件选中（双击执行），按钮提供与按键相同的操作，按键仍然可用。`adr_*` 工具调用显示为原生卡片（带彩色状态的 ADR 表格、单个 ADR 的元数据和可折叠的正文、改动的文件、检查诊断），`/adr` 消息带有可读的标题，比如 “ADR check”。 |
| 任何宿主 | `/adr visualize` 把地址作为显示的消息发送。只有宿主有 UI 时才会打开浏览器。 |

没有 UI 时，`/adr init` 返回渲染后的预览和 `/adr confirm <token>` 命令，不写入任何内容。令牌只覆盖所显示的文件，在会话重建（启动、切换、分支、树导航）或被新的 `/adr init` 预览替换之前有效；确认时会重新检查初始化是否仍生成相同的文件。这个待确认的预览只保存在内存里，进程退出后就会丢失。

在终端控制台中，取消新决策或替代决策的主题对话框会回到控制台。插件附带 `adr` 技能和固定版本的 MADR 4.0 模板（`assets/madr/`）。

## 可视化服务

`/adr visualize` 运行一个只读的决策图服务。服务代码在 `src/visualize-server.ts`，图数据在 `src/visualize-data.ts` 和 `src/visualize-history.ts`，页面在 `assets/visualize/`（纯 HTML、CSS 和 JavaScript，没有构建步骤）。

- **监听地址**：`Bun.serve` 监听 `127.0.0.1`，端口为 `0`，由操作系统分配。每次启动服务都会生成新的随机令牌（24 字节的十六进制字符串），作为路径前缀：`http://127.0.0.1:<端口>/<令牌>/`。没有该前缀的路径，以及非 GET 的请求，都返回 404。
- **端点**：页面使用前缀下的相对 URL。

| 路径 | 响应 |
| --- | --- |
| `/<令牌>/` | `index.html` |
| `/<令牌>/app.js`、`/<令牌>/app.css` | 资源文件，每次请求时从磁盘读取，附带对应的内容类型 |
| `/<令牌>/api/graph` | 每次请求都重新构建的 `AdrGraph`，`Cache-Control: no-store`。构建失败时返回状态码 500 和 `{"error": ...}`。 |
| `/<令牌>/api/events` | `text/event-stream`。连接时以及每次修订时发送 `{"revision":N}`，并每 15 秒发送一次 `: keep-alive` 注释。 |

资源目录中只有 `index.html`、`app.js` 和 `app.css` 可以访问，其他文件名返回 404。

- **生命周期**：`AdrVisualizer` 只保留一个服务，由会话 ID 和仓库根目录（`discoverRepo(cwd)`）标识。两者都匹配时 `open` 复用它，否则启动新的服务。会话关闭（`session_shutdown`）时立即停止。如果会话 ID 或仓库根目录已经不匹配，下一次 `open` 或变更通知会先停掉旧服务。停止时会关闭 SSE 连接、两个文件监听器、保活计时器和 HTTP 服务。
- **打开浏览器**：`open` 总是返回地址，只有 `ctx.hasUI` 为 true 时才调用 `openPath`。命令随后发送一条显示的消息 `ADR visualization: <url>`。
- **修订触发**：最后一次触发后 200 毫秒（防抖），服务把修订号加一并广播。触发来源有三类：
  - `docs/adr/` 目录的变化。监听该目录；目录不存在时监听它最近的已存在上级目录，目录出现后再切换过去；
  - git 公共目录下路径匹配 `HEAD`、`refs` 或 `packed-refs` 的变化（递归监听），涵盖提交、分支移动和标签；
  - ADR 工具调用、`/adr` 命令和服务写入，它们走同一个通知入口。
  `docs/adr/` 和 git 目录之外的文件修改不会触发修订。
- **图数据**：只有状态为 `managed` 或 `unmanaged` 时，`buildAdrGraph` 才会读取 ADR；`absent` 和 `empty` 状态下返回空列表，页面会显示说明。阶段标题取自 `docs/roadmap/**/S*.md` 文件的前置元数据（`id`、`title`、`round`、`status`），没有时取第一个 `#` 标题，并且只读取被 ADR 引用的阶段。`mentions` 是正文中匹配 `ADR-\d{4,}` 且指向已存在 ADR 的 ID，排除自身和取代关系中的 ID，按 ID 排序。`notes` 是 `## More Information` 下的 `### YYYY-MM-DD` 标题，内容取到下一个标题为止。`workingTree` 与 HEAD 比较：HEAD 中没有该 ID 的文件时为 `untracked`，路径和字节都相同时为 `clean`，其余为 `modified`。

`AdrGraph`（版本 1）：

| 字段 | 内容 |
| --- | --- |
| `version` | 固定为 `1`。 |
| `generatedAt` | 构建时的 ISO 时间。工作区事件使用它作为日期。 |
| `repo` | `name`（目录名）、`root`、`branch`（HEAD 游离或无法读取时省略）和 `head`（7 位短 SHA，没有提交时省略）。 |
| `state` | `AdrDirState`：`absent`、`empty`、`managed` 或 `unmanaged`。 |
| `adrs` | 按 ID 排序的 `AdrNode`。 |
| `stages` | ADR 引用的每个阶段对应一个 `StageInfo`（`id`，可选的 `title`、`round`、`status`）。 |
| `history` | `available`、可选的 `reason`，以及 `events`：按时间从早到晚排列，工作区事件排在最后。 |
| `parseErrors` | 加载失败的文件，包含仓库相对路径 `path` 和 `message`。 |

`AdrNode` 包含 `id`、`title`、`status`、`date`（`YYYY-MM-DD`）、可选的 `stage`、`supersedes`、可选的 `supersededBy`、`decisionMakers`、`consulted`、`informed`、`path`、`body`（不含前置元数据）、`notes`、`mentions` 和 `workingTree`。

`HistoryEvent`：`adr`、`kind`（`created`、`status`、`superseded`、`stage`、`note`、`edited` 或 `deleted`）、`commit`（7 位短 SHA；工作区事件为空字符串）、`date`（提交的作者时间，ISO 格式）、`author`、`subject`、可选的 `from` 和 `to`，工作区事件带 `uncommitted: true`。工作区事件的 `subject` 为 “Uncommitted changes”。

历史通过只读的 git 命令读取（带 `--no-optional-locks` 和 `--literal-pathspecs`）：

- 日志命令是 `git log --reverse --topo-order --full-history --diff-merges=off --raw --find-renames --root HEAD -- docs/adr/`。只统计从 HEAD 可达的提交。合并提交不产生事件，每个侧分支提交单独读取，因此同一变更不会被计算两次。合并提交内部做的冲突解决不会显示。
- 只统计 `docs/adr/*.md` 文件。`docs/adr/README.md` 不计入日志，也不计入 HEAD 快照。
- 版本按每个文件内部的 ADR ID 比较，所以保留 ID 的重命名算作一次变更，改变 ID 的重命名则拆成一次 `deleted` 加一次 `created`。解析失败的版本视为不存在。
- 一次提交中改动的每条 ADR 可能产生多个事件。文件出现时产生 `created`（`to` 为状态），文件消失时产生 `deleted`（`from` 为最后的状态）。状态变化产生 `status`（`from`、`to`）；新状态为 `superseded` 时改为产生 `superseded`，`from` 为旧状态，`to` 为取代它的 ID。阶段变化产生 `stage`。每个新的 `### YYYY-MM-DD` 备注标题产生一个 `note`，`to` 为该日期。以上都没有触发时产生 `edited`，因此正文变化、标题、日期或决策者的变化，以及它们的任意组合，都一定会产生事件。
- 工作区与 HEAD 快照按同样的方式比较。这些事件的 `commit` 为空字符串，`date` 等于 `generatedAt`，带 `uncommitted: true`，排在提交事件之后。
- HEAD 不存在（没有任何提交）时，`history.available` 为 `false` 并给出原因，事件只包含工作区中的 `created` 事件。之后的 git 命令失败时，`history.available` 同样为 `false`，`events` 为空，`reason` 为 git 的错误信息。

## 状态快照

主会话会用共享的快照外层结构发布 `adr.json`（见[仓库参考文档](../../REFERENCE.zh.md)）。`state` 是根据磁盘文件得出的 `adr/status` 负载，版本 1；仓库没有受管理的 `docs/adr/` 时为 `null`。它会在会话启动、切换、分支和树导航时，在每次 `adr_*` 工具调用、`/adr` 命令和服务写入之后，以及每个代理回合开始时重写。

| 字段 | 内容 |
| --- | --- |
| `kind`、`version` | `"adr/status"`、`1` |
| `repoRoot` | git 工作树根目录。 |
| `format` | 标记格式（`1`）；`docs/adr/README.md` 仍是旧版 roadmap 索引时为 `null`。 |
| `legacyFiles` | 仍是旧版 roadmap 格式的文件数（包括索引）。 |
| `counts` | `{ proposed, accepted, rejected, deprecated, superseded }`。 |
| `records` | 按 ID 排序的 `{ id, title, status, date, stage?, superseded_by? }`；缺失的链接会省略。 |

## 服务契约

同一会话中的其他插件通过 `pi.events` 访问本插件。roadmap 插件用它读取 ADR、把 ADR 关联到阶段，以及初始化 `docs/adr/`。

请求方订阅 `adr:binding`，发出带 `{ v: 1, sessionId, requestId }` 的 `adr:binding-request`，然后取消订阅。本插件在请求处理函数内同步应答，且只在 `sessionId` 是它自己的会话时应答，内容为 `{ v: 1, sessionId, requestId, toolSourcePath, api }`。没有应答表示插件未加载；`v !== 1` 或缺少 `api` 表示版本不兼容。

```ts
type AdrActor = "main" | "sub";
type AdrStatus = "proposed" | "accepted" | "rejected" | "deprecated" | "superseded";
type AdrDirState = "absent" | "empty" | "managed" | "unmanaged";
interface AdrSections { context: string; drivers?: string; options: string[]; outcome: string; consequences?: string; confirmation?: string; pros_cons?: string; more_info?: string }
interface AdrCreateInput { title: string; sections: AdrSections; status?: Exclude<AdrStatus, "superseded">; stage?: string; decision_makers?: string[]; consulted?: string[]; informed?: string[] }
interface AdrRecord {
  id: string; title: string; status: AdrStatus; date: string;
  stage?: string; supersedes: string[]; superseded_by?: string;
  decision_makers: string[]; consulted: string[]; informed: string[];
  path: string;     // repository-relative, e.g. docs/adr/0001-use-madr.md
  body: string;     // MADR body after the "# title" line
  legacy: boolean;  // stored in the legacy roadmap format
}
interface AdrSnapshot { repoRoot: string; records: AdrRecord[]; parseErrors: { path: string; message: string }[] }
interface AdrWriteOptions { signal?: AbortSignal; dryRun?: boolean }
interface AdrWriteResult { files: { path: string; content: string }[]; ids: string[]; warnings: string[] }
type StageResolver = (repoRoot: string, stageId: string) => Promise<string | undefined>; // undefined = valid; string = refusal reason

interface AdrApiV1 {
  version: 1;
  dirState(repoRoot: string): Promise<AdrDirState>;
  load(repoRoot: string): Promise<AdrSnapshot | null>;
  initialize(repoRoot: string, actor: AdrActor, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  create(repoRoot: string, actor: AdrActor, input: AdrCreateInput, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  createMany(repoRoot: string, actor: AdrActor, inputs: AdrCreateInput[], options?: AdrWriteOptions & { initialize?: boolean }): Promise<AdrWriteResult>;
  link(repoRoot: string, actor: AdrActor, id: string, stage: string | undefined, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  relinkStage(repoRoot: string, actor: AdrActor, from: string, to: string, options?: AdrWriteOptions): Promise<AdrWriteResult>;
  registerStageResolver(resolver: StageResolver): () => void;
}
```

| 方法 | 行为 |
| --- | --- |
| `dirState` | `managed` 包括本插件的标记和旧版 roadmap 索引。标记声称受管理却无法解析时抛出错误。 |
| `load` | 返回快照，记录按 ID 排序；未受管理时返回 `null`。解析失败的文件列在 `parseErrors` 中，不出现在 `records` 里。 |
| `initialize` | 仅限主会话。向不存在或为空的 `docs/adr/` 写入标记；未管理的目录会被拒绝；已受管理时返回带警告的空结果。 |
| `create` | 只有一个输入的 `createMany`。 |
| `createMany` | 在一个加锁的批次中按输入顺序以连续 ID 创建 ADR。目录未初始化时拒绝，除非传入 `initialize: true`（仅限主会话），此时在同一批次中向不存在或为空的目录写入标记。 |
| `link` | 仅限主会话，允许任何 ADR 状态。经解析器校验后设置或更改单个 ADR 的阶段关联；`stage: undefined` 清除关联，不需要解析器。正文、状态和取代关系不变。 |
| `relinkStage` | 把所有 `stage: from` 改写为 `to`，用于阶段重新编号。它需要已注册的解析器，但不会就 `to` 询问解析器，因为重命名由调用方负责。 |
| `registerStageResolver` | 每个会话一个解析器；以最后一次注册为准，返回的函数只会注销它自己注册的解析器。 |

所有写入都会获取 ADR 锁、遵守 `signal`，执行与工具相同的校验和执行者规则，并把涉及的文件改写为本插件的格式。解析器在获取锁之前调用，因此可以自由读取调用方自己的文件。使用 `dryRun` 时，写入会返回将要写入的文件和临时 ID（与真实写入一样，高于计数器和磁盘上的 ID），但不写文件、不消耗计数器；因此连续的预演会返回相同的 ID。`files` 列出相对于仓库的路径，先是 ADR 文件，最后是索引；`ids` 先按输入顺序列出新建的 ADR，再列出其他被修改的 ADR。拒绝以带有面向用户信息的 `Error` 抛出。

解析器收到的仓库根目录是调用时传入的路径解析出的 git 工作树根目录，以及一个形如 `S04` 的阶段 ID。
