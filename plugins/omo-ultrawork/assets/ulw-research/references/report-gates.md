> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Report gate defects

Read defects from the JSON produced by `node <Research assets directory>/scripts/report-tools.mjs check ...`. The codes below identify machine checks, their severity, and the repair. The static tool checks structure; the layout probe requires a rendered-page object from the OMP `browser` tool. Visual composition and language remain human/agent inspection gates, not claims the static checker can prove.

| Static code | Impact | Repair |
|---|---|---|
| `korean_no_keep_all` | Hangul wraps character by character | Set `word-break: keep-all; overflow-wrap: anywhere`. |
| `palette_off_token` | Color is outside the design tokens | Use or add a palette token in `design-spec.md`. |
| `emoji_in_prose` | Emoji disrupt typographic hierarchy | Remove prose emoji; use semantic text or a restrained icon. |
| `em_dash_in_prose`, `en_dash_in_prose` | Sentence punctuation violates the report register | Rewrite the sentence; reserve en dash for number ranges. |
| `heading_too_long`, `heading_generic` | Heading is long or fails to state a claim | Shorten and state the finding. |
| `unsourced_number` | Quantity lacks provenance | Add same-element citation or `MEASURED`/`ASSUMED`/`DERIVED` lineage. |
| `chart_without_figure` | Uncaptioned visual lacks context | Place in a figure with a caption. |
| `chart_svg_no_text`, `chart_svg_missing_labels` | Axes, units, title, or values cannot be read | Add real SVG text and units. |
| `korean_serif_font` | Korean body copy uses an unsuitable serif | Choose a real sans/gothic font. |
| `section_without_citation` | A finding section has no source | Add an in-text citation or merge into a cited section. |
| `missing_closing_section` | Methodology/gates/provenance closure missing | Add the required closing section. Integrity blocker. |
| `missing_citation_section` | Sources cannot be audited | Include a numbered sources section. Integrity blocker. |
| `broken_asset_reference` | Referenced figure or asset is absent | Create the actual asset and rerender. Integrity blocker. |
| `missing_required_section` | Brief-required section is absent | Add the section specified by `--require-section`. Integrity blocker. |
| `missing_promised_deliverable` | A promised output is unresolved | Deliver or explicitly mark unavailable with reason. Integrity blocker. |

| Layout code | Impact | Repair |
|---|---|---|
| `layout_overflow` | Child exceeds its container | Constrain widths or allow wrapping. |
| `layout_text_clipped` | Text hidden by overflow/fixed height | Remove clipping or allow the box to grow. |
| `layout_scroll_container` | Scroll-only table loses content in print | Reflow or provide a printable layout. |
| `layout_image_distorted` | Stretched asset changes meaning | Keep original aspect ratio with contain-fit. |
| `layout_sibling_overlap` | Neighboring blocks collide | Restore spacing or split the page/slide. |

Gate states are `pass`, `fail`, or `not_run`. `not_run` is truthful only for a gate inapplicable to the selected tier; an omitted required visual review is not a pass. The layout gate needs a real rendered-page probe; absent a probe, layout remains `not_run`. Residual defect objects carry `code` and `message` in the outcome manifest and must appear in the closing briefing. Cite sources inline as `[Sn]`/`[Rn]` or in a numbered section with an explicit lineage mode; the choice is governed by the design spec, not by accidental checker defaults.
