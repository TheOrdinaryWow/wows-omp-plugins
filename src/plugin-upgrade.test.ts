import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface AssetModule {
  loadPromptAsset(relativePath: string): string;
}

// The host installs a plugin as a cache copy behind a node_modules symlink and deletes that copy when it upgrades the plugin.
for (const { plugin, assets } of [
  { plugin: "omo-prometheus", assets: ["SKILL_ASSET", "ATLAS_ASSET"] },
  { plugin: "omo-ultrawork", assets: ["DIRECTIVE_ASSET", "HYPERPLAN_ASSET", "RESEARCH_ASSET"] },
]) {
  test(`${plugin} prompt assets survive an upgrade under a running session`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plugin-upgrade-")));
    try {
      const cache = join(root, "cache", `${plugin}___old`);
      const link = join(root, "node_modules", `wows-omp-plugin-${plugin}`);
      await cp(fileURLToPath(new URL(`../plugins/${plugin}`, import.meta.url)), cache, { recursive: true });
      await mkdir(join(root, "node_modules"));
      await symlink(cache, link);
      // The module must load from the throwaway install copy, which only exists at runtime.
      const module = (await import(join(link, "src/assets.ts"))) as AssetModule & Record<string, string>;
      await rm(cache, { recursive: true, force: true });
      for (const asset of assets) expect(module.loadPromptAsset(module[asset] as string).length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
