import { expect, test } from "bun:test";

import { renderHandoff, renderInjection } from "../plugins/roadmap/src/handoff.ts";
import type { Binding } from "../plugins/roadmap/src/ses.ts";
import { roadmapStatus } from "../plugins/roadmap/src/state.ts";
import { modelFixture, roundFixture, stageFixture, todoFixture } from "./roadmap-fixtures.ts";

const binding = (stage: string): Binding => ({ v: 1, repoRoot: "/repo", stage, at: "2026-10-07T00:00:00.000Z" });

test("roadmap/status reports the active round, stages, open TODO counts and an active binding", () => {
  const model = modelFixture();
  model.stages = [
    stageFixture({ status: "closed" }),
    stageFixture({ id: "S02", title: "Operations", round: "R2", status: "active" }),
    stageFixture({ id: "S03", title: "UI", round: "R2" }),
  ];
  model.rounds = [roundFixture({ id: "R1", status: "closed" }), roundFixture({ id: "R2", title: "Scale", status: "active" })];
  const item = todoFixture().items[0];
  if (!item) throw new Error("fixture TODO missing");
  model.todos = [
    todoFixture({ round: "R1", items: [{ ...item, id: "T001", status: "wontfix" }] }),
    todoFixture({
      round: "R2",
      items: [
        { ...item, id: "T002", target: "S02" },
        { ...item, id: "T003", target: "S02" },
        { ...item, id: "T004", target: "S03" },
        { ...item, id: "T005", target: undefined, trigger: "after release" },
        { ...item, id: "T006", target: "S03", status: "resolved" },
      ],
    }),
  ];

  expect(roadmapStatus("/repo", model, binding("S02"), "2026-10-08")).toEqual({
    kind: "roadmap/status",
    version: 1,
    repoRoot: "/repo",
    project: "Example project",
    format: 1,
    activeRound: { id: "R2", title: "Scale", target: null, opened: "2026-10-06", overdue: false },
    stages: [
      {
        id: "S01",
        title: "Launch: usable | increment",
        status: "closed",
        round: "R1",
        target: null,
        started: null,
        closed: null,
        overdue: false,
        dependsOn: [],
        blockedBy: [],
        startable: false,
      },
      {
        id: "S02",
        title: "Operations",
        status: "active",
        round: "R2",
        target: null,
        started: null,
        closed: null,
        overdue: false,
        dependsOn: [],
        blockedBy: [],
        startable: false,
      },
      {
        id: "S03",
        title: "UI",
        status: "planned",
        round: "R2",
        target: null,
        started: null,
        closed: null,
        overdue: false,
        dependsOn: [],
        blockedBy: [],
        startable: true,
      },
    ],
    plannedRounds: [],
    openTodos: { total: 4, byStage: { S02: 2, S03: 1 }, untargeted: 1 },
    boundStage: "S02",
  });

  // A stage marked active outside the active round is never reported as bound.
  model.stages = [stageFixture({ id: "S02", title: "Operations", round: "R3", status: "active" })];
  model.rounds.push(roundFixture({ id: "R3", title: "Next", status: "planned", opened: null }));
  expect(roadmapStatus("/repo", model, binding("S02"), "2026-10-08").boundStage).toBeNull();
});

test("roadmap/status omits bindings to stages that are no longer active and reports no active round", () => {
  const model = modelFixture();
  model.rounds = [roundFixture({ status: "closed" })];
  model.stages = [stageFixture({ status: "closed" })];
  model.todos = [];
  const status = roadmapStatus("/repo", model, binding("S01"));
  expect(status.activeRound).toBeNull();
  expect(status.boundStage).toBeNull();
  expect(status.openTodos).toEqual({ total: 0, byStage: {}, untargeted: 0 });
  expect(roadmapStatus("/repo", model, undefined).boundStage).toBeNull();
});

function targetedModel() {
  const model = modelFixture();
  model.index = { ...model.index, format: 2 };
  model.rounds = [
    roundFixture({ id: "R1", status: "closed", closed: "2026-09-01", target: "2026-08-15" }),
    roundFixture({ id: "R2", title: "Scale", opened: "2026-09-02", target: "2026-10-01" }),
    roundFixture({ id: "R4", title: "Later", status: "planned", opened: null, target: "2026-09-30" }),
    roundFixture({ id: "R3", title: "Next", status: "planned", opened: null, target: "2026-12-01" }),
  ];
  model.stages = [
    stageFixture({ status: "closed", target: "2026-08-10", started: "2026-08-01", closed: "2026-08-20" }),
    stageFixture({ id: "S02", title: "Operations", round: "R2", status: "active", target: "2026-10-05", started: "2026-09-03" }),
    stageFixture({ id: "S03", title: "UI", round: "R2", target: "2026-11-01" }),
    stageFixture({ id: "S04", title: "Next A", round: "R3" }),
    stageFixture({ id: "S05", title: "Next B", round: "R3", status: "dropped", closed: "2026-09-20" }),
  ];
  const item = todoFixture().items[0];
  if (!item) throw new Error("fixture TODO missing");
  model.todos = [
    todoFixture({
      round: "R2",
      items: [
        { ...item, id: "T001", target: "S02" },
        { ...item, id: "T002", target: "S04" },
      ],
    }),
    todoFixture({ format: 2, round: "R3", items: [{ ...item, id: "T003", target: undefined, trigger: "after launch" }] }),
  ];
  // Targets are format-2-only fields; every targeted document is a format-2 file.
  model.rounds = model.rounds.map((round) => ({ ...round, format: 2 }));
  model.stages = model.stages.map((stage) => ({ ...stage, format: 2 }));
  model.todos = model.todos.map((doc) => ({ ...doc, format: 2 }));
  return model;
}

test("roadmap/status adds format, target versus actual dates, overdue flags and planned rounds additively", () => {
  const status = roadmapStatus("/repo", targetedModel(), undefined, "2026-10-08");
  expect(status.format).toBe(2);
  expect(status.activeRound).toEqual({ id: "R2", title: "Scale", target: "2026-10-01", opened: "2026-09-02", overdue: true });
  expect(status.stages.map(({ id, target, started, closed, overdue }) => ({ id, target, started, closed, overdue }))).toEqual([
    { id: "S01", target: "2026-08-10", started: "2026-08-01", closed: "2026-08-20", overdue: false },
    { id: "S02", target: "2026-10-05", started: "2026-09-03", closed: null, overdue: true },
    { id: "S03", target: "2026-11-01", started: null, closed: null, overdue: false },
    { id: "S04", target: null, started: null, closed: null, overdue: false },
    { id: "S05", target: null, started: null, closed: "2026-09-20", overdue: false },
  ]);
  expect(status.plannedRounds).toEqual([
    { id: "R3", title: "Next", target: "2026-12-01", overdue: false, stageCount: 1, openTodos: 2 },
    { id: "R4", title: "Later", target: "2026-09-30", overdue: true, stageCount: 0, openTodos: 0 },
  ]);
  // Existing keys keep their 0.2.3 meaning.
  expect(status.openTodos).toEqual({ total: 3, byStage: { S02: 1, S04: 1 }, untargeted: 1 });
  expect(status.stages[1]).toMatchObject({ id: "S02", title: "Operations", status: "active", round: "R2" });

  const early = roadmapStatus("/repo", targetedModel(), undefined, "2026-09-15");
  expect(early.activeRound?.overdue).toBe(false);
  expect(early.stages.filter((stage) => stage.overdue)).toEqual([]);
  expect(early.plannedRounds.map((round) => round.overdue)).toEqual([false, false]);
});

test("roadmap/status lists planned rounds when no round is active", () => {
  const model = targetedModel();
  model.rounds = model.rounds.filter((round) => round.status !== "active");
  const status = roadmapStatus("/repo", model, undefined, "2026-10-08");
  expect(status.activeRound).toBeNull();
  expect(status.plannedRounds.map((round) => round.id)).toEqual(["R3", "R4"]);
});

test("injection shows targets, overdue stages and a bounded planned-round list, and stays off without an active round", () => {
  const model = targetedModel();
  const text = renderInjection(model, undefined, "2026-10-08");
  expect(text).toContain("Active round: R2 — Scale (target 2026-10-01, overdue)");
  expect(text).toContain("- S02 [active, target 2026-10-05, overdue] Operations");
  expect(text).toContain("- S03 [planned, target 2026-11-01] UI");
  expect(text).toContain("Overdue stages: S02.");
  expect(text).toContain(
    "Planned rounds:\n- R3 [planned, target 2026-12-01] Next — 1 stage\n- R4 [planned, target 2026-09-30, overdue] Later — 0 stages",
  );

  const early = renderInjection(model, undefined, "2026-09-15");
  expect(early).not.toContain("overdue");
  expect(early).not.toContain("Overdue stages");

  model.rounds.push(
    ...["R5", "R6", "R7"].map((id) => roundFixture({ id, title: `Round ${id}`, status: "planned", opened: null, target: null })),
  );
  const capped = renderInjection(model, undefined, "2026-10-08");
  expect(capped.match(/^- R\d+ \[planned/gm)).toHaveLength(3);
  expect(capped).toContain("2 more, see roadmap_status.");
  expect(capped.split("\n").length).toBeLessThanOrEqual(40);

  model.rounds = model.rounds.filter((round) => round.status !== "active");
  expect(renderInjection(model, undefined, "2026-10-08")).toBe("");
});

test("injection and handoff for untargeted format-1 models carry no schedule text", () => {
  const model = modelFixture();
  const injection = renderInjection(model, undefined, "2026-10-08");
  expect(injection).toContain("- S01 [planned] Launch");
  expect(injection).not.toContain("target");
  expect(injection).not.toContain("Planned rounds");
  expect(injection).not.toContain("Overdue");
  const handoff = renderHandoff(model, model.stages[0] as NonNullable<(typeof model.stages)[0]>, "2026-10-08");
  expect(handoff).not.toContain("schedule:");
});

test("handoff shows stage and round target versus actual dates and flags overdue", () => {
  const model = targetedModel();
  const stage = model.stages[1];
  if (!stage) throw new Error("fixture stage missing");
  expect(renderHandoff(model, stage, "2026-10-08")).toContain(
    "Stage schedule: target 2026-10-05, started 2026-09-03, overdue\nRound schedule: target 2026-10-01, opened 2026-09-02, overdue",
  );
  const early = renderHandoff(model, stage, "2026-09-15");
  expect(early).toContain("Stage schedule: target 2026-10-05, started 2026-09-03\n");
  expect(early).toContain("Round schedule: target 2026-10-01, opened 2026-09-02\n");
});
