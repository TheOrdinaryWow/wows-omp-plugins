<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/audit-goal-dark.png">
  <img alt="audit-goal" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/audit-goal-light.png">
</picture>

# audit-goal

English | [简体中文](README.zh.md)

> A CodeRabbit-style review inside OMP that fixes what it finds and keeps going until the code stops turning up problems.

Run `/audit` with something you want checked, such as a branch, a plan or a feature, and the agent reviews it in rounds. In each round, reviewers look for problems without touching the code, the main agent checks every finding against the source and throws out the false ones, and fixers repair the rest. The agent runs your project's checks after every round and keeps a written record of what it found and fixed. It stops when the audit converges, when a round limit you set runs out, or when you stop it.

## Install

```bash
omp plugin install audit-goal@wows-omp-plugins
```

You need OMP 18.19.0 or newer with goal mode turned on (`goal.enabled`, on by default). Restart the session after installing.

## Quick start

```text
/audit the checkout service refactor on this branch
/audit plan local://PLAN.md
```

Describe the target in your own words. The footer shows progress, for example `Audit 2/5 · standard` (round 2 of at most 5, standard intensity). The audit runs on its own from there.

## Usage

### Follow, pause or stop an audit

An audit runs as an OMP goal, so the usual goal commands control it:

- `/goal` shows the audit's status.
- `/goal pause` pauses it. The agent cannot run audit rounds until you resume with `/goal resume`.
- `/goal drop` stops it for good.

`/goal budget` limits tokens, not rounds. To cap the number of rounds, use the `maxRounds` setting.

### What happens in a round

1. The agent splits the code into areas (server, worker, database, …) and sends a read-only reviewer into each one.
2. It checks every reported problem against the source and rejects the ones that do not hold up.
3. It sends fixers to repair the confirmed problems. Fixers working at the same time never edit the same file.
4. It runs the project's full checks, makes sure nothing is left uncommitted, and records the round.

Problems are graded Critical, Major, Minor or Picky. The record for each round lists which models reviewed, what they covered, which checks ran, the confirmed problems with their evidence, repairs of earlier problems, and why rejected claims were rejected.

Sometimes a fix adds new code that the next round then has to review, which keeps the audit going. The agent tracks these problems caused by its own fixes separately and is told to simplify or undo what it added.

### Choose how strict the audit is

The `intensity` setting decides what counts as a problem, what gets fixed, and when the audit may stop:

|  | `relaxed` | `standard` (default) | `strict` |
| --- | --- | --- | --- |
| Reviewers report | visible problems: wrong behavior in normal use, failing checks, clear deviations from the plan | problems that could realistically happen in production, followed end to end | also problems at the toolchain, dependency and OMP boundaries, and rare bugs with a concrete trigger |
| Gets fixed | Critical, Major | Critical, Major, Minor | everything |
| Stops after | one round with no Critical or Major | two rounds in a row with no Critical or Major | two rounds in a row with no Critical, Major or Minor |

### How an audit ends

Before the goal can complete, the agent has to record one of three conclusions:

- `threshold-convergence`: the stopping rule for the chosen intensity was met. That means the audit stopped finding problems, not that the code is bug free. Earlier Critical or Major problems stay open until a repair is recorded for them.
- `capability-saturation`: with no round limit, the same models have done at least three comparable rounds from different angles, and the agent explains why another round is unlikely to find more. Open problems stay open, and a low count of new problems alone is not enough.
- `stop`: the round limit ran out first. The agent asks whether to add rounds, remove the limit or stop. If you stop, it records why and what is still open. Dismissing the question leaves the choice open.

None of these means the audited work is accepted. That decision stays with you.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-audit-goal intensity strict
omp plugin config set wows-omp-plugin-audit-goal maxRounds 5
omp plugin config delete wows-omp-plugin-audit-goal maxRounds   # back to unlimited
omp plugin config list wows-omp-plugin-audit-goal               # show current values
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-audit-goal": { "intensity": "strict" } } }
```

Each `/audit` uses the values in effect when it starts. A running audit keeps them.

| Setting | Default | What it changes |
| --- | --- | --- |
| `intensity` | `standard` | How deep the reviewers look, which grades get fixed, and when the audit may stop: `relaxed`, `standard` or `strict` (see the table above). |
| `maxRounds` | unset | The most rounds one `/audit` may run. Unset means no limit. |
| `maxParallelLanes` | unset | How many reviewers or fixers may run at the same time. Unset means the plugin adds no limit. OMP's own `task.maxConcurrency` still applies, so a setting of 10 with an OMP limit of 3 runs three at a time. |

## Working with other plugins

`judge-dispatch` leaves the audit's reviewers and fixers alone, and never sends other work to them.

## Known limitations

- The reviewer and fixer agents, `audit-auditor` and `audit-fixer`, show up in the agent list of every session because OMP cannot hide them. They only run inside an `/audit`; anywhere else the plugin refuses them.
- `/audit` does not start in Plan Mode or vibe mode, while another goal is unfinished, or while an audit is already running.
- If the latest round record is damaged, the audit can neither continue nor finish. Run `/goal drop` and start a new audit.
- The audit follows the commit conventions and rules in the audited project's own context files, such as `AGENTS.md`.

## More details

[REFERENCE.md](REFERENCE.md) explains how the plugin drives the loop, how the audit behaves in RPC, ACP editors, the SDK and headless runs, and the state snapshot that client programs can read.

## License

MIT.
