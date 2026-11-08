// Modified-port notice: OMP adaptation of oh-my-openagent adddd17004076e799c2de18ccfdee29e12525ace; SUL-1.0 (see plugin LICENSE-SUL-1.0).

import { spawnSync } from "node:child_process";

export type ToolOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "failed"; readonly status: number | null; readonly stderr: string };

export function runTool(command: string, args: readonly string[], cwd?: string): ToolOutcome {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, UV_PYTHON_DOWNLOADS: "never", RUSTUP_AUTO_INSTALL: "0", GOTOOLCHAIN: "local" },
  });
  if (result.error !== undefined) return { kind: "unavailable", reason: result.error.message };
  if (result.status === 0) return { kind: "ok" };
  return { kind: "failed", status: result.status, stderr: result.stderr };
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
