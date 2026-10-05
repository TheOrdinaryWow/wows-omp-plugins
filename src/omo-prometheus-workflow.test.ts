import { describe, expect, test } from "bun:test";

import {
  executionBlockReason,
  executionToolSourceBlockReason,
  isApprovedPlanHandoff,
  isPrometheusOptInConsent,
  isPrometheusOptInQuestion,
  nestedXdevToolCall,
  PROMETHEUS_OPT_IN_QUESTION_ID,
  parseAtlasCommand,
  parsePrometheusCommand,
  proposedPlanPathFromToolResult,
  taskSpawnBlockReason,
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

  test("parses only exact Atlas commands and preserves explicit selectors", () => {
    expect(parseAtlasCommand("/atlas")).toEqual({ selector: "" });
    expect(parseAtlasCommand(" /atlas integrity ")).toEqual({ selector: "integrity" });
    expect(parseAtlasCommand("/atlas integrity--id")).toEqual({ selector: "integrity--id" });
    expect(parseAtlasCommand("/atlasx")).toBeUndefined();
    expect(parseAtlasCommand("/Atlas")).toBeUndefined();
    expect(parsePrometheusCommand("/atlas integrity")).toBeUndefined();
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
    expect(executionBlockReason("atlas_ledger", { action: "status" })).toBeUndefined();
    expect(executionBlockReason("atlas_release", { reason: "verified" })).toBeUndefined();
    expect(executionBlockReason("prometheus_ledger", { action: "status" })).toBeTruthy();
    expect(executionBlockReason("prometheus_release", { reason: "verified" })).toBeTruthy();
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

  test("lets Atlas message and cancel children through native write coordination paths", () => {
    expect(executionBlockReason("wait", {})).toBeUndefined();
    expect(executionBlockReason("write", { path: "agent://0-AuthLoader", content: "Rebase onto T1 first." })).toBeUndefined();
    expect(executionBlockReason("write", { path: "agent://all", content: "Pause edits to src/index.ts." })).toBeUndefined();
    expect(executionBlockReason("write", { path: "proc://0-AuthLoader/kill" })).toBeUndefined();
    expect(executionBlockReason("write", { path: "proc://dev-server", content: "q" })).toBeTruthy();
    expect(executionBlockReason("write", { path: "proc://dev-server/mode", content: "persist" })).toBeTruthy();
    expect(executionBlockReason("write", { path: "local://notes.md", content: "changed" })).toBeTruthy();
  });

  test("rejects same-name extension or MCP shadows of trusted tools", () => {
    expect(executionToolSourceBlockReason("task", "builtin")).toBeUndefined();
    expect(executionToolSourceBlockReason("task", "extension")).toBeTruthy();
    expect(executionToolSourceBlockReason("atlas_release", "extension", true)).toBeUndefined();
    expect(executionToolSourceBlockReason("atlas_release", "extension", false)).toBeTruthy();
    expect(executionToolSourceBlockReason("atlas_ledger", "extension", true)).toBeUndefined();
    expect(executionToolSourceBlockReason("atlas_ledger", "extension", false)).toBeTruthy();
    expect(executionToolSourceBlockReason("atlas_ledger", "mcp", false)).toBeTruthy();
    expect(executionToolSourceBlockReason("ctx_reduce", "extension")).toBeUndefined();
    expect(executionToolSourceBlockReason("ctx_reduce", "mcp")).toBeTruthy();
    expect(executionToolSourceBlockReason("todo", "extension")).toBeUndefined();
    expect(executionToolSourceBlockReason("todo", "mcp")).toBeTruthy();
    expect(executionBlockReason("ctx_reduce", { drop: ["§1§"] })).toBeUndefined();
    expect(executionBlockReason("ctx_execute", { code: "rm -rf ." })).toBeTruthy();
  });
});

test("admits only the read-only operations of op-gated native tools", () => {
  expect(executionBlockReason("github", { op: "run_watch" })).toBeUndefined();
  expect(executionBlockReason("github", { op: "pr_push" })).toBeTruthy();
  expect(executionBlockReason("debug", { action: "STACK_TRACE" })).toBeUndefined();
  expect(executionBlockReason("debug", { action: "continue" })).toBeTruthy();
  expect(executionBlockReason("ida", { action: "list" })).toBeUndefined();
  expect(executionBlockReason("ida", { action: "exec" })).toBeTruthy();
  expect(executionBlockReason("rewind", { report: "x" })).toBeTruthy();
  const device = (tool: string, args: object) => ({ path: `xd://${tool}`, content: JSON.stringify(args) });
  expect(executionBlockReason("write", device("github", { op: "file_read" }))).toBeUndefined();
  expect(executionBlockReason("write", device("github", { op: "pr_create" }))).toBeTruthy();
});

describe("plan-gated reviewer spawns", () => {
  test("allows both gated reviewers during planning", () => {
    expect(taskSpawnBlockReason("planning", { task: "Review the planning gap", agent: "metis" })).toBeUndefined();
  });

  test("blocks gated reviewers while idle or without a session record", () => {
    const input = { task: "Review the plan", agent: "momus" };
    expect(taskSpawnBlockReason("idle", input)).toContain("reviewer");
    expect(taskSpawnBlockReason(undefined, input)).toContain("reviewer");
  });

  test("allows only Momus compliance review during execution", () => {
    expect(taskSpawnBlockReason("executing", { task: "F1 review_kind: compliance", agent: "momus" })).toBeUndefined();
    expect(taskSpawnBlockReason("executing", { task: "Review the plan", agent: "momus" })).toContain("reviewer");
    expect(taskSpawnBlockReason("executing", { task: "F1 review_kind: compliance", agent: "metis" })).toContain("reviewer");
  });

  test("rejects a batch containing a disallowed gated reviewer", () => {
    expect(
      taskSpawnBlockReason("executing", {
        context: "Run independent checks.",
        tasks: [
          { task: "F1 review_kind: compliance", agent: "momus" },
          { task: "Consult for planning gaps", agent: "metis" },
          { task: "Run tests", agent: "task" },
        ],
      }),
    ).toContain("reviewer");
  });
});
