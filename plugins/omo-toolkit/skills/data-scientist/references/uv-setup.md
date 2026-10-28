> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# uv Setup — Per-Platform

This skill's isolated lane uses `uv run --with ...`; the Python cache helper also requires uv. Prefer an already installed uv or managed native eval. If uv is missing, explain that installing it changes a user/machine toolchain and ask for separate explicit consent. Never run either installer or any global package manager automatically on skill load or as a failed-import fallback. Resolve scripts from the actual physical skill directory, not cwd.

## Manual consent-only utilities

| Platform | Command |
|---|---|
| macOS / Linux / WSL / Git Bash | `bash scripts/setup-uv.sh` |
| Windows (PowerShell) | `powershell -ExecutionPolicy Bypass -File scripts/setup-uv.ps1` |

Both scripts may install **or upgrade** uv and can invoke platform package managers. The table is an explicit manual option after consent, not an automatic setup phase. These machine/user-wide effects are outside scoped package provisioning; loading a skill authorizes none of them.

## Manual install per platform

### macOS

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh        # official installer → ~/.local/bin/uv
# or, with Homebrew:
brew install uv
```

### Linux (x86_64 / aarch64)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh        # official installer → ~/.local/bin/uv
```

The installer detects glibc vs musl and downloads the right static binary. On minimal containers, ensure `curl` (or `wget`) exists; `wget -qO- https://astral.sh/uv/install.sh | sh` is the fallback.

### Windows (native)

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# or, with winget:
winget install --id=astral-sh.uv -e
```

### Windows Subsystem for Linux / Git Bash

Use the Linux/macOS installer inside the Unix shell, not the PowerShell installer:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### CI

```yaml
# GitHub Actions
- uses: astral-sh/setup-uv@v5
# or plain shell anywhere:
- run: curl -LsSf https://astral.sh/uv/install.sh | sh
```

## PATH notes

- The official installers put the binary in `~/.local/bin` (Unix) or `%USERPROFILE%\.local\bin` (Windows). New shells get it automatically on most setups; an already-open shell needs `export PATH="$HOME/.local/bin:$PATH"` (Unix) or `$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"` (PowerShell) once.
- Homebrew and winget install into their own prefixes that are already on PATH.

## Upgrade to latest

```bash
uv self update
```

`uv self update` only works for official-installer binaries; Homebrew/winget installs upgrade through their package manager (`brew upgrade uv` / `winget upgrade astral-sh.uv`). The setup scripts handle this automatically.

## Verify

```bash
uv --version
```

## Offline / air-gapped

Download the matching archive from the uv GitHub releases page, extract it, and put the `uv` binary anywhere on PATH. `uv run --with <pkg>` still needs network for first-time package resolution unless a mirror is configured via `UV_INDEX_URL`.
