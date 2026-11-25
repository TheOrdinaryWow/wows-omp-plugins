import { afterEach, expect, test } from "bun:test";

import type { ExtensionAPI, ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { TspToolProps } from "@oh-my-pi/pi-wire";
import { z } from "zod";

import { registerInitDeepAdvisor } from "../plugins/omo-toolkit/src/init-deep-advisor.ts";
import { initDeepCard } from "../plugins/omo-toolkit/src/init-deep-card.ts";
import { DEFAULT_SETTINGS } from "../plugins/omo-toolkit/src/settings.ts";

let card = initDeepCard;
registerInitDeepAdvisor(
  new Proxy(
    {
      zod: z,
      registerTool: (tool: typeof initDeepCard) => {
        card = tool;
      },
    },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
    },
  ) as unknown as ExtensionAPI,
  () => DEFAULT_SETTINGS,
);
const snapshot = {
  commitSha: "abcdef1234567890".repeat(3).slice(0, 40),
  fileCount: 12000,
  loc: 987654,
  timestamp: 1735689600000,
  mode: "committed",
};
const options = { expanded: false, isPartial: false };
afterEach(() => setNativeRenderingForTest(false));

type Result = Parameters<typeof initDeepCard.renderResult>[0];
const paint = (node: UiNode | undefined): string =>
  node ? stripEscapes(renderBlock(node, 100, { theme: PLAIN_THEME }).rows.join("\n")) : "";
/** The terminal's inline head (`head`) and painted rows (`term`), and the body Tern receives under its own card head (`tern`). */
function view(result: Result, opts: ToolRenderResultOptions, args?: Parameters<typeof initDeepCard.renderCall>[0]) {
  setNativeRenderingForTest(true);
  const native = card.renderResult(result, opts, undefined, args);
  setNativeRenderingForTest(false);
  const node = card.renderResult(result, opts, undefined, args);
  return {
    head: (node?.props() ?? {}) as Partial<TspToolProps> & { tone?: string },
    tern: JSON.stringify(native ? describeTree(native, staticEnvironment(PLAIN_THEME)) : undefined),
    term: paint(node),
  };
}

test("status shows snapshot and advisor facts without raw model JSON", () => {
  const details = { root: "/project", snapshot, project: { declined: false, cooldownUntil: 0 }, global: { declined: false } };
  const result = { content: [{ type: "text", text: JSON.stringify(details) }], details };
  const shown = view(result, options, { action: "status" });
  expect(shown.head).toMatchObject({ title: "Init Deep", target: "status" });
  for (const fact of ["abcdef123456", "12000", "987654", "2025-01-01T00:00:00.000Z", "Not suppressed", "Recommendation"]) {
    expect(shown.tern).toContain(fact);
    expect(shown.term).toContain(fact);
  }
  expect(shown.tern).not.toContain("Model text");
  expect(shown.tern).not.toContain("commitSha");
  expect(shown.term).not.toContain("commitSha");
  const expanded = view(result, { ...options, expanded: true }, { action: "status" });
  expect(expanded.tern).toContain("Model text");
  expect(expanded.tern).toContain('"collapsed":true');
  expect(expanded.tern).toContain('\\n  \\"root');
  // The terminal cannot unfold a section, so the expanded card shows the receipt open there.
  expect(expanded.term).toContain('"root"');
});

test("record shows bounded counts, short HEAD, and delivery mode", () => {
  const result = { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
  const shown = view(result, options, { action: "record", mode: "committed" });
  expect(shown.head.target).toBe("record committed");
  expect(shown.tern).toContain("987654");
  expect(shown.tern).not.toContain(snapshot.commitSha);
  expect(shown.tern.length).toBeLessThan(2500);
});

test("errors show a reason with raw text folded only when expanded", () => {
  const result = {
    content: [{ type: "text", text: "Init-deep snapshot not recorded: mode is required for record (local or committed)" }],
    isError: true,
  };
  const shown = view(result, options, { action: "record" });
  expect(shown.head).toMatchObject({ status: "error" });
  expect(shown.tern).toContain("mode is required");
  expect(shown.term).toContain("mode is required");
  expect(shown.tern).not.toContain("Model text");
  expect(view(result, { ...options, expanded: true }).tern).toContain('"collapsed":true');
});

test("legacy and missing details stay readable, including partial call args", () => {
  expect(card.mergeCallAndResult).toBe(true);
  const call = card.renderCall();
  expect(call?.props()).toMatchObject({ title: "Init Deep" });
  expect((call?.props() as Partial<TspToolProps> | undefined)?.target).toBeUndefined();
  setNativeRenderingForTest(true);
  expect(card.renderCall({ action: "status" })).toBeUndefined();
  setNativeRenderingForTest(false);
  const legacy = view({ content: [{ type: "text", text: JSON.stringify(snapshot) }] }, options);
  expect(legacy.tern).toContain("abcdef123456");
  for (const details of [undefined, null, [], { snapshot: null }, { snapshot: "invalid" }, { project: null }]) {
    const shown = view({ content: [{ type: "text", text: "old model guidance" }], details }, options);
    expect(shown.tern).not.toContain("old model guidance");
    expect(shown.term).not.toContain("old model guidance");
  }
  const disabled = view({ content: [], details: { snapshot: null, global: { declined: true } } }, options);
  expect(disabled.tern).toContain("Disabled everywhere");
});
