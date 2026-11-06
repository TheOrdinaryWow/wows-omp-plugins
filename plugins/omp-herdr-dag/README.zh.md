<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omp-herdr-dag-dark.png">
  <img alt="omp-herdr-dag" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omp-herdr-dag-light.png">
</picture>

# omp-herdr-dag

[English](README.md) | 简体中文

> 在 Herdr 侧边窗格里用一张实时图看 OMP 在做什么：待办、计划，以及每个正在干活的子代理。

代理处理一长串待办、执行已批准的计划，或者同时跑很多子代理时，单看对话很难弄清进展。如果你在 Herdr 终端复用器里运行 OMP，这个插件会在旁边打开一个窗格，显示一张实时的依赖图：哪些做完了，哪些在进行，哪些在等谁；每个子代理正在用的工具、最近的输出、模型和费用也都能看到。它也会显示 `omo-prometheus` 的 Atlas 计划。窗格只负责看，从不启动工作、完成待办或修改计划。

## 安装

```bash
omp plugin install omp-herdr-dag@wows-omp-plugins
```

需要：

- OMP 18.17.0 或更高版本，并在 Herdr 的窗格中以交互方式启动；
- `PATH` 中有 `herdr` 命令；
- Bun：`PATH` 中有 `bun`，或者在 `viewerRuntime` 中指定。

支持 Linux。macOS 使用同一套代码，但没有测试过。不支持 Windows。安装后重启 OMP。

## 快速上手

使用默认设置时，已批准的计划开始执行时窗格会自动打开。随时可以手动打开或关闭：

```text
/dag-pane          # 切换
/dag-pane open
/dag-pane close
```

在窗格中，用方向键在节点之间移动，Enter 展开节点，`t` 切换到 Tasks 视图，`o` 查看子代理的对话记录，`?` 查看帮助。

## 用法

### 窗格什么时候打开

`displayTiming` 决定窗格何时自动打开：

| 值 | 在什么时候打开 |
| --- | --- |
| `never` | 从不自动打开，用 `/dag-pane` 手动打开。 |
| `any-todo` | 任何待办列表、已批准的计划或 Atlas 计划。 |
| `plan-execution`（默认） | 你在 Plan Mode 中批准的计划，或 Atlas 计划。 |
| `atlas-only` | 只在有 Atlas 计划时。 |

只有子代理在运行时不会打开窗格。用 `q` 或 `/dag-pane close` 关闭后，这一轮内它不会再打开；新的一轮开始或执行 `/dag-pane open` 时会重新出现。`/new` 和切换会话会继续使用同一个窗格。

### 看懂这张图

每一轮按来源着色：

| 来源 | 颜色 | 显示内容 |
| --- | --- | --- |
| 待办列表 | 蓝色 `#4f8cff` | 待办阶段形成横向分组。阶段之间的虚线表示先后顺序，不表示依赖。 |
| 计划执行 | 紫色 `#a371f7` | 你在 Plan Mode 中批准计划后的第一份待办列表。 |
| Atlas | 绿色 `#3fb950` | `omo-prometheus` 的计划：任务、新发现的工作、修复、最终评审和交付，以及它们真实的依赖关系。 |

节点图标使用你的 OMP 主题颜色：

| 图标 | 状态 |
| --- | --- |
| `○` | 等待中 |
| `◐` | 进行中 |
| `✔` | 已完成 |
| `✖` | 失败 |
| `⊘` | 被阻塞 |
| `⊖` | 已放弃 |

实线表示依赖，选中节点的连线会加粗显示。点线表示修复关系和指向前面的依赖（标为 `↑ after <label>`）。为了让图保持清晰，如果一条更长的路径已经表达了同样的先后顺序，就隐藏这条线；按 `e` 可以显示全部连线。底部始终列出选中节点直接依赖的节点。

按 `p` 高亮关键路径，也就是按耗时计算最长的那条依赖链；按 `c` 折叠已完成的层。

如果某个进行中节点的子代理超过 `stalledAfterSeconds` 没有进展，它会被标为 `stalled`。子代理失败不会把对应的待办或计划任务标为失败。

### 任务和对话记录

Tasks 视图（`t`）列出主会话启动的所有子代理，显示它当前的工具和参数、最近的输出、模型、重试次数、耗时、token 和费用（以 OMP 提供的为准）。子代理会挂在它启动时正在进行的那个待办下面。缺少的数字显示为缺失，从不显示为零。

在某个任务或挂有子代理的节点上按 `o`，可以查看它的对话记录：它的消息、工具调用以及结果的简短预览。

### 查看器按键

| 按键 | 操作 |
| --- | --- |
| `q`、Ctrl+C | 退出并关闭窗格。 |
| `t` | 在依赖图和 Tasks 之间切换；在对话记录中按下时，切换到另一个主视图。 |
| `h` | 显示或隐藏上一份待办列表（只保留一份）。 |
| `[` / `]` | 上一轮 / 下一轮。 |
| Tab | 让方向键在选择节点（`NODES`）和移动视图（`PAN`）之间切换。 |
| 方向键、`j` / `k` | 选择最近的节点、移动视图、在任务之间移动，或滚动对话记录。 |
| PgUp / PgDn | 按页浏览节点、任务或对话记录。 |
| Enter | 展开或折叠选中的节点或任务。 |
| `c` | 折叠已完成的层。 |
| `p` | 高亮关键路径。 |
| `e` | 显示全部依赖连线。 |
| `f` | 跳到下一个进行中的节点。 |
| `o` | 打开选中子代理的对话记录。 |
| Esc | 离开对话记录或关闭帮助。 |
| `?` | 帮助。 |

鼠标也可以用：滚轮滚动，Shift+滚轮横向滚动，单击选中节点，双击打开对话记录。查看器运行时，直接拖动不再选中文字；大多数终端里按住 Shift 再拖动即可选择。

### 待办之间的真实依赖

默认情况下，这张图只知道待办阶段的先后顺序。代理也可以说明哪个待办要等哪个，图上就会画出这些依赖。你可以直接要求（“把待办之间的依赖标出来”），也可以交给代理自己决定。依赖从不根据措辞猜测。指向不存在的任务、指向自己或者形成环的依赖会被丢弃，并给出 `Herdr DAG edges:` 警告，但待办本身的改动照常生效。用 `todoDependencies: false` 可以关掉这项功能。

### 窗格放在哪里

窗口较宽时，窗格放在 OMP 右边；窗口较高时，放在下面。窗口形状改变后，插件会移动窗格。两种形状下的位置和大小都可以分别设置。

OMP 退出时窗格也会关闭。设置 `finishBehavior: keep-open` 后，它会保持打开，显示已断开连接，并不断尝试重新连接。

## 设置

为当前用户修改设置：

```bash
omp plugin config set wows-omp-plugin-omp-herdr-dag displayTiming any-todo
omp plugin config set wows-omp-plugin-omp-herdr-dag landscapeSize 0.3
omp plugin config list wows-omp-plugin-omp-herdr-dag
```

只想在某个项目里改，就在该项目的 `.omp/plugin-overrides.json` 中写上：

```json
{ "settings": { "wows-omp-plugin-omp-herdr-dag": { "displayTiming": "atlas-only" } } }
```

设置在启动、切换会话以及每次执行 `/dag-pane` 命令时读取。位置、大小和颜色的修改会在下次打开窗格或图更新时生效。值无效时会回退到默认值，并给出警告。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `displayTiming` | `plan-execution` | 窗格何时自动打开：`never`、`any-todo`、`plan-execution` 或 `atlas-only`（见上文）。 |
| `finishBehavior` | `close-with-omp` | `close-with-omp` 表示 OMP 退出时关闭窗格；`keep-open` 表示保持打开并尝试重连。 |
| `landscapePosition` | `right` | 窗口较宽时窗格的位置：`left`、`right`、`top` 或 `bottom`。 |
| `portraitPosition` | `bottom` | 窗口较高时窗格的位置：`left`、`right`、`top` 或 `bottom`。 |
| `landscapeSize` | `0.35` | 窗口较宽时窗格所占的比例，范围 0.15 到 0.6。 |
| `portraitSize` | `0.4` | 窗口较高时窗格所占的比例，范围 0.15 到 0.6。 |
| `followOrientation` | `true` | 窗口在宽和高之间变化时移动窗格。 |
| `focusPane` | `false` | 窗格打开时把键盘焦点放到窗格上。 |
| `stalledAfterSeconds` | `90` | 子代理多少秒没有进展就把任务标为停滞，范围 10 到 900。 |
| `todoDependencies` | `true` | 允许代理声明待办之间的依赖。关掉后待办本身照常工作。 |
| `atlasIntegration` | `true` | 显示 `omo-prometheus` 的 Atlas 计划。 |
| `followTheme` | `true` | 跟随 OMP 主题的变化。 |
| `colorTodo` | `#4f8cff` | 待办这一轮的颜色（`#rrggbb`）。 |
| `colorPlan` | `#a371f7` | 计划这一轮的颜色（`#rrggbb`）。 |
| `colorAtlas` | `#3fb950` | Atlas 这一轮的颜色（`#rrggbb`）。 |
| `retentionDays` | `14` | 会话启动时，删除超过这么多天的会话所留下的本插件文件，范围 1 到 365。 |
| `layoutAlign` | `centered` | `centered` 让图在窗格中居中；`left` 让图靠左排列。 |
| `viewerRuntime` | 空 | 查看器使用的 Bun 可执行文件。为空表示在 `PATH` 中查找 `bun`。 |

## 与其他插件配合

**omo-prometheus**：当本插件的 `atlasIntegration` 和 Prometheus 的 `herdrDag` 设置都开启时（默认如此），它的 Atlas 计划会以绿色显示。分组顺序为 Tasks、Discovered、Fixes、Final gates、Delivery，任务会显示 LIGHT 或 HEAVY 等级以及是否已验证。显示 Atlas 计划期间，对应的待办阶段（`Atlas tasks`、`Atlas discovered`、`Atlas fixes`、`Atlas final gates`、`Atlas delivery`）不会出现在蓝色的待办视图中，避免同样的工作出现两次。

## 已知限制

- 只能在 Herdr 中使用，不支持 Windows。
- 子代理再启动的子代理只显示为标有 `activity unavailable` 的状态卡片，看不到它们的工具、输出或用量。
- 升级插件后，必须重启 OMP 才能再次打开窗格。插件会提示你这一点；已经打开的窗格可以继续使用。
- 显示的数字和对话记录取决于 OMP 报告了什么。
- 如果 OMP 在刚创建窗格后崩溃，可能会留下一个孤立的窗格。插件会发出警告，但从不关闭不是它创建的窗格，请手动关闭。
- 插件的本地文件可能包含任务描述、工具参数、输出片段、错误信息和本地路径。请像对待会话数据一样对待它们。

## 更多细节

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍了窗格在什么条件下运行（包括 RPC、ACP 和无界面会话）、如何识别计划执行、图的布局和窗格位置规则、待办依赖的格式、与 omo-prometheus 的接口，以及本地文件。

## 许可证

MIT。本插件是 [jc01rho/omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag) 的改进移植，参考的修订版本为 `a093cdf5da96e28dfe50348965d9f3bafb1c9531`。上游的版权和许可声明保留在 [NOTICE](NOTICE) 中；本插件的许可证见 [LICENSE](LICENSE)。
