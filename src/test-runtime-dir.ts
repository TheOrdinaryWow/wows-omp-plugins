import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function executableTmpfsAvailable(): boolean {
  let directory: string | undefined;
  try {
    const stats = statfsSync("/dev/shm");
    if (stats.bavail * stats.bsize < 2 * 1024 ** 3) return false;
    directory = mkdtempSync("/dev/shm/wows-omp-plugins-test-");
    const probe = join(directory, "probe.sh");
    writeFileSync(probe, "#!/bin/sh\nexit 0\n");
    chmodSync(probe, 0o755);
    const result = spawnSync(probe, { stdio: "ignore" });
    return !result.error && result.status === 0;
  } catch {
    return false;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

// Keep durability checks real without competing for disk fsyncs; temporary hooks must also remain executable.
if (process.platform === "linux" && executableTmpfsAvailable()) process.env.TMPDIR = "/dev/shm";

// Plugins publish state under $XDG_RUNTIME_DIR; keep test runs, and the children they spawn, out of the real one.
const runtimeDir = mkdtempSync(join(tmpdir(), "wows-omp-plugins-test-runtime-"));
process.env.XDG_RUNTIME_DIR = runtimeDir;
afterAll(() => rmSync(runtimeDir, { recursive: true, force: true }));
