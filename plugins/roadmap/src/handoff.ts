import { basename, relative } from "node:path";

import type { AdrRecord } from "./adr.ts";
import { type Model, overdue, parseDoneCriteria, renderStage, type StageDoc, today } from "./documents.ts";
import { byId, plannedRoundCounts, roundActual, schedule, stageActual } from "./state.ts";

export interface StageBinding {
  stage: string;
}

function successor(records: readonly AdrRecord[], initial: AdrRecord): AdrRecord {
  let adr = initial;
  const visited = new Set<string>();
  while (adr.superseded_by && !visited.has(adr.id)) {
    visited.add(adr.id);
    const next = records.find((candidate) => candidate.id === adr.superseded_by);
    if (!next) break;
    adr = next;
  }
  return adr;
}

export function renderHandoff(model: Model, stage: StageDoc, on = today()): string {
  const round = model.rounds.find((candidate) => candidate.id === stage.round);
  const todos = model.todos.flatMap((doc) => doc.items).filter((item) => item.status === "open" && item.target === stage.id);
  const citations = new Set(
    [renderStage(stage), round?.principles ?? "", ...todos.map((item) => Object.values(item).join("\n"))]
      .join("\n")
      .match(/\bADR-\d{4,}\b/g) ?? [],
  );
  const view = model.adrs;
  const records = view?.records ?? [];
  const adrs = new Map<string, { adr: AdrRecord; cited: string[] }>();
  const notes: string[] = [];
  if (citations.size && !view) notes.push("Cited ADRs are unavailable: the adr plugin is not loaded in this session.");
  else if (citations.size && view?.error) notes.push(`Cited ADRs could not be read: ${view.error} Run adr_check.`);
  for (const cited of citations) {
    const original = records.find((candidate) => candidate.id === cited);
    if (!original) {
      const broken = view?.parseErrors.find((issue) => Number(basename(issue.path).split("-")[0]) === Number(cited.slice(4)));
      if (broken) notes.push(`${cited} could not be read (${broken.path}: ${broken.message}). Run adr_check.`);
      continue;
    }
    const adr = successor(records, original);
    const entry = adrs.get(adr.id) ?? { adr, cited: [] };
    if (cited !== adr.id) entry.cited.push(cited);
    adrs.set(adr.id, entry);
  }
  const parts = [
    `# Planning handoff: ${stage.id} — ${stage.title}`,
    `Round: ${stage.round}${round ? ` — ${round.title}` : ""}\nStage document: ${model.repo ? relative(model.repo.repoRoot, stage.path) : stage.path}${scheduleLines(stage, round, on)}`,
    `## Objective\n\n${stage.objective}`,
    `## Scope\n\n### In\n\n${stage.scope_in || "None."}\n\n### Out\n\n${stage.scope_out || "None."}`,
    `## Done criteria\n\n${parseDoneCriteria(stage.done_criteria)
      .map((criterion) => `- ${criterion.id} — ${criterion.statement}\n  - Verify: ${criterion.verify}`)
      .join("\n")}`,
  ];
  if (stage.design_constraints) parts.push(`## Design constraints\n\n${stage.design_constraints}`);
  if (stage.risks) parts.push(`## Risks\n\n${stage.risks}`);
  if (stage.amendments) parts.push(`## Amendments\n\n${stage.amendments}`);
  parts.push(
    `## Open TODOs targeting this stage\n\n${
      todos.length
        ? todos
            .map((item) => `### ${item.id} — ${item.title}\n\nSeverity: ${item.severity}\nSource: ${item.source}\n\n${item.body}`)
            .join("\n\n")
        : "None."
    }`,
    `## Cited ADRs\n\n${
      adrs.size || notes.length
        ? [
            ...[...adrs.values()].map(
              ({ adr, cited }) =>
                `### ${adr.id} — ${adr.title} (${adr.status})\n\nDocument: ${adr.path}${
                  cited.length ? `\nResolved from superseded ${cited.join(", ")}.` : ""
                }\n\n${adr.body.trimEnd()}`,
            ),
            ...notes,
          ].join("\n\n")
        : "None."
    }`,
    `## Free-work log\n\nVerify in code what already exists before planning duplicate work.\n\n${stage.free_work_log || "No free work recorded."}`,
    "## Closing guidance\n\nThe plan must cover every surviving done criterion. Close with roadmap_stage action=close and passing evidence for each criterion, delivered work and deviations. Resolve or move every open TODO targeting this stage. Close refuses while an ADR linked to this stage is proposed: the main agent accepts or rejects it with adr_manage first. roadmap_check verifies document consistency only; verify code and record real evidence before closing.",
  );
  return `${parts.join("\n\n")}\n`;
}

function oneLine(value: string, limit: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}

/** Target versus actual lines for the handoff header; empty when neither the stage nor its round has a target. */
function scheduleLines(stage: StageDoc, round: Model["rounds"][number] | undefined, on: string): string {
  const stageDates = schedule(stage, stageActual(stage), on);
  const roundDates = round ? schedule(round, roundActual(round), on) : "";
  return `${stageDates ? `\nStage schedule: ${stageDates}` : ""}${roundDates ? `\nRound schedule: ${roundDates}` : ""}`;
}

const STAGE_CAP = 12;
const PLANNED_ROUND_CAP = 3;

export function renderInjection(model: Model, binding?: StageBinding, on = today()): string {
  const round = model.rounds.find((candidate) => candidate.status === "active");
  if (!round) return "";
  const stages = model.stages
    .filter((stage) => stage.round === round.id && (stage.status === "planned" || stage.status === "active"))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const todos = model.todos.filter((doc) => doc.round === round.id).flatMap((doc) => doc.items.filter((item) => item.status === "open"));
  const roundDates = schedule(round, null, on);
  const tag = (stage: StageDoc) => {
    const dates = schedule(stage, null, on);
    return dates ? `${stage.status}, ${dates}` : stage.status;
  };
  const lines = [
    "[Roadmap status]",
    `Active round: ${round.id} — ${oneLine(round.title, 120)}${roundDates ? ` (${roundDates})` : ""}`,
    `Goal: ${oneLine(round.goal, 180)}`,
    `Open TODOs: ${todos.length} (${todos.filter((item) => item.severity === "high").length} high severity).`,
    "Unclosed stages:",
    ...stages
      .slice(0, STAGE_CAP)
      .map((stage) => `- ${stage.id} [${tag(stage)}] ${oneLine(stage.title, 80)} — ${oneLine(stage.objective, 160)}`),
  ];
  if (!stages.length) lines.push("- None.");
  if (stages.length > STAGE_CAP) lines.push(`${stages.length - STAGE_CAP} more, see roadmap_status.`);
  // Overdue stages can sit beyond the cap, so name them separately (ids only, bounded like the stage list).
  const late = stages.filter((stage) => overdue(stage, on)).map((stage) => stage.id);
  if (late.length) {
    lines.push(
      `Overdue stages: ${late.slice(0, STAGE_CAP).join(", ")}${late.length > STAGE_CAP ? `, ${late.length - STAGE_CAP} more` : ""}.`,
    );
  }
  const planned = model.rounds.filter((candidate) => candidate.status === "planned").sort(byId);
  if (planned.length) {
    lines.push(
      "Planned rounds:",
      ...planned.slice(0, PLANNED_ROUND_CAP).map((candidate) => {
        const count = plannedRoundCounts(model, candidate.id).stageCount;
        const dates = schedule(candidate, null, on);
        return `- ${candidate.id} [planned${dates ? `, ${dates}` : ""}] ${oneLine(candidate.title, 80)} — ${count} stage${count === 1 ? "" : "s"}`;
      }),
    );
    if (planned.length > PLANNED_ROUND_CAP) lines.push(`${planned.length - PLANNED_ROUND_CAP} more, see roadmap_status.`);
  }
  if (binding) {
    const stage = model.stages.find((candidate) => candidate.id === binding.stage);
    lines.push(
      stage?.status === "active" && stage.round === round.id
        ? `Bound stage: ${stage.id}. Call roadmap_status with stage=${stage.id} for its planning handoff.`
        : `Previous binding ${oneLine(binding.stage, 40)} is no longer active; drop this session's binding.`,
    );
  }
  lines.push(
    "Managed files change only through roadmap_* tools; do not write docs/roadmap/ directly. ADRs change through adr_manage.",
    "If the user's request overlaps an unclosed stage and this session is not working on it, call roadmap_overlap before starting.",
    "Close stages with passing evidence for every done criterion and TODO dispositions, after the main agent accepts or rejects the stage's proposed ADRs with adr_manage. Check cannot detect code/document drift.",
    "[/Roadmap status]",
  );
  return lines.join("\n");
}
