# Changelog

## Unreleased

### Fixed

- Bind execution to the exact approved plan, retain acceptance criteria, reject dependency cycles, and pause on unavailable or invalid ledgers instead of falling back to unguarded execution.
- Authenticate completion with native owned-child results and persistent receipts; require distinct fresh structured gate verifiers, with F4 following F1–F3.
- Invalidate stale downstream work and verification on reopen, serialize ledger updates with atomic file replacement, and reopen historical completions lacking proof on resume.
- Require final native task success after isolation postprocessing; reject early completion events and invalidate older receipts without final-result proof.

## [0.4.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.3.2...omo-prometheus@0.4.0) (2026-09-29)


### Features

* add shared Atlas execution and cross-session resume ([c2d64d2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/c2d64d27c59519387779687599f2078df2aa6e3f))


### Bug Fixes

* restore approved plan reference when resuming a session ([7956033](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/7956033c8789230748ba9f6e392d39811ce7befe))

## [0.3.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.3.1...omo-prometheus@0.3.2) (2026-09-29)


### Bug Fixes

* **omo-prometheus:** let Atlas message and cancel child agents ([8788bc0](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/8788bc0ebcaf3550e595efe7cd5c2bf5be03250e))

## [0.3.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.3.0...omo-prometheus@0.3.1) (2026-09-28)


### Bug Fixes

* **omo-prometheus:** bind completion to verified child evidence ([b5856b9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/b5856b9d02f676af05c88d54de432608a47dd92e))
* **omo-prometheus:** require final native execution success ([516c1ea](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/516c1eae01d04eefab8cb45866acb0a72c47d2a2))

## [0.3.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.2.0...omo-prometheus@0.3.0) (2026-09-28)


### Features

* **omo-prometheus:** run final gates on fresh children and gate metis and momus to planning ([5ae80f9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/5ae80f9dbd5d4a3ba33f1ce4208679beb3fe4662))

## [0.2.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.1.0...omo-prometheus@0.2.0) (2026-09-28)


### Features

* **omo-prometheus:** add configurable plan review level ([63cf177](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/63cf1773d9b3115c46b600be16f64d85998816f9))
* **omo-prometheus:** resolve plan agents against installed agents ([4c204aa](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/4c204aaa6cb3e988932abf04b8bc9c41c0cfa497))
