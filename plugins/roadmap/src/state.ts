import type { Model, StageStatus } from "#src/documents.ts";
import type { Binding } from "#src/ses.ts";

export const ROADMAP_STATUS_KIND = "roadmap/status";

/** Sidecar payload (`state` of the plugin-state envelope), version 1. Output-only; never read back. */
export interface RoadmapStatusPayload {
  kind: typeof ROADMAP_STATUS_KIND;
  version: 1;
  repoRoot: string;
  project: string;
  activeRound: { id: string; title: string } | null;
  stages: Array<{ id: string; title: string; status: StageStatus; round: string }>;
  openTodos: { total: number; byStage: Record<string, number>; untargeted: number };
  boundStage: string | null;
}

export function roadmapStatus(repoRoot: string, model: Model, binding: Binding | undefined): RoadmapStatusPayload {
  const round = model.rounds.find((candidate) => candidate.status === "active");
  const byStage: Record<string, number> = {};
  let total = 0;
  let untargeted = 0;
  for (const doc of model.todos) {
    for (const item of doc.items) {
      if (item.status !== "open") continue;
      total++;
      if (item.target) byStage[item.target] = (byStage[item.target] ?? 0) + 1;
      else untargeted++;
    }
  }
  // A binding whose stage is no longer active on disk is dropped at the next turn; never report it as bound.
  const bound = binding && model.stages.some((stage) => stage.id === binding.stage && stage.status === "active") ? binding.stage : null;
  return {
    kind: ROADMAP_STATUS_KIND,
    version: 1,
    repoRoot,
    project: model.index.title,
    activeRound: round ? { id: round.id, title: round.title } : null,
    stages: model.stages.map((stage) => ({ id: stage.id, title: stage.title, status: stage.status, round: stage.round })),
    openTodos: { total, byStage, untargeted },
    boundStage: bound,
  };
}
