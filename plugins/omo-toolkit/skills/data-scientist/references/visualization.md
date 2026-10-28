> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Visualization

A chart exists to answer a named query/aggregation at a glance. Use matplotlib (provision it explicitly through managed eval or isolated `uv run --with matplotlib` if missing) or the project's existing plot engine, then inspect the output before delivery. Package residency is not assumed.

## When to chart

Chart when the user asked for one, and default to charting when the answer is a shape prose
cannot carry: a trend over time, a distribution, a comparison across many categories, a
relationship between variables. Skip the chart when a number or a five-row table answers the
question — decoration dilutes the answer.

## Chart type follows the question

| Question shape | Chart |
| --- | --- |
| How did X change over time? | line, datetime x-axis |
| Which categories are biggest? | horizontal bar, sorted by value |
| How is X distributed? | histogram (tune bin count) or box plot per group |
| Is X related to Y? | scatter; add a trend line only when it aids the eye |
| Composition of a whole? | stacked or 100% bar — pie only for four or fewer slices |
| Many series over time? | small multiples over one spaghetti chart |

## Quality bar — every chart

- Title states the finding ("Seoul overtook Busan in March"), not the dataset name.
- Axis labels carry units. Tick density stays readable: `fig.autofmt_xdate()` for dates,
  rotate or abbreviate long category names.
- Size for the medium: inline chat reads well around `figsize=(10, 6)` at default dpi;
  documents want `dpi=150` or more at export.
- `tight_layout()` (or `constrained_layout=True`) before saving — clipped labels are the
  most common chart defect.
- Few series: label lines directly, or keep the legend inside empty plot space. Many
  series: gray the context, color only the series that answers the question.
- The default color cycle is fine; avoid rainbow palettes and 3D. Sort categorical bars by
  value, never alphabetically.

## CJK and other non-Latin text

Choose a font actually installed with glyph coverage for the labels' script: for example Noto Sans CJK SC for Simplified Chinese, JP for Japanese, or KR for Korean. Inspect available fonts through matplotlib's font manager; do not assume a platform supplies a particular family. Set `matplotlib.rcParams["font.family"]` to the chosen actual family plus a fallback and check minus signs, punctuation and the saved image. Ask before installing fonts globally. A Korean-only font assumption is not a general CJK recipe.

## Output contract

1. Save a PNG next to the work: `plt.savefig(path, dpi=150, bbox_inches="tight")`.
2. Print the figure/image in native eval to attach it; if that surface is unavailable, use native image read on the real saved path. Use `skill://visual-qa` for a visual acceptance requirement.
3. Report the file path together with the answer.

## Visual QA — mandatory

Open the produced image — kernel display, or the harness's image-reading surface — and
check four things: labels readable and unclipped, no tofu or mojibake, nothing overlapping,
and the chart actually shows the finding the title claims. A failed check means fix and
re-render, not ship with a caveat. This one pass catches nearly every chart defect;
skipping it is how tofu titles reach users.
