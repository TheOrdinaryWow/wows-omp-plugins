<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/adr-dark.png">
  <img alt="adr" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/adr-light.png">
</picture>

# adr

[English](README.md) | 简体中文

> 把架构决策写成记录留在仓库里，让代理帮你写，但不会篡改历史。

架构决策记录（ADR）是一份简短的文档，说明一项设计决策：遇到了什么问题、考虑过哪些方案、最后选了哪个。这个插件把它们以 [MADR 4.0](https://github.com/adr/madr) 格式的 Markdown 保存在 `docs/adr/` 中。代理通过提问了解情况，起草记录并保存为“提议”状态，接不接受由你决定。已接受的决策不会被改写，只能弃用、被新决策取代，或者追加带日期的备注，这样记录里能看出你的想法是怎么变化的。每一轮对话，代理还会收到一份尚未定下的决策摘要。

## 安装

```bash
omp plugin install adr@wows-omp-plugins
```

需要 OMP 18.17.0 或更高版本，并且要在 Git 仓库里使用（本地 `git init` 就够了，不需要远程仓库）。不在 Git 仓库中时，命令会拒绝运行。安装后开一个新会话。

## 快速上手

1. 运行 `/adr init`。`docs/adr/` 必须不存在或为空。查看预览，选择 `Write 1 file`（全屏预览里按 Shift+W）。
2. 运行 `/adr new`，也可以带上主题：`/adr new database choice`。代理会询问背景、可选方案和结论，给你看草稿，然后保存为提议状态的 ADR。
3. 运行 `/adr`，选中这条 ADR，按 Enter，选择 `Accept`、`Reject` 或 `Deprecate`。

如果你的 ADR 是 roadmap 插件 0.4.0 或更早版本写的，可以跳过 `/adr init`，见 [roadmap 插件留下的 ADR](#roadmap-插件留下的-adr)。

## 用法

### ADR 记录了什么

| 字段 | 含义 |
| --- | --- |
| ID（`ADR-0001`） | 依次递增，不会重复使用。文件名为 `docs/adr/0001-slug.md`。 |
| 状态 | `proposed`、`accepted`、`rejected`、`deprecated` 或 `superseded`。 |
| 取代 / 被取代 | 一项决策和取代它的新决策之间的双向链接。 |
| 阶段 | 可选，关联到 roadmap 中的某个阶段；需要 roadmap 插件。 |
| 决策者、咨询对象、知会对象 | 可选的相关人员名单。 |

`docs/adr/README.md` 用来标记这个目录已被管理，里面有一张所有决策的表格，由插件自动维护。

### 决策如何随时间变化

- 新决策都从 `proposed` 开始。只有你明确同意时，代理才会把决策记为已接受。
- 决策处于提议状态时，可以整体重写。
- 已接受的决策不会被重写，只能弃用、被新的已接受决策取代，或在 More Information 下追加带日期的备注。
- 只有你，或者代表你的主代理，才能接受、拒绝、弃用、取代决策，以及修改它关联的阶段。子代理可以起草提议、修改提议和添加备注。
- 备注在提交之前可以修改或删除，提交之后就保持原样，需要补充时请再加一条新备注。

代理不能直接修改 `docs/adr/` 里的文件，必须通过插件来改，插件会执行上面这些规则。你自己仍然可以在编辑器里修改正文。

### 命令

所有命令都在主会话中运行，支持补全子命令和 ADR ID。

| 命令 | 作用 |
| --- | --- |
| `/adr` | 打开 ADR 控制台（见下文）。 |
| `/adr list [status]` | 列出 ADR，可以只看某一种状态。 |
| `/adr show <id>` | 显示一条 ADR，以及它取代的或取代它的决策。 |
| `/adr accept\|reject\|deprecate <id>` | 记录你的决定。 |
| `/adr note <id> <text>` | 在 More Information 下追加一条带日期的备注。 |
| `/adr new [topic]` | 让代理就一项新决策向你提问。 |
| `/adr supersede <id> [topic]` | 让代理就一项取代已接受或已弃用决策的新决策向你提问。 |
| `/adr check [--fix]` | 检查记录是否一致；`--fix` 重建决策表格。 |
| `/adr init` | 确认预览后初始化 `docs/adr/`。 |
| `/adr confirm <token>` | 没有对话框可用时，用它确认 `/adr init` 的预览。 |

### `/adr` 控制台

`/adr` 会占满终端：左边是带状态标记的 ADR 列表，右边是选中那条的完整内容。

| 按键 | 操作 |
| --- | --- |
| 上、下、Home、End | 选择 ADR。 |
| PgUp、PgDn、鼠标滚轮 | 滚动决策内容。在列表上滚动滚轮会移动选择。 |
| Tab、Shift+Tab | 在“全部”和各个状态之间切换，并显示数量。 |
| 小写字母、数字 | 搜索 ID、标题和状态。用 Backspace 修改搜索内容。 |
| Enter | 选择对当前 ADR 做什么。 |
| Shift+A、R、D | 在状态允许时接受、拒绝或弃用当前 ADR。 |
| Shift+N、S | 添加备注，或取代一条已接受或已弃用的 ADR。 |
| Shift+O | 新建决策。 |
| Shift+C | 运行检查。 |
| Shift+F | 运行检查并重建决策表格。 |
| Esc | 先清空搜索，再关闭。 |

接受、拒绝、弃用、添加备注或运行检查之后，控制台会停在同一条 ADR 上，并在按键提示上方显示结果；完整结果也会写进对话。新建决策或取代决策会关闭控制台，因为接下来代理要向你提问。

`/adr init` 的预览也是同样的布局，左边是文件列表。按 Shift+W 写入，按 Esc 放弃。

在 [Tern](https://docs.stencil.so/tern/) 中，控制台和预览以原生面板打开，按钮提供同样的操作，代理的 ADR 工具调用也会显示成易读的卡片。

### 代理做了什么

代理通过三个工具读写 ADR：`adr_status` 用来列出和阅读，`adr_manage` 用来新建、修改、变更状态、取代、添加备注和关联阶段，`adr_check` 用来检查。这些工具不需要你自己调用。在还没运行过 `/adr init` 的仓库里，它们会拒绝执行，代理会请你先运行它。

### roadmap 插件留下的 ADR

roadmap 插件 0.4.0 或更早版本写的 ADR 可以直接读取，仓库视为已经初始化。插件每次修改一个文件时，只会把这个文件改写成新格式；第一次修改还会转换决策表格，并保留你在里面写的文字。没人动过的文件保持原样，新 ID 会接着 roadmap 插件的编号往下排。

这种转换是单向的：roadmap 插件 0.4.0 及更早版本读不了转换后的文件。如果这个仓库的其他克隆还在用那些版本，请在第一次修改之前，先在那边升级 roadmap 插件并安装本插件。

## 设置

为当前用户修改设置：

```bash
omp plugin config set wows-omp-plugin-adr uiMenu inline
omp plugin config list wows-omp-plugin-adr
```

只想在某个项目里改，就在该项目的 `.omp/plugin-overrides.json` 中写上：

```json
{ "settings": { "wows-omp-plugin-adr": { "uiMenu": "inline" } } }
```

修改在下次运行 `/adr` 命令时生效。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `uiMenu` | `fullscreen` | `fullscreen` 打开上文介绍的控制台和全屏预览。`inline` 改用小对话框：先选状态，再选 ADR，然后选操作。只影响终端；无法识别的值按 `fullscreen` 处理。 |

## 与其他插件配合

- **roadmap** 依赖本插件。它会读取你的 ADR 并把它们关联到 roadmap 的阶段，它的 `/init-project` 会在 `docs/adr/` 不存在或为空时把它初始化。把 ADR 关联到阶段需要安装 roadmap 且该阶段存在；取消关联则不需要。
- **omo-prometheus** 在执行已批准的计划时，允许代理继续使用 ADR 工具。

## 已知限制

- `/adr init` 无法接管已有文件、但不由本插件管理的 `docs/adr/` 目录。
- 防止直接修改的保护只能尽力而为，对 shell 命令尤其如此，它不是沙箱。
- `/adr check` 只检查记录本身，不检查代码是否遵循了这些决策。
- 涉及多个文件的修改不是全有或全无。如果中途被打断，可以用 `/adr check --fix` 修复决策表格。
- 同一仓库的不同克隆各自编号，ID 可能冲突。同一克隆的多个工作树共享编号。

## 更多细节

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍了工具参数、文件格式（包括 roadmap 插件的旧文件）、工具接受的 Markdown、编辑保护的原理、恢复与工作树、`/adr` 在 RPC、ACP 编辑器和无界面模式下的表现、状态快照，以及供其他插件使用的接口。

## 许可证

MIT。随附的 MADR 模板在 `assets/madr/` 中保留各自的许可证。
