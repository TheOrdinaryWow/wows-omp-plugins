import { expect, test } from "bun:test";

import type { Binding } from "../plugins/roadmap/src/ses.ts";
import { roadmapStatus } from "../plugins/roadmap/src/state.ts";
import { modelFixture, roundFixture, stageFixture, todoFixture } from "./roadmap-fixtures.ts";

const binding = (stage: string): Binding => ({ v: 1, repoRoot: "/repo", stage, at: "2026-10-07T00:00:00.000Z" });

test("roadmap/status reports the active round, stages, open TODO counts and an active binding", () => {
  const model = modelFixture();
  model.stages = [
    stageFixture({ status: "closed" }),
    stageFixture({ id: "S02", title: "Operations", status: "active" }),
    stageFixture({ id: "S03", title: "UI" }),
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

  expect(roadmapStatus("/repo", model, binding("S02"))).toEqual({
    kind: "roadmap/status",
    version: 1,
    repoRoot: "/repo",
    project: "Example project",
    activeRound: { id: "R2", title: "Scale" },
    stages: [
      { id: "S01", title: "Launch: usable | increment", status: "closed", round: "R1" },
      { id: "S02", title: "Operations", status: "active", round: "R1" },
      { id: "S03", title: "UI", status: "planned", round: "R1" },
    ],
    openTodos: { total: 4, byStage: { S02: 2, S03: 1 }, untargeted: 1 },
    boundStage: "S02",
  });
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
