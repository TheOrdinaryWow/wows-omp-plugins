/**
 * Install working-tree plugins into this repo's project scope through a local
 * `wows-omp-plugins-dev` marketplace, leaving the user-scope GitHub install alone.
 *
 * omp refuses plugin sources that resolve outside the marketplace root, so the
 * marketplace is a copy of `plugins/` rather than a symlink. Project installs
 * shadow user installs of the same plugin, so sessions started in this repo
 * run the working tree while every other directory keeps the released version.
 *
 *   bun run dev:plugins              sync and (re)install every plugin
 *   bun run dev:plugins omo-prometheus   only the named plugins
 *   bun run dev:plugins --remove     uninstall them and drop the dev marketplace
 */
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";

import { REPO_ROOT, readCatalog } from "@/catalog.ts";

const DEV_MARKETPLACE = "wows-omp-plugins-dev";
const DEV_ROOT = path.join(REPO_ROOT, ".omp", "dev-marketplace");

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const requested = args.filter((arg) => !arg.startsWith("--"));

const catalog = await readCatalog();
const known = catalog.plugins.map((plugin) => plugin.name);
const unknown = requested.filter((name) => !known.includes(name));
if (unknown.length > 0) {
  console.error(`unknown plugin(s): ${unknown.join(", ")}; catalog has ${known.join(", ")}`);
  process.exit(1);
}
const targets = requested.length > 0 ? requested : known;

const registered = (await $`omp plugin marketplace list`.cwd(REPO_ROOT).quiet().text())
  .split("\n")
  .some((line) => line.trim().split(/\s+/)[0] === DEV_MARKETPLACE);

if (remove) {
  for (const name of targets) {
    await $`omp plugin uninstall --scope project ${`${name}@${DEV_MARKETPLACE}`}`.cwd(REPO_ROOT).nothrow();
  }
  if (requested.length === 0) {
    if (registered) await $`omp plugin marketplace remove ${DEV_MARKETPLACE}`.cwd(REPO_ROOT);
    await rm(DEV_ROOT, { recursive: true, force: true });
  }
  process.exit(0);
}

await rm(DEV_ROOT, { recursive: true, force: true });
await cp(path.join(REPO_ROOT, "plugins"), path.join(DEV_ROOT, "plugins"), { recursive: true });
await Bun.write(path.join(DEV_ROOT, ".omp-plugin", "marketplace.json"), JSON.stringify({ ...catalog, name: DEV_MARKETPLACE }, null, 2));

if (registered) await $`omp plugin marketplace update ${DEV_MARKETPLACE}`.cwd(REPO_ROOT);
else await $`omp plugin marketplace add ${DEV_ROOT}`.cwd(REPO_ROOT);

for (const name of targets) {
  await $`omp plugin install --force --scope project ${`${name}@${DEV_MARKETPLACE}`}`.cwd(REPO_ROOT);
}
console.log("Restart OMP sessions in this repo to load the updated plugins.");
