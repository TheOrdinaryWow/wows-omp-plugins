<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-dark.png">
  <img alt="omo-prometheus" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/omo-prometheus-light.png">
</picture>

# omo-prometheus

English | [简体中文](README.zh.md)

> Plan a big change with an agent that asks the right questions first, then have it carried out task by task, with proof that each task is done.

For a large or unclear change, starting to code right away usually goes wrong. This plugin brings the Prometheus planner and the Atlas executor of [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO) to OMP, on top of OMP's Plan Mode:

- **Prometheus** plans. Before writing anything, it has **Metis** check what you actually want and what is missing, and it asks you only questions whose answers would change the plan. **Momus**, and for harder work **Oracle**, can review the plan and reject it for what it misses or for what it builds beyond the need.
- **Atlas** carries out the approved plan. It hands every task to a subagent, accepts a task only when the subagent's result proves it, and finishes with four independent reviews. The main session never edits files itself while Atlas runs.

## Install

```bash
omp plugin install omo-prometheus@wows-omp-plugins
```

You need OMP 18.17.0 or newer with Plan Mode enabled (`plan.enabled`, on by default). Restart OMP after installing.

If you used the older `prometheus` plugin, uninstall it first with `omp plugin uninstall prometheus@wows-omp-plugins`. Its plans do not carry over, so start a new one.

## Quick start

```text
/prometheus add rate limiting to the public API
```

1. Prometheus enters Plan Mode, consults Metis and asks its questions. Answer until it proposes a plan.
2. Review the proposal and approve it in OMP's usual approval dialog.
3. Atlas starts on its own. The widget above the editor shows progress, and `/atlas` opens the full view.
4. The plan is done when every task, the four final reviews and any delivery step have passed. `/atlas exit` leaves Atlas at any time.

## Usage

### Plan with `/prometheus`

`/prometheus` enters Plan Mode, or switches a Plan Mode session that is already running to Prometheus. Put the request on the same line or in your next message. Running `/prometheus` again while planning leaves Prometheus and Plan Mode.

In OMP's ordinary `/plan` mode, small and clear requests stay on the normal path. For large, cross-cutting or unclear goals, the planner asks whether to switch to Prometheus.

The plan goes through OMP's normal approval. If OMP's plan autosave is on, the approved copy is also saved under `.omp/plans/`. The [`reviewLevel`](#settings) setting decides whether Momus alone, or Momus and Oracle together, review the plan before you see it.

Reviewer verdicts are saved beside the plan and kept with its approved copy for later reference. They do not replace your approval. If a review round neither finds a new blocking problem nor confirms that a recorded one is fixed, Prometheus stops and asks you what to do, even before `reviewRoundLimit` is reached.

Plans keep each task small enough for one subagent to finish and check, and each acceptance check lists the pages, states and screen sizes it covers. Momus rejects a task whose acceptance says "every state" or applies a design rule across the whole app, and a task too large for one subagent, because during the run both turn into round after round of fixes.

Prometheus keeps the plan to what is actually needed. Each part of the desired result says who depends on it and where the requirement comes from (your request, a decision you confirmed, or something the repository already promises). Each task lists what it adds, and a `## Must not build` section lists what is deliberately left out. The proposal shows both, along with reviewer suggestions Prometheus decided not to follow. For a hard design or algorithm question, Prometheus may also consult `architect` or `ultrabrain` when they are available.

### What a plan looks like

Every plan ends with a task list and the final reviews:

```markdown
## Tasks
- [ ] T1. Add the parser
  - Agent: task
  - Depends on: none
  - Tier: LIGHT
  - Acceptance: the new unit test passes and the CLI prints the parsed value
- [ ] T2. Update the command help text for the new flag
  - Agent: sonic
  - Depends on: T1
  - Tier: LIGHT
  - Acceptance: CLI help lists the new flag

## Final gates
- [ ] F1. Plan compliance review
- [ ] F2. Code quality review
- [ ] F3. Real-surface QA
- [ ] F4. Success-criteria fidelity
```

Each task names the agent that does it, what it depends on, how to tell it is done and its tier, `LIGHT` or `HEAVY` (see [Set how carefully each task is checked](#set-how-carefully-each-task-is-checked)). Prometheus picks the most specific agent your session offers, preferring those of omo-toolkit. If that agent is gone by the time the task runs, Atlas uses a fallback, and you do not have to approve again. The full plan format is in the [reference](REFERENCE.md#plan-grammar).

### Set how carefully each task is checked

Every task is either `LIGHT` or `HEAVY`. A `LIGHT` task is done on its own proof: its subagent shows its checks pass, and the final reviews cover the whole change. A `HEAVY` task gets a second check from a fresh subagent that did not do the work, and it counts as done only after that check passes.

The tier depends on what an uncaught defect would cost, not on which part of the code the task touches. A task is `HEAVY` when a defect its own checks could miss would plausibly lead to:

- unauthorized access, a bypassed permission or policy check, a security feature that silently stops working, or exposed secrets;
- loss or corruption of data kept in storage;
- a destructive or irreversible migration, or a storage format change that cannot be undone;
- money or paid quota charged, settled or credited wrongly;
- breaking existing callers of a published interface or one shared across components;
- a concurrency bug on a production path.

A task is also `HEAVY` when it changes shared behavior that several modules must change together, or when it is by itself a very large new production subsystem. Everything else is `LIGHT`. That includes tests and benchmarks, documentation, scripts and CI, front-end pages that call existing APIs, and changes inside one module whose failures show up in the task's own checks, such as logging, renames, configuration parsing and additive features.

While it plans, Prometheus asks OMP's `judge` role to settle each task's tier from the task text. That role is OMP's judge model, the one it uses to classify tasks. Only a judgment model counts, such as TypeSafe's Jev or an OpenRouter decision model; an ordinary chat model is never asked. When the judge is sure, its tier stands. When it is not sure, when no such judge is configured, or when `tierJudge` is off, Prometheus picks the tier by the rules above and writes a `Tier basis:` line with its reason. You can also settle a tier yourself: tell Prometheus before you approve, and the plan records `Tier basis: owner — <reason>`. The [reference](REFERENCE.md#tier-judge) has the exact rules.

### How Atlas carries out a plan

After approval, the main session becomes Atlas. Atlas does not edit files or run commands itself; it sends every task to a subagent and tracks progress in a ledger. A task is done only when its subagent's final result proves it, and ticking the box in the plan file changes nothing. Tasks run in dependency order, with one exception: a task that depends on a `HEAVY` task starts as soon as that task's implementation is recorded, while its independent check is still running. Final reviews and delivery still wait for everything. If the check then fails, the repair runs as usual, and tasks already running are told about any interface the repair changes.

Subagents may find problems along the way:

- A problem within the change's reach becomes a new task (`D1`, `D2`, …) that runs before the final reviews. It normally waits for the task that found it to finish; if it prevents that task from meeting its acceptance, it can be handled first. Existing discovered tasks keep their ordering after a plugin update.
- A problem outside it becomes a finding (`O1`, `O2`, …) that Atlas sorts as a roadmap TODO, a duplicate, won't fix or report only. Atlas cannot finish while a finding is unsorted, and the final report lists them all.

Atlas keeps going until the plan is done. If the plan or ledger files go missing, get damaged, or no longer match the approved plan, Atlas pauses until you restore them, or until you exit with `/atlas exit` and approve a changed plan.

A task stops being retried after two identical failures in a row, a third failure, or four hours of work unless the plan sets another limit (see below). A failure doesn't count when the checking subagent shows that every earlier failure is now fixed and it found a different problem, up to three such failures per try. Once no other task is ready to start, you can give the stopped task another try without losing its history, even while other tasks are still running. A failure that comes from the test harness rather than the product gets one extra repair. If the subagent that checks a `Tier: HEAVY` task is stopped by a broken environment and finds nothing wrong with the change, the finished work is kept and only the check runs again. A subagent call that fails before any subagent starts costs the task no retry. The [reference](REFERENCE.md#retry-windows-and-delivery-repair) has the exact rules.

A `HEAVY` task's first check looks at everything. It reports every problem it finds in one pass and fails the task only for its own acceptance. After a failed check and its repair, the next check is narrower: it confirms that each listed problem is fixed and that the repair broke nothing. It fails the task again only for a listed problem that is still there, a regression the repair caused, or a newly found problem with a severe result: exposed secrets or credentials, unauthorized access, lost or corrupted stored data, an irreversible migration or stored-format upgrade, a broken caller of a published contract, or a concurrency bug on a path that carries user traffic or data. Any other new finding goes on the list of discovered tasks or findings, and the task is not reopened for it. Problems in other tasks' code go on that list too.

If a task reaches its time limit but its subagent has already finished successfully, granting another try keeps that result without making the subagent repeat the work.

Prometheus keeps long test suites out of individual tasks. Each task and its checker run the tests the change touches, and a suite that takes hours runs once, in the real-surface QA review at the end. A task or final review that needs more than four hours gets a line such as `Time limit: 14h` (1 to 72 hours), and approving the plan approves that limit. When Atlas asks you to give a stopped task another try, it can propose a higher limit; the limit changes only if you confirm it in that dialog. When a task is tried again, after a failure or a ruling, the new attempt keeps each check that already passed and that nothing since can affect, and reruns only the checks that failed, were never reached, are measured differently under a ruling, or could be affected by new changes. If a ruling changes a threshold, the recorded measurement is judged against the new threshold without being measured again. A check that depends on timing, memory or load is not rerun just to confirm a pass already recorded, and Atlas never asks you to relax a check that already has a reusable pass. A reimplementation starts from nothing. Atlas never adds repeated or stress runs of a test, or a pass threshold stricter than the plan's acceptance; a repeat count applies only when the plan or one of your rulings states it. An intermittent failure is traced before anyone is blamed. In a test the task added or changed, the failure is that task's problem, unless the test's own timing is wrong and the product clearly behaves correctly. A test the task did not touch is rerun alone and checked on the plan's starting commit: if it fails there too, it is a known flaky check for the plan; if it does not, the failure is recorded as a finding instead of failing the task.

When a task needs you, Atlas marks it blocked and carries on with everything that does not depend on it. Questions that would not change the work go into its reply; when nothing else can move, it asks you in a dialog and waits. A running subagent that only needs you to do something outside the session, such as starting Docker or signing in, is left running with its work intact: Atlas asks you, then tells the subagent to continue. The final report lists every assumption it made. If you fix a blocker yourself, tell Atlas which commit or files did it, and a new subagent checks the task again. Atlas never rolls back unverified work; it keeps it and lists it.

If your answer changes how a task's acceptance is met, for example by accepting a smaller result, Atlas records it as an owner ruling (`R1`, `R2`, …). By default it asks you to confirm the ruling first. The old acceptance applies until the ruling is recorded, and the ruling states the accepted value or setting itself, so the subagent doesn't pick it. Atlas then runs the task again, but only what the ruling affects, along with any check that failed or may be affected by changes; the earlier passing results still stand. The reviewers see the ruling, and the final report lists it as a deviation from the approved plan. If the change affects which tasks there are or the scope, run `/atlas exit` and plan again with `/prometheus`.

Atlas mirrors the plan into your todo list, and titles the session "Atlas …" unless you named it yourself.

Subagents commit their own work. If you use OMP's task isolation with `merge: patch`, Atlas switches it to `branch` while it runs, so each subagent's commits are kept, and restores your setting afterwards. Outside a Git repository nothing uses Git; run `git init` before planning if you want commits.

### The final reviews

When every task is done, Atlas runs four reviews in parallel, each by a fresh subagent that reports but never fixes:

| Review | Agent | Checks |
| --- | --- | --- |
| F1. Plan compliance review | `momus` (fallback `reviewer`) | the changes match the approved plan |
| F2. Code quality review | `deep-high` (fallback `task`) | correctness, scope, proportion, maintainability, test value and regression risk. A critical or high-severity finding fails it, including machinery built beyond what the plan declared |
| F3. Real-surface QA | `deep-low` (fallback `task`) | every verification scenario, actually run, with an artifact behind each pass |
| F4. Success-criteria fidelity | `deep-high` (fallback `task`) | the result against each success criterion; it passes unless a criterion is shown to fail |

Only `PASS` counts. When a review rejects the work, each fix becomes a new task (`X1`, …), and only that review runs again afterwards; reviews that passed keep their result.

### Deliver the result

The `delivery` setting decides how finished work leaves the repository:

- `direct` keeps the commits on your working branch.
- `pr` has a subagent push the branch and open a pull request after the reviews.
- `ship` also follows the pull request through CI and review and merges it. Failures within scope become fix tasks, and the affected tests and QA run again.
- `ask` (the default) makes Prometheus ask you when the repository has a remote.

`pr` and `ship` without a remote become `direct`. You can also say which one you want in conversation. Merging follows the repository's own required checks and review rules; Atlas never approves its own work. Missing access, a required human approval or an unclear branch stops delivery and asks you.

### The `/atlas` command

```text
/atlas                          # not running: open Atlas Dispatch; running: open the plan's view
/atlas <plan-name-or-id>        # start a plan in this session
/atlas start <plan-name-or-id>  # same as above
/atlas list                     # list approved plans with their status
/atlas show <plan-name-or-id>   # show a plan's tasks, acceptance and evidence
/atlas resume <plan-name-or-id> # switch to a session that already ran the plan
/atlas rename <id> <new name>   # change a plan's display name
/atlas delete <id> [--yes]      # delete a plan and its evidence
/atlas exit                     # leave Atlas (asks first if the plan is unfinished)
```

Apart from bare `/atlas` and `exit`, these work only while Atlas is not running; to switch plans, exit first. Plans can be named by their name or ID.

Atlas Dispatch lists the unfinished plans of the current workspace. Tab shows every plan, including finished ones and those from other workspaces, for viewing only.

| Key | Action |
| --- | --- |
| typing | Search names, IDs or status |
| Enter | Start the highlighted plan |
| Space, Shift+I | Open the full plan view |
| Shift+R | Resume in a session that already ran the plan |
| Backspace, Delete | Edit the search; with an empty search, Backspace deletes the plan (Delete always does) |
| Shift+N | Rename the plan |
| Esc | Close |

Starting a plan in a session that already has messages asks whether to use a new session or this one.

While Atlas runs, bare `/atlas` opens a live view of every task's status, the running subagents with their model, current tool and usage, and a timeline (Tab). Shift+X exits Atlas and Esc closes the view. Set `atlasWidget` to `false` to hide the progress widget above the editor. In [Tern](https://docs.stencil.so/tern/), these open as native sheets with buttons for the same actions.

### Continue in another session

Plans and their evidence are stored in your OMP session directory, not inside one session. Another session in the same workspace can continue a plan with `/atlas <name>`. Shift+R or `/atlas resume` goes back to a session that already ran the plan.

A plan runs in one session at a time. Exiting releases it, but does not cancel running subagents or mark work as done; a session with a running subagent keeps the plan until that subagent reports. Updating the plugin keeps existing plans runnable without approving them again.

### Choose the models

Metis, Oracle and Momus use OMP's `@slow` role. Atlas runs in the main session, and the plugin adds an `atlas` model role you can assign in `/model`:

```yaml
modelRoles:
  atlas: anthropic/claude-sonnet-5
```

While a plan waits for approval, the approval slider also offers `atlas`; move it off `default` to run the plan with that role. `/atlas <plan>` uses the role when it is assigned. The role is not part of the Ctrl+P model cycle.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-omo-prometheus reviewLevel standard
omp plugin config set wows-omp-plugin-omo-prometheus delivery pr
omp plugin config list wows-omp-plugin-omo-prometheus
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-omo-prometheus": { "delivery": "direct" } } }
```

Settings are read when a session starts, so restart the session after changing them.

| Setting | Default | What it changes |
| --- | --- | --- |
| `reviewLevel` | `ask` | How plans are reviewed before you see them (see below). |
| `reviewRoundLimit` | `5` | The most review rounds per plan. `0` or empty means no limit. At the limit you choose whether to allow more rounds or have Prometheus propose the plan as it stands, with the open problems listed. |
| `tierJudge` | `true` | Lets OMP's judge role settle each task's tier during planning. When off, Prometheus decides every tier itself and writes a reason for each one. |
| `tierJudgeConfidence` | `0.6` | How sure the judge must be before its tier is final, from 0 to 1. Below this value Prometheus decides the tier and writes the reason. A lower value lets the judge decide more tasks, a higher one leaves more to Prometheus. |
| `delivery` | `ask` | How finished work leaves the repository: `ask`, `direct`, `pr` or `ship` (see [Deliver the result](#deliver-the-result)). |
| `atlasWidget` | `true` | Show the progress widget above the editor while Atlas runs. |
| `progressReports` | `false` | Have Atlas post a short chat update before each batch of tasks and after each task: progress, result, how it was checked, any problem and the next step. |
| `herdrDag` | `true` | Show Atlas progress in the `omp-herdr-dag` pane. |
| `atlasRetry` | `ask` | Who gives a stopped task another try (see [Decisions while you are away](#decisions-while-you-are-away)). |
| `atlasAmend` | `ask` | Who confirms owner rulings that change a task's acceptance. |
| `atlasRelease` | `ask` | Who confirms that a finished plan is complete. |
| `atlasAskTimeout` | `30` | Minutes a dialog stays open before an `ask-then-*` value decides. |
| `atlasAutoRetryLimit` | `1` | How many extra tries per task a setting may give without you. `0` means no limit. |

`reviewLevel` values:

- `ask`: Momus reviews every plan. Momus and Oracle review together when you ask for high accuracy or the work is non-trivial and unclear; for clear work you get a one-time choice.
- `standard`: Momus reviews every plan. Asking for it explicitly still adds Oracle.
- `high-accuracy`: Momus and Oracle always review.
- `off`: no Momus or Oracle review, even on request. Metis still runs, and Atlas still runs the F1 review.

### Decisions while you are away

During a run, Atlas needs you for three kinds of decision: giving a stopped task another try (`atlasRetry`), confirming an owner ruling (`atlasAmend`) and confirming that the plan is complete (`atlasRelease`). Each setting takes one of these values:

| Value | What happens |
| --- | --- |
| `ask` | A dialog waits for your answer however long it takes. Without a UI, the decision is declined. |
| `ask-then-approve` | The dialog waits `atlasAskTimeout` minutes, then approves. In the terminal, any key restarts the countdown; Esc or declining in time is your decline. Without a UI, it approves at once. |
| `ask-then-decline` | The same, but it declines when the time runs out, or at once without a UI. |
| `approve` | Approves without a dialog. |
| `decline` | Declines without a dialog. |

Past `atlasAutoRetryLimit`, a setting can no longer approve extra tries for that task; you still can in the dialog. Every decision says whether you or a setting made it, and rulings approved by a setting are marked as such for the reviewers and in the final report. A declined completion keeps Atlas active until `/atlas exit`.

`atlasAmend: approve` lets Atlas loosen a task's acceptance without asking you, so only use it if you accept that risk. A mostly unattended setup, which still stops on problems that need you, could look like this:

```bash
omp plugin config set wows-omp-plugin-omo-prometheus atlasRetry ask-then-approve
omp plugin config set wows-omp-plugin-omo-prometheus atlasAmend ask-then-decline
omp plugin config set wows-omp-plugin-omo-prometheus atlasRelease approve
```

## Working with other plugins

- **omo-toolkit**: plans prefer its specialist agents, and the F2, F3 and F4 reviews run on its `deep-high` and `deep-low`.
- **judge-dispatch**: reroutes nothing while a plan runs, and never reroutes `metis`, `momus` or `oracle`.
- **omp-herdr-dag**: shows the plan's tasks, discovered tasks, fixes, reviews and delivery as a live graph.
- **roadmap**: a plan made while the session is on a roadmap stage belongs to that stage, and declares which of the stage's done criteria it covers with a line such as `Roadmap criteria: DC1, DC3`. Prometheus checks that line against the stage before you approve; criteria left out stay open for another plan. Atlas can use the roadmap tools, files findings as roadmap TODOs, and starts the stage before its first task. If the stage changes after approval, you get a notice and the plan keeps running. When the plan finishes, the session is reminded to consider closing the stage; it never closes by itself.
- **adr**: Atlas can use the ADR tools and accepts, rejects or supersedes ADRs itself; subagents never do.
- [Magic Context](https://github.com/cortexkit/magic-context): its `ctx_*` tools stay available to Atlas.

## Known limitations

- Atlas needs sessions saved on a local disk that supports hard links, atomic renames and syncing files and directories. With in-memory or remote-only session storage it refuses to run, and sessions with different session directories cannot see each other's plans.
- Planning with Prometheus needs Plan Mode's interactive approval, so it does not run in headless or SDK sessions.
- Plans from versions before the shared ledger cannot be resumed. Have them approved again.
- In Tern, the plan list and plan view keep one size and scroll their panes inside, so text in the scrolling panes cannot be selected or copied there.
- The tier judge reads only each task's text. A task whose risk does not show in its description can be judged `LIGHT`, so check the tiers of risky tasks before you approve and ask Prometheus to change any that are wrong. Your change is recorded as an owner decision.

## More details

[REFERENCE.md](REFERENCE.md) covers the plan format, which tools Atlas may use, how tasks are dispatched and checked, the plan files and ledger, retry rules, ownership between sessions, behavior in RPC, ACP editors and headless runs, the state snapshot, and the interfaces with `omp-herdr-dag`, `roadmap` and `adr`.

## License

The Prometheus, Metis, Oracle, Momus and Atlas prompt assets are modified derivatives of OmO. `NOTICE` records the upstream repository, the pinned revision, earlier fork history and the modification notice. The `/prometheus` and `/atlas` commands follow OmO's [Ultrawork Planner](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#planning-the-ultrawork-planner) and [`/ulw-execute`](https://github.com/code-yeongyu/oh-my-openagent/blob/ac9fcb6f4223cf105a80b93e965cbc6274e53100/docs/guide/orchestration.md#execution-ulw-execute).

Extension code and original packaging are MIT (`LICENSE-MIT`). The derived prompt assets under `agents/`, `assets/` and `skills/prometheus/` stay under the upstream Sustainable Use License 1.0 (`LICENSE-SUL-1.0`), which allows internal business, personal and non-commercial use, and free distribution only for non-commercial purposes.
