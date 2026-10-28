# Changelog

## Unreleased

### Improvements

- Make category workers escalate unapproved material choices to their parent and keep refactor delegation proportional to independent work.
- Align debugging and Git guidance with observed evidence, user-owned decisions, and previously authorized commit cadence.
- Inject an agent selection protocol into the main agent's system prompt when the `task` roster lists omo-toolkit agents: domain-to-agent lanes, `deep-low` as the default, and handling of `ESCALATE: deep-high` and `ESCALATE: parent` results by re-dispatching with the same task `name`.

## [0.6.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.5.0...omo-toolkit@0.6.0) (2026-10-28)


### Features

* **omo-toolkit:** add coding-agent-sessions, onboarding and give-me-tips skills ([b5df91b](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/b5df91b54eec099f9653bea4ca86765e2c34c03b))
* **omo-toolkit:** add data-scientist and repository-first programming skills ([962326d](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/962326d7da12f948a4272ae36f6c519883842be3))
* **omo-toolkit:** add opt-in comment checker, AGENTS.md coverage advisor and fallback architect hint ([ecb5ae2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ecb5ae2696e9083e6a786eced42c31c6630b8f35))
* **omo-toolkit:** add ultimate-browsing routing and visualize skills ([4ebd654](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/4ebd654a90cd867f3acebcc9cbe08607a78267c9))
* **omo-toolkit:** run comment-checker through pinned bunx when no path is set ([7b3932d](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/7b3932d6323423e0a6a998b014fb09d3b0d14262))
* **omo-toolkit:** sync frontend and visual-qa with upstream draft guard and bounded review ([9fd0911](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9fd0911fa53ad7ecd08e70584bfca8430e6213fe))
* **omo-toolkit:** sync init-deep with reviewed-PR delivery and durable snapshots ([9ea55e0](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9ea55e012d6a7f3d5a26ca89e36a4a038ceaf71a))


### Bug Fixes

* **omo-toolkit:** install golangci-lint from its v2 module path ([67b6362](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/67b6362234f54053725c4c25465629693d70776d))
* **omo-toolkit:** keep librarian read-only so routing never hands it to a writer ([aa64ea7](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/aa64ea7c1099880621e6694a6f35e74620426473))
* **omo-toolkit:** keep queued comment checks inside the host result budget ([8634905](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/8634905498d7aeb18842cc644a3771e0b076c8f4))
* **omo-toolkit:** put scoped Go tools on the generated CI path ([a393cd5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a393cd5c22bc65923cea727fdb786712a6343d26))

## [0.5.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.4.2...omo-toolkit@0.5.0) (2026-10-16)


### Features

* **omo-toolkit:** guide the main agent to pick agents by lane and handle escalations ([bb3e7c0](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/bb3e7c0d3186844a55da0f8588602d1de6c0db64))

## [0.4.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.4.1...omo-toolkit@0.4.2) (2026-10-14)


### Bug Fixes

* raise supported OMP floor to 18.10.4 ([9bdda2e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9bdda2ea3a1c547f8cd3447439819654ba448182))

## [0.4.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.4.0...omo-toolkit@0.4.1) (2026-10-10)


### Bug Fixes

* raise supported OMP floor to 18.5.1 ([217da70](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/217da70c138e3a5bd0ccaa0f7e1b3fb03b7d1b0f))

## [0.4.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.3.0...omo-toolkit@0.4.0) (2026-10-08)


### Features

* **omo-toolkit:** list designer and writer model roles in /models ([cbc5990](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/cbc5990d8c9a508ac15e23e7f83b71870cb10a57))

## [0.3.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.2.0...omo-toolkit@0.3.0) (2026-09-29)


### Features

* **omo-toolkit:** route librarian through tiny, writing through a writer role, and raise creative lanes to xhigh ([7ef81ff](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/7ef81ff4ba130fa7d1a4024659620a020788d908))

## [0.2.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.1.2...omo-toolkit@0.2.0) (2026-09-29)


### Features

* **omo-toolkit:** let visual-engineering prefer a designer model role before task ([3026f5c](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3026f5cf02061c0beef1969c25d4ea238f1a43ec))

## [0.1.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.1.1...omo-toolkit@0.1.2) (2026-09-28)


### Bug Fixes

* **omo-toolkit:** respect decision ownership in worker workflows ([74b6718](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/74b6718204f8c47e9d8e5bfdbd045554b7eb9697))

## [0.1.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-toolkit@0.1.0...omo-toolkit@0.1.1) (2026-09-28)


### Bug Fixes

* **omo-toolkit:** turn off thinking for librarian ([67c05f4](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/67c05f47430af82fdb831a9172109fe7c04d5244))
