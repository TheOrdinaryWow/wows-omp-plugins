# snippets reference

This page covers the file format, matching rules, settings, and state storage for maintainers and client authors. For day-to-day use, see the [README](README.md).

## Snippet files

Snippets live in two directories:

| Scope | Path | Notes |
|---|---|---|
| `global` | `<agent dir>/snippets/<key>.md` | `<agent dir>` is `getAgentDir()` (`~/.omp/agent` by default). |
| `workspace` | `<cwd>/.omp/snippets/<key>.md` | `<cwd>` is the session's working directory. |

A workspace snippet with the same key as a global snippet shadows it. The global entry stays listed as shadowed and never matches.

### Key

The key is the filename without `.md`. It must match:

```text
^[A-Za-z0-9_-]{1,64}$
```

Files whose names do not match are reported as problems and skipped. Problems never stop the plugin.

### Format

A file has an optional frontmatter block and a body:

```markdown
---
description: One line describing the snippet
---
Body text. Every line after the frontmatter is the body.
```

Rules:

- The frontmatter is optional. When present, it starts with a `---` line, ends with a `---` line, and may contain only `description: <value>`. The value is a bare one-line scalar, a double-quoted JSON string, or a single-quoted string with `''` escapes.
- Any other frontmatter key, a second `description`, or a block scalar is an error and the file is skipped.
- Without frontmatter, the whole file is the body. Trailing newlines are trimmed from the body. Other whitespace is kept.
- An empty body loads. Using such a snippet (insert or send) fails with an error and does not count a use.

Writes from the console use the same format (`formatSnippetSource`). Hand edits are read on the next load.

## Trigger words

A trigger word is the trigger setting, the key, and the trigger setting again (closed) or once (open):

| `matching` | Example with `trigger: "."` and key `review` |
|---|---|
| `closed` (default) | `.review.` |
| `open` | `.review` |

The trigger must not contain whitespace or any of these characters: `/ ! @ ^ # : $ \` \\`. An invalid trigger disables expansion, warns once, and never falls back to `.`.

An empty trigger turns off expansion and highlighting. Snippets are then usable only from `/snippets`.

## Matching

Matching is case-sensitive and uses the `u` flag. Only keys of enabled, non-shadowed snippets match.

Boundaries match the host highlight boundaries so the glow and the expansion agree:

```text
left:   (?<![\p{L}\p{N}_./\\-])(?<!::)
right:  (?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()
```

Additional rules:

- Matches are found only in prose. The text is passed through `maskNonProse` from `@oh-my-pi/pi-tui/prompt/markdown-prose`, which blanks code spans, fenced code blocks, and XML or HTML sections while keeping the length. Only matches that land in prose expand.
- Shell and Python sigils (`!`, `$`) at the start of the trimmed text skip expansion entirely.
- Expansion is a single pass. Bodies are never expanded again.
- Each expansion counts one use in the state file.

### Escape

A backslash immediately before a trigger occurrence keeps it literal. The backslash is removed from the sent text only when what follows would be a match of an existing key. For example, `\.review.` sends `.review.`.

## Settings

Settings are read from the plugin's `omp.settings` entry with `getPluginSettings("wows-omp-plugin-snippets", cwd)` on every use.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `trigger` | string | `"."` | Literal trigger prefix. Empty disables expansion and highlighting. |
| `matching` | `"closed"` \| `"open"` | `"closed"` | Trigger word shape. |

The plugin has no replace-mode setting. Expansion always happens at send.

## Expansion at send

Expansion runs in the extension `input` event (`pi.on("input", ...)`), which returns `{ text }`. It applies to sources `interactive` and `rpc`. Text from source `extension` is never expanded.

The store reloads on session start, on every `input` event, and after every console change. Highlights are re-registered after each reload and on `session_start` and `session_switch`.

Highlights register each active trigger word with the host magic-keyword engine (`setMagicKeywords` from `@oh-my-pi/pi-tui/prompt/magic-keywords`), alongside the host's own keywords from `MAGIC_KEYWORDS` in `@oh-my-pi/pi-coding-agent/modes/magic-keywords`. Snippet words use hues `190` and `290`.

## Console, form, and dialogs

The console and the form are plugin components. Tern gets the native versions, and the terminal gets the split console and the framed form.

- In Tern, the console is a native `picker` sheet with the preview below the list when the host supports `picker`. Hosts without it get a generic native layout. The terminal keeps the split view.
- The form is a `SnippetForm` with the native overlay role `omp.overlay.snippets.form`. It resolves to a draft of `key`, `scope`, `description`, and `body`. Only the focused text field is a live input, so the caret follows the keyboard.
- On save, the command formats the draft with `formatSnippetSource(description, body)` and writes it with `store.write`. A changed key renames the file first with `store.rename`, keeping its state, then writes the text when it changed.
- Without the custom UI (`ctx.mode` not `tui`, or no `ctx.ui.custom`), the same draft comes from `ctx.ui.input`, `ctx.ui.select` (scope, new snippets only), and `ctx.ui.editor` (body). No path shows frontmatter.

## State file

Personal state lives outside the repository:

```text
<agent dir>/wows-omp-plugins/snippets/state.json
```

Schema, version 1:

```json
{
  "version": 1,
  "entries": {
    "global:<key>": { "disabled": true, "pinned": true, "uses": 3 },
    "workspace:<absolute workspace dir>:<key>": { "uses": 1 }
  }
}
```

- `id` is `global:<key>` or `workspace:<absolute workspace dir>:<key>`.
- `disabled`, `pinned`, and `uses` are optional. Missing fields mean `false`, `false`, and `0`.
- A missing file is empty state. A corrupt file is empty state and triggers a warning. The plugin does not overwrite a corrupt file silently.

## Problems

Each load reports problems: unreadable files, invalid keys, bad frontmatter, and a corrupt state file. Problems appear as the console's persistent warning line (first problem plus a count) and in the headless list. Notices go to `ctx.ui.notify` when a UI exists; otherwise they are posted as a display message. Problems never stop expansion of other snippets.
