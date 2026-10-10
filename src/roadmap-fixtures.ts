import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { type AdrDoc, buildAdrBody, renderAdr, renderIndex } from "../plugins/adr/src/documents.ts";
import { registerService } from "../plugins/adr/src/service.ts";
import { type AdrApi, type AdrRecord, type ContractEvents, resolveStage } from "../plugins/roadmap/src/adr.ts";
import type { AtlasStagePlan } from "../plugins/roadmap/src/atlas.ts";
import {
  generatedBlock,
  type Model,
  type Repo,
  type RoundDoc,
  renderRoadmapIndex,
  renderRound,
  renderStage,
  renderStageTable,
  renderTodo,
  type StageDoc,
  type TodoDoc,
} from "../plugins/roadmap/src/documents.ts";

/**
 * The adr plugin's real v1 service without a host session, with roadmap's stage resolver registered the way the roadmap
 * extension registers it. Operation tests attach it to a Repo as the extension's requireRepo does.
 */
export function adrApi(): AdrApi {
  const host = { on() {}, events: { on: () => () => {}, emit() {} } } as unknown as ExtensionAPI;
  const { api } = registerService(host, () => {});
  api.registerStageResolver(resolveStage);
  return api;
}

/** A synchronous pi.events stand-in: listeners run inside emit, like the host bus's handlers before their first await. */
export function contractEvents(): ContractEvents & { emitted: Array<{ channel: string; payload: unknown }> } {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  return {
    emitted,
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    emit(channel, payload) {
      emitted.push({ channel, payload });
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
    },
  };
}

/** An `atlas:plans` entry as omo-prometheus answers it. */
export function planFixture(overrides: Partial<AtlasStagePlan> = {}): AtlasStagePlan {
  return {
    planId: "plan-a",
    name: "Checkout plan",
    repoRoot: "/repo",
    stage: "S01",
    criteria: ["DC1"],
    status: "unfinished",
    done: 1,
    total: 3,
    gates: [],
    deferred: [],
    directory: "/sessions/atlas/checkout-plan--plan-a",
    ...overrides,
  };
}

export function stageFixture(overrides: Partial<StageDoc> = {}): StageDoc {
  return {
    format: 1,
    path: "docs/roadmap/01-launch/stages/01-launch.md",
    id: "S01",
    title: "Launch: usable | increment",
    round: "R1",
    status: "planned",
    target: null,
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
    target: null,
    opened: "2026-10-06",
    closed: null,
    frozen_sha256: null,
    goal: "A working launch.  \n\nMeasurable and usable.",
    constraints: "- Keep the host floor",
    non_goals: "- No new storage engine",
    principles: "- Use the documented choice (ADR-0001).",
    stages: generatedBlock("stages", renderStageTable([], 1)),
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

/** An ADR in the adr plugin's format; `path` is repository-relative until diskFixture places it. */
export function adrFixture(overrides: Partial<AdrDoc> = {}): AdrDoc {
  const title = "Choose the shared host";
  return {
    legacy: false,
    format: 1,
    path: "docs/adr/0001-shared-host.md",
    id: "ADR-0001",
    title,
    supersedes: [],
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

/** The record the adr service reports for `doc`, as roadmap's loadAll stores it in `Model.adrs`. */
export function adrRecord(doc: AdrDoc, repoRoot = ""): AdrRecord {
  const { legacy, format: _format, path, body, ...fields } = doc;
  return { ...fields, legacy, path: repoRoot ? relative(repoRoot, path) : path, body: body.replace(/^# [^\n]*\n\n?/, "") };
}

export function modelFixture(): Model {
  const stages = [stageFixture()];
  const rounds = [roundFixture({ stages: generatedBlock("stages", renderStageTable(stages, 1)) })];
  const index = { format: 1 as const, path: "docs/roadmap/README.md", title: "Example project", body: "" };
  return { index, rounds, stages, todos: [todoFixture()], adrs: { managed: true, records: [adrRecord(adrFixture())], parseErrors: [] } };
}

const temporaryDirectories: string[] = [];
/** A git work tree with the fixture roadmap and one adr-plugin ADR; `repo` carries the real ADR service. */
export async function diskFixture(): Promise<{ repo: Repo; model: Model; adrs: AdrDoc[] }> {
  const root = await mkdtemp(join(tmpdir(), "roadmap-t2-"));
  temporaryDirectories.push(root);
  const git = Bun.spawn(["git", "init", "-q", root], { stdout: "pipe", stderr: "pipe" });
  if ((await git.exited) !== 0) throw new Error(await new Response(git.stderr).text());
  const repo: Repo = {
    repoRoot: root,
    commonDir: join(root, ".git"),
    roadmapDir: join(root, "docs/roadmap"),
    adrDir: join(root, "docs/adr"),
    adr: adrApi(),
  };
  const model = modelFixture();
  const adrs = [adrFixture()];
  model.repo = repo;
  model.index.path = join(root, model.index.path);
  for (const doc of [...model.rounds, ...model.stages, ...model.todos, ...adrs]) doc.path = join(root, doc.path);
  const files = [
    { path: model.index.path, content: renderRoadmapIndex(model.index, model.rounds, model.stages) },
    ...model.rounds.map((doc) => ({ path: doc.path, content: renderRound(doc, model.stages) })),
    ...model.stages.map((doc) => ({ path: doc.path, content: renderStage(doc) })),
    ...model.todos.map((doc) => ({ path: doc.path, content: renderTodo(doc) })),
    ...adrs.map((doc) => ({ path: doc.path, content: renderAdr(doc) })),
    { path: join(root, "docs/adr/README.md"), content: renderIndex(undefined, adrs) },
  ];
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
  return { repo, model, adrs };
}

export async function cleanupFixtures(): Promise<void> {
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true });
}
