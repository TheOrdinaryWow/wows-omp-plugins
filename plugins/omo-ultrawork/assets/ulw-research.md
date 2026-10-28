> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# ULW-RESEARCH — Saturation research with source-faithful delivery

Open with `ULW-RESEARCH MODE ENABLED!`; if another active directive mandates a banner, show that banner first. This is a private research procedure supplied by the extension for an explicit command or binding research request, not a model-invocable skill. An ordinary question does not activate it. Research the requested subject to convergence, challenge the findings, and deliver cited materials that survive the fidelity and delivery gates. A shortened investigation still owes source fidelity, truthful verification, and reference comparison when reproducing something visual.

The extension supplies `Research assets directory: <absolute path>` and `Research scratch root: <absolute path>` after this procedure. Set `ASSETS` to the first and `SCRATCH_ROOT` to the second. The assets are a pinned content-addressed snapshot cached before plugin upgrades can remove the installation. Keep that exact directory for the run; never substitute scripts or references from another release. `node "$ASSETS/scripts/report-tools.mjs" ...` and `bun "$ASSETS/scripts/report-tools.mjs" ...` are equivalent supported entrypoints. The scripts require Node 20+ or Bun and use only built-ins, not installed plugin dependencies.

## Native OMP authority and lifecycle

The lead owns scope, brief, journal, claim graph, source and fact ledgers, verification, synthesis, and delivery. Children return bounded observations, sources, claim candidates, and EXPAND leads; they do not edit shared journal files. A separately assigned asset, reader-verdict, or report lane may write only its named output files.

Use one native `task({ tasks: [...] })` batch for independent axes. Pick exact names from its live roster: `scout` for local read-only discovery, `librarian` for external evidence (otherwise `scout`), `sonic` for cheap mechanical reading, `deep-low` for bounded engineering judgment, `ultrabrain` for strong review, and `writing` for language. When a specialist is absent, omit `agent` for the native default rather than inventing a selector. Coordinate through `write agent://<id>`; replies are auto-delivered, and `wait` is only for otherwise-blocked background work. Do not use Senpi team, workflow, category, load_skills, task_send, task_output, or task_cancel APIs. Every child executing verification or rendered QA receives a `VERIFY` section naming the exact checks, scenarios, and output artifacts it must run and return.

Reuse an **explicitly active** `ulw-loop` if its objective owns this research: read `ulw_loop` status, map axes and evidence to its existing goals/criteria, and mirror steering without creating a second aggregate. Otherwise keep the research-journal lifecycle. `/ulw-research` does not start a loop or a native goal. An approved controlling workflow retains ownership; research does not bypass its decisions. Findings are evidence, not RED→GREEN test targets. After compaction, re-read the brief, journal, claim graph, outcome, and active-loop status before another dispatch.

## Phase 0 — Scope, journal, and fidelity interview

Scope the question yourself before spawning: core information need, expected truths from user intent or an evidenced contract, three or more orthogonal axes, source territories, source-access requirements, likely ambiguities, falsifiers, precision demand, scale, and one named owner per axis. Settle a named entity's canonical identity and first-party source before anyone expands its history or performance.

Read `references/research-setup.md` in full, then `references/deliverable-phase.md` sections 1–6. Use an actual filesystem run directory: Node/Bun helpers cannot resolve `local://` URLs.

```bash
ASSETS="<Research assets directory>"
SCRATCH_ROOT="<Research scratch root>"
SESSION_DIR="$SCRATCH_ROOT/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SESSION_DIR"
```

Keep `SESSION_DIR` absolute and pass `--session-dir "$SESSION_DIR"` on every helper call. This is uncommitted scratch, not the requested final destination. Use `local://ultrawork/<slug>-research.md` for an optional native handoff pointer to the real paths, never as a CLI argument. Create the run once; `outcome init` records its start clock from `--started-at <ISO>`, supported supervisor metadata, or the timestamped directory, not from a later resumption.

Maintain these lead-owned files as evidence arrives:

- `brief.md`: core question, axes/owners, expected truths, source territories, scale, debate strategy, delivery lane, formats, destination, audience, template, and `answered_by: user|default|request|pending`.
- `intent-diff.md`: expected truth, observed reality, violated invariant, intent source, observation and claim ids, and true/violated/unknown status.
- `claim-graph.md`: the single final-claim store; a Markdown table with `claim_id | statement | risk tier | status | fact_ids` plus scope, type, intent ids, support/counter-observations, independence groups, validity, dependencies, primary source, counter-search, skeptic verdict, and synthesis location. Use `C<n>`, `high|normal`, and `supported|partial|refuted|unresolved`. Under `## verified-claims`, list `- C<n>: <statement>` only for high-risk non-code claims that clear the gate below. Old free-form graphs must be preserved and normalized into this table, not treated as an allowlist.
- `observation-manifest.md`: observation id, observer/group, independence basis, source URL/path, `observed_at`, `valid_at` or `claim_valid_at`, exact artifact/quote locator, and contamination notes.
- `sources-ledger.md`: `[S<n>] <url or path> — <description>` immediately on retrieval; `sources/S<n>/` contains immutable captured bytes, extraction metadata/hashes, sentence/acronym indexes, and any command receipt.
- `fact-ledger.json`: every measured value, direct quotation, scripted derivation/conversion, or explicit assumption used in `SYNTHESIS.md` and every delivered edition. Fill maps, `claims.json`, `pairs.json`, `fidelity-state.json`, edition-specific fidelity/meaning records, and run-local `fidelity-calibration.jsonl` preserve the dataflow.
- `verification-economics.md`, `cause-disappearance.md`, `excursion-log.md`, `debate-log.md`, `expansion-log.md`, `wave-<n>-<axis>.md`, `verify-<slug>.md`, and `SYNTHESIS.md`: append proof decisions, causal/disconfirming observations, excursions, attacks/defenses/verdicts, and each worker return as it lands. Never reconstruct a journal from memory at the end.

Derive the delivery lane (`template-strict|template-vibe|no-format|edit-existing`) and formats from the request/destination. For an existing deliverable, run `outcome state --deliverable <path>`: partial resumes the skeleton; complete means edit, not regenerate. A document with no format/destination defaults to PDF plus DOCX; a conversational answer does not manufacture those promises. Ask only consequential information not settled by request, source, or documented default, through native `ask` when available; do not invent a nonblocking question API. Collection may proceed with explicit pending fields, but fill and verification cannot.

Lock seven lines under `## Fidelity` in `brief.md`, each with `answered_by`, and retain `asked:` history. Follow the exact inference/interview rules in `research-setup.md`:

1. `as of`: the named version, commit, release, date, period, or run-start anchor; ask for genuinely unresolved time-sensitive anchors.
2. `meaning check`: `on` for full reports and precision-sensitive legal/medical/financial/procurement/public-facing answers without speed wording; `off` for the ordinary light tier. Resolve conflicting speed/precision signals rather than guessing. A focused request uses the documented `force strong` form.
3. `source floor`: `standard`, `primary only`, `pointed only: <ids/URLs/paths>`, or `classes: <host suffixes>`. Seeds alone are not a restriction; unresolved conflicts remain pending.
4. `derived numbers`: exactly `allowed` or `none`; partial allowances use `none` and disclose that interpretation. `none` also excludes converted and assumed rows.
5. `languages`: report in the user's language (Simplified Chinese unless requested otherwise), actual source languages, and original quotes with translation beside when needed.
6. `identifier classes`: domain-specific versions, packages, commits, tickers, filings, statutes, DOIs, etc., or `none`. This is recorded policy, not a universally enforced classifier.
7. `fallback`: exactly `block-quote` or `omit`.

Initialize `outcome init --promised <formats> --lane <lane>` and write `design-spec.md` plus an early report skeleton with `STATUS: draft — <n> sections open`. Extract a pointed-at HTML/Markdown template with `format-extract <reference> --out "$SESSION_DIR/design-spec.md"`; resolve `TODO: ask` from answers or recorded defaults. For visual reproduction add `Reference compare: required`, source, and matched moments/viewpoints to the brief. Do not write workspace-global calibration or invented memory-palace files; use available native preference memory only when its contract actually supports it.

## Phase 1 — Parallel collection with immutable provenance

Read `references/collection.md` and `references/fact-ledger.md`. Launch disjoint axes and a skeptic together, sized to the actual scope and available native concurrency. A MASS request uses the available `mass-ulw` procedure for dependency-graph collection; if unavailable, say so and use native batches without inventing that engine. Each assignment states TASK, unique AXIS, source scope, exact return schema, provenance fields, EXPAND tail, and any explicit VERIFY checks. Children must not start another swarm.

**Intentional OMP acquisition deviation: static-first, browser-required when material.** Search snippets identify candidates, not final sources. Read static primary documentation/datasets in full with native `read`/search, preserving immutable snapshots and explicit extractor provenance. A claim about rendering, authenticated content/access, interaction, or visual state **requires native OMP browser evidence**. Such a child must first read `xd://eval/browser`, use its own tabs, inspect the rendered state, and save the actual capture, access/auth state, URL, time, and relevant screenshots. Optional installed `ultimate-browsing` is for genuinely blocked platforms/archives, not a replacement browser engine; absent access is a reported gap. Never invent a browser skill, connector, cookie utility, or Senpi tool.

Snapshot each retrieved source before registering a fact:

```bash
node "$ASSETS/scripts/report-tools.mjs" source snapshot --id S1 --url <static-url> --provenance primary --revision <anchor> --session-dir "$SESSION_DIR"
node "$ASSETS/scripts/report-tools.mjs" source snapshot --id S2 --html <actual-browser-capture.html> --provenance primary --revision <anchor> --session-dir "$SESSION_DIR"
node "$ASSETS/scripts/report-tools.mjs" source snapshot --id S3 --text <verified-text.txt> --extractor <actual-name>@<version> --session-dir "$SESSION_DIR"
```

`--url` is plain fetch, not rendered/authenticated provenance. `--html` and unlabelled `--text` imports are lower-trust `model` extraction; use a named extractor only when it truly produced those bytes. Do not fetch an authenticated URL again and substitute potentially different bytes for its capture. Inspect the saved snapshot and printed context, not merely a snippet. Same-id/same-text is idempotent; changed content refuses, and `--replace` refuses while active ledger rows pin that source. Correct a conversion by verified text only after retracting its rows or choosing a new source id. HTML/URL snapshots probe altered numbers automatically; for another conversion run `source probe-conversion <raw> <converted>` before fact registration. `altered` numbers block registration; `lost` is a warning, not permission to invent them.

Use `find` for unknown code behavior, exact search/structure/LSP for known symbols, and SHA-pinned code citations. Record source access time, validity, independence group, and contamination from common upstream sources. Two URLs on one domain do not prove independence. A command-shaped proof may use `source snapshot --command '<argv JSON>' --cwd <dir>` for a real argv/no-shell receipt; an asserted verified claim is not command output.

Every substantial return ends:

```markdown
## EXPAND
- LEAD: <observation> — WHY: <effect on answer> — ANGLE: <next probe>
- DEAD END: <lead and reason>
```

If none, `none — <reason>`. Request a missing tail once. Journal every return immediately, relay urgent discoveries to the existing owner over `agent://`, and never assign two children the same file or angle.

## Phase 2 — Expand, debate, and converge

Deduplicate leads against all previous waves, not only supported claims. Route unchecked leads to a live owner or a bounded new native batch. The skeptic attacks every supported claim, especially surprising/high-risk/contested ones: alternative explanations, stronger counter-sources, temporal mismatch, and nonindependent observations. Relay defense and record verdict/change in `debate-log.md`.

An excursion needs an explicit ENTER trigger: contradiction of a locked claim, a finding that changes the answer, an unowned source territory, or quoted user steering. Record worker/probe bounds, allow one nested excursion only, and EXIT when resolved, two probes add nothing, claim status stops moving, or its bound is spent. Every EXIT states its effect (`none` allowed), updates the parent, and mirrors evidence/steering only into an already-active loop. Three no-change excursions end excursions. Relay user steering verbatim to every live owner.

For multi-faceted questions, perform at least two expansion waves. Converge when all leads are pursued/closed or three consecutive waves add no actionable lead. At depth five, show open leads and ask whether to extend. A finished child is not convergence. Preserve room for synthesis and delivery rather than expanding without ever producing materials.

## Phase 3 — Prove claims and register facts

For contested, undocumented, performance, or compatibility code claims, execute a minimal real script under the applicable pinned versions. Record exact code, full stdout/stderr, environment, version, and `CONFIRMED|REFUTED|PARTIAL` in `verify-<slug>.md`; a child needs the explicit VERIFY assignment. Judgment cannot settle an executable disagreement.

High-risk non-code claims (numeric, dated, legal, causal, financial) enter `verified-claims` only with two independent domains, two independent observation groups (or a documented primary-only exception), an active counter-search without a stronger refutation, a primary source, and `observed_at` plus validity. Otherwise keep them unresolved/refuted and abstain from settled assertion. The lead decides status; a worker's candidate is not approval.

Register every value/quote by locator, inspect the returned row/context, and write placeholders rather than manually copying values into prose:

```bash
node "$ASSETS/scripts/report-tools.mjs" fact add --source S1 --find <unique-anchor> --label capacity --session-dir "$SESSION_DIR"
node "$ASSETS/scripts/report-tools.mjs" fact quote --source S1 --match <unique-words> --label caveat --session-dir "$SESSION_DIR"
node "$ASSETS/scripts/report-tools.mjs" claims index "$SESSION_DIR/claim-graph.md" --out "$SESSION_DIR/claims.json"
```

Use table labels (`--table --row --col`) or document `--page --line` when appropriate. `{{F1:capacity}}` renders the value/unit, `:value|:unit|:q` select parts/qualifiers, and `{{Q1:caveat}}` or documented anchored selectors render exact quotations. `fact derive --op sum|diff|growth|ratio|share|convert|expr` computes compatible units, period, population, precision, and rational operands; do not calculate by prose. An assumption uses `fact add --assumed ... --rationale ...` and is visibly ASSUMED. Retract/supersede wrong rows with audit history, never delete or hand-edit them. See `fact-ledger-grammar.md`, `unit-rules.md`, and `fidelity-claim-kinds.md` for exact rules.

## Phase 4 — Synthesis and report assets

Re-read the intent diff, claim graph, observation manifest, debates, verification outputs, and every wave digest. Write `SYNTHESIS.md` with the answer, themed findings, primary/independent citations, code permalinks/lines, proof verdicts, corrections, unresolved gaps, independent-group convergence, debate provenance, and expansion trace. Every assertion cites a retrieved source or verification artifact; high-risk non-code assertions come only from `verified-claims`. Every findings sentence binds to a fact, quote, `[S<n>]` citation, or `data-claim="C<n>"`. Review filled text with `fact fill ... --view`, not raw placeholders. Distinguish MEASURED, DERIVED, and ASSUMED, show operations and sensitivity where assumptions matter. Retrieve mainly in English, add source-local-language searches when useful, and deliver in the requested language; preserve original-language quotations.

Before asset lanes read `references/report-visualization.md`. Give each lane the authoritative `design-spec.md` path. Export chart data only through `fact export --csv --out <chart.csv>` and attach `data-chart-source` to its figure; do not plot invented prose values. Use available task-scoped `uv run --with ...` packages or project/temporary tools (no global installs or plugin runtime dependencies). Where installed, use `data-scientist`, `frontend`, and `visual-qa` guidance. Use real available fonts appropriate to the report language, including Chinese; do not assume Korean-specific fonts cover every CJK script.

A full report contains meaningful rendered visuals, not decorative logos or a Mermaid source block. Charts need title, axes, units, value labels, real exported data, source/caption, and alt text. Figures preserve aspect ratio in contain-fit containers. Decorative images use `alt=""` plus presentation/none/hidden semantics and do not satisfy the visual minimum; zero-size images do not either. `report_without_visual` is major and `image_missing_alt` minor. Verify referenced assets exist and are nonempty before rendering.

For a visual reproduction, capture real source frames at the brief's moments/viewpoints, render the output at the same ones, compose side-by-side pairs, inspect/critique each pair, fix the largest differences, and compare again within the repair bound. Include final pairs with attributed captions and alt text in the report, first-round pairs beside final ones in the correction log, and truthful remaining differences. An output inspected only against itself is unverified, even on a simple topic.

Author standalone HTML/Markdown and produce only promised formats the session can actually render. PDF/DOCX render from a verified HTML/Markdown source; use an available Chromium/WeasyPrint/converter, not an invented host tool. For LaTeX also read `references/latex-report.md`, verify its authoritative Markdown source (direct `fact verify --format tex` is unsupported), compile, and inspect every page. Preserve sources and mark unavailable formats `blocked_capability` with the real reason.

## Phase 5 — Five delivery gates and protected polish

Read `references/report-gates.md` and the delivery contract again. Run in this execution order: **static → fidelity and meaning → layout → visual → proofread → post-polish fidelity/changed-meaning recheck**. Record with `outcome gate <static|fidelity|layout|visual|proofread> <pass|fail|not_run>`. Full web/paginated reports owe all five; light answers owe static plus an appropriate render, and inapplicable steps are truthfully `not_run` with a reason. Fidelity is never skipped merely because repair ran out.

1. **Static.** `check <report.html> --design-spec <spec> --out` is not an output-writing interface: capture its stdout JSON as `defects.json` through the available execution tool. It checks content, structure, citations, assets, visual minimum, and alt semantics. `check` exits 1 for blockers only; exit 0 with major/minor defects is not visual perfection. Inspect counts/defects and repair.
2. **Fidelity.** `fact fill <placeholder-source> --out <report.html|report.md>` writes the edition and its fill map. `fact verify <report> --session-dir "$SESSION_DIR"` checks the current locked brief, ledger/snapshot hashes, quotes/values/units, claims, chart values, and sentence bindings, writing `fidelity-defects.json` with `artifact_sha256`. Any blocker or major exits 1; minors are disclosed. Every byte-distinct reader-facing edition needs its own verify record (`--out <edition-record>`); Markdown needs its fill map. Never edit a filled value by hand: fix the row/placeholder and fill again.
3. **Meaning (within fidelity).** If the locked brief says off, `fact pairs` writes `skipped: true`; do not invent reader results. Otherwise `fact pairs <report>` writes source-paired sentences to `pairs.json`. Spawn the cheapest adequate reader (`sonic` if listed, otherwise the native default), then a strong reader (`ultrabrain` if listed, otherwise the native default with a strong-judgment assignment) for cheap-flagged pairs and every `force_strong` pair. The prompt contains only the **pair-file path** and the verdict schema below, not inline quote bytes or unrelated report/journal context:

```text
TASK: meaning reader, <cheap|strong> tier.
Read ONLY <absolute pair-file path> and its verdict_schema. Do not open, search, fetch, or consult any other file/page/tool output: not the report, ledger, sources, or claim graph.
Compare each sentence with its quote (or the claim statement). Decide whether it changes subject, scope, certainty, causality, direction, population, or evidence grade. Faithful shortening/summarizing/translation is ok.
Write <absolute verdict-output path> as {"model_tier":"<cheap|strong>","verdicts":[...]}, one verdict per pair_id. A drift verdict names one allowed drift_kind, exact nonempty fragment/source_fragment copied from the sentence and quote/statement, and a one-sentence explanation. Never paraphrase the fragments. Return verdicts only; do not rewrite anything.
```

Build `pairs-strong.json` by retaining the cheap-flagged and `force_strong` pairs, preserving their exact bytes/metadata. Ingest with `fact meaning-check --pairs <all-pairs> --verdicts <cheap> --verdicts <strong> --edition <format>`. Missing coverage/strong coverage is `meaning_unverified`, not a clean empty result. Fabricated fragments are dropped. Two tiers agreeing on a non-`other` drift kind confirm a major; a single flag is a minor warning. Never turn a dispute into permission to deliver: record it, rewrite from the quote, rerun pairs/readers, and recheck. Newest matching-byte meaning record wins; equal-time more severe wins. Calibration stays run-local and never automatically changes integrity severity.

4. **Layout and visual.** Evaluate the expression from `layout-probe --json` on the actual rendered page with native OMP browser, save `boxes.json`, and rerun `check --layout <boxes>`. Inspect HTML at desktop/mobile widths and every PDF/slide page as pixels. Source inspection is not visual QA; record actual captures and unavailable capabilities honestly.
5. **Proofread without changing facts.** A separate `writing` child (native default if absent) reads the authoritative current artifact and returns only `polish-edits.json` (`[{before,after,reason}]`), never edits the report. Apply with `fact polish-apply <report> --edits <edits> --out <polished>`. Its exit 0 means an output was written, **not** that every edit applied: inspect top-level `applied`, accepted/rejected/unlocated edits, and defects. Safe edits apply independently; facts, numbers, identifiers, hedges, links, entities, tags/attributes, comments, hidden content, script/style, and structural markup stay protected. Run `fact polish-diff --before <report> --after <polished>`, re-run `fact verify`, and generate `fact pairs <polished> --changed-since <pre-polish.fill-map.json>` for fresh changed-pair readers. Reuse prior verdicts only for unchanged pairs as the reference describes; edited byte editions still need current bound meaning/fidelity records. Mark proofread pass only after this chain passes.

After each defective gate, run `repair decide --state <repair-state.json> --defects <static-record> --defects <fidelity-record> --defects <meaning-record> --artifact-bytes <bytes> --renders <pages> --session-dir "$SESSION_DIR"`. Obey repair/deliver/block, with the documented 3-attempt, plateau, oscillation, and 15-minute bounds. A deliver-on-exhaustion decision never clears unresolved fidelity blockers/majors: `outcome verify` and `outcome finish` still refuse them.

## Phase 6 — Exact-edition delivery and closing briefing

Resolve every promised format with `outcome set <format> delivered --path <actual-file> --verified-by <fidelity-record>`. Rendered PDF/DOCX also name `--rendered-from <verified-source>`; the record must match that source's exact hash. Same-byte copies may share proof; changed bytes may not. Otherwise use `blocked_capability|skipped|failed --reason <truth>`. A pending row is not completion.

`outcome.json` is OMP schema v2, independent of still-v1 `repair-state.json`. Reading v1 upgrades in memory, preserves timestamps/deliveries/gates/repairs/residuals/optional fields, adds fidelity `not_run` and `legacy_unverified` provenance, and does not rewrite the old file until the next mutation. Historical delivery stays readable and is never retroactively described as verified. Before resuming or redelivering, infer/lock Fidelity, normalize the claim table, register snapshots/facts, fill, and verify current bytes. A legacy marker is not a delivery exemption.

Run `outcome verify`, `outcome finish`, then `outcome briefing`, always against the same `SESSION_DIR`. Paste the script's printed closing block, never reconstruct counts from memory. Add recorded worker/wave/debate/excursion/proof effort and the `fact export` coverage line (snapshotted sources by extractor). Explain real unresolved gaps and capability limits.

OMP has no inline-HTML delivery tool: do not call show_html_page or html_render. Deliver standalone files/paths, native-browser-inspected screenshots where appropriate, and a concise chat-readable answer with sources and the printed briefing. Optional installed `visualize` may guide portable HTML, but it does not add a tool. A built app/scene is not its research report; include the report and reference-comparison evidence too. Await every live child to terminal status (or use an actual owned process cancellation handle if necessary) before closing; do not claim unsupported team teardown or cancellation. Keep scratch uncommitted and hand the user artifacts at the requested destination.
