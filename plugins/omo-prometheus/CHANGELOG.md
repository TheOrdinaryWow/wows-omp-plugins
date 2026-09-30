# Changelog

## Unreleased

### Fixed

- Bind execution to the exact approved plan, retain acceptance criteria, reject dependency cycles, and pause on unavailable or invalid ledgers instead of falling back to unguarded execution.
- Authenticate completion with native owned-child results and persistent receipts; require distinct fresh structured gate verifiers, with F4 following F1–F3.
- Invalidate stale downstream work and verification on reopen, serialize ledger updates with atomic file replacement, and reopen historical completions lacking proof on resume.
- Require final native task success after isolation postprocessing; reject early completion events and invalidate older receipts without final-result proof.

## [0.9.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.8.0...omo-prometheus@0.9.0) (2026-09-30)


### Features

* **omo-prometheus:** persist Atlas observation timeline ([76fed51](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/76fed5161ee9b3699541f45b7bcf1280d6031ddd))
* **omo-prometheus:** render live Atlas plan activity ([9658f05](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9658f05d2f7ba268ccda1b1be18ab1208bc31b2f))
* **omo-prometheus:** show configurable Atlas status widget ([d17bcbf](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/d17bcbfcfe285eedf8139360a99b18c9f32c1ffe))


### Bug Fixes

* **omo-prometheus:** keep Atlas live page scroll per body and list waiting rows in the widget ([1625908](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/162590850b1e7db0c70dd3fa6ab96f3dbd828f52))
* **omo-prometheus:** preserve Atlas todos through HUD refresh ([09a6286](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/09a6286b24c0dccbd75ad5a3b1b0c318f67844fd))
* **omo-prometheus:** render Atlas row evidence and acceptance as Markdown ([80b5ea2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/80b5ea244eb3c9fbbb1943383e6dcd76ed849c3c))
* **omo-prometheus:** synchronize Atlas ledger with session todos ([e0cf6cb](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/e0cf6cb31bbdaf8965a2c1ae7bd3ab38cd6a21e3))

## [0.8.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.7.0...omo-prometheus@0.8.0) (2026-09-30)


### Features

* **omo-prometheus:** fix gate rejections with new rows instead of reopening finished work ([ab922ec](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ab922ec1e25b3ee4f12eebe2e12d7ce744db23d2))
* **omo-prometheus:** show the running plan on /atlas and move exit to /atlas exit or Shift+X ([5b68764](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/5b68764a422b1c8e54fce5018923195e07827da7))

## [0.7.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.6.0...omo-prometheus@0.7.0) (2026-09-29)


### Features

* **omo-prometheus:** frame the /atlas menu with native OMP panel chrome and aligned progress ([08391df](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/08391df63180fde929ccfd7c728920b566ceb468))
* **omo-prometheus:** turn /atlas into Atlas Dispatch with auto-start, session resume and a fullscreen plan view ([39e63db](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/39e63db946caf292a8cd31d8a489fb380455c771))


### Bug Fixes

* **omo-prometheus:** refuse /prometheus when OMP plan mode is disabled in settings ([49fd2b7](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/49fd2b77ad85a57ab52b94288d43de95e1ad102f))
* **omo-prometheus:** render /atlas menu glyphs from the active OMP symbol preset ([293b46b](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/293b46b7d20cff57ebf89fd28c994e0e4cfb29e4))

## [0.6.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.5.0...omo-prometheus@0.6.0) (2026-09-29)


### Features

* **omo-prometheus:** add an interactive /atlas plan menu with search, rename and delete ([0d190bc](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/0d190bc4fcb80a98e5f0308ae2e4e13e1e568876))
* **omo-prometheus:** confirm early Atlas exit and refuse plan switching while active ([7aa47e4](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/7aa47e45a47fb04b67c46af5f420f51233ebc8e3))


### Bug Fixes

* **omo-prometheus:** hand off approved Atlas plans through a scoped URL ([8ee69b5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/8ee69b565cd36b1eff4eaf0037521ff8673c32d5))
* **omo-prometheus:** keep the atlas tier out of Ctrl+P while approval shows it ([a63bad9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a63bad94120d5238939f2090f9d58e7cca0fd63e))

## [0.5.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.4.0...omo-prometheus@0.5.0) (2026-09-29)


### Features

* **omo-prometheus:** add an atlas model role for approval and /atlas entry ([aeceec8](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/aeceec8a9eef73757a9acac06983692aad861ca4))


### Bug Fixes

* **omo-prometheus:** accept host-formatted approval handoffs and plan file names in /atlas ([da2d285](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/da2d285a3346e80883faabefae4de1f51b040b07))

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
