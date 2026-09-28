---
name: frontend
description: "Use for web UI, UX, styling, layout, animation, design-system, accessibility, SEO, or frontend performance work."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Frontend

Use this skill to design, implement, audit and polish web interfaces. Before editing, choose the relevant references below, state why each is needed, and read those files. Treat design and performance as equally important: a fast generic surface fails, and a beautiful surface with a poor build fails.

## Route before UI work

| Request | Read |
|---|---|
| Any UI implementation, redesign, mockup or visual decision | `references/design/README.md` first, then `references/design/design-system-architecture.md` when `DESIGN.md` is missing or unclear |
| Layout, scroll ownership, containment or breakage at a viewport | `references/design/layout-skill.md` and `references/design/stylegallery.md` |
| PDF, print CSS, paged decks or page-break defects | `references/design/print-paged-media.md` |
| Interaction, transitions, gestures or state feedback | `references/design/interaction-skill.md` |
| Hero atmosphere, animated backgrounds, typographic reveals or scroll storytelling | `references/design/ambience-skill.md` |
| React tooling setup or render inspection | `references/design/react-dev-tooling-skill.md` |
| Frontend implementation, audit or performance/accessibility/SEO quality | `references/perfection/README.md`; also `references/perfection/react-perf-tooling.md` for React |
| Personas, critique, debt, handoff, accessibility constraints or operating-layer design process | `references/designpowers/README.md` and the relevant `lane-*.md` file |
| Clone a live URL | `references/design/clone-from-url.md` |
| Research real product screens | `references/design/lazyweb.md` |
| Aside-style browser-agent landing surface | `references/design/aside.md` |

`references/design/_INDEX.md` is the upstream catalog. This port contains only the design references physically present under `references/design/`; if a catalog entry is absent, do not invent it. Derive the design from the user's material, the existing product, present references, and direct inspection instead.

## Design-system gate

Before component work choose one route: (1) with a concrete static reference, extract exact tokens, geometry, copy, spacing, states and responsive intent into `DESIGN.md`; (2) with a live URL, use the OMP `browser` tool and `getComputedStyle` evidence as described in `clone-from-url.md`; (3) with an existing design system, follow it and update it only when the request introduces a token, primitive, state, motion rule, accessibility constraint or accepted debt; (4) with existing UI but no design system, use `ask` to choose between preserving local styling and extracting a reusable system. For greenfield work, record design research, chosen references and rationale in `DESIGN.md` before components.

Keep durable session state at `local://frontend-design/state.md` when a design operating ledger is useful. `DESIGN.md` is the implementation contract: every visual value traces to a named token or documented primitive.

## Performance and audits

Build production output first; never measure a development server. Run the bundled Lighthouse audit with the skill directory supplied by the host:

```bash
uv run <skill-directory>/scripts/perfection/lighthouse-audit.py https://localhost:3000
```

Run mobile and desktop presets, repeat enough times to take a median, and diagnose causes from the report. Do not weaken UX, hide content or remove meaningful motion for a score.

## Shared rules

- No design system means no component work. Match concrete references unless the user accepts a deviation.
- Use SVG icon sets rather than emoji icons. Encode selected state through tonal layers, marks or `focus-visible` rings rather than decorative accent borders.
- Animate compositor-friendly properties (`transform`, `opacity`, `filter`) and provide reduced-motion alternatives. Motion must communicate a state, relationship or affordance.
- Verify at representative widths, including 375, 768 and 1280 pixels, with interactions and motion driven in a real browser.

## Planning, QA and review

For a reviewed and approved implementation plan, run `/prometheus`. Use `skill://visual-qa` for rendered verification and `skill://review-work` for final implementation review. Carry design decisions, evidence paths and unresolved debt into those reviews.
