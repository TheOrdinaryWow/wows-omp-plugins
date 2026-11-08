---
name: mass-ulw
description: Decompose a large job into a dependency graph of self-contained child tasks and run one inspected frontier at a time through the eval kernel. Use for mass ulw, mulw, staged multi-agent fan-out, or saving and rerunning a named graph definition.
---

> **Modified-port notice and license.** This skill is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace` (`packages/omo-senpi/skills/mass-ulw/**` and the input-definition doctrine in `packages/omo-senpi/skills/dag-library/SKILL.md`). It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# mass-ulw: dependency-ordered child work

Use a graph when ordering is real: C consumes what A and B produce. Fully independent children belong in one ordinary `task` batch. One run covers one coherent stage, not a whole evolving project; inspected results determine a later discovery-dependent stage's graph. Read `skill://mass-ulw/references/planning.md` in full before defining nodes. Record topology, handoff files, wave widths, routing reasons, disjoint writes, and verification before dispatch.

The local runner deliberately dispatches **one ready frontier**, waits for that whole frontier to settle, saves reports, and returns control for inspection. No branch advances early, and no rescue run races a still-active writer. Do not import upstream's `workflow`, SDK, automatic per-angle scheduler, or runtime caps.

## Goal and authorization before start

Register the overall objective and binary success criteria with `todo` before starting. An active `/ulw-loop` already owns goals, criteria, evidence, and checkpoints; mirror its cursor without creating another goal or notepad. An approved Atlas plan keeps its own dispatch and acceptance authority. A child or run finishing never proves the goal: inspect its final native result and captured evidence against those criteria.

Only the **main session**, through native `ask`, requests unresolved owner decisions about scope, spend, or irreversible actions before dependent work starts. A node reports a decision need to the main session; neither its prompt nor an eval cell asks or grants authorization. Timeout, dismissal, or an unavailable answer means **unapproved**, even if generic tool text recommends best judgment. Do not launch the dependent run or frontier. Saving a definition, loading it, scheduling a future run, or having run it before is not authorization to execute it now.

## Input definitions and per-run state

A definition contains `key`, `name`, and `nodes`, never run status or old results. A node has `{ id, prompt, agent, dependsOn?, label? }`; `agent` names an OMP agent in the live task description, not a model category. The eval runner cannot set effort. Use a direct `task` assignment outside this graph for work that needs `effort: "hi"`, then inspect its result before defining the next stage.

`dependsOn` orders work; it does not interpolate a result or transport files. Every prompt stands alone with `TASK`, `DELIVERABLE`, `SCOPE`, `VERIFY`, and `STOP WHEN`. Producer and consumer prompts name the **same accessible absolute physical path**. A missing or insufficient handoff is FAIL, not permission to improvise. Parent-local `local://` report URIs are not automatically visible to another session.

For a new execution, choose a fresh safe run key, create an owned physical handoff root, and write a materialized input-only definition at `local://mass-ulw/<run-key>/definition.json`. Resolve all paths before dispatch. The concrete example below assumes the coordinator has created and recorded `/tmp/mass-ulw-docs-refresh-a1` as a shared handoff root available to these children; replace that path in **every** producer and consumer prompt for the real run. A child that cannot access it fails the handoff.

```json
{
  "key": "docs-refresh-a1",
  "name": "Refresh the documentation",
  "nodes": [
    { "id": "audit", "agent": "sonic", "prompt": "TASK: Audit docs for obsolete APIs. DELIVERABLE: Write /tmp/mass-ulw-docs-refresh-a1/audit.md with each stale page, claim and current declaration. SCOPE: Read docs and src; write only that report. VERIFY: Confirm the report exists and cite current declarations for every finding. STOP WHEN: The bounded report is written, or a failure is reported." },
    { "id": "rewrite", "agent": "writing", "dependsOn": ["audit"], "prompt": "TASK: Rewrite the identified pages. DELIVERABLE: Update those pages and write /tmp/mass-ulw-docs-refresh-a1/rewrite.md naming every changed example. SCOPE: Read /tmp/mass-ulw-docs-refresh-a1/audit.md and src; write only docs pages named by the audit and the rewrite report. VERIFY: A missing or insufficient audit file is FAIL; otherwise check each link and example against current declarations. STOP WHEN: All named pages and the rewrite report are complete, or a failure is reported." },
    { "id": "verify", "agent": "task", "dependsOn": ["rewrite"], "prompt": "TASK: Verify all revised examples. DELIVERABLE: Write /tmp/mass-ulw-docs-refresh-a1/verify.md with exact commands, observations and PASS/FAIL per example. SCOPE: Read /tmp/mass-ulw-docs-refresh-a1/rewrite.md, docs and build outputs; write only the verification report. VERIFY: A missing or insufficient rewrite file is FAIL; otherwise execute the documented examples and inspect their actual results. STOP WHEN: Every listed example has observed evidence or an explicit failure." }
  ]
}
```

Write separate execution state at `local://mass-ulw/docs-refresh-a1.json`:

```json
{
  "version": 2,
  "key": "docs-refresh-a1",
  "definitionPath": "local://mass-ulw/docs-refresh-a1/definition.json",
  "status": {
    "audit": { "state": "pending" },
    "rewrite": { "state": "pending" },
    "verify": { "state": "pending" }
  }
}
```

A status row is `pending|running|done|failed|skipped`, with `handle` (`agent://…`), `resultPath`, or `error` as applicable. Returned reports are saved at `local://mass-ulw/<run-key>/<id>.md`. `done` means a child returned and its report was saved, **not accepted work**. The physical producer handoff is a separate promised deliverable; saving returned text does not create it.

### Save, rerun, or recover

For a reusable library, save only the input definition as `<name>.json` at an explicitly chosen path. For named lookup, use an explicit supplied file first, then `<repo>/.omp/dags/<name>.json`, then `$HOME/.omp/dags/<name>.json`, taking the first existing file and stating which one was read. Do not install a library SDK or automatically search a foreign configuration root. A library name is one safe file-name segment, never a path.

A saved definition may use `{{key}}` and `{{handoffRoot}}` inside string values. Before a fresh run, the coordinator copies it to that run's `definition.json`, fills a new unique key and owned absolute handoff root consistently, and inspects the resulting prompts for unresolved placeholders, current agents, current scopes, interfaces, and authorization. The frontier runner consumes the materialized definition, not a template. Every fresh run gets fresh state with all rows pending and fresh report/handoff paths; old acceptance never carries over. Do not silently overwrite an existing run just because its definition has the same base name.

Recovery is a different, explicit choice: reuse the existing key, definition snapshot, state, and reports; settle any old writers, inspect evidence freshness, then retry or amend only the affected rows as described below. Do not rotate the key and call it recovery, and do not reset a settled run merely by loading its template. Saving alone does not trigger a trial run.

## Run one frontier per Python eval cell

The kernel supplies synchronous `read`/`write`, `agent`, and `wait`. Substitute the real run key. The cell validates the **whole** graph and state before any spawn, skips failed dependents, dispatches the current ready frontier only, and persists returned reports. It upgrades the previous combined `{key, name, nodes, status}` run format on load by writing its input definition separately and preserving status, handles, and report paths. A saved running row still requires explicit reconciliation before the cell can proceed.

```python
import json
import re

key = "docs-refresh-a1"
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", key):
    raise ValueError("Run key must be a safe path segment")
run_path = f"local://mass-ulw/{key}.json"
definition_path = f"local://mass-ulw/{key}/definition.json"
run = json.loads(read(run_path))
if not isinstance(run, dict) or run.get("key") != key:
    raise ValueError("Run key is invalid")
legacy = run.get("version", 1) == 1 and "nodes" in run
if legacy:
    definition = {"key": key, "name": run.get("name", key), "nodes": run["nodes"]}
else:
    if run.get("version") != 2 or run.get("definitionPath") != definition_path or "nodes" in run:
        raise ValueError("Run version or definition path is invalid")
    definition = json.loads(read(definition_path))
if (not isinstance(definition, dict) or definition.get("key") != key
        or not isinstance(definition.get("nodes"), list) or not definition["nodes"] or "status" in definition):
    raise ValueError("Input definition key or node list is invalid")

nodes = {}
for node in definition["nodes"]:
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

if legacy:
    write(definition_path, json.dumps(definition, indent=2) + "\n")
    run = {"version": 2, "key": key, "definitionPath": definition_path, "status": status}
    write(run_path, json.dumps(run, indent=2) + "\n")

while True:
    blocked = [node_id for node_id, node in nodes.items() if status[node_id]["state"] == "pending"
               and any(status[dep]["state"] in ("failed", "skipped") for dep in node.get("dependsOn", []))]
    if not blocked:
        break
    for node_id in blocked:
        status[node_id] = {"state": "skipped", "error": "dependency failed"}
    write(run_path, json.dumps(run, indent=2) + "\n")

ready = [node for node in definition["nodes"] if status[node["id"]]["state"] == "pending"
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

Inspect the saved reports and actual handoff files before rerunning the cell. It does not decide acceptance or run the next frontier automatically. A legacy run's input snapshot is migrated only after complete preflight; rejected graphs or unresolved running rows dispatch nothing and do not rewrite state.

## Recovery and supervision

- **retry:** after the frontier settles, inspect the error, then reset only the named failed rows and their skipped descendants to exactly `{ "state": "pending" }`. Keep untouched done reports only when their proof and relevant inputs are still valid.
- **amend:** explicitly edit the run's materialized definition and reset changed nodes and their transitive dependents to clean pending rows, clearing stale handles, paths, and errors. Include nodes whose evidence was invalidated by changed source, importers, dependencies, configuration, generated inputs, or environment. Do not mutate a running node or silently widen its writes. Amend a reusable template separately if future runs should inherit the change.
- **send:** `write agent://<id>` steers an active child; the state records its handle. On a midpoint decision inspect the child's actual scope and correct drift, rather than treating observation as passive spectating.
- **cancel:** `write proc://<id>/kill` targets the actual owned process. Confirm it is terminal before reconciling or reusing its writes. Cancellation is not a successful result, and a quiet queued or running child is not dead.

After a kernel reset, a JSON handle is not a live wait handle. Inspect the native child result and artifacts, then explicitly save a trustworthy returned report as done at its expected result path, or mark the unverified row failed with the real error. Never dispatch a replacement while the original child may still write.

Read **every** returned report and check its claims against the criteria before the next frontier. A blocked response can still be a returned report; repair or amend rather than treating `done` as acceptance. A code-changing graph ends with independent verification that consumes every relevant producer and actually runs the checks. Paginated deliverables require inspection of every rendered page. Broad research harvests and expands in inspected stages, then reduces bounded reports, not one unbounded pile. Stop when evidence fulfills the user's goal, not when all handles return.
