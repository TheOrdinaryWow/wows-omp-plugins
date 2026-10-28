---
name: give-me-tips
description: "Explain a quoted OMP or installed-plugin tip, command, or feature using installed documentation, live schemas, configuration, and implementation evidence. Use when a user asks what a Tip line means, how a feature works, or whether it is available here. External-product tips require an explicit request."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Explain the actual feature

Start from the exact quoted tip, command, UI line, or feature in the user's message and recent context. Respond in the user's language. Explain the mechanism and its practical limits, not a generic paraphrase, marketing claim, or tour of unrelated features. If the wording is ambiguous, first inspect available conversation/context; ask for the exact line only when that cannot resolve it.

This skill is an **OMP/installed-plugin feature explainer**, not a tip engine. It adds no rotating startup tips, catalog state, cooldown tracking, eligibility API, or onboarding service. Do not run `omp --list-tips`, query invented `tipsHistory`, invoke `onboarding_*`, or read a Senpi settings file as if it configured OMP.

## Evidence ladder

1. **Identify ownership.** Is the line from the host, an installed plugin, a repository instruction, or an explicitly named external product? Do not attribute a third-party message to OMP merely because it appeared in this terminal.
2. **Read installed sources first.** For host behavior use relevant `omp://` docs and the active tool schema. For a plugin read its installed README, REFERENCE and configuration schema; NOTICE identifies source provenance, not proof of a currently enabled runtime. For skills, read their actual `skill://` procedure and prerequisites.
3. **Check availability without changing it.** Distinguish documented, installed, configured, enabled, available in this session, and actually exercised. Inspect only relevant non-secret settings using documented configuration surfaces. A visible command/tool confirms that surface exists, not that credentials, a backend or a third-party service are ready. Do not enumerate credentials or open auth files. No writes, installs, login, global toggles or test actions are authorized by a request for explanation.
4. **Explain the real implementation when needed.** Follow source pointers from installed docs if source is physically available. Use native discovery/LSP references where appropriate. Do not assume a local source checkout or invent install paths. If the question needs upstream internals, use an available librarian to research the exact product/revision, then cite the retrieved source; do not replace installed behavior with the latest upstream branch. If source is unavailable, say the explanation is documented behavior rather than claiming a verified implementation detail.
5. **Resolve disagreements explicitly.** The installed implementation/active schema outranks stale prose for this installation. State a mismatch and its impact. Missing evidence means unknown or unavailable, not an invented fallback mechanism.

Cite each important claim with the actual source read: `omp://...` sections, installed plugin file paths/line ranges, active tool-schema names, or remote source URLs/revision. Keep an inference clearly labeled. Do not expose personal settings, session contents or secrets as evidence for an ordinary feature explanation.

## Shape of the answer

- **What the line means:** one sentence anchored to the quote.
- **How it works:** the concrete trigger, prerequisites/configuration gate, action/state/evidence flow, and stopping/failure behavior relevant to the question. Include only mechanisms actually supported by the sources.
- **Here and now:** available/enabled/disabled/unknown for this session, with the evidence and any TUI/RPC/headless or backend limitation. Do not claim to know an unseen tip-rotation algorithm or what the user will be shown next.
- **How to use it:** one minimal documented example, clearly labeled as an example, not silently executed. If it would mutate data or require consent, say so.
- **Sources:** concise citations adjacent to claims or a short final source list.

Depth follows the question. A small command explanation should stay small; a request about a workflow's evidence/ownership guarantees merits the actual state transitions and limitations. Factual specificity replaces a forced “brag” tone.

## Common boundaries

- A quoted OMP `/skill:<name>` feature: read `omp://skills.md` and the selected installed skill. Explain on-demand procedure loading rather than pretending it registers runtime tools.
- An Atlas/Prometheus, ultrawork, judge-dispatch or toolkit feature: use that installed plugin's docs/schema and defaults. A plugin feature is not a host guarantee; a disabled optional hook is not automatically active.
- Memory-related wording: read `omp://memory.md` and the active native memory schema/backend. Memory is optional/off by default; do not map Senpi's Kibitzer or memory-palace semantics onto it.
- An unavailable flag: check the installed CLI documentation/help or schema safely. Explain absence or uncertainty and a documented alternative only when equivalent; do not issue the unknown flag merely to generate an error.
- A user's explicit quote from Senpi, OmO, Claude, Codex, or another product: label it **external**, research that named product only to answer the explicit question, and state it is not thereby installed or supported in this OMP session. Kibitzer/fallback-architect are not default OMP features. External source browsing is not authorization to install/migrate that product or copy tokens.

When the user asks “which tips can I see?”, explain the features demonstrably available from installed docs/schema/settings. Be honest that this skill has no host-provided personal tip catalog or cooldown history. Ask which feature they want explained if no quote or topic is present; do not manufacture a catalog.
