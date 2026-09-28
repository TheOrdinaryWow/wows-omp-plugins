> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `fe427efeed97e95f009dc6ca7fb17a3ac857f79f`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Phase 5 — User Decision Escalation

Escalation is for genuine ambiguity, not for skipping investigation. Most "should I ask the user" moments are really "I don't want to do one more query" moments, and those are wrong.

---

## Ask the user when the lead cannot settle a material choice

- Evidence and the request leave multiple valid fixes with different scope, risk, or lasting contract trade-offs; present those options and a recommendation before editing.
- The proposed fix would change user-visible behavior beyond restoring the already agreed contract.
- Evidence is exhausted or contradictory and proceeding would commit to a user-owned policy choice.

Do not delay a consequential decision merely to complete an Oracle round. Conversely, investigate instead of asking when one more repository or runtime query can settle the fact, or the user already made the choice. A delegated worker sends the decision brief to the parent, not directly to the user; the parent uses the user-facing decision surface.

---

## Escalation format (to the parent when delegated)

Keep it short. Evidence-dense. One decision, not a status update.

```markdown
## Decision needed

**What we know** (verbatim evidence, not paraphrase):
- <fact 1 with file:line or address>
- <fact 2 with source>
- <what the evidence rules IN>
- <what the evidence rules OUT>

**What the decision is** (one sentence):
<the fork in the road>

**Options**:

| # | Fix | Scope | Risk | Effort |
|---|-----|-------|------|--------|
| A | <short label> | <files touched / layers> | <regressions possible> | <rough> |
| B | ... | ... | ... | ... |
| C | ... | ... | ... | ... |

**Recommendation**: <A/B/C> because <one-sentence reason>.

Which direction do you want?
```

---

## Anti-patterns in escalation

- **Asking without evidence.** "What do you want me to do?" is not an escalation, it's abandonment. Every escalation includes the evidence the user needs to decide.
- **Two questions in one.** One decision per escalation. Multi-part questions lead to partial answers and re-escalation.
- **Delaying an unapproved choice for a ritual.** Oracle reviews are optional diagnostic help, not permission to decide a user's contract or a prerequisite to asking.
- **Presenting options you don't actually have.** If option C requires a library the user doesn't use, don't list it. The options are only things you can actually do today.
- **Hiding a recommendation.** The user hired you to think — always end with a recommendation, even if you're low-confidence. Say so explicitly: "Recommendation (low confidence): B, because X. If you have context about Y that I don't, it might change to A."

---

## What happens after the user responds

- **User picks an option**: return to Phase 6 (root cause confirmation) with the chosen direction. The user's choice is not itself confirmation — you still need runtime evidence that the cause you're fixing is the cause in play.
- **User proposes a different option you hadn't considered**: treat it as new information. Update hypotheses. May trigger another Phase 3 round.
- **User gives more context that resolves the disagreement**: skip to Phase 6.
- **User is also unsure**: that's a signal you need more evidence, not more opinions. Run one more targeted query before asking again.
