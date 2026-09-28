---
name: mass-ulw
description: Decompose a large job into a dependency graph of self-contained child tasks and run it in waves through the eval kernel. Use when the user says mass ulw, mulw, or asks for a staged multi-agent fan-out.
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# mass-ulw: dependency-ordered child work

Use a graph only when real ordering exists: if every child is independent, use one ordinary `task` batch instead. One run covers one coherent stage, then its verified output informs the next stage's graph. Read `skill://mass-ulw/references/planning.md` in full before defining nodes; it defines topology, routing, write scopes, prompt contracts, and a verification frontier.

## Definition and durable state

A node has `{ id, prompt, agent, dependsOn?, label? }`; `agent` is an OMP agent listed in the task tool description (default `task`), not a model category. Use `sonic` for mechanical work; if another category agent is absent, use `task`. The eval runner cannot set child effort. For high-effort work requiring `task` with `effort: "hi"`, dispatch via the `task` tool outside this graph and use its verified result when defining the next stage. `dependsOn` is ordering only, not data interpolation. The prompt must stand alone, with `TASK`, `DELIVERABLE`, `SCOPE`, `VERIFY`, and `STOP WHEN` sections. Give siblings disjoint write scopes. Preflight the entire definition and resume status before any child dispatch; invalid ids, references, cycles, or contradictory statuses must launch zero children.

Create `local://mass-ulw/<run-key>.json` with `write`. Choose a stable short key for the current stage and fill this shape:

```json
{
  "key": "docs-refresh",
  "name": "Refresh the documentation",
  "nodes": [
    { "id": "audit", "agent": "sonic", "prompt": "TASK: Audit docs for obsolete APIs. DELIVERABLE: A bounded file report. SCOPE: Read docs and src only. VERIFY: Cite current declarations. STOP WHEN: Every obsolete link is listed." },
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

Every node's final result is stored at `local://mass-ulw/<run-key>/<id>.md`; a status record holds `state: pending|running|done|failed|skipped`, plus `handle` (`agent://…`), `resultPath`, or `error` when applicable. The run file records returned child output, not acceptance: `done` means a child returned and its report was saved, while the goal is complete only when independent verification evidence proves the success criteria. `read local://mass-ulw/<run-key>.json` shows saved status after a kernel reset, but JSON cannot reattach live handles. Register the overall goal and its success criteria with `todo` before starting.

## Run one frontier per Python eval cell

The kernel supplies synchronous `read`/`write`, `agent`, and `wait`. Substitute the real key before running. This cell validates the **whole** graph and saved status before any spawn, skips dependents of failures, dispatches only the current ready frontier, and persists each returned result. Inspect its child reports and evidence before rerunning the same cell for the next frontier:

```python
import json
import re

key = "docs-refresh"
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", key):
    raise ValueError("Run key must be a safe path segment")
run_path = f"local://mass-ulw/{key}.json"
run = json.loads(read(run_path))
if not isinstance(run, dict) or run.get("key") != key or not isinstance(run.get("nodes"), list) or not run["nodes"]:
    raise ValueError("Run key or node list is invalid")

nodes = {}
for node in run["nodes"]:
    if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", node["id"]):
        raise ValueError("Node id must be a safe, nonempty path segment")
    node_id = node["id"]
    if node_id in nodes:
        raise ValueError(f"Duplicate node id: {node_id}")
    deps = node.get("dependsOn", [])
    if not isinstance(deps, list) or any(not isinstance(dep, str) for dep in deps) or len(deps) != len(set(deps)):
        raise ValueError(f"Invalid dependencies for {node_id}")
    if not isinstance(node.get("prompt"), str) or not node["prompt"].strip():
        raise ValueError(f"Missing prompt for {node_id}")
    if not isinstance(node.get("agent", "task"), str) or not node.get("agent", "task"):
        raise ValueError(f"Invalid agent for {node_id}")
    if "label" in node and (not isinstance(node["label"], str) or not node["label"].strip()):
        raise ValueError(f"Invalid label for {node_id}")
    nodes[node_id] = node

followers = {node_id: [] for node_id in nodes}
indegree = {}
for node_id, node in nodes.items():
    deps = node.get("dependsOn", [])
    for dep in deps:
        if dep not in nodes:
            raise ValueError(f"Unknown dependency {dep} for {node_id}")
        followers[dep].append(node_id)
    indegree[node_id] = len(deps)
frontier = [node_id for node_id, degree in indegree.items() if degree == 0]
seen = 0
while frontier:
    current = frontier.pop()
    seen += 1
    for follower in followers[current]:
        indegree[follower] -= 1
        if indegree[follower] == 0:
            frontier.append(follower)
if seen != len(nodes):
    raise ValueError("Dependency graph has a cycle")

status = run.get("status")
if not isinstance(status, dict) or set(status) != set(nodes):
    raise ValueError("Status rows must match node ids exactly")
for node_id, row in status.items():
    state = row.get("state") if isinstance(row, dict) else None
    if state not in ("pending", "running", "done", "failed", "skipped"):
        raise ValueError(f"Invalid status for {node_id}")
    if state == "running":
        raise ValueError(f"Resolve live child {node_id} before restarting; saved handles cannot be awaited here")
for node_id, node in nodes.items():
    row = status[node_id]
    state = row["state"]
    allowed = {"pending": {"state"}, "done": {"state", "handle", "resultPath"},
               "failed": {"state", "handle", "error"}, "skipped": {"state", "error"}}
    if not set(row) <= allowed[state]:
        raise ValueError(f"Unexpected status fields for {node_id}")
    if "handle" in row and (not isinstance(row["handle"], str) or not row["handle"].startswith("agent://")):
        raise ValueError(f"Invalid handle for {node_id}")
    deps = node.get("dependsOn", [])
    if state == "pending" and set(row) != {"state"}:
        raise ValueError(f"Reset stale fields on pending node {node_id}")
    if state == "done":
        if row.get("resultPath") != f"local://mass-ulw/{key}/{node_id}.md" or "error" in row:
            raise ValueError(f"Invalid result path or error for done node {node_id}")
        read(row["resultPath"])  # A saved status without its report is not recoverable evidence.
    if state in ("failed", "skipped") and (not isinstance(row.get("error"), str) or not row["error"] or "resultPath" in row):
        raise ValueError(f"Invalid failure status for {node_id}")
    if state == "skipped" and ("handle" in row or not any(status[dep]["state"] in ("failed", "skipped") for dep in deps)):
        raise ValueError(f"Skipped node {node_id} has no failed dependency")
    if state in ("done", "failed") and any(status[dep]["state"] != "done" for dep in deps):
        raise ValueError(f"Completed node {node_id} has an incomplete dependency")

while True:
    blocked = [node_id for node_id, node in nodes.items() if status[node_id]["state"] == "pending"
               and any(status[dep]["state"] in ("failed", "skipped") for dep in node.get("dependsOn", []))]
    if not blocked:
        break
    for node_id in blocked:
        status[node_id] = {"state": "skipped", "error": "dependency failed"}
    write(run_path, json.dumps(run, indent=2) + "\n")

ready = [node for node in run["nodes"] if status[node["id"]]["state"] == "pending"
         and all(status[dep]["state"] == "done" for dep in node.get("dependsOn", []))]
if not ready and any(row["state"] == "pending" for row in status.values()):
    raise RuntimeError("Pending nodes have no ready frontier")
if ready:
    handles = [agent(node["prompt"], agent=node.get("agent", "task"), label=node.get("label", node["id"])) for node in ready]
    for node, handle in zip(ready, handles):
        status[node["id"]] = {"state": "running", "handle": handle.handle}
    write(run_path, json.dumps(run, indent=2) + "\n")

    results = wait(handles, raise_errors=False)
    for node, result in zip(ready, results):
        node_id = node["id"]
        if isinstance(result, BaseException):
            status[node_id] = {"state": "failed", "handle": status[node_id]["handle"], "error": str(result) or repr(result)}
        else:
            result_path = f"local://mass-ulw/{key}/{node_id}.md"
            write(result_path, str(result))
            status[node_id] = {"state": "done", "handle": status[node_id]["handle"], "resultPath": result_path}
        write(run_path, json.dumps(run, indent=2) + "\n")

print({node_id: row["state"] for node_id, row in status.items()})
```

The preflight rejects a cycle before launching anything. If the cell loses live handles while status is `running`, inspect the child output and any saved artifacts, then explicitly reconcile the row: save a trustworthy returned report as `done` with its expected `resultPath`, or mark an unverified child `failed` with an error before retrying. A JSON handle is not a live wait handle; do not start another wave while its original child may still be writing. `wait(handles, raise_errors=False)` isolates failed children so unaffected nodes can complete.

## Recovery and supervision

- **retry**: after the wave settles, inspect the error, then reset only the named `failed`/`skipped` rows and skipped descendants to exactly `{ "state": "pending" }`; rerun the cell. Never rerun untouched `done` nodes.
- **amend**: edit the node definition and reset only changed nodes and their transitive dependents to exactly `{ "state": "pending" }`, clearing stale `resultPath`, `handle`, and `error`; keep other `done` reports and paths. Tell the user when changed write scopes alter the topology.
- **send**: `write agent://<handle>` with a concise steering message while a child is active; the status file records its handle.
- **cancel**: `write proc://<id>/kill` for the active process that owns the run, then mark unverified nodes failed. Do not cancel merely because a model is quiet; use `wait` when blocked.

Read each returned report and check its claims against the user's criteria **before** running the next frontier. `done` only records a returned report; if the evidence does not support a dependent task, repair or amend the graph rather than treating it as accepted. A code-changing graph ends with a verification node depending on all producers and actually running the checks. For paginated deliverables, render and inspect every page. For broad research, harvest in waves, follow leads, then fan results into bounded synthesis reports rather than flooding one reducer with raw output. Stop when the user's success criteria pass, not when all handles return.
