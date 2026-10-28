<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/find-console-dark.png">
  <img alt="find-console" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/find-console-light.png">
</picture>

# find-console

[English](README.md) | 简体中文

通过 `/find` 自行发起按行为描述的语义搜索，浏览经过校准的 judge 分数，并预览匹配的源码行范围。命令在当前进程内运行宿主的语义搜索级联，使用会话的 judge 角色和项目设置，不会让聊天代理代为搜索。

## 安装

```bash
omp plugin install find-console@wows-omp-plugins
```

需要 OMP 18.12.0 或更高版本，并配置原生 judge，例如 TypeSafe jev。安装后启动新会话。插件没有运行时依赖，也不单独保存设置或凭据。

## 快速开始

1. 运行 `/find where release-please versions are bumped`。不带文字运行 `/find` 时，会打开查询输入框。
2. 查看进度视图。按 Esc 或 Ctrl+C 取消搜索；命令本身不设搜索时限。
3. 用上、下方向键选择结果，用左、右方向键切换已判定的行范围。预览包含周围源码，并高亮当前范围。
4. 按 Enter 将当前 `path:start-end` 引用插入输入框，或按 `s` 将选中的结果发送给代理。按 Esc 关闭控制台，不会增加对话记录。

## 用法

### 查询、搜索范围和关键词

```text
/find [--path PATH] [-k KEYWORD]... <query>
/find --help
/find --cancel
```

`--path`（缩写 `-p`）对应 CLI 的可选 `[path]`，可指定目录、单个文件或内部 URL。默认范围是当前会话的工作目录，而不是进程工作目录。每个额外词法关键词使用一次 `-k`（或 `--keyword`）。查询正文可以不加引号；路径或关键词包含空格时需要加引号。命令支持选项名称补全。

```text
/find --path plugins where version manifests are updated -k release-please
/find --path "a directory" -k "model role" how judges are resolved
/find --path omp://extensions.md how user messages are queued
/find -- --dash-leading query text
```

`--` 结束选项解析。路径必须由 `--path` 引入，不会将查询中的某个词猜成位置路径。隐藏文件和忽略文件遵循宿主级联的默认搜索策略。

### 结果控制台

终端会打开全屏覆盖层，左侧按相关性排列结果，右侧显示源码上下文。每条结果包含与宿主一致的六格分数条、分数、最相关的已判定范围和文件覆盖情况。分数颜色沿用内置 find 工具的强匹配、可能匹配和弱匹配档位。分数是 judge 的概率判断，不保证结果一定正确。

| 按键 | 操作 |
| --- | --- |
| 上、下方向键，Home、End | 选择结果。切换文件时从最相关的行范围开始。 |
| 左、右方向键，Tab | 按相关性顺序切换当前文件的行范围。 |
| PgUp、PgDn | 滚动较长的源码预览。 |
| Space | 标记或取消标记待发送的结果。 |
| Enter、`i` | 将当前范围引用插入输入框并关闭控制台，保留已有草稿。 |
| `s` | 以用户消息发送所有已标记的结果；没有标记时发送当前结果。代理仍在输出时，排入后续消息队列，不打断当前输出。 |
| `o` | 使用 `$VISUAL` / `$EDITOR` 打开本地文件，通过 `+line` 定位当前范围的起始行。未配置编辑器时使用系统打开方式。 |
| Esc、Ctrl+C | 关闭控制台，不发送结果，也不将控制台写入对话记录。 |

在 [Tern](https://docs.stencil.so/tern/) 中，同一控制台显示为大型原生玻璃面板。点击结果即可预览；范围切换、标记、插入、发送和外部打开按钮与按键使用同一操作逻辑。列表将文件名放在前面，完整长路径放在行提示中。底部显示结果数、费用、实际耗时和搜索统计。

### 覆盖情况与失败

- **完整覆盖**表示没有 judge 请求失败，不表示检查了全部文件或全部行。宿主级联会缩小候选范围，并限制读取和窗口预算。
- **部分覆盖**警告始终显示在结果上方；统计中保留失败请求数和未回答问题数。文件标记为部分覆盖时，表示文件还有未发送给 judge 的内容。
- **不可用**表示没有内容被判定。命令会显示错误，明确说明这不能证明不存在匹配，并且不打开结果控制台。
- **没有结果**时显示通知，不打开空控制台。如果覆盖不完整，通知仍会说明未判定文件可能包含匹配。

## 设置

命令每次调用都会从当前会话的项目级设置读取宿主的 `find.enabled`。例如，可在项目的 `.omp/config.yml` 中配置：

```yaml
find:
  enabled: auto
```

| 值 | 行为 |
| --- | --- |
| `auto`（宿主默认值） | 仅当 judge 角色首个可用候选为原生 judge 时启用；否则说明缺少原生 judge。 |
| `on` | 通过与宿主工具一致的启用判断。但非原生候选仍会在实际判定前被拒绝；控制台不会使用聊天模型或本地文本模型代替经过校准的搜索分数。 |
| `off` | 拒绝搜索，并指出原因是 `find.enabled`。 |

模型和认证由 OMP 配置，不由本插件配置。宿主会话管理器提供用量账本时，计费判定请求通过 `journalJudgmentUsage` 记入宿主账本；缓存命中不计费。没有账本的宿主仍会在底部显示级联返回的费用。

## 与其他插件配合

不依赖其他市场插件。`judge-dispatch` 与本命令共用宿主的 judge 配置，但不会互相更改路由或设置。本命令不注册 `tool_call` 或 `tool_result` 钩子，不会关闭推测式读取或启动。

## 没有终端界面时

| 宿主 | 行为 |
| --- | --- |
| 带 UI 的 RPC（`--mode rpc`、`rpc-ui`）和 ACP | 通过状态更新显示搜索进度，并提供取消对话框。结果使用文件选择器（含文件名、分数和范围说明）、操作选择器以及只读预览编辑器。预览中的编辑会被丢弃。仍支持标记和发送多个结果。 |
| 没有输入编辑器的宿主 | 明确说明无法插入引用，可改用发送给代理的操作。声明编辑器支持的 RPC 输入框可以接收插入；ACP 通常不支持。 |
| 没有 UI（print、JSON、SDK） | 不打开对话框，也不执行交互操作。需在命令中提供查询；通过显示消息输出排序结果、引用、覆盖情况、失败原因和统计。 |

如果带 UI 的宿主不能挂载自定义组件，命令会使用同一套选择器和编辑器流程。关闭对话框不会将结果发送给代理。

## 已知限制

- 内部 URL 结果（包括 `omp://` 和 `skill://`）可以预览、插入和发送，但不能外部打开；控制台会说明原因。
- 外部打开操作在运行 OMP 的机器上执行，不会为另一台机器上的 RPC/ACP 客户端提供本地编辑器集成。终端编辑器需要真实终端；图形编辑器只有接受 `+line` 时才能可靠定位，系统打开方式通常不能定位行号。
- 源码预览按需读取，最多读取前 4 MiB，与级联的读取上限一致。文件可能在判定后发生变化；预览不会冻结或编辑文件。
- 命令不额外增加 20 秒超时，但宿主底层提供方和文件系统扫描仍保留各自的限制。取消不会撤销已经计费的判定。
- 宿主的扩展命令 API 没有命令级中止信号。可通过进度视图取消（Esc/Ctrl+C 或取消对话框），也可运行 `/find --cancel`；切换会话和关闭会话同样会取消正在进行的搜索。

## 参考

宿主文档介绍了[语义 find](omp://tools/find.md)、[judge 和 find 设置](omp://settings.md)以及[扩展界面与消息投递](omp://extensions.md)。本插件不持久化状态，也不增加工具或客户端协议。

## 许可证

MIT。
