import { spawnSync } from "node:child_process";

export interface RuntimeLookup {
  which: (binary: string) => string | null;
  execPath: string;
  version: (binary: string) => string | undefined;
}

const defaultLookup: RuntimeLookup = {
  which: (binary) => Bun.which(binary),
  execPath: process.execPath,
  version: (binary) => {
    const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 });
    return result.status === 0 ? result.stdout.trim() : undefined;
  },
};

/** A compiled host executable is not a viewer runtime merely because it embeds Bun. */
export function resolveViewerRuntime(override = "", lookup: RuntimeLookup = defaultLookup): string | undefined {
  if (override.trim()) return override.trim();
  const bun = lookup.which("bun");
  if (bun) return bun;
  const version = lookup.version(lookup.execPath);
  return version && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version) ? lookup.execPath : undefined;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface ViewerCommandOptions {
  runtime: string;
  viewer: string;
  socket: string;
  snapshot: string;
  state: string;
  pane: string;
  finish: "close-with-omp" | "keep-open";
}

export function buildViewerCommand(options: ViewerCommandOptions): string {
  return [
    options.runtime,
    options.viewer,
    "--socket",
    options.socket,
    "--snapshot",
    options.snapshot,
    "--state",
    options.state,
    "--pane",
    options.pane,
    "--finish",
    options.finish,
  ]
    .map(shellQuote)
    .join(" ");
}
