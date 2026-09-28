import { describe, expect, test } from "bun:test";

import {
  executionBlockReason,
  executionToolSourceBlockReason,
  isApprovedPlanHandoff,
  isPrometheusOptInConsent,
  isPrometheusOptInQuestion,
  nestedXdevToolCall,
  PROMETHEUS_OPT_IN_QUESTION_ID,
  parsePrometheusCommand,
  proposedPlanPathFromToolResult,
} from "../plugins/omo-prometheus/src/workflow.ts";

const optInInput = {
  questions: [
    {
      id: PROMETHEUS_OPT_IN_QUESTION_ID,
      header: "Prometheus",
      question: "Choose planning depth",
      multi: false,
      options: [{ label: "Standard" }, { label: "Prometheus" }],
    },
  ],
};

const approvedPrompt = (path: string) =>
  `Plan approved.\nFull plan inlined below; durable copy at \`${path}\`\n<plan path="${path}">\n# Plan\n</plan>`;

describe("Prometheus command parsing", () => {
  test("parses the toggle command with an optional first prompt", () => {
    expect(parsePrometheusCommand("/prometheus")).toEqual({ prompt: "" });
    expect(parsePrometheusCommand("/prometheus ship it")).toEqual({ prompt: "ship it" });
    expect(parsePrometheusCommand("/prometheusx")).toBeUndefined();
  });
});

describe("native plan opt-in consent", () => {
  test("accepts only the fixed deep-planning choice from an interactive ask result", () => {
    expect(isPrometheusOptInQuestion(optInInput)).toBe(true);
    expect(
      isPrometheusOptInConsent(optInInput, { options: ["Standard", "Prometheus"], selectedOptions: ["Prometheus"] }, false, true),
    ).toBe(true);

    expect(
      isPrometheusOptInConsent(
        optInInput,
        { options: ["Standard", "Prometheus"], selectedOptions: ["Prometheus"], timedOut: true },
        false,
        true,
      ),
    ).toBe(false);
    expect(isPrometheusOptInConsent(optInInput, { options: ["Standard", "Prometheus"], selectedOptions: ["Standard"] }, false, true)).toBe(
      false,
    );
    expect(
      isPrometheusOptInConsent(optInInput, { options: ["Standard", "Prometheus"], selectedOptions: ["Prometheus"] }, false, false),
    ).toBe(false);
  });

  test("rejects a matching id whose header or deep-choice label lacks Prometheus provenance", () => {
    const original = optInInput.questions[0];
    expect(isPrometheusOptInQuestion({ questions: [{ ...original, header: "Other" }] })).toBe(false);
    expect(isPrometheusOptInQuestion({ questions: [{ ...original, options: [{ label: "Standard" }, { label: "Advanced" }] }] })).toBe(
      false,
    );
  });
});

describe("native approval binding", () => {
  test("uses only a successful propose result with a real plan artifact", () => {
    const details = {
      xdev: {
        tool: "propose",
        mode: "execute",
        inner: { planFilePath: "local:/checkout-plan.md", planExists: true },
      },
    };
    expect(proposedPlanPathFromToolResult("write", false, details)).toBe("local://checkout-plan.md");
    expect(proposedPlanPathFromToolResult("write", true, details)).toBeUndefined();
    expect(
      proposedPlanPathFromToolResult("write", false, {
        xdev: { ...details.xdev, inner: { planFilePath: "local:/checkout-plan.md", planExists: false } },
      }),
    ).toBeUndefined();
  });

  test("rejects approval-looking user text unless the host reference and full envelope agree", () => {
    const path = "local://checkout-plan.md";
    expect(isApprovedPlanHandoff(approvedPrompt(path), path, path)).toBe(true);
    expect(isApprovedPlanHandoff("Plan approved.\nPlease execute it.", path, path)).toBe(false);
    expect(isApprovedPlanHandoff(approvedPrompt(path), path, "local://other-plan.md")).toBe(false);
  });
});

describe("Atlas execution guard", () => {
  test("permits observation and child coordination but blocks parent implementation", () => {
    expect(executionBlockReason("read", { path: "src/index.ts" })).toBeUndefined();
    expect(executionBlockReason("task", { tasks: [] })).toBeUndefined();
    expect(executionBlockReason("prometheus_ledger", { action: "status" })).toBeUndefined();
    expect(executionBlockReason("edit", { path: "src/index.ts" })).toBeTruthy();
    expect(executionBlockReason("bash", { command: "bun test" })).toBeTruthy();
    expect(executionBlockReason("lsp", { action: "references" })).toBeUndefined();
    expect(executionBlockReason("lsp", { action: "rename", apply: true })).toBeTruthy();
    expect(executionBlockReason("hub", { op: "wait" })).toBeUndefined();
    expect(executionBlockReason("hub", { op: "start", application: "bun" })).toBeTruthy();
  });

  test("recursively classifies xd device calls instead of treating write as a bypass", () => {
    const safe = { path: "xd://read", content: JSON.stringify({ path: "src/index.ts" }) };
    const unsafe = { path: "xd://lsp", content: JSON.stringify({ action: "rename", file: "src/index.ts" }) };

    expect(nestedXdevToolCall(safe)).toEqual({ toolName: "read", input: { path: "src/index.ts" }, documentation: false });
    expect(executionBlockReason("write", safe)).toBeUndefined();
    expect(executionBlockReason("write", unsafe)).toBeTruthy();
    expect(executionBlockReason("write", { path: "src/index.ts", content: "changed" })).toBeTruthy();
    expect(executionBlockReason("write", { path: "xd://read", content: "?" })).toBeUndefined();
    expect(executionBlockReason("write", { path: "xd://read", content: "not JSON" })).toBeTruthy();
  });

  test("rejects same-name extension or MCP shadows of trusted tools", () => {
    expect(executionToolSourceBlockReason("task", "builtin")).toBeUndefined();
    expect(executionToolSourceBlockReason("task", "extension")).toBeTruthy();
    expect(executionToolSourceBlockReason("prometheus_release", "extension", true)).toBeUndefined();
    expect(executionToolSourceBlockReason("prometheus_release", "extension", false)).toBeTruthy();
    expect(executionToolSourceBlockReason("prometheus_ledger", "extension", true)).toBeUndefined();
    expect(executionToolSourceBlockReason("prometheus_ledger", "extension", false)).toBeTruthy();
    expect(executionToolSourceBlockReason("prometheus_ledger", "mcp", false)).toBeTruthy();
  });
});
