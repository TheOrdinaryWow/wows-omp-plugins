> **Modified-port notice and license.** This reference is a modified OMP port of oh-my-openagent ulw-loop material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Define the loop goals

Read this before `create_goals`, and before any `steer` or `add_goal` that changes a goal or criterion. The aggregate objective and the criteria form the binding contract for the whole run. The run's quality is capped by how well they are written.

A goal is a prompt that future you will follow, including after compaction. Keep only what the run cannot re-derive later: the outcome, the proof, the bounds, and the stop line.

## The quality bar

Before seeding, the objective must answer all five:

1. What concrete thing will be true when this is done? An outcome, never an activity.
2. What evidence will prove it? Commands, validators, or artifacts that someone can open.
3. What binary or numeric threshold defines success?
4. What is in scope, and what is explicitly out?
5. What should make the run stop and ask instead of grinding?

An objective that cannot answer one of these is not ready. Repair it first.

## Objective anatomy

Write the objective outcome-first, in this order:

1. **Outcome.** One sentence naming the artifact, system, repository, or user-facing behavior involved.
2. **Deliverables.** Literal paths, endpoints, packages, or environments. The executor reads names literally and infers no surface that you did not name.
3. **Success criteria.** Summarized here. Each one is a seed with its scenario and expected evidence (see Criteria below).
4. **Constraints and bounds.** The user's constraints, verbatim, including what is out of scope. Where the user was silent on a bound that the work depends on, choose the clearest defensible default from repository evidence and write it as `assumed: <constraint>. Rationale: <why>. Reversible: <yes or no>.` Unstated bounds do not exist, which is why you write them.
5. **WHEN TO STOP.** One line: "Stop right away when <the exact observable state that ends this run>." The run delivers and stops the moment that line holds. Work past it is a defect.

State a motivation only when it changes execution. Positive statements beat prohibitions: "verify against staging" says more than "do not touch production".

## Criteria

Count by tier:

- LIGHT (known pattern, no open design decisions): one or two criteria, the happy path plus the riskiest edge.
- HEAVY (a new module or abstraction, auth or security, an external integration, a schema or migration, concurrency or cache behavior, a cross-domain refactor, or a user who asked for care): at least three criteria covering the happy path, an edge (boundary, empty, malformed, concurrent), a regression named by file and function, and the adversarial risk the change creates.

Tier triage is per goal. Choose HEAVY when unsure, upgrade as soon as a HEAVY fact appears, and never downgrade mid-run.

Each criterion carries these at definition time, not after the work:

- **Binary pass condition.** "Returns 200 and the body matches the schema." Never "works correctly".
- **Exact scenario.** The literal command, request, page action, or payload that proves it.
- **Expected evidence.** The artifact it will capture: transcript, status plus body, screenshot path, diff, parsed dump, or cited source for research.
- **userModel.** One of `happy`, `edge`, `regression`, or `adversarial`.
- **essential.** Set it to true for criteria that must pass before a non-final checkpoint can close. Final completion checks every criterion regardless.

A criterion that cannot fail is not a criterion. If no input could make the scenario fail, rewrite it until failure is possible.

Probe the adversarial classes that the change actually triggers: malformed input, prompt injection, cancel and resume, stale state, a dirty worktree, hung or long commands, flaky tests, misleading success output, and repeated interruptions. Record each class the change does not trigger as not applicable, in one line, in the `notes` of the next evidence record.

Research goals use the same structure. The scenario is the source check that the research question needs. The expected evidence is the cited source and its dated revision.

## Make it quantitative

Prefer numbers that represent real success. A threshold that nobody would act on differently is noise.

| Domain | Quantify as |
|---|---|
| Bug fix | The failing case captured first, the same case passing after. |
| Tests | The exact command and pass condition, plus a run count for flake-prone suites. |
| Performance | Metric, target, measurement method, and run count ("p95 under 250 ms across 3 consecutive local runs"). |
| Quality work | The observable bar: lint, typecheck, and tests pass; reviewed examples; a user-approved artifact. |
| Research | The decision the research must enable, the sources in scope, and the evidence standard per claim. |
| Operations | Healthy state, monitoring window, failure threshold, and the rollback or escalation trigger. |

## Repair weak goals

Reject activity objectives such as "make progress", "keep investigating", "improve things", or "work on X". They cannot fail, so they cannot finish.

Rewrite vague goals when local context makes the rewrite safe. Ask the user one narrow question only when the missing detail is an owner decision: something irreversible, destructive, safety-critical, or a cross-cutting product choice (budget, public surface, external dependency, data shape, or target audience). Shape the question around the missing validator or bound, for example: "Which environment do I verify against: local, staging, or production?" Every other gap becomes an `assumed:` default that the user can veto.

When the user cannot name a metric, choose the most honest binary validator available and state it in the objective.

Weak: "Make checkout faster."
Repaired: "Reduce checkout API p95 below 250 ms on the documented slow path with the smallest safe server-side change. Prove it with `npm run test:checkout` green plus a local latency benchmark showing p95 under 250 ms across 3 consecutive runs. Out of scope: client-side changes and new caching layers."

Weak: "Keep investigating the PR comments."
Repaired: "Resolve every open change-requesting review comment on PR 123 that touches the auth files and their tests. Prove it with the targeted auth test command green plus `gh pr view 123` showing zero unresolved change-request threads."

## The brief file

The brief is the authoritative record of the user's request. Write it as a plain text file and pass its path as `briefPath`, either absolute or relative to the project directory. Put it outside the repository, for example in the loop directory that contains the `evidenceRoot` reported by `status`. `local://` URIs are not file paths for this tool.

The plugin reads the file once, when `create_goals` runs, and keeps its text in the loop state. Later edits to the file do not change the loop. Include the user's request verbatim, every constraint the user stated verbatim, the out-of-scope items, and the owner decisions already made. Do not paraphrase the user in place of their words.

## Registration

The loop itself exists only after the user runs `/ulw-loop <goal>`. If `status` reports no loop, tell the user to start one. Otherwise act on what `status` reports:

| `status` shows | Action |
|---|---|
| A loop with no goals yet | Write the brief, then call `create_goals`. |
| Goals already exist | Continue them, or steer them. Never seed again (`ULW_LOOP_GOALS_EXIST`). |
| Completed | Read-only. Unrelated work needs a new session. |
| Paused, blocked, or stopped | Do not mutate. Report it and wait for the user to run `/ulw-loop resume`. |
| Driver foreign or missing | Stop and report it. Never take over another native goal. |

Goals are unlimited. Never invent a token budget, run quota, or deadline that the user did not state. The `assumed:` work constraints are different: they are required.

## Completion honesty

- A pass needs evidence captured in this run, at the current tree.
- A green suite is supporting evidence, never completion proof by itself.
- Waiting is not blocked. A running child or background process can still wake the run, so let it finish.
- Blocked needs a true impasse: no way to resume, and the same block across consecutive turns.
- When the WHEN TO STOP line holds with evidence in hand, deliver and stop.

## Anti-patterns

| Anti-pattern | Why it fails | Instead |
|---|---|---|
| Activity objective ("investigate X") | Cannot fail, so it cannot finish | Name the outcome the activity must produce, and its evidence |
| Criteria added after implementation | The contract bent to fit the work | Write criteria and scenarios before any edit |
| Decorative precision (a number nobody measures) | No validator checks it | Use only thresholds that a named validator will check |
| Padded objective (role prose, restated context) | Extra tokens compete with the criteria | Outcome, deliverables, criteria, bounds, and stop line; nothing else |
| Goal written in prose or a notepad | Nothing binds the run | Seed goals through `create_goals`; change them through `steer` |
| Duplicate aggregate for the same intent | Two contracts, neither authoritative | Continue the active aggregate, or surface the conflict |
