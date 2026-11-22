# Changelog

## [0.3.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/find-console@0.3.0...find-console@0.3.1) (2026-11-22)


### Bug Fixes

* **find-console:** keep URL segments with literal percent signs ([0f43020](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/0f43020679de99efb37428d075c36c6baf525f4c))
* **find-console:** match and search within percent-encoded URL file names ([52cb3cf](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/52cb3cfba79fd97af1cd9c84060732717d347912))
* raise supported OMP floor to 19.1.0 ([e4d84e1](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/e4d84e1afc0061507d429c582e94084daeabbb47))

## [0.3.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/find-console@0.2.3...find-console@0.3.0) (2026-11-19)


### Features

* **find-console:** show unranked literal matches when judging is unavailable ([87bafe1](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/87bafe132022fa3bc2f57933ecfff425f09fb49d))


### Bug Fixes

* honor same-provider judge restrictions by passing the session model ([995553a](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/995553afd3f883aef9cee58c27298796bee15a2e))
* raise supported OMP floor to 19.0.0 ([46e3b7d](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/46e3b7d05d32ba715cf5c15e400a053da983b84b))

## [0.2.3](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/find-console@0.2.2...find-console@0.2.3) (2026-11-12)


### Bug Fixes

* support OMP 18.19.0 and make it the minimum version ([4a28fae](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/4a28faeaf11f675a9f1a3bf7b53cb0b8f30a1939))

## [0.2.2](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/find-console@0.2.1...find-console@0.2.2) (2026-11-09)


### Bug Fixes

* **find-console:** load on bundled omp hosts by translating local models through completeSimple ([39ac207](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/39ac20703cafa460ace622aac7f32f4a692ce8db))

## [0.2.1](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/find-console@0.2.0...find-console@0.2.1) (2026-11-06)


### Bug Fixes

* **find-console:** count search requests toward the session cost cap ([0394ecb](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/0394ecb4ffd92f377a2d2078410acbc5279327c7))
* **find-console:** keep skill-scoped searches inside the skill root ([c794e93](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/c794e938b4c0f0fc6d9afaa7d9232b982e47c7be))
* raise supported OMP floor to 18.17.0 ([e0835f9](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/e0835f9b202187b0e86bb238ae21ece096e77e34))

## [0.2.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/find-console@0.1.0...find-console@0.2.0) (2026-10-28)


### Features

* **find-console:** define advanced search report contract ([a67543c](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a67543c4fc1b8983058eee13dfff69e0b4f4c263))
* **find-console:** filter candidate files and ranked results ([12939e2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/12939e28ed50bf21e2dae373a927a6a98b9ed78b))
* **find-console:** measure cached answers and support cache bypass ([9a53331](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/9a5333189f19cb317685112ba71db39f92f08eb2))
* **find-console:** persist history and search within current results ([1760cea](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/1760ceae28d943283a0e9687912f5a5333ab43b4))
* **find-console:** refine verified windows with native judgments ([f116203](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/f1162035e4719a81b4249c47af9d6489b36e5072))
* **find-console:** report each translation model attempt in progress ([c1995f4](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/c1995f4f684384c7bcc3933858ed1c0cdaca1c62))
* **find-console:** scroll full-file previews to refined ranges with cache, cost and follow-up actions ([01a780f](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/01a780fde81405b3691d6e342c58aee1454cac9f))
* **find-console:** translate non-Latin queries with configured roles ([6ca308c](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/6ca308cb8077e0194972477a2ddd124cba2c624c))


### Bug Fixes

* **find-console:** call the preview mode full file to keep it apart from whole-file hits ([a764a8e](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a764a8ed237bb8111d77e550fcddc0c439058a84))
* **find-console:** count billed judgments that later fail in the search cost ([02c3bd5](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/02c3bd5575041b9eb82cf41b52b857db8bf42777))
* **find-console:** drop the history upgrader for a format that never shipped ([a497eb2](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/a497eb222eba16ecca9509f937136552b5b163ec))
* **find-console:** keep the native source scroller inside the results sheet ([05e14b0](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/05e14b0d9aebf6ff7549962d669cdca6f00fa9ce))
* **find-console:** retain query provenance when sending selected hits ([60ba10f](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/60ba10fed42703d9fe51f5927cd994c9a4e66158))
* **find-console:** use singular nouns for single counts ([0b9a88a](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/0b9a88a1c8af3dae832c407cde8d3a4d9301e7c0))

## [0.1.0](https://github.com/TheOrdinaryWow/wows-omp-plugins/compare/find-console@0.1.0...find-console@0.1.0) (2026-10-28)


### Features

* **find-console:** add native previews and configurable terminal layouts ([2b1b0ca](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/2b1b0caf555f4c9cf937b8df0a4c643b118305c0))
* **find-console:** add user semantic search and host dialog flow ([d59f108](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/d59f108d18a589048d832d3ecbd795c57d422b5e))


### Bug Fixes

* **find-console:** keep preview height stable while sources load ([5f57230](https://github.com/TheOrdinaryWow/wows-omp-plugins/commit/5f57230f46b8c2d9105accd004ce799f1bacbae3))
