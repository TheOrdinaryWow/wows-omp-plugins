from __future__ import annotations

# Modified-port notice and license: OMP session directory and child linkage adaptation
# of oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e.
# Sustainable Use License 1.0 (../../../../LICENSE-SUL-1.0): internal business and
# personal/noncommercial use; free distribution for noncommercial purposes.

from dataclasses import replace
from pathlib import Path

from .jsonio import iter_jsonl
from .transcript import env_path, existing, jsonl_parallel, recent, stem_id
from .types import Session

SENPI_CONFIG_DIRS = (".omo", ".senpi", ".pi")
OH_MY_PI_CONFIG_DIRS = (".omp",)
GAJAE_CODE_CONFIG_DIRS = (".gjc",)

__all__ = ["scan_gajae_code", "scan_oh_my_pi", "scan_senpi"]


def scan_senpi(extra_roots: tuple[Path, ...], workers: int) -> list[Session]:
    return _scan_pi_family("senpi", SENPI_CONFIG_DIRS, "senpi", extra_roots, workers)


def scan_oh_my_pi(extra_roots: tuple[Path, ...], workers: int) -> list[Session]:
    roots = _pi_family_roots(OH_MY_PI_CONFIG_DIRS, "omp", extra_roots)
    return scan_omp_session_dirs(tuple(root / "sessions" for root in roots), workers)


def scan_gajae_code(extra_roots: tuple[Path, ...], workers: int) -> list[Session]:
    return _scan_pi_family("gajae-code", GAJAE_CODE_CONFIG_DIRS, "gjc", extra_roots, workers)


def _scan_pi_family(platform: str, config_dirs: tuple[str, ...], xdg_app: str, extra_roots: tuple[Path, ...], workers: int) -> list[Session]:
    roots = _pi_family_roots(config_dirs, xdg_app, extra_roots)
    paths = [path for root in roots for path in (root / "sessions").rglob("*.jsonl")]
    return jsonl_parallel(recent(paths), workers, platform, lambda path: stem_id(path, "_"))


def scan_omp_session_dirs(directories: tuple[Path, ...], workers: int) -> list[Session]:
    """Explicit native session directories: no home discovery or product CLI calls."""
    paths = sorted({path.resolve() for root in directories for path in root.rglob("*.jsonl")})
    # Artifact directories contain other JSONL logs. Only a real header is a session;
    # the current physical title slot may precede it.
    valid: list[Path] = []
    for path in recent(paths):
        rows = iter_jsonl(path)
        first = next(rows, {})
        header = next(rows, {}) if first.get("type") == "title" else first
        if header.get("type") == "session":
            valid.append(path)
        rows.close()
    sessions = jsonl_parallel(valid, workers, "oh-my-pi", lambda path: stem_id(path, "_"))
    by_id = {item.id: item for item in sessions}
    by_path = {str(Path(item.path).resolve()): item for item in sessions}
    linked: list[Session] = []
    for item in sessions:
        reference = item.parent_reference
        parent = by_id.get(reference or "") or by_path.get(reference or "")
        # parentSession also describes forks. Only artifact-contained sessions are
        # subagents; never guess a parent from a filename/dot-qualified id prefix.
        if parent and Path(item.path).is_relative_to(Path(parent.path).with_suffix("")):
            item = replace(item, parent_id=parent.id)
        linked.append(item)
    return linked


def _pi_family_roots(config_dirs: tuple[str, ...], xdg_app: str, extra_roots: tuple[Path, ...]) -> list[Path]:
    home = Path.home()
    roots: list[Path] = []
    for config_dir in config_dirs:
        base = home / config_dir
        roots.append(base / "agent")
        roots.extend(sorted(base.glob("profiles/*/agent")))
    xdg_data = env_path("XDG_DATA_HOME")
    if xdg_data is not None:
        app_root = xdg_data / xdg_app
        roots.append(app_root)
        roots.extend(sorted(app_root.glob("profiles/*")))
    roots.extend(extra_roots)
    return existing(roots)
