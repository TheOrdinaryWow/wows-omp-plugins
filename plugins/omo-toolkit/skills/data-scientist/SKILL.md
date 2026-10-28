---
name: data-scientist
description: "Use for CSV/Parquet/JSON/NDJSON analysis, SQL joins/grouping/aggregation, DataFrame transforms, larger-than-RAM processing, numerical work or query-backed plots. Chooses DuckDB, Polars, NumPy and plotting engines with native persistent eval first."
---

> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Data scientist

Answer the question through the cheapest engine and execution surface that can prove it. Existing project/user choices win: do not migrate a pandas pipeline or add dependencies merely to enforce this skill's DuckDB/Polars preference.

## Persistent eval first

Read `references/execution-surfaces.md` before the first query. Native `eval` keeps connections, arrays and frames across cells; import/connect/load once, then reuse. Do not assume any package is resident. Read `xd://eval/helpers` before native managed provisioning; provision only the packages needed, in its managed environment. Otherwise use an explicitly invoked isolated `uv run --with ...` process or the scoped cache helpers below. Heavy/crash-prone work can use uv rather than risk the live kernel.

Resolve helper paths from the host-provided physical skill directory. Scripts are not extension imports or automatic install hooks. Never write into the copied skill/plugin tree, mutate system Python, or install/upgrade a global tool on skill load. First package use may access a registry/network. `setup-uv.sh` and `.ps1` are manual consent-only toolchain utilities, not a fallback to run silently.

## Choose the engine

| Shape | Engine | Boundary |
| --- | --- | --- |
| SQL joins, windows, aggregation, file/remote queries | DuckDB | query files in place; set memory/spill limits before heavy work |
| expression-chain transforms, reshapes, lazy pipelines | Polars | use lazy scans and `collect(engine="streaming")` for eligible larger-than-RAM plans; inspect blocking operators |
| statistics, linear algebra, FFT, sampling | NumPy | bound arrays/samples to memory; do not turn a full huge table into an ndarray |
| static chart | matplotlib (or existing project chart engine) | aggregate first, save an image, inspect labels/units/fonts and the actual finding |

Read `references/polars-lane.md` for current Polars/Arrow patterns and `references/visualization.md` before charting. Benchmark actual shape/hardware when engine choice matters; pinned performance folklore is not evidence.

## Place the computation before loading

Probe file size, available RAM and, when needed, a direct row count. Read `references/placement.md` for recipes.

- Repeated questions and a bounded working set (roughly under a quarter of free RAM): load a table/frame once, then reuse.
- Single-pass or larger-than-RAM: direct DuckDB scans with a deliberate `memory_limit` and spill directory, or lazy Polars streaming where the plan supports it. Leave space for outputs and intermediates; joins/sorts/materialization can still exhaust memory/disk.
- Remote Parquet/CSV: push projection/filter/aggregation toward the data. Remote reads can download DuckDB extensions and access the network; honor data permissions and keep credentials out of reports. When execution near the data exists, send the query and bring back a small result instead of copying the entire dataset.

Do not promise that streaming makes every operation out-of-core. Never eagerly load a larger-than-RAM dataset, and do not use quick-query's eager `--filter`/`--describe` as the large-data route. SQL quick-query also materializes its **result** for display: aggregate/limit it.

## One-shot helper

`quick-query.py` supports CSV, Parquet, JSON and NDJSON/JSONL. SQL exposes the input as `data`, `df`, and the quoted file stem. Use the following isolated invocation (the helper also carries PEP 723 metadata):

```bash
uv run --with duckdb --with polars --with numpy --with pyarrow --with typer --with rich <skill-dir>/scripts/quick-query.py /tmp/sales.csv 'SELECT category, sum(amount) AS total FROM data GROUP BY category ORDER BY category'
uv run <skill-dir>/scripts/quick-query.py /tmp/sales.csv --filter 'amount > 100'
uv run <skill-dir>/scripts/quick-query.py /tmp/sales.csv --describe
```

Describe/filter eagerly read fitting datasets. Unsupported formats and missing paths fail nonzero; Excel must be exported to CSV/Parquet first. SQL is an explicitly supplied DuckDB query, not a sandbox: do not run untrusted SQL or embed secrets. Choose the engine's direct filename reader when querying another file is intended.

For standalone resident kernels, `scripts/ensure-py-deps.sh <sys.executable>` installs Polars/Arrow under a version-keyed user cache and prints its import directory; `scripts/ensure-js-deps.sh` installs `@duckdb/node-api` into a separate user cache and prints its import path. `OMP_DATA_SCIENTIST_CACHE` can select an explicit external cache; never point it at the skill, project dependencies, or a system prefix. No foreign cache is migrated or deleted.

## Deliver evidence, then stop

Answer the question; include source/query/filter provenance, meaningful row counts and elapsed time for heavy work. Explain null/type/aggregation choices that change the answer. No bonus charts or unrelated exploration. A chart uses a named aggregation, labeled units and the user's actual script/font needs; save it to a real artifact, display it with native printed-image output, inspect it, and use `skill://visual-qa` when visual acceptance is required.

References: `execution-surfaces.md`, `placement.md`, `polars-lane.md`, `visualization.md`, `uv-setup.md` under `references/`.
