> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# ULW-RESEARCH — Saturation research with verified delivery

The first visible line is `ULW-RESEARCH MODE ENABLED!`. If another active directive also mandates a banner, show its banner first and this one next. This is a user-invoked research procedure, not a model-invocable skill: exhaust relevant source territories, chase actionable leads, cross-attack findings, verify contested claims, and deliver a cited artifact that survives QA. An ordinary question does not activate it.

The extension supplied `Research assets directory: <absolute path>` after this procedure. Refer to it as `ASSETS` in shell commands, substituting the actual directory: `node "$ASSETS/scripts/report-tools.mjs" ...`. `node` must be on PATH. Read `<Research assets directory>/references/deliverable-phase.md` sections 1–6 before writing the brief, `<Research assets directory>/references/report-gates.md` before delivery checks, and `<Research assets directory>/references/latex-report.md` if LaTeX is requested.

## Authority, ownership, and evidence

The user explicitly requested exhaustive research. Continue until the convergence rules below are met, not merely until the first plausible answer. The main session owns scope, journal, claim graph, source ledger, verification, synthesis, and deliverable; children return bounded observations and leads. Do not delegate authorship of the source-of-truth journal to a child. Use a single `task` batch for disjoint research axes and IRC (`write agent://<name>`, `wait`, `read agent://<id>`) for live coordination and later debate. For unfamiliar code use `scout`; for external evidence use `librarian` if listed in the task tool description, otherwise `scout`; for report language proofread use `writing` if listed, otherwise `task`. Other category agents have `task` fallback when absent. Use `web_search` for web and social signals, `browser` for actual rendered pages and screenshots, `ask` for consequential unanswered format choices. Do not invent unsupported team or search tools.

Before work, establish criteria: every named axis has an owner; every EXPAND lead is pursued or closed as duplicate/dead end; a supported contested claim survives an adversarial pass; code-shaped uncertainties are executed; every final assertion cites a retrieved source or a proof; every high-risk non-code assertion clears the claim gate; promised formats and verification gates match the brief; all running children terminate; the closing briefing comes from the outcome script.

## Epistemic journal

Create an actual filesystem directory because the vendored Node CLIs use `node:path` and cannot resolve `local://` URLs. In the workspace run:

```bash
SESSION_DIR="$(pwd)/.omp/tmp/ulw-research/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SESSION_DIR"
ASSETS="<Research assets directory>"
```

Keep `SESSION_DIR` as an absolute filesystem path in every `node "$ASSETS/scripts/..."` invocation. This is uncommitted scratch, not the requested final destination. Write deliverables where the user requested. Keep these files current as observations arrive:

- `brief.md`: core question, axes and owners, expected truths, evidence territories, scale, debate strategy, delivery lane, format, destination, audience, template, and `answered_by: user|default|request` for each choice.
- `intent-diff.md`: expected truth, observed reality, violated invariant, intent source, linked observations and claims, and true/violated/unknown status.
- `claim-graph.md`: one node per asserted claim, type, risk, supporting and contradicting observations, independent groups, temporal validity, dependencies, skeptic verdict, primary source, counter-search, and supported/partial/refuted/unresolved status. Keep a `verified-claims` digest of high-risk non-code claims that cleared the gate.
- `observation-manifest.md`: observer/group, source path or URL, `observed_at`, `valid_at` or `claim_valid_at`, exact artifact/quote, and possible contamination from shared sources.
- `verification-economics.md`: claim, error cost, proof cost, decision, result, residual risk.
- `cause-disappearance.md`: causal claims with last positive observation, disconfirming observation, replacement cause, and current status.
- `excursion-log.md`: ENTER trigger, parent claim, depth, bounded probes, EXIT rule, and what changed in the answer (including `none`).
- `debate-log.md`, `sources-ledger.md`, `expansion-log.md`, `wave-<n>-<axis>.md`, and `SYNTHESIS.md`: append as evidence lands, never reconstruct from memory at the end.

The graph is the only store of final claims. A worker's reply is a candidate, not a verdict. After compaction re-read `brief.md`, journal, graph, and outcome manifest before launching another wave. The run start clock is the timestamp on the session directory; do not rename it.

## Phase 0 — Scope and choose the delivery lane

Scope the actual question yourself with a handful of independent code/doc/web lookups. Write three or more orthogonal axes, source territories, likely ambiguity, what would falsify expected truths, and whether browsing or code execution is needed. Disambiguate a named entity against its first-party source before expanding its alleged history. Record a unique owner for every axis in `brief.md` before spawning.

Read `references/deliverable-phase.md` at the supplied assets directory. Derive lane (`template-strict`, `template-vibe`, `no-format`, `edit-existing`) and promised formats from the request and destination. If the user supplied an existing deliverable, run:

```bash
node "$ASSETS/scripts/report-tools.mjs" outcome state --deliverable <absolute-path> --session-dir "$SESSION_DIR"
```

`partial` means resume the existing skeleton; `complete` means edit rather than regenerate. Ask with `ask` only for missing destination/format, audience/length, or template lineage; show defaults, let collection proceed while waiting if the tool supports it, and record the answer source. For an unspecified document format and destination, PDF plus DOCX are the defaults; for a conversational question, do not manufacture documents. Initialize the manifest with `outcome init --promised <comma-separated formats> --lane <lane> --session-dir "$SESSION_DIR"`. Create an early deliverable skeleton with a `STATUS: draft — <n> sections open` marker so interrupted runs leave a usable partial artifact.

## Phase 1 — Start a research roster

A coordinating roster is the default. Launch one `task` batch of named children for disjoint axes plus a skeptic. Each prompt is self-contained: `TASK`, evidence/source scope, concrete return schema, `EXPAND` tail, and a request to report new leads promptly via `write agent://<lead-id>`. Assign the least costly adequate agent (`quick` → `sonic` fallback, `deep-low`/`unspecified-high`/`ultrabrain` → `task` fallback), using `scout` for local read-only sweeps and `librarian` (fallback `scout`) for external retrieval. Record user routing words verbatim in the journal; do not silently promote or demote a requested tier. If the topic needs rendered web evidence, include a `browser`-capable `task` lane in the opening batch; a plain fetch is not a screenshot. When the user combines mass-ulw with research, read `skill://mass-ulw` and its planning reference; use the eval-kernel graph for a broad first harvest (60+ angles when genuinely broad), then chained expansion waves. The user's command still governs claim and delivery gates.

Workers may not start their own research swarms or write the shared journal. Every substantial reply ends:

```markdown
## EXPAND
- LEAD: <new observation> — WHY: <effect on answer> — ANGLE: <next search>
- DEAD END: <lead closed and why>
```

If none exist, return `## EXPAND` followed by `none — <reason>`. A missing tail gets one request to complete it. Collect evidence paths, observer group, source access time, and precise citations from every lane. Use IRC to relay time-sensitive discoveries to an existing owner; no two children write the same file.

## Phase 2 — Saturation and observation

Search official documentation and primary datasets first, then independent implementations, issue discussions, and critical counterexamples. Use varied `web_search` queries (`site:`, `filetype:`, `intitle:`, `inurl:`, quotes, `OR`, `after:`) rather than repeating one query. Fetch the full page for a claim that matters. For code use `find`, `grep`, `glob`, structural tools, and `lsp` definition/references; cite path and line. For inaccessible/JS-rendered or visually material sources use the `browser` tool, capture what actually rendered, and note authenticated versus archived provenance. Do not mistake two pages on one domain for independent sources.

Journal every return when it arrives in `wave-<n>-<axis>.md`, `sources-ledger.md`, and `observation-manifest.md`. The source ledger identifies first-party or secondary source, URL, observation time, validity time, and where it supports or disputes a claim.

## Phase 3 — Expand and debate to convergence

Deduplicate every EXPAND lead against all previous waves. Immediately send each unchecked lead via `write agent://<owner>` to its live owner or start a bounded `task` batch for unowned territories. Ask the skeptic to ATTACK surprising, high-risk, and contested claims for weaker alternatives, missing counter-sources, and nonindependent observations; relay the attack to the claim owner for defense and record the outcome in `debate-log.md`. Every supported claim receives at least one skeptic pass, even if no worker volunteered an objection. A child finishing is not convergence.

An excursion needs a named ENTER trigger: contradiction of a locked claim, a discovery that would change the answer, an uncovered source territory, or explicit user steering. Bound its workers and probes, permit no more than one nested excursion, and EXIT when settled, two probes add nothing, the claim status stops changing, or its budget is spent. Fold back into the parent claim with a line on what changed (`none` is valid). Three no-change excursions end excursion work. Relay any user steering to all active owners over IRC and record the exact wording.

For multi-faceted requests perform at least two expansion waves. Stop when all leads are closed and claims attacked, or three consecutive waves add no actionable lead. At depth five, show the remaining leads and ask whether to extend. Preserve time and attention for synthesis and final materials; do not keep expanding until no deliverable can be made.

## Phase 4 — Verify claims

For a disputed, undocumented, performance, or compatibility code claim, run a minimal real script under the applicable pinned versions and record code, full stdout/stderr, environment, and `CONFIRMED`, `REFUTED`, or `PARTIAL` in `verify-<slug>.md`. A `deep-low` verification child (if not listed, use `task`) may run this when assigned a self-contained claim. Judgment alone does not settle an executable disagreement.

For high-risk non-code claims (numeric, dated, legal, causal, financial), admit into `verified-claims` only with at least two independent source domains, two independent observation groups (or a documented primary-only exception), one active counter-search without a stronger refutation, a primary source, and explicit `observed_at` plus `valid_at` or `claim_valid_at`. Otherwise move the claim to the unresolved/refuted annex and abstain from asserting it as settled. A worker's candidate marker can be `CLAIM: ... — RISK: high|normal — SOURCES: ... — COUNTER: ... — PRIMARY: ...`; only the lead decides status.

## Phase 5 — Synthesize

Re-read intent diff, claim graph, observation manifest, debate log, verification outputs, and all wave digests. Write `SYNTHESIS.md` with executive answer, findings by theme, cited primary and independent sources, code paths/lines where relevant, code and non-code verification verdicts, contradictions and corrections, unresolved gaps, observation-group convergence, debate provenance, and a wave-by-wave expansion trace. Every assertion cites `[Source N]` or a verification artifact; high-risk non-code claims come only from `verified-claims`. Distinguish `MEASURED`, `ASSUMED`, and `DERIVED` quantities, show calculations and sensitivity where assumptions affect results. Search mainly in English, deliver in the user's language unless requested otherwise.

## Phase 6 — Deliver and verify

Read `references/deliverable-phase.md` and `references/report-gates.md` in the supplied assets directory. Write `design-spec.md` before parallel asset lanes. Extract an existing HTML/Markdown style with `node "$ASSETS/scripts/report-tools.mjs" format-extract <reference> --out "$SESSION_DIR/design-spec.md"`; fill `TODO: ask` from answers or documented defaults. For LaTeX also read `references/latex-report.md`; compile and inspect every rendered page. For HTML→PDF use an available Chromium command or WeasyPrint, and for DOCX use an available document converter; do not claim a format was delivered if no renderer exists. Figures require a caption, labeled axes/units and preserved aspect ratio; verify every referenced asset exists before rendering.

Run delivery gates in order, recording each with `node "$ASSETS/scripts/report-tools.mjs" outcome gate <static|layout|visual|proofread> <pass|fail|not_run> --session-dir "$SESSION_DIR"`:

1. Static: `node "$ASSETS/scripts/report-tools.mjs" check "$SESSION_DIR/report.html" --design-spec "$SESSION_DIR/design-spec.md" > "$SESSION_DIR/defects.json"` for an HTML report; fix content/structure/source/asset defects.
2. Layout: `node "$ASSETS/scripts/report-tools.mjs" layout-probe --json` provides a probe expression. Evaluate it on the rendered page with the OMP `browser` tool, save boxes to `$SESSION_DIR/boxes.json`, and rerun `check --layout "$SESSION_DIR/boxes.json"`.
3. Visual: render every PDF or slide page to images and inspect them; for HTML inspect desktop and mobile widths through `browser`. Source inspection alone is not visual QA.
4. Proofread: send the final text to a separate `writing` child (if not listed, use `task`) for grammar, terminology, and native language; fix defects, recheck changed passages, then deliver.

For a light conversational answer run the static gate on its rendered artifact where applicable and one render; record inapplicable layout/proofread as `not_run`. Full paginated or web reports run all four. On defects use `node "$ASSETS/scripts/report-tools.mjs" repair decide --state "$SESSION_DIR/repair-state.json" --defects "$SESSION_DIR/defects.json" --artifact-bytes <bytes> --renders <pages> --session-dir "$SESSION_DIR"` and obey `repair`, `deliver` (with disclosed residuals), or `block` (integrity failure). Never suppress a checker failure.

Resolve each promised format with `outcome set <format> delivered --path <file>` or a truthful `blocked_capability`, `skipped`, or `failed` with a reason. Then run `outcome verify`, `outcome finish`, and `outcome briefing`, always with `--session-dir "$SESSION_DIR"`. Paste the printed briefing into the closing response; do not estimate its counts. It identifies distinct source domains, elapsed time, each promised artifact, gate results, and residual defects. Cancel or await every live child using its process/agent handle before the final response; do not leave the roster active. Keep the journal scratch uncommitted and hand the user the artifact at the requested destination.
