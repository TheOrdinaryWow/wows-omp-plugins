# Changelog

## Unreleased

### Fixed

- Bind execution to the exact approved plan, retain acceptance criteria, reject dependency cycles, and pause on unavailable or invalid ledgers instead of falling back to unguarded execution.
- Authenticate completion with native owned-child results and persistent receipts; require distinct fresh structured gate verifiers, with F4 following F1–F3.
- Invalidate stale downstream work and verification on reopen, serialize ledger updates with atomic file replacement, and reopen historical completions lacking proof on resume.
- Require final native task success after isolation postprocessing; reject early completion events and invalidate older receipts without final-result proof.

## [0.13.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.13.0...omo-prometheus@0.13.1) (2026-10-07)


### Bug Fixes

* write plugin state sidecars to a private runtime directory instead of the session directory ([ad085bc](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ad085bce8fe43c78de16625d9a3e821d6f69e16d))

## [0.13.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.12.0...omo-prometheus@0.13.0) (2026-10-07)


### Features

* **omo-prometheus:** run /atlas without the terminal UI and publish workflow state for clients ([479ad22](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/479ad2213c7ac909cad4a1bd16cd0e4549b19c56))

## [0.12.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.11.1...omo-prometheus@0.12.0) (2026-10-06)


### Features

* **roadmap:** prometheus binding and completion contract ([f68c4eb](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/f68c4ebe7c6ce9d18f2486394dc7c3ff05220d0c))


### Bug Fixes

* **omo-prometheus:** permit authenticated roadmap stage closure ([ac8e81f](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ac8e81f4edcea32a16ed1b5eaa8e06f7566c4238))

## [0.11.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.11.0...omo-prometheus@0.11.1) (2026-10-06)


### Bug Fixes

* **omo-prometheus:** let Atlas use extension-wrapped todo ([6966256](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/6966256caf877a15c71eb4b8b6b482cac6c624dd))

## [0.11.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.10.0...omo-prometheus@0.11.0) (2026-10-04)


### Features

* **omo-prometheus:** publish session-scoped Atlas DAG events ([fb642ae](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/fb642aee6612253bf12b3b50ad62cdc1cc719e2e))


### Bug Fixes

* raise supported OMP floor to 18.3.5 ([3872df5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3872df5c97904b74f5e42a35d9c79efdb881ff64))

## [0.10.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.9.3...omo-prometheus@0.10.0) (2026-10-01)


### Features

* **omo-prometheus:** let Atlas use read-only and memory native tools ([ccf05d6](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/ccf05d65fe0c783a330bba3666c69c490ae2de81))


### Bug Fixes

* **omo-prometheus:** let Atlas use Magic Context memory tools ([1c28643](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1c2864398737130d6ec97b07ac5a06f6d2e62b46))

## [0.9.3](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.9.2...omo-prometheus@0.9.3) (2026-09-30)


### Bug Fixes

* **omo-prometheus:** scroll the Atlas view with the mouse wheel ([3f2b9a5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/3f2b9a54b66557549e2201d50683c5f6e4e3eee4))

## [0.9.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.9.1...omo-prometheus@0.9.2) (2026-09-30)


### Bug Fixes

* **omo-prometheus:** refuse proposals whose plan Atlas cannot execute ([35fd468](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/35fd468bf560cd1e21d743ebac9949c0899a49aa))

## [0.9.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/omo-prometheus@0.9.0...omo-prometheus@0.9.1) (2026-09-30)


### Bug Fixes

* **omo-prometheus:** don't treat compaction after Save and quit as plan approval ([1a1d3f1](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1a1d3f1468f69ccebadfb1d08792eb63f110a417))
* **omo-prometheus:** keep Prometheus planning when the host restores plan mode ([1fb9e0f](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1fb9e0fcb2d52f2aed3257a7a3f0d487718b6aca))

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
