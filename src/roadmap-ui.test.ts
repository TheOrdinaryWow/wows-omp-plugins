import { expect, test } from "bun:test";

import type { Model, RoundDoc, StageDoc, StageStatus, TodoItem } from "../plugins/roadmap/src/documents.ts";
import { createTuiUi, HeadlessUi, type RoadmapUiContext } from "../plugins/roadmap/src/ui.ts";

type Answer = string | boolean | undefined;

interface Stub {
  ctx: RoadmapUiContext;
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
  return {
    ctx: { hasUI, ui } as unknown as RoadmapUiContext,
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
  const ui = createTuiUi(stub.ctx);
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

const FILES = [
  { path: "docs/roadmap/README.md", content: "# Roadmap\n" },
  { path: "docs/adr/0001-use-madr.md", content: "# Use MADR\n" },
];

test("previewConfirm shows every file through the editor, discards edits, then confirms", async () => {
  const stub = stubUi(["edited text that must be ignored", "# Use MADR\n", true]);
  const ui = createTuiUi(stub.ctx);
  expect(await ui.previewConfirm({ title: "Initialize roadmap", files: FILES })).toBe(true);
  expect(stub.calls.map((call) => call.kind)).toEqual(["editor", "editor", "confirm"]);
  expect(stub.call(0).title).toContain("docs/roadmap/README.md");
  expect(stub.call(0).body).toBe("# Roadmap\n");
  expect(stub.call(1).title).toContain("docs/adr/0001-use-madr.md");
  expect(stub.call(1).body).toBe("# Use MADR\n");
  expect(stub.call(2).body).toContain("docs/adr/0001-use-madr.md");
  evidence("previewConfirm", stub.transcript());

  const declined = stubUi(["", "", false]);
  expect(await createTuiUi(declined.ctx).previewConfirm({ title: "Initialize roadmap", files: FILES })).toBe(false);

  const cancelled = stubUi(["", undefined]);
  expect(await createTuiUi(cancelled.ctx).previewConfirm({ title: "Initialize roadmap", files: FILES })).toBeUndefined();
  expect(cancelled.calls.map((call) => call.kind)).toEqual(["editor", "editor"]);
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
  const ui = createTuiUi(stub.ctx);
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
  ]);
  evidence("statusMenu (stage active)", stub.transcript(0, 1));

  const finished = model([round("R1", "active")], [stage("S01", "closed", "Documents"), stage("S02", "dropped", "Operations")]);
  const done = stubUi([`Close round R1`]);
  expect(await createTuiUi(done.ctx).statusMenu(finished)).toEqual({ action: "close-round" });
  expect(done.call(0).body).toEqual(["● S01 Documents [closed]", "× S02 Operations [dropped]", "Run check", "Close round R1"]);
  evidence("statusMenu (all stages settled)", done.transcript());

  const planned = stubUi([undefined]);
  await createTuiUi(planned.ctx).statusMenu(model([round("R1", "active")], [stage("S01", "planned")]));
  expect(planned.call(0).body).not.toContain("Close round R1");

  const between = stubUi(["Open a new round"]);
  expect(await createTuiUi(between.ctx).statusMenu(model([round("R1", "closed")], [stage("S01", "closed")]))).toEqual({
    action: "new-round",
  });
  expect(between.call(0).title).toBe("Roadmap: no active round (last: R1 Foundation, closed)");
  expect(between.call(0).body).toEqual(["Run check", "Open a new round"]);
  evidence("statusMenu (no active round)", between.transcript());
});

test("closeRoundDispositions walks every open TODO and collects references", async () => {
  const items = [todo("T001", { target: "S02", severity: "high" }), todo("T002", { trigger: "after release" }), todo("T003")];
  const stub = stubUi(["Resolved", "  abc1234  ", "Won't fix", "", "Carry to the next round"]);
  expect(await createTuiUi(stub.ctx).closeRoundDispositions(items)).toEqual([
    { id: "T001", disposition: "resolved", reference: "abc1234" },
    { id: "T002", disposition: "wontfix" },
    { id: "T003", disposition: "carried" },
  ]);
  expect(stub.calls.map((call) => call.kind)).toEqual(["select", "input", "select", "input", "select"]);
  expect(stub.call(0).title).toBe("Close round: T001 Item T001 (1/3, high, target S02)");
  expect(stub.call(2).title).toBe("Close round: T002 Item T002 (2/3, normal, trigger: after release)");
  expect(stub.call(0).body).toEqual(["Resolved", "Won't fix", "Carry to the next round"]);
  evidence("closeRoundDispositions", stub.transcript());

  expect(await createTuiUi(stubUi(["Resolved", undefined]).ctx).closeRoundDispositions(items)).toBeUndefined();
  expect(await createTuiUi(stubUi([undefined]).ctx).closeRoundDispositions(items)).toBeUndefined();
});

test("HeadlessUi returns undefined from every dialog and is used without a UI", async () => {
  const stub = stubUi(["Resolved", true], false);
  const ui = createTuiUi(stub.ctx);
  expect(ui).toBeInstanceOf(HeadlessUi);
  const headless = new HeadlessUi();
  for (const target of [ui, headless]) {
    expect(await target.overlap(OVERLAP)).toBeUndefined();
    expect(await target.previewConfirm({ title: "x", files: FILES })).toBeUndefined();
    expect(await target.statusMenu(model([round("R1", "active")], []))).toBeUndefined();
    expect(await target.closeRoundDispositions([todo("T001")])).toBeUndefined();
    target.notify("hello", "info");
  }
  expect(stub.calls).toEqual([]);
});
