#!/usr/bin/env bun
// Modified-port notice: OMP adaptation of oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace; SUL-1.0 (see plugin LICENSE-SUL-1.0).
/**
 * Opt-in, single-owner mutation evidence. A nonzero command exit is not assertion proof.
 * Direct argv execution, passing baselines, exact edit, intended failure matcher, byte restore.
 * Run only on exclusively owned/disposable work; callers must bound their test commands.
 * Normal/exception/SIGINT/SIGTERM cleanup cannot cover SIGKILL, machine loss or descendants.
 * A concurrent edit is reported, never overwritten. One mutant covers only its particular case.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

export type MutationTest = {
  readonly label: string;
  readonly argv: readonly string[];
  readonly failure: { readonly exitCode: number; readonly pattern: string };
};

export type MutationOutcome = {
  readonly label: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly verdict: "red" | "green" | "command-failed";
  readonly reason: string;
  readonly matchedFailure?: string;
  readonly outputTail: string;
};

export type MutationResult = {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly mutated: boolean;
  readonly complete: boolean;
  readonly originalSha256: string;
  readonly restoredSha256: string;
  readonly baselines: readonly MutationOutcome[];
  readonly outcomes: readonly MutationOutcome[];
};

export class MutationError extends Error {
  constructor(
    readonly kind: "INVALID_EDIT" | "INVALID_TEST" | "OWNER_CHANGED" | "RESTORE_CONFLICT" | "RESTORE_MISMATCH" | "INTERRUPTED",
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "MutationError";
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

type Captured = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
  readonly error?: string;
};

function classify(test: MutationTest, run: Captured, baseline: boolean): MutationOutcome {
  const common = {
    label: test.label,
    argv: test.argv,
    exitCode: run.exitCode,
    signal: run.signal,
    outputTail: run.output.trimEnd().split("\n").slice(-30).join("\n"),
  };
  if (run.error !== undefined || run.signal !== null) {
    return { ...common, verdict: "command-failed", reason: run.error ?? `terminated by ${run.signal}` };
  }
  if (run.exitCode === 0) return { ...common, verdict: "green", reason: "command passed" };
  if (baseline) return { ...common, verdict: "command-failed", reason: "unchanged baseline failed; mutation not attempted" };
  const match = new RegExp(test.failure.pattern, "m").exec(run.output);
  if (run.exitCode === test.failure.exitCode && match !== null) {
    return { ...common, verdict: "red", reason: "declared intended assertion failure matched", matchedFailure: match[0] };
  }
  return { ...common, verdict: "command-failed", reason: "exit/output did not match the intended assertion failure" };
}

function validateTests(tests: readonly MutationTest[]): void {
  if (tests.length === 0) throw new MutationError("INVALID_TEST", "at least one test specification is required", 2);
  const labels = new Set<string>();
  for (const test of tests) {
    if (!test.label.trim() || labels.has(test.label) || test.argv.length === 0 || test.argv.some((arg) => !arg.length)) {
      throw new MutationError("INVALID_TEST", "test labels must be unique and argv must contain nonempty strings", 2);
    }
    if (
      !Number.isInteger(test.failure.exitCode) ||
      test.failure.exitCode < 1 ||
      test.failure.exitCode > 125 ||
      !test.failure.pattern.trim()
    ) {
      throw new MutationError("INVALID_TEST", `${test.label}: name an assertion exit code (1..125) and its specific failure pattern`, 2);
    }
    try {
      const pattern = new RegExp(test.failure.pattern, "m");
      if (pattern.test("")) throw new MutationError("INVALID_TEST", `${test.label}: failure pattern must not match empty output`, 2);
    } catch (error) {
      if (error instanceof SyntaxError) throw new MutationError("INVALID_TEST", `${test.label}: ${error.message}`, 2);
      throw error;
    }
    labels.add(test.label);
  }
}

export async function runMutation(options: {
  readonly cwd: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly tests: readonly MutationTest[];
}): Promise<MutationResult> {
  validateTests(options.tests);
  if (!options.find.length || options.find === options.replace)
    throw new MutationError("INVALID_EDIT", "find must be nonempty and replacement must change it");
  const full = resolve(options.cwd, options.file);
  const original = readFileSync(full);
  const text = original.toString("utf8");
  if (!Buffer.from(text).equals(original)) throw new MutationError("INVALID_EDIT", `${options.file}: expected UTF-8 source`);
  const index = text.indexOf(options.find);
  if (index < 0 || text.indexOf(options.find, index + 1) >= 0) {
    throw new MutationError("INVALID_EDIT", `${options.file}: find must match exactly once`);
  }
  const mutant = Buffer.from(text.slice(0, index) + options.replace + text.slice(index + options.find.length));
  const originalSha256 = sha256(original);
  const baselines: MutationOutcome[] = [];
  const outcomes: MutationOutcome[] = [];
  let mutated = false;
  let interrupted = 0;
  let active: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const interrupt = (code: number): void => {
    interrupted = code;
    active?.kill("SIGKILL");
  };
  const onInt = (): void => interrupt(130);
  const onTerm = (): void => interrupt(143);
  const checkInterrupt = (): void => {
    if (interrupted)
      throw new MutationError("INTERRUPTED", "interrupted; the direct child exited and owner cleanup was attempted", interrupted);
  };
  const run = async (test: MutationTest, baseline: boolean): Promise<MutationOutcome> => {
    checkInterrupt();
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn([...test.argv], { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return classify(test, { exitCode: null, signal: null, output: "", error: error.message }, baseline);
    }
    active = child;
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return classify(test, { exitCode, signal: child.signalCode, output: `${stdout}\n${stderr}` }, baseline);
    } finally {
      active = undefined;
    }
  };
  let operationError: unknown;
  let restorationError: unknown;
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    for (const test of options.tests) {
      baselines.push(await run(test, true));
      checkInterrupt();
    }
    if (baselines.every((outcome) => outcome.verdict === "green")) {
      if (!readFileSync(full).equals(original))
        throw new MutationError("OWNER_CHANGED", "owner changed during baseline; nothing was overwritten");
      writeFileSync(full, mutant);
      mutated = true;
      for (const test of options.tests) {
        outcomes.push(await run(test, false));
        checkInterrupt();
      }
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      if (mutated) {
        const current = readFileSync(full);
        if (!current.equals(mutant) && !current.equals(original)) {
          restorationError = new MutationError(
            "RESTORE_CONFLICT",
            `${options.file}: owner changed beyond the controlled mutation; recover from the disposable checkout, not an overwrite`,
          );
        }
        if (restorationError === undefined && !current.equals(original)) writeFileSync(full, original);
      }
    } catch (error) {
      restorationError = error;
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
  if (restorationError !== undefined) throw restorationError;
  if (operationError !== undefined) throw operationError;
  const restoredSha256 = sha256(readFileSync(full));
  if (restoredSha256 !== originalSha256)
    throw new MutationError("RESTORE_MISMATCH", `${options.file}: owner differs from the captured baseline`);
  return {
    file: options.file,
    find: options.find,
    replace: options.replace,
    mutated,
    complete: mutated && outcomes.length === options.tests.length && outcomes.every((outcome) => outcome.verdict !== "command-failed"),
    originalSha256,
    restoredSha256,
    baselines,
    outcomes,
  };
}

function parseTest(spec: string): MutationTest {
  const value: unknown = JSON.parse(spec);
  if (
    typeof value !== "object" ||
    value === null ||
    !("label" in value) ||
    typeof value.label !== "string" ||
    !("argv" in value) ||
    !Array.isArray(value.argv) ||
    !value.argv.every((arg): arg is string => typeof arg === "string") ||
    !("failure" in value) ||
    typeof value.failure !== "object" ||
    value.failure === null ||
    !("exitCode" in value.failure) ||
    typeof value.failure.exitCode !== "number" ||
    !("pattern" in value.failure) ||
    typeof value.failure.pattern !== "string"
  ) {
    throw new MutationError("INVALID_TEST", "--test requires JSON {label, argv: string[], failure: {exitCode, pattern}}", 2);
  }
  return { label: value.label, argv: value.argv, failure: { exitCode: value.failure.exitCode, pattern: value.failure.pattern } };
}

const USAGE = `Usage: bun mutation-proof.ts --file <owner> --find <text> --replace <text>
  --test '{"label":"candidate","argv":["bun","test","case.test.ts"],"failure":{"exitCode":1,"pattern":"AssertionError: exact contract message"}}'
  [--test <json> ...] [--cwd <dir>] [--json]

Each bounded test command runs unchanged first. Only its declared assertion exit AND message
count as red after the mutation; setup/compile/import/crash/command failures are inconclusive.
Use direct argv JSON, never shell strings. Inspect the specific assertion message, not a test name.
Every distinct obligation needs a keeper: one mutant is not proof a whole test is redundant.
Requires exclusive/disposable ownership. Restores on normal/error exits and SIGINT/SIGTERM
once the direct child exits, not on SIGKILL/machine loss; concurrent edits are not overwritten.
Exit: 0 complete receipt (not deletion approval), 1 edit/restore error, 2 usage/baseline/command
failure, 130/143 interrupted with cleanup attempted. --help has no side effects.`;

async function main(argv: readonly string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        file: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        test: { type: "string", multiple: true },
        cwd: { type: "string", default: process.cwd() },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    if (values.file === undefined || values.find === undefined || values.replace === undefined || values.test === undefined) {
      console.error(USAGE);
      return 2;
    }
    const result = await runMutation({
      cwd: values.cwd,
      file: values.file,
      find: values.find,
      replace: values.replace,
      tests: values.test.map(parseTest),
    });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const outcome of result.baselines) console.log(`baseline ${outcome.label}: ${outcome.verdict} (${outcome.reason})`);
      for (const outcome of result.outcomes) console.log(`${outcome.label}: ${outcome.verdict} (${outcome.reason})`);
      console.log(`restored ${result.file} (sha256 ${result.restoredSha256})`);
    }
    return result.complete ? 0 : 2;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(`mutation-proof: ${error instanceof MutationError ? `${error.kind}: ` : ""}${error.message}`);
    return error instanceof MutationError ? error.exitCode : error instanceof SyntaxError || error instanceof TypeError ? 2 : 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
