<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/snippets-dark.png">
  <img alt="snippets" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/snippets-light.png">
</picture>

# snippets

[English](README.md) | 简体中文

> 输入 `.review.` 再发送，发出去的就是你保存好的审查清单。

把经常要发的文字存成小小的 Markdown 文件，比如代码审查清单、bug 报告模板或项目说明。在消息里输入片段的触发词，发送时它就会被换成保存的内容。`/snippets` 让你不离开 OMP 就能浏览、插入、发送、新建和编辑片段。片段都是普通文件，也可以手动修改；置顶和使用次数这些个人数据不会进入你的仓库。

## 安装

```bash
omp plugin install snippets@wows-omp-plugins
```

需要 OMP 18.19.0 或更高版本。安装后开一个新会话。

## 快速上手

1. 在 `~/.omp/agent/snippets/review.md` 创建一个片段：

   ```markdown
   ---
   description: 代码审查清单
   ---
   代码审查清单：
   - 改动是否符合描述的目标？
   - 边界情况和错误路径是否处理？
   - 新行为是否有测试？
   - 命名是否清楚，是否删除了无用代码？
   - 是否泄露密钥或记录了敏感数据？
   ```

2. 在会话里输入一条包含 `.review.` 的消息并发送。代理收到的是这份清单，聊天记录里显示的也是清单。
3. 运行 `/snippets` 查看所有片段。

## 用法

### 片段放在哪里

| 范围 | 位置 | 适合放 |
|---|---|---|
| 全局 | `~/.omp/agent/snippets/<key>.md` | 每个项目都会用到的文字 |
| 工作区 | `<项目>/.omp/snippets/<key>.md` | 只属于某个仓库的文字 |

key 就是去掉 `.md` 的文件名，只能用字母、数字、`_` 或 `-`，最长 64 个字符。工作区片段和全局片段 key 相同时，以工作区片段为准，全局片段在 `/snippets` 里会标为“已覆盖”。

片段文件的内容就是要发送的文字。文件开头也可以加一段 frontmatter，写一行 `description`，像上面的例子那样。手动修改的内容会在你下次发送消息或打开 `/snippets` 时生效。插件读不了的文件会被跳过，并在 `/snippets` 里列为问题，其他片段照常可用。

### 在消息里使用片段

按默认设置，片段 `review` 的触发词是 `.review.`。把它写在消息的任何位置，发送时就会换成片段内容。输入时文字不会变，不过编辑器会让触发词发光，方便你看出哪些会被展开。

触发词只有在普通文字里单独出现时才会展开：

- 它必须是一个独立的词。`file.review.bak` 和 `x.review.` 会保持原样。
- 行内代码、代码块以及 HTML 或 XML 片段里的内容不会展开。
- 以 `!` 或 `$` 开头的行（shell 和 Python 命令）会原样发送。

想发送触发词本身，就在前面加一个反斜杠：`\.review.` 发出去的是 `.review.`。

### 用 `/snippets` 浏览和管理片段

`/snippets` 打开一个控制台，一边是片段列表，一边是预览。置顶的片段排在最前，其次是用得最多的。预览会显示片段内容、触发词（没有触发词时显示“仅菜单”）、文件位置，以及片段是否被覆盖或停用。在 Tern 中，控制台以原生面板打开，同样的操作都放在操作栏里。

| 按键 | 操作 |
|---|---|
| 上 / 下、Home / End | 选择片段 |
| PgUp / PgDn、鼠标滚轮 | 滚动预览 |
| Tab / Shift+Tab | 在“全部”“全局”“工作区”之间切换 |
| 字母和数字 | 按 key、描述和内容搜索，输入的每个词都要匹配 |
| 左 / 右、Backspace、Delete | 编辑搜索文字 |
| Esc | 先清空搜索，再关闭控制台 |
| Enter | 把片段插入到编辑器光标处。还没有片段时，新建一个。 |
| Shift+S | 立即发送片段 |
| Shift+N | 新建片段 |
| Shift+E | 编辑片段。修改 key 会重命名文件。 |
| Shift+D | 停用或启用片段 |
| Shift+P | 置顶或取消置顶 |
| Shift+X | 删除片段，删除前会让你确认 |

大写的 S、E、D、P、X、N 等同于对应的 Shift 快捷键，其他大写字母会输入到搜索框。

### 新建或编辑片段

Shift+N 和 Shift+E 会打开一个表单，包含四个字段：Key、范围（全局或工作区）、描述（可选，一行）和正文（片段内容）。文件由表单替你写好，frontmatter 也不用自己写。Tab 和 Shift+Tab 在字段间移动，在正文里按 Enter 换行，Ctrl+S 保存，Esc 取消。key 会在输入时检查，所选范围里已经用过的 key 会提示错误。编辑已有片段时不能修改范围。重命名片段会保留它的置顶、停用状态和使用次数。

### 命令

| 命令 | 作用 |
|---|---|
| `/snippets` | 打开控制台 |
| `/snippets <key>` | 把片段放进编辑器 |
| `/snippets send <key>` | 把片段作为你的消息发送 |
| `/snippets list` | 把片段列表作为消息发出 |

这些命令只能找到已启用且没有被覆盖的片段。`send` 和 `list` 是子命令，所以名为 `send` 或 `list` 的片段无法这样调用，需要改名。

### 置顶和使用次数

每次展开、插入或发送都算一次使用。置顶、停用状态和使用次数保存在 `~/.omp/agent/wows-omp-plugins/snippets/state.json`，不在项目目录里，所以不会出现在提交中。

## 设置

为当前用户修改设置：

```bash
omp plugin config set wows-omp-plugin-snippets trigger "?"
omp plugin config set wows-omp-plugin-snippets matching open
omp plugin config list wows-omp-plugin-snippets
```

只想在某个项目里改，就在该项目的 `.omp/plugin-overrides.json` 中写上：

```json
{ "settings": { "wows-omp-plugin-snippets": { "trigger": "?", "matching": "open" } } }
```

修改会在你下次发送消息或打开 `/snippets` 时生效。

| 设置 | 默认值 | 作用 |
|---|---|---|
| `trigger` | `.` | 触发词开头的字符或文字。不能包含空格，也不能包含 `/ ! @ ^ # : $ \` \\` 中的任何字符；值无效时会提示一次，并关闭展开。设为空也会关闭展开和高亮，这时只能通过 `/snippets` 使用片段。 |
| `matching` | `closed` | `closed` 表示触发词结尾也带一个 trigger（`.review.`）；`open` 表示结尾不带（`.review`）。 |

例如，把 `trigger` 设为 `?`、`matching` 设为 `open` 后，输入 `?review` 就会展开。

## 与其他插件配合

snippets 可以单独使用，不需要其他插件。

## 已知限制

- 片段只在发送时展开，在那之前编辑器里的触发词保持原样。
- 编辑器里的高亮可能在 OMP 更新后失效，但展开不受影响。
- 在终端里从控制台插入较长的片段时，编辑器可能把它显示成一个粘贴标记。可以改用 `/snippets send <key>` 发送，或者发送前检查一下内容。
- `/snippets <key>` 需要带编辑器的客户端，其他环境请用 `/snippets send <key>`。

## 更多细节

[REFERENCE.zh.md](REFERENCE.zh.md) 说明了准确的文件格式、匹配规则、插件在 Tern、RPC、ACP 和无界面会话中的表现，以及状态文件。

## 许可证

MIT。
