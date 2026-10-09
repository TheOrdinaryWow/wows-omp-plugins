# omo-prometheus

[English](README.md) | 简体中文

[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（OmO）的 Prometheus 规划与 Atlas 执行在 OMP 上的移植。Prometheus 会一直向你提问，直到能写出值得批准的计划。批准后，Atlas 负责执行：把每个任务委派给子代理，为每个任务记录经过验证的证据，并在宣布计划完成前运行四个独立的验证关口。进度在会话之间共享，一个会话停下的地方，另一个会话可以接着做。

插件基于 OMP 原生的 Plan Mode 和批准流程，并增加了：

- Metis：在规划开始前检查意图和遗漏；
- Prometheus：只问会改变计划的问题；
- 可选的 Momus 和 Oracle 评审，找出计划中的阻塞性问题；Oracle 也可以就架构和高风险决策提供咨询；
- Atlas：执行者。

## 安装

```bash
omp plugin install omo-prometheus@wows-omp-plugins
```

需要 OMP 18.3.5 或更高版本；规划还需要启用 Plan Mode（`plan.enabled`，默认开启）。安装后重启 OMP。

如果你用过旧的 `prometheus` 插件，请先用 `omp plugin uninstall prometheus@wows-omp-plugins` 卸载。它的会话状态不会迁移过来，需要重新制定计划。

## 快速上手

```text
/prometheus add rate limiting to the public API
```

1. Prometheus 进入 Plan Mode，先咨询 Metis，然后向你提问。一直回答，直到它提出计划。
2. 审阅提案，并通过 OMP 正常的批准对话框批准。两个批准选项都会交给 Atlas 执行。
3. Atlas 会自行开始执行。编辑器上方的小组件显示进度；`/atlas` 打开完整视图。
4. 所有任务和四个最终关口都通过后，计划即完成。随时可以用 `/atlas exit` 退出 Atlas。

## 用法

### 规划

`/prometheus` 会进入 Plan Mode；如果已经在 Plan Mode 中，则升级为 Prometheus。可以在命令后直接写需求，也可以在下一条消息里描述。规划期间再次运行 `/prometheus` 会同时退出 Prometheus 和 Plan Mode。

在普通的 `/plan` 模式下，小而明确的需求仍走 OMP 的常规流程。遇到大型、跨模块或含糊的目标时，规划者会询问是否切换到 Prometheus；同意后，会话即进入同一套工作流。

计划写在 `local://` 会话产物中，并通过 OMP 的批准流程提交。如果开启了 OMP 的计划自动保存，批准后的副本还会保存在 `.omp/plans/` 下。

`reviewLevel`（见[设置](#设置)）决定提案前由 Momus 单独评审，还是由 Momus 和 Oracle 一起评审。

原版说明见 OmO 文档：[Planning: the Ultrawork Planner](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#planning-the-ultrawork-planner)。在本插件所基于的版本中，Prometheus 叫作 Ultrawork Planner，通过 `/ulw-plan` 启动。

### 计划格式

每份计划都以两个机器可读的章节结尾。任务是从 `T1` 开始编号的复选框行，每行带有 `Agent:`、`Depends on:` 和 `Acceptance:`：

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

Prometheus 会为每个任务分配会话 `task` 工具中最专门的代理，优先使用 `omo-toolkit` 的代理，而不是通用的 `task` 或 `sonic`。如果执行时某个代理不存在，Atlas 会尝试它的回退代理（大多回退到 `task`），再不行就从当前列表中挑最合适的，不需要你重新批准计划。

### 执行

批准后，主会话变成 Atlas。Atlas 自己不改文件：插件会在父会话中屏蔽实现类工具（`bash`、`eval`、`edit`、文件写入等），所以每个任务都通过 `task` 交给子代理。只读工具，以及 `task`、`todo`、`ask` 等协调类工具仍然可用。

Atlas 用账本跟踪计划。只有拿到子代理真实最终结果作为证明，任务才会被标记为完成；在计划文件里勾选复选框不算数。任务按依赖顺序执行；依赖关系中有环的计划会在执行前被拒绝。

如果 Atlas 停下时还有未完成的任务，插件会推动它继续，你每发一条消息最多推动八次。连续两次推动都没有进展时，循环停止并通知你。

如果账本或计划文件缺失、损坏，或者与批准的计划不一致，Atlas 会暂停，等你处理：恢复这些文件，或者用 `/atlas exit` 退出后重新批准修改过的计划。

执行期间，Atlas 会让会话的待办列表与计划保持同步（任务、修正和最终关口），并把会话重命名为以“Atlas”开头的标题，除非你自己起过名字。

原版说明见 OmO 文档：[Execution: /ulw-execute](https://github.com/code-yeongyu/oh-my-openagent/blob/fe427efeed97e95f009dc6ca7fb17a3ac857f79f/docs/guide/orchestration.md#execution-ulw-execute)。在该版本中，Atlas 执行对应的是 `/ulw-execute`。

### 最终关口

所有任务完成后，Atlas 会并行运行四个验证关口，每个都在一个没参与过这份计划的全新子代理上执行：

| 关口 | 代理 | 检查内容 |
| --- | --- | --- |
| F1. Plan compliance review | `momus`（回退 `reviewer`） | 根据计划、账本和计划期间的 Git 历史，检查改动是否符合批准的计划 |
| F2. Code quality review | `deep-high`（回退 `task`） | 可维护性、范围、测试价值，以及有证据支撑的阻塞问题 |
| F3. Real-surface QA | `deep-low`（回退 `task`） | 实际运行计划 Verification 章节中的每个场景 |
| F4. Success-criteria fidelity | `deep-high`（回退 `task`） | 每条列明的成功标准和对抗性用例，都要对应到证据 |

每个关口返回结构化的 `PASS`、`FAIL` 或 `INCONCLUSIVE`；只有结构化的 `PASS` 才算通过。关口失败时，Atlas 会添加修正行（`X1`、`X2`……），像普通任务一样执行，然后只重跑这个关口。已完成的任务和已通过的关口保持不变。

### `/atlas` 命令

```text
/atlas                          # inactive: open Atlas Dispatch; active: open the running plan's view
/atlas <plan-name-or-id>        # enter a plan in this session and start executing
/atlas start <plan-name-or-id>  # same as above
/atlas list                     # list approved plans with their status
/atlas show <plan-name-or-id>   # show a plan's rows, acceptance and evidence
/atlas resume <plan-name-or-id> # switch to a session that already ran the plan
/atlas rename <id> <new name>   # change a plan's display label
/atlas delete <id> [--yes]      # delete a plan and its evidence
/atlas exit                     # leave Atlas (asks first if the plan is unfinished)
```

除了裸 `/atlas` 和 `exit`，其他子命令只能在 Atlas 未激活时使用。要换计划，先退出。计划可以按显示名称、原始名称，或去掉 `-plan` 后缀的任一名称匹配；重名时请用完整 ID。名称以子命令单词开头的计划，仍可以通过 ID 或 `/atlas start` 选中。

Atlas Dispatch 列出当前工作区中未完成的计划；按 Tab 显示所有计划，包括已完成、无效和其他工作区的计划，但只能查看。

| 按键 | 操作 |
| --- | --- |
| 直接输入 | 模糊搜索名称、ID 或状态 |
| Enter | 立即开始执行选中的计划 |
| Space、Shift+I | 打开全屏计划视图 |
| Shift+R | 在已执行过该计划的会话中恢复 |
| Backspace、Delete | 编辑搜索内容；搜索为空时按 Backspace，或任何时候按 Delete，删除计划 |
| Shift+N | 修改显示名称 |
| Esc | 关闭 |

在非空会话中开始计划时，会询问使用新会话还是当前会话。之后 Atlas 会自己发出第一条执行消息。

Atlas 激活时，裸 `/atlas` 打开一个实时只读视图，显示每一行的状态、正在运行的子代理及其模型、当前工具和用量，按 Tab 可查看时间线。Shift+X 退出 Atlas，Esc 关闭视图。编辑器上方的小组件可以通过 `atlasWidget` 关闭。

### 在另一个会话中继续

计划及其证据不属于任何单个会话，而是保存在你的 OMP 会话目录中。会话 A 完成一部分后退出，会话 B 可以用 `/atlas <name>` 接着做，只要两者使用同一个会话目录和工作区。Shift+R 或 `/atlas resume` 则是切回曾经执行过该计划的会话；切回后处于 Atlas 模式，等待你发下一条消息。

同一时间只有一个会话能执行某个计划。退出会立即释放计划，但不会取消正在运行的子代理，也不会把工作标记为完成。子代理还在运行时，它所在的会话会一直持有计划，直到子代理报告最终结果。

升级插件后，已有计划无需重新批准即可继续执行。

### 模型

Metis、Oracle 和 Momus 使用 OMP 的 `@slow` 角色。Atlas 在主会话中运行；插件注册了一个 `atlas` 模型角色，可以在 `/model` 中指定：

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

Prometheus 提案等待批准时，批准滑块也会提供 `atlas`；滑块默认停在 `default`，要用这个角色执行，请把它移到 `atlas`。`/atlas <plan>` 在指定了 `atlas` 角色时会切换过去，否则保持当前模型。这个角色不在 Ctrl+P 的轮换中。

## 设置

`omp plugin config` 使用的包名：`wows-omp-plugin-omo-prometheus`。

```bash
omp plugin config list wows-omp-plugin-omo-prometheus
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
```

| 设置 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `reviewLevel` | `off` \| `ask` \| `standard` \| `high-accuracy` | `ask` | 提案前的计划评审。 |
| `atlasWidget` | boolean | `true` | Atlas 执行时在编辑器上方显示进度小组件。 |
| `herdrDag` | boolean | `true` | 向 `omp-herdr-dag` 查看器发布 Atlas 进度。 |

评审级别：

- `ask`：每份计划都由 Momus 评审。你要求高精度，或工作不简单且不清晰时，由 Momus 和 Oracle 一起评审；工作清晰时会让你选一次。
- `standard`：每份计划都由 Momus 评审；明确要求时仍会加上 Oracle。
- `high-accuracy`：始终由 Momus 和 Oracle 一起评审。
- `off`：不做 Momus 或 Oracle 评审，即使你要求也不做。Metis 仍会运行，Atlas 也仍会运行 F1 合规关口。

用户设置会与项目覆盖合并。设置在会话启动时读取，修改后请重启会话。

## 与其他插件配合

- `omo-toolkit`：计划优先使用它的分类代理，F2、F3、F4 三个关口运行在 `deep-high` 和 `deep-low` 上。
- `judge-dispatch`：计划执行期间不改派任何调用，也从不改派 `metis`、`momus` 或 `oracle`。
- `omp-herdr-dag`：以实时依赖图显示 Atlas 的任务、修正和关口。
- `roadmap`：在绑定了路线图阶段时提出的计划会记住该阶段。Atlas 执行期间可以使用路线图工具；计划完成后，会话会收到提醒，用关口证据关闭该阶段。阶段不会被自动关闭。
- [Magic Context](https://github.com/cortexkit/magic-context)：它的 `ctx_*` 工具在 Atlas 中保持可用。

## 不使用终端界面时

| 宿主 | `/atlas` 的行为 |
| --- | --- |
| RPC（`--mode rpc`、rpc-ui） | Atlas Dispatch 变为一系列选择对话框（先选计划，再选 Start、Resume、View details、Rename、Delete 或 Back）。小组件以文本行发送。 |
| ACP 编辑器 | 通过表单征询显示相同的对话框。不显示小组件。 |
| SDK、`--no-ui`、print | 没有对话框，请使用子命令。删除需要 `--yes`。`/atlas resume` 只能在唯一执行过该计划的会话中使用；否则它会列出应该打开的会话。 |

Prometheus 规划需要 Plan Mode 的交互式批准，所以只能在 TUI、RPC 和 ACP 中运行。

客户端程序可以从状态快照读取规划和执行状态，见[参考文档](REFERENCE.zh.md#状态快照)。

## 已知限制

- Atlas 需要基于文件的会话，且所在本地文件系统支持硬链接、原子重命名以及文件和目录同步。会话存储在内存中或只在远端时，Atlas 会拒绝运行。会话目录不同的会话看不到彼此的计划。
- 有些 OMP 版本无法可靠地告知子代理是否已完全结束。这时计划会一直由其会话持有，直到该 OMP 进程退出；关闭它之后再开新会话。
- 在共享账本之前的版本中执行的计划无法恢复，需要重新批准。
- Atlas 父会话中禁用了 `checkpoint` 和 `rewind`，因为回退会让会话脱离已完成任务的证明。
- 来自其他扩展和 MCP 服务器的工具在 Atlas 父会话中会被屏蔽，参考文档中列出的除外。

## 参考

[REFERENCE.zh.md](REFERENCE.zh.md) 介绍 Atlas 工具守卫、计划包与账本、所有权、状态快照，以及与 `omp-herdr-dag` 和 `roadmap` 的事件契约。

## 许可证

Prometheus、Metis、Oracle、Momus 和 Atlas 的提示词资源是 OmO 的修改衍生作品；`NOTICE` 记录了上游仓库、固定的修订版本、早期 fork 历史和修改声明。

扩展代码和原创打包部分采用 MIT 许可证（`LICENSE-MIT`）。`agents/`、`assets/` 和 `skills/prometheus/` 下的衍生提示词资源仍适用上游的 Sustainable Use License 1.0（`LICENSE-SUL-1.0`），允许内部商业使用、个人使用和非商业使用，仅允许出于非商业目的免费分发。
