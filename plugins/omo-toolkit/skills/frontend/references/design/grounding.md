> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `adddd17004076e799c2de18ccfdee29e12525ace`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Grounding: guideline source, ideal state, gap ledger

Run this before the brief for a new screen or flow, a redesign ("this looks bad", "make it better", "rework the design system"), and any design-system creation or rework. It replaces taste guesses with a written bar: what a good interface does for its users, and every place the work falls short of it. A small change skips the run and reads the ledger in `DESIGN.md` section 9 when one exists.

The output is `DESIGN.md` section 9 (`design-system-architecture.md` gives the template), or the change description when the project has no `DESIGN.md`. Grounding sizes itself to the surface under work; it never widens the request on its own.

## 1. Guideline sources, the governing parts read in full

Pick the authoritative sources for the platform and the domain: the platform's guidelines (Apple Human Interface Guidelines, Material 3, Fluent 2), WCAG 2.2, and the project's own `DESIGN.md`. Read in full the parts that govern this surface: the sections for the components, patterns, states and journeys it contains. A skimmed or sampled passage counts as unread; a section about controls the surface does not have is not owed. Record each source with its URL or path and the sections read. When the governing parts are too large for one context, independent readers may run in one native `task` batch, each returning the principles from its sections with their URLs.

## 2. Universal principles

Drop the platform idioms: named materials, system icon sets, platform control chrome, and vendor elevation and motion names. Keep what holds for any interface: hierarchy, feedback, consistency, error prevention and recovery, input effort, density, legibility, and accessibility. Tie each principle to a persona and a journey step. Name who uses the product and what they are trying to get done. Then name the step where the principle decides the experience: first visit, daily use, recovery from an error, or a return after time away.

## 3. Ideal state

For each journey step, write what the product does at its best: what the user sees first, the one action, the feedback after it, and the way back from a mistake. Write it so a reviewer can check it on a screenshot: "the run's status and its one next action are the first thing on the screen" is checkable; "clean and intuitive" is not.

## 4. Gap ledger

Capture the surface under work through `skill://visual-qa` (every state at 390 and 1440, both themes; on a new screen, the first draft built after the brief, and the ledger grows as the draft is checked) and list every difference from the ideal state. Do not rank the small ones away. Then add every violation of the rule sources this request routed to: `SKILL.md`'s build rules and draft guard (plus `check-draft-guard.ts` output), the rendered detector report (`references/perfection/detect.md`), the `skill://visual-qa` checklist, and the WCAG 2.2 AA items in `SKILL.md` Verify. Capture a screenshot for each row and keep the ledger in a durable record (section 9, the change description, or the `/ulw-loop` ledger when it runs) so no finding lives only in context. One row per gap, with its proof planned before any edit:

| ID | Screen / state | Gap | Principle or rule broken | Evidence | Fix | Proof | Status |
|---|---|---|---|---|---|---|---|
| G1 | Settings / save | Save button widens from 96 to 128 px when its spinner appears | State-stable controls | `before/settings-save-loading.png` | Spinner overlays the hidden label in a fixed-width slot | Width probe equal across idle/loading/done; `skill://visual-qa` before/after pair | open |

A row records a gap; it is not permission to fix it. Rows inside the request are the work. A row that widens the request, changes the product's direction, or needs an owner choice stays `open (owner)` and goes to the owner, with its evidence, through `ask` or the reviewed plan.

## 5. Close the ledger

Plan the fixes before the first edit (`/prometheus` for a ledger large enough to need a reviewed plan): each in-scope row names its fix and, in advance, the `skill://visual-qa` item or probe that will prove it. Each fix is a scoped pass (`SKILL.md` Verify). Rows with disjoint files may run as parallel native `task` children; a consequential choice that surfaces mid-way pauses for `ask` instead of being settled silently. The work ships as one change unless the owner asks for it to be split. A row closes only with its before/after pair and the passing proof, and the pairs go in the PR body or change description. Report progress as closed/total ledger rows, naming what closed since the last report and which rows wait on the owner.
