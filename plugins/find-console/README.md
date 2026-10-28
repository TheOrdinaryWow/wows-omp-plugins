<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/find-console-dark.png">
  <img alt="find-console" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/find-console-light.png">
</picture>

# find-console

English | [简体中文](README.zh.md)

Run `/find` yourself to search by behavior, browse calibrated judge scores and preview the matching source ranges. The command runs the host's semantic search cascade in the current process, using the session's judge role and project settings. It does not ask the chat agent to search.

## Install

```bash
omp plugin install find-console@wows-omp-plugins
```

Requires OMP 18.12.0 or newer and a configured native judge, such as TypeSafe jev. Start a new session after installing. The plugin has no runtime dependencies or credentials of its own.

## Quick start

1. Run `/find where release-please versions are bumped`. Running `/find` without text opens a query prompt.
2. Watch the progress view. Esc or Ctrl+C cancels the search; there is no command-level search deadline.
3. Use Up/Down to select a result and Left/Right to switch refined ranges. By default the preview loads the full file and highlights only refined ranges. A `whole-file` result has no highlights and uses a bare-path reference.
4. Press Enter to insert the selected `path:start-end` reference into the composer, or `s` to send the selected hit to the agent. Esc closes the console without adding a transcript entry.

## Usage

### Query, scope and keywords

```text
/find [--path PATH] [-k KEYWORD]... [--glob PATTERN]... [--ext EXT]... [--min-score 0.2..1] [--limit N] [--no-cache] [--no-translate] <query>
/find --help
/find --cancel
/find --history
```

`--path` (short form `-p`) is the slash-command form of the CLI's optional `[path]`: it can name a directory, one file, or an internal URL. It defaults to the session's current directory, not the process's working directory. Use `-k` (or `--keyword`) once per extra lexical keyword. Query text can remain unquoted; quote a path or keyword containing spaces. The command completes its option names.

```text
/find --path plugins where version manifests are updated -k release-please
/find --path "a directory" -k "model role" how judges are resolved
/find --path omp://extensions.md how user messages are queued
/find -- --dash-leading query text
```

`--` ends option parsing. There is no ambiguous positional path: a path is always introduced by `--path`. Hidden and ignored files follow the host cascade's default search policy.

Use `--no-cache` to bypass both reads and writes in the host judgment cache. Reports count cached answers independently of cost: `all cached`, `partly cached`, `fresh`, `cache off`, or `cache unavailable`. Exactly zero costs display as `$0`; tiny non-zero costs display as `<$0.0001` rather than rounding to zero.

Queries containing non-Latin letters are translated to English before the lexical scan, using the configured `tiny` role first and `smol` if tiny is unavailable or fails. Results keep the original query and show `searched as: …`. If neither model works, search continues untranslated with the reason shown. Use `--no-translate` to disable translation for one search.

File filters run before lexical scanning and filename judgments. Repeat `--glob` for alternative patterns and `--ext` for alternative suffixes; glob and extension filters intersect. A glob containing `/` matches a search-root-relative path; otherwise it matches the basename at any depth. Extensions ignore case and accept an optional leading dot. `--min-score` filters both hits and refined ranges and must be at least the cascade threshold (0.2); `--limit` is a positive hit-count cap applied after score filtering. For example: `/find --glob 'plugins/**/*.ts' --ext ts --min-score 0.7 --limit 5 where settings are read`.

### Recent searches and follow-up questions

Recent original queries and their flags are saved per project in `.omp/.cache/find-console/history.json`, outside the installed plugin copy. The newest 50 searches are kept and duplicates replace their older flags. `/find` argument completion offers recent queries; `/find --history` or the console's Recent searches action opens a picker and reruns the selected search with its saved flags. Versioned history upgrades on load. It contains query text and paths, so treat it as local project data; remove the file to clear it.

Press `r` (Search within results) to ask another question restricted to the current hit files, without a repository-wide rescan. Existing flags are preserved and results identify `within N files of: <previous query>`. Press `h` for recent searches. Both actions close the console before opening host input/select dialogs; cancelling those dialogs does not send anything to the agent. A history rerun also restores a saved within-results file restriction. Recent-query text completion covers ordinary searches; use the history picker for restricted follow-up searches.


### Results console

The terminal opens a fullscreen console by default, with ranked hits on the left and source context on the right. Set `uiMenu: half-screen` for a compact, bottom-anchored overlay that keeps the conversation visible above it. Both layouts support selection, source preview and the same result actions. Scores use the same strong/plausible/muted bands as the built-in find tool. They are judge probabilities, not a guarantee that the hit is correct.

| Key | Action |
| --- | --- |
| Up, Down, Home, End | Select a hit. A new hit starts at its strongest range. |
| Left, Right, Tab | Switch between the selected hit's ranges, strongest first. |
| PgUp, PgDn | Scroll a long preview. |
| Space | Mark or unmark a hit for sending. |
| Enter, `i` | Insert the current range reference into the composer and close. The existing draft is preserved. |
| `s` | Send marked hits, or the selected hit when none are marked, as a user message. While the agent is streaming, queue it as a follow-up instead of interrupting it. |
| `o` | Open the local file at the current range's first line in `$VISUAL` / `$EDITOR`, using `+line`. With no configured editor, use the OS opener. |
| `r` | Ask a new question within only the current result files, preserving flags. |
| `h` | Pick and rerun a recent search with its original flags. |
| Esc, Ctrl+C | Close without sending results or recording the console in the transcript. |

In [Tern](https://docs.stencil.so/tern/), the same console opens as a large native glass sheet. Click a hit to preview it; the range, marking, insertion, sending and opening buttons run the same actions as the keys. Long paths appear in row tooltips, with the filename first in the list. The footer reports hits, cost, wall time and search accounting.

### Coverage and failures

- **Complete** means no judge request failed, not that every file or line was examined. The host cascade narrows candidates and applies read/window budgets.
- **Partial coverage** stays visible above the results; failed requests and unanswered questions remain in the accounting. A partial file has additional content the judge did not see.
- **Unavailable** means nothing was judged. The command shows an error explicitly stating that this is not evidence of absence, and opens no results console.
- **No hits** produces a notice rather than an empty console. With partial coverage, the notice still warns that unjudged files may match.

## Settings

### Terminal layout

```bash
omp plugin config set wows-omp-plugin-find-console uiMenu half-screen
```

| Setting | Values | Default | Effect |
| --- | --- | --- | --- |
| `uiMenu` | `fullscreen` \| `half-screen` | `fullscreen` | Choose a fullscreen console or a bottom-anchored half-screen overlay for terminal results. |
| `autoTranslate` | boolean | `true` | Translate non-Latin queries with tiny, then smol. `--no-translate` disables it per search. |
| `previewMode` | `full-file` \| `snippet` | `full-file` | Load the full file and focus the active refined range, or show only its surrounding context. Whole-file results have no highlights. |

The layout setting is read each time the results console opens; no session restart is needed. It applies only to the terminal TUI. Tern keeps its large native glass sheet, and RPC/ACP keep the selector/editor flow. To restore fullscreen, set `uiMenu` to `fullscreen`.

### Search enablement

The command reads the host's `find.enabled` setting on every call from the current session's project-scoped settings. For example, a project's `.omp/config.yml` can contain:

```yaml
find:
  enabled: auto
```

| Value | Behavior |
| --- | --- |
| `auto` (host default) | Enable only when the first usable judge-role candidate is native. Otherwise explain the missing native judge. |
| `on` | Pass the same enablement gate as the host tool. Non-native candidates are still refused before a judgment; the console never substitutes a chat or local text model for calibrated search scores. |
| `off` | Refuse and name `find.enabled` as the reason. |

Configure models and authentication through OMP, not this plugin. Billed judgment attempts are journaled through the host's `journalJudgmentUsage` when its session manager provides the usage ledger; cache hits are not billed. Hosts without that ledger still show the cascade's reported cost in the footer.

## Working with other plugins

No other marketplace plugin is required. `judge-dispatch` and this command share the host's judge configuration, but neither changes the other's routing or settings. The command registers no `tool_call` or `tool_result` hook, so it does not disable speculative reads or launches.

## Without the terminal UI

| Host | Behavior |
| --- | --- |
| RPC (`--mode rpc`, `rpc-ui`) and ACP with UI | Search progress appears through status updates with a cancel dialog. Results use a hit selector (file, score and range description), an action selector and a read-only preview editor. Preview edits are discarded. Marking, multi-hit sending, Search within results and Recent searches remain available. |
| Host without a composer editor | Insertion is unavailable with a reason; use the send-to-agent action. RPC composers that advertise editor support can accept insertion; ACP normally cannot. |
| No UI (print, JSON, SDK) | No dialogs or interactive actions. Supply the query in the command; ranked results, references, coverage, failures and accounting are reported through a displayed message. |

If a UI host cannot mount custom components, the command uses the same selector/editor flow. Closing a dialog does not send results to the agent.

## Known limitations

- Internal-URL hits, including `omp://` and `skill://`, can be previewed, inserted and sent but cannot open externally; the console explains why.
- External open runs on the machine hosting OMP. An RPC/ACP client on another machine does not gain a local editor integration. A terminal-only `$EDITOR` needs a real terminal; graphical editors and OS openers do not position reliably unless they accept `+line`.
- Source previews are read on demand and limited to the first 4 MiB, matching the cascade's read bound. The file may have changed since judging; the preview does not freeze or edit it.
- The command adds no 20-second timeout, but the host's underlying providers and filesystem scan retain their own limits. Cancelling cannot undo already billed judgments.
- The host extension command API has no command-level abort signal. Use the progress view's cancel action (Esc/Ctrl+C or a dialog cancellation), or `/find --cancel`; session changes and shutdown also cancel a running search.

## Reference

The [implementation reference](REFERENCE.md) documents refinement, translation, filters and versioned history storage. Host documentation covers [semantic find](omp://tools/find.md), [judge and find settings](omp://settings.md) and [extension UI/message delivery](omp://extensions.md).

## License

MIT.
