---
name: init-deep
description: "Use when a repository needs hierarchical AGENTS.md guidance generated or refreshed from its code structure and conventions."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Deep repository knowledge initialization

Generate a hierarchy of AGENTS.md files: a root guide plus complexity-scored subdirectory guides. Keep the orchestrating session's context bounded. Arguments: `--create-new` means read existing guides first, preserve still-true facts, then replace those guides; `--max-depth=N` limits candidates (default 3). Without `--create-new`, edit existing guides in place and add only warranted new ones. Never erase a user's unrelated prose without tracing its intent.

## Map, reduce, verify

1. In one `eval` cell measure source bytes per directory, file counts and depth, excluding generated/vendored/binary artifacts. Group whole directories into approximately 400 KiB chunks; split only at child boundaries. Track the five transitions with `todo` (`init`, `start`, `done`).
2. Use an eval `workpool()` of `scout` children, one per chunk, for fast scanners. Each scanner returns bounded facts: inventory, exported symbols and references (`lsp`/`ast_grep`), conventions that differ from defaults, anti-patterns, hotspots and applicable commands. If `scout` is unavailable, use `task`. Write each bounded report to `local://init-deep/reports/<id>.md` and pass paths rather than report bodies downstream.
3. Give each disjoint directory subtree to one `writing` child (if `writing` is not listed in the task tool description, use `task`). It reads its scanner reports, spot-checks claims in the code, scores candidate locations below, edits existing files or writes new AGENTS.md, and writes a digest to `local://init-deep/digests/<subtree>.md`. No two writers own one path. A separate root `writing` child reads only digests and existing root guidance to write the root file.
4. Dispatch one root `scout` verifier with paths and digests. It checks every declared file exists, meets the line guidance and avoids copied parent sections. Correct failed locations through their owning writer, then re-verify. Read only the verifier verdict and the digest needed for a repair in the main session.
5. Store the final snapshot (commit SHA, file count, LOC, timestamp and mode) in `local://init-deep/snapshot.json`; reports and digests are session artifacts, not repository files. Ask via `ask` whether the guidance should be committed or kept local when not already decided. In local mode, do not silently add tracked guidance; explain the choice and preserve existing tracked files.

For a small repository where scanner fan-out costs more than it saves, use a few `scout` children in one `task` batch, then apply the same scoring and verification rules. Do not create a separate scheduler or project-root state directory.

## Scoring & Location (each writer applies this to its subtree; the inline path applies it repo-wide)

### Scoring Matrix

| Factor | Weight | High Threshold | Source |
|--------|--------|----------------|--------|
| File count | 3x | >20 | bash |
| Subdir count | 2x | >5 | bash |
| Code ratio | 2x | >70% | bash |
| Unique patterns | 1x | Has own config | scout |
| Module boundary | 2x | Has index.ts/__init__.py | bash |
| Symbol density | 2x | >30 symbols | lsp/ast_grep |
| Export count | 2x | >10 exports | lsp/ast_grep |
| Reference centrality | 3x | >20 refs | lsp/ast_grep |

### Decision Rules

| Score | Action |
|-------|--------|
| **Root (.)** | ALWAYS create |
| **>15** | Create AGENTS.md |
| **8-15** | Create if distinct domain |
| **<8** | Skip (parent covers) |

### Output
```
AGENTS_LOCATIONS = [
  { path: ".", type: "root" },
  { path: "src/hooks", score: 18, reason: "high complexity" },
  { path: "src/api", score: 12, reason: "distinct domain" }
]
```

---

## Templates & File Writing Rule

<critical>
**File Writing Rule**: If AGENTS.md already exists at the target path → use `edit`. If it does NOT exist → use `write`.
NEVER use Write to overwrite an existing file. ALWAYS check existence first via `read` or discovery results.
</critical>

### Root AGENTS.md (Full Treatment)

```markdown
# PROJECT KNOWLEDGE BASE

**Generated:** {TIMESTAMP}
**Commit:** {SHORT_SHA}
**Branch:** {BRANCH}

## OVERVIEW
{1-2 sentences: what + core stack}

## STRUCTURE
```
{root}/
├── {dir}/    # {non-obvious purpose only}
└── {entry}
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|

## CODE MAP
{From LSP/ast-grep - skip only if neither exists or project <10 files}

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|

## CONVENTIONS
{ONLY deviations from standard}

## ANTI-PATTERNS (THIS PROJECT)
{Explicitly forbidden here}

## UNIQUE STYLES
{Project-specific}

## COMMANDS
```bash
{dev/test/build}
```

## NOTES
{Gotchas}
```

**Quality gates**: 50-150 lines, no generic advice, no obvious info.

### Subdirectory AGENTS.md

30-80 lines max. Sections: OVERVIEW (1 line), STRUCTURE (only if >5 subdirs), WHERE TO LOOK, CONVENTIONS (only if different from parent), ANTI-PATTERNS. NEVER repeat parent content; note why the directory earned its file (score, distinct domain).

---


