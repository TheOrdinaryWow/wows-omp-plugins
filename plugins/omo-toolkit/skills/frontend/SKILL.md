---
name: frontend
description: "Use for web UI, UX, styling, layout, animation, design-system, accessibility, SEO, frontend performance, or HTML/CSS/SVG reports, figures, slides and paginated output."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Frontend

The flow is brief -> build -> subtract -> verify. Restraint with a visible hierarchy is the default: one primary action, important information first, nothing without a job. A quiet, correct screen holding that hierarchy at 390 and 1440 in both themes is finished. Atmosphere, motion and award-grade surface work are opt-in for an expressive brief, not defaults for internal tools, dashboards, reports or figures.

## Route before the first edit

Name each applicable reference and why, then read it; rows stack. A named but unopened reference is a gap. A small existing-surface change reads only a few references, not a full greenfield research stack.

| Request | Read |
|---|---|
| Small existing-surface fix, control, restyle, copy or spacing change | Project `DESIGN.md`, or the nearest styled sibling when absent; no extraction needed under the small-change rule in `references/design/README.md`. |
| New screen/flow or greenfield | `references/design/README.md`, then `design-system-architecture.md` when creating the contract. |
| Concrete image/reference | Extract exact tokens, geometry, copy and responsive intent into `DESIGN.md`; live URL: `references/design/clone-from-url.md`. |
| Any layout/structure change, shell, panel, grid, sticky bar or scroller | `references/design/layout-skill.md` plus `references/design/stylegallery.md`; write `Layout:` before code. |
| Print CSS, PDF, paged deck or fragmentation | `references/design/print-paged-media.md`. |
| Interactions, gestures, transitions, state feedback | `references/design/interaction-skill.md`. |
| Ambience explicitly requested: hero background, reveal, scroll storytelling | `references/design/ambience-skill.md`. |
| Tone outside the anchors: agent UI, charts, landing sections, brutalist/Tailwind-only | `references/design/component-catalogs.md`: routing, exploration and licence gate. |
| Any frontend code change, performance/accessibility/SEO audit | `references/perfection/README.md`; React: also `references/perfection/react-perf-tooling.md` and `references/design/react-dev-tooling-skill.md`. |
| `DESIGN.md`, personas, critique, debt, handoff or accessibility constraints | `references/designpowers/README.md` and its relevant `lane-*.md`. |
| Research shipped product screens | `references/design/lazyweb.md`. |
| Aside-style browser-agent landing surface | `references/design/aside.md`. |

`references/design/_INDEX.md` is an upstream catalog, not an installed-file manifest. Only physically present references are bundled. Do not initialize submodules, materialize brand/UI databases, invent missing references, or claim the upstream 70-brand/83-reference collection or ui-ux-db CLI exists here. Use the user's material, existing product, available references and direct inspection instead. For chart/type questions use the project's design system and the installed `data-scientist` skill when available. Catalogs are external links, not bundled source.

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

Take the branch in `references/design/README.md` Phase 0 first (a small change on a surface with no `DESIGN.md` follows its small-change rule), and on a React project its Phase 0.5 tooling check: `DESIGN.md` (or, under the small-change rule, the styled sibling) exists before components do, and every colour, size, and spacing value traces to a token in it. Then build to these rules; `skill://visual-qa` verifies them afterwards and should find nothing new.

- **Hit targets.** Touch layouts: at least 44x44 pt (44 CSS px) per interactive element, 8-12 pt between neighbours. Pointer-only: about 10 px beyond the glyph. Grow the hit area with padding or a pseudo-element, never the glyph; adjacent bar buttons share continuous hit areas.
- **Hierarchy.** The brief's primary action is the one prominent control; the most important content sits top-leading in reading order; each screen's title says what it is; neither a destructive action nor Cancel is the Enter default.
- **States.** A control ships with hover, pressed, focus-visible, and disabled states beside its default. A data view ships empty (offering the next action), loading (a placeholder at once, a spinner only past about a second), error (cause beside the object), and offline.
- **Keyboard.** Every action reachable in reading order with a visible focus ring; Escape closes the topmost overlay; Enter triggers the non-destructive default; standard shortcuts keep their meaning; icon-only controls carry an accessible name and a tooltip.
- **Motion.** Only for a cause (an interaction, a state change, an arrival), on `transform`, `opacity`, `filter`; interruptible, never gating input; movement becomes a cross-fade under `prefers-reduced-motion`. A hover that changes nothing or motion on a non-interactive element is slop: leave it out.
- **Icons.** One SVG set (Lucide, Heroicons, Radix, Phosphor); never an emoji.
- **Concrete reference = contract.** Match its pixels, copy, component structure, and responsive intent unless the user accepts a deviation.
- **Never weaken UX to buy points.** No dropping animations, hiding content, or simplifying interactions for a Lighthouse score or a deadline.

### Draft guard: tells kept out of the first draft

Some tells regenerate by default, so they are kept out of the first draft rather than left for QA to find.

- **No coloured bar on one side of a box, rounded or square, and no accent outline on a rounded card, decorative or state.** A card, callout, warning, cover block, stat tile, testimonial, alert, or list row never carries a coloured stripe on one side: `border-left: 4px solid <accent>` or `border-l-4 border-indigo-500`, a coloured `::before`/`::after` bar inside it, an inset `box-shadow` stripe, or a hard-stop gradient band or gradient `border-image` along one edge. A rounded card never wears a 2px-or-wider accent outline either (`border: 2px solid var(--primary)`, `ring-2 ring-indigo-500`, an inset ring). Both read as generated whether they decorate the box or mark it selected, focused, or active, and an accent underline under a heading, tab, or link counts too: use a neutral 1px rule, or set the text itself in the accent ink. Give the card its identity another way: a tonal surface (one ink at a low alpha, or the next step of the surface ramp), an eyebrow or heading set in the accent ink, a leading glyph, or more space between groups. Encode state with one ink at many alphas (hover/selected/active washes), a check glyph for selection, and tonal layering for focus. The coloured edges that stay allowed: keyboard `focus-visible` rings, validation states on form inputs, neutral 1px hairlines and dividers between rows or sections, table rules, and a blockquote's neutral rule. This covers pre-existing instances on any surface you touch.
- **Lint before visual QA.** Run `bun <skill-directory>/scripts/perfection/check-draft-guard.ts <changed files or dirs>` on every stylesheet, component, and HTML file you wrote, including a report or figure you will print, screenshot, or render to an image. It reads CSS/SCSS/Less, HTML, JSX/TSX, Vue, Svelte, Astro, Tailwind classes (including `@apply` and `cva`/`cn` strings), inline styles, and styled-components, and flags the stripes above plus promotional filler copy, emoji used as icons, hype badges, and hard-coded vanity numbers in stat tiles. Exit 1 means a tell is in the draft: remove it, do not argue with the finding.
- **No decorative badge without a state behind it.** A pill, chip, or tag appears only when it carries a value that can change: a status, a count, a category the user filters by. "New", "Pro", or "AI-powered" on a static heading is decoration.
- **No stat tile without a decision behind it.** A number earns a tile when someone acts on it; four tiles above a table that already holds the numbers are filler.
- **No invented proof.** Testimonials, quotes, customer logos, ratings, user counts, and prices come from the project or stay out. A section that needs proof the project does not have is cut, or ships as an empty slot labelled for the owner to fill; a "sample" testimonial is still a fabricated one.
- **No prop decoration.** A device tilted for effect, a floating reassurance card, decorative coordinates, sparkles, and ornaments that say nothing about the product are the generated version of "premium". A product preview shows a real state of the product, with its text readable at the rendered size.
- **No repeated formula.** A treatment that carries one heading (a serif line with an italic accent phrase, a gradient word, an eyebrow-headline-subtitle stack) becomes a template when every section repeats it; so does one image reused across sections. Use each once, where it means something.
- **No subtitle under every heading.** A heading explains itself; a one-line description under each one is the generated rhythm. Keep a subtitle only where the heading alone would be misread.
- **One fact, one place.** A conclusion banner and a callout that restates it, a summary card and a table row with the same figure, a label repeated as its placeholder: keep one.
- **No promotional copy.** Interface copy states what a thing is or does. "Seamlessly", "effortlessly", "smart", "powerful", "at a glance", "supercharge", and their Korean counterparts ("한눈에", "손쉽게", "스마트한", "효율적으로", "간편하게") are marketing, not interface: rewrite as the plain fact or delete.

## 3. Subtract

After the draft renders and the lint exits 0, walk every element on the screen and ask what the user could not do or know without it. No answer: delete it, whatever the reference or the previous version showed. Then open the brief's required-content list and confirm every item is still on the screen by name, with its own control or field. Subtraction that merges two required inputs into one, drops a datum, or shortens required copy is a regression, not a cleanup. Record what you removed under "Left out on purpose".

## 4. Verify

Done is the `skill://visual-qa` gate, not your own glance. It owns the visual checks; this skill keeps build rules. Hand it the brief (B7 checks the primary action and priorities), the `Layout:` line (A12), the required-content list (Pass A), and, for a changed surface, the `before` set so it runs Before/after mode and the pair shows what improved. Its review loop is bounded (its Step 4 sets the budget): defects earn another round, and taste findings are recorded and stop it. A concrete reference runs reference-fidelity mode. Fix passes are scoped: after the first build, each fix names one change and the regions it owns (a token fix may own every region) and leaves everything else untouched, because a whole-page "make it better" pass breaks what was already right. Pass design-system decisions, evidence, and unresolved debt into `/review-work` for significant work.

## OMP execution and audit surfaces

Use native OMP `browser` for rendered inspection and captures (`skill://agent-browser`), attached to the user's signed-in session when required; do not introduce upstream browser engines. Use `ask` for consequential design decisions. Optional session design notes belong at `local://frontend-design/state.md`; project design contracts belong in `DESIGN.md`. Pass evidence by path: prompts are not byte-preserving transports. Read-only helpers never write inside the shipped skill tree.

Build production output before performance measurement. The Lighthouse helper requires local Chrome, Node and a project-resolvable `lighthouse` package; Python dependencies are isolated by `uv run`. It never installs Node packages or tools globally. If prerequisites are absent, report the exact missing prerequisite; ask before a project-local install or use an explicitly selected ephemeral audit environment.

```bash
uv run <skill-directory>/scripts/perfection/lighthouse-audit.py https://localhost:3000
```

Run mobile and desktop, repeat 3-5 times and report the median. Never weaken UX or required content for a score. A missing audit prerequisite is not an audit PASS.

Use `/prometheus` for a reviewed and approved implementation plan, `skill://visual-qa` for rendered verification, and `skill://review-work` for implementation review. Carry the brief, before/after evidence, layout contract and unresolved debt into both reviews.
