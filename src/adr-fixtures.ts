import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreateInput } from "../plugins/adr/src/operations.ts";

/** Bytes the roadmap plugin 0.4.0 wrote: a format-1 accepted ADR without a stage (`stage: null`). */
export const LEGACY_ADR_1 =
  '---\nformat: 1\nid: "ADR-0001"\nsupersedes: []\nsuperseded_by: null\nstage: null\nstatus: "accepted"\ndate: "2026-10-01"\ndecision-makers: ["Project owner"]\nconsulted: []\ninformed: []\n---\n<!-- Managed by the roadmap OMP plugin (format v1). Change it through roadmap_* tools. Format: docs/roadmap/README.md -->\n\n# Use Postgres\n\n## Context and Problem Statement\nWe need a relational store.\n\n## Considered Options\n* Postgres\n* SQLite\n\n## Decision Outcome\nChosen option: "Postgres", because it scales.\n\n';

/** A format-2 roadmap ADR (written in a format-2 roadmap repository) tied to a stage. */
export const LEGACY_ADR_2 =
  '---\nformat: 2\nid: "ADR-0002"\nsupersedes: []\nsuperseded_by: null\nstage: "S01"\nstatus: "proposed"\ndate: "2026-10-02"\ndecision-makers: []\nconsulted: []\ninformed: []\n---\n<!-- Managed by the roadmap OMP plugin (format v2). Change it through roadmap_* tools. Format: docs/roadmap/README.md -->\n\n# Cache reads\n\n## Context and Problem Statement\nReads are slow.\n\n## Considered Options\n* Cache\n* No cache\n\n## Decision Outcome\nChosen option: "Cache".\n\n';

/** The roadmap plugin's ADR index for the two ADRs above. */
export const LEGACY_INDEX =
  "---\nformat: 1\n---\n<!-- Managed by the roadmap OMP plugin (format v1). Change it through roadmap_* tools. Format: docs/roadmap/README.md -->\n\n# Architecture Decision Records\n\nADRs use the vendored MADR 4.0 body and format: 1 metadata. Files are NNNN-slug.md with ids ADR-NNNN. Create and revise proposed records through roadmap_adr; accepted records change through status transitions, supersession or dated notes under More Information. Confirmation describes verification; implementation steps belong to the plan. ADRs outlive roadmap rounds.\n\n## Decisions\n\n<!-- roadmap:generated:adrs -->\n| ADR | Title | Status | Date |\n| --- | --- | --- | --- |\n| ADR-0001 | Use Postgres | accepted | 2026-10-01 |\n| ADR-0002 | Cache reads | proposed | 2026-10-02 |\n<!-- /roadmap:generated -->\n";

export const decision: CreateInput = {
  title: "Adopt event sourcing",
  sections: {
    context: "Audits need the full history.",
    options: ["Event sourcing", "Snapshots only"],
    outcome: 'Chosen option: "Event sourcing", because audits replay history.',
  },
};

export async function git(root: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stdout}\n${stderr}`);
}

const temporaryDirectories: string[] = [];

/** A fresh git work tree; `legacy` adds the roadmap-written docs/adr above. */
export async function repoFixture(options: { legacy?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adr-fixture-"));
  temporaryDirectories.push(root);
  await git(root, ["init", "-q"]);
  if (options.legacy) {
    await mkdir(join(root, "docs/adr"), { recursive: true });
    await writeFile(join(root, "docs/adr/README.md"), LEGACY_INDEX);
    await writeFile(join(root, "docs/adr/0001-use-postgres.md"), LEGACY_ADR_1);
    await writeFile(join(root, "docs/adr/0002-cache-reads.md"), LEGACY_ADR_2);
  }
  return root;
}

export async function cleanupFixtures(): Promise<void> {
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
}
