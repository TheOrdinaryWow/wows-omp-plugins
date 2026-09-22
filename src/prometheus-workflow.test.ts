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
} from "../plugins/prometheus/src/workflow.ts";

const optInInput = {
  questions: [
    {
      id: PROMETHEUS_OPT_IN_QUESTION_ID,
      question: "Choose planning depth",
      multi: false,
      options: [{ label: "Standard" }, { label: "Prometheus" }],
    },
  ],
};

const approvedPrompt = (path: string) =>
  `Plan approved.\nFull plan inlined below; durable copy at \`${path}\`\n<plan path="${path}">\n# Plan\n</plan>`;

describe("Prometheus command parsing", () => {
  test("uses one explicit command for the shared workflow", () => {
    expect(parsePrometheusCommand("/prometheus ship it")).toEqual({ kind: "activate", request: "ship it" });
    expect(parsePrometheusCommand("/prometheus off")).toEqual({ kind: "release" });
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
    expect(executionBlockReason("edit", { path: "src/index.ts" })).toContain("neither an orchestration tool");
    expect(executionBlockReason("bash", { command: "bun test" })).toContain("neither an orchestration tool");
    expect(executionBlockReason("lsp", { action: "references" })).toBeUndefined();
    expect(executionBlockReason("lsp", { action: "rename", apply: true })).toContain("can mutate");
    expect(executionBlockReason("hub", { op: "wait" })).toBeUndefined();
    expect(executionBlockReason("hub", { op: "start", application: "bun" })).toContain("starts or mutates");
  });

  test("recursively classifies xd device calls instead of treating write as a bypass", () => {
    const safe = { path: "xd://read", content: JSON.stringify({ path: "src/index.ts" }) };
    const unsafe = { path: "xd://lsp", content: JSON.stringify({ action: "rename", file: "src/index.ts" }) };

    expect(nestedXdevToolCall(safe)).toEqual({ toolName: "read", input: { path: "src/index.ts" }, documentation: false });
    expect(executionBlockReason("write", safe)).toBeUndefined();
    expect(executionBlockReason("write", unsafe)).toContain("can mutate");
    expect(executionBlockReason("write", { path: "src/index.ts", content: "changed" })).toContain("direct implementation");
  });

  test("rejects same-name extension or MCP shadows of trusted tools", () => {
    expect(executionToolSourceBlockReason("task", "builtin")).toBeUndefined();
    expect(executionToolSourceBlockReason("task", "extension")).toContain("not a trusted native/plugin tool");
    expect(executionToolSourceBlockReason("prometheus_release", "extension", true)).toBeUndefined();
    expect(executionToolSourceBlockReason("prometheus_release", "extension", false)).toContain("not the plugin-owned");
  });
});
