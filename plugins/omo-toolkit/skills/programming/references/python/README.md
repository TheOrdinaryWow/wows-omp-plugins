> **Modified-port notice and license.** This file is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

> **OMP scope.** Repository-first scope: these are optional recipes, not installation-wide rules. Existing repository contracts, language/toolchain versions, standard libraries and dependencies win. Do not migrate stacks, add dependencies, brand every primitive, run checks outside the assignment, or refactor automatically. Size and argument-count metrics are not gates. Run only explicitly requested/authorized checks. Provision packages only in the requested project, a temporary environment, or an explicit user cache; machine-wide installs/upgrades require separate consent.


# Python Programmer

Modern Python. Type-strict, stack-first, async-correct.

## Philosophy

The type checker is your compiler. Make illegal states unrepresentable. Parse at boundaries. Own resources explicitly. Every function has a contract; the type system enforces it.

## Optional modern recipes

These examples are project choices, not skill-wide obligations. Preserve existing tooling and libraries; adopt a new stack only for a concrete requirement or an explicitly requested project.

### Tooling

| Category | Example recipe | Existing alternatives to preserve |
|---|---|---|
| Package manager | `uv` | pip, poetry, conda, pipenv |
| Type checker | `basedpyright` (`typeCheckingMode = "all"`) | pyright, mypy |
| Linter + formatter | `ruff` (`select = ["ALL"]`) | flake8, black, isort, autopep8 |
| Async runtime | `anyio` | `import asyncio` |
| Data | `polars` + `duckdb` + `numpy` | pandas |
| Web framework | FastAPI + Pydantic v2 | Flask, Django REST |
| ORM | SQLAlchemy 2.x async | Django ORM, Tortoise |
| HTTP client | [`httpx2`](https://github.com/pydantic/httpx2) | requests, aiohttp, httpx |
| Testing | `pytest` | unittest |
| CLI | `typer` + `rich` | argparse, click, fire |

### Design questions

1. **Frozen by default** — `@dataclass(frozen=True, slots=True)`. Pydantic: `model_config = ConfigDict(frozen=True)`. Mutable only when mutation is the documented purpose.
2. **NewType for distinct IDs** — `UserId = NewType("UserId", int)`. Never pass raw `int` where a branded type exists.
3. **Exhaustive variants** — prefer `match` plus `assert_never` when it helps the type checker prove coverage. Existing clear `isinstance`/`if` narrowing is valid; do not rewrite it merely to enforce a syntax preference.
4. **Protocol over ABC** — `typing.Protocol` for interfaces. ABC only when you need shared method implementation.
5. **No raw dicts in signatures** — params and returns use `TypedDict`, `dataclass`, or Pydantic model. Internal scratch dicts are fine.
6. **Parse, don't validate** — constructors produce typed objects or raise. Never pass unvalidated data deeper into the call stack.
7. **Typed errors** — error types are dataclasses or exceptions with typed fields. Never `raise ValueError("something")` with a bare string. Use union returns when the caller is within 1-2 call levels and must handle the outcome (repository → service). Use exceptions when the error should propagate up many layers to a boundary handler (service → HTTP handler).
8. **Final for constants** — module-level constants use `Final`. Mutable module globals are a code smell.
9. **Explicit None** — annotate `-> X | None`. Never return `None` from a function whose signature omits it.
10. **Context managers for resources** — files, DB connections, HTTP clients, locks. No manual `.close()`.
11. **No Any, no object** — both are banned as type annotations. `object` erases all structural information (zero callable attributes, zero narrowing). Use `Protocol` (structural typing), `TypeVar` (generic pass-through), explicit union (known variants), or `TypedDict` (dict shapes).
12. **No cast** — `cast()` is banned. Redesign the types.
13. **No type: ignore** — fix the type error. The checker is right; you are wrong.
14. **No broad except** — `except Exception` and `except BaseException` are banned. Catch the **specific** exception you expect. A broad catch swallows bugs you need to see — `KeyError`, `AttributeError`, `TypeError` all vanish silently. If you genuinely need a catch-all at a top-level boundary (CLI entry, HTTP handler), use `# noqa: BROAD_EXCEPT_OK` and log + re-raise.

### Typing and safety

- `basedpyright` in `typeCheckingMode = "all"`. Every public function has full annotations. Internal helpers: annotate return type; parameter types may be inferred.
- `ruff` with `select = ["ALL"]`. Override specific rules per project in `pyproject.toml`, never globally disable the strict baseline.
- Every new function must have a `docstring` unless its name + signature makes it completely obvious (e.g. `def full_name(first: str, last: str) -> str:`).
- Use `X | Y` union syntax (PEP 604), never `Union[X, Y]` or `Optional[X]`.

### Why `object` is banned

`object` pretends to be safe ("it's the top type!") but gives **zero** narrowing and **zero** attributes. Even `Any` is more honest — it admits the boundary is untyped.

```python
# BANNED
def process(data: object) -> object: ...
def store(items: list[object]) -> None: ...
results: dict[str, object] = {}

# GOOD — Protocol for structural typing
class Serializable(Protocol):
    def serialize(self) -> bytes: ...
def process(data: Serializable) -> ProcessResult: ...

# GOOD — TypeVar for generic pass-through
def identity[T](x: T) -> T: ...
def first[T](items: Sequence[T]) -> T: ...

# GOOD — explicit union for known variants
def parse(raw: str | bytes) -> Document: ...
```

### Why `if/elif` on variants is banned

`if/elif/else` chains on type, enum, or literal values lose compile-time exhaustiveness. When a new variant is added, nothing warns you. `match/case` + `assert_never` does.

```python
# BANNED — if/elif for type discrimination
if isinstance(event, Click):
    handle_click(event.x, event.y)
elif isinstance(event, Scroll):
    handle_scroll(event.delta)
else:
    raise ValueError(f"Unknown: {event}")  # runtime bomb

# BANNED — if/elif for enum discrimination
if status == Status.PENDING:
    start_review()
elif status == Status.ACTIVE:
    continue_processing()
elif status == Status.CLOSED:
    archive()

# BANNED — non-exhaustive match (swallows new variants)
match event:
    case Click(x, y): handle_click(x, y)
    case _: pass

# GOOD — exhaustive match with assert_never
match event:
    case Click(x=x, y=y):
        handle_click(x, y)
    case Scroll(delta=delta):
        handle_scroll(delta)
    case unreachable:
        assert_never(unreachable)

# GOOD — enum match
match status:
    case Status.PENDING: start_review()
    case Status.ACTIVE:  continue_processing()
    case Status.CLOSED:  archive()
    case unreachable:    assert_never(unreachable)
```

`if/else` is fine for boolean conditions and range checks — things that aren't variant discrimination:

```python
# FINE — boolean, not variant
if age >= 18:
    grant_access()
else:
    deny_access()
```

### Why broad `except` is banned

`except Exception` catches **every** non-system exception — `KeyError`, `TypeError`, `AttributeError`, `ValueError` all vanish. You lose the stack trace that would have told you exactly what went wrong. The fix is always to name the exception you expect.

```python
# BANNED — swallows bugs
try:
    result = api.fetch(url)
except Exception as e:
    logger.error(e)
    return None

# BANNED — catch-and-ignore
try:
    parse(data)
except Exception:
    pass

# GOOD — catch what you expect
try:
    result = api.fetch(url)
except httpx.HTTPStatusError as e:
    logger.error("API %d: %s", e.response.status_code, e.request.url)
    return None
except httpx.ConnectError:
    raise ServiceUnavailableError(service="api") from None

# GOOD — top-level boundary (only place broad catch is acceptable)
def main() -> int:  # noqa: BROAD_EXCEPT_OK
    try:
        return run()
    except Exception:
        logger.exception("unhandled error")
        return 1
```

### Async

- Own every background task's cancellation and shutdown. Preserve the existing asyncio/AnyIO runtime rather than introducing a second one.
- For a project that chooses AnyIO, `create_task_group` and `CapacityLimiter` provide structured task/concurrency management; see `async-anyio.md` for those patterns.

### Data modeling — which container, when

All model fields carry type annotations. No `Any`, no untyped dicts in public APIs.
Use `polars` + `duckdb` for data. pandas is never the right answer in this stack.

| Situation | Use |
|---|---|
| User input, API request/response | `Pydantic BaseModel (frozen=True)` |
| Internal value object (no I/O) | `@dataclass(frozen=True, slots=True)` |
| Function with multiple outcomes | Union of frozen dataclasses + `match` |
| Dict shape for JSON compat / `**kwargs` | `TypedDict` |
| Fixed constants | `StrEnum` / `IntEnum` |
| Distinct primitive (UserId vs MovieId) | `NewType` |
| Contract / capability | `Protocol` |
| Contract + shared implementation | `ABC` |
| ORM model (SQLAlchemy) | `Mapped[]` — inherently mutable, `# noqa: MUTABLE_OK` |
| Config from env vars | `pydantic-settings BaseSettings` |

**The one rule**: data crosses trust boundary → Pydantic. Everything else → dataclass.

Load `data-modeling.md` for the full decision flowchart and comparison matrix.

### When frozen=True does not apply

- **ORM models** — SQLAlchemy `Mapped[]` requires mutation. Use `# noqa: MUTABLE_OK`.
- **Builder / accumulator** — object exists to be mutated (counter, buffer, state machine). Docstring must explain why.
- **Pydantic Settings** — tests override fields. Mutable is acceptable.

If you need `# noqa: MUTABLE_OK`, the class docstring must say why mutation is required.

### Libraries

Canonical defaults (override only if `pyproject.toml` explicitly picks something else):

| Domain | Library | Reason |
|---|---|---|
| CLI | `typer` | Type-annotated CLI from function sigs |
| Pretty output | `rich` | Tables, progress, tracebacks, markdown |
| HTTP client | [`httpx2`](https://github.com/pydantic/httpx2) | Next-gen HTTP client (Pydantic stewardship), HTTP/2, brotli+zstd. Always `httpx2[http2,brotli,zstd]`. See `httpx2-optimization.md` |
| Validation | `pydantic` v2 | Fast native validator, JSON Schema |
| Web API | `fastapi` | Async, Pydantic-native, OpenAPI |
| ORM | `sqlalchemy` 2.x async | `Mapped[]` types, async sessions |
| DB driver (Postgres) | `asyncpg` (via SQLAlchemy) | Fastest PG driver |
| AI agents | `pydantic-ai` | Typed deps, structured output |
| TUI | `textual` | Rich-based, CSS layout, widgets |
| Logging | `rich.logging.RichHandler` | Pretty; swap to `structlog` in prod |

## pyproject.toml — the one true config

Scaffold a new project with all strict defaults pre-configured:

```bash
uv run ../../scripts/python/new-project.py myproject
uv run ../../scripts/python/new-project.py myproject --path ./workspace
uv run ../../scripts/python/new-project.py myproject --lib   # publishable library
```

Creates via `uv init`, then injects basedpyright `typeCheckingMode = "all"` + ruff `select = ["ALL"]` + pytest strict. Cross-platform (macOS, Linux, Windows).

For manual setup: `uv init --app myproject`, then load `pyproject-strict.md`.

## PEP 723 — inline script metadata (mandatory for ALL scripts)

Every `.py` script — even throwaway — MUST use PEP 723 inline metadata with the `# ─── How to run ───` comment block. No venv, no `requirements.txt`. The script IS the environment spec. A script without the usage comment block is incomplete.

Scaffold with: `uv run ../../scripts/python/new-script.py <name> --deps "httpx2[http2,brotli,zstd]"` (writes to temp dir by default, `--output` for specific path).

Load `one-liners.md` for full patterns, examples, and anti-patterns.

## Reference loading

Load on demand — not all at once.

| Need | Load |
|---|---|
| Full pyproject.toml config | `pyproject-strict.md` |
| Type patterns (NewType, Final, enums, narrowing) | `type-patterns.md` |
| Data modeling (container choice, frozen, parse-don't-validate) | `data-modeling.md` |
| Error handling (typed errors, union returns, exhaustive match) | `error-handling.md` |
| Async patterns (anyio) | `async-anyio.md` |
| Data processing (polars / duckdb) | `data-processing.md` |
| FastAPI + SQLAlchemy stack | `fastapi-stack.md` |
| Library decision tree | `libraries.md` |
| httpx2 optimization (only for a chosen httpx2 stack) | `httpx2-optimization.md` |
| **orjson** (when JSON is in the hot path; FastAPI/Pydantic v2 integration) | `orjson-stack.md` |
| One-liner scripts (PEP 723) | `one-liners.md` |
| PydanticAI agents | `pydantic-ai.md` |
| Textual TUI | `textual-tui.md` |

## Optional httpx2 stack

Keep the repository's current HTTP client. For an explicitly chosen httpx2 project, inspect `httpx2-optimization.md` for timeout, pooling and compression recipes. Tune those values to the workload; retries, HTTP/2, proxy behavior and extra dependencies are not automatic obligations. Do not copy a factory verbatim without checking the installed version and existing error/retry policy.

## No-excuse audit

Optional policy findings are reported by `../../scripts/python/check-no-excuse-rules.py`; run only when the project/user adopts this policy, not after every edit.

| Rule ID | Catches | Opt-out |
|---|---|---|
| `cast-any` | `cast(Any, ...)` | None — redesign types |
| `type-ignore` | `# type: ignore` | None — fix the type |
| `pyright-ignore` | `# pyright: ignore` | None — fix the type |
| `bare-except` | `except:` with no class | None — name the exception |
| `silent-except` | `except X: pass` / `except X: ...` | None — handle or re-raise |
| `no-asyncio` | `import asyncio` | `# noqa: ANYIO_OK` |
| `no-pandas` | `import pandas` | `# noqa: PANDAS_OK` |
| `mutable-dataclass` | `@dataclass` without `frozen=True` | `# noqa: MUTABLE_OK` |
| `missing-slots` | `@dataclass` without `slots=True` | `# noqa: SLOTS_OK` |
| `raw-dict-return` | `-> dict` in function return type | `# noqa: DICT_OK` |
| `missing-assert-never` | `match` block without `assert_never` default | `# noqa: MATCH_OK` |
| `generic-exception` | `raise ValueError("...")` / `raise TypeError("...")` with bare string | `# noqa: GENERIC_ERR_OK` |
| `no-object` | `object` used as type annotation (param, return, generic arg) | `# noqa: OBJECT_OK` |
| `if-elif-on-variant` | `if isinstance()`/`if x == Enum.V` chain that should be `match/case` | `# noqa: IF_VARIANT_OK` |
| `broad-except` | `except Exception` / `except BaseException` (too broad) | `# noqa: BROAD_EXCEPT_OK` |

Fix every violation before declaring work done. basedpyright + ruff strict config catches the rest.

## In tests

Tests are strict too, with these exceptions (already configured in `pyproject.toml` per-file-ignores):

| In tests you may | Why |
|---|---|
| Use `assert` | That's how pytest works (`S101` ignored) |
| Use magic numbers | Test data (`PLR2004` ignored) |
| Access `_private` members | Testing internals (`SLF001` ignored) |
| Skip docstrings | Test names are the docs (`D` ignored) |
| Have unused function args | Fixtures (`ARG` ignored) |

Tests still follow the iron list — frozen dataclasses, typed errors, exhaustive match. If test fixtures need mutable state, use `# noqa: MUTABLE_OK` on the fixture class.

## Existing codebases

When editing an existing file that doesn't follow these rules: **write new code in strict style, don't refactor existing code in the same change.** Mixing feature work with style migration makes reviews harder and bugs likelier.

## Activation

This skill activates whenever you are writing or modifying any `.py` file. Even one-off scripts get the strict treatment — that is the whole point of PEP 723 + uv: production hygiene with throwaway ergonomics.
