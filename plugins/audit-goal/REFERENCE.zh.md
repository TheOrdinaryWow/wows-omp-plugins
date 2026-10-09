# audit-goal 参考

[English](REFERENCE.md) | 简体中文

## 循环如何运行

- 审计开始时以及每次压缩之后，插件会以隐藏消息的形式注入审计协议和轮次账本。
- 插件在循环期间启用 `goal` 和 `audit_round` 工具；目标完成或被放弃后，再关闭由它启用的那些工具。
- 在 `audit_round` 记录下有效结论之前，模型无法通过 `goal({op:"complete"})` 完成目标，经由嵌套设备调用也不行。
- `audit-auditor` 和 `audit-fixer` 以阻塞调用派发，主代理会等每一批完成。在 `/audit` 运行之外、来自子代理、或通过 `eval` 的 `agent()` 派发它们时，插件会拒绝。
- 插件会拒绝任何超出实际通道上限的 `task` 调用。
- 如果最新的账本条目损坏，模型既不能完成目标，也不能派发保留代理。插件不会回退到更早的快照。
- 结果中的 `artifactAccepted` 始终为 `false`。
- headless 会话到达有限轮数上限时，会直接记录非交互式停止，不会询问。

## 状态快照

每次保存账本时，插件都会用共享的快照外层结构发布 `audit-goal.json`（见[仓库参考文档](../../REFERENCE.zh.md)）。从未运行过 `/audit` 的会话不会生成该文件。切换分支后如果会话里已没有审计账本，文件会被改写为 `state: null`。

| 字段 | 含义 |
| --- | --- |
| `kind`、`version` | `"audit-goal/audit"`、`1` |
| `status` | `running`；`awaiting-limit-decision`（已到有限轮数上限，等待用户选择）；`converged`；`saturated`；`stopped`；或 `invalid`（最新账本条目损坏或无法保存，此时没有其他字段） |
| `ended` | 审计目标完成、被放弃或被替换后为 `true` |
| `target`、`intensity`、`maxRounds`、`laneLimit`、`baseline` | 审计配置。不限时 `maxRounds` 和 `laneLimit` 为 `null`；不在 git 中时 `baseline` 为 `null` |
| `rounds[]` | `index`、`counts`（`critical`、`major`、`minor`、`picky`）、`rejected`、`loopInduced` 和 `verdict`（`continue`、`threshold-ready`、`cap-reached`，按当前轮数上限计算） |
| `totals` | 各轮计数之和，以及 `rejected` 和 `loopInduced` |
| `openFindings` | 未关闭发现按严重度的 `counts`，以及 `items[]`（`id`、`severity`、`summary`、`origin`） |
| `conclusion` | `null`，或包含 `kind`（`threshold-convergence`、`capability-saturation`、`stop`）、`reason` 和引用的 `evidence[]` |
| `stopReason` | 审计停止时为结论中的原因，否则为 `null` |
| `artifactAccepted` | 始终为 `false` |
