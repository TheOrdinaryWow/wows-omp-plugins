# Plugin state snapshots

English | [简体中文](REFERENCE.zh.md)

Plugins that hold workflow state write a JSON snapshot of it to:

```text
<runtime dir>/plugin-state/<session id>/<plugin>.json
```

The runtime dir is `$XDG_RUNTIME_DIR/wows-omp-plugins`, or `<os tmpdir>/wows-omp-plugins-<uid>` when `XDG_RUNTIME_DIR` is unset. Only the current user can read it. It lies outside the project and the host session store, so snapshots do not survive a reboot. The plugin replaces the file atomically on every change.

Every snapshot uses the same envelope:

```json
{ "schema": "wows-omp-plugins/plugin-state", "version": 1, "plugin": "audit-goal", "sessionId": "…", "seq": 12, "updatedAt": "…", "state": { "kind": "audit-goal/audit", "version": 1 } }
```

Take the session id from RPC `get_state` (`sessionId`). In-memory sessions (`--no-session`) publish too. `state: null` means the plugin has nothing active in that session.

The files are output only; the plugins never read them back.

| Plugin | File | Payload |
| --- | --- | --- |
| `adr` | `adr.json` | [adr reference](plugins/adr/REFERENCE.md#state-snapshot) |
| `audit-goal` | `audit-goal.json` | [audit-goal reference](plugins/audit-goal/REFERENCE.md#state-snapshot) |
| `omo-prometheus` | `omo-prometheus.json` | [omo-prometheus reference](plugins/omo-prometheus/REFERENCE.md#state-snapshot) |
| `omo-ultrawork` | `omo-ultrawork.json` | [omo-ultrawork reference](plugins/omo-ultrawork/REFERENCE.md#state-snapshot) |
| `roadmap` | `roadmap.json` | [roadmap reference](plugins/roadmap/REFERENCE.md#state-snapshot) |

`judge-dispatch`, `omo-toolkit` and `omp-herdr-dag` publish no snapshot.
