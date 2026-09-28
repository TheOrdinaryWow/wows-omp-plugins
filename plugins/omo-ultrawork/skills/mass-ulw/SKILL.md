---
name: mass-ulw
description: Decompose a large job into a dependency graph of self-contained child tasks and run it in waves through the eval kernel. Use when the user says mass ulw, mulw, or asks for a staged multi-agent fan-out.
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# mass-ulw: dependency-ordered child work

Use a graph only when real ordering exists: if every child is independent, use one ordinary `task` batch instead. One run covers one coherent stage, then its verified output informs the next stage's graph. Read `skill://mass-ulw/references/planning.md` in full before defining nodes; it defines topology, routing, write scopes, prompt contracts, and a verification frontier.

## Definition and durable state

A node has `{ id, prompt, agent, dependsOn?, label? }`; `agent` is an OMP agent listed in the task tool description (default `task`), not a model category. If `quick` is absent use `sonic`; if any other category agent is absent use `task`. `dependsOn` is ordering only, not data interpolation. The prompt must stand alone, with `TASK`, `DELIVERABLE`, `SCOPE`, `VERIFY`, and `STOP WHEN` sections. Give siblings disjoint write scopes. Verify ids are unique, all dependencies exist, and the graph is acyclic before spawning anything.

Create `local://mass-ulw/<run-key>.json` with `write`. Choose a stable short key for the current stage and fill this shape:

```json
{
  "key": "docs-refresh",
  "name": "Refresh the documentation",
  "nodes": [
    { "id": "audit", "agent": "quick", "prompt": "TASK: Audit docs for obsolete APIs. DELIVERABLE: A bounded file report. SCOPE: Read docs and src only. VERIFY: Cite current declarations. STOP WHEN: Every obsolete link is listed." },
    { "id": "rewrite", "agent": "writing", "dependsOn": ["audit"], "prompt": "TASK: Rewrite the identified pages. DELIVERABLE: Updated docs. SCOPE: Only docs pages named in the audit. VERIFY: Check links and examples. STOP WHEN: All named pages reflect current APIs." },
    { "id": "verify", "agent": "task", "dependsOn": ["rewrite"], "prompt": "TASK: Check all revised examples. DELIVERABLE: Captured command results. SCOPE: Read docs and build outputs; no edits. VERIFY: Run the documented examples. STOP WHEN: Every command is observed passing or a failure is reported." }
  ],
  "status": {
    "audit": { "state": "pending" },
    "rewrite": { "state": "pending" },
    "verify": { "state": "pending" }
  }
}
```

Every node's final result is stored at `local://mass-ulw/<run-key>/<id>.md`; a status record holds `state: pending|running|done|failed|skipped`, plus `handle` (`agent://…`), `resultPath`, or `error` when applicable. The run file is the source of truth; `read local://mass-ulw/<run-key>.json` shows its status after a kernel reset. Register the overall goal and its success criteria with `todo` before starting; the graph is complete only when the verification evidence proves them.

## Run in one Python eval cell

The kernel supplies synchronous `read`/`write`, `agent`, and `wait`. The following cell expects a definition already written as above. It records a wave before waiting, persists each child result, and skips transitive dependents of a failure. Substitute the real key before running:

```python
import json

key = "docs-refresh"
run_path = f"local://mass-ulw/{key}.json"
run = json.loads(read(run_path))
nodes = {node["id"]: node for node in run["nodes"]}
status = run["status"]
assert len(nodes) == len(run["nodes"])
assert all(set(node.get("dependsOn", [])) <= nodes.keys() for node in nodes.values())
assert all(node_id in status for node_id in nodes)

while True:
    changed = False
    for node_id, node in nodes.items():
        if status[node_id]["state"] != "pending":
            continue
        if any(status[dep]["state"] in ("failed", "skipped") for dep in node.get("dependsOn", [])):
            status[node_id] = {"state": "skipped", "error": "dependency failed"}
            changed = True
    if changed:
        write(run_path, json.dumps(run, indent=2) + "\n")

    ready = [node for node in run["nodes"] if status[node["id"]]["state"] == "pending"
             and all(status[dep]["state"] == "done" for dep in node.get("dependsOn", []))]
    if not ready:
        assert not any(row["state"] == "pending" for row in status.values()), "Cycle or unresolved running child"
        break

    handles = [agent(node["prompt"], agent=node.get("agent", "task"), label=node.get("label", node["id"])) for node in ready]
    for node, handle in zip(ready, handles):
        status[node["id"]] = {"state": "running", "handle": handle.handle}
    write(run_path, json.dumps(run, indent=2) + "\n")

    results = wait(handles, raise_errors=False)
    for node, result in zip(ready, results):
        node_id = node["id"]
        if isinstance(result, BaseException):
            status[node_id] = {"state": "failed", "handle": status[node_id]["handle"], "error": str(result)}
        else:
            result_path = f"local://mass-ulw/{key}/{node_id}.md"
            write(result_path, str(result))
            status[node_id] = {"state": "done", "handle": status[node_id]["handle"], "resultPath": result_path}
        write(run_path, json.dumps(run, indent=2) + "\n")

print({node_id: row["state"] for node_id, row in status.items()})
```

A cycle should be rejected before launching, not discovered by the final assertion. If the cell loses its live handles while status is `running`, inspect child output/artifacts and mark unverified nodes `failed` for an explicit retry; a JSON record alone cannot reattach an in-memory handle. `wait(handles, raise_errors=False)` isolates failed children so unaffected nodes can complete.

## Recovery and supervision

- **retry**: after the wave settles, edit the named `failed`/`skipped` status rows to `pending`, removing their `error` and stale `handle`; rerun the cell. Include skipped descendants whose failed ancestor you reset. Never rerun `done` nodes.
- **amend**: edit the node definition, reset only changed nodes and their transitive dependents to `pending`, then rerun the cell. Keep other `done` results and their paths. Tell the user when changed write scopes alter the topology.
- **send**: `write agent://<handle>` with a concise steering message while a child is active; the status file records its handle.
- **cancel**: `write proc://<id>/kill` for the active process that owns the run, then mark unverified nodes failed. Do not cancel merely because a model is quiet; use `wait` when blocked.

Read child output at each frontier and verify claims before treating `done` as success. A graph changing code ends with a verification node depending on all producers and actually running the checks. For paginated deliverables, render and inspect every page. For broad research, harvest in waves, follow leads, then fan results into bounded synthesis reports rather than flooding one reducer with raw output. Stop when the user's success criteria pass, not when all handles return.
