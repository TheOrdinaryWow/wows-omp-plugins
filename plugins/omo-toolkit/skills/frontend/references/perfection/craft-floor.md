> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes. It is adapted from the `craft-floor` reference of [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0, Copyright 2025 Paul Bakaus), rewritten for this skill; see `../../ATTRIBUTION.md` section 6 for the license and the list of changes.

# Craft defaults: the computed checks a build is held to

Read this with `README.md` for any code change. It sets no direction. Each line is checked on the rendered page by reading computed values, not by looking at the source, and `skill://visual-qa` checks them again (A3, A13, B8, E7, F8, F9).

Every line is a contextual default, not a hard floor. It holds until something more specific sets its own value: the brief's words, a concrete reference, the project's `DESIGN.md`, a route the brief chose (a Layer A style or Layer B brand reference, or the ambience route), or the content itself (the script and language, a dense data table, a platform convention). Brutalist display scale and tracking, a brand's labels above headings, and the ambience route's blur reveals and glowing-border cards are examples. The override wins for that one item only. Record the deviation and its reason in the brief or `DESIGN.md` so `skill://visual-qa` reads it as chosen, not generated. An unrecorded miss is a finding, classified by its effect: broken hierarchy, legibility or function is a defect; a within-scale numeric difference is taste.

## Browser surfaces

The parts of a page the browser draws by default ship with no design unless you give them one. Theme every one that the surface has, from the palette tokens, in both themes:

| Surface | What to set |
|---|---|
| Text selection | `::selection { background: <accent at low alpha>; color: <ink> }`; the default system blue never shows. |
| Caret | `caret-color: <accent or ink>` on inputs, textareas and contenteditable. |
| Scrollbars | `scrollbar-color: <thumb> <track>` and `scrollbar-width: thin` on scroll containers that keep a visible bar. Overlay scrollbars stay overlay (`skill://visual-qa` A5); this styles the bar, it never adds a gutter. |
| Focus ring | `:focus-visible { outline: 2px solid <focus token>; outline-offset: 2px }`, visible on every surface colour. |
| Underlines | `text-underline-offset: 0.15em` to `0.25em` and `text-decoration-thickness` from the type scale on links, so the line clears descenders. |
| Numerals | `font-variant-numeric: tabular-nums` on every column, counter, timer, price and table cell that changes or aligns. |

Exempt: a surface with no instance of the element (no inputs means no caret), and a native control the brief keeps unstyled on purpose.

## Type and spacing

| Default | Value | Read from |
|---|---|---|
| Type scale steps | Each step of the heading ladder (display, h1, h2, h3) and the step from the smallest heading to body differ by at least 1.25x in size. The body-family roles (lead, body, small, caption, overline or label) may sit closer, but each also differs from its neighbour by weight, colour or case, never by size alone. | computed `font-size` of each role in use |
| Space around a heading | The space above a section heading is at least 1.5x the space below it, so the heading belongs to the content it introduces. | computed margin/padding plus the parent gap |
| Group separation | The gap between groups is at least 2x the gap inside a group. | computed `gap` / margins of siblings |
| Body measure | Latin-script body text runs 65-75 characters per line on desktop, 45 at the least on a phone; CJK and other scripts are measured in their own units. | rendered line length at 1440 and 390 |
| Display size | A display heading stays at or under 6rem. | computed `font-size` |
| Tracking | Letter spacing stays at or above -0.04em; -0.02em to -0.03em usually reads better on large type. Body text keeps 0. | computed `letter-spacing` / `font-size` |

Run the real copy at every captured width and fix what overflows or wraps a heading to four lines.

## Patterns kept out of the first draft

These extend the Draft guard in `SKILL.md`. Each one is what a generator reaches for when nothing decided otherwise, so the first draft leaves it out. The brief or its chosen route can still ask for one (see the override rule above); the hard offset shadow below is narrower than that.

- **Kicker above a heading.** A small uppercase or accent label sitting on top of a heading ("FEATURES", "01 - OVERVIEW"). Delete it; the heading carries its own weight.
- **Icon in a tile over a heading.** A rounded square holding an icon, stacked above a heading and a line of text, repeated across a grid of same-size cards. Use the content's own structure (a list, a table, a real image) instead of the card formula.
- **Hero metric.** One giant number with a small label, flanked by supporting stats and an accent. A number earns that size only when it is the decision the screen exists for.
- **Cards inside cards.** A bordered or shadowed box inside another. Separate inner groups with space or a neutral 1px rule.
- **Gray text on a coloured surface.** Secondary text on a tinted or coloured background takes a shade of that hue (or the foreground at reduced alpha), never neutral gray, which looks dirty and fails contrast first.
- **Monospace as a costume.** A monospace face only for code, data, ids and measurements, never to make a heading or a UI read as "technical".
- **Glow and halo shadows.** A shadow carries a y-offset and a soft blur. A zero-offset coloured glow around a card or button is decoration, unless the brief asked for glowing-border cards through the ambience route. Hard offset shadows with no blur (`4px 4px 0`) only when the brief chose a neobrutalist direction.

## What this skill does not take from the source

The upstream reference disagrees with rules this skill already holds; ours win:

- Blur, `backdrop-filter` and `filter: blur()` are not general motion materials. They animate only in an ambience reveal the brief asked for (`../design/ambience-skill.md`), and never under `prefers-reduced-motion` (`skill://visual-qa` G4).
- No number here is a universal floor: a project, reference, route or the content may set its own value, recorded as above. Contrast and the other WCAG checks in `SKILL.md` Verify are not craft defaults and are never overridden this way.
- A label above a heading is a default to leave out, not an absolute ban: a style route that allows a limited number of them is followed.
- Both light and dark themes ship (`skill://visual-qa` E1); the theme is not picked per product category.
- An intentional spring is allowed where `DESIGN.md` names it; bounce easing is a finding only when no token asked for it.
- A typeface the project chose (for example Inter in a product that matches its platform) is never a finding because it is common.
- Scrollbars follow the overlay rule above; this skill never asks for a decorative custom scrollbar.
