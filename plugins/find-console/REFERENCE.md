# find-console reference

[简体中文](REFERENCE.zh.md)

## Native refinement

The host cascade first verifies complete windows (up to 8 KiB each); those are candidate regions, not precise line matches. The console then sends at most 20 native-judge requests, one per hit, and at most 256 smaller segments per search. Each file receives at most 24 segments, with a deterministic equal-share cap when many files match. Segments contain at most 12 complete lines and 1,536 UTF-8 bytes, cut only inside verified windows.

A request contains `search`, `file`, a `passages` map (`s0`, `s1`, …, each with its original line coordinates), and `fullFile`. When the entire preview is untruncated and at most 24 KiB, `fullFile` contains its complete text and a separate `whole` probability question asks whether the file's overall purpose answers the query. Otherwise `fullFile` is null and no whole-file judgment is requested. Only an explicit `whole >= 0.8` over complete text produces `scope: "whole-file"`; it has a bare-path reference and no highlights. This avoids claiming whole-file relevance from samples.

Otherwise `scope: "ranges"` contains the segment probabilities at or above the cascade threshold (0.2). Adjacent passing segments merge. Budget-excluded portions and oversized individual lines retain the original verified-window scores and are visibly reported as unrefined. Request/read failures and unanswered questions retain the original windows, record `refineFailed`, and mark coverage partial rather than becoming negative evidence. All refinement requests use the same native-only judge, shared-cache policy, usage ledger and cancellation signal as the cascade.

`ConsoleHit.ranges` preserves the cascade windows; `ConsoleHit.refined` is the presentation/reference range set. `whole-file` hits have an empty refined set. Full-file previews still respect the 4 MiB read cap; the preview notice is independent of whether the judge examined the entire file.

## Cost and cache accounting

The plugin wraps only the cache reference passed into this search. Each native cache lookup adds its requested question count to `total` and the number of returned answers to `cached`. It does not mutate the process-wide cache. Labels are `all cached` (N/N), `partly cached` (k/N), or `fresh` (0/N). Without a cache the label is `cache unavailable`; `--no-cache` omits the cache entirely from judge resolution, disabling reads and writes and displaying `cache off`.

Cost is independent of cache state: exactly zero is `$0`, positive values below 0.0001 are `<$0.0001`, and larger values use four significant digits without trailing zero padding.
