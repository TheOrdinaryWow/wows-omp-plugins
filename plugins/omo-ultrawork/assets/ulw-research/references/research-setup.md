> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

> **OMP adaptation.** The private parent procedure controls native task/agent selectors, `agent://` coordination, static-first immutable acquisition (browser required for rendered/authenticated/visual claims), active-loop-only reuse, and file/summary delivery. `$ASSETS` is the supplied pinned filesystem snapshot; `$SESSION_DIR` is the actual run directory. Node/Bun helpers cannot resolve `local://`. Use task-scoped/temporary tools only; no global installs, plugin runtime dependencies, or Senpi APIs.

## Phase 0 — Decompose and open the journal

Before spawning anything, decompose the query. Start from "what must be true if the user's intent/spec is true?", not "what looks broken?" Seed `intent-diff.md` with those expected truths before treating code, current docs, or web results as the source of truth:

```
<analysis>
Core question: <the actual information need>
Axes (3+ orthogonal): <axis — what to search, where, why> ...
Codebase relevant: <yes/no> · External: <yes/no> · Collection: <static-first | browser-required> · Verification likely: <yes/no>
Scale: <axis count, source territories, target document length> · Precision demand: <what a wrong claim costs here> → lifecycle: <single team | research team then refinement team>
</analysis>
```

**Intentional OMP deviation:** static-first native `read`/search for complete static sources, with immutable snapshots and truthful extractor provenance. `Collection: browser-required` is mandatory when any claim depends on rendered, authenticated, interactive, or visual state. Assign those lanes to native OMP browser, beginning with `read xd://eval/browser`; snippets alone do not back a substantive claim.

Then create the session directory:

```bash
SESSION_DIR="<Research scratch root>/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SESSION_DIR"
```

This is `$SESSION_DIR`. The orchestrator owns the journal: you write every file in it; workers never do (a mass-research dag node writes only its own `waves/<run-key>/<node-id>.md` handoff file, which carries its EXPAND tail and claim candidates; you journal from it). Maintain:

- `brief.md` — the analysis block, the axis list, the expected truths, and the `## Deliverable` record from the interview below (lane, state, formats, each field with `answered_by`).
- `sources-ledger.md` — one line per source the moment it is read: `[S<n>] <url> — <what it is>`. The closing briefing counts sources and domains from this file.
- `sources/` and `fact-ledger.json` — the source snapshots and the verbatim fact ledger ([references/fact-ledger.md](fact-ledger.md)). Every number and every direct quotation in the report comes from a ledger row through a `{{F<n>:label}}` or `{{Q<n>:label}}` placeholder; nobody types a value into a report or into `SYNTHESIS.md`.
- `wave-<N>-<kind>-<axis>.md` — your digest of each worker return: key findings, sources with URLs, and the worker's EXPAND markers verbatim.
- `expansion-log.md` — per wave: workers spawned, markers gained, leads opened and closed.
- `excursion-log.md` — one ENTER row and one EXIT row per excursion: `excursion_id`, parent claim or axis, ENTER trigger, depth, workers spent, the EXIT rule that closed it, what it changed in the top-level answer (`none` is a valid, required answer), and the ulw-loop steer/evidence id it was mirrored into.
- `intent-diff.md` — orchestrator-owned expected-truth ledger comparing intent/spec/history to observed reality.
- `claim-graph.md` — orchestrator-owned claim graph linking every final assertion to observations, counterevidence, dependencies, and verdict.
- `observation-manifest.md` — orchestrator-owned observation manifest with `observed_at`, temporal validity, artifact paths, and contamination notes.
- `verification-economics.md` — proof-cost ledger mapping claim risk to verification path, deferral decisions, and residual risk.
- `cause-disappearance.md` — cause ledger tracking expected truth, previous observation, `last_seen`, disconfirming observation, and whether the violation is no longer observed.
- `verify-<slug>.md`, `SYNTHESIS.md`, `REPORT.*` from later phases.

Append each digest the moment its worker returns, not in a batch at the end — the journal is your recovery point after context loss and the user's audit trail.

### Reuse an active loop, and journal in real time

Reuse only an explicitly active `ulw-loop` whose objective owns this research; read `ulw_loop` status and bind research axes/evidence to its existing goals and criteria. Otherwise keep this journal lifecycle: `/ulw-research` never starts a loop/native goal or creates a second controlling aggregate. The run clock is recorded once by `outcome init` (`--started-at <ISO>`, supported supervisor metadata, or the timestamped directory). Write every source, fact, quote, finding, and lead immediately. After context loss re-read the brief/journal and, only if active, loop status.

### Deliverable lane, format, and the empty-info interview

Never block collection on the shape of the deliverable, and never guess it either. Read [references/deliverable-phase.md](deliverable-phase.md) sections 1-6 before writing the brief, then:

1. **Derive first.** Name the lane (`template-strict`, `template-vibe`, `no-format`, `edit-existing`) and the promised formats from the request and its destination (the reference's section 3). When the request refers to an existing deliverable, decide its state with `node "$ASSETS/scripts/report-tools.mjs" outcome state --deliverable <path> --session-dir "$SESSION_DIR"`: `partial` resumes the skeleton on disk, `complete` means edit-existing and never a regenerated report. `$ASSETS` is the absolute pinned Research assets directory supplied by the extension, not a model-loadable skill directory.
2. **Reuse an explicitly recorded preference** only through an available native memory contract or this run's brief. Do not invent memory-palace paths, write automatic preference episodes, or learn from an unconfirmed choice.
3. **Ask only what is still missing**: at most the reference's three questions (destination and format, audience and length, template lineage) in one call to the harness question tool (native `ask`, when available), without claiming a nonblocking capability the native tool does not provide, each with its default first, a free-text "describe the format" path, and "don't care, you decide". Collection starts without waiting; a late answer is folded in until the assembly worker starts, and after that it becomes a re-render request.
4. **Settle source fidelity in the same step.** Seven fields under `## Fidelity` in `brief.md` say what the report must stay faithful to; the reference's section 4 lists each field's values and default. Infer every field before asking anything; an explicit word in the request decides a field (`answered_by: request`), the destination, the sources, and the Phase 0 axes supply the rest (`answered_by: default`):
   - `as of`: a version, release, tag, commit, date, quarter, "as of", "current", or "latest" in the request decides it; a pointed-at repository anchors on its HEAD or tag at run start, pointed-at documents on their own revisions, and a comparison of two anchors records `multiple: <a>, <b>; rows tagged`. Default `latest at run start, <run date>`, the date of the `$SESSION_DIR` timestamp. Ask when the topic is version-bound or time-sensitive (software, APIs, standards, prices, rates, rankings, laws, programs, schedules) and nothing names an anchor; a stable topic takes the default silently.
   - `meaning check`: the QA tier decides (full: `on`, light: `off`); a chat answer on a legal, medical, financial, procurement, or public-facing question with no speed word is `on`. Ask when two explicit signals disagree: a document deliverable under a literal "quick" or "fast", or a light-tier answer that carries both a speed word and a precision demand; `on` goes first.
   - `source floor`: "official docs only", "peer-reviewed only", "SEC filings" give `primary only` or `classes: <host suffixes>`; "from these only" gives `pointed only: <source ids, URLs, or paths>`; pointed-at sources with no restricting word are seeds, not a floor. Default `standard`. Ask when a restricting phrase sits beside an open-ended question whose answer lives outside that floor. Declare each source's provenance when you snapshot it (`source snapshot --provenance primary|secondary`, by the Phase 3b primary-source rule); `primary only` refuses every source not declared `primary`.
   - `derived numbers`: "compare", "growth", "share", "estimate" give `allowed`; "only the sources' own numbers", "no estimates" give `none`. Default `allowed`. Ask when both kinds of phrase share one request. Record only `allowed` or `none` (any other value stops `fact fill` and `fact verify` with a usage error); a partial or free-text answer records `none`.
   - `languages` (never asked): the report in the user's language or the one they named; sources `en`, plus the user's language for a local topic, plus the pointed-at documents' languages; quotes `original` when every source language equals the report language, else `original with translation beside`.
   - `identifier classes` (never asked): from the Phase 0 axes' domain (software: version strings, package names, commit ids; finance: tickers, filing ids, fiscal periods; law: statute, article, and case numbers; science: gene names, DOIs, trial ids), else `none`. It is recorded only; no gate enforces it yet.
   - `fallback` (never asked): `block-quote`, or `omit` on "drop anything you cannot verify"; no other value is accepted.

   Ask nothing when the request, the destination, and the sources decide every field. Otherwise ask only the fields whose trigger fired, in the same question-tool call as the format questions (native `ask`, when available), without claiming a nonblocking capability the native tool does not provide, each with its default first, a free-text path, and "don't care, you decide" (it resolves to the first option, recorded `answered_by: user`). At most four questions ride in that call: `pending` fidelity fields first, then format Q1, Q2, Q3, then `as of`, `meaning check`, `source floor`, `derived numbers`; a question that loses its slot runs on its default and is named, with that default, in the reply that opens collection. When each reading of a field would make part of the request undeliverable, record it `pending` with no default. Collection starts regardless: `source snapshot`, `fact add`, `fact quote`, `fact derive`, `fact retract`, and `fact export` keep working while answers are pending; only the six reader-facing commands (`fact fill`, `fact verify`, `fact pairs`, `fact meaning-check`, `fact polish-apply`, `fact polish-diff`) and the assembly lane wait for the lock, and those commands exit 1 with `fidelity_interview_incomplete` while a field is `pending` or missing. When the assembly lane is about to start, a field still awaiting its answer keeps its default; a `pending` field is asked once more, blocking this time.
5. **Record it.** Write `## Deliverable` into `brief.md` (lane, state, formats, destination, audience, template, format description, each with `answered_by: user|default|request`) plus `## Fidelity` (the block below), and open the manifest in the same step: `node "$ASSETS/scripts/report-tools.mjs" outcome init --promised <formats> --lane <lane> --session-dir "$SESSION_DIR"`. When the ask is to recreate, reproduce, or rebuild something visual, add `Reference compare: required` with the source (URL or file) and the moments to compare; the comparison runs on every round of the build, not only at the end.

#### The fidelity questions

Ask them in the user's language, translating these English texts faithfully and keeping the option order; `<run date>` is the `$SESSION_DIR` date.

- **`as of`**, header `As of`: "Which version or date must the facts hold for? Sources are snapshotted and quoted against that anchor."
  1. `Latest as of today, <run date>` - The state published at the run's start; anything older is flagged as stale.
  2. `Other: a named version, release, or date` - Type it (v3.2, 2026-Q3, a commit or tag). Every quote and number is checked against sources valid at that anchor.
  3. `Don't care, you decide` - Resolves to option 1.
- **`meaning check`**, header `Drift check`: "Numbers and quotes are always script-checked against source snapshots. Should every explanatory sentence also be read against its source quote by a separate reader? Slower and more tokens; it catches widened scope and dropped hedges."
  1. `On` - Every sentence is paired with its source and read; confirmed drift is rewritten from the quote or listed in the briefing.
  2. `Off (faster)` - Script checks only: numbers, units, quotes, qualifiers, bindings. A paraphrase that shifts meaning is not read.
  3. `Other: where to focus` - Type it ("the financial sections", "anything about the competitor"); those pairs go to the strongest reader.
  4. `Don't care, you decide` - Resolves to option 1.
- **`source floor`**, header `Sources`: "Which sources may back a statement of fact?"
  1. `Standard: primary source required for high-risk claims` - Numeric, legal, financial, dated, and causal claims need a primary source plus two independent domains; other claims may cite attributed secondary sources.
  2. `Primary only` - Every fact traces to a first-party source (standard, filing, dataset, official doc); commentary appears only as attributed opinion.
  3. `Only the sources I pointed at` - Ledger rows come from the named files and URLs only; anything else is context, not evidence.
  4. `Other: name the source classes` - Type it ("peer-reviewed only", "no vendor blogs").
  5. `Don't care, you decide` - Resolves to option 1.
- **`derived numbers`**, header `Derived`: "May the report state numbers no source states (sums, growth rates, shares, unit conversions, estimates)?"
  1. `Yes, computed by script and labeled DERIVED` - Each one names its operation and input rows; inputs are checked for unit, period, and population compatibility; an estimate carries its assumptions.
  2. `No, sourced numbers only` - Every number is a MEASURED ledger value; comparisons are stated in words or shown side by side.
  3. `Other: describe` - Type it ("growth rates yes, estimates no"). A partial allowance is recorded as `none`, and the reply that opens collection says so.
  4. `Don't care, you decide` - Resolves to option 1.

#### The `## Fidelity` block

Write it in the same step as `## Deliverable`, provisional defaults included, one line per field with its `answered_by`, plus an `asked:` line naming the fidelity questions sent:

```text
## Fidelity
as of: latest at run start, 2026-10-23 (answered_by: default)
meaning check: on (answered_by: default)
source floor: standard (answered_by: default)
derived numbers: pending (answered_by: pending)
languages: report en; sources en; quotes original (answered_by: default)
identifier classes: version strings, package names, commit ids (answered_by: default)
fallback: block-quote (answered_by: default)
asked: derived numbers
```

Values carry no parentheses; `pending` goes only with `answered_by: pending`. When an answer lands, rewrite that one line with `answered_by: user` and leave `asked:` as history; a late answer after `fact fill` is a re-render: fill again, then verify.

**Re-entry.** An `edit-existing` session, or any session created before this block existed, has no `## Fidelity`. Before any `fact` command, run the inference step above and write the block with `answered_by: default` on every field. `claims index` on a free-form `claim-graph.md` (no claim table) returns `{claims: [], errors: [...]}`, exits 2, and writes no `claims.json`; run `fact verify` without it, and the gate reports each unbound sentence as `unbound_sentence` (major) instead of blocking.

**Calibration.** Keep `fact meaning-check` calibration in `$SESSION_DIR/fidelity-calibration.jsonl` (or an explicitly chosen run-local path). Never automatically append to workspace-global state. Comparing logs from several runs is an explicit analysis, not a hidden memory/backend. Promotion eligibility is reported; it does not automatically change integrity severity.

Phase 5 opens by turning the recorded fields into `design-spec.md`.
