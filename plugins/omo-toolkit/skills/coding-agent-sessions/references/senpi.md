> **Modified-port notice and license.** This reference is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# OMP and the OMO / Senpi / pi family

For OMP recall, read `xd://eval/archive` and use native archive first. `archive.sessions` returns the actual raw `file`; `archive.search` searches interactive-editor prompts, not every message or child transcript. Use full raw logs only when the question needs them and within the authorized scope.

| Platform key | Aliases | Actual conventional locations |
|---|---|---|
| `oh-my-pi` | `omp`, `ohmypi`, `oh_my_pi` | `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl` |
| `senpi` | — | `~/.omo/agent/sessions/`, `~/.senpi/agent/sessions/`, `~/.pi/agent/sessions/` |
| `gajae-code` | `gjc`, `gajae`, `gajaecode` | `~/.gjc/agent/sessions/` |

Do not rename foreign stores to `.omp`. Named profiles use `<config-root>/profiles/<profile>/agent/sessions/`. Explicit `$XDG_DATA_HOME/<app>/sessions/` and profile roots are also probed by the finder. Host `PI_CODING_AGENT_DIR`, profile selection, XDG state/data configuration, `--session` and `--session-dir` may select other locations: prefer native returned files and installed `omp://settings.md` / `omp://session.md` / `omp://cli-reference.md`, not speculative reconstruction of encoded cwd names. `--no-session` has no persisted JSONL.

Finder `--root /custom/agent` adds `<root>/sessions/` to normal discovery. It does **not** mean arbitrary raw session directory and does not exclude default roots. For read-only current-project isolation use:

```bash
python3 -B "<skill-dir>/scripts/find-agent-sessions.py" list --platform omp --session-dir /exact/project/session-directory --include-subagents --limit 20
```

This helper-only `--session-dir` flag is repeatable, bypasses all default roots, and requires just `--platform omp` (or `oh-my-pi`) without `--root`. No product CLI is invoked. Narrowing a directory bounds reads; `--cwd`, date and hit limit do not prevent earlier parsing. At most the most recent 2,000 native transcript files are parsed per scan.

## Format and parent-child evidence

Current native JSONL can start with a fixed-width `type: "title"` slot, followed by the logical `type: "session"` header (`version: 3`, `id`, `timestamp`, `cwd`, optional `parentSession`). Older files can start directly with the header. Native scanning validates this layout and ignores other artifact JSONL logs.

`model_change` names `provider`/`modelId`; `message` wraps role/content/usage; `session_init` can name the agent. Finder `usage` is selected metadata, not summed spend. Cache-discount estimates must use the onboarding helper's message-level native usage processing.

Native child files are under `<parent-file-without-.jsonl>/<id>.jsonl`, with possible dot-qualified nested task IDs. The task ID in the filename and UUID in the header are not interchangeable. The helper preserves the raw `parentSession` as `parent_reference` and resolves it only against **actually scanned** IDs/absolute paths. It sets `parent_id` for a subagent only when that reference resolves and the child is within the parent's artifact directory. A fork can carry the same lineage marker while living beside its parent: it stays a main result. Unresolved lineage is reported without guessing from filename prefixes.

The host writes `parentSession` as either an ID or a path depending on flow. Both files need to be in the selected scan for normalized linkage. `get`/`read` lists direct children; recurse explicitly for a whole tree. In a live session use `history://<task-id>`; historical children may not be registered there, so read their raw file or use an available `seance` consult. Neither a header reference nor a completed transcript alone proves final task success after isolation processing.

Verified implementation pointers in host 18.12.5: `src/session/session-entries.ts:38-55` (header), `src/session/session-manager.ts:371-388` (artifact containment), `src/task/executor.ts:4197-4198,4523-4536` (child file and parent header). These are source provenance, not runtime API imports; use the installed host docs for your current version.
