---
name: frontend
description: "Use for web UI, UX, styling, layout, animation, design-system, accessibility, SEO, frontend performance, or HTML/CSS/SVG reports, figures, slides and paginated output."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes. The browser-surface, type-and-spacing and generated-scaffold rules are adapted from Impeccable (Apache-2.0); see `ATTRIBUTION.md` section 6.

# Frontend

The flow is ground -> brief -> build -> subtract -> verify. Restraint with a visible hierarchy is the default: one primary action, important information first, nothing without a job. A quiet, correct screen holding that hierarchy at 390 and 1440 in both themes is finished. Atmosphere, motion and award-grade surface work are opt-in for an expressive brief, not defaults for internal tools, dashboards, reports or figures.

A chart, table or diagram delivered beside a reply (a standalone HTML file or an image; OMP has no inline HTML surface) follows `skill://visualize`. It is exempt from the `DESIGN.md` gate, grounding, the Lighthouse audit and the research lanes, and keeps the build rules, the Draft guard and the lint.

## Route before the first edit

Name each applicable reference and why, then read it; rows stack. A named but unopened reference is a gap. A small existing-surface change reads only a few references, not a full greenfield research stack.

| Request | Read |
|---|---|
| Small existing-surface fix, control, restyle, copy or spacing change | Project `DESIGN.md`, or the nearest styled sibling when absent; no extraction needed under the small-change rule in `references/design/README.md`. |
| New screen/flow or greenfield | `references/design/README.md`, then `design-system-architecture.md` when creating the contract. |
| New screen or flow, redesign ("this looks bad", "make it better"), or design-system creation or rework | ALSO `references/design/grounding.md` (step 0 below). |
| Concrete image/reference | Extract exact tokens, geometry, copy and responsive intent into `DESIGN.md`; live URL: `references/design/clone-from-url.md`. |
| Any layout/structure change, shell, panel, grid, sticky bar or scroller | `references/design/layout-skill.md` plus `references/design/stylegallery.md`; write `Layout:` before code. |
| Print CSS, PDF, paged deck or fragmentation | `references/design/print-paged-media.md`. |
| Interactions, gestures, transitions, state feedback | `references/design/interaction-skill.md`. |
| Ambience explicitly requested: hero background, reveal, scroll storytelling | `references/design/ambience-skill.md`. |
| Tone outside the anchors: agent UI, charts, landing sections, brutalist/Tailwind-only | `references/design/component-catalogs.md`: routing, exploration and licence gate. |
| Any frontend code change, performance/accessibility/SEO audit | `references/perfection/README.md`, `references/perfection/craft-floor.md` and `references/perfection/detect.md`; React: also `references/perfection/react-perf-tooling.md` and `references/design/react-dev-tooling-skill.md`. |
| `DESIGN.md`, personas, critique, debt, handoff or accessibility constraints | `references/designpowers/README.md` and its relevant `lane-*.md`. |
| Research shipped product screens | `references/design/lazyweb.md`. |
| Aside-style browser-agent landing surface | `references/design/aside.md`. |

`references/design/_INDEX.md` is an upstream catalog, not an installed-file manifest. Only physically present references are bundled. Do not initialize submodules, materialize brand/UI databases, invent missing references, or claim the upstream 70-brand/83-reference collection or ui-ux-db CLI exists here. Use the user's material, existing product, available references and direct inspection instead. For chart/type questions use the project's design system and the installed `data-scientist` skill when available. Catalogs are external links, not bundled source.

## 0. Ground: know the product and the bar before designing

For a new screen or flow, a redesign, or design-system work, run `references/design/grounding.md` first. It reads the governing parts of the guideline sources, defines the ideal state for the product's personas and journeys, and writes every gap into a ledger with the proof each fix will need. The brief and the build close the rows inside the request; a row that widens it waits for the owner. A small change reads the ledger when `DESIGN.md` has one.

## 1. Brief: decide what the screen is for before drawing it

Write this for every screen you build or change, into `DESIGN.md` section 5 beside the screen's components (the `Layout:` line goes under section 4, as `references/design/stylegallery.md` says), or into the change description when the project has no `DESIGN.md`. The build follows it; `skill://visual-qa` checks the rendered screen against it.

- **Primary action.** Exactly one. It gets the prominent style; its peers differ by style, never by size.
- **Information priorities 1-3.** In reading order. Priority 1 is the first thing the eye lands on.
- **Left out on purpose.** What a generated version of this screen would add and this one will not: the decorative badge, the stat tile nobody acts on, the subtitle under every heading, the callout that repeats the banner.
- **Required content.** Every input, datum, label, and piece of copy the request, the reference, or the existing screen requires, listed by name. Subtraction is checked against this list; nothing on it may disappear or merge.
- **Data shape -> component** (data screens): several things to compare -> table; a ranking -> ordered list; one verdict -> conclusion banner first, evidence under it; many items -> filter + results grid; one object -> detail view with its primary action. Choose from this before reaching for cards.
- **Layout line** (any layout or structure change, an existing `DESIGN.md` included): one `Layout:` line in the format and with the unreachable-host form given in `references/design/stylegallery.md`, written before the code.
- **Before captures** (changing an existing UI): fix the cases now, states x widths, and capture `before` through `skill://visual-qa` Before/after mode BEFORE the first edit. A baseline reconstructed later is not a baseline.

## 2. Build

Take the branch in `references/design/README.md` Phase 0 first (a small change on a surface with no `DESIGN.md` follows its small-change rule), and on a React project its Phase 0.5 tooling check: `DESIGN.md` (or, under the small-change rule, the styled sibling) exists before components do, and every colour, size, and spacing value traces to a token in it. A new system is built in this order: colour roles in both themes, then type and spacing, then components, which start from the project's own kit or, without one, a known component anatomy (shadcn/ui's, for example) restyled with the tokens, never an invented shape; adding a component library as a dependency is the owner's choice. Then build to these rules; `skill://visual-qa` verifies them afterwards and should find nothing new.

- **Hit targets.** Touch layouts: at least 44x44 pt (44 CSS px) per interactive element, 8-12 pt between neighbours. Pointer-only: at least 24x24 CSS px (WCAG 2.5.8), about 10 px beyond the glyph. Grow the hit area with padding or a pseudo-element, never the glyph; adjacent bar buttons share continuous hit areas.
- **Hierarchy.** The brief's primary action is the one prominent control; the most important content sits top-leading in reading order; each screen's title says what it is; neither a destructive action nor Cancel is the Enter default.
- **States.** A control ships with hover, pressed, focus-visible, and disabled states beside its default. It keeps one box in every state: the label, icon, and spinner swap inside slots that exist in all states (a min-width sized to the longest label, a spinner overlaying the hidden label), so width, height, and padding never change when the state does, and an arrow or spinner never adds padding when it appears. A data view ships empty (offering the next action), loading (a placeholder at once, a spinner only past about a second), error (cause beside the object), and offline.
- **Keyboard.** Every action reachable in reading order with a visible focus ring that no sticky bar or overlay covers; Escape closes the topmost overlay; Enter triggers the non-destructive default; standard shortcuts keep their meaning; icon-only controls carry an accessible name and a tooltip.
- **Motion.** Only for a cause (an interaction, a state change, an arrival), on `transform`, `opacity`, `filter`; interruptible, never gating input; movement becomes a cross-fade under `prefers-reduced-motion`. A hover that changes nothing or motion on a non-interactive element is slop: leave it out.
- **Icons.** One SVG set (Lucide, Heroicons, Radix, Phosphor); never an emoji.
- **Browser surfaces.** Text selection, the caret, visible scrollbars, the focus ring, link underline offset, and tabular numerals are themed from the palette in both themes; none ships as the browser default. `references/perfection/craft-floor.md` has the property for each.
- **Type and spacing defaults.** Each heading step (display to h3, and the smallest heading to body) differs by at least 1.25x, and body-family roles that sit closer also differ by weight, colour or case; the space above a section heading is at least 1.5x the space below it; the gap between groups is at least 2x the gap inside one; Latin body text runs 65-75 characters per line on desktop; display type stays at or under 6rem and tracking at or above -0.04em. These are contextual defaults: the brief, a concrete reference, `DESIGN.md`, a chosen route or the content (script, data density, platform) may set its own value, recorded as `craft-floor.md` says. Check computed values, not the source.
- **Concrete reference = contract.** Match its pixels, copy, component structure, and responsive intent unless the user accepts a deviation.
- **Never weaken UX to buy points.** No dropping animations, hiding content, or simplifying interactions for a Lighthouse score or a deadline.

### Draft guard: tells kept out of the first draft

Some tells regenerate by default, so they are kept out of the first draft rather than left for QA to find.

- **No coloured bar on one side of a box, rounded or square, and no accent outline on a rounded card, decorative or state.** A card, callout, warning, cover block, stat tile, testimonial, alert, or list row never carries a coloured stripe on one side: `border-left: 4px solid <accent>` or `border-l-4 border-indigo-500`, a coloured `::before`/`::after` bar inside it, an inset `box-shadow` stripe, or a hard-stop gradient band or gradient `border-image` along one edge. A rounded card never wears a 2px-or-wider accent outline either (`border: 2px solid var(--primary)`, `ring-2 ring-indigo-500`, an inset ring). Both read as generated whether they decorate the box or mark it selected, focused, or active, and an accent underline under a heading, tab, or link counts too: use a neutral 1px rule, or set the text itself in the accent ink. Give the card its identity another way: a tonal surface (one ink at a low alpha, or the next step of the surface ramp), a heading set in the accent ink, a leading glyph, or more space between groups. Encode state with one ink at many alphas (hover/selected/active washes), a check glyph for selection, and tonal layering for focus. The coloured edges that stay allowed: keyboard `focus-visible` rings, validation states on form inputs, neutral 1px hairlines and dividers between rows or sections, table rules, and a blockquote's neutral rule. This covers pre-existing instances on any surface you touch.
- **Lint before visual QA.** Run `bun <skill-directory>/scripts/perfection/check-draft-guard.ts <changed files or dirs>` on every stylesheet, component, and HTML file you wrote, including a report or figure you will print, screenshot, or render to an image. It reads CSS/SCSS/Less, HTML, JSX/TSX, Vue, Svelte, Astro, Tailwind classes (including `@apply` and `cva`/`cn` strings), inline styles, and styled-components, and flags the stripes above plus promotional filler copy, emoji used as icons, hype badges, and hard-coded vanity numbers in stat tiles. Exit 1 means a tell is in the draft: remove it, do not argue with the finding.
- **Detect after the build renders.** Once the page renders, run the detect SDK on it from a JavaScript eval cell through the native browser, at 1440 and 390 with reflow on (`references/perfection/detect.md`): `detectPage({ kind: "url", url }, { renderer: createNativeBrowserRenderer(browser), reflow: true })`; a saved snapshot is linted with `bun <skill-directory>/scripts/detect/cli.ts <snapshot.json>`. It reads the rendered page (contrast on the painted background, type scale, heading order, overflow, decoration and copy tells). Fix every blocking finding (an objective defect) before `skill://visual-qa`; fix or record a decision for every other warning and advisory. Its report names what it could not inspect, and zero findings never stands for visual or accessibility verification.
- **No decorative badge without a state behind it.** A pill, chip, or tag appears only when it carries a value that can change: a status, a count, a category the user filters by. "New", "Pro", or "AI-powered" on a static heading is decoration.
- **No stat tile without a decision behind it.** A number earns a tile when someone acts on it; four tiles above a table that already holds the numbers are filler.
- **No invented proof.** Testimonials, quotes, customer logos, ratings, user counts, and prices come from the project or stay out. A section that needs proof the project does not have is cut, or ships as an empty slot labelled for the owner to fill; a "sample" testimonial is still a fabricated one.
- **No prop decoration.** A device tilted for effect, a floating reassurance card, decorative coordinates, sparkles, and ornaments that say nothing about the product are the generated version of "premium". A product preview shows a real state of the product, with its text readable at the rendered size.
- **No repeated formula.** A treatment that carries one heading (a serif line with an italic accent phrase, a gradient word, a headline-subtitle pair) becomes a template when every section repeats it; so does one image reused across sections. Use each once, where it means something.
- **No subtitle under every heading.** A heading explains itself; a one-line description under each one is the generated rhythm. Keep a subtitle only where the heading alone would be misread.
- **One fact, one place.** A conclusion banner and a callout that restates it, a summary card and a table row with the same figure, a label repeated as its placeholder: keep one.
- **No dated or borrowed surface.** Glass and blur panels (they read as a clone of a popular open-source chat app), neumorphism, mesh-gradient heroes, heavy drop shadows, and 2019-era SaaS illustration date a draft on sight. Surfaces come from `DESIGN.md` section 7; a material ships only when the brief or a concrete reference supplies it.
- **No generated scaffold.** No kicker label above a heading, no icon tile stacked over a heading in a grid of same-size cards, no hero metric (a giant number with a small label and supporting stats), no card inside a card, no neutral gray text on a coloured surface, no monospace as a "technical" costume, and no zero-offset coloured glow standing in for a shadow. `references/perfection/craft-floor.md` gives the replacement for each, and says when the brief or its chosen route brings one back.
- **No promotional copy.** Interface copy states what a thing is or does. "Seamlessly", "effortlessly", "smart", "powerful", "at a glance", "supercharge", and their Korean counterparts ("한눈에", "손쉽게", "스마트한", "효율적으로", "간편하게") are marketing, not interface: rewrite as the plain fact or delete.

## 3. Subtract

After the draft renders and the lint exits 0, walk every element on the screen and ask what the user could not do or know without it. No answer: delete it, whatever the reference or the previous version showed. Then open the brief's required-content list and confirm every item is still on the screen by name, with its own control or field. Subtraction that merges two required inputs into one, drops a datum, or shortens required copy is a regression, not a cleanup. Record what you removed under "Left out on purpose". Then count the controls: a secondary action most visits do not need moves into a menu or to the object it acts on, and groups separate by whitespace, not by boxes and borders. Fewer controls with room around them is the target, never at the cost of a required item.

## 4. Verify

Done is the `skill://visual-qa` gate, not your own glance. It owns the visual checks; this skill keeps build rules. Hand it the brief (B7 checks the primary action and priorities), the `Layout:` line (A12), the required-content list (Pass A), the detect report, and, for a changed surface, the `before` set so it runs Before/after mode and the pair shows what improved. Its review loop is bounded (its Step 4 sets the budget): defects earn another round, and taste findings are recorded and stop it. A concrete reference runs reference-fidelity mode. Fix passes are scoped: after the first build, each fix names one change and the regions it owns (a token fix may own every region) and leaves everything else untouched, because a whole-page "make it better" pass breaks what was already right. Pass design-system decisions, evidence, and unresolved debt into `skill://review-work` for significant work.

Every UI or design-system deliverable states its WCAG 2.2 AA result for the criteria below. Probe the built surface in the native browser and put a table in the deliverable (PR body, change description, or reply): one row per item, PASS / FAIL / N/A, with its evidence (a named capture, probe output, or the detect report). The table covers these checked criteria only and is not a WCAG conformance claim. A FAIL is fixed, or recorded as accepted debt in `DESIGN.md` section 8 with the user's sign-off; the row then still reads FAIL and names the debt entry, because accepted debt never turns a FAIL into a PASS. N/A only when the surface has no instance, with the reason.

- **Contrast** (1.4.3, 1.4.11): text 4.5:1 (large 3:1), icons and control edges 3:1, both themes, placeholder text included.
- **Focus** (2.4.7, 2.4.11): Tab through every control and screenshot each ring; none missing, none entirely hidden by a sticky bar or overlay (the AA line; the target is none covered at all).
- **Target size** (2.5.8): every pointer target at least 24x24 CSS px, or an undersized one whose 24 px circle, centred on it, intersects no other target and no other undersized target's circle. Exempt: inline links in a sentence, targets the browser draws unstyled, a target with a same-function equivalent that passes, and a size the information requires.
- **Keyboard** (2.1.1, 2.1.2): every action works from the keyboard, and focus never gets trapped.
- **Reflow and text spacing** (1.4.10, 1.4.12): at 320 CSS px no content scrolls sideways, except content that needs two dimensions (a data table, a map, a diagram); with line-height 1.5, paragraph spacing 2em, letter spacing 0.12em, and word spacing 0.16em applied, nothing clips or overlaps.
- **Dragging, authentication, help, entry** (2.5.7, 3.3.8, 3.2.6, 3.3.7): a single-pointer alternative for every drag; no cognitive test to sign in unless an alternative exists, paste and password managers work, or the test is object or personal-content recognition; help in the same place on every page; nothing asked twice in one flow. N/A only when the surface has none of these.
- **State-stable controls** (build rule above): read each control's `getBoundingClientRect()` in every state (idle, hover, focus, loading, success, disabled); width and height match across states.
- **System and surfaces** (build rules above): colour roles exist in `DESIGN.md` before any component; each component names its project-kit or anatomy source; a grep of the shipped styles finds no `backdrop-filter`, neumorphic double shadows, or mesh-gradient backgrounds unless the brief or a concrete reference supplies them.

On the grounded path, close the gap ledger row by row: each fixed gap has its before/after pair and the planned proof, passing; rows waiting on the owner are listed as open.

## OMP execution and audit surfaces

Use native OMP `browser` for rendered inspection, captures and the detect SDK (`skill://agent-browser`, `xd://eval/browser`), attached to the user's signed-in session when required; do not introduce upstream browser engines. Use `ask` for consequential design decisions. Optional session design notes belong at `local://frontend-design/state.md`; project design contracts belong in `DESIGN.md`. Pass evidence by path: prompts are not byte-preserving transports. Read-only helpers never write inside the shipped skill tree.

Build production output before performance measurement. The Lighthouse helper requires local Chrome, Node and a project-resolvable `lighthouse` package; Python dependencies are isolated by `uv run`. It never installs Node packages or tools globally. If prerequisites are absent, report the exact missing prerequisite; ask before a project-local install or use an explicitly selected ephemeral audit environment.

```bash
uv run <skill-directory>/scripts/perfection/lighthouse-audit.py https://localhost:3000
```

Run mobile and desktop, repeat 3-5 times and report the median. Never weaken UX or required content for a score. A missing audit prerequisite is not an audit PASS.

Use `/prometheus` for a reviewed and approved implementation plan, `skill://visual-qa` for rendered verification, and `skill://review-work` for implementation review. Carry the brief, before/after evidence, layout contract, detect report and unresolved debt into both reviews.
