/**
 * Modified-port notice: adapts packages/omo-senpi/src/components/init-deep-advisor/state.ts from
 * oh-my-openagent revision 8a8db1d3094da8743989bf693ee5de77889de50e, Copyright the oh-my-openagent
 * contributors, licensed under the Sustainable Use License 1.0 (see LICENSE-SUL-1.0 and NOTICE).
 * OMP adaptation: new versioned Git-common-dir state, per-worktree baselines, and host agent-dir global decline.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir, z } from "@oh-my-pi/pi-coding-agent";

import type { GitRepository, SnapshotFields } from "#src/init-deep-metrics.ts";

const nonnegative = z.number().nonnegative().refine(Number.isFinite, "must be finite");
const advisorSchema = z.object({
  version: z.literal(1),
  declined: z.boolean(),
  cooldownUntil: nonnegative,
  lastProposedHead: z.string().nullable(),
  lastProposedAt: nonnegative,
});
const globalSchema = z.object({ version: z.literal(1), declined: z.boolean(), declinedAt: nonnegative.nullable() });
const snapshotSchema = z.object({
  version: z.literal(1),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  fileCount: nonnegative,
  loc: nonnegative,
  timestamp: nonnegative,
  mode: z.enum(["local", "committed"]),
});
export type AdvisorState = z.infer<typeof advisorSchema>;
export type GlobalAdvisorState = z.infer<typeof globalSchema>;
export interface Snapshot extends SnapshotFields {
  version: 1;
}

export function advisorPaths(repo: GitRepository, agentDir = getAgentDir()) {
  const directory = join(repo.commonDir, "wows-omp-plugins", "omo-toolkit", "init-deep");
  const worktree = createHash("sha256").update(repo.root).digest("hex");
  return {
    project: join(directory, "advisor.json"),
    snapshot: join(directory, "worktrees", worktree, "snapshot.json"),
    global: join(agentDir, "omo-toolkit", "init-deep-advisor.json"),
  };
}

async function readJson(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid init-deep state JSON: ${path}; state was preserved`);
  }
}

export async function readAdvisorState(path: string): Promise<AdvisorState> {
  const value = await readJson(path);
  if (value === undefined) return { version: 1, declined: false, cooldownUntil: 0, lastProposedHead: null, lastProposedAt: 0 };
  const parsed = advisorSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Invalid or unsupported init-deep advisor state at ${path}: ${parsed.error.message}; state was preserved`);
  return parsed.data;
}

export async function readGlobalState(path: string): Promise<GlobalAdvisorState> {
  const value = await readJson(path);
  if (value === undefined) return { version: 1, declined: false, declinedAt: null };
  const parsed = globalSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Invalid or unsupported init-deep global state at ${path}: ${parsed.error.message}; state was preserved`);
  return parsed.data;
}

export async function readSnapshot(path: string): Promise<Snapshot | "invalid" | null> {
  let value: unknown;
  try {
    value = await readJson(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid init-deep state JSON:")) return "invalid";
    throw error;
  }
  if (value === undefined) return null;
  if (value && typeof value === "object" && "version" in value && typeof value.version === "number" && value.version > 1) {
    throw new Error(`Unsupported init-deep snapshot version at ${path}; state was preserved`);
  }
  const parsed = snapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : "invalid";
}

/** New files only; there is no previously shipped durable state format or implicit local:// migration. */
export async function writeState(path: string, value: AdvisorState | GlobalAdvisorState | Snapshot): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function updateAdvisorState(path: string, patch: Partial<Omit<AdvisorState, "version">>): Promise<void> {
  await writeState(path, { ...(await readAdvisorState(path)), ...patch });
}
