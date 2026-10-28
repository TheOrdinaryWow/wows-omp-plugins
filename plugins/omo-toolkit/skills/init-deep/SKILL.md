---
name: init-deep
description: "Use when a repository needs hierarchical AGENTS.md guidance generated or refreshed from its code structure and conventions."
argument-hint: "[--create-new] [--max-depth=N]"
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Deep repository knowledge initialization

Generate a hierarchy of AGENTS.md files: a root guide plus complexity-scored subdirectory guides. Keep the orchestrating session's context bounded. Arguments: `--create-new` means read existing guides first, preserve still-true facts, then replace those guides; `--max-depth=N` limits candidates (default 3). Without `--create-new`, edit existing guides in place and add only warranted new ones. Never erase a user's unrelated prose without tracing its intent.

## Map, reduce, verify

1. In one `eval` cell measure tracked source bytes per directory, file counts, LOC and depth, excluding generated/vendored/binary artifacts and lockfiles. Compute `N_scanners = ceil(sourceBytes / (400 * 1024))`, `N_writers = ceil(N_scanners / 12)`. Group whole directories into approximately 400 KiB chunks; split only at child boundaries. Read root guidance now and give existing descendant guidance to its scanner/writer, including `--create-new`. Track the five transitions with `todo` (`init`, `start`, `done`) only if no other workflow owns that list.
2. Read native eval agent/workpool documentation before using it. Use an eval `workpool()` of `scout` children, one per chunk, for read-only scanners. Each scanner writes one report of at most 5k tokens with inventory, exported symbols/references (`lsp`/`ast_grep`), deviations from defaults, anti-patterns, hotspots and applicable commands; empty sections say `none`. Write each report to `local://init-deep/reports/<id>.md` and pass paths rather than report bodies downstream. Children use the live native task schema; do not invent DAG/category fields or install an orchestration SDK.
3. Give each disjoint directory subtree to one `writing` child (if not listed in the live roster, use an available write-capable agent). Its assignment tells it to read `skill://init-deep`, read its reports, spot-check claims in real code, score candidate locations below, edit existing files or write warranted new AGENTS.md, and write a digest of at most 2k tokens to `local://init-deep/digests/<subtree>.md`. No two writers own one path. A separate root writer reads only digests and existing root guidance to write the root file. Do not require implementation builds/tests merely to document an observed command.
4. Dispatch one independent root `scout` verifier with paths and digests. It checks every declared file exists, root has 50–150 lines and descendants 30–80, facts have source evidence, and children do not repeat parent sections. It returns one `PASS` or `FAIL <path>: <reason>` per file. Correct failed locations through their owning writer, then re-verify. The main session never reads raw chunk reports/outputs; read only the verifier verdict and the digest needed for a repair. Verification is explicit in each child's assignment.
5. Complete the mode/delivery and snapshot procedure below after all verifier results PASS. Reports, digests and the session snapshot stay under `local://`; do not create `.omo/`, a project scheduler, project scaffolding or a second state store.

For `N_scanners < 4`, scanner fan-out can cost more than it saves: use a few bounded `scout` children in one native `task` batch, then apply the same scoring, disjoint writer and independent-verification rules. For larger repositories, batch within the native concurrency limit and reduce digests hierarchically if needed; do not raise a foreign DAG setting.

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


## Mode, reviewed-PR handoff and snapshot

Settle the mode before writing guidance when it has not already been explicitly decided. Use native `ask` with effects visible in the option labels/descriptions:

- **Local guidance:** keep the generated guidance personal to this checkout; no commit, push or PR. Preserve existing tracked files as tracked. Git excludes cannot hide modifications to an already tracked AGENTS.md, so disclose those visible modifications; do not untrack/revert user guidance or pretend it is hidden. If asked to exclude newly created guidance, edit only a clearly managed block in the actual Git `info/exclude`, preserving user lines. Do not change `.gitignore` for personal mode.
- **Reviewed PR:** authorize creation of a dedicated guidance branch, a guidance-only commit, pushing that branch and opening a PR, **never merging**. A previous vague “commit it” is not permission to push/open a PR: obtain specific authorization first. If no interactive prompt exists, require these effects explicitly in the request; never infer consent from a timeout or a tracked file.

An explicit mode answer wins over tracked status. Tracked status can inform the question, never authorize network effects. If the user has already authorized exactly these effects, do not ask again.

### Committed mode

Read `skill://git-master` before Git mutations. If a project-provided PR skill is actually available, read it for repository conventions, but keep this skill's authorization and no-merge limits. No external PR skill is required:

1. Inspect actual worktree state and contribution rules. Preserve unrelated changes. Create a dedicated branch using repository naming, otherwise `docs/init-deep` (choose a noncolliding name if it exists). Never commit guidance straight to the default branch or switch a dirty unrelated checkout destructively.
2. Commit only AGENTS.md paths generated/updated by this run and independently verified. Do not sweep in unrelated preexisting guidance edits or use blanket staging. If those edits overlap, preserve them and isolate only this run's hunks; ask when ownership cannot be determined.
3. Push that branch and open a PR against the documented integration/default branch. List every generated file, score and one-line role in the PR body. State verification and any preserved preexisting edits.
4. Stop at reviewed-PR handoff. Never merge, even if a hosting command or another skill defaults to it. If no remote/hosting route/credentials or offline, leave the local guidance commit on its dedicated branch and report that the PR was not opened. Provide exact shell-quoted push and PR-open commands for the discovered remote/base/branch; if a remote does not exist, explicitly name the required remote URL instead of inventing one. Do not silently downgrade to local mode or claim review happened.

### Snapshot record seam

After independent PASS and the local/committed handoff is settled, call the toolkit runtime tool when exposed:

```json
{"action":"record","mode":"local"}
```

Use tool `toolkit_init_deep` and the actual selected mode (`local` or `committed`). It derives repository/HEAD and counts, and owns the durable Git-common-dir, per-worktree advisor snapshot. Do not write those runtime paths directly. Copy its returned `{commitSha,fileCount,loc,timestamp,mode}` to `local://init-deep/snapshot.json`. A failed record (`isError`) leaves the previous baseline intact: report that failure, never claim a durable baseline was updated. Do not record a fresh baseline when verification or guidance delivery remains unfinished.

If the runtime tool is not exposed (content-only skill use), capture those same five fields with native eval/Git reads after delivery into the session-only `local://init-deep/snapshot.json`: full HEAD SHA, tracked-file count, source LOC, milliseconds timestamp, selected mode. State explicitly that no durable advisor baseline was recorded. In a non-Git project, guidance can still be generated locally; report Git snapshot/committed mode as unavailable rather than fabricating a commit SHA.

## Final report

Report update/create-new and local/committed modes, source sizing and scanner/writer counts, each generated/updated path with score/role/line count and verifier verdict, skipped locations, and the guidance hierarchy. Include snapshot artifact and durable-record success/failure/unavailable. For committed mode name the branch, local commit and actual PR URL, or the precise remaining commands and missing prerequisite. Local artifacts require no project cleanup; never delete a user project directory or unrelated guidance.

## Avoid

Do not generate one worker per source file, read raw map reports into the main session, invent LSP centrality when unmeasured, erase existing user intent, document every directory, repeat parent sections, or add generic advice. Do not treat prompt/context text as byte-identical transport: the artifact path is the authority.
