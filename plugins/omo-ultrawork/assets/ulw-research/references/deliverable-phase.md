> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Research deliverable contract

Read this before the brief and again before assembly. Every command runs against the absolute `SESSION_DIR` filesystem path, not a `local://` URL. The extension sends an absolute `Research assets directory`; set `ASSETS` to that directory. The helpers are dependency-free `.mjs` files invoked with `node "$ASSETS/scripts/report-tools.mjs" <command>`. Node exits 0 for success, 1 for a failed semantic gate, and 2 for usage/IO failure. Always include `--session-dir "$SESSION_DIR"` for outcome and repair calls.

## 1. Choose one lane

- `template-strict`: the user points at a prior document; match its structure, citation style, typography, and figures, rather than inventing a new look.
- `template-vibe`: the user describes a register or mood but no exact source; use the clean analyst defaults below.
- `no-format`: the destination itself implies a chat answer or post; no document-format interview.
- `edit-existing`: a complete deliverable for this question already exists; edit it rather than regenerating it.

## 2. Detect existing state

For a named existing deliverable, run `node "$ASSETS/scripts/report-tools.mjs" outcome state --deliverable <absolute-path> --session-dir "$SESSION_DIR"` before writing the brief. `none` means fresh work; `partial` means the file carries `STATUS: draft` near the top or has a pending manifest row, so resume its existing skeleton; `complete` means resolved manifest plus a nonempty file, so select `edit-existing`. Do not destroy useful partial work.

## 3. Derive defaults from destination

| Signal | Promised formats | Lane | QA |
|---|---|---|---|
| Question or message answered here, no document requested | `post` | `no-format` | light |
| Blog/web page destination | `html` | `template-vibe` | full |
| Explicit PDF, DOCX, slides, or LaTeX | Exactly requested types | `template-vibe` | full |
| Report/document with no format or destination | `pdf,docx` | `template-vibe` | full |
| An exact document provided as reference | Reference format | `template-strict` | full |
| Complete deliverable of this question | Existing format | `edit-existing` | prior tier |

A similar prior report can supply a default format, not override an explicit request. Light QA runs static checks and one render; full QA runs static, layout, visual, and proofread gates.

## 4. Ask only for missing details, without blocking collection

Derive from the request first. If still unknown, send at most three questions together through `ask`: destination/format, audience and length (`short`, `standard` about 5–12 pages, `deep` dossier), and template lineage. For each, put the derived default first, allow free text and "don't care, you decide". Ask without waiting when the surface permits and continue collecting sources. A late answer can change assembly until it starts; after that it is a re-render request. In `brief.md`, under `## Deliverable`, record lane, state, formats, destination, audience, template, format description, and `answered_by: user|default|request` on each choice. Initialize the manifest in the same step: `node "$ASSETS/scripts/report-tools.mjs" outcome init --promised <formats> --lane <lane> --session-dir "$SESSION_DIR"`.

If a memory tool carries a declared report-format preference for the same destination kind and audience, use it to propose the default instead of asking again; write a new preference only when stated explicitly or repeated across runs, never from a single accidental format choice. Do not store report contents in format memory.

## 5. Establish `design-spec.md`

Write `$SESSION_DIR/design-spec.md` before any visual/assembly child starts; give it to every asset lane. For HTML/Markdown references use `node "$ASSETS/scripts/report-tools.mjs" format-extract <reference> --out "$SESSION_DIR/design-spec.md"` or add `--from-url` for a URL. The extractor provides token palettes, typography, breakpoints, document structure, figure and citation details, and `TODO: ask` where uncertain. A PDF reference cannot be extracted directly; request its HTML/Markdown source. Resolve every `TODO: ask` from the interview or the documented defaults, never by guessing.

Absent an exact template, use one accent over neutral colors, real embeddable sans/gothic fonts, readable margins, responsive breakpoints, a methodology closing section, and numbered sources with access dates. For Korean set `word-break: keep-all; overflow-wrap: anywhere`. Each chart gets a title, units, axis/value labels, and deterministic data-derived ticks; figures use fixed-size captioned containers with aspect-preserving contain-fit. Define a `Lineage: inline` spec when each number carries `MEASURED`, `ASSUMED`, `DERIVED`, or a citation; `Lineage: section` places sources at sentence ends and number lineage in captions. Keep colors and typography identical in prose, charts, and diagrams.

## 6. Delivery gates and repairs

Record each result: `node "$ASSETS/scripts/report-tools.mjs" outcome gate <static|layout|visual|proofread> <pass|fail|not_run> --session-dir "$SESSION_DIR"`. The static gate checks rendered HTML with `node "$ASSETS/scripts/report-tools.mjs" check "$SESSION_DIR/report.html" --design-spec "$SESSION_DIR/design-spec.md" > "$SESSION_DIR/defects.json"`. Exit 1 denotes an integrity blocker; inspect JSON even at exit 0 for other defects. For layout call `layout-probe --json`, evaluate its `.source` on the rendered page with OMP `browser`, save `$SESSION_DIR/boxes.json`, then rerun `check --layout "$SESSION_DIR/boxes.json"`. Visual QA renders every page and inspects the pixels (HTML at desktop and phone widths); a separate `writing` child if listed in task tool description, otherwise `task`, proofreads final text without rewriting arguments. Read [report-gates.md](report-gates.md) for defect codes. Light conversational answers record inapplicable gates as `not_run`; a full paginated or web artifact runs all four in order.

After defects run `node "$ASSETS/scripts/report-tools.mjs" repair decide --state "$SESSION_DIR/repair-state.json" --defects "$SESSION_DIR/defects.json" --artifact-bytes <bytes> --renders <pages> --session-dir "$SESSION_DIR"`. `repair` means fix and rerun; `deliver` means release a usable artifact while disclosing residual nonblocking defects; `block` means an integrity defect or absent usable output remains, so do not deliver. The helper defaults to three attempts, a two-attempt plateau, oscillation detection, and 15 minutes from the first decision. Its decision, not a vague desire to polish indefinitely, governs the loop.

## 7. Resolve promises and print the briefing

`$SESSION_DIR/outcome.json` tracks each format (`pdf`, `docx`, `html`, `md`, `latex`, `slides`, `post`). Resolve each with `outcome set <format> delivered --path <absolute-path> [--pages N]` or `blocked_capability`, `skipped`, `failed` with `--reason`, always with `--session-dir`. Use `outcome render <png> --page N --session-dir` for a page preview. `outcome verify --session-dir` refuses pending promises, missing reasons, and missing/empty delivered files. Then `outcome finish --session-dir` computes elapsed minutes and source/domain counts from the ledger; `outcome briefing --session-dir` prints the required closing text. Paste the printed block, never recall numbers from memory.

| Helper | Relevant arguments | Failed semantic check |
|---|---|---|
| `check <report.html>` | `--design-spec`, optional `--layout`, repeatable `--require-section` | Integrity blocker |
| `layout-probe` | `--cap`, `--root`, `--json` | None |
| `repair decide` | `--state`, `--defects`, `--artifact-bytes`, `--renders` | Decision is `block` |
| `outcome init` | `--promised`, `--lane` | None |
| `outcome set <format> <status>` | `--path`, `--pages`, `--reason` | None |
| `outcome gate <gate> <status>` | `--session-dir` | None |
| `outcome render <png>` | `--page` | None |
| `outcome state` | `--deliverable` | None |
| `outcome verify` | `--session-dir` | Unresolved or invalid promise |
| `outcome finish`, `outcome briefing` | `--ledger`, `--json` when applicable | None |
| `format-extract <reference>` | `--out`, optional `--from-url` | Unsupported input exits 2 |
