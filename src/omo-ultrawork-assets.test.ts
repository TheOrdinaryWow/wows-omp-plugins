import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type * as AssetModule from "../plugins/omo-ultrawork/src/assets.ts";

const pluginRoot = fileURLToPath(new URL("../plugins/omo-ultrawork/", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(omit?: string) {
  const root = await mkdtemp(join(tmpdir(), "ulw-prompt-cache-"));
  roots.push(root);
  for (const file of [
    "src/assets.ts",
    "assets/ultrawork-directive.md",
    "assets/hyperplan.md",
    "assets/ulw-research.md",
    "skills/ulw-loop/SKILL.md",
    "skills/ulw-loop/references/define-goal.md",
    "skills/ulw-loop/references/full-workflow.md",
  ]) {
    if (file === omit) continue;
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(pluginRoot, file), destination);
  }
  // The fixture installation is runtime-selected and intentionally tests the module-loading lifetime boundary.
  const assets: typeof AssetModule = await import(pathToFileURL(join(root, "src/assets.ts")).href);
  return { root, assets };
}

describe("ultrawork prompt cache lifetime", () => {
  test("directive, private procedures and loop references remain usable after the installation is removed", async () => {
    const { root, assets } = await fixture();
    const paths = [
      assets.DIRECTIVE_ASSET,
      assets.HYPERPLAN_ASSET,
      assets.RESEARCH_ASSET,
      assets.LOOP_ASSET,
      assets.LOOP_DEFINE_ASSET,
      assets.LOOP_WORKFLOW_ASSET,
    ];
    const before = paths.map((file) => assets.loadPromptAsset(file));
    expect(before.every((body) => body.length > 0)).toBe(true);
    await rm(root, { recursive: true });
    expect(paths.map((file) => assets.loadPromptAsset(file))).toEqual(before);
  });

  test("missing module-load assets remain failed closed rather than rereading a different installed edition", async () => {
    const missing = "skills/ulw-loop/references/full-workflow.md";
    const { root, assets } = await fixture(missing);
    expect(() => assets.loadPromptAsset(assets.LOOP_WORKFLOW_ASSET)).toThrow();
    await writeFile(join(root, missing), "later replacement edition\n");
    expect(() => assets.loadPromptAsset(assets.LOOP_WORKFLOW_ASSET)).toThrow();
    expect(assets.stripFrontmatter("---\nname: fixture\n---\nbody\n\n---\nsecond section\n")).toBe("body\n\n---\nsecond section\n");
  });
});
