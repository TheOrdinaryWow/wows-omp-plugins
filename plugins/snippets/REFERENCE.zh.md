# snippets 参考

本页面向维护者和客户端开发者，说明文件格式、匹配规则、设置和状态存储。日常用法见 [README](README.zh.md)。

## 片段文件

片段保存在两个目录中：

| 范围 | 路径 | 说明 |
|---|---|---|
| `global` | `<agent 目录>/snippets/<key>.md` | `<agent 目录>` 即 `getAgentDir()`，默认为 `~/.omp/agent`。 |
| `workspace` | `<cwd>/.omp/snippets/<key>.md` | `<cwd>` 为会话的工作目录。 |

工作区片段与全局片段 key 相同时，工作区片段覆盖全局片段。全局片段仍会列出并标记为已覆盖，且不会匹配。

### Key

key 是去掉 `.md` 的文件名，必须符合：

```text
^[A-Za-z0-9_-]{1,64}$
```

文件名不符合的文件会被报告为问题并跳过。问题不会导致插件停止工作。

### 格式

文件由可选的 frontmatter 和正文组成：

```markdown
---
description: 一行描述
---
正文。frontmatter 之后的每一行都是正文。
```

规则：

- frontmatter 可选。存在时以 `---` 行开始，以 `---` 行结束，且只能包含 `description: <值>`。值可以是一行裸文本、双引号 JSON 字符串，或使用 `''` 转义的单引号字符串。
- 其他 frontmatter 键、第二个 `description` 或块标量会导致错误，文件被跳过。
- 没有 frontmatter 时，整个文件都是正文。正文末尾的换行会被去掉，其他空白保留。
- 空正文可以加载。使用该片段（插入或发送）会报错，且不计一次使用。

控制台写入时使用相同格式（`formatSnippetSource`）。手动编辑的内容会在下次加载时读取。

## 触发词

触发词由 trigger 设置、key 组成，`closed` 时首尾各有一个 trigger，`open` 时只有前面的 trigger：

| `matching` | `trigger: "."`、key 为 `review` 时 |
|---|---|
| `closed`（默认） | `.review.` |
| `open` | `.review` |

trigger 不能包含空白字符，也不能包含以下字符：`/ ! @ ^ # : $ \` \\`。无效的 trigger 会关闭展开、只警告一次，并且绝不会回退到 `.`。

空字符串 trigger 会关闭展开和高亮，片段只能通过 `/snippets` 使用。

## 匹配

匹配区分大小写，使用 `u` 标志。只有已启用且未被覆盖的片段 key 会参与匹配。

边界与宿主的高亮边界一致，保证发光的词就是会被展开的词：

```text
左边界：(?<![\p{L}\p{N}_./\\-])(?<!::)
右边界：(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()
```

补充规则：

- 只在正文区域匹配。文本先经过 `@oh-my-pi/pi-tui/prompt/markdown-prose` 的 `maskNonProse` 处理，它会在保持长度不变的前提下把行内代码、围栏代码块以及 XML 或 HTML 片段替换为空白。只有落在正文中的匹配才会展开。
- 去掉首尾空白后以 shell 或 Python 标记（`!`、`$`）开头的文本会整体跳过展开。
- 展开只做一遍，正文不会再次展开。
- 每次展开在状态文件中记一次使用。

### 转义

紧贴触发词前面的反斜杠会使该触发词保持原样。只有在其后内容本会匹配已有 key 时，反斜杠才会从发送的文本中去掉。例如 `\.review.` 发送的是 `.review.`。

## 设置

插件的设置来自 `omp.settings`，每次使用时都通过 `getPluginSettings("wows-omp-plugin-snippets", cwd)` 读取。

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `trigger` | 字符串 | `"."` | 字面触发前缀。为空时关闭展开和高亮。 |
| `matching` | `"closed"` \| `"open"` | `"closed"` | 触发词的形式。 |

插件没有替换模式设置。展开始终在发送时进行。

## 发送时展开

展开在扩展的 `input` 事件（`pi.on("input", ...)`）中进行，返回 `{ text }`。它适用于 `interactive` 和 `rpc` 来源，来源为 `extension` 的文本从不展开。

存储会在会话启动、每次 `input` 事件以及每次控制台修改后重新加载。每次重新加载后，以及 `session_start` 和 `session_switch` 时，都会重新注册高亮。

高亮通过 `@oh-my-pi/pi-tui/prompt/magic-keywords` 中的 `setMagicKeywords` 注册，与 `@oh-my-pi/pi-coding-agent/modes/magic-keywords` 中 `MAGIC_KEYWORDS` 提供的宿主关键词并列。片段触发词使用色相 `190` 和 `290`。

## 控制台、表单和对话框

控制台和表单都是插件组件。Tern 使用原生版本，终端使用分栏控制台和带边框的表单。

- 宿主支持 `picker` 时，Tern 中的控制台是原生 `picker` 面板，预览位于列表下方。不支持的宿主使用通用原生布局。终端保留分栏视图。
- 表单是 `SnippetForm`，原生浮层角色为 `omp.overlay.snippets.form`。它输出草稿：`key`、`scope`、`description` 和 `body`。只有获得焦点的文本字段是可编辑的输入框，因此光标跟随键盘。
- 保存时，命令用 `formatSnippetSource(description, body)` 格式化草稿，并通过 `store.write` 写入。修改 key 时先用 `store.rename` 重命名并保留状态，正文有变化再写入。
- 没有自定义 UI（`ctx.mode` 不是 `tui`，或没有 `ctx.ui.custom`）时，同样的草稿来自 `ctx.ui.input`、`ctx.ui.select`（仅新建时选择范围）和 `ctx.ui.editor`（正文）。任何路径都不会显示 frontmatter。

## 状态文件

个人状态保存在仓库之外：

```text
<agent 目录>/wows-omp-plugins/snippets/state.json
```

版本 1 的结构：

```json
{
  "version": 1,
  "entries": {
    "global:<key>": { "disabled": true, "pinned": true, "uses": 3 },
    "workspace:<工作区绝对路径>:<key>": { "uses": 1 }
  }
}
```

- `id` 为 `global:<key>` 或 `workspace:<工作区绝对路径>:<key>`。
- `disabled`、`pinned` 和 `uses` 都是可选字段。缺失时分别视为 `false`、`false` 和 `0`。
- 文件不存在时视为空状态。文件损坏时同样视为空状态并发出警告，插件不会静默覆盖损坏的文件。

## 问题报告

每次加载都会报告问题，包括无法读取的文件、无效的 key、错误的 frontmatter 以及损坏的状态文件。问题会以控制台持久警告行（首个问题加数量）显示，也会出现在无界面的列表中。通知在有 UI 时使用 `ctx.ui.notify`，否则作为显示消息发布。问题不会阻止其他片段展开。
