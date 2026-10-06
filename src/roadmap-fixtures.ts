import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type AdrDoc,
  buildAdrBody,
  generatedBlock,
  type Model,
  type Repo,
  type RoundDoc,
  renderAdr,
  renderAdrIndex,
  renderRoadmapIndex,
  renderRound,
  renderStage,
  renderStageTable,
  renderTodo,
  type StageDoc,
  type TodoDoc,
} from "../plugins/roadmap/src/documents.ts";

export function stageFixture(overrides: Partial<StageDoc> = {}): StageDoc {
  return {
    format: 1,
    path: "docs/roadmap/01-launch/stages/01-launch.md",
    id: "S01",
    title: "Launch: usable | increment",
    round: "R1",
    status: "planned",
    depends_on: [],
    follows: null,
    created: "2026-10-06",
    started: null,
    closed: null,
    closed_sha256: null,
    objective: "An end-to-end usable increment.  \n\nKeep **free Markdown**, [a link](https://example.com) and trailing spaces.  ",
    scope_in: "- First slice\n- Second slice",
    scope_out: "- Later rounds",
    done_criteria: "- DC1 — Users can complete the workflow\n  - Verify: `bun test` and a manual walkthrough",
    design_constraints: "See ADR-0001.",
    risks: "A risk.\n\n### Mitigation\n\nTest it first.",
    amendments: "### 2026-10-06 — A note\n\n- Reason: retain free Markdown",
    free_work_log: '- 2026-10-06 · session abc123 · "inspect code"',
    ...overrides,
  };
}

export function roundFixture(overrides: Partial<RoundDoc> = {}): RoundDoc {
  return {
    format: 1,
    path: "docs/roadmap/01-launch/README.md",
    id: "R1",
    title: "Launchable v1",
    status: "active",
    opened: "2026-10-06",
    closed: null,
    frozen_sha256: null,
    goal: "A working launch.  \n\n> Measurable and usable.",
    constraints: "- Keep the host floor",
    non_goals: "- No new storage engine",
    principles: "- Use the documented choice (ADR-0001).",
    stages: generatedBlock("stages", renderStageTable([])),
    known_limitations: "",
    ...overrides,
  };
}

export function todoFixture(overrides: Partial<TodoDoc> = {}): TodoDoc {
  return {
    format: 1,
    path: "docs/roadmap/01-launch/TODO.md",
    round: "R1",
    items: [
      {
        id: "T001",
        title: "Carry-over",
        status: "open",
        severity: "normal",
        source: "S01 (2026-10-06)",
        target: "S01",
        body: "See ADR-0001.\n\nFree **Markdown**.  ",
      },
    ],
    ...overrides,
  };
}

export function adrFixture(overrides: Partial<AdrDoc> = {}): AdrDoc {
  const title = "Choose the shared host";
  return {
    format: 1,
    path: "docs/adr/0001-shared-host.md",
    id: "ADR-0001",
    title,
    supersedes: [],
    superseded_by: null,
    stage: "S01",
    status: "accepted",
    date: "2026-10-06",
    decision_makers: ["Project owner", "Engineer, developer"],
    consulted: [],
    informed: [],
    body: buildAdrBody(title, {
      context: "We need a shared host.  \n\nFree-form context.",
      drivers: "* Compatibility\n* Reliability",
      options: ["Use the host", "Build a replacement"],
      outcome: 'Chosen option: "Use the host", because compatibility matters.',
      consequences: "* Good, because it avoids duplicated state\n* Bad, because it needs a supported host",
      confirmation: "Run the host smoke test.",
      pros_cons: "### Use the host\n\n* Good, because it is already available",
      more_info: "### 2026-10-06\n\nA dated note.  ",
    }),
    ...overrides,
  };
}

export function modelFixture(): Model {
  const stages = [stageFixture()];
  const rounds = [roundFixture({ stages: generatedBlock("stages", renderStageTable(stages)) })];
  const index = { format: 1 as const, path: "docs/roadmap/README.md", title: "Example project", body: "" };
  const adrIndex = { format: 1 as const, path: "docs/adr/README.md", body: "" };
  return { index, rounds, stages, todos: [todoFixture()], adrs: [adrFixture()], adrIndex };
}

const temporaryDirectories: string[] = [];
export async function diskFixture(): Promise<{ repo: Repo; model: Model }> {
  const root = await mkdtemp(join(tmpdir(), "roadmap-t2-"));
  temporaryDirectories.push(root);
  const git = Bun.spawn(["git", "init", "-q", root], { stdout: "pipe", stderr: "pipe" });
  if ((await git.exited) !== 0) throw new Error(await new Response(git.stderr).text());
  const repo: Repo = {
    repoRoot: root,
    commonDir: join(root, ".git"),
    roadmapDir: join(root, "docs/roadmap"),
    adrDir: join(root, "docs/adr"),
  };
  const model = modelFixture();
  model.repo = repo;
  model.index.path = join(root, model.index.path);
  if (model.adrIndex) model.adrIndex.path = join(root, model.adrIndex.path);
  for (const doc of [...model.rounds, ...model.stages, ...model.todos, ...model.adrs]) doc.path = join(root, doc.path);
  const files = [
    { path: model.index.path, content: renderRoadmapIndex(model.index, model.rounds, model.stages) },
    ...model.rounds.map((doc) => ({ path: doc.path, content: renderRound(doc, model.stages) })),
    ...model.stages.map((doc) => ({ path: doc.path, content: renderStage(doc) })),
    ...model.todos.map((doc) => ({ path: doc.path, content: renderTodo(doc) })),
    ...model.adrs.map((doc) => ({ path: doc.path, content: renderAdr(doc) })),
  ];
  if (model.adrIndex) files.push({ path: model.adrIndex.path, content: renderAdrIndex(model.adrIndex, model.adrs) });
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
  return { repo, model };
}

export async function cleanupFixtures(): Promise<void> {
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
}
