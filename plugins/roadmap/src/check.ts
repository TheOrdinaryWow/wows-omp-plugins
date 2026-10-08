import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

import {
  type AdrDoc,
  DocumentError,
  generatedContent,
  loadAll,
  type Model,
  parseAdr,
  parseAdrIndex,
  parseRoadmapIndex,
  parseRound,
  parseStage,
  parseTodo,
  renderAdr,
  renderAdrIndex,
  renderAdrTable,
  renderCurrentStatus,
  renderRoadmapIndex,
  renderRound,
  renderRoundTable,
  renderStage,
  renderStageTable,
  renderTodo,
  replaceGenerated,
  roundFiles,
  roundSha256,
  stageSha256,
  type TodoItem,
} from "./documents.ts";
import { guardMutation } from "./mutation-guard.ts";
import { withRepoLock } from "./numbering.ts";

export interface Diagnostics {
  severity: "error" | "warning";
  rule: string;
  path: string;
  message: string;
  fixable: boolean;
}

interface Generated {
  path: string;
  name: string;
  expected: string;
  source: string;
  frozen: boolean;
}

function generated(model: Model): Generated[] {
  const blocks: Generated[] = [];
  const content = (path: string, fallback: string): string => {
    const bytes = model.files?.[path];
    return bytes === undefined ? fallback : Buffer.from(bytes).toString("utf8");
  };
  const root = content(model.index.path, renderRoadmapIndex(model.index));
  const format = model.index.format;
  blocks.push(
    { path: model.index.path, name: "rounds", expected: renderRoundTable(model.rounds, format), source: root, frozen: false },
    {
      path: model.index.path,
      name: "status",
      expected: renderCurrentStatus(model.rounds, model.stages, format),
      source: root,
      frozen: false,
    },
  );
  for (const round of model.rounds) {
    blocks.push({
      path: round.path,
      name: "stages",
      expected: renderStageTable(
        model.stages.filter((stage) => stage.round === round.id),
        round.format,
      ),
      source: content(round.path, renderRound(round)),
      frozen: round.status === "closed" || round.status === "dropped" || round.closed !== null || round.frozen_sha256 !== null,
    });
  }
  if (model.adrIndex) {
    blocks.push({
      path: model.adrIndex.path,
      name: "adrs",
      expected: renderAdrTable(model.adrs),
      source: content(model.adrIndex.path, renderAdrIndex(model.adrIndex)),
      frozen: false,
    });
  }
  return blocks;
}

export function checkClosureIntegrity(model: Model): Diagnostics[] {
  const result: Diagnostics[] = [];
  const report = (rule: string, path: string, message: string): void => {
    result.push({ severity: "error", rule, path, message, fixable: false });
  };
  for (const stage of model.stages) {
    if (
      (stage.closed_sha256 !== null && stage.status !== "closed") ||
      (stage.closed !== null && stage.status !== "closed" && stage.status !== "dropped")
    ) {
      report(
        "closed-stage-status",
        stage.path,
        `${stage.id} status ${stage.status} is inconsistent with its closure metadata. Restore it with git; corrective work belongs in a new stage.`,
      );
    }
    if ((stage.status === "closed" || stage.closed_sha256 !== null) && stage.closed_sha256 !== stageSha256(stage)) {
      report(
        "closed-stage-hash",
        stage.path,
        `${stage.id} closed_sha256 mismatch: a closed stage was edited. Restore it with git; corrective work belongs in a new stage.`,
      );
    }
  }
  for (const round of model.rounds) {
    const terminal = round.status === "closed" || round.status === "dropped";
    if (!terminal && (round.closed !== null || round.frozen_sha256 !== null)) {
      report(
        "frozen-round-status",
        round.path,
        `${round.id} status ${round.status} is inconsistent with its closure metadata. Restore the frozen directory with git.`,
      );
    }
    if (terminal || round.frozen_sha256 !== null) {
      const files = roundFiles(model, round);
      if (!Object.keys(files).length || round.frozen_sha256 !== roundSha256(files)) {
        report(
          "frozen-round-hash",
          round.path,
          `${round.id} frozen_sha256 mismatch: a ${round.status === "dropped" ? "dropped" : "closed"} round was edited. Restore the frozen directory with git.`,
        );
      }
    }
  }
  return result;
}

function diagnostics(model: Model): Diagnostics[] {
  const result: Diagnostics[] = [];
  const report = (severity: Diagnostics["severity"], rule: string, path: string, message: string, fixable = false): void => {
    result.push({ severity, rule, path, message, fixable });
  };
  for (const issue of model.parseErrors ?? []) report("error", issue.rule, issue.path, issue.message);
  const validate = <T extends { path: string }>(
    doc: T,
    render: (doc: T) => string,
    parse: (content: string, path: string) => unknown,
  ): void => {
    try {
      parse(render(doc), doc.path);
    } catch (error) {
      report(
        "error",
        error instanceof DocumentError ? error.rule : "structure",
        doc.path,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  validate(model.index, renderRoadmapIndex, parseRoadmapIndex);
  if (model.adrIndex) validate(model.adrIndex, renderAdrIndex, parseAdrIndex);
  for (const doc of model.rounds) validate(doc, renderRound, parseRound);
  for (const doc of model.stages) validate(doc, renderStage, parseStage);
  for (const doc of model.todos) validate(doc, renderTodo, parseTodo);
  for (const doc of model.adrs) validate(doc, renderAdr, parseAdr);
  result.push(...checkClosureIntegrity(model));
  const repository = model.index.format;
  if (!model.parseErrors?.some((issue) => issue.path === model.index.path)) {
    for (const doc of [...model.rounds, ...model.stages, ...model.todos, ...model.adrs, ...(model.adrIndex ? [model.adrIndex] : [])]) {
      if (doc.format > repository)
        report(
          "error",
          "format",
          doc.path,
          `This file uses roadmap format ${doc.format}, but the repository marker in docs/roadmap/README.md is format ${repository}. Run /roadmap upgrade to adopt format 2, or restore the file with git.`,
        );
    }
  }

  const seen = new Map<string, string>();
  const duplicate = (id: string, path: string, previous: string): void => {
    const hint = id.startsWith("S")
      ? "Renumber a planned stage; started stages require a manual decision."
      : "Cross-branch or cross-clone collisions require a manual decision; ids are never reused.";
    report("error", "duplicate-id", path, `Duplicate ${id}; also present in ${previous}. ${hint}`);
  };
  for (const doc of [...model.rounds, ...model.stages, ...model.adrs]) {
    const previous = seen.get(doc.id);
    if (previous !== undefined) duplicate(doc.id, doc.path, previous);
    else seen.set(doc.id, doc.path);
  }
  // Round close carries TODOs for a planned round's stages under the same id; only that chain may repeat an id.
  const occurrences = new Map<string, Array<{ item: TodoItem; round: string; path: string }>>();
  for (const todo of model.todos) {
    for (const item of todo.items) {
      const entries = occurrences.get(item.id) ?? [];
      entries.push({ item, round: todo.round, path: todo.path });
      occurrences.set(item.id, entries);
    }
  }
  for (const [id, entries] of occurrences) {
    const chain = [...entries].sort((a, b) => Number(a.round.slice(1)) - Number(b.round.slice(1)));
    const carried = chain.every((entry, index) => {
      const next = chain[index + 1];
      return (
        (next === undefined && entry.item.status !== "carried") ||
        (next !== undefined &&
          Number(next.round.slice(1)) > Number(entry.round.slice(1)) &&
          entry.item.status === "carried" &&
          entry.item.reference === next.round &&
          next.item.carried_from === `${id} (${entry.round})`)
      );
    });
    if (!carried) for (const entry of entries.slice(1)) duplicate(id, entry.path, (entries[0] as (typeof entries)[number]).path);
  }
  const rounds = new Map(model.rounds.map((round) => [round.id, round]));
  const stages = new Map(model.stages.map((stage) => [stage.id, stage]));
  const adrs = new Map(model.adrs.map((adr) => [adr.id, adr]));
  if (model.rounds.filter((round) => round.status === "active").length > 1)
    report("error", "structure", model.index.path, "At most one round may be active.");
  for (const stage of model.stages) {
    const round = rounds.get(stage.round);
    if (!round) report("error", "dangling-reference", stage.path, `${stage.id} has unknown round ${stage.round}.`);
    else if (
      (round.status === "planned" && stage.status !== "planned" && stage.status !== "dropped") ||
      (round.status === "dropped" && stage.status !== "dropped")
    )
      report(
        "error",
        "round-state",
        stage.path,
        `${stage.id} is ${stage.status} in ${round.status} round ${round.id}; a planned round holds only planned or dropped stages and a dropped round only dropped stages.`,
      );
    for (const dependency of [...stage.depends_on, ...(stage.follows ? [stage.follows] : [])]) {
      if (!stages.has(dependency)) report("error", "dangling-reference", stage.path, `${stage.id} refers to missing stage ${dependency}.`);
    }
    for (const dependency of stage.depends_on) {
      const other = stages.get(dependency);
      if (other && Number(other.round.slice(1)) > Number(stage.round.slice(1)))
        report(
          "error",
          "dependency-order",
          stage.path,
          `${stage.id} in ${stage.round} depends on ${other.id} in the later round ${other.round}; a stage depends only on stages in its own or an earlier round.`,
        );
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const visit = (stageId: string): void => {
    if (active.has(stageId)) {
      const stage = stages.get(stageId);
      report(
        "error",
        "dependency-cycle",
        stage?.path ?? model.index.path,
        `Dependency cycle: ${[...stack.slice(stack.indexOf(stageId)), stageId].join(" → ")}.`,
      );
      return;
    }
    if (visited.has(stageId)) return;
    const stage = stages.get(stageId);
    if (!stage) return;
    active.add(stageId);
    stack.push(stageId);
    for (const dependency of stage.depends_on) visit(dependency);
    stack.pop();
    active.delete(stageId);
    visited.add(stageId);
  };
  for (const stage of model.stages) visit(stage.id);
  for (const todo of model.todos) {
    if (!rounds.has(todo.round)) report("error", "dangling-reference", todo.path, `TODO document refers to missing round ${todo.round}.`);
    for (const item of todo.items) {
      if (item.target && !stages.has(item.target))
        report("error", "dangling-reference", todo.path, `${item.id} targets missing stage ${item.target}.`);
      if (item.status !== "open") continue;
      if (
        !item.severity ||
        !["high", "normal", "low"].includes(item.severity) ||
        !item.source?.trim() ||
        (!item.target?.trim() && !item.trigger?.trim()) ||
        (item.target && item.trigger)
      ) {
        report("error", "todo-fields", todo.path, `${item.id} needs severity, source and exactly one target stage or trigger condition.`);
      }
      const target = item.target ? stages.get(item.target) : undefined;
      if (target && (target.status === "closed" || target.status === "dropped")) {
        report(
          "error",
          "todo-target",
          todo.path,
          `${item.id} targets ${target.status} stage ${target.id}; move it to an unclosed stage or a trigger.`,
        );
      } else if (target && rounds.get(todo.round)?.status === "planned" && target.round !== todo.round) {
        report(
          "error",
          "todo-target",
          todo.path,
          `${item.id} in planned round ${todo.round} targets ${target.id} in ${target.round}; a planned round's TODO.md holds only TODOs for its own stages or with a trigger. Move it with roadmap_todo.`,
        );
      }
    }
  }
  for (const adr of model.adrs) {
    for (const reference of [...adr.supersedes, ...(adr.superseded_by ? [adr.superseded_by] : [])]) {
      if (!adrs.has(reference)) report("error", "dangling-reference", adr.path, `${adr.id} refers to missing ADR ${reference}.`);
    }
    if (adr.stage && !stages.has(adr.stage))
      report("error", "dangling-reference", adr.path, `${adr.id} refers to missing origin stage ${adr.stage}.`);
    if (adr.status === "proposed" && (!adr.stage || stages.get(adr.stage)?.status !== "active")) {
      report("warning", "proposed-adr", adr.path, `${adr.id} is proposed but not tied to an active stage.`);
    }
  }
  const warnReferences = (body: string, path: string): void => {
    for (const reference of new Set(body.match(/\bADR-\d{4,}\b/g) ?? [])) {
      const adr: AdrDoc | undefined = adrs.get(reference);
      if (adr?.superseded_by) report("warning", "superseded-adr", path, `${reference} is superseded; use successor ${adr.superseded_by}.`);
    }
  };
  for (const round of model.rounds) warnReferences(round.principles, round.path);
  for (const stage of model.stages.filter((stage) => stage.status === "planned" || stage.status === "active"))
    warnReferences(renderStage(stage), stage.path);
  for (const todo of model.todos)
    for (const item of todo.items.filter((item) => item.status === "open"))
      warnReferences(
        [item.title, item.source, item.target, item.trigger, item.carried_from, item.reference, item.body].join("\n"),
        todo.path,
      );
  try {
    for (const block of generated(model)) {
      if (generatedContent(block.source, block.name) !== block.expected) {
        report(
          "error",
          "generated",
          block.path,
          `Stale generated ${block.name} block.${block.frozen ? " Fix refused: this round is closed or dropped; restore its frozen contents with git." : " Run check --fix."}`,
          !block.frozen,
        );
      }
    }
  } catch (error) {
    report(
      "error",
      error instanceof DocumentError ? error.rule : "structure",
      model.index.path,
      error instanceof Error ? error.message : String(error),
    );
  }
  return result;
}

/** Fix owns the repository lock; callers must not wrap check(..., {fix:true}) in another lock. */
export async function check(
  model: Model,
  options: { fix?: boolean; signal?: AbortSignal; changedFiles?: Set<string> } = {},
): Promise<Diagnostics[]> {
  if (!options.fix) return diagnostics(model);
  const cancelled = (path = model.index.path): Diagnostics[] | undefined => {
    const guarded = guardMutation(model, options);
    if (guarded && !guarded.ok) return [{ severity: "error", rule: "cancelled", path, message: guarded.reason, fixable: false }];
  };
  if (!model.repo) {
    const result = diagnostics(model);
    if (result.some((item) => item.fixable))
      result.push({
        severity: "error",
        rule: "fix-unavailable",
        path: model.index.path,
        message: "Fix requires a disk-loaded repository model.",
        fixable: false,
      });
    return cancelled() ?? result;
  }
  const repo = model.repo;
  const result = await withRepoLock(repo, async () => {
    const afterLock = cancelled();
    if (afterLock) return afterLock;
    const fresh = await loadAll(repo);
    const initial = diagnostics(fresh);
    if (
      initial.some(
        (item) =>
          item.rule === "structure" ||
          item.rule === "format" ||
          item.rule.startsWith("closed-stage-") ||
          item.rule.startsWith("frozen-round-"),
      )
    )
      return initial;
    const changes = new Map<string, string>();
    for (const block of generated(fresh)) {
      if (block.frozen || generatedContent(block.source, block.name) === block.expected) continue;
      changes.set(block.path, replaceGenerated(changes.get(block.path) ?? block.source, block.name, block.expected));
    }
    for (const [path, content] of changes) {
      const beforeWrite = cancelled(path);
      if (beforeWrite) return beforeWrite;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { flag: "wx" });
        const beforeRename = cancelled(path);
        if (beforeRename) return beforeRename;
        await rename(temporary, path);
        options.changedFiles?.add(path);
        model.files ??= {};
        model.files[path] = Buffer.from(content);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const repaired = changes.size ? await loadAll(repo) : fresh;
    Object.assign(model, repaired);
    return diagnostics(repaired);
  });
  return cancelled() ?? result;
}
