import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { materializeResearchAssets, RESEARCH_UPSTREAM_PIN } from "../plugins/omo-ultrawork/src/research-assets.ts";

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "research-assets-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pinned research asset snapshots", () => {
  test("materializes a coherent manifest and reuses its content-addressed directory", async () => {
    const root = temporaryRoot();
    const first = await materializeResearchAssets(root);
    const second = await materializeResearchAssets(root);
    expect(second).toEqual(first);
    expect(first.durable).toBe(true);
    expect(first.pin).toBe(RESEARCH_UPSTREAM_PIN);
    expect(first.directory).toBe(join(root, "ulw-research-assets", `${first.pin}-${first.digest}`));
    const manifest = JSON.parse(readFileSync(join(first.directory, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, pin: first.pin, digest: first.digest });
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ path: "scripts/report-tools.mjs", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    );
    expect(manifest.files.some((entry: { path: string }) => entry.path.includes(".test."))).toBe(false);
    const cli = Bun.spawnSync(["bun", join(first.directory, "scripts/report-tools.mjs"), "--help", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout.toString()).commands).toContain("fact verify");
  });

  test("keeps scripts, procedure, and references after the installed directory is deleted", async () => {
    const root = temporaryRoot();
    const installation = join(root, "installation");
    mkdirSync(join(installation, "src"), { recursive: true });
    cpSync("plugins/omo-ultrawork/src/research-assets.ts", join(installation, "src/research-assets.ts"));
    cpSync("plugins/omo-ultrawork/assets/ulw-research", join(installation, "assets/ulw-research"), { recursive: true });
    cpSync("plugins/omo-ultrawork/assets/ulw-research.md", join(installation, "assets/ulw-research.md"));
    const reference = readFileSync(join(installation, "assets/ulw-research/references/fact-ledger.md"));
    const procedure = readFileSync(join(installation, "assets/ulw-research.md"));
    // Runtime-selected fixture import exercises module loading before the installation disappears.
    const loaded = (await import(pathToFileURL(join(installation, "src/research-assets.ts")).href)) as {
      materializeResearchAssets: typeof materializeResearchAssets;
    };
    rmSync(installation, { recursive: true });
    const snapshot = await loaded.materializeResearchAssets(join(root, "session-store"));
    expect(readFileSync(join(snapshot.directory, "references/fact-ledger.md"))).toEqual(reference);
    expect(readFileSync(join(snapshot.directory, "procedure.md"))).toEqual(procedure);
    const cli = Bun.spawnSync(["bun", join(snapshot.directory, "scripts/report-tools.mjs"), "--help", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout.toString()).commands).toContain("source snapshot");
  });

  test("refuses modified script bytes rather than silently repairing or mixing releases", async () => {
    const root = temporaryRoot();
    const snapshot = await materializeResearchAssets(root);
    writeFileSync(join(snapshot.directory, "scripts/report-tools.mjs"), "throw new Error('modified');\n");
    await expect(materializeResearchAssets(root)).rejects.toThrow("content does not match its manifest");
  });

  test("validates the manifest pin/digest and the complete file inventory", async () => {
    const root = temporaryRoot();
    const snapshot = await materializeResearchAssets(root);
    const manifestPath = join(snapshot.directory, "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, original.replace(RESEARCH_UPSTREAM_PIN, "0".repeat(40)));
    await expect(materializeResearchAssets(root)).rejects.toThrow("manifest does not match");
    writeFileSync(manifestPath, original);
    writeFileSync(join(snapshot.directory, "unexpected.mjs"), "export {};\n");
    await expect(materializeResearchAssets(root)).rejects.toThrow("file inventory is invalid");
  });

  test("handles concurrent initial materialization without incomplete bundles", async () => {
    const root = temporaryRoot();
    const snapshots = await Promise.all([materializeResearchAssets(root), materializeResearchAssets(root)]);
    expect(snapshots[0]).toEqual(snapshots[1]);
  });

  test("no-session materialization stays private and explicitly ephemeral, never relative to cwd", async () => {
    const root = temporaryRoot();
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      const snapshot = await materializeResearchAssets("");
      expect(snapshot.durable).toBe(false);
      expect(snapshot.directory.startsWith(`${root}/wows-omp-plugins-`)).toBe(true);
      await expect(materializeResearchAssets("relative-session")).rejects.toThrow("absolute session-store");
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });
});
