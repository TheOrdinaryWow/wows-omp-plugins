# 插件状态快照

[English](REFERENCE.md) | 简体中文

带工作流状态的插件会把状态写成 JSON 快照，路径为：

```text
<runtime dir>/plugin-state/<session id>/<plugin>.json
```

runtime dir 是 `$XDG_RUNTIME_DIR/wows-omp-plugins`；未设置 `XDG_RUNTIME_DIR` 时为 `<os tmpdir>/wows-omp-plugins-<uid>`。只有当前用户能读取。它位于项目和宿主会话存储之外，所以重启后快照不会保留。每次状态变化时，插件都会原子地替换文件。

所有快照使用同一个外层结构：

```json
{ "schema": "wows-omp-plugins/plugin-state", "version": 1, "plugin": "audit-goal", "sessionId": "…", "seq": 12, "updatedAt": "…", "state": { "kind": "audit-goal/audit", "version": 1 } }
```

会话 id 从 RPC `get_state` 的 `sessionId` 获取。内存会话（`--no-session`）同样会发布。`state: null` 表示插件在该会话中没有活动的工作流。

这些文件只供输出，插件自己不会读回。

| 插件 | 文件 | `state` 内容 |
| --- | --- | --- |
| `adr` | `adr.json` | [adr 参考文档](plugins/adr/REFERENCE.zh.md#状态快照) |
| `audit-goal` | `audit-goal.json` | [audit-goal 参考文档](plugins/audit-goal/REFERENCE.zh.md#状态快照) |
| `omo-prometheus` | `omo-prometheus.json` | [omo-prometheus 参考文档](plugins/omo-prometheus/REFERENCE.zh.md#状态快照) |
| `omo-ultrawork` | `omo-ultrawork.json` | [omo-ultrawork 参考文档](plugins/omo-ultrawork/REFERENCE.zh.md#状态快照) |
| `roadmap` | `roadmap.json` | [roadmap 参考文档](plugins/roadmap/REFERENCE.zh.md#状态快照) |

`judge-dispatch`、`omo-toolkit` 和 `omp-herdr-dag` 不发布快照。
