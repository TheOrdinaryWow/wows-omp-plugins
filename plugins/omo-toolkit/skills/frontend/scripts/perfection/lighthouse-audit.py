#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "playwright",
#     "typer",
#     "rich",
# ]
# ///

# Modified OMP port of oh-my-openagent at 8a8db1d3094da8743989bf693ee5de77889de50e.
# Sustainable Use License 1.0: ../../../../LICENSE-SUL-1.0.
# Internal business and personal/noncommercial use; free noncommercial distribution.
# ─── How to run ───
# 1. uv, Node, local Chrome and project-resolvable lighthouse must be installed.
#    No tool or Node dependency is installed by this helper.
# 2. Chrome is launched with channel="chrome"; no browser download.
# 3. Run:
#      uv run lighthouse-audit.py https://example.com
#      uv run lighthouse-audit.py https://example.com --desktop-only
#      uv run lighthouse-audit.py https://example.com --threshold 95
# ──────────────────

"""Lighthouse audit via real Playwright Chrome.

Follows the frontend skill perfection ruleset:
  - NEVER use `lighthouse` CLI (uses headless-shell, not real Chrome)
  - Use Playwright with channel="chrome" (real Chrome stable)
  - Run lighthouse Node API via the Playwright CDP endpoint
  - Mobile preset (primary) + Desktop preset (secondary)
  - 100 in every category is the floor
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import typer
from rich import print as rprint
from rich.table import Table


# Resolve Lighthouse from the caller's project, not a temporary runner directory.
LIGHTHOUSE_RUNNER_JS = """\
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve(process.cwd(), 'package.json'));
const { default: lighthouse } = await import(pathToFileURL(require.resolve('lighthouse')).href);

const url = process.argv[1];
const port = parseInt(process.argv[2]);
const preset = process.argv[3]; // 'mobile' or 'desktop'

const config = {
  extends: 'lighthouse:default',
  settings: {
    formFactor: preset === 'desktop' ? 'desktop' : 'mobile',
    throttling: preset === 'desktop'
      ? { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 }
      : undefined,
    screenEmulation: preset === 'desktop'
      ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1 }
      : undefined,
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
  },
};

(async () => {
  const result = await lighthouse(url, { port, logLevel: 'error' }, config);
  const categories = result.lhr.categories;
  const output = {};
  for (const [key, cat] of Object.entries(categories)) {
    output[key] = Math.round(cat.score * 100);
  }
  console.log(JSON.stringify(output));
})();
"""


def _check_node_deps() -> bool:
    """Check the caller's Lighthouse installation without installing anything."""
    try:
        result = subprocess.run(
            ["node", "-e", "require.resolve('lighthouse')"],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return False
    return result.returncode == 0


def _run_lighthouse_via_cdp(url: str, cdp_port: int, preset: str) -> dict[str, int]:
    """Run the project-resolved ESM Lighthouse API against real Chrome's CDP."""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", LIGHTHOUSE_RUNNER_JS, url, str(cdp_port), preset],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        rprint(f"[red]Lighthouse failed:[/red] {result.stderr}")
        raise SystemExit(1)
    return json.loads(result.stdout.strip())


def _run_with_playwright(url: str, preset: str) -> dict[str, int]:
    """Launch real Chrome via Playwright, run Lighthouse against CDP."""
    from playwright.sync_api import sync_playwright

    # Chrome writes its selected CDP port to this public profile file. A fresh
    # temporary profile never reads or modifies the user's browser state.
    with tempfile.TemporaryDirectory(prefix="frontend-lighthouse-") as profile:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                profile,
                channel="chrome",
                headless=True,
                args=["--remote-debugging-port=0"],
            )
            try:
                port_file = Path(profile) / "DevToolsActivePort"
                cdp_port = int(port_file.read_text().splitlines()[0])
                return _run_lighthouse_via_cdp(url, cdp_port, preset)
            finally:
                context.close()


def _print_scores(scores: dict[str, int], preset: str, threshold: int) -> bool:
    """Print scores as a rich table. Returns True if all pass."""
    table = Table(title=f"Lighthouse — {preset}")
    table.add_column("Category")
    table.add_column("Score", justify="right")
    table.add_column("Status")

    all_pass = True
    for category, score in scores.items():
        status = "[green]✓ PASS[/green]" if score >= threshold else "[red]✗ FAIL[/red]"
        if score < threshold:
            all_pass = False
        color = "green" if score >= threshold else "red"
        table.add_row(category, f"[{color}]{score}[/{color}]", status)

    rprint(table)
    return all_pass


def main(
    url: str = typer.Argument(help="URL to audit"),
    threshold: int = typer.Option(100, "--threshold", "-t", help="Minimum passing score"),
    desktop_only: bool = typer.Option(False, "--desktop-only", help="Skip mobile audit"),
    mobile_only: bool = typer.Option(False, "--mobile-only", help="Skip desktop audit"),
) -> None:
    """Run Lighthouse audit via real Playwright Chrome."""
    if not _check_node_deps():
        print(
            "Missing audit prerequisite: Node and a project-resolvable lighthouse package are required. "
            "With project-owner approval, run `npm install --save-dev lighthouse` in the target project, "
            "then rerun this helper from that project. No global installation was attempted.",
            file=sys.stderr,
        )
        raise SystemExit(2)

    all_pass = True

    if not desktop_only:
        rprint(f"\n[bold]Auditing (mobile):[/bold] {url}")
        mobile_scores = _run_with_playwright(url, "mobile")
        if not _print_scores(mobile_scores, "Mobile", threshold):
            all_pass = False

    if not mobile_only:
        rprint(f"\n[bold]Auditing (desktop):[/bold] {url}")
        desktop_scores = _run_with_playwright(url, "desktop")
        if not _print_scores(desktop_scores, "Desktop", threshold):
            all_pass = False

    if all_pass:
        rprint("\n[green bold]✓ All categories passed![/green bold]")
    else:
        rprint(f"\n[red bold]✗ Some categories below {threshold}. Not done yet.[/red bold]")
        raise SystemExit(1)


if __name__ == "__main__":
    typer.run(main)
