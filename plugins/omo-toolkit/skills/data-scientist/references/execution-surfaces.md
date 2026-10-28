# Execution surfaces

> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

## Native eval first

Read `xd://eval/helpers` before the first package-provisioning operation. Import only what is actually available; missing DuckDB/NumPy/matplotlib/Polars/Arrow is not evidence that a global install is needed. Native Python managed provisioning targets its actual interpreter; native managed JS uses its own scoped environment. JS provisioning disables lifecycle scripts: native bindings may need explicit preparation, so a DuckDB Python uv environment is often simpler. No install belongs in the copied skill tree.

Reuse one persistent connection/frame across cells:

```python
import duckdb
con = duckdb.connect()
rows = con.sql("SELECT category, sum(amount) FROM 'data.csv' GROUP BY category").fetchall()
print(rows)
```

For Arrow transfer with the relevant packages installed, `relation.pl()` yields Polars, while `con.register("t", frame)` goes back to DuckDB. `.df()` requires pandas; preserve existing pandas workflows when that is the project contract, rather than migrating them for a preference. Printing a figure in native Python eval attaches it; also save a PNG at a real output path.

## Explicit external caches

Resolve `<skill-dir>` from the physical base directory supplied by the host, independent of the current project cwd. The following helpers provision only when explicitly invoked; network access is possible on first use.

```bash
bash <skill-dir>/scripts/ensure-js-deps.sh
bash <skill-dir>/scripts/ensure-py-deps.sh <actual-python-executable>
```

The JS helper prints an absolute `@duckdb/node-api` entry path. Dynamic-import it in Bun, create one `DuckDBInstance`, connect once, then reuse:

```js
const { DuckDBInstance } = await import("<printed absolute path>");
const db = await DuckDBInstance.create(":memory:");
const conn = await db.connect();
const rows = await conn.runAndReadAll("SELECT count(*) AS n FROM 'data.csv'");
print(rows.getRowObjects());
```

COUNT/SUM integer values can be BigInt: stringify deliberately, not via a failing plain JSON.stringify. The Python helper accepts `sys.executable`, installs Polars/Arrow with uv `--target` into an interpreter-version-keyed user cache, and prints the directory to insert into `sys.path`. It does not modify the interpreter. It does not install DuckDB, NumPy or matplotlib: provision those explicitly if needed. `OMP_DATA_SCIENTIST_CACHE` overrides the external cache root; never use the plugin tree or system interpreter directories.

## Isolated one-shot

```bash
uv run --with duckdb --with polars --with pyarrow --with numpy python <analysis.py>
uv run <skill-dir>/scripts/quick-query.py data.csv 'SELECT count(*) FROM data;'
```

Include exactly the packages imported (Arrow for `.pl()`). Helper PEP 723 metadata declares its own requirements. Cache reuse avoids downloads on a warm offline environment, but first resolution needs the configured registry. Keep a bounded query result; quick-query materializes its output, and describe/filter eagerly load the whole input. Larger-than-RAM work uses direct DuckDB queries/spill or eligible Polars lazy streaming instead (`placement.md`, `polars-lane.md`).

Use a one-shot for crash-prone/memory-heavy work or when no eval is exposed. Batch related questions in one process instead of spawning repeatedly. Do not claim package availability, latency, row counts or timing until observed.
