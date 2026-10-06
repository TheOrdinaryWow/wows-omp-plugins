import { join } from "node:path";

import type { Repo } from "../plugins/roadmap/src/documents.ts";
import { allocate, withRepoLock } from "../plugins/roadmap/src/numbering.ts";

const commonDir = process.argv[2];
if (!commonDir) throw new Error("Missing test common directory.");
const repo: Repo = { commonDir, repoRoot: "", roadmapDir: "", adrDir: "" };
const ids: number[] = [];
for (let index = 0; index < 10; index++) {
  ids.push(await withRepoLock(repo, () => allocate(repo, "stage", 40)));
}
console.log(JSON.stringify({ ids, counter: join(commonDir, "roadmap/counters.json") }));
