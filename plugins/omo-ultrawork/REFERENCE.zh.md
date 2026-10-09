# omo-ultrawork 参考

[English](REFERENCE.md) | 简体中文

## 关键词识别

- 关键词必须是独立的词，不区分大小写，并且不在行内代码、代码块、已注入的指令或提醒块以及斜杠命令中。
- 粘贴一个完整的 `<ultrawork-mode>…</ultrawork-mode>` 块会让会话进入触发状态，但不会重复注入指令。
- 子会话和扩展生成的消息会被忽略。
- 只有当 OMP 会响应 `orchestrate`（该关键词已启用且 `task` 工具可用）时，它才会阻止注入。

## 指令投递

开启持续模式时，指令的投递方式如下：

- 带参数（`/ultrawork fix X`）：指令排队，参数作为你的下一条消息发出；
- 空闲时不带参数：随你的下一条消息发出；
- 回合进行中：并入当前回合。

关闭模式时会排队一条隐藏的退出通知。持续模式下每条消息都会附带简短提醒，压缩之后则附带完整指令。只有在模式原本关闭时，`/ultrawork <request>` 才会提交请求。

处于触发状态时，第一次 `todo init` 或 `todo append` 会触发一条隐藏提醒，要求代理评估可独立进行的工作，并说明它的委派选择。压缩会重置这条提醒。

退出模式，或切换到未触发的会话时，页脚提示会清除。切换会话或关闭时，不会清除已触发会话中保存的状态。

## 各命令使用的代理

`/hyperplan`：范围评审（`skeptic`）使用 `task`，集成评审（`validator`）使用 `effort: "hi"` 的 `task`；如果列表中有 `deep-low`、`ultrabrain` 和 `artistry`，证据评审（`researcher`）、架构评审（`architect`）和替代方案评审（`creative`）分别使用它们。没有 `deep-low` 时，辩论不含证据评审，以四个角色进行；缺少 `ultrabrain` 或 `artistry` 时回退到 `task`。规划者使用 `ultrabrain`，没有时使用 `task`。

`/ulw-research`：机械性工作交给 `sonic`，有限判断交给 `task`，高强度工作交给 `effort: "hi"` 的 `task`。`scout` 负责本地发现，`librarian`（或 `scout`）负责来源调研，`writing`（或 `task`）负责校对；其他分类代理回退到 `task`。辅助脚本是 `assets/ulw-research/scripts/` 下无依赖的 Node CLI，按绝对路径调用。

`metis` 只在 Prometheus 规划中使用；规划之外，`momus` 只用于明确的 Atlas 合规检查。

需要完整评审的工作遵循其所属的计划。独立的合规、代码质量和真实界面 QA 报告可以并行进行，这些报告齐全后才启动最终的证据关口评审。轻量工作只做限定范围的自查和真实界面验证，不并行派评审。

## mass-ulw 持久化

状态保存在 `local://mass-ulw/<run-key>.json`，报告保存在 `local://mass-ulw/<run-key>/<id>.md`。两者在内核重置后都会保留，但已保存的 `running` 句柄无法重新接回 `wait`，必须先核对清楚才能继续分发工作。`done` 只表示子代理已返回。重试或修改部分节点时，其他节点的 `done` 报告保持不变。

## 状态快照

主会话会用共享的快照外层结构发布 `omo-ultrawork.json`（见[仓库参考文档](../../REFERENCE.zh.md)）：

```json
{ "kind": "omo-ultrawork/mode", "version": 1, "mode": true, "armed": true }
```

`mode` 是持续模式开关；`armed` 表示指令已经在会话上下文中。两者都为 false 时 `state` 为 `null`。快照会跟随恢复和分支导航更新。`mass-ulw` 文件和调研临时文件与快照无关。

没有 UI 时，命令反馈以 `wows-omp-omo-ultrawork.command-status` 类型的自定义消息送达。
