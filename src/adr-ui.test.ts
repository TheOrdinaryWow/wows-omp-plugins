import { expect, test } from "bun:test";

// Registers the terminal look of the host's bare sheet, which frames nothing itself.
import "@oh-my-pi/pi-coding-agent/ui/styles/overlays/bare-sheet";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";

import type { AdrRecord } from "../plugins/adr/src/documents.ts";
import { h } from "../plugins/adr/src/tsp.ts";
import { type AdrUiContext, createTuiUi, HeadlessUi, type MenuEntry } from "../plugins/adr/src/ui.ts";

function entry(id: string, status: AdrRecord["status"], extra: Partial<AdrRecord> = {}): MenuEntry {
  return {
    record: {
      id,
      title: `Decision ${id}`,
      status,
      date: "2026-10-01",
      supersedes: [],
      decision_makers: [],
      consulted: [],
      informed: [],
      path: `docs/adr/${id.slice(4)}-decision.md`,
      body: "## Context and Problem Statement\nWhy.\n",
      legacy: false,
      ...extra,
    },
    detail: `${id} detail`,
  };
}

type Factory = (
  host: { size(): { columns: number; rows: number } },
  theme: unknown,
  keybindings: unknown,
  done: (value: unknown) => void,
) => UiNode;

/**
 * Answers each select with the first option matching the next pattern; undefined answers act like Escape.
 * Each `custom` call mounts the view in a terminal and presses the next list of key ids. `custom` throws when no keys
 * are queued, which is how the dialog tests prove the fullscreen surface is never used.
 */
function scripted(answers: Array<RegExp | undefined>, mode = "tui", keys: string[][] = []) {
  const titles: string[] = [];
  const options: string[][] = [];
  const viewed: string[] = [];
  const frames: string[] = [];
  /** Each mounted view, and whether it was already disposed when the terminal let go of it. */
  const views: Array<{ view: UiNode; disposedAtUnmount: boolean }> = [];
  const ui = {
    async select(title: string, labels: string[]) {
      titles.push(title);
      options.push(labels);
      const answer = answers.shift();
      return answer ? labels.find((label) => answer.test(label)) : undefined;
    },
    async editor(_title: string, content: string) {
      viewed.push(content);
      return undefined;
    },
    async input() {
      return "typed";
    },
    notify() {},
    custom(factory: Factory, options: { overlay?: boolean; fullscreen?: boolean }) {
      const script = keys.shift();
      if (!script) throw new Error("custom must not be called");
      expect(options).toEqual({ overlay: true, fullscreen: true });
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const view = factory({ size: () => ({ columns: 80, rows: 24 }) }, undefined, undefined, resolve);
      const term = createTestTerminal(() => ({ layer: h("overlay", { size: "full", role: "omp.sheet.bare" }, view) }), {
        columns: 80,
        rows: 24,
      });
      term.focus(view);
      frames.push(term.screen().join("\n"));
      for (const key of script) term.press(key);
      term.dispose();
      views.push({ view, disposedAtUnmount: view.disposed });
      return promise;
    },
  };
  return { ctx: { hasUI: true, mode, ui } as unknown as AdrUiContext, titles, options, viewed, frames, views };
}

const pi = { sendMessage() {} };
const entries = [
  entry("ADR-0001", "accepted"),
  entry("ADR-0002", "proposed"),
  entry("ADR-0003", "superseded", { superseded_by: "ADR-0004" }),
];

test("the menu filters by status, opens a detail view and returns the chosen decision", async () => {
  const run = scripted([/^Proposed \(1\)$/, /ADR-0002/, /^View the decision$/, /^Accept$/]);
  expect(await createTuiUi(run.ctx, pi, "inline").menu(entries)).toEqual({ action: "accept", id: "ADR-0002" });
  expect(run.titles[0]).toBe("ADRs: 1 proposed, 1 accepted, 1 superseded");
  expect(run.options[0]).toEqual([
    "All ADRs (3)",
    "Proposed (1)",
    "Accepted (1)",
    "Superseded (1)",
    "New decision…",
    "Run check",
    "Run check and regenerate the index",
  ]);
  expect(run.options[1]).toEqual(["○ ADR-0002 Decision ADR-0002 [proposed]", "← Back"]);
  expect(run.options[2]).toEqual(["View the decision", "Accept", "Reject", "Deprecate", "Append a dated note", "← Back"]);
  expect(run.viewed).toEqual(["ADR-0002 detail"]);
});

test("accepted ADRs offer supersede, superseded ones only notes, and Escape climbs back up", async () => {
  const accepted = scripted([/^All ADRs/, /ADR-0001/, /^Supersede/]);
  expect(await createTuiUi(accepted.ctx, pi, "inline").menu(entries)).toEqual({ action: "supersede", id: "ADR-0001" });
  expect(accepted.options[2]).toEqual([
    "View the decision",
    "Reject",
    "Deprecate",
    "Append a dated note",
    "Supersede with a new decision…",
    "← Back",
  ]);
  const superseded = scripted([/^All ADRs/, /ADR-0003/, undefined, /^← Back$/, /^Run check$/]);
  expect(await createTuiUi(superseded.ctx, pi, "inline").menu(entries)).toEqual({ action: "check" });
  expect(superseded.options[2]).toEqual(["View the decision", "Append a dated note", "← Back"]);
  expect(superseded.titles[2]).toBe("ADR-0003 Decision ADR-0003 [superseded] · 2026-10-01 · superseded by ADR-0004");
  expect(await createTuiUi(scripted([undefined]).ctx, pi, "inline").menu(entries)).toBeUndefined();
  expect(await createTuiUi(scripted([/^New decision/]).ctx, pi, "inline").menu([])).toEqual({ action: "new" });
});

test("inline keeps the dialogs in the terminal, and fullscreen falls back to them outside it", async () => {
  const inline = scripted([/^View docs/, /^Write 1 file$/]);
  const ui = createTuiUi(inline.ctx, pi, "inline");
  expect(ui.console).toBe(false);
  expect(await ui.previewConfirm({ title: "Init", files: [{ path: "docs/adr/README.md", content: "# ADRs" }] })).toBe(true);
  expect(inline.options[0]).toEqual(["Write 1 file", "View docs/adr/README.md", "Cancel"]);
  expect(inline.viewed).toEqual(["# ADRs"]);
  const rpc = scripted([/^Run check$/], "rpc");
  const fallback = createTuiUi(rpc.ctx, pi, "fullscreen");
  expect(fallback.console).toBe(false);
  expect(await fallback.menu(entries)).toEqual({ action: "check" });
  expect(rpc.titles[0]).toBe("ADRs: 1 proposed, 1 accepted, 1 superseded");
});

test("fullscreen opens the console, keeps its filter across re-opens, and Enter asks for the decision", async () => {
  // Tab moves to Proposed; Enter on ADR-0002 opens the decision dialog, whose Back re-mounts the console.
  const run = scripted([/^← Back$/, /^Reject$/], "tui", [["tab", "enter"], ["enter"], ["escape"]]);
  const ui = createTuiUi(run.ctx, pi, "fullscreen");
  expect(ui.console).toBe(true);
  expect(await ui.menu(entries)).toEqual({ action: "reject", id: "ADR-0002" });
  expect(run.titles).toEqual(["ADR-0002 Decision ADR-0002 [proposed] · 2026-10-01", "ADR-0002 Decision ADR-0002 [proposed] · 2026-10-01"]);
  expect(run.options[0]).toEqual(["Accept", "Reject", "Deprecate", "Append a dated note", "← Back"]);
  expect(run.frames[1]).toMatch(/ADR-0002 {2}Decision ADR-0002/);
  expect(run.frames[1]).not.toMatch(/ADR-0001 Decision/);
  // The caller re-opens on the ADR it acted on with the result line; Esc closes.
  expect(await ui.menu(entries, { selectedId: "ADR-0002", message: { text: "ADR-0002 rejected.", level: "info" } })).toBeUndefined();
  expect(run.frames[2]).toMatch(/ADR-0002 rejected\./);
  const shortcut = scripted([], "tui", [["shift+s"]]);
  expect(await createTuiUi(shortcut.ctx, pi, "fullscreen").menu(entries)).toEqual({ action: "supersede", id: "ADR-0001" });
  const global = scripted([], "tui", [["shift+f"]]);
  expect(await createTuiUi(global.ctx, pi, "fullscreen").menu(entries)).toEqual({ action: "check-fix" });
});

test("the fullscreen preview writes on Shift+W and declines on Esc", async () => {
  const files = [{ path: "docs/adr/README.md", content: "# Decisions\n\nIndex." }];
  const write = scripted([], "tui", [["shift+w"]]);
  expect(await createTuiUi(write.ctx, pi, "fullscreen").previewConfirm({ title: "Initialize ADR management", files })).toBe(true);
  expect(write.frames[0]).toMatch(/Decisions/);
  const cancel = scripted([], "tui", [["escape"]]);
  expect(await createTuiUi(cancel.ctx, pi, "fullscreen").previewConfirm({ title: "Initialize ADR management", files })).toBe(false);
});

test("each console and preview view is disposed once its dialog settles", async () => {
  const run = scripted([/^← Back$/], "tui", [["enter"], ["escape"]]);
  expect(await createTuiUi(run.ctx, pi, "fullscreen").menu(entries)).toBeUndefined();
  const preview = scripted([], "tui", [["escape"]]);
  await createTuiUi(preview.ctx, pi, "fullscreen").previewConfirm({ title: "Init", files: [] });
  const views = [...run.views, ...preview.views];
  expect(views).toHaveLength(3);
  // The terminal leaving the view does not end it; the settled dialog does.
  expect(views.map(({ disposedAtUnmount }) => disposedAtUnmount)).toEqual([false, false, false]);
  expect(views.map(({ view }) => view.disposed)).toEqual([true, true, true]);
});

test("without a UI there are no dialogs and notices become displayed messages", async () => {
  const sent: unknown[] = [];
  const ui = createTuiUi({ hasUI: false } as AdrUiContext, { sendMessage: (message: unknown) => sent.push(message) }, "fullscreen");
  expect(ui).toBeInstanceOf(HeadlessUi);
  expect(ui.interactive).toBe(false);
  expect(ui.console).toBe(false);
  expect(await ui.menu(entries)).toBeUndefined();
  expect(await ui.previewConfirm({ title: "x", files: [] })).toBeUndefined();
  ui.notify("Nothing to do", "warning");
  expect(sent).toEqual([{ customType: "wows-omp-adr.notice", content: "ADR warning: Nothing to do", display: true, attribution: "agent" }]);
});
