import { expect, test } from "bun:test";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
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

test("status shows snapshot and advisor facts without raw model JSON", () => {
  const details = { root: "/project", snapshot, project: { declined: false, cooldownUntil: 0 }, global: { declined: false } };
  const result = { content: [{ type: "text", text: JSON.stringify(details) }], details };
  const view = card.describeResult(result, options, { action: "status" });
  const shown = JSON.stringify(view);
  expect(view.tool).toMatchObject({ title: "Init Deep", target: "status" });
  for (const fact of ["abcdef123456", "12000", "987654", "2025-01-01T00:00:00.000Z", "Not suppressed", "Recommendation"])
    expect(shown).toContain(fact);
  expect(shown).not.toContain("Model text");
  expect(shown).not.toContain("commitSha");
  const expanded = JSON.stringify(card.describeResult(result, { ...options, expanded: true }, { action: "status" }));
  expect(expanded).toContain("Model text");
  expect(expanded).toContain('"collapsed":true');
  expect(expanded).toContain('\\n  \\"root');
});

test("record shows bounded counts, short HEAD, and delivery mode", () => {
  const result = { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
  const view = card.describeResult(result, options, { action: "record", mode: "committed" });
  expect(view.tool?.target).toBe("record committed");
  const shown = JSON.stringify(view);
  expect(shown).toContain("987654");
  expect(shown).not.toContain(snapshot.commitSha);
  expect(shown.length).toBeLessThan(2500);
});

test("errors show a reason with raw text folded only when expanded", () => {
  const result = {
    content: [{ type: "text", text: "Init-deep snapshot not recorded: mode is required for record (local or committed)" }],
    isError: true,
  };
  const view = card.describeResult(result, options, { action: "record" });
  expect(view.tone).toBe("error");
  expect(JSON.stringify(view)).toContain("mode is required");
  expect(JSON.stringify(view)).not.toContain("Model text");
  expect(JSON.stringify(card.describeResult(result, { ...options, expanded: true }))).toContain('"collapsed":true');
});

test("legacy and missing details stay readable, including partial call args", () => {
  expect(card.describeCall().tool).toEqual({ title: "Init Deep" });
  const legacy = card.describeResult({ content: [{ type: "text", text: JSON.stringify(snapshot) }] }, options);
  expect(JSON.stringify(legacy)).toContain("abcdef123456");
  for (const details of [undefined, null, [], { snapshot: null }, { snapshot: "invalid" }, { project: null }]) {
    const view = card.describeResult({ content: [{ type: "text", text: "old model guidance" }], details }, options);
    expect(JSON.stringify(view)).not.toContain("old model guidance");
  }
  const disabled = card.describeResult({ content: [], details: { snapshot: null, global: { declined: true } } }, options);
  expect(JSON.stringify(disabled)).toContain("Disabled everywhere");
});
