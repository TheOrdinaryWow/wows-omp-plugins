> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

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

## Figures — every chart

- **Trace every value.** Keep the source, query, filters, aggregation, grain, units and missing-row policy. The numbers drawn must be the computed result, not hand-retyped approximations; mark illustrative data explicitly.
- **Declare bucket semantics.** For reader-facing daily, weekly or monthly comparisons, cut buckets at the reader's calendar boundaries and name the timezone (and week start where relevant). Preserve an explicitly requested UTC/business calendar; if the reader's zone is unknown, disclose the chosen zone instead of guessing. Mark a still-filling day/week/month on the affected bar/point itself, not only in a subtitle, so it does not masquerade as a decline.
- **Cross-check a headline figure.** When an independent second source is available (another independently maintained table, dashboard or raw count), compare a headline value and name the source, matching scope and any discrepancy beside the figure. A second aggregation of the same source is a consistency check, not independent corroboration. If no independent source is available, say so explicitly and state what internal check was possible; never invent a source or claim a match you did not observe.
- **Check geometry and series.** Verify representative rendered marks against their source values and the actual axis transform, baseline, domain and plot dimensions. For a zero-based, unstacked linear bar, height is `value / axisMaximum * plotHeight`; that formula is not universal. Use transformed endpoints for log/truncated/negative axes and segment boundaries/totals for stacked bars. Inspect clipped/out-of-domain values and check each legend label, swatch and series against what is actually plotted (computed colors for HTML). A polished screenshot alone is not numerical proof.

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
