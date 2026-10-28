import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "toolkit-development-skills-"));
const skills = resolve(import.meta.dir, "../plugins/omo-toolkit/skills");
const uv = Bun.which("uv");
const cargo = Bun.which("cargo");
const isolatedEnv = { ...process.env, UV_PYTHON_DOWNLOADS: "never", RUSTUP_AUTO_INSTALL: "0", NO_COLOR: "1", POLARS_MAX_THREADS: "2" };

async function run(args: string[], cwd = root, env = isolatedEnv) {
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
const helperReady = uv
  ? await run([uv, "run", "--offline", "--with", "typer", "--with", "rich", "python", "-c", "import typer, rich"])
  : undefined;
const cargoReady = cargo ? await run([cargo, "--version"]) : undefined;
const scaffoldAvailable = helperReady?.code === 0 && cargoReady?.code === 0;
if (!scaffoldAvailable)
  console.warn(
    `SKIP Rust generator integration: ${cargoReady?.code !== 0 ? "installed Cargo toolchain unavailable (automatic downloads disabled)" : "uv or offline typer/rich cache unavailable"}`,
  );

afterAll(() => {
  const copiedTree = join(root, "read only skill with spaces");
  if (existsSync(copiedTree)) chmodSync(copiedTree, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("development skill executable boundaries", () => {
  test("TypeScript scaffold copies its complete plugin closure and refuses to overwrite a target", async () => {
    const script = join(skills, "programming/scripts/typescript/new-project.ts");
    const created = await run([process.execPath, script, "typed-demo", "--path", root]);
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
      const script = join(skills, "programming/scripts/rust/new-project.py");
      const created = await run([uv ?? "uv", "run", "--offline", script, "rust-demo", "--path", root]);
      expect(created.code).toBe(0);
      const project = join(root, "rust-demo");
      expect(existsSync(join(project, "rust-toolchain.toml"))).toBe(false);
      const build = await run([cargo ?? "cargo", "check", "--offline"], project);
      expect(build.code).toBe(0);
      const marker = join(project, "src/main.rs");
      writeFileSync(marker, "// keep existing user code\n");
      expect((await run([uv ?? "uv", "run", "--offline", script, "rust-demo", "--path", root])).code).toBe(1);
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
