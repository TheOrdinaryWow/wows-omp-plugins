<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/snippets-dark.png">
  <img alt="snippets" src="https://raw.githubusercontent.com/TheOrdinaryWow/wows-omp-plugins/main/.github/banners/snippets-light.png">
</picture>

# snippets

English | [简体中文](README.zh.md)

> Type `.review.` and send: your saved review checklist goes out in its place.

Keep text you send often, such as a review checklist, a bug report template or project instructions, as small Markdown files. Typing a snippet's trigger word in a message replaces it with the saved text when you send. `/snippets` lets you browse, insert, send, create and edit snippets without leaving OMP. Snippets are plain files you can also edit by hand, and your pins and use counts stay out of your repository.

## Install

```bash
omp plugin install snippets@wows-omp-plugins
```

You need OMP 18.17.0 or newer. Start a new session after installing.

## Quick start

1. Create a snippet at `~/.omp/agent/snippets/review.md`:

   ```markdown
   ---
   description: Code review checklist
   ---
   Review checklist:
   - Does the change do what the description says?
   - Are edge cases and error paths handled?
   - Are there tests for the new behavior?
   - Are names clear and is dead code removed?
   - Does anything leak secrets or log sensitive data?
   ```

2. In a session, type `.review.` in a message and send it. The agent receives the checklist, and your chat history shows the checklist too.
3. Run `/snippets` to see all your snippets.

## Usage

### Where snippets live

| Scope | Location | Use it for |
|---|---|---|
| Global | `~/.omp/agent/snippets/<key>.md` | Text you reuse in every project |
| Workspace | `<project>/.omp/snippets/<key>.md` | Text that belongs to one repository |

The key is the file name without `.md`: letters, digits, `_` or `-`, up to 64 characters. If a workspace snippet has the same key as a global one, the workspace snippet wins and the global one is shown as shadowed in `/snippets`.

A snippet file is just its text. Optionally, it can start with a frontmatter block holding one `description` line, as in the example above. Edits you make by hand show up the next time you send a message or open `/snippets`. A file the plugin cannot read is skipped and listed as a problem in `/snippets`; the other snippets keep working.

### Use a snippet in a message

With the default settings, the snippet `review` has the trigger word `.review.`. Type it anywhere in a message, and it is replaced with the snippet's text when you send. Nothing changes while you type, but trigger words glow in the editor so you can see what will expand.

A trigger word expands only when it stands on its own in normal text:

- It must be a separate word. `file.review.bak` and `x.review.` stay as typed.
- Code spans, code blocks and HTML or XML sections are left alone.
- Lines starting with `!` or `$` (shell and Python commands) are sent exactly as typed.

To send a trigger word literally, put a backslash in front of it: `\.review.` sends `.review.`.

### Browse and manage snippets with `/snippets`

`/snippets` opens a console with your snippets on one side and a preview on the other. Pinned snippets come first, then the ones you use most. The preview shows the text, the trigger word (or "menu only" when there is none), where the file lives, and whether the snippet is shadowed or disabled. In Tern, the console opens as a native sheet with the same actions in an action bar.

| Key | Action |
|---|---|
| Up / Down, Home / End | Select a snippet |
| PgUp / PgDn, mouse wheel | Scroll the preview |
| Tab / Shift+Tab | Switch between All, Global and Workspace |
| Letters and digits | Search by key, description and text. Every word you type must match. |
| Left / Right, Backspace, Delete | Edit the search text |
| Esc | Clear the search, then close the console |
| Enter | Insert the snippet at the editor cursor. With no snippets yet, create one. |
| Shift+S | Send the snippet right away |
| Shift+N | Create a new snippet |
| Shift+E | Edit the snippet. Changing its key renames the file. |
| Shift+D | Disable or enable the snippet |
| Shift+P | Pin or unpin the snippet |
| Shift+X | Delete the snippet, after you confirm |

Uppercase S, E, D, P, X and N work as the Shift shortcuts; any other uppercase letter goes into the search.

### Create or edit a snippet

Shift+N and Shift+E open a form with four fields: Key, Scope (Global or Workspace), Description (one optional line) and Body (the text itself). The form writes the file for you, frontmatter included. Tab and Shift+Tab move between fields, Enter in Body adds a line, Ctrl+S saves and Esc cancels. The key is checked as you type, and a key already used in the chosen scope shows an error. When you edit, the scope cannot be changed. Renaming a snippet keeps its pin, disabled flag and use count.

### Commands

| Command | What it does |
|---|---|
| `/snippets` | Open the console |
| `/snippets <key>` | Put the snippet into the editor |
| `/snippets send <key>` | Send the snippet as your message |
| `/snippets list` | Post the list of snippets as a message |

These commands only find enabled snippets that are not shadowed. `send` and `list` are commands, so a snippet named `send` or `list` cannot be reached this way; rename it.

### Pins and use counts

Each expansion, insert or send counts as one use. Pins, disabled flags and use counts are stored in `~/.omp/agent/wows-omp-plugins/snippets/state.json`, outside your project, so they never end up in a commit.

## Settings

Change a setting for your user:

```bash
omp plugin config set wows-omp-plugin-snippets trigger "?"
omp plugin config set wows-omp-plugin-snippets matching open
omp plugin config list wows-omp-plugin-snippets
```

To change a setting for one project only, add it to `.omp/plugin-overrides.json` in that project:

```json
{ "settings": { "wows-omp-plugin-snippets": { "trigger": "?", "matching": "open" } } }
```

Changes apply the next time you send a message or open `/snippets`.

| Setting | Default | What it changes |
|---|---|---|
| `trigger` | `.` | The character or text that starts a trigger word. It cannot contain spaces or any of `/ ! @ ^ # : $ \` \\`; an invalid value shows a warning once and turns expansion off. An empty value also turns expansion and highlighting off, and snippets are then used only through `/snippets`. |
| `matching` | `closed` | `closed` means the trigger word ends with the trigger too (`.review.`); `open` means it does not (`.review`). |

For example, `trigger` set to `?` with `matching` set to `open` makes `?review` expand.

## Working with other plugins

snippets works on its own and does not need any other plugin.

## Known limitations

- Snippets expand only when you send. A trigger word stays as typed in the editor until then.
- The highlight in the editor may stop working after an OMP update. Expansion keeps working.
- In the terminal, inserting a long snippet from the console can turn it into a paste marker in the editor. Send it with `/snippets send <key>`, or check the text before you send.
- `/snippets <key>` needs a client with an editor. Elsewhere, use `/snippets send <key>`.

## More details

[REFERENCE.md](REFERENCE.md) covers the exact file format, the matching rules, how the plugin behaves in Tern, RPC, ACP and headless sessions, and the state file.

## License

MIT.
