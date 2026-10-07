import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Plugins publish state under $XDG_RUNTIME_DIR; keep test runs, and the children they spawn, out of the real one.
const runtimeDir = mkdtempSync(join(tmpdir(), "wows-omp-plugins-test-runtime-"));
process.env.XDG_RUNTIME_DIR = runtimeDir;
afterAll(() => rmSync(runtimeDir, { recursive: true, force: true }));
