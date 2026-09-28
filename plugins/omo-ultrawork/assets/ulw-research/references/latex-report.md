> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# LaTeX report route

Use this when a reader needs a typeset, math-heavy or citation-heavy PDF, or explicitly asks for `.tex`. The deliverable is the compiled PDF plus sources; a source tree alone is not a promised PDF. Keep work under the absolute filesystem `SESSION_DIR` (Node helpers cannot use a `local://` URL). Follow the delivery contract at `<Research assets directory>/references/deliverable-phase.md` and the same static, layout, page-visual, and proofreading gates appropriate to the requested output.

## Detect a toolchain and choose an engine

```bash
for b in latexmk xelatex pdflatex lualatex tectonic bibtex biber texfot pdftoppm; do command -v "$b" >/dev/null && echo "OK $b" || echo "-- $b"; done
```

Prefer `latexmk`; otherwise run the chosen engine multiple times with bibliography in between. XeLaTeX is required for CJK/heavy Unicode with an installed CJK font; pdfLaTeX is suitable for plain Latin text; LuaLaTeX is for a requested Lua-based workflow. Tectonic can stand alone if TeX Live is unavailable. With no engine, deliver `.tex` sources, mark PDF `blocked_capability` in the outcome manifest, and tell the user plainly. Do not claim a file exists when it was never compiled.

## Write a skeleton and compile iteratively

Start with `main.tex`, separate section files for longer reports, and `% STATUS: draft — <n> sections open` at the top. The source should include a title, executive summary, findings by theme with citations, detailed analysis/figures, comparative section when options compete, methodology, correction log, and bibliography. Keep the marker until content is complete. For one to ten pages, one assembly lane is enough; for eleven to twenty, split disjoint sections between two lanes; beyond that, assign bounded batches of about seven pages to separate writers. The lead owns `main.tex` and bibliography, compiles after every section merge, and prevents shared-file writes.

A minimal cross-engine preamble includes `iftex`, Latin encodings only on pdfTeX, `fontspec` on Xe/Lua, `geometry`, `microtype`, `xcolor`, `graphicx`, `booktabs`, `tabularx`, `longtable`, `float`, `enumitem`, `titlesec`, `fancyhdr`, `pgfplots`, `tikz`, `listings`, and `hyperref`. For CJK, check available fonts before choosing one; never assume a font name. Define an accent and use it consistently across headings, figures, and links according to `design-spec.md`.

From the report root:

```bash
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
# With CJK, add -xelatex. When latexmk is unavailable:
<engine> -interaction=nonstopmode -halt-on-error main.tex
bibtex main  # or biber main when the chosen bibliography requires it
<engine> -interaction=nonstopmode -halt-on-error main.tex
<engine> -interaction=nonstopmode -halt-on-error main.tex
```

Read the log after every compile: fix the first `!` error, then undefined commands/references/citations, then overfull boxes wider than 20pt. URLs need `\url{}` or `xurl`, code needs `breaklines`, wide tables need reflow. The TOC and citations may need two or three passes; no red flags may be dismissed as harmless. Run `pdftoppm -png -r 110 main.pdf "$SESSION_DIR/page"` and inspect every page image for broken figures, clipped CJK, bad table breaks, blank pages, orphaned headers, and unlabeled charts. Correct and rerender until clean. Remove aux files only after the PDF is accepted.

## Citations and visual material

Every bibliography entry traces one-to-one to a source actually retrieved in `sources-ledger.md`; no remembered or fabricated citation. Use BibTeX/biblatex with `\cite{srcN}` when available, or a numbered `thebibliography` block for a small web-source report. Recheck attachment and counts after prose edits; never silently move or delete citations during proofreading.

Charts start from measured CSV/JSON, use vector PDF or adequate-resolution PNG, and include a caption, label, units, and textual reference. For Mermaid, render the diagram to a supported image before including it. Preserve aspect ratio with `\includegraphics[width=0.9\textwidth,keepaspectratio]{...}`. Tables use `booktabs` without vertical rules; use `tabularx` for full-width columns and `longtable` for multipage data. Code can use `listings` with wrapping rather than a shell-escape-dependent package. Large floats may use `[!htbp]`, but avoid forcing every element to `[H]` or inserting page breaks to conceal weak layout.

## Language pass and common failures

Have a `writing` agent proofread if listed in the task tool description, otherwise `task`. Vary sentence and paragraph rhythm, remove filler and redundant transitions, keep active voice, but do not alter citation attachment. Then compile again and compare citation use against the ledger.

| Log symptom | Likely cause | Remedy |
|---|---|---|
| `Undefined control sequence` | Typo or absent package | Fix first failing line or load correct package. |
| `Missing $ inserted` | Math-only character in prose | Escape `_`, `^`, etc. or enter math mode. |
| `Misplaced alignment tab character &` | Unescaped ampersand | Use `\&`. |
| `Illegal unit of measure` | Invalid dimension | Use valid TeX units/fractions. |
| Undefined environment | Missing package/typo | Load the owner package or fix name. |
| Mojibake without compile error | Wrong engine/font for CJK | Switch to XeLaTeX and an installed CJK font. |
| Overfull box | Unbreakable URL/code/table | Use URL wrapping, code breaklines, or reflow. |
| Undefined citation | Missing bibliography pass or wrong key | Run bibliography plus two passes. |
| Missing graphics file | Relative path resolved from `main.tex` | Fix path relative to report root. |

Do not replace analysis with walls of bullets, stretch images, or accept a PDF from a source-only check. Record each preview with `outcome render`, then mark the promised PDF delivered only once its pages were actually inspected.
