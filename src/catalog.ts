import { readdir } from "node:fs/promises";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "..");
export const CATALOG_PATH = path.join(REPO_ROOT, ".omp-plugin", "marketplace.json");
export const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");

/** Lowercase alphanumerics, hyphens and dots; must start and end alphanumeric. Max 64 chars. */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

const MANIFEST_FILES = [".omp-plugin/plugin.json", "package.json"] as const;

export type PluginEntry = {
  name: string;
  source: string;
  version?: string;
  description?: string;
};

export type Catalog = {
  name: string;
  owner: { name: string; email?: string };
  metadata?: { description?: string; version?: string; pluginRoot?: string };
  plugins: PluginEntry[];
};

export async function readCatalog(): Promise<Catalog> {
  return (await Bun.file(CATALOG_PATH).json()) as Catalog;
}

/**
 * Cross-check the catalog against the `plugins/` tree. The two drift apart
 * silently otherwise — nothing at install time reports a plugin directory that
 * was never listed, or a version bumped in only one of the manifests.
 */
export async function validateCatalog(): Promise<string[]> {
  const catalog = await readCatalog();
  const problems: string[] = [];

  if (!NAME_PATTERN.test(catalog.name)) {
    problems.push(`marketplace name "${catalog.name}" violates omp naming rules`);
  }

  const seen = new Set<string>();
  const claimed = new Set<string>();

  for (const entry of catalog.plugins) {
    if (!NAME_PATTERN.test(entry.name)) {
      problems.push(`plugin name "${entry.name}" violates omp naming rules`);
    }
    if (seen.has(entry.name)) {
      problems.push(`plugin "${entry.name}" is listed more than once`);
    }
    seen.add(entry.name);

    if (!entry.source.startsWith("./")) {
      problems.push(`plugin "${entry.name}" uses source "${entry.source}"; relative sources must start with "./"`);
      continue;
    }

    const dir = path.resolve(REPO_ROOT, catalog.metadata?.pluginRoot ?? ".", entry.source);
    if (!dir.startsWith(`${PLUGINS_DIR}${path.sep}`)) {
      problems.push(`plugin "${entry.name}" resolves outside plugins/: ${dir}`);
      continue;
    }
    claimed.add(path.basename(dir));

    let manifestCount = 0;
    for (const manifestFile of MANIFEST_FILES) {
      const file = Bun.file(path.join(dir, manifestFile));
      if (!(await file.exists())) continue;
      manifestCount += 1;

      const { version } = (await file.json()) as { version?: unknown };
      if (entry.version && typeof version === "string" && version !== entry.version) {
        problems.push(`plugin "${entry.name}" version drift: catalog ${entry.version} vs ${manifestFile} ${version}`);
      }
    }

    if (manifestCount === 0) {
      problems.push(`plugin "${entry.name}" has no ${MANIFEST_FILES.join(" or ")} at ${path.relative(REPO_ROOT, dir)}`);
    }
  }

  for (const dirent of await readdir(PLUGINS_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    if (!claimed.has(dirent.name)) {
      problems.push(`plugins/${dirent.name} exists but is not listed in the catalog`);
    }
  }

  return problems;
}
