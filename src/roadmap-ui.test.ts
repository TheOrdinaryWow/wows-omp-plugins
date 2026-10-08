import { expect, test } from "bun:test";

import type { Model, RoundDoc, StageDoc, StageStatus, TodoItem } from "../plugins/roadmap/src/documents.ts";
import { createTuiUi, HeadlessUi, NOTICE_TYPE, type RoadmapMessenger, type RoadmapUiContext } from "../plugins/roadmap/src/ui.ts";

type Answer = string | boolean | undefined;

interface Stub {
  ctx: RoadmapUiContext;
  pi: RoadmapMessenger;
  sent: Array<Parameters<RoadmapMessenger["sendMessage"]>[0]>;
  calls: Array<{ kind: string; title: string; body: string | string[] | undefined }>;
  call(index: number): Stub["calls"][number];
  transcript(first?: number, count?: number): string;
}

function stubUi(answers: Answer[], hasUI = true): Stub {
  const calls: Stub["calls"] = [];
  const next = (kind: string, title: string, body?: string | string[]) => {
    calls.push({ kind, title, body });
    return Promise.resolve(answers.shift());
  };
  const ui = {
    select: (title: string, options: string[]) => next("select", title, options),
    confirm: async (title: string, message: string) => (await next("confirm", title, message)) === true,
    input: (title: string, placeholder?: string) => next("input", title, placeholder),
    editor: (title: string, prefill?: string) => next("editor", title, prefill),
    notify: (message: string, level?: string) => void calls.push({ kind: "notify", title: level ?? "info", body: message }),
  };
  const sent: Stub["sent"] = [];
  return {
    ctx: { hasUI, ui } as unknown as RoadmapUiContext,
    pi: { sendMessage: (message) => void sent.push(message) },
    sent,
    calls,
    call(index) {
      const call = calls[index];
      if (!call) throw new Error(`no dialog call ${index}`);
      return call;
    },
    transcript: (first = 0, count = calls.length) =>
      calls
        .slice(first, first + count)
        .map(({ kind, title, body }) => {
          const detail = Array.isArray(body) ? body.map((option) => `\n    - ${option}`).join("") : body ? `\n    ${body}` : "";
          return `[${kind}] ${title}${detail}`;
        })
        .join("\n"),
  };
}

function stage(id: string, status: StageStatus, title = `Stage ${id}`): StageDoc {
  return { format: 1, path: "", id, title, round: "R1", status } as StageDoc;
}

function round(id: string, status: RoundDoc["status"], title = "Foundation"): RoundDoc {
  return { format: 1, path: "", id, title, status } as RoundDoc;
}

function todo(id: string, extra: Partial<TodoItem> = {}): TodoItem {
  return { id, title: `Item ${id}`, status: "open", body: "", ...extra };
}

function model(rounds: RoundDoc[], stages: StageDoc[], items: TodoItem[] = []): Model {
  return {
    index: { format: 1, path: "", title: "Roadmap", body: "" },
    rounds,
    stages,
    todos: [{ format: 1, path: "", round: "R1", items }],
    adrs: [],
  };
}

// ROADMAP_UI_TRANSCRIPT=1 prints the captured dialog text as review evidence.
function evidence(name: string, text: string): void {
  if (process.env.ROADMAP_UI_TRANSCRIPT) console.log(`--- ${name}\n${text}`);
}

const OVERLAP = { stage: { id: "S03", title: "Close gate", status: "active" as const }, intent: "add evidence checks" };

test("overlap shows the stage and three options and maps answers", async () => {
  const stub = stubUi([
    "Use the roadmap: bind this session to the stage",
    "Free work: proceed and log it on the stage",
    "Unrelated: do not ask again for this stage",
    undefined,
  ]);
  const ui = createTuiUi(stub.ctx, stub.pi);
  expect(await ui.overlap(OVERLAP)).toBe("roadmap");
  expect(await ui.overlap(OVERLAP)).toBe("free");
  expect(await ui.overlap(OVERLAP)).toBe("unrelated");
  expect(await ui.overlap(OVERLAP)).toBeUndefined();
  const first = stub.call(0);
  expect(first.kind).toBe("select");
  expect(first.title).toContain("S03");
  expect(first.title).toContain('"Close gate"');
  expect(first.title).toContain("[active]");
  expect(first.title).toContain("add evidence checks");
  expect(first.body).toHaveLength(3);
  evidence("overlap", stub.transcript(0, 1));
});

const ROOT = "/work/repo";
const FILES = [
  { path: `${ROOT}/docs/roadmap/README.md`, content: "# Roadmap\n" },
  { path: `${ROOT}/docs/adr/0001-use-madr.md`, content: "# Use MADR\n" },
];
const PREVIEW = { title: "Initialize roadmap", root: ROOT, files: FILES };

test("previewConfirm offers write, cancel and repo-relative file views from one menu, returning to it after each view", async () => {
  const stub = stubUi(["View docs/adr/0001-use-madr.md", "edited text that must be ignored", "Write 2 files"]);
  const ui = createTuiUi(stub.ctx, stub.pi);
  expect(await ui.previewConfirm(PREVIEW)).toBe(true);
  expect(stub.calls.map((call) => call.kind)).toEqual(["select", "editor", "select"]);
  expect(stub.call(0).title).toContain("Initialize roadmap");
  expect(stub.call(0).body).toEqual(["Write 2 files", "View docs/roadmap/README.md", "View docs/adr/0001-use-madr.md", "Cancel"]);
  expect(stub.call(1).title).toStartWith("docs/adr/0001-use-madr.md");
  expect(stub.call(1).body).toBe("# Use MADR\n");
  evidence("previewConfirm", stub.transcript());

  const direct = stubUi(["Write 2 files"]);
  expect(await createTuiUi(direct.ctx, direct.pi).previewConfirm(PREVIEW)).toBe(true);
  expect(direct.calls.map((call) => call.kind)).toEqual(["select"]);

  const declined = stubUi(["View docs/roadmap/README.md", undefined, "Cancel"]);
  expect(await createTuiUi(declined.ctx, declined.pi).previewConfirm(PREVIEW)).toBe(false);

  const dismissed = stubUi([undefined]);
  expect(await createTuiUi(dismissed.ctx, dismissed.pi).previewConfirm(PREVIEW)).toBeUndefined();
});

test("statusMenu lists round, stages with glyphs and TODO counts, and only valid actions", async () => {
  const active = model(
    [round("R1", "active")],
    [stage("S02", "active", "Operations"), stage("S01", "closed", "Documents"), stage("S03", "planned", "UI")],
    [
      todo("T001", { target: "S02" }),
      todo("T002", { target: "S02" }),
      todo("T003", { trigger: "after release" }),
      todo("T004", { status: "resolved", target: "S03" }),
    ],
  );
  const stub = stubUi(["◐ S02 Operations [active] · 2 open TODOs", "Close stage S02", "Run check", undefined]);
  const ui = createTuiUi(stub.ctx, stub.pi);
  expect(await ui.statusMenu(active)).toEqual({ action: "stage", stage: "S02" });
  expect(await ui.statusMenu(active)).toEqual({ action: "close", stage: "S02" });
  expect(await ui.statusMenu(active)).toEqual({ action: "check" });
  expect(await ui.statusMenu(active)).toBeUndefined();
  const menu = stub.call(0);
  expect(menu.title).toBe("Roadmap R1 Foundation [active] · 3 stages · 3 open TODOs (1 by trigger)");
  expect(menu.body).toEqual([
    "● S01 Documents [closed]",
    "◐ S02 Operations [active] · 2 open TODOs",
    "○ S03 UI [planned]",
    "Close stage S02",
    "Run check",
    "Plan a future round",
  ]);
  evidence("statusMenu (stage active)", stub.transcript(0, 1));

  const finished = model([round("R1", "active")], [stage("S01", "closed", "Documents"), stage("S02", "dropped", "Operations")]);
  const done = stubUi([`Close round R1`]);
  expect(await createTuiUi(done.ctx, done.pi).statusMenu(finished)).toEqual({ action: "close-round" });
  expect(done.call(0).body).toEqual([
    "● S01 Documents [closed]",
    "× S02 Operations [dropped]",
    "Run check",
    "Close round R1",
    "Plan a future round",
  ]);
  evidence("statusMenu (all stages settled)", done.transcript());

  const planned = stubUi([undefined]);
  await createTuiUi(planned.ctx, planned.pi).statusMenu(model([round("R1", "active")], [stage("S01", "planned")]));
  expect(planned.call(0).body).not.toContain("Close round R1");

  const between = stubUi(["Open a new round"]);
  expect(await createTuiUi(between.ctx, between.pi).statusMenu(model([round("R1", "closed")], [stage("S01", "closed")]))).toEqual({
    action: "new-round",
  });
  expect(between.call(0).title).toBe("Roadmap: no active round (last: R1 Foundation, closed)");
  expect(between.call(0).body).toEqual(["Run check", "Open a new round", "Plan a future round"]);
  evidence("statusMenu (no active round)", between.transcript());
});

test("statusMenu shows target versus actual dates, flags overdue unfinished items and lists planned rounds compactly", async () => {
  const r1 = { ...round("R1", "active"), opened: "2026-09-01", target: "2026-10-01" };
  const r2 = { ...round("R2", "planned", "Scale"), opened: null, target: "2026-12-01" };
  const r3 = { ...round("R3", "planned", "Polish"), opened: null, target: "2026-09-15" };
  const stages = [
    { ...stage("S01", "closed", "Documents"), target: "2026-09-10", closed: "2026-09-12" },
    { ...stage("S02", "active", "Operations"), target: "2026-09-30", started: "2026-09-05" },
    { ...stage("S03", "planned", "UI"), target: "2026-12-01" },
    { ...stage("S04", "planned", "Scale A"), round: "R2" },
    { ...stage("S05", "planned", "Scale B"), round: "R2", target: "2026-11-01" },
    { ...stage("S06", "dropped", "Scale C"), round: "R2" },
  ];
  const m = model([r3, r2, r1], stages, [todo("T001", { target: "S02" }), todo("T002", { target: "S04" })]);
  m.todos.push({ format: 2, path: "", round: "R2", items: [todo("T003", { trigger: "after launch" })] });
  const stub = stubUi(["○ R2 Scale [planned] · 2 stages · 2 open TODOs · target 2026-12-01", "Plan a future round"]);
  const ui = createTuiUi(stub.ctx, stub.pi);
  expect(await ui.statusMenu(m, "2026-10-08")).toEqual({ action: "round", round: "R2" });
  expect(await ui.statusMenu(m, "2026-10-08")).toEqual({ action: "plan-round" });
  expect(stub.call(0).title).toBe(
    "Roadmap R1 Foundation [active] · 3 stages · 2 open TODOs (1 by trigger) · target 2026-10-01, opened 2026-09-01, overdue · 1 overdue stage · 2 planned rounds",
  );
  expect(stub.call(0).body).toEqual([
    "● S01 Documents [closed] · target 2026-09-10, closed 2026-09-12",
    "◐ S02 Operations [active] · target 2026-09-30, started 2026-09-05, overdue · 1 open TODO",
    "○ S03 UI [planned] · target 2026-12-01",
    "Close stage S02",
    "○ R2 Scale [planned] · 2 stages · 2 open TODOs · target 2026-12-01",
    "○ R3 Polish [planned] · 0 stages · target 2026-09-15, overdue",
    "Run check",
    "Plan a future round",
  ]);
  evidence("statusMenu (targets and planned rounds)", stub.transcript(0, 1));

  const early = stubUi([undefined]);
  await createTuiUi(early.ctx, early.pi).statusMenu(m, "2026-09-01");
  expect(early.call(0).title).toBe(
    "Roadmap R1 Foundation [active] · 3 stages · 2 open TODOs (1 by trigger) · target 2026-10-01, opened 2026-09-01 · 2 planned rounds",
  );
  expect((early.call(0).body as string[]).filter((label) => label.includes("overdue"))).toEqual([]);
});

test("statusMenu without an active round offers the lowest planned round for activation and planning another", async () => {
  const closed = { ...round("R1", "closed"), closed: "2026-10-01" };
  const r2 = { ...round("R2", "planned", "Scale"), opened: null, target: null };
  const r3 = { ...round("R3", "planned", "Polish"), opened: null, target: "2026-11-01" };
  const m = model(
    [r3, closed, r2],
    [
      { ...stage("S01", "closed"), round: "R1" },
      { ...stage("S02", "planned"), round: "R2" },
    ],
  );
  const stub = stubUi(["Activate R2 Scale", "○ R3 Polish [planned] · 0 stages · target 2026-11-01", "Plan a future round"]);
  const ui = createTuiUi(stub.ctx, stub.pi);
  expect(await ui.statusMenu(m, "2026-10-08")).toEqual({ action: "new-round" });
  expect(await ui.statusMenu(m, "2026-10-08")).toEqual({ action: "round", round: "R3" });
  expect(await ui.statusMenu(m, "2026-10-08")).toEqual({ action: "plan-round" });
  expect(stub.call(0).title).toBe("Roadmap: no active round (last: R1 Foundation, closed) · 2 planned rounds");
  expect(stub.call(0).body).toEqual([
    "○ R2 Scale [planned] · 1 stage",
    "○ R3 Polish [planned] · 0 stages · target 2026-11-01",
    "Run check",
    "Activate R2 Scale",
    "Plan a future round",
  ]);
  evidence("statusMenu (planned rounds, none active)", stub.transcript(0, 1));

  const fresh = stubUi([undefined]);
  await createTuiUi(fresh.ctx, fresh.pi).statusMenu(model([r2], []), "2026-10-08");
  expect(fresh.call(0).title).toBe("Roadmap: no active round · 1 planned round");
  expect(fresh.call(0).body).toEqual(["○ R2 Scale [planned] · 0 stages", "Run check", "Activate R2 Scale", "Plan a future round"]);
});

test("closeRoundDispositions walks every open TODO and collects references", async () => {
  const items = [todo("T001", { target: "S02", severity: "high" }), todo("T002", { trigger: "after release" }), todo("T003")];
  const stub = stubUi(["Resolved", "  abc1234  ", "Won't fix", "", "Carry to the next round"]);
  expect(await createTuiUi(stub.ctx, stub.pi).closeRoundDispositions(items)).toEqual([
    { id: "T001", disposition: "resolved", reference: "abc1234" },
    { id: "T002", disposition: "wontfix" },
    { id: "T003", disposition: "carried" },
  ]);
  expect(stub.calls.map((call) => call.kind)).toEqual(["select", "input", "select", "input", "select"]);
  expect(stub.call(0).title).toBe("Close round: T001 Item T001 (1/3, high, target S02)");
  expect(stub.call(2).title).toBe("Close round: T002 Item T002 (2/3, normal, trigger: after release)");
  expect(stub.call(0).body).toEqual(["Resolved", "Won't fix", "Carry to the next round"]);
  evidence("closeRoundDispositions", stub.transcript());

  const partial = stubUi(["Resolved", undefined]);
  expect(await createTuiUi(partial.ctx, partial.pi).closeRoundDispositions(items)).toBeUndefined();
  const dismissed = stubUi([undefined]);
  expect(await createTuiUi(dismissed.ctx, dismissed.pi).closeRoundDispositions(items)).toBeUndefined();
});

test("HeadlessUi returns undefined from every dialog and turns notices into displayed messages", async () => {
  const stub = stubUi(["Resolved", true], false);
  const ui = createTuiUi(stub.ctx, stub.pi);
  expect(ui).toBeInstanceOf(HeadlessUi);
  expect(ui.interactive).toBe(false);
  expect(createTuiUi(stubUi([]).ctx, stub.pi).interactive).toBe(true);
  const direct = stubUi([], false);
  const headless = new HeadlessUi(direct.pi);
  for (const target of [ui, headless]) {
    expect(await target.overlap(OVERLAP)).toBeUndefined();
    expect(await target.previewConfirm(PREVIEW)).toBeUndefined();
    expect(await target.statusMenu(model([round("R1", "active")], []))).toBeUndefined();
    expect(await target.closeRoundDispositions([todo("T001")])).toBeUndefined();
  }
  ui.notify("hello", "info");
  ui.notify("Every stage must be closed", "error");
  expect(stub.calls).toEqual([]);
  expect(stub.sent).toEqual([
    { customType: NOTICE_TYPE, content: "hello", display: true, attribution: "agent" },
    { customType: NOTICE_TYPE, content: "Roadmap error: Every stage must be closed", display: true, attribution: "agent" },
  ]);
  expect(direct.sent).toEqual([]);
});
