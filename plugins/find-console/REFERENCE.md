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

## Query translation

Detection requires at least one Unicode letter whose script is not Latin. Chinese, Japanese, Cyrillic and Arabic therefore trigger translation; accented Latin letters, numbers and punctuation alone do not. This is script detection, not a general language classifier: non-English Latin-script queries are unchanged.

Resolution uses the host's `@tiny` role and its eligible candidate pool, then `@smol` if tiny is absent, fails, or does not return an English query. Local-inference models use the generic tiny chat client (not its 20-token title-generation mode); online models use `completeSimple` with the registry's credential resolver. A request contains only the original query and an English code-search translation instruction, with a 128-token output bound. Cancellation propagates; unavailable translation is reported and does not block an untranslated search. Online usage is journaled as `find-translate` and included in the reported cost, separately from judgment-cache answer counts.

The report's `query` is the actual searched text. Successful translation adds `originalQuery` and `translation: { model: "<role>: <provider>/<id>" }`; skipped/failed translation adds `translation: { skipped: "<reason>" }`. Only the original query is used for display and history. Translation does not mutate host role settings.

## Filters

`--glob` and `--ext` filter directory entries in a per-search native-filesystem view before the host cascade lists or lexically scans files. The shared filesystem is unchanged, directories remain traversable, and ignore-policy files stay readable. Explicit file roots are checked before starting the cascade. Globs without a slash match basenames at any depth; globs with a slash match search-root-relative paths. Repeated patterns are alternatives, repeated extensions are alternatives, and the two filter groups intersect. Extensions are normalized to lowercase without a leading dot.

`--min-score` must be in [0.2, 1], preserving the host cascade's minimum threshold. It filters cascade hits before refinement and filters refined ranges afterward. Range hits with no surviving ranges are removed; whole-file hits have no line ranges by definition. `--limit` is a positive safe integer applied last; hit ordering remains the cascade's calibrated score order.

## History storage and upgrades

The per-project file is `<ctx.cwd>/.omp/.cache/find-console/history.json`. Plugin upgrades replace only the plugin directory, not this file. Writes use a private temporary file (mode 0600) and atomic rename; missing history means an empty list. Malformed or unknown-version files are preserved and reported rather than silently replaced.

Current format:

```json
{
  "version": 2,
  "entries": [
    {
      "args": {
        "query": "where versions are bumped",
        "path": ".",
        "keywords": [],
        "globs": [],
        "extensions": [],
        "minScore": 0.2,
        "noCache": false,
        "noTranslate": false,
        "help": false,
        "cancel": false,
        "history": false
      },
      "searchedAt": 1793180000000
    }
  ]
}
```

`limit` is optional inside `args`. Restricted follow-ups also have `within: { query: "<previous original query>", files: ["<absolute path or URL>"] }` on the entry. The timestamp is Unix milliseconds. Newest entries come first; duplicates use normalized original query text, search path and within-file scope as their identity, keeping the newest flags. History is capped at 50 entries, including completed searches with zero hits; cancelled searches are not recorded. Search history first appears with this feature (0.1.0 wrote none). The accepted predecessor format is `{ version: 1, entries: [{ query, path, keywords, searchedAt }] }`; loading it fills new flags with defaults and atomically rewrites version 2 without losing the query, scope, keywords or timestamp.

The command API's completion callback has no context argument, so the extension loads a project-bound history snapshot at session start/switch and refreshes it after completed searches, using `ctx.cwd` only. Ordinary-query completion restores all command flags. Restricted follow-ups rerun through the host history picker so a textual completion cannot accidentally widen their file scope.

## Search within results

The action closes the current console, asks a new question through host input, and reruns the same cascade and refinement with unchanged flags. A synthetic directory tree is constructed only from the current hit paths and their ancestors. Both the lexical scan and filename listing see this tree through the native filesystem bridge; no repository directory enumeration occurs. File contents and metadata still resolve through the original session filesystem. Results display the preceding original query and restricted file count. Nested follow-ups narrow to their own current hits, and persisted history retains the exact file restriction for reruns.
