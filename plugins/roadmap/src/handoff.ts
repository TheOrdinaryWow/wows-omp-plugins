import { relative } from "node:path";

import { type AdrDoc, type Model, parseDoneCriteria, renderStage, type StageDoc } from "./documents.ts";

export interface StageBinding {
  stage: string;
}

function pathFor(model: Model, path: string): string {
  return model.repo ? relative(model.repo.repoRoot, path) : path;
}

function successor(model: Model, initial: AdrDoc): AdrDoc {
  let adr = initial;
  const visited = new Set<string>();
  while (adr.superseded_by && !visited.has(adr.id)) {
    visited.add(adr.id);
    const next = model.adrs.find((candidate) => candidate.id === adr.superseded_by);
    if (!next) break;
    adr = next;
  }
  return adr;
}

export function renderHandoff(model: Model, stage: StageDoc): string {
  const round = model.rounds.find((candidate) => candidate.id === stage.round);
  const todos = model.todos.flatMap((doc) => doc.items).filter((item) => item.status === "open" && item.target === stage.id);
  const citations = new Set(
    [renderStage(stage), round?.principles ?? "", ...todos.map((item) => Object.values(item).join("\n"))]
      .join("\n")
      .match(/\bADR-\d{4,}\b/g) ?? [],
  );
  const adrs = new Map<string, { adr: AdrDoc; cited: string[] }>();
  for (const cited of citations) {
    const original = model.adrs.find((candidate) => candidate.id === cited);
    if (!original) continue;
    const adr = successor(model, original);
    const entry = adrs.get(adr.id) ?? { adr, cited: [] };
    if (cited !== adr.id) entry.cited.push(cited);
    adrs.set(adr.id, entry);
  }
  const parts = [
    `# Planning handoff: ${stage.id} — ${stage.title}`,
    `Round: ${stage.round}${round ? ` — ${round.title}` : ""}\nStage document: ${pathFor(model, stage.path)}`,
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
      adrs.size
        ? [...adrs.values()]
            .map(
              ({ adr, cited }) =>
                `### ${adr.id} — ${adr.title} (${adr.status})\n\nDocument: ${pathFor(model, adr.path)}${
                  cited.length ? `\nResolved from superseded ${cited.join(", ")}.` : ""
                }\n\n${adr.body.replace(/^# [^\n]+\n\n/, "")}`,
            )
            .join("\n\n")
        : "None."
    }`,
    `## Free-work log\n\nVerify in code what already exists before planning duplicate work.\n\n${stage.free_work_log || "No free work recorded."}`,
    "## Closing guidance\n\nThe plan must cover every surviving done criterion. Close with roadmap_stage action=close and passing evidence for each criterion, delivered work and deviations. Resolve or move every open TODO targeting this stage, and have the main agent accept or reject every proposed ADR for it. roadmap_check verifies document consistency only; verify code and record real evidence before closing.",
  );
  return `${parts.join("\n\n")}\n`;
}

function oneLine(value: string, limit: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}

export function renderInjection(model: Model, binding?: StageBinding): string {
  const round = model.rounds.find((candidate) => candidate.status === "active");
  if (!round) return "";
  const stages = model.stages
    .filter((stage) => stage.round === round.id && (stage.status === "planned" || stage.status === "active"))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const todos = model.todos.filter((doc) => doc.round === round.id).flatMap((doc) => doc.items.filter((item) => item.status === "open"));
  const lines = [
    "[Roadmap status]",
    `Active round: ${round.id} — ${oneLine(round.title, 120)}`,
    `Goal: ${oneLine(round.goal, 180)}`,
    `Open TODOs: ${todos.length} (${todos.filter((item) => item.severity === "high").length} high severity).`,
    "Unclosed stages:",
    ...stages.slice(0, 12).map((stage) => `- ${stage.id} [${stage.status}] ${oneLine(stage.title, 80)} — ${oneLine(stage.objective, 160)}`),
  ];
  if (!stages.length) lines.push("- None.");
  if (stages.length > 12) lines.push(`${stages.length - 12} more, see roadmap_status.`);
  if (binding) {
    const stage = model.stages.find((candidate) => candidate.id === binding.stage);
    lines.push(
      stage?.status === "active" && stage.round === round.id
        ? `Bound stage: ${stage.id}. Call roadmap_status with stage=${stage.id} for its planning handoff.`
        : `Previous binding ${oneLine(binding.stage, 40)} is no longer active; drop this session's binding.`,
    );
  }
  lines.push(
    "Managed files change only through roadmap_* tools; do not write docs/roadmap/ or docs/adr/ directly.",
    "If the user's request overlaps an unclosed stage and this session is not working on it, call roadmap_overlap before starting.",
    "Close stages with passing evidence for every done criterion and TODO/ADR dispositions. Check cannot detect code/document drift.",
    "[/Roadmap status]",
  );
  return lines.join("\n");
}
