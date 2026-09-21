import path from "node:path";

import { CATALOG_PATH, REPO_ROOT, validateCatalog } from "@/catalog.ts";

const problems = await validateCatalog();

if (problems.length > 0) {
  console.error(`${path.relative(REPO_ROOT, CATALOG_PATH)} is out of sync with plugins/:\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log("catalog is in sync with plugins/");
