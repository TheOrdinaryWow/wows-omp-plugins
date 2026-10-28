> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Frontend Design Router

The flow and build rules live in `../../SKILL.md`: brief, build, subtract, verify. This file chooses references and gates the work on an appropriate design contract. The verification authority is `skill://visual-qa`.

## The bar and available sources

Restraint with visible hierarchy is the default. One prominent primary action, priority-1 content first, every element with a job. A quiet, correct screen holding at 390 and 1440 in both themes is finished. Atmosphere, rich material and signature motion are deliverables only for an expressive brief, such as a named brand, premium marketing page or explicit visual ambition.

Only the files physically present here are bundled. `_INDEX.md` is the upstream catalog, not an availability promise. Do not fetch/materialize missing brand/UI databases, initialize submodules, fabricate placeholder references, or assume `open-design`, image-generation tools or a ui-ux-db CLI is installed. Use project contracts, user references, present files and direct inspection; report a missing source. External catalogs remain link-only subject to `component-catalogs.md`.

## Phase 0: Design System Gate

Look for `DESIGN.md`, `design-system.md`, or `design-tokens.md` at root, then `docs/`, then `src/`.

**It exists:** read all of it and follow its tokens, primitives and states. Add a needed token to the contract before using it. Any layout or structure change still needs a `Layout:` line before code; an existing design system does not decide this region's scroller for you.

**Small existing-surface change, no design system:** a fix, control, restyled component, copy or spacing change follows the nearest styled sibling. The sibling stands in for `DESIGN.md`: no full extraction, no design-system question. Put the brief and any `Layout:` line in the change description. Do not use this exception for a new screen/flow, or when no styled sibling exists.

**Otherwise no design system:** read `design-system-architecture.md`, then take the branch:

1. **Greenfield, no concrete reference:** research available sources and open `DESIGN.md` with a `## 0. Research Log`. Record the available-reference shortlist and pick, viewed real-product screens via `lazyweb.md`, a spatial pattern via `stylegallery.md`, and concept drafts only when requested and a suitable tool exists. Name unavailable sources explicitly rather than fabricating evidence. Independent research lanes may run in one native `task` batch. Keep product names/URLs and observed facts separate from recommendations; a recurring pattern is a convention, not proof. Extract tokens, layout grammar, anatomy, states and motion into project-specific primitives. Give each content block a job and order by the user's decision path, not symmetry.
2. **Concrete reference:** a static image is the contract; a live URL follows `clone-from-url.md`. Extract exact tokens, geometry, copy, states and responsive intent into `DESIGN.md`. Build real reusable primitives, not screenshot-shaped one-offs. Finish in reference-fidelity visual QA.
3. **New screen/flow in existing UI with implicit patterns:** codify existing colours, type, spacing, primitives, states and motion into `DESIGN.md` before components.
4. **New screen/flow with no reusable component layer:** ask one focused question: preserve local styling through copy-nearby edits, or extract `DESIGN.md` plus reusable components? Do not silently choose either a larger refactor or a cheaper design. In the local-styling route the brief and `Layout:` live in the change description.

**Primitive showcase:** when introducing a design system, name reusable primitives and states in section 5 and verify them in a showcase or equivalent state harness before product screens. This does not turn the small-change sibling exception into a showcase project.

### Expressive briefs only

Commit a direction before extracting tokens: atmosphere, signature material, colour story and the memorable moment. Consider genuinely different directions instead of averaging them. Preserve the reference's elevation recipe, perceptual colour ramp, declared display/body/mono choices and signature interaction. A single blur on generic dark SaaS is not the rich reference. Before QA check the rendered material against the contract; never add atmosphere to an operational brief merely to make it less flat.

## Phase 0.5: React tooling

For React projects inspect existing dev-only `react-grab`, `react-scan` and `react-doctor` wiring, then read `react-dev-tooling-skill.md` for framework recipes and the production-leak check. Follow the project's dependency policy; never install globally or mutate the copied skill directory. Project-local setup commands, when permitted:

```bash
npx grab@latest init
npx react-doctor@latest install
npx react-scan@latest init
```

Runtime tools must be behind `NODE_ENV === 'development'` or `import.meta.env.DEV`. Skip additions when the owner said no extra dev dependencies; a library without an entry point uses the applicable static scan, not runtime injection. Do not claim an unrun scan passed.

## Route only to available references

- Layout/structure: `layout-skill.md` for mechanics plus `stylegallery.md` for the named pattern and scroll-owner contract.
- Controls and state motion: `interaction-skill.md` (beui.dev); ambience only when requested: `ambience-skill.md` (react-bits).
- Tone outside those anchors, AI-agent UI, charts, landing sections, brutalist or Tailwind-only: `component-catalogs.md`, at most two catalogs, existing engine first, licence/access gate before reuse.
- Live reference: `clone-from-url.md`; print/paged output: `print-paged-media.md`; Aside direction: `aside.md`.
- Shipped-product research: `lazyweb.md`; use only the user's connected Mobbin MCP if available, never scrape Mobbin.
- Design contract, personas, critique, debt or handoff: `../designpowers/README.md` and the applicable lane.
- Code changes/audits: `../perfection/README.md`; React also loads its React performance reference.

For a marketing/landing redesign, research at least three shipped examples in the same category before editing. Record what is weak today, the observed conventions, the proposed direction and its reasons in the change description. User-selected sites, permitted catalog surfaces and Lazyweb are source material, not permission to copy brand assets or component source.

At most one visual direction at a time; layout, interaction and ambience are orthogonal mechanics. Match existing project infrastructure: CSS Modules remain CSS Modules, styled-components remain styled-components. Do not introduce a second motion engine for one effect.

## Execution and final QA

Read the contract or styled sibling and write the brief before code. Verify installed dependencies and Tailwind version instead of assuming either. Full-height heroes use `min-height: 100dvh`; Next.js state/motion lives in client leaves. Tokens follow the contract; repeated new primitives go back into section 5. No `as any` or `@ts-ignore` to force borrowed components to fit.

Run the draft guard on changed CSS/components/HTML before visual QA. Subtract jobless decoration without dropping or merging any required content. `skill://visual-qa` receives the brief, `Layout:` line, required-content list and fixed pre-edit captures. It checks B7, A12, required content and paired before/after within its bounded review budget. Taste is recorded, not an endless redesign loop. Concrete references use reference-fidelity mode. For expressive briefs only, also judge whether the requested distinctive material survived; operational work is complete when the brief and bounded QA gate hold.
