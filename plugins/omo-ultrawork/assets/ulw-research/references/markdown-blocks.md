> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

> **OMP adaptation.** The private parent procedure controls native task/agent selectors, `agent://` coordination, static-first immutable acquisition (browser required for rendered/authenticated/visual claims), active-loop-only reuse, and file/summary delivery. `$ASSETS` is the supplied pinned filesystem snapshot; `$SESSION_DIR` is the actual run directory. Node/Bun helpers cannot resolve `local://`. Use task-scoped/temporary tools only; no global installs, plugin runtime dependencies, or Senpi APIs.

# Markdown block boundaries

The light Markdown model preserves the documented CommonMark paragraph interruption rule:
only an ordered marker numbered `1` interrupts an open paragraph. In
`1. a\ncontinued\n2. b`, the blocks remain a list item `a` and a paragraph
`continued\n2. b`. The model does not attach the unindented continuation to the
preceding list item. The `2` remains paragraph text with its original source
offset; fidelity numerals in either block remain available to the numeral parser.

A closing code fence permits at most three leading spaces. A candidate indented
four spaces stays code; without a later valid close the parser reports
`unterminated_fence` instead of exposing the code as report prose.
