import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runTool } from "../plugins/omo-toolkit/skills/programming/scripts/shared/run-tool.ts";

const root = mkdtempSync(join(tmpdir(), "toolkit-development-skills-"));
const skills = resolve(import.meta.dir, "../plugins/omo-toolkit/skills");
const copiedPlugin = join(root, "copied plugin with spaces");
const programming = join(copiedPlugin, "skills/programming");
cpSync(join(skills, "programming"), programming, { recursive: true });
const uv = Bun.which("uv");
const cargo = Bun.which("cargo");
const go = Bun.which("go");
const isolatedEnv = { ...process.env, UV_PYTHON_DOWNLOADS: "never", RUSTUP_AUTO_INSTALL: "0", NO_COLOR: "1", POLARS_MAX_THREADS: "2" };

async function run(args: string[], cwd = root, env: NodeJS.ProcessEnv = isolatedEnv) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

const packages = ["duckdb", "polars", "numpy", "pyarrow", "typer", "rich"];
const withPackages = packages.flatMap((name) => ["--with", name]);
const queryReady = uv
  ? await run([uv, "run", "--offline", ...withPackages, "python", "-c", "import duckdb, polars, numpy, pyarrow, typer, rich"])
  : undefined;
const dataAvailable = queryReady?.code === 0;
if (!dataAvailable)
  console.warn(
    `SKIP data helper integration: ${uv ? `offline Python package cache unavailable: ${queryReady?.stderr.trim()}` : "uv is not installed"}`,
  );
const cargoReady = cargo ? await run([cargo, "--version"]) : undefined;
const scaffoldAvailable = cargoReady?.code === 0;
if (!scaffoldAvailable)
  console.warn("SKIP Rust generator integration: installed Cargo toolchain unavailable (automatic downloads disabled)");

afterAll(() => {
  const copiedTree = join(root, "read only skill with spaces");
  if (existsSync(copiedTree)) chmodSync(copiedTree, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("development skill executable boundaries", () => {
  test("TypeScript scaffold copies its complete plugin closure and refuses to overwrite a target", async () => {
    const script = join(programming, "scripts/typescript/new-project.ts");
    const created = await run([process.execPath, script, "typed-demo", "--path", root], copiedPlugin);
    expect(created.code).toBe(0);
    const project = join(root, "typed-demo");
    const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    expect(pkg.devDependencies.typescript).toBe("^5.8.0");
    const config = JSON.parse(readFileSync(join(project, ".oxlintrc.json"), "utf8"));
    for (const plugin of config.jsPlugins) expect(existsSync(join(project, plugin.specifier))).toBe(true);
    for (const asset of [
      ".oxfmtrc.json",
      "tsconfig.json",
      "lint/oxlint-plugin/LICENSE",
      "lint/oxlint-plugin/no-em-dash-copy.js",
      "lint/oxlint-plugin/require-suppression-reason.js",
    ]) {
      expect(existsSync(join(project, asset))).toBe(true);
    }
    const marker = join(project, "src/index.ts");
    writeFileSync(marker, "export const keep = 42;\n");
    expect((await run([process.execPath, script, "typed-demo", "--path", root])).code).toBe(1);
    expect(readFileSync(marker, "utf8")).toBe("export const keep = 42;\n");
    expect(existsSync(join(project, "node_modules"))).toBe(false);
  });

  test.skipIf(!dataAvailable)(
    "quick-query handles file formats, quoted paths, SQL aliases and eager filter/describe",
    async () => {
      const tree = join(root, "read only skill with spaces");
      cpSync(join(skills, "data-scientist"), tree, { recursive: true });
      chmodSync(tree, 0o555);
      const script = join(tree, "scripts/quick-query.py");
      const csv = join(root, "sales' fixture.csv");
      writeFileSync(csv, "category,amount\na,10\nb,5\na,20\n");
      const formats = await run([
        uv ?? "uv",
        "run",
        "--offline",
        ...withPackages,
        "python",
        "-c",
        "import polars as p,sys; from pathlib import Path; d=p.read_csv(sys.argv[1]); r=Path(sys.argv[2]); d.write_parquet(r/'sales.parquet'); d.write_json(r/'sales.json'); d.write_ndjson(r/'sales.ndjson')",
        csv,
        root,
      ]);
      expect(formats.code).toBe(0);
      for (const file of [csv, join(root, "sales.parquet"), join(root, "sales.json"), join(root, "sales.ndjson")]) {
        const result = await run([
          uv ?? "uv",
          "run",
          "--offline",
          ...withPackages,
          script,
          file,
          "SELECT category, sum(amount) AS total FrOm data GROUP BY category ORDER BY category;",
        ]);
        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/a\s*│\s*30/);
        expect(result.stdout).toMatch(/b\s*│\s*5/);
      }
      const literal = await run([
        uv ?? "uv",
        "run",
        "--offline",
        ...withPackages,
        script,
        csv,
        "SELECT 'FROM data ' AS label, count(*) AS n FROM df;",
      ]);
      expect(literal.code).toBe(0);
      expect(literal.stdout).toContain("FROM data");
      const filtered = await run([uv ?? "uv", "run", "--offline", ...withPackages, script, csv, "--filter", "amount > 10"]);
      expect(filtered.code).toBe(0);
      expect(filtered.stdout).toContain("20");
      expect(filtered.stdout).toContain("1 rows");
      const described = await run([uv ?? "uv", "run", "--offline", ...withPackages, script, csv, "--describe"]);
      expect(described.code).toBe(0);
      expect(described.stdout).toContain("3 rows");
      expect((await run([uv ?? "uv", "run", "--offline", ...withPackages, script, join(root, "missing.csv")])).code).not.toBe(0);
      expect((await run([uv ?? "uv", "run", "--offline", ...withPackages, script, csv, "SELECT missing FROM data"])).code).not.toBe(0);
      chmodSync(tree, 0o755);
    },
    60_000,
  );

  test("cache provisioners pass explicit external targets without global flags", async () => {
    const bin = join(root, "stub-bin");
    const cache = join(root, "external cache");
    mkdirSync(bin);
    const log = join(root, "provision.log");
    writeFileSync(
      join(bin, "uv"),
      '#!/bin/bash\nprintf "%s\\n" "$@" > "$PROVISION_LOG"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--target" ]; then shift; mkdir -p "$1/polars" "$1/pyarrow"; fi; shift; done\n',
    );
    writeFileSync(
      join(bin, "bun"),
      '#!/bin/bash\nprintf "%s\\n" "$@" > "$PROVISION_LOG"\nmkdir -p node_modules/@duckdb/node-api/lib\nprintf "export {};\\n" > node_modules/@duckdb/node-api/lib/index.js\n',
    );
    chmodSync(join(bin, "uv"), 0o755);
    chmodSync(join(bin, "bun"), 0o755);
    const env = { ...isolatedEnv, PATH: `${bin}:${process.env.PATH}`, OMP_DATA_SCIENTIST_CACHE: cache, PROVISION_LOG: log };
    const py = await run(["bash", join(skills, "data-scientist/scripts/ensure-py-deps.sh"), Bun.which("python3") ?? "python3"], root, env);
    expect(py.code).toBe(0);
    expect(py.stdout.trim().startsWith(cache)).toBe(true);
    const args = readFileSync(log, "utf8").trim().split("\n");
    expect(args[args.indexOf("--target") + 1]).toBe(py.stdout.trim());
    expect(args).not.toContain("--system");
    const js = await run(["bash", join(skills, "data-scientist/scripts/ensure-js-deps.sh")], root, env);
    expect(js.code).toBe(0);
    expect(js.stdout.trim()).toBe(join(cache, "node_modules/@duckdb/node-api/lib/index.js"));
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["add", "@duckdb/node-api"]);
  });

  test.skipIf(!scaffoldAvailable)(
    "Rust generator uses the installed toolchain, builds offline and preserves existing directories",
    async () => {
      const script = join(programming, "scripts/rust/new-project.ts");
      const created = await run([process.execPath, script, "rust-demo", "--path", root], copiedPlugin);
      expect(created.code).toBe(0);
      const project = join(root, "rust-demo");
      expect(existsSync(join(project, "rust-toolchain.toml"))).toBe(false);
      const build = await run([cargo ?? "cargo", "check", "--offline"], project);
      expect(build.code).toBe(0);
      const marker = join(project, "src/main.rs");
      writeFileSync(marker, "// keep existing user code\n");
      expect((await run([process.execPath, script, "rust-demo", "--path", root], copiedPlugin)).code).toBe(1);
      expect(readFileSync(marker, "utf8")).toBe("// keep existing user code\n");
    },
    60_000,
  );

  test("optional TypeScript checker reports incompatible caller compiler without provisioning", async () => {
    const project = join(root, "incompatible-ts");
    mkdirSync(join(project, "node_modules/typescript"), { recursive: true });
    writeFileSync(join(project, "node_modules/typescript/index.js"), 'module.exports = {versionMajorMinor:"7.0"};\n');
    writeFileSync(join(project, "input.ts"), "export const value = 1;\n");
    const result = await run(
      [process.execPath, join(skills, "programming/scripts/typescript/check-no-excuse-rules.mjs"), "input.ts"],
      project,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("stable compiler API");
    expect(existsSync(join(project, "bun.lock"))).toBe(false);
  });
});

const compilerPath = process.env.TOOLKIT_SKILLS_TYPESCRIPT_MODULE;
if (!compilerPath)
  console.warn(
    "SKIP stable TypeScript checker fixture: set TOOLKIT_SKILLS_TYPESCRIPT_MODULE to an existing TypeScript >=5.8 stable package (no test downloads)",
  );
test.skipIf(!compilerPath)("optional checker uses caller stable compiler for clean, violating and invalid input", async () => {
  if (!compilerPath) throw new Error("Stable TypeScript fixture requires an explicit existing compiler package");
  const project = join(root, "stable-ts");
  mkdirSync(join(project, "node_modules"), { recursive: true });
  symlinkSync(resolve(compilerPath), join(project, "node_modules/typescript"), "dir");
  const script = join(skills, "programming/scripts/typescript/check-no-excuse-rules.mjs");
  writeFileSync(join(project, "clean.ts"), 'export const value = "// @ts-ignore";\n');
  expect((await run([process.execPath, script, "clean.ts"], project)).code).toBe(0);
  writeFileSync(join(project, "bad.ts"), "export let value: any = 1;\n");
  const bad = await run([process.execPath, script, "bad.ts"], project);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("no-any-annotation");
  expect((await run([process.execPath, script, "missing.ts"], project)).code).toBe(2);
});

function fixture(name: string) {
  return mkdtempSync(join(root, `${name}-`));
}

function executable(dir: string, name: string, source: string) {
  const file = join(dir, name);
  writeFileSync(file, `#!${process.execPath}\n${source}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("copied Bun scaffolders", () => {
  for (const language of ["python", "rust", "go", "typescript"]) {
    test(`${language} refuses existing targets before invoking tools or changing files`, async () => {
      const parent = fixture(`refuse-${language}`);
      const target = join(parent, "keep");
      const bin = join(parent, "bin");
      mkdirSync(target);
      mkdirSync(bin);
      const marker = join(target, "user-code");
      const log = join(parent, "unexpected-invocation");
      writeFileSync(marker, "preserved\n");
      for (const tool of ["uv", "cargo", "go"]) {
        executable(bin, tool, `require("node:fs").writeFileSync(${JSON.stringify(log)}, "invoked"); process.exit(90);`);
      }
      const result = await run(
        [process.execPath, join(programming, `scripts/${language}/new-project.ts`), "keep", "--path", parent],
        copiedPlugin,
        { ...isolatedEnv, PATH: bin },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("already exists");
      expect(readFileSync(marker, "utf8")).toBe("preserved\n");
      expect(existsSync(log)).toBe(false);
    });
  }

  test("Python declares valid dev configuration without running an install", async () => {
    const parent = fixture("python-declaration");
    const bin = join(parent, "bin");
    mkdirSync(bin);
    const log = join(parent, "commands.jsonl");
    executable(
      bin,
      "uv",
      `const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] !== "init") { console.error("unexpected package install"); process.exit(90); }
const dest = args.at(-1); fs.mkdirSync(dest, {recursive: true});
fs.writeFileSync(path.join(dest,"pyproject.toml"), '[project]\\nname = "demo"\\nversion = "0.1.0"\\n[dependency-groups]\\ndev = ["old-tool"]\\n[tool.fixture]\\nkeep = true\\n');`,
    );
    const result = await run(
      [process.execPath, join(programming, "scripts/python/new-project.ts"), "demo", "--path", parent],
      copiedPlugin,
      { ...isolatedEnv, PATH: bin },
    );
    expect(result.code).toBe(0);
    const target = join(parent, "demo");
    const config = Bun.TOML.parse(readFileSync(join(target, "pyproject.toml"), "utf8"));
    expect(config).toHaveProperty("dependency-groups.dev", ["basedpyright>=1.21", "ruff>=0.8", "pytest>=8", "pytest-cov>=5"]);
    expect(config).toMatchObject({ tool: { fixture: { keep: true }, basedpyright: { typeCheckingMode: "all" } } });
    expect(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)[0]),
    ).toEqual(["init"]);
    expect(existsSync(join(target, ".venv"))).toBe(false);
    expect(existsSync(join(target, "uv.lock"))).toBe(false);
  });

  for (const unavailable of [false, true]) {
    test(`Go reports ${unavailable ? "an unavailable executable" : "the actual initialization rejection"} without fabricating go.mod`, async () => {
      const parent = fixture("go-failure");
      const bin = join(parent, "bin");
      mkdirSync(bin);
      if (!unavailable) executable(bin, "go", 'console.error("module declaration rejected by installed go"); process.exit(23);');
      const result = await run(
        [process.execPath, join(programming, "scripts/go/new-project.ts"), "demo", "--path", parent, "--module", "example.com/demo"],
        copiedPlugin,
        { ...isolatedEnv, PATH: bin },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(unavailable ? "go could not be started" : "module declaration rejected by installed go");
      if (!unavailable) expect(result.stderr).toContain("exit 23");
      expect(existsSync(join(parent, "demo/go.mod"))).toBe(false);
      expect(existsSync(join(parent, "demo/cmd/server/main.go"))).toBe(false);
    });
  }

  test.skipIf(!go)("Go produces its templates with a real initialized module and does not fetch packages", async () => {
    const parent = fixture("go-generation");
    const result = await run(
      [process.execPath, join(programming, "scripts/go/new-project.ts"), "service", "--path", parent, "--module", "example.com/service"],
      copiedPlugin,
      { ...isolatedEnv, GOPROXY: "off", GOTOOLCHAIN: "local" },
    );
    expect(result.code).toBe(0);
    const target = join(parent, "service");
    expect((await run([go ?? "go", "list", "-m"], target, { ...isolatedEnv, GOPROXY: "off", GOTOOLCHAIN: "local" })).stdout.trim()).toBe(
      "example.com/service",
    );
    expect(existsSync(join(target, "cmd/server/main.go"))).toBe(true);
    expect(existsSync(join(target, ".github/workflows/ci.yml"))).toBe(true);
    expect(existsSync(join(target, "go.sum"))).toBe(false);
  });

  test("the Python script launcher writes executable metadata without provisioning and refuses its existing output", async () => {
    const parent = fixture("python-script");
    const target = join(parent, "script with spaces.py");
    const script = join(programming, "scripts/python/new-script.ts");
    const created = await run([process.execPath, script, "tool", "--output", target, "--deps", "rich", "--deps", "polars"], copiedPlugin, {
      ...isolatedEnv,
      PATH: parent,
    });
    expect(created.code).toBe(0);
    const content = readFileSync(target, "utf8");
    const metadata = content.split("# /// script\n")[1]?.split("# ///")[0];
    expect(metadata).toBeDefined();
    expect(Bun.TOML.parse((metadata ?? "").replace(/^# ?/gm, ""))).toEqual({
      "requires-python": ">=3.13",
      dependencies: ["rich", "polars"],
    });
    expect((await run([process.execPath, script, "tool", "--output", target], copiedPlugin)).code).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(content);
  });

  for (const script of ["python/new-project", "python/new-script", "rust/new-project", "go/new-project", "typescript/new-project"]) {
    test(`${script} help and missing arguments have no target side effects`, async () => {
      const parent = fixture("cli-help");
      const path = join(programming, `scripts/${script}.ts`);
      expect((await run([process.execPath, path, "--help"], parent)).code).toBe(0);
      expect((await run([process.execPath, path], parent)).code).toBe(2);
      expect(existsSync(join(parent, "src"))).toBe(false);
      expect(existsSync(join(parent, "pyproject.toml"))).toBe(false);
    });
  }
});

test("run-tool preserves direct argv and distinguishes unavailable tools from real failures", () => {
  const parent = fixture("run-tool");
  const output = join(parent, "argv result");
  const literal = "argument with spaces; $(not-a-shell)";
  expect(
    runTool(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1],process.argv[2]);', output, literal], parent),
  ).toEqual({ kind: "ok" });
  expect(readFileSync(output, "utf8")).toBe(literal);
  const failed = runTool(process.execPath, ["-e", 'process.stderr.write("real tool denial");process.exit(7);'], parent);
  expect(failed).toEqual({ kind: "failed", status: 7, stderr: "real tool denial" });
  expect(runTool(join(parent, "missing tool"), [], parent).kind).toBe("unavailable");
});

test("scaffolder processes disable automatic interpreter and toolchain provisioning", async () => {
  const parent = fixture("toolchain-policy");
  const output = join(parent, "observed-env.json");
  const consumer = join(parent, "consumer.ts");
  writeFileSync(
    consumer,
    `import {runTool} from ${JSON.stringify(join(programming, "scripts/shared/run-tool.ts"))};
const result = runTool(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({uv:process.env.UV_PYTHON_DOWNLOADS,rust:process.env.RUSTUP_AUTO_INSTALL,go:process.env.GOTOOLCHAIN}));`)}]);
if(result.kind !== "ok") process.exit(1);`,
  );
  const result = await run([process.execPath, consumer], copiedPlugin, {
    ...isolatedEnv,
    UV_PYTHON_DOWNLOADS: "auto",
    RUSTUP_AUTO_INSTALL: "1",
    GOTOOLCHAIN: "auto",
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ uv: "never", rust: "0", go: "local" });
});

test.skipIf(!Bun.which("python3"))("optional Python policy scanner does not enforce a file-size gate", async () => {
  const parent = fixture("python-policy");
  const file = join(parent, "cohesive.py");
  writeFileSync(file, Array.from({ length: 300 }, (_, index) => `value_${index} = ${index}`).join("\n"));
  const script = join(programming, "scripts/python/check-no-excuse-rules.py");
  const result = await run([Bun.which("python3") ?? "python3", "-B", script, file], copiedPlugin);
  expect(result.code).toBe(0);
  expect((await run([Bun.which("python3") ?? "python3", "-B", script, join(parent, "missing.py")], copiedPlugin)).code).toBe(2);
});

describe("opt-in test-junk scanner", () => {
  const scanner = join(programming, "scripts/typescript/check-test-junk.ts");

  test("reports candidate classes across languages without modifying the inspected tree", async () => {
    const parent = fixture("junk-scan");
    const file = join(parent, "cases.test.ts");
    const content = [
      'const source = readFileSync("owner.ts", "utf8");',
      'const prose = readFileSync("SKILL.md", "utf8");',
      'expect(source).toContain("export");',
      'expect(prose).toContain("wording");',
      "await Bun.sleep(10);",
      "test.only(() => {});",
      "test.skip(() => {});",
      "expect(value).toBe(value);",
      "expect(items.length).toBeGreaterThan(1);",
    ].join("\n");
    writeFileSync(file, content);
    writeFileSync(join(parent, "test_cases.py"), "time.sleep(1)\nassert value == value\n");
    writeFileSync(join(parent, "cases_test.go"), "time.Sleep(time.Second)\nt.Skip()\n");
    writeFileSync(join(parent, "cases.rs"), "#[test]\nfn case() { thread::sleep(duration); }\n");
    mkdirSync(join(parent, "node_modules"));
    writeFileSync(join(parent, "node_modules/ignored.test.ts"), "test.only(() => {});\n");
    const result = await run([process.execPath, scanner, "--json", parent], copiedPlugin);
    expect(result.code).toBe(1);
    const findings: { file: string; line: number; rule: string }[] = JSON.parse(result.stdout).findings;
    expect([...new Set(findings.map((finding) => finding.rule))].sort()).toEqual([
      "fixed-sleep",
      "focused",
      "lower-bound",
      "prose-pin",
      "self-compare",
      "skipped",
      "source-grep",
    ]);
    expect(findings.filter((finding) => finding.file === file).map(({ line, rule }) => ({ line, rule }))).toEqual([
      { line: 3, rule: "source-grep" },
      { line: 4, rule: "prose-pin" },
      { line: 5, rule: "fixed-sleep" },
      { line: 6, rule: "focused" },
      { line: 7, rule: "skipped" },
      { line: 8, rule: "self-compare" },
      { line: 9, rule: "lower-bound" },
    ]);
    expect(findings.some((finding) => finding.file.includes("node_modules"))).toBe(false);
    expect(new Set(findings.map((finding) => finding.file))).toEqual(
      new Set([file, join(parent, "test_cases.py"), join(parent, "cases_test.go"), join(parent, "cases.rs")]),
    );
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  test("requires reasons for exceptions and separates clean scans from invalid inputs", async () => {
    const parent = fixture("junk-exceptions");
    const file = join(parent, "cases.test.ts");
    writeFileSync(file, "await Bun.sleep(5); // test-junk-ok: fixed-sleep the debounce interval is the contract\n");
    expect((await run([process.execPath, scanner, file], copiedPlugin)).code).toBe(0);
    writeFileSync(file, "await Bun.sleep(5); // test-junk-ok: fixed-sleep\n");
    expect((await run([process.execPath, scanner, file], copiedPlugin)).code).toBe(1);
    expect((await run([process.execPath, scanner, join(parent, "missing.test.ts")], copiedPlugin)).code).toBe(2);
    expect((await run([process.execPath, scanner], copiedPlugin)).code).toBe(2);
  });
});

type EvidenceTest = { label: string; argv: string[]; failure: { exitCode: number; pattern: string } };

function mutationFixture() {
  const dir = fixture("mutation");
  const owner = join(dir, "owner.ts");
  const original = Buffer.from("export const value = 1;\r\n");
  writeFileSync(owner, original);
  return { dir, owner, original };
}

function evidenceTest(dir: string, label: string, source: string): EvidenceTest {
  const file = join(dir, `${label} with spaces.mjs`);
  writeFileSync(file, source);
  return { label, argv: [process.execPath, file], failure: { exitCode: 1, pattern: `AssertionError[^\n]*${label}-contract` } };
}

function mutationArgs(owner: string, tests: EvidenceTest[], find = "value = 1", replace = "value = 0") {
  return [
    process.execPath,
    join(programming, "scripts/typescript/mutation-proof.ts"),
    "--file",
    owner,
    "--find",
    find,
    "--replace",
    replace,
    "--json",
    ...tests.flatMap((spec) => ["--test", JSON.stringify(spec)]),
  ];
}

describe("controlled mutation receipts", () => {
  test("runs unchanged baselines and records candidate/keeper discrimination with byte-exact restore", async () => {
    const { dir, owner, original } = mutationFixture();
    const candidate = evidenceTest(
      dir,
      "candidate",
      'import assert from "node:assert/strict"; import {value} from "./owner.ts"; assert.equal(Number.isInteger(value),true,"candidate-contract");',
    );
    const keeper = evidenceTest(
      dir,
      "keeper",
      'import assert from "node:assert/strict"; import {value} from "./owner.ts"; assert.equal(value,1,"keeper-contract");',
    );
    const result = await run(mutationArgs(owner, [candidate, keeper]), copiedPlugin);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.complete).toBe(true);
    expect(receipt.baselines.map((entry: { verdict: string }) => entry.verdict)).toEqual(["green", "green"]);
    expect(receipt.outcomes.map((entry: { verdict: string }) => entry.verdict)).toEqual(["green", "red"]);
    expect(receipt.outcomes[1].matchedFailure).toContain("keeper-contract");
    expect(receipt.originalSha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(receipt.restoredSha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(readFileSync(owner)).toEqual(original);
  });

  test("does not count an unrelated command failure as the intended assertion red", async () => {
    const { dir, owner, original } = mutationFixture();
    const test = evidenceTest(
      dir,
      "candidate",
      'import {value} from "./owner.ts"; if(value === 0) {console.error("test setup dependency failed"); process.exit(1);}',
    );
    const result = await run(mutationArgs(owner, [test]), copiedPlugin);
    expect(result.code).toBe(2);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.mutated).toBe(true);
    expect(receipt.complete).toBe(false);
    expect(receipt.outcomes[0].verdict).toBe("command-failed");
    expect(receipt.outcomes[0].outputTail).toContain("test setup dependency failed");
    expect(readFileSync(owner)).toEqual(original);
  });

  test("a baseline assertion failure or unavailable command prevents mutation rather than proving deletion", async () => {
    const { dir, owner, original } = mutationFixture();
    const red = evidenceTest(dir, "candidate", 'import assert from "node:assert/strict"; assert.fail("candidate-contract");');
    const unavailable = { ...red, label: "missing", argv: [join(dir, "missing runner")] };
    const result = await run(mutationArgs(owner, [red, unavailable]), copiedPlugin);
    expect(result.code).toBe(2);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.mutated).toBe(false);
    expect(receipt.outcomes).toEqual([]);
    expect(receipt.baselines.map((entry: { verdict: string }) => entry.verdict)).toEqual(["command-failed", "command-failed"]);
    expect(readFileSync(owner)).toEqual(original);
  });

  test("refuses no-op and ambiguous edits before running a command", async () => {
    const { dir, owner, original } = mutationFixture();
    const marker = join(dir, "must-not-run");
    const test = evidenceTest(dir, "candidate", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
    for (const [find, replace] of [
      ["value = 1", "value = 1"],
      ["not present", "changed"],
      [" ", "\t"],
      ["", "changed"],
    ]) {
      const result = await run(mutationArgs(owner, [test], find, replace), copiedPlugin);
      expect(result.code).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(owner)).toEqual(original);
    }
  });

  test("keeps an unexpected writer's bytes instead of blindly restoring over them", async () => {
    const { dir, owner } = mutationFixture();
    const test = evidenceTest(
      dir,
      "candidate",
      `import {value} from "./owner.ts"; import {writeFileSync} from "node:fs"; if(value === 0) writeFileSync(${JSON.stringify(owner)}, "external writer\\n");`,
    );
    const result = await run(mutationArgs(owner, [test]), copiedPlugin);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("RESTORE_CONFLICT");
    expect(readFileSync(owner, "utf8")).toBe("external writer\n");
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} waits for its direct child to exit and restores the owner`, async () => {
      const { dir, owner, original } = mutationFixture();
      const ready = join(dir, "ready");
      const spec = evidenceTest(
        dir,
        "candidate",
        `import {value} from "./owner.ts"; import {writeFileSync,watch} from "node:fs"; if(value === 0) { watch(${JSON.stringify(dir)}, () => {}); writeFileSync(${JSON.stringify(ready)}, "ready"); }`,
      );
      const observed = Promise.withResolvers<void>();
      const observer = watch(dir, (_event, file) => {
        if (file === "ready" && existsSync(ready)) observed.resolve();
      });
      // This deadline bounds an OS event in a separate process; the file event, not elapsed time, signals readiness.
      const deadline = setTimeout(() => observed.reject(new Error("mutated child never reached its ready event")), 5000);
      const child = Bun.spawn(mutationArgs(owner, [spec]), { cwd: copiedPlugin, env: isolatedEnv, stdout: "pipe", stderr: "pipe" });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      try {
        await observed.promise;
        child.kill(signal);
        expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
        expect(await stderr).toContain("INTERRUPTED");
        expect(readFileSync(owner)).toEqual(original);
      } finally {
        observer.close();
        clearTimeout(deadline);
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
        await stdout;
        await stderr;
      }
    });
  }
});
